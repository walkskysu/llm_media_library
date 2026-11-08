//! Fetch public GitHub repository info + README for "收藏 GitHub 仓库".
//!
//! Parsing / summarising lives in the frontend (`src/lib/github.ts`); the
//! backend only does the network calls (with a proper User-Agent).

use serde_json::{Value, json};
use std::io::Read;
use std::time::Duration;

const USER_AGENT: &str = concat!("llm-media-library/", env!("CARGO_PKG_VERSION"));
/// README text beyond this is dropped (the summary prompt truncates further anyway).
const MAX_README_BYTES: u64 = 512 * 1024;

/// GitHub owner / repository names: `[A-Za-z0-9._-]`, not `.` / `..`.
pub fn is_valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

#[allow(clippy::result_large_err)]
fn get(url: &str, accept: &str) -> Result<ureq::Response, ureq::Error> {
    ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", accept)
        .timeout(Duration::from_secs(20))
        .call()
}

fn api_error(e: ureq::Error, what: &str) -> String {
    match e {
        ureq::Error::Status(404, _) => format!("{what}不存在或不是公开仓库"),
        ureq::Error::Status(403 | 429, _) => "GitHub API 请求过于频繁，请稍后再试".into(),
        e => format!("获取{what}失败: {e}"),
    }
}

/// `{ "repo": <GitHub API repo JSON>, "readme": "<raw README text or empty>" }`
pub fn fetch_repo(owner: &str, repo: &str) -> Result<Value, String> {
    if !is_valid_name(owner) || !is_valid_name(repo) {
        return Err(format!("无效的 GitHub 仓库: {owner}/{repo}"));
    }
    let base = format!("https://api.github.com/repos/{owner}/{repo}");
    let info: Value = get(&base, "application/vnd.github+json")
        .map_err(|e| api_error(e, "GitHub 仓库"))
        .and_then(|r| {
            serde_json::from_reader(r.into_reader().take(4 * 1024 * 1024))
                .map_err(|e| format!("无法解析 GitHub 响应: {e}"))
        })?;
    let readme = match get(&format!("{base}/readme"), "application/vnd.github.raw") {
        Ok(r) => {
            let mut bytes = Vec::new();
            r.into_reader()
                .take(MAX_README_BYTES)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("读取 README 失败: {e}"))?;
            String::from_utf8_lossy(&bytes).into_owned()
        }
        Err(ureq::Error::Status(404, _)) => String::new(),
        Err(e) => return Err(api_error(e, "README ")),
    };
    Ok(json!({ "repo": info, "readme": readme }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names() {
        assert!(is_valid_name("tauri-apps"));
        assert!(is_valid_name("socket.io"));
        assert!(is_valid_name(".github"));
        assert!(!is_valid_name(".."));
        assert!(!is_valid_name("a/b"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("a b"));
    }

    /// Hits the network; run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn fetches_real_repo() {
        let v = fetch_repo("tauri-apps", "tauri").unwrap();
        assert_eq!(v["repo"]["full_name"], "tauri-apps/tauri");
        assert!(v["readme"].as_str().unwrap().len() > 100);
    }
}
