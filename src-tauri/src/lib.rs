//! Backend for LLM Media Library.
//!
//! Responsibilities:
//! - remember the user-chosen data directory (stored in the OS app-config dir)
//! - persist the video library in SQLite (`library.db`) inside that data directory,
//!   with cover images cached locally under `thumbnails/` (see [`db`])
//! - load `GEMINI_API_KEY` / `GEMINI_API_MODEL` from a `conf.json` file
//!   (a legacy `.env` in the data directory is migrated automatically)

pub mod db;

use db::{Library, Video};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";
const CONF_FILE: &str = "conf.json";
const LEGACY_ENV_FILE: &str = ".env";
const KEY_API_KEY: &str = "GEMINI_API_KEY";
const KEY_MODEL: &str = "GEMINI_API_MODEL";

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub data_dir: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeminiConfig {
    pub api_key: Option<String>,
    pub model: Option<String>,
    /// Where the values were found (for display in the settings screen).
    pub source: Option<String>,
}

/// Parse the contents of a legacy `.env` file (KEY=VALUE lines, `#` comments,
/// optional `export ` prefix, optional single/double quotes).
///
/// Only used to migrate old `.env` files to `conf.json`.
pub fn parse_env(content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut value = value.trim();
        let quoted = value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')));
        if quoted {
            value = &value[1..value.len() - 1];
        } else if let Some(idx) = value.find(" #") {
            value = value[..idx].trim_end();
        }
        map.insert(key.to_string(), value.to_string());
    }
    map
}

/// Parse a `conf.json` body into a JSON object. Invalid JSON or a non-object
/// top level is reported as an error.
pub fn parse_conf(content: &str) -> Result<Map<String, Value>, String> {
    if content.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(content) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err("conf.json 顶层必须是 JSON 对象".into()),
        Err(e) => Err(format!("conf.json 格式错误: {e}")),
    }
}

/// Merge-update a `conf.json` body, replacing existing keys, adding new ones
/// and keeping every other key untouched. Returns pretty-printed JSON.
pub fn update_conf(content: &str, updates: &[(&str, &str)]) -> Result<String, String> {
    let mut map = parse_conf(content)?;
    for (k, v) in updates {
        map.insert((*k).to_string(), Value::String((*v).to_string()));
    }
    let mut s = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    s.push('\n');
    Ok(s)
}

/// Convert legacy `.env` contents to a `conf.json` body (only the Gemini keys).
pub fn env_to_conf(content: &str) -> Result<String, String> {
    let env = parse_env(content);
    let updates: Vec<(&str, &str)> = [KEY_API_KEY, KEY_MODEL]
        .iter()
        .filter_map(|k| env.get(*k).map(|v| (*k, v.as_str())))
        .collect();
    update_conf("", &updates)
}

/// If `dir/conf.json` does not exist but a legacy `dir/.env` does, create
/// `conf.json` from it. The old `.env` is left in place.
pub fn migrate_legacy_env(dir: &Path) -> Result<bool, String> {
    let conf = dir.join(CONF_FILE);
    let legacy = dir.join(LEGACY_ENV_FILE);
    if conf.exists() {
        return Ok(false);
    }
    let Ok(content) = fs::read_to_string(&legacy) else {
        return Ok(false);
    };
    write_atomic(&conf, &env_to_conf(&content)?)?;
    Ok(true)
}

fn conf_str(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Resolve Gemini settings from a list of candidate `conf.json` files (first hit
/// wins per key) and finally from process environment variables.
pub fn resolve_gemini_config(candidates: &[PathBuf]) -> GeminiConfig {
    let mut cfg = GeminiConfig::default();
    for path in candidates {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        let conf = match parse_conf(&content) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("ignoring {}: {e}", path.display());
                continue;
            }
        };
        let key = conf_str(&conf, KEY_API_KEY);
        let model = conf_str(&conf, KEY_MODEL);
        if cfg.api_key.is_none() && key.is_some() {
            cfg.api_key = key;
            cfg.source = Some(path.display().to_string());
        }
        if cfg.model.is_none() && model.is_some() {
            cfg.model = model;
        }
    }
    if cfg.api_key.is_none()
        && let Some(key) = non_empty(std::env::var(KEY_API_KEY).ok())
    {
        cfg.api_key = Some(key);
        cfg.source = Some("environment variable".into());
    }
    if cfg.model.is_none() {
        cfg.model = non_empty(std::env::var(KEY_MODEL).ok());
    }
    cfg
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

fn read_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    read_settings(app)
        .data_dir
        .map(PathBuf::from)
        .ok_or_else(|| "尚未设置数据目录 (data directory not configured)".to_string())
}

/// Write a file atomically (write to temp file then rename).
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    read_settings(&app)
}

#[tauri::command]
fn set_data_dir(app: AppHandle, path: String) -> Result<Settings, String> {
    let dir = PathBuf::from(path.trim());
    if path.trim().is_empty() {
        return Err("路径不能为空".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建目录: {e}"))?;
    // Make sure we can actually write there.
    let probe = dir.join(".write-test");
    fs::write(&probe, b"ok").map_err(|e| format!("目录不可写: {e}"))?;
    let _ = fs::remove_file(probe);

    let settings = Settings {
        data_dir: Some(dir.display().to_string()),
    };
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    write_atomic(&settings_path(&app)?, &content)?;
    // Open once so the database is created / legacy JSON is migrated right away.
    Library::open(&dir)?;
    allow_thumbnail_dir(&app, &dir);
    Ok(settings)
}

/// Let the webview load cached cover images through the asset protocol.
fn allow_thumbnail_dir(app: &AppHandle, dir: &Path) {
    let thumbs = dir.join(db::THUMB_DIR);
    let _ = fs::create_dir_all(&thumbs);
    if let Err(e) = app.asset_protocol_scope().allow_directory(&thumbs, true) {
        eprintln!("failed to allow thumbnail dir in asset scope: {e}");
    }
}

/// Run a blocking library operation off the main thread.
async fn with_library<T, F>(app: AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Library) -> Result<T, String> + Send + 'static,
{
    let dir = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || f(&Library::open(&dir)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_library(app: AppHandle) -> Result<Vec<Video>, String> {
    allow_thumbnail_dir(&app, &data_dir(&app)?);
    with_library(app, |lib| lib.list()).await
}

#[tauri::command]
async fn save_video(app: AppHandle, video: Video) -> Result<(), String> {
    with_library(app, move |lib| lib.upsert(&video)).await
}

#[tauri::command]
async fn delete_video(app: AppHandle, id: String) -> Result<(), String> {
    with_library(app, move |lib| lib.delete(&id)).await
}

/// Download the cover image to `数据目录/thumbnails/` and return its absolute path.
#[tauri::command]
async fn cache_thumbnail(app: AppHandle, id: String, urls: Vec<String>) -> Result<String, String> {
    with_library(app, move |lib| lib.cache_thumbnail(&id, &urls)).await
}

fn conf_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(dir) = data_dir(app) {
        if let Err(e) = migrate_legacy_env(&dir) {
            eprintln!("failed to migrate legacy .env: {e}");
        }
        v.push(dir.join(CONF_FILE));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        v.push(dir.join(CONF_FILE));
    }
    if let Ok(cwd) = std::env::current_dir() {
        v.push(cwd.join(CONF_FILE));
        // `tauri dev` runs inside src-tauri/, the project conf.json lives one level up.
        if let Some(parent) = cwd.parent() {
            v.push(parent.join(CONF_FILE));
        }
    }
    v
}

#[tauri::command]
fn load_gemini_config(app: AppHandle) -> GeminiConfig {
    resolve_gemini_config(&conf_candidates(&app))
}

#[tauri::command]
fn save_gemini_config(
    app: AppHandle,
    api_key: String,
    model: String,
) -> Result<GeminiConfig, String> {
    let dir = data_dir(&app)?;
    migrate_legacy_env(&dir)?;
    let path = dir.join(CONF_FILE);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let body = update_conf(
        &existing,
        &[(KEY_API_KEY, api_key.trim()), (KEY_MODEL, model.trim())],
    )?;
    write_atomic(&path, &body)?;
    Ok(resolve_gemini_config(&conf_candidates(&app)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_data_dir,
            load_library,
            save_video,
            delete_video,
            cache_thumbnail,
            load_gemini_config,
            save_gemini_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_env_files() {
        let env = parse_env(
            "# comment\nGEMINI_API_KEY=abc123\nexport GEMINI_API_MODEL=\"gemini-2.5-flash\"\nEMPTY=\nX='q # not comment'\nY=v # trailing\nbad line\n",
        );
        assert_eq!(env.get("GEMINI_API_KEY").unwrap(), "abc123");
        assert_eq!(env.get("GEMINI_API_MODEL").unwrap(), "gemini-2.5-flash");
        assert_eq!(env.get("EMPTY").unwrap(), "");
        assert_eq!(env.get("X").unwrap(), "q # not comment");
        assert_eq!(env.get("Y").unwrap(), "v");
        assert!(!env.contains_key("bad line"));
    }

    #[test]
    fn updates_conf_preserving_other_keys() {
        let out = update_conf(
            "{\"FOO\": 1, \"GEMINI_API_KEY\": \"old\"}",
            &[("GEMINI_API_KEY", "new"), ("GEMINI_API_MODEL", "m")],
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["FOO"], 1);
        assert_eq!(v["GEMINI_API_KEY"], "new");
        assert_eq!(v["GEMINI_API_MODEL"], "m");
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn update_conf_rejects_invalid_json() {
        assert!(update_conf("not json", &[("A", "b")]).is_err());
        assert!(update_conf("[1, 2]", &[("A", "b")]).is_err());
        assert!(update_conf("", &[("A", "b")]).is_ok());
    }

    #[test]
    fn resolves_config_first_file_wins() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.json");
        let b = dir.path().join("b.json");
        let bad = dir.path().join("bad.json");
        fs::write(&a, r#"{"GEMINI_API_KEY": ""}"#).unwrap();
        fs::write(&bad, "{oops").unwrap();
        fs::write(
            &b,
            r#"{"GEMINI_API_KEY": "key-b", "GEMINI_API_MODEL": "model-b"}"#,
        )
        .unwrap();
        let missing = dir.path().join("missing.json");
        let cfg = resolve_gemini_config(&[missing, a, bad, b.clone()]);
        assert_eq!(cfg.api_key.as_deref(), Some("key-b"));
        assert_eq!(cfg.model.as_deref(), Some("model-b"));
        assert_eq!(cfg.source, Some(b.display().to_string()));
    }

    #[test]
    fn migrates_legacy_env_once() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(".env"),
            "# c\nGEMINI_API_KEY=abc\nGEMINI_API_MODEL=m1\nOTHER=x\n",
        )
        .unwrap();
        assert!(migrate_legacy_env(dir.path()).unwrap());
        let conf = dir.path().join("conf.json");
        let cfg = resolve_gemini_config(std::slice::from_ref(&conf));
        assert_eq!(cfg.api_key.as_deref(), Some("abc"));
        assert_eq!(cfg.model.as_deref(), Some("m1"));
        let v: Value = serde_json::from_str(&fs::read_to_string(&conf).unwrap()).unwrap();
        assert!(v.get("OTHER").is_none());
        // Existing conf.json is never overwritten.
        fs::write(&conf, r#"{"GEMINI_API_KEY": "kept"}"#).unwrap();
        assert!(!migrate_legacy_env(dir.path()).unwrap());
        let cfg = resolve_gemini_config(&[conf]);
        assert_eq!(cfg.api_key.as_deref(), Some("kept"));
    }

    #[test]
    fn no_migration_without_legacy_env() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!migrate_legacy_env(dir.path()).unwrap());
        assert!(!dir.path().join("conf.json").exists());
    }
}
