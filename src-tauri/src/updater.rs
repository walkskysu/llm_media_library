//! "检查升级 / 安装更新": query GitHub Releases and download + launch the installer.
//!
//! Release parsing / version comparison lives in the frontend (`src/lib/update.ts`);
//! the backend only does the network and process work, which the webview can't.

use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const REPO: &str = "walkskysu/llm_media_library";
const USER_AGENT: &str = concat!("llm-media-library/", env!("CARGO_PKG_VERSION"));
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;

fn download_prefix() -> String {
    format!("https://github.com/{REPO}/releases/download/")
}

/// Latest published (non-draft, non-prerelease) release as raw GitHub API JSON,
/// or `None` if the repository has no release yet.
pub fn fetch_latest_release() -> Result<Option<Value>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .call();
    match resp {
        Ok(r) => serde_json::from_reader::<_, Value>(r.into_reader().take(16 * 1024 * 1024))
            .map(Some)
            .map_err(|e| format!("无法解析 GitHub 响应: {e}")),
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(ureq::Error::Status(403 | 429, _)) => Err("GitHub API 请求过于频繁，请稍后再试".into()),
        Err(e) => Err(format!("检查更新失败: {e}")),
    }
}

/// Validate the installer URL and derive a safe local file name from it.
pub fn installer_file_name(url: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix(&download_prefix())
        .ok_or_else(|| format!("不允许的下载地址: {url}"))?;
    let name = rest.rsplit('/').next().unwrap_or_default();
    let name = name.split(['?', '#']).next().unwrap_or_default();
    let lower = name.to_ascii_lowercase();
    let valid_chars = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "._-%+".contains(c));
    if name.is_empty() || !valid_chars || name.starts_with('.') {
        return Err(format!("无效的安装包文件名: {name}"));
    }
    if !(lower.ends_with(".exe") || lower.ends_with(".msi")) {
        return Err("安装包必须是 .exe 或 .msi 文件".into());
    }
    Ok(name.to_string())
}

/// Download `url` (a release asset of this repository) into `dir`; returns the file path.
pub fn download_installer(url: &str, dir: &Path) -> Result<PathBuf, String> {
    let name = installer_file_name(url)?;
    fs::create_dir_all(dir).map_err(|e| format!("无法创建下载目录: {e}"))?;
    let resp = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|e| format!("下载失败: {e}"))?;
    let expected: Option<u64> = resp.header("Content-Length").and_then(|v| v.parse().ok());
    let path = dir.join(&name);
    let tmp = dir.join(format!("{name}.part"));
    let mut file = fs::File::create(&tmp).map_err(|e| format!("无法写入文件: {e}"))?;
    let copied = std::io::copy(
        &mut resp.into_reader().take(MAX_INSTALLER_BYTES + 1),
        &mut file,
    )
    .map_err(|e| format!("下载失败: {e}"))?;
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    let fail = |msg: String| {
        let _ = fs::remove_file(&tmp);
        Err(msg)
    };
    if copied > MAX_INSTALLER_BYTES {
        return fail("安装包过大".into());
    }
    if expected.is_some_and(|n| n != copied) || copied == 0 {
        return fail("下载不完整，请重试".into());
    }
    let _ = fs::remove_file(&path);
    fs::rename(&tmp, &path).map_err(|e| format!("无法保存安装包: {e}"))?;
    Ok(path)
}

/// Start the installer detached from this process.
pub fn launch_installer(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::process::Command;
        let is_msi = path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("msi"));
        let mut cmd = if is_msi {
            let mut c = Command::new("msiexec");
            c.arg("/i").arg(path);
            c
        } else {
            Command::new(path)
        };
        cmd.spawn().map_err(|e| format!("无法启动安装程序: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(format!(
            "自动安装仅支持 Windows，安装包已下载到: {}",
            path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_installer_urls() {
        let base = download_prefix();
        assert_eq!(
            installer_file_name(&format!(
                "{base}v0.2.0/LLM.Media.Library_0.2.0_x64-setup.exe"
            ))
            .unwrap(),
            "LLM.Media.Library_0.2.0_x64-setup.exe"
        );
        assert!(installer_file_name(&format!("{base}v0.2.0/app_0.2.0_x64_en-US.msi")).is_ok());
        assert!(installer_file_name("https://evil.example/x-setup.exe").is_err());
        assert!(
            installer_file_name("https://github.com/other/repo/releases/download/v1/x.exe")
                .is_err()
        );
        assert!(installer_file_name(&format!("{base}v0.2.0/SHA256SUMS.txt")).is_err());
        assert!(installer_file_name(&format!("{base}v0.2.0/..exe")).is_err());
        assert!(installer_file_name(&format!("{base}v0.2.0/a b.exe")).is_err());
        assert!(installer_file_name(&base).is_err());
    }
}
