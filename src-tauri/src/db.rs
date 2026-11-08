//! SQLite-backed video library (`library.db` inside the data directory) and
//! local cover-image cache (`thumbnails/<id>.jpg`).

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const DB_FILE: &str = "library.db";
pub const LEGACY_JSON_FILE: &str = "library.json";
pub const THUMB_DIR: &str = "thumbnails";

/// Max accepted cover image size (protects against bogus responses).
const MAX_THUMB_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Video {
    pub id: String,
    pub url: String,
    pub title: String,
    pub author: String,
    pub published_at: String,
    pub duration_seconds: Option<f64>,
    pub description: String,
    pub thumbnail_url: String,
    pub transcript: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub added_at: String,
    pub updated_at: String,
    /// Absolute path of the locally cached cover image. Output-only: managed by
    /// the backend (see [`Library::cache_thumbnail`]) and ignored on upsert.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_thumbnail: Option<String>,
    /// `youtube` (default) or `github`.
    pub kind: String,
    /// GitHub: Gemini summary of the README.
    pub summary: String,
    /// GitHub: one-line feature headline shown on the generated cover.
    pub headline: String,
    /// GitHub: star count when the repo was (re)fetched.
    pub stars: Option<i64>,
    /// GitHub: primary language.
    pub language: String,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS videos (
    id               TEXT PRIMARY KEY NOT NULL,
    url              TEXT NOT NULL DEFAULT '',
    title            TEXT NOT NULL DEFAULT '',
    author           TEXT NOT NULL DEFAULT '',
    published_at     TEXT NOT NULL DEFAULT '',
    duration_seconds REAL,
    description      TEXT NOT NULL DEFAULT '',
    thumbnail_url    TEXT NOT NULL DEFAULT '',
    thumbnail_file   TEXT,
    transcript       TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'ready',
    error            TEXT,
    added_at         TEXT NOT NULL DEFAULT '',
    updated_at       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_videos_added_at ON videos(added_at DESC);
";

/// v2: GitHub repositories are stored in the same table (`kind = 'github'`).
const MIGRATION_V2: &str = "
ALTER TABLE videos ADD COLUMN kind     TEXT NOT NULL DEFAULT 'youtube';
ALTER TABLE videos ADD COLUMN summary  TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN headline TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN stars    INTEGER;
ALTER TABLE videos ADD COLUMN language TEXT NOT NULL DEFAULT '';
";

const SCHEMA_VERSION: i64 = 2;

pub struct Library {
    dir: PathBuf,
    conn: Connection,
}

fn sql_err(e: rusqlite::Error) -> String {
    format!("数据库错误: {e}")
}

impl Library {
    /// Open (creating if needed) the library in `dir`, migrating a legacy
    /// `library.json` on first use.
    pub fn open(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let conn = Connection::open(dir.join(DB_FILE)).map_err(sql_err)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(sql_err)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(sql_err)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(sql_err)?;
        if version < 1 {
            conn.execute_batch(SCHEMA).map_err(sql_err)?;
            conn.pragma_update(None, "user_version", 1)
                .map_err(sql_err)?;
        }
        if version < SCHEMA_VERSION {
            conn.execute_batch(&format!(
                "BEGIN;{MIGRATION_V2}PRAGMA user_version = {SCHEMA_VERSION};COMMIT;"
            ))
            .map_err(sql_err)?;
        }
        let mut lib = Library {
            dir: dir.to_path_buf(),
            conn,
        };
        lib.migrate_legacy_json()?;
        Ok(lib)
    }

    /// Import `library.json` (old storage format) into the database, then
    /// rename it to `library.json.migrated` so it is not imported twice.
    fn migrate_legacy_json(&mut self) -> Result<(), String> {
        let path = self.dir.join(LEGACY_JSON_FILE);
        if !path.exists() {
            return Ok(());
        }
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let videos: Vec<Video> = serde_json::from_str(&content)
            .map_err(|e| format!("library.json 迁移失败（解析错误）: {e}"))?;
        let tx = self.conn.transaction().map_err(sql_err)?;
        for v in &videos {
            // Keep any row that already exists in the database.
            if !exists(&tx, &v.id)? {
                upsert(&tx, v)?;
            }
        }
        tx.commit().map_err(sql_err)?;
        fs::rename(&path, self.dir.join(format!("{LEGACY_JSON_FILE}.migrated")))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Video>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, url, title, author, published_at, duration_seconds, description,
                        thumbnail_url, transcript, status, error, added_at, updated_at, thumbnail_file,
                        kind, summary, headline, stars, language
                 FROM videos ORDER BY added_at DESC",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    Video {
                        id: r.get(0)?,
                        url: r.get(1)?,
                        title: r.get(2)?,
                        author: r.get(3)?,
                        published_at: r.get(4)?,
                        duration_seconds: r.get(5)?,
                        description: r.get(6)?,
                        thumbnail_url: r.get(7)?,
                        transcript: r.get(8)?,
                        status: r.get(9)?,
                        error: r.get(10)?,
                        added_at: r.get(11)?,
                        updated_at: r.get(12)?,
                        local_thumbnail: None,
                        kind: r.get(14)?,
                        summary: r.get(15)?,
                        headline: r.get(16)?,
                        stars: r.get(17)?,
                        language: r.get(18)?,
                    },
                    r.get::<_, Option<String>>(13)?,
                ))
            })
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (mut v, file) = row.map_err(sql_err)?;
            v.local_thumbnail = file
                .map(|f| self.dir.join(f))
                .filter(|p| p.is_file())
                .map(|p| p.display().to_string());
            out.push(v);
        }
        Ok(out)
    }

    pub fn upsert(&self, v: &Video) -> Result<(), String> {
        upsert(&self.conn, v)
    }

    /// Delete a video and its cached cover image.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let file: Option<String> = self
            .conn
            .query_row(
                "SELECT thumbnail_file FROM videos WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?
            .flatten();
        self.conn
            .execute("DELETE FROM videos WHERE id = ?1", [id])
            .map_err(sql_err)?;
        if let Some(f) = file {
            let _ = fs::remove_file(self.dir.join(f));
        }
        Ok(())
    }

    /// Store image bytes as the video's local cover and record it in the DB.
    /// Returns the absolute path of the stored file.
    pub fn store_thumbnail(&self, id: &str, bytes: &[u8]) -> Result<String, String> {
        if !is_valid_id(id) {
            return Err(format!("非法的视频 ID: {id}"));
        }
        if !exists(&self.conn, id)? {
            return Err(format!("视频不存在: {id}"));
        }
        let ext = image_ext(bytes).ok_or("下载的封面不是有效的图片")?;
        let rel = format!("{THUMB_DIR}/{id}.{ext}");
        let abs = self.dir.join(&rel);
        fs::create_dir_all(self.dir.join(THUMB_DIR)).map_err(|e| e.to_string())?;
        let tmp = abs.with_extension("tmp");
        fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &abs).map_err(|e| e.to_string())?;
        let old: Option<String> = self
            .conn
            .query_row(
                "SELECT thumbnail_file FROM videos WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .map_err(sql_err)?;
        self.conn
            .execute(
                "UPDATE videos SET thumbnail_file = ?2 WHERE id = ?1",
                params![id, rel],
            )
            .map_err(sql_err)?;
        if let Some(old) = old.filter(|o| *o != rel) {
            let _ = fs::remove_file(self.dir.join(old));
        }
        Ok(abs.display().to_string())
    }

    /// Download the cover image (trying each URL in order) and store it locally.
    pub fn cache_thumbnail(&self, id: &str, urls: &[String]) -> Result<String, String> {
        let mut last_err = "没有可用的封面地址".to_string();
        for url in urls {
            match download_image(url) {
                Ok(bytes) => return self.store_thumbnail(id, &bytes),
                Err(e) => last_err = e,
            }
        }
        Err(format!("封面下载失败: {last_err}"))
    }
}

fn exists(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM videos WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
        .map_err(sql_err)
}

fn upsert(conn: &Connection, v: &Video) -> Result<(), String> {
    if v.id.trim().is_empty() {
        return Err("video id 不能为空".into());
    }
    conn.execute(
        "INSERT INTO videos (id, url, title, author, published_at, duration_seconds, description,
                             thumbnail_url, transcript, status, error, added_at, updated_at,
                             kind, summary, headline, stars, language)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET
            url = excluded.url, title = excluded.title, author = excluded.author,
            published_at = excluded.published_at, duration_seconds = excluded.duration_seconds,
            description = excluded.description, thumbnail_url = excluded.thumbnail_url,
            transcript = excluded.transcript, status = excluded.status, error = excluded.error,
            added_at = excluded.added_at, updated_at = excluded.updated_at,
            kind = excluded.kind, summary = excluded.summary, headline = excluded.headline,
            stars = excluded.stars, language = excluded.language",
        params![
            v.id,
            v.url,
            v.title,
            v.author,
            v.published_at,
            v.duration_seconds,
            v.description,
            v.thumbnail_url,
            v.transcript,
            if v.status.is_empty() {
                "ready"
            } else {
                &v.status
            },
            v.error,
            v.added_at,
            v.updated_at,
            if v.kind.is_empty() {
                "youtube"
            } else {
                &v.kind
            },
            v.summary,
            v.headline,
            v.stars,
            v.language
        ],
    )
    .map_err(sql_err)?;
    Ok(())
}

/// YouTube ids are 11 chars of `[A-Za-z0-9_-]`; GitHub entries use
/// `github.<owner>.<repo>` (repo names may contain `.`). Ids never contain a
/// path separator or start with `.`, so they are always safe as file names.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 220
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Detect the image type from magic bytes.
pub fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn download_image(url: &str) -> Result<Vec<u8>, String> {
    if !url.starts_with("https://") {
        return Err(format!("不支持的地址: {url}"));
    }
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(MAX_THUMB_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_THUMB_BYTES {
        return Err("图片过大".into());
    }
    if image_ext(&bytes).is_none() {
        return Err("不是有效的图片".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const JPG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 1, 2, 3];

    fn video(id: &str, added: &str) -> Video {
        Video {
            id: id.into(),
            url: format!("https://www.youtube.com/watch?v={id}"),
            title: format!("title {id}"),
            status: "ready".into(),
            added_at: added.into(),
            updated_at: added.into(),
            duration_seconds: Some(61.0),
            kind: "youtube".into(),
            ..Default::default()
        }
    }

    #[test]
    fn crud_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        assert!(lib.list().unwrap().is_empty());
        lib.upsert(&video("aaaaaaaaaaa", "2024-01-01")).unwrap();
        lib.upsert(&video("bbbbbbbbbbb", "2024-02-01")).unwrap();
        let mut a = video("aaaaaaaaaaa", "2024-01-01");
        a.transcript = "hello".into();
        a.error = Some("boom".into());
        lib.upsert(&a).unwrap();
        let list = lib.list().unwrap();
        assert_eq!(
            list.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            ["bbbbbbbbbbb", "aaaaaaaaaaa"]
        );
        assert_eq!(list[1], a);
        lib.delete("aaaaaaaaaaa").unwrap();
        assert_eq!(lib.list().unwrap().len(), 1);
        // Data persists across connections.
        drop(lib);
        let lib = Library::open(dir.path()).unwrap();
        assert_eq!(lib.list().unwrap()[0].id, "bbbbbbbbbbb");
    }

    #[test]
    fn migrates_legacy_json() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(LEGACY_JSON_FILE),
            r#"[{"id":"aaaaaaaaaaa","url":"u","title":"t","author":"","publishedAt":"",
                "durationSeconds":null,"description":"","thumbnailUrl":"x","transcript":"tr",
                "status":"ready","addedAt":"2024-01-01","updatedAt":"2024-01-01"}]"#,
        )
        .unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let list = lib.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].transcript, "tr");
        assert_eq!(list[0].duration_seconds, None);
        assert!(!dir.path().join(LEGACY_JSON_FILE).exists());
        assert!(dir.path().join("library.json.migrated").exists());
    }

    #[test]
    fn stores_thumbnails_locally() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        assert!(lib.store_thumbnail("aaaaaaaaaaa", JPG).is_err()); // unknown video
        lib.upsert(&video("aaaaaaaaaaa", "2024-01-01")).unwrap();
        assert!(lib.store_thumbnail("aaaaaaaaaaa", b"<html>").is_err());
        assert!(lib.store_thumbnail("../evil", JPG).is_err());
        let path = lib.store_thumbnail("aaaaaaaaaaa", JPG).unwrap();
        assert!(path.ends_with("aaaaaaaaaaa.jpg"));
        assert_eq!(fs::read(&path).unwrap(), JPG);
        assert_eq!(
            lib.list().unwrap()[0].local_thumbnail.as_deref(),
            Some(path.as_str())
        );
        // Upserting from the frontend must not clear the cached cover.
        lib.upsert(&video("aaaaaaaaaaa", "2024-01-01")).unwrap();
        assert!(lib.list().unwrap()[0].local_thumbnail.is_some());
        // A missing file is reported as not cached.
        fs::remove_file(&path).unwrap();
        assert!(lib.list().unwrap()[0].local_thumbnail.is_none());
        let path = lib.store_thumbnail("aaaaaaaaaaa", JPG).unwrap();
        lib.delete("aaaaaaaaaaa").unwrap();
        assert!(!Path::new(&path).exists());
    }

    #[test]
    fn stores_github_entries() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let mut g = video("github.tauri-apps.tauri", "2024-03-01");
        g.kind = "github".into();
        g.summary = "summary".into();
        g.headline = "Build apps".into();
        g.stars = Some(42);
        g.language = "Rust".into();
        lib.upsert(&g).unwrap();
        lib.upsert(&video("aaaaaaaaaaa", "2024-01-01")).unwrap();
        let list = lib.list().unwrap();
        assert_eq!(list[0], g);
        assert_eq!(list[1].kind, "youtube");
        let png = b"\x89PNG\r\n\x1a\nxxxx";
        let path = lib.store_thumbnail("github.socket.io.socket.io", png);
        assert!(path.is_err()); // row does not exist
        let path = lib.store_thumbnail(&g.id, png).unwrap();
        assert!(path.ends_with("github.tauri-apps.tauri.png"));
        assert!(!is_valid_id(".."));
        assert!(!is_valid_id("github/x"));
    }

    #[test]
    fn migrates_v1_schema() {
        let dir = tempfile::tempdir().unwrap();
        {
            let conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO videos (id, title, added_at) VALUES ('aaaaaaaaaaa', 't', '2024')",
                [],
            )
            .unwrap();
        }
        let lib = Library::open(dir.path()).unwrap();
        let list = lib.list().unwrap();
        assert_eq!(list[0].kind, "youtube");
        assert_eq!(list[0].stars, None);
        // Re-opening must not re-run the migration.
        drop(lib);
        Library::open(dir.path()).unwrap();
    }

    #[test]
    fn detects_image_types() {
        assert_eq!(image_ext(JPG), Some("jpg"));
        assert_eq!(image_ext(b"\x89PNG\r\n\x1a\nxxxx"), Some("png"));
        assert_eq!(image_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_ext(b"GIF89a"), None);
    }

    /// Hits the network; run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn downloads_real_cover() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        lib.upsert(&video("dQw4w9WgXcQ", "2024-01-01")).unwrap();
        let urls = vec![
            "https://i.ytimg.com/vi/dQw4w9WgXcQ/nope.jpg".to_string(),
            "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg".to_string(),
        ];
        let path = lib.cache_thumbnail("dQw4w9WgXcQ", &urls).unwrap();
        assert!(fs::metadata(path).unwrap().len() > 1000);
    }
}
