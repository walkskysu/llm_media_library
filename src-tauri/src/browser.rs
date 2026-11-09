//! Save a web page as PDF with the user's own local browser.
//!
//! Many articles only show their full content after logging in, so instead of a
//! headless browser we open a *visible* Chrome / Edge / Firefox window on the page.
//! The user logs in if needed and waits until the article is displayed, then the
//! app drives the browser over its remote-debugging protocol: it scrolls through
//! the page (so lazy-loaded images load) and prints it to PDF — text and images
//! exactly as the browser renders them.
//!
//! - Chrome / Edge: Chrome DevTools Protocol (`Page.printToPDF`).
//! - Firefox: WebDriver BiDi (`browsingContext.print`).
//!
//! Each browser gets a dedicated, persistent profile (under the app's local data
//! directory), so a login only has to happen once. Chrome/Edge refuse remote
//! debugging on the user's everyday profile, which is why a separate one is used.

use base64::Engine;
use serde::Serialize;
use serde_json::{Value, json};
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

/// Environment variable that overrides the browser executable.
pub const BROWSER_ENV: &str = "LLM_MEDIA_LIBRARY_BROWSER";
/// How long to wait for the browser's debugging endpoint after launching it.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Max time for one protocol command (scrolling / printing a long article).
const COMMAND_TIMEOUT: Duration = Duration::from_secs(180);
/// Upper bound for a single protocol message (base64 PDF data).
const MAX_MESSAGE_BYTES: usize = 512 * 1024 * 1024;

/// Scrolls through the page so lazy-loaded images are fetched, waits for the
/// images to finish loading, then scrolls back to the top.
const PREPARE_PAGE_JS: &str = r#"(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = document.scrollingElement || document.documentElement;
  document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = "eager"; });
  const start = Date.now();
  let y = 0;
  while (y < el.scrollHeight && Date.now() - start < 30000) {
    y += Math.max(300, Math.floor(window.innerHeight * 0.8));
    window.scrollTo(0, y);
    await sleep(300);
  }
  window.scrollTo(0, 0);
  const pending = Array.from(document.images).filter((i) => !i.complete);
  await Promise.all(pending.map((i) => new Promise((r) => {
    i.addEventListener("load", r, { once: true });
    i.addEventListener("error", r, { once: true });
    setTimeout(r, 8000);
  })));
  await sleep(500);
  return true;
})()"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserKind {
    Chrome,
    Edge,
    Firefox,
}

impl BrowserKind {
    pub const ALL: [BrowserKind; 3] =
        [BrowserKind::Chrome, BrowserKind::Edge, BrowserKind::Firefox];

    pub fn id(self) -> &'static str {
        match self {
            BrowserKind::Chrome => "chrome",
            BrowserKind::Edge => "edge",
            BrowserKind::Firefox => "firefox",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            BrowserKind::Chrome => "Google Chrome",
            BrowserKind::Edge => "Microsoft Edge",
            BrowserKind::Firefox => "Mozilla Firefox",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|k| k.id() == s.trim().to_ascii_lowercase())
    }

    fn is_firefox(self) -> bool {
        self == BrowserKind::Firefox
    }

    /// Guess the browser kind from an executable path (used for the env override).
    pub fn from_path(path: &Path) -> Self {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if name.contains("firefox") {
            BrowserKind::Firefox
        } else if name.contains("edge") {
            BrowserKind::Edge
        } else {
            BrowserKind::Chrome
        }
    }
}

/// An installed browser.
#[derive(Debug, Clone, Serialize)]
pub struct BrowserInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub path: String,
    #[serde(skip)]
    pub kind: BrowserKind,
}

fn candidates(kind: BrowserKind) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if cfg!(windows) {
        let roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(|k| std::env::var_os(k).map(PathBuf::from))
            .collect::<Vec<_>>();
        let rels: &[&str] = match kind {
            BrowserKind::Chrome => &[r"Google\Chrome\Application\chrome.exe"],
            BrowserKind::Edge => &[r"Microsoft\Edge\Application\msedge.exe"],
            BrowserKind::Firefox => &[r"Mozilla Firefox\firefox.exe"],
        };
        for rel in rels {
            v.extend(roots.iter().map(|r| r.join(rel)));
        }
    } else if cfg!(target_os = "macos") {
        let app = match kind {
            BrowserKind::Chrome => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            BrowserKind::Edge => "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            BrowserKind::Firefox => "/Applications/Firefox.app/Contents/MacOS/firefox",
        };
        v.push(PathBuf::from(app));
    } else if let Some(path) = std::env::var_os("PATH") {
        let names: &[&str] = match kind {
            BrowserKind::Chrome => &[
                "google-chrome",
                "google-chrome-stable",
                "chromium",
                "chromium-browser",
            ],
            BrowserKind::Edge => &["microsoft-edge", "microsoft-edge-stable"],
            BrowserKind::Firefox => &["firefox"],
        };
        for dir in std::env::split_paths(&path) {
            v.extend(names.iter().map(|n| dir.join(n)));
        }
    }
    v
}

/// Installed browsers, in the order Chrome, Edge, Firefox. The executable named
/// by [`BROWSER_ENV`] (if any) replaces the auto-detected one of its kind.
pub fn installed() -> Vec<BrowserInfo> {
    let override_path = std::env::var(BROWSER_ENV)
        .ok()
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| p.is_file());
    let override_kind = override_path.as_deref().map(BrowserKind::from_path);
    BrowserKind::ALL
        .into_iter()
        .filter_map(|kind| {
            let path = if override_kind == Some(kind) {
                override_path.clone()
            } else {
                candidates(kind).into_iter().find(|p| p.is_file())
            }?;
            Some(BrowserInfo {
                id: kind.id(),
                name: kind.name(),
                path: path.display().to_string(),
                kind,
            })
        })
        .collect()
}

/// The browser to use: the requested one if installed, otherwise the first installed one.
pub fn pick(requested: Option<&str>) -> Result<BrowserInfo, String> {
    let all = installed();
    let wanted = requested.and_then(BrowserKind::parse);
    if let Some(kind) = wanted {
        return all.into_iter().find(|b| b.kind == kind).ok_or_else(|| {
            format!(
                "未找到 {}。请安装后重试，或选择其他浏览器（也可通过环境变量 {BROWSER_ENV} 指定浏览器路径）",
                kind.name()
            )
        });
    }
    all.into_iter().next().ok_or_else(|| {
        format!(
            "未找到可用的浏览器（Google Chrome / Microsoft Edge / Mozilla Firefox）。可通过环境变量 {BROWSER_ENV} 指定浏览器路径"
        )
    })
}

/// Chromium command line: visible window, dedicated profile, debugging port chosen by the browser.
pub fn chromium_args(url: &str, profile: &Path) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-port=0".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        url.to_string(),
    ]
}

/// Firefox command line: separate instance with a dedicated profile and WebDriver BiDi on `port`.
pub fn firefox_args(url: &str, profile: &Path, port: u16) -> Vec<String> {
    vec![
        "-profile".into(),
        profile.display().to_string(),
        "-no-remote".into(),
        "-new-instance".into(),
        "--remote-debugging-port".into(),
        port.to_string(),
        url.to_string(),
    ]
}

/// Preferences that keep a fresh Firefox profile from showing first-run pages.
const FIREFOX_USER_JS: &str = r#"user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
"#;

/// Parse Chromium's `DevToolsActivePort` file (first line: port).
pub fn parse_devtools_port(content: &str) -> Option<u16> {
    content
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()
        .filter(|p| *p > 0)
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("无法分配端口: {e}"))?;
    l.local_addr()
        .map(|a| a.port())
        .map_err(|e| format!("无法分配端口: {e}"))
}

fn http_json(url: &str) -> Result<Value, String> {
    ureq::get(url)
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
}

/// A browser window opened for saving a page as PDF.
pub struct Session {
    pub browser: BrowserInfo,
    child: Child,
    port: u16,
}

impl Session {
    /// Open `url` in a visible window of `browser`, using a persistent profile in `profiles_dir`.
    pub fn launch(browser: BrowserInfo, url: &str, profiles_dir: &Path) -> Result<Self, String> {
        let profile = profiles_dir.join(browser.id);
        std::fs::create_dir_all(&profile).map_err(|e| format!("无法创建浏览器配置目录: {e}"))?;
        let firefox_port = if browser.kind.is_firefox() {
            let user_js = profile.join("user.js");
            if !user_js.exists() {
                let _ = std::fs::write(&user_js, FIREFOX_USER_JS);
            }
            Some(free_port()?)
        } else {
            None
        };
        let args = match firefox_port {
            Some(port) => firefox_args(url, &profile, port),
            None => chromium_args(url, &profile),
        };
        let child = Command::new(&browser.path)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("无法启动 {}: {e}", browser.name))?;
        let started = Instant::now();
        let port = loop {
            let found = match firefox_port {
                Some(port) => ("localhost", port)
                    .to_socket_addrs()
                    .ok()
                    .into_iter()
                    .flatten()
                    .any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(500)).is_ok())
                    .then_some(port),
                // A Chromium instance already running on this profile also answers here.
                None => std::fs::read_to_string(profile.join("DevToolsActivePort"))
                    .ok()
                    .and_then(|c| parse_devtools_port(&c))
                    .filter(|p| http_json(&format!("http://127.0.0.1:{p}/json/version")).is_ok()),
            };
            if let Some(port) = found {
                break port;
            }
            if started.elapsed() > STARTUP_TIMEOUT {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} 未能开启远程调试端口。如果该浏览器已用同一配置运行，请先关闭它后重试",
                    browser.name
                ));
            }
            std::thread::sleep(Duration::from_millis(300));
        };
        Ok(Self {
            browser,
            child,
            port,
        })
    }

    /// Scroll through the current page (loading lazy images) and print it to PDF.
    pub fn capture_pdf(&self) -> Result<Vec<u8>, String> {
        let data = if self.browser.kind.is_firefox() {
            self.capture_firefox()?
        } else {
            self.capture_chromium()?
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|e| format!("PDF 数据无效: {e}"))?;
        if !crate::web::is_pdf(&bytes) {
            return Err("浏览器生成的文件不是有效的 PDF".into());
        }
        Ok(bytes)
    }

    fn capture_chromium(&self) -> Result<String, String> {
        let list =
            http_json(&format!("http://127.0.0.1:{}/json/list", self.port)).map_err(|e| {
                format!(
                    "无法连接 {}（浏览器窗口是否已关闭？）: {e}",
                    self.browser.name
                )
            })?;
        let ws_url = pick_chromium_page(&list).ok_or("浏览器中没有打开的网页")?;
        let mut cdp = Rpc::connect(&ws_url)?;
        cdp.call(
            "Runtime.evaluate",
            json!({ "expression": PREPARE_PAGE_JS, "awaitPromise": true, "returnByValue": true }),
        )?;
        let r = cdp.call(
            "Page.printToPDF",
            json!({ "printBackground": true, "transferMode": "ReturnAsBase64" }),
        )?;
        r["data"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "浏览器未返回 PDF 数据".into())
    }

    fn capture_firefox(&self) -> Result<String, String> {
        let mut bidi =
            Rpc::connect(&format!("ws://localhost:{}/session", self.port)).map_err(|e| {
                format!(
                    "无法连接 {}（浏览器窗口是否已关闭？）: {e}",
                    self.browser.name
                )
            })?;
        bidi.call("session.new", json!({ "capabilities": {} }))?;
        let result = (|| {
            let tree = bidi.call("browsingContext.getTree", json!({ "maxDepth": 0 }))?;
            let contexts: Vec<(String, String)> = tree["contexts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| {
                    Some((
                        c["context"].as_str()?.to_string(),
                        c["url"].as_str().unwrap_or_default().to_string(),
                    ))
                })
                .collect();
            // Prefer the visible web page (the tab the user is looking at).
            let mut chosen = None;
            for (ctx, url) in contexts.iter().filter(|(_, u)| crate::web::is_http_url(u)) {
                let r = bidi.call(
                    "script.evaluate",
                    json!({
                        "expression": "document.visibilityState",
                        "target": { "context": ctx },
                        "awaitPromise": false,
                    }),
                );
                let visible = r
                    .map(|v| v["result"]["value"] == "visible")
                    .unwrap_or(false);
                if visible || chosen.is_none() {
                    chosen = Some((ctx.clone(), url.clone()));
                }
                if visible {
                    break;
                }
            }
            let (ctx, _) = chosen.ok_or("浏览器中没有打开的网页")?;
            bidi.call(
                "script.evaluate",
                json!({
                    "expression": PREPARE_PAGE_JS,
                    "target": { "context": ctx },
                    "awaitPromise": true,
                }),
            )?;
            let r = bidi.call(
                "browsingContext.print",
                json!({ "context": ctx, "background": true }),
            )?;
            r["data"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "浏览器未返回 PDF 数据".to_string())
        })();
        let _ = bidi.call("session.end", json!({}));
        result
    }

    /// True while the browser process is still running.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Close the browser window gracefully (so the profile isn't marked as crashed).
    pub fn close(mut self) {
        let graceful = if self.browser.kind.is_firefox() {
            Rpc::connect(&format!("ws://localhost:{}/session", self.port))
                .and_then(|mut b| {
                    b.call("session.new", json!({ "capabilities": {} }))?;
                    b.call("browser.close", json!({}))
                })
                .is_ok()
        } else {
            http_json(&format!("http://127.0.0.1:{}/json/version", self.port))
                .ok()
                .and_then(|v| v["webSocketDebuggerUrl"].as_str().map(str::to_string))
                .and_then(|url| Rpc::connect(&url).ok())
                .map(|mut b| {
                    // The connection drops while the browser shuts down; that's expected.
                    let _ = b.call("Browser.close", json!({}));
                })
                .is_some()
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while graceful && self.is_alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        if self.is_alive() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

/// `webSocketDebuggerUrl` of the web page to print from a CDP `/json/list`
/// response (ordered most recently used first).
pub fn pick_chromium_page(list: &Value) -> Option<String> {
    let pages = list.as_array()?.iter().filter(|t| t["type"] == "page");
    pages
        .filter(|t| crate::web::is_http_url(t["url"].as_str().unwrap_or_default()))
        .find_map(|t| t["webSocketDebuggerUrl"].as_str().map(str::to_string))
}

/// Minimal JSON-RPC over WebSocket, shared by CDP and WebDriver BiDi
/// (both use `{id, method, params}` → `{id, result}` / `{id, error}`).
struct Rpc {
    ws: WebSocket<TcpStream>,
    next_id: u64,
}

impl Rpc {
    fn connect(url: &str) -> Result<Self, String> {
        let rest = url
            .strip_prefix("ws://")
            .ok_or_else(|| format!("不支持的调试地址: {url}"))?;
        let host = rest.split('/').next().unwrap_or_default();
        let addrs: Vec<_> = host
            .to_socket_addrs()
            .map_err(|e| format!("无法解析 {host}: {e}"))?
            .collect();
        let stream = addrs
            .iter()
            .find_map(|a| TcpStream::connect_timeout(a, Duration::from_secs(5)).ok())
            .ok_or_else(|| format!("无法连接浏览器调试端口 {host}"))?;
        stream
            .set_read_timeout(Some(COMMAND_TIMEOUT))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(30)))
            .map_err(|e| e.to_string())?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        let (ws, _) = tungstenite::client::client_with_config(url, stream, Some(config))
            .map_err(|e| format!("无法连接浏览器调试端口: {e}"))?;
        Ok(Self { ws, next_id: 1 })
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "id": id, "method": method, "params": params }).to_string();
        self.ws
            .send(Message::text(msg))
            .map_err(|e| format!("浏览器通信失败: {e}"))?;
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        loop {
            if Instant::now() > deadline {
                return Err(format!("浏览器响应超时 ({method})"));
            }
            let msg = match self.ws.read() {
                Ok(m) => m,
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    return Err(format!("浏览器响应超时 ({method})"));
                }
                Err(e) => return Err(format!("浏览器通信失败: {e}")),
            };
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                Message::Close(_) => return Err("浏览器已断开连接".into()),
                _ => continue,
            };
            let Ok(v) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if v["id"].as_u64() != Some(id) {
                continue; // events
            }
            return rpc_result(method, v);
        }
    }
}

/// Extract the result of a CDP / BiDi response, turning protocol errors into messages.
pub fn rpc_result(method: &str, mut v: Value) -> Result<Value, String> {
    // BiDi: {"type":"error","error":"unknown command","message":"..."}
    // CDP:  {"error":{"code":-32000,"message":"..."}}
    if v["type"] == "error" || !v["error"].is_null() {
        let message = v["message"]
            .as_str()
            .or_else(|| v["error"]["message"].as_str())
            .or_else(|| v["error"].as_str())
            .unwrap_or("unknown error");
        return Err(format!("浏览器命令 {method} 失败: {message}"));
    }
    if let Some(r) = v["result"].as_object() {
        // CDP Runtime.evaluate reports page exceptions inside the result.
        if let Some(ex) = r.get("exceptionDetails") {
            let text = ex["exception"]["description"]
                .as_str()
                .or_else(|| ex["text"].as_str())
                .unwrap_or("script error");
            return Err(format!("网页脚本执行失败: {text}"));
        }
    }
    Ok(v["result"].take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_browser_kinds() {
        assert_eq!(BrowserKind::parse("Chrome"), Some(BrowserKind::Chrome));
        assert_eq!(BrowserKind::parse("firefox"), Some(BrowserKind::Firefox));
        assert_eq!(BrowserKind::parse("edge"), Some(BrowserKind::Edge));
        assert_eq!(BrowserKind::parse("auto"), None);
        assert_eq!(
            BrowserKind::from_path(Path::new(r"C:\Program Files\Mozilla Firefox\firefox.exe")),
            BrowserKind::Firefox
        );
        assert_eq!(
            BrowserKind::from_path(Path::new("/usr/bin/microsoft-edge")),
            BrowserKind::Edge
        );
        assert_eq!(
            BrowserKind::from_path(Path::new("/usr/bin/chromium")),
            BrowserKind::Chrome
        );
    }

    #[test]
    fn builds_command_lines() {
        let a = chromium_args("https://example.com/", Path::new("/p/chrome"));
        assert_eq!(a.last().unwrap(), "https://example.com/");
        assert!(a.contains(&"--remote-debugging-port=0".to_string()));
        assert!(a.iter().any(|x| x == "--user-data-dir=/p/chrome"));
        assert!(!a.iter().any(|x| x.contains("headless")));

        let f = firefox_args("https://example.com/", Path::new("/p/firefox"), 9333);
        assert_eq!(f.last().unwrap(), "https://example.com/");
        let i = f
            .iter()
            .position(|x| x == "--remote-debugging-port")
            .unwrap();
        assert_eq!(f[i + 1], "9333");
        assert!(f.contains(&"-no-remote".to_string()));
    }

    #[test]
    fn parses_devtools_active_port() {
        assert_eq!(
            parse_devtools_port("53211\n/devtools/browser/abc\n"),
            Some(53211)
        );
        assert_eq!(parse_devtools_port(""), None);
        assert_eq!(parse_devtools_port("0\n"), None);
        assert_eq!(parse_devtools_port("x\n"), None);
    }

    #[test]
    fn picks_web_page_target() {
        let list = json!([
            { "type": "service_worker", "url": "https://a.com/sw.js", "webSocketDebuggerUrl": "ws://sw" },
            { "type": "page", "url": "chrome://newtab/", "webSocketDebuggerUrl": "ws://newtab" },
            { "type": "page", "url": "https://example.com/article", "webSocketDebuggerUrl": "ws://article" },
            { "type": "page", "url": "https://other.com/", "webSocketDebuggerUrl": "ws://other" }
        ]);
        assert_eq!(pick_chromium_page(&list).as_deref(), Some("ws://article"));
        assert_eq!(pick_chromium_page(&json!([])), None);
    }

    #[test]
    fn extracts_rpc_results() {
        let ok = rpc_result(
            "Page.printToPDF",
            json!({ "id": 1, "result": { "data": "JVBERi0=" } }),
        );
        assert_eq!(ok.unwrap()["data"], "JVBERi0=");
        let bidi_ok = rpc_result(
            "x",
            json!({ "type": "success", "id": 2, "result": { "data": "x" } }),
        );
        assert_eq!(bidi_ok.unwrap()["data"], "x");
        let cdp_err = rpc_result(
            "x",
            json!({ "id": 1, "error": { "code": -32000, "message": "boom" } }),
        );
        assert!(cdp_err.unwrap_err().contains("boom"));
        let bidi_err = rpc_result(
            "x",
            json!({ "type": "error", "id": 1, "error": "no such frame", "message": "gone" }),
        );
        assert!(bidi_err.unwrap_err().contains("gone"));
        let script_err = rpc_result(
            "Runtime.evaluate",
            json!({ "id": 1, "result": { "exceptionDetails": { "text": "Uncaught", "exception": { "description": "TypeError: x" } } } }),
        );
        assert!(script_err.unwrap_err().contains("TypeError"));
    }

    /// Opens a real browser window and hits the network. Point
    /// `LLM_MEDIA_LIBRARY_BROWSER` at Chrome/Edge/Firefox and run with
    /// `cargo test -- --ignored captures_real_page`.
    #[test]
    #[ignore]
    fn captures_real_page() {
        let dir = tempfile::tempdir().unwrap();
        let info = pick(None).unwrap();
        let url = std::env::var("LLM_MEDIA_LIBRARY_TEST_URL")
            .unwrap_or_else(|_| "https://example.com/".into());
        let session = Session::launch(info, &url, dir.path()).unwrap();
        std::thread::sleep(Duration::from_secs(8));
        let bytes = session.capture_pdf();
        session.close();
        let bytes = bytes.unwrap();
        assert!(crate::web::is_pdf(&bytes));
        assert!(bytes.len() > 1000, "{} bytes", bytes.len());
        if let Ok(out) = std::env::var("LLM_MEDIA_LIBRARY_TEST_OUT") {
            std::fs::write(out, &bytes).unwrap();
        }
    }
}
