//! "收藏网页": fetch a web page's HTML and save the page as a PDF.
//!
//! HTML parsing / summarising lives in the frontend (`src/lib/web.ts`); the
//! backend does the network calls and drives a headless Chromium-based browser
//! (Microsoft Edge is always present on Windows 10/11) to print the page to PDF.

use serde_json::{Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Browser-like UA: many sites refuse obvious bots.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 llm-media-library";
/// HTML beyond this is dropped.
const MAX_HTML_BYTES: u64 = 5 * 1024 * 1024;
/// Max size of a PDF served directly by the URL.
pub const MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;
/// How long the headless browser may take to print one page.
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);
/// Environment variable that overrides the browser used for printing.
pub const BROWSER_ENV: &str = "LLM_MEDIA_LIBRARY_BROWSER";

pub fn is_http_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")) && url.len() <= 4096
}

pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

#[allow(clippy::result_large_err)]
fn get(url: &str) -> Result<ureq::Response, ureq::Error> {
    ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5",
        )
        .set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .timeout(Duration::from_secs(30))
        .call()
}

fn fetch_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("网页返回 HTTP {code}"),
        e => format!("无法访问网页: {e}"),
    }
}

fn read_limited(r: ureq::Response, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    r.into_reader()
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取网页失败: {e}"))?;
    Ok(bytes)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// `{ "finalUrl", "contentType", "body": <base64 of the raw bytes> }`.
///
/// The body is returned undecoded so the frontend can honour the page's
/// charset (GBK / Big5 / Shift_JIS pages are common). For PDF links the body
/// is left empty (only the content type matters).
pub fn fetch_page(url: &str) -> Result<Value, String> {
    if !is_http_url(url) {
        return Err(format!("不支持的网址: {url}"));
    }
    let resp = get(url).map_err(fetch_error)?;
    let final_url = resp.get_url().to_string();
    let content_type = resp.content_type().to_ascii_lowercase();
    let charset_header = resp.header("Content-Type").unwrap_or_default().to_string();
    let body = if content_type == "application/pdf" {
        Vec::new()
    } else {
        read_limited(resp, MAX_HTML_BYTES)?
    };
    let (content_type, body) = if is_pdf(&body) {
        ("application/pdf".to_string(), Vec::new())
    } else {
        (content_type, body)
    };
    Ok(json!({
        "finalUrl": final_url,
        "contentType": content_type,
        "contentTypeHeader": charset_header,
        "body": base64(&body),
    }))
}

/// If the URL serves a PDF directly, download it. `Ok(None)` = not a PDF (or unreachable).
pub fn download_pdf(url: &str) -> Result<Option<Vec<u8>>, String> {
    let Ok(resp) = get(url) else {
        return Ok(None);
    };
    let ct = resp.content_type().to_ascii_lowercase();
    if ct != "application/pdf" && ct != "application/octet-stream" {
        return Ok(None);
    }
    let bytes = read_limited(resp, MAX_PDF_BYTES + 1)?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("PDF 文件过大".into());
    }
    Ok(is_pdf(&bytes).then_some(bytes))
}

/// Candidate Chromium-based browsers, most preferred first.
fn browser_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(p) = std::env::var(BROWSER_ENV)
        && !p.trim().is_empty()
    {
        v.push(PathBuf::from(p.trim()));
    }
    if cfg!(windows) {
        let roots = ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
            .iter()
            .filter_map(|k| std::env::var_os(k).map(PathBuf::from))
            .collect::<Vec<_>>();
        for rel in [
            r"Microsoft\Edge\Application\msedge.exe",
            r"Google\Chrome\Application\chrome.exe",
            r"Chromium\Application\chrome.exe",
            r"BraveSoftware\Brave-Browser\Application\brave.exe",
        ] {
            v.extend(roots.iter().map(|r| r.join(rel)));
        }
    } else if cfg!(target_os = "macos") {
        for app in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ] {
            v.push(PathBuf::from(app));
        }
    } else if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in [
                "chromium",
                "chromium-browser",
                "google-chrome",
                "google-chrome-stable",
                "microsoft-edge",
                "microsoft-edge-stable",
                "brave-browser",
            ] {
                v.push(dir.join(name));
            }
        }
    }
    v
}

pub fn find_browser() -> Option<PathBuf> {
    browser_candidates().into_iter().find(|p| p.is_file())
}

/// Command-line arguments that make a Chromium-based browser print `url` to `out`.
pub fn print_args(url: &str, out: &Path, profile: &Path) -> Vec<String> {
    vec![
        "--headless=new".into(),
        "--disable-gpu".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-extensions".into(),
        "--disable-sync".into(),
        "--mute-audio".into(),
        "--hide-scrollbars".into(),
        "--run-all-compositor-stages-before-draw".into(),
        // Give scripts / lazy content some (virtual) time to render before printing.
        "--virtual-time-budget=15000".into(),
        "--no-pdf-header-footer".into(),
        "--print-to-pdf-no-header".into(),
        // A private profile so a running browser instance doesn't swallow the request.
        format!("--user-data-dir={}", profile.display()),
        format!("--print-to-pdf={}", out.display()),
        url.to_string(),
    ]
}

/// Print `url` to PDF with a headless browser and return the PDF bytes.
pub fn print_to_pdf(url: &str, work_dir: &Path) -> Result<Vec<u8>, String> {
    if !is_http_url(url) {
        return Err(format!("不支持的网址: {url}"));
    }
    let browser = find_browser().ok_or_else(|| {
        format!(
            "未找到可用于生成 PDF 的浏览器（Microsoft Edge / Google Chrome / Chromium）。可通过环境变量 {BROWSER_ENV} 指定浏览器路径"
        )
    })?;
    std::fs::create_dir_all(work_dir).map_err(|e| e.to_string())?;
    let out = work_dir.join("page.pdf");
    let profile = work_dir.join("profile");
    let _ = std::fs::remove_file(&out);

    let mut cmd = Command::new(&browser);
    cmd.args(print_args(url, &out, &profile))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动浏览器 {}: {e}", browser.display()))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > PRINT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("生成 PDF 超时".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => return Err(format!("等待浏览器失败: {e}")),
        }
    }
    let bytes = std::fs::read(&out).map_err(|_| "浏览器未能生成 PDF 文件".to_string())?;
    if !is_pdf(&bytes) {
        return Err("浏览器生成的文件不是有效的 PDF".into());
    }
    Ok(bytes)
}

/// PDF bytes for `url`: the file itself if the URL serves a PDF, otherwise
/// the page printed by a headless browser. `work_dir` is removed afterwards.
pub fn page_pdf(url: &str, work_dir: &Path) -> Result<Vec<u8>, String> {
    if !is_http_url(url) {
        return Err(format!("不支持的网址: {url}"));
    }
    if let Some(bytes) = download_pdf(url)? {
        return Ok(bytes);
    }
    let result = print_to_pdf(url, work_dir);
    let _ = std::fs::remove_dir_all(work_dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00, 0x10]), "//4AEA==");
    }

    #[test]
    fn validates_urls_and_pdf_magic() {
        assert!(is_http_url("https://example.com/a"));
        assert!(is_http_url("HTTP://example.com"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(is_pdf(b"%PDF-1.7\n..."));
        assert!(!is_pdf(b"<html>"));
    }

    #[test]
    fn builds_print_args() {
        let args = print_args(
            "https://example.com/",
            Path::new("/tmp/x/page.pdf"),
            Path::new("/tmp/x/profile"),
        );
        assert_eq!(args.last().unwrap(), "https://example.com/");
        assert!(args.contains(&"--headless=new".to_string()));
        assert!(args.iter().any(|a| a.starts_with("--print-to-pdf=")));
        assert!(args.iter().any(|a| a.starts_with("--user-data-dir=")));
    }

    #[test]
    fn rejects_non_http_urls() {
        let dir = tempfile::tempdir().unwrap();
        assert!(fetch_page("file:///etc/passwd").is_err());
        assert!(page_pdf("ftp://example.com/a.pdf", dir.path()).is_err());
    }

    /// Hits the network and needs a Chromium-based browser; run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn prints_real_page() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = page_pdf("https://example.com/", &dir.path().join("work")).unwrap();
        assert!(is_pdf(&bytes));
    }
}
