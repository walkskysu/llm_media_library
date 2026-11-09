//! "收藏网页": fetch a web page's HTML and save the page as a PDF.
//!
//! HTML parsing / summarising lives in the frontend (`src/lib/web.ts`); this
//! module does the network calls. Pages are printed to PDF by the user's own
//! browser (see [`crate::browser`]); URLs that already serve a PDF are downloaded.

use serde_json::{Value, json};
use std::io::Read;
use std::time::Duration;

/// Browser-like UA: many sites refuse obvious bots.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 llm-media-library";
/// HTML beyond this is dropped.
const MAX_HTML_BYTES: u64 = 5 * 1024 * 1024;
/// Max size of a PDF served directly by the URL.
pub const MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;

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
    if !is_http_url(url) {
        return Err(format!("不支持的网址: {url}"));
    }
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
    fn rejects_non_http_urls() {
        assert!(fetch_page("file:///etc/passwd").is_err());
        assert!(download_pdf("ftp://example.com/a.pdf").is_err());
    }
}
