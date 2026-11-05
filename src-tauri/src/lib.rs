//! Backend for LLM Media Library.
//!
//! Responsibilities:
//! - remember the user-chosen data directory (stored in the OS app-config dir)
//! - persist the video library in SQLite (`library.db`) inside that data directory,
//!   with cover images cached locally under `thumbnails/` (see [`db`])
//! - load `GEMINI_API_KEY` / `GEMINI_API_MODEL` from a `.env` file

pub mod db;

use db::{Library, Video};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";
const ENV_FILE: &str = ".env";

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

/// Parse the contents of a `.env` file (KEY=VALUE lines, `#` comments,
/// optional `export ` prefix, optional single/double quotes).
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

/// Merge-update a `.env` file body, replacing existing keys and appending new ones.
pub fn update_env(content: &str, updates: &[(&str, &str)]) -> String {
    let mut remaining: Vec<(&str, &str)> = updates.to_vec();
    let mut out: Vec<String> = Vec::new();
    for raw in content.lines() {
        let trimmed = raw.trim();
        let key = trimmed
            .strip_prefix("export ")
            .unwrap_or(trimmed)
            .split_once('=')
            .map(|(k, _)| k.trim());
        if let Some(key) = key
            && !trimmed.starts_with('#')
            && let Some(pos) = remaining.iter().position(|(k, _)| *k == key)
        {
            let (k, v) = remaining.remove(pos);
            out.push(format!("{k}={v}"));
            continue;
        }
        out.push(raw.to_string());
    }
    for (k, v) in remaining {
        out.push(format!("{k}={v}"));
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

fn non_empty(v: Option<&String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Resolve Gemini settings from a list of candidate `.env` files (first hit wins
/// per key) and finally from process environment variables.
pub fn resolve_gemini_config(candidates: &[PathBuf]) -> GeminiConfig {
    let mut cfg = GeminiConfig::default();
    for path in candidates {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        let env = parse_env(&content);
        let key = non_empty(env.get("GEMINI_API_KEY"));
        let model = non_empty(env.get("GEMINI_API_MODEL"));
        if cfg.api_key.is_none() && key.is_some() {
            cfg.api_key = key;
            cfg.source = Some(path.display().to_string());
        }
        if cfg.model.is_none() && model.is_some() {
            cfg.model = model;
        }
    }
    if cfg.api_key.is_none()
        && let Some(key) = non_empty(std::env::var("GEMINI_API_KEY").ok().as_ref())
    {
        cfg.api_key = Some(key);
        cfg.source = Some("environment variable".into());
    }
    if cfg.model.is_none() {
        cfg.model = non_empty(std::env::var("GEMINI_API_MODEL").ok().as_ref());
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

fn env_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(dir) = data_dir(app) {
        v.push(dir.join(ENV_FILE));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        v.push(dir.join(ENV_FILE));
    }
    if let Ok(cwd) = std::env::current_dir() {
        v.push(cwd.join(ENV_FILE));
        // `tauri dev` runs inside src-tauri/, the project .env lives one level up.
        if let Some(parent) = cwd.parent() {
            v.push(parent.join(ENV_FILE));
        }
    }
    v
}

#[tauri::command]
fn load_gemini_config(app: AppHandle) -> GeminiConfig {
    resolve_gemini_config(&env_candidates(&app))
}

#[tauri::command]
fn save_gemini_config(
    app: AppHandle,
    api_key: String,
    model: String,
) -> Result<GeminiConfig, String> {
    let path = data_dir(&app)?.join(ENV_FILE);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let body = update_env(
        &existing,
        &[
            ("GEMINI_API_KEY", api_key.trim()),
            ("GEMINI_API_MODEL", model.trim()),
        ],
    );
    write_atomic(&path, &body)?;
    Ok(resolve_gemini_config(&env_candidates(&app)))
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
    fn updates_env_preserving_other_lines() {
        let out = update_env(
            "# keep\nFOO=1\nGEMINI_API_KEY=old\n",
            &[("GEMINI_API_KEY", "new"), ("GEMINI_API_MODEL", "m")],
        );
        assert_eq!(
            out,
            "# keep\nFOO=1\nGEMINI_API_KEY=new\nGEMINI_API_MODEL=m\n"
        );
    }

    #[test]
    fn resolves_config_first_file_wins() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.env");
        let b = dir.path().join("b.env");
        fs::write(&a, "GEMINI_API_KEY=\n").unwrap();
        fs::write(&b, "GEMINI_API_KEY=key-b\nGEMINI_API_MODEL=model-b\n").unwrap();
        let missing = dir.path().join("missing.env");
        let cfg = resolve_gemini_config(&[missing, a, b.clone()]);
        assert_eq!(cfg.api_key.as_deref(), Some("key-b"));
        assert_eq!(cfg.model.as_deref(), Some("model-b"));
        assert_eq!(cfg.source, Some(b.display().to_string()));
    }
}
