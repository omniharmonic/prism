//! "Save export archive" (`save_export`): a finished server export (a ZIP of a
//! page with its sub-pages/files, or of the workspace) saved to a file the USER
//! picks.
//!
//! Why Rust does the download: the webview cancels `<a download>` (this shell
//! sets no download handler on purpose — one would let page script download
//! arbitrary URLs), and an archive can be gigabytes, so it must stream to disk
//! and never cross IPC.
//!
//! 🔒 What the page controls: a JOB ID (strict shape) and a suggested name.
//! It supplies no URL, no path and no token:
//!  - the URL is built here: `<configured origin>/api/export/<id>/download`;
//!  - the bearer comes from the keychain cache and goes to that URL only;
//!  - redirects are refused (the client never follows one), so the bearer and
//!    the bytes cannot be steered to another host;
//!  - the response must be `200` + `application/zip`, within [`MAX_ARCHIVE_BYTES`]
//!    by its declared length AND while streaming, and exactly as long as declared;
//!  - the destination is exactly what the native save panel returned (plus
//!    `.zip` when no extension was typed); bytes go to a fresh sibling
//!    `.<name>.<random>.part` (`create_new`) that is renamed over the target
//!    only after the whole body arrived and was synced, and removed otherwise.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::origin::ServerOrigin;

/// The server never builds a larger archive (`EXPORT_MAX_BYTES` is clamped to
/// the classic-ZIP limit, transfer/export.ts).
pub const MAX_ARCHIVE_BYTES: u64 = 0xf000_0000;
/// No byte for this long = the download is dead.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// A server job id: 16 random bytes as unpadded base64url (transfer/jobs.ts).
pub fn valid_job_id(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The ONLY URL this module ever requests.
pub fn download_url(origin: &ServerOrigin, job_id: &str) -> Option<String> {
    valid_job_id(job_id).then(|| origin.join(&format!("/api/export/{job_id}/download")))
}

/// The name pre-filled in the save panel: sanitised stem + `.zip`.
pub fn zip_name(suggested: &str) -> String {
    let trimmed = suggested.trim();
    let stem = if trimmed.to_ascii_lowercase().ends_with(".zip") {
        &trimmed[..trimmed.len() - 4]
    } else {
        trimmed
    };
    let clean = crate::export::sanitize_stem(stem);
    // sanitize_stem's own fallback name is for notes; an archive with no usable name is "export".
    let fallback = clean == "note" && !stem.trim().eq_ignore_ascii_case("note");
    format!("{}.zip", if fallback { "export" } else { &clean })
}

/// Exactly what the user chose, with `.zip` added only when they typed no extension.
pub fn target_path(chosen: &Path) -> PathBuf {
    if chosen.extension().is_some() {
        chosen.to_path_buf()
    } else {
        let mut os = chosen.as_os_str().to_owned();
        os.push(".zip");
        PathBuf::from(os)
    }
}

/// The temporary sibling the body is streamed into (same folder → the final
/// rename is atomic and never crosses a volume).
pub fn part_path(target: &Path, nonce: &str) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export.zip".into());
    target.with_file_name(format!(".{name}.{nonce}.part"))
}

#[derive(Debug, PartialEq, Eq)]
pub enum SaveError {
    Cancelled,
    Failed(String),
}

impl SaveError {
    fn failed(msg: impl Into<String>) -> Self {
        SaveError::Failed(msg.into())
    }
}

/// One save at a time; the page may cancel the one it started.
#[derive(Default)]
pub struct SaveState(Mutex<Option<(String, Arc<AtomicBool>)>>);

impl SaveState {
    pub fn begin(&self, job_id: &str) -> Result<SaveGuard<'_>, String> {
        let mut slot = self.0.lock().unwrap();
        if slot.is_some() {
            return Err("Another export is being saved. Wait for it to finish.".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        *slot = Some((job_id.to_string(), flag.clone()));
        Ok(SaveGuard { state: self, flag })
    }
    /// Ask the running save of THIS job to stop. Returns whether one was running.
    pub fn cancel(&self, job_id: &str) -> bool {
        match self.0.lock().unwrap().as_ref() {
            Some((id, flag)) if id == job_id => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            _ => false,
        }
    }
}

/// Frees the slot when the save ends, however it ends.
pub struct SaveGuard<'a> {
    state: &'a SaveState,
    flag: Arc<AtomicBool>,
}
impl SaveGuard<'_> {
    pub fn flag(&self) -> &AtomicBool {
        &self.flag
    }
}
impl Drop for SaveGuard<'_> {
    fn drop(&mut self) {
        *self.state.0.lock().unwrap() = None;
    }
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("PrismClient/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

fn refusal(status: u16) -> String {
    match status {
        300..=399 => "The server tried to send the download somewhere else. Nothing was saved.".into(),
        401 | 403 => "You’re signed out, or this export is no longer yours to download.".into(),
        404 | 410 => "This export has expired. Export again.".into(),
        409 => "The export isn’t finished yet.".into(),
        s => format!("The server couldn’t send the export (HTTP {s})."),
    }
}

/// Stream the archive at `url` into `target`. `progress(received, declared)`
/// is called as bytes arrive. Leaves either the complete file at `target` or
/// nothing new on disk.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    target: &Path,
    max_bytes: u64,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<u64, SaveError> {
    if target.is_dir() {
        return Err(SaveError::failed("That location is a folder."));
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(SaveError::Cancelled);
    }
    let sent = client.get(url).bearer_auth(token).send();
    let mut resp = match tokio::time::timeout(IDLE_TIMEOUT, sent).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => return Err(SaveError::failed("Couldn’t reach the server. Nothing was saved.")),
        Err(_) => return Err(SaveError::failed("The server didn’t answer. Nothing was saved.")),
    };
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(SaveError::Failed(refusal(status)));
    }
    let is_zip = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/zip"))
        .unwrap_or(false);
    if !is_zip {
        return Err(SaveError::failed("The server didn’t send an archive. Nothing was saved."));
    }
    let declared = resp.content_length();
    if declared.is_some_and(|n| n > max_bytes) {
        return Err(SaveError::failed("This export is too large to save."));
    }

    let part = part_path(target, &crate::pkce::random_token()[..12]);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
        .map_err(|e| SaveError::Failed(format!("could not write there: {e}")))?;
    let outcome = async {
        let mut received: u64 = 0;
        progress(0, declared);
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(SaveError::Cancelled);
            }
            let chunk = match tokio::time::timeout(IDLE_TIMEOUT, resp.chunk()).await {
                Ok(Ok(Some(c))) => c,
                Ok(Ok(None)) => break,
                Ok(Err(_)) => return Err(SaveError::failed("The download was interrupted. Nothing was saved.")),
                Err(_) => return Err(SaveError::failed("The download stalled. Nothing was saved.")),
            };
            received += chunk.len() as u64;
            if received > max_bytes || declared.is_some_and(|n| received > n) {
                return Err(SaveError::failed("The server sent more than it announced. Nothing was saved."));
            }
            file.write_all(&chunk)
                .map_err(|e| SaveError::Failed(format!("could not write the file: {e}")))?;
            progress(received, declared);
        }
        if declared.is_some_and(|n| received != n) {
            return Err(SaveError::failed("The download was incomplete. Nothing was saved."));
        }
        file.sync_all()
            .map_err(|e| SaveError::Failed(format!("could not write the file: {e}")))?;
        Ok(received)
    }
    .await;
    drop(file);
    match outcome {
        Ok(n) => match std::fs::rename(&part, target) {
            Ok(()) => Ok(n),
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                Err(SaveError::Failed(format!("could not save the file: {e}")))
            }
        },
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// iOS: the folder under the app's tmp directory that holds an archive while the
/// system share sheet is up. The Swift side shares files under this folder ONLY
/// (`PrismIosPlugin.shareFile`) — keep the name in step with it.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub const SHARE_ROOT: &str = "prism-exports";

/// `<tmp>/prism-exports/<nonce>`: one private folder per save, so the file can
/// keep its readable name (the share sheet shows it) without ever colliding.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn share_dir(tmp: &Path, nonce: &str) -> PathBuf {
    tmp.join(SHARE_ROOT).join(nonce)
}

/// Create `dir` (and the share root above it) readable by this app only.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for d in [dir.parent(), Some(dir)].into_iter().flatten() {
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// Remove every archive left under the share root (at launch: a save that was
/// cut short by the app being killed must not leave a workspace export behind).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn purge_share_root(tmp: &Path) {
    let _ = std::fs::remove_dir_all(tmp.join(SHARE_ROOT));
}

/// JS the shell evals to report progress: a DOM event with numbers and the job
/// id (a JSON string literal), never a path.
pub fn progress_js(job_id: &str, received: u64, total: Option<u64>) -> String {
    let id = serde_json::to_string(job_id).expect("a string serializes");
    let total = total.map(|n| n.to_string()).unwrap_or_else(|| "null".into());
    format!(
        "window.dispatchEvent(new CustomEvent(\"prism:export-save-progress\",{{detail:{{jobId:{id},received:{received},total:{total}}}}}));"
    )
}

/// Show the native save panel (main thread) and return the chosen path.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn choose_path_blocking(file_name: &str) -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_title("Save export")
        .set_file_name(file_name)
        .add_filter("ZIP archive", &["zip"])
        .save_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const ID: &str = "AbCdEfGhIjKlMnOpQrStUv";
    const TOKEN: &str = "pd_test-token";

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "prism-export-archive-{}-{name}-{}",
            std::process::id(),
            &crate::pkce::random_token()[..8]
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    /// A one-connection fake server: answers with `head` then the `body` parts
    /// (a pause between parts), and returns the request head it saw.
    async fn fake(
        head: String,
        body: Vec<Vec<u8>>,
        pause: Duration,
    ) -> (ServerOrigin, tokio::task::JoinHandle<String>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = s.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let _ = s.write_all(head.as_bytes()).await;
            for part in body {
                if s.write_all(&part).await.is_err() {
                    break;
                }
                let _ = s.flush().await;
                tokio::time::sleep(pause).await;
            }
            let _ = s.shutdown().await;
            String::from_utf8_lossy(&buf).to_string()
        });
        (
            ServerOrigin::parse(&format!("http://127.0.0.1:{port}")).unwrap(),
            h,
        )
    }
    fn ok_head(len: Option<usize>, content_type: &str) -> String {
        let length = len.map(|n| format!("Content-Length: {n}\r\n")).unwrap_or_default();
        format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n{length}Connection: close\r\n\r\n")
    }
    async fn run(origin: &ServerOrigin, target: &Path, max: u64, cancel: &AtomicBool) -> (Result<u64, SaveError>, Vec<(u64, Option<u64>)>) {
        let mut seen = Vec::new();
        let url = download_url(origin, ID).unwrap();
        let r = download(&client().unwrap(), &url, TOKEN, target, max, cancel, |a, b| seen.push((a, b))).await;
        (r, seen)
    }

    #[test]
    fn job_ids_are_strict_and_the_url_is_built_here() {
        assert!(valid_job_id(ID));
        assert!(valid_job_id("a-_0123456789ABCDEFGHI"));
        for bad in [
            "", "short", "AbCdEfGhIjKlMnOpQrStUvX", "AbCdEfGhIjKlMnOpQrStU", "../../../../etc/passwd..", "AbCdEfGhIjKlMnOpQrSt/v",
            "AbCdEfGhIjKlMnOpQrSt?v", "AbCdEfGhIjKlMnOpQrSt#v", "AbCdEfGhIjKlMnOpQrSt%2", "AbCdEfGhIjKlMnOpQrSt.v", "AbCdEfGhIjKlMnOpQrSt v",
            "AbCdEfGhIjKlMnOpQrSt\\v", "AbCdEfGhIjKlMnOpQrSt@v", "AbCdEfGhIjKlMnOpQrSt:v", "AbCdEfGhIjKlMnOpQrSt\nv", "AbCdEfGhIjKlMnOpQrSté",
        ] {
            assert!(!valid_job_id(bad), "{bad:?}");
        }
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        assert_eq!(
            download_url(&o, ID).as_deref(),
            Some("https://prism.example.com/api/export/AbCdEfGhIjKlMnOpQrStUv/download")
        );
        assert_eq!(download_url(&o, "https://evil.example/x"), None);
        assert_eq!(download_url(&o, "x@evil.example/aaaaaaaaa"), None);
    }

    #[test]
    fn names_and_paths_come_from_the_panel_not_the_page() {
        assert_eq!(zip_name("Plan"), "Plan.zip");
        assert_eq!(zip_name("Plan.zip"), "Plan.zip");
        assert_eq!(zip_name("Plan.ZIP"), "Plan.zip");
        assert_eq!(zip_name("../../etc/passwd.zip"), "etc-passwd.zip");
        assert_eq!(zip_name("C:\\x\\y"), "C--x-y.zip");
        assert_eq!(zip_name(""), "export.zip");
        assert_eq!(zip_name(".zip"), "export.zip");
        assert_eq!(zip_name("a\u{0}b\nc"), "a-b-c.zip");
        for evil in ["a/b", "..", "~/x", ".hidden", "x\\y"] {
            let n = zip_name(evil);
            assert!(!n.contains('/') && !n.contains('\\') && !n.starts_with('.'), "{n}");
        }
        let chosen = Path::new("/Users/me/Desktop/out");
        assert_eq!(target_path(chosen), PathBuf::from("/Users/me/Desktop/out.zip"));
        assert_eq!(target_path(Path::new("/Users/me/Desktop/out.zip")), PathBuf::from("/Users/me/Desktop/out.zip"));
        // The temporary file is a hidden sibling in the SAME folder.
        let part = part_path(Path::new("/Users/me/Desktop/out.zip"), "abc123");
        assert_eq!(part, PathBuf::from("/Users/me/Desktop/.out.zip.abc123.part"));
        assert_eq!(part.parent(), Path::new("/Users/me/Desktop/out.zip").parent());
        // The command's page-controlled surface: no path, no URL, no token.
        let src = include_str!("native_cmds.rs");
        let start = src.find("pub async fn save_export").expect("save_export exists");
        let sig = &src[start..start + src[start..].find(") ->").unwrap()];
        for forbidden in ["path", "PathBuf", "url", "token", "origin"] {
            assert!(!sig.to_lowercase().contains(&forbidden.to_lowercase()), "save_export must not take a {forbidden}: {sig}");
        }
    }

    #[test]
    fn one_save_at_a_time_and_only_its_own_job_can_cancel_it() {
        let s = SaveState::default();
        assert!(!s.cancel(ID), "nothing running");
        let g = s.begin(ID).unwrap();
        assert!(s.begin("zzzzzzzzzzzzzzzzzzzzzz").is_err(), "busy");
        assert!(!s.cancel("zzzzzzzzzzzzzzzzzzzzzz"), "another job's id cancels nothing");
        assert!(!g.flag().load(Ordering::SeqCst));
        assert!(s.cancel(ID));
        assert!(g.flag().load(Ordering::SeqCst));
        drop(g);
        assert!(!s.cancel(ID));
        assert!(s.begin(ID).is_ok(), "the slot is free again");
    }

    #[tokio::test]
    async fn streams_the_archive_to_the_chosen_file_with_the_bearer_and_no_leftover() {
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let parts: Vec<Vec<u8>> = body.chunks(50_000).map(|c| c.to_vec()).collect();
        let (origin, seen) = fake(ok_head(Some(body.len()), "application/zip"), parts, Duration::from_millis(5)).await;
        let dir = tmp("ok");
        let target = dir.join("out.zip");
        std::fs::write(&target, b"old").unwrap(); // the panel already asked about replacing it
        let (r, progress) = run(&origin, &target, MAX_ARCHIVE_BYTES, &AtomicBool::new(false)).await;
        assert_eq!(r, Ok(body.len() as u64));
        assert_eq!(std::fs::read(&target).unwrap(), body);
        assert_eq!(names(&dir), vec!["out.zip".to_string()], "no .part left behind");
        assert_eq!(progress.first(), Some(&(0, Some(body.len() as u64))));
        assert_eq!(progress.last(), Some(&(body.len() as u64, Some(body.len() as u64))));
        assert!(progress.windows(2).all(|w| w[0].0 <= w[1].0), "progress never goes back");
        let req = seen.await.unwrap();
        assert!(req.starts_with(&format!("GET /api/export/{ID}/download HTTP/1.1\r\n")), "{req}");
        assert!(req.to_lowercase().contains(&format!("authorization: bearer {}", TOKEN.to_lowercase())));
        assert!(!req.to_lowercase().contains("cookie:"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_redirect_is_refused_and_never_followed() {
        // The redirect points at a second listener: it must never be contacted.
        let elsewhere = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let there = elsewhere.local_addr().unwrap().port();
        for status in ["302 Found", "301 Moved Permanently", "307 Temporary Redirect", "308 Permanent Redirect"] {
            let head = format!("HTTP/1.1 {status}\r\nLocation: http://127.0.0.1:{there}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let (origin, _seen) = fake(head, vec![], Duration::ZERO).await;
            let dir = tmp("redirect");
            let (r, _) = run(&origin, &dir.join("out.zip"), MAX_ARCHIVE_BYTES, &AtomicBool::new(false)).await;
            assert!(matches!(&r, Err(SaveError::Failed(m)) if m.contains("somewhere else")), "{status}: {r:?}");
            assert!(names(&dir).is_empty(), "{status}: nothing written");
            let _ = std::fs::remove_dir_all(&dir);
        }
        let contacted = tokio::time::timeout(Duration::from_millis(200), elsewhere.accept()).await;
        assert!(contacted.is_err(), "the redirect target was never contacted (the bearer stays with the configured server)");
    }

    #[tokio::test]
    async fn refusals_write_nothing() {
        // Not an archive.
        for ct in ["text/html", "application/json", "application/zipx", "application/octet-stream"] {
            let (origin, _s) = fake(ok_head(Some(5), ct), vec![b"hello".to_vec()], Duration::ZERO).await;
            let dir = tmp("type");
            let (r, _) = run(&origin, &dir.join("out.zip"), MAX_ARCHIVE_BYTES, &AtomicBool::new(false)).await;
            assert!(matches!(&r, Err(SaveError::Failed(m)) if m.contains("didn’t send an archive")), "{ct}: {r:?}");
            assert!(names(&dir).is_empty());
            let _ = std::fs::remove_dir_all(&dir);
        }
        // Server statuses.
        for (status, needle) in [("401 Unauthorized", "signed out"), ("404 Not Found", "expired"), ("409 Conflict", "isn’t finished"), ("500 Internal Server Error", "HTTP 500")] {
            let head = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n");
            let (origin, _s) = fake(head, vec![b"{}".to_vec()], Duration::ZERO).await;
            let dir = tmp("status");
            let (r, _) = run(&origin, &dir.join("out.zip"), MAX_ARCHIVE_BYTES, &AtomicBool::new(false)).await;
            assert!(matches!(&r, Err(SaveError::Failed(m)) if m.contains(needle)), "{status}: {r:?}");
            assert!(names(&dir).is_empty());
            let _ = std::fs::remove_dir_all(&dir);
        }
        // Declared larger than the cap: refused before a byte is written.
        let (origin, _s) = fake(ok_head(Some(5000), "application/zip"), vec![vec![0u8; 5000]], Duration::ZERO).await;
        let dir = tmp("declared");
        let (r, progress) = run(&origin, &dir.join("out.zip"), 1000, &AtomicBool::new(false)).await;
        assert!(matches!(&r, Err(SaveError::Failed(m)) if m.contains("too large")), "{r:?}");
        assert!(names(&dir).is_empty() && progress.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        // No declared length, and the stream runs past the cap: stopped, the partial file removed.
        let (origin, _s) = fake(ok_head(None, "application/zip"), vec![vec![1u8; 800], vec![2u8; 800], vec![3u8; 800]], Duration::from_millis(20)).await;
        let dir = tmp("stream");
        let (r, _) = run(&origin, &dir.join("out.zip"), 1000, &AtomicBool::new(false)).await;
        assert!(matches!(&r, Err(SaveError::Failed(m)) if m.contains("more than it announced")), "{r:?}");
        assert!(names(&dir).is_empty(), "{:?}", names(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        // Shorter than declared (the connection dropped): not a saved archive.
        let (origin, _s) = fake(ok_head(Some(1000), "application/zip"), vec![vec![1u8; 400]], Duration::ZERO).await;
        let dir = tmp("short");
        let (r, _) = run(&origin, &dir.join("out.zip"), MAX_ARCHIVE_BYTES, &AtomicBool::new(false)).await;
        assert!(matches!(&r, Err(SaveError::Failed(_))), "{r:?}");
        assert!(names(&dir).is_empty(), "{:?}", names(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        // A folder is not a destination.
        let (origin, _s) = fake(ok_head(Some(1), "application/zip"), vec![vec![1u8]], Duration::ZERO).await;
        let dir = tmp("folder");
        let (r, _) = run(&origin, &dir, MAX_ARCHIVE_BYTES, &AtomicBool::new(false)).await;
        assert!(matches!(&r, Err(SaveError::Failed(m)) if m.contains("folder")), "{r:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_stops_the_stream_and_leaves_no_file() {
        // Cancelled before it starts: no request needed, nothing written.
        let dir = tmp("cancel0");
        let o = ServerOrigin::parse("http://127.0.0.1:9").unwrap();
        let (r, _) = run(&o, &dir.join("out.zip"), MAX_ARCHIVE_BYTES, &AtomicBool::new(true)).await;
        assert_eq!(r, Err(SaveError::Cancelled));
        assert!(names(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);

        // Cancelled mid-stream: an existing file at the target is untouched, the part is gone.
        let parts: Vec<Vec<u8>> = (0..40).map(|_| vec![7u8; 10_000]).collect();
        let (origin, _s) = fake(ok_head(Some(400_000), "application/zip"), parts, Duration::from_millis(25)).await;
        let dir = tmp("cancel1");
        let target = dir.join("out.zip");
        std::fs::write(&target, b"the previous export").unwrap();
        let cancel = AtomicBool::new(false);
        let url = download_url(&origin, ID).unwrap();
        let c = client().unwrap();
        let r = download(&c, &url, TOKEN, &target, MAX_ARCHIVE_BYTES, &cancel, |received, _| {
            if received >= 30_000 {
                cancel.store(true, Ordering::SeqCst);
            }
        })
        .await;
        assert_eq!(r, Err(SaveError::Cancelled));
        assert_eq!(std::fs::read(&target).unwrap(), b"the previous export");
        assert_eq!(names(&dir), vec!["out.zip".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn progress_is_numbers_and_an_escaped_id_never_a_path() {
        assert_eq!(
            progress_js(ID, 10, Some(20)),
            r#"window.dispatchEvent(new CustomEvent("prism:export-save-progress",{detail:{jobId:"AbCdEfGhIjKlMnOpQrStUv",received:10,total:20}}));"#
        );
        assert!(progress_js("a\"b", 1, None).contains(r#"jobId:"a\"b",received:1,total:null"#));
    }

    #[test]
    fn share_folder_is_private_and_purged() {
        // iOS: the archive waits for the share sheet in <tmp>/prism-exports/<nonce>/.
        let base = tmp("share");
        let dir = share_dir(&base, "n0nce");
        assert_eq!(dir, base.join("prism-exports").join("n0nce"));
        create_private_dir(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for d in [&dir, &base.join(SHARE_ROOT)] {
                let mode = std::fs::metadata(d).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o700, "{d:?} is private to the app");
            }
        }
        let file = dir.join(zip_name("My export"));
        std::fs::write(&file, b"PK").unwrap();
        assert_eq!(file.file_name().unwrap(), "My export.zip");
        // Launch-time cleanup removes every leftover, and is harmless when there is none.
        purge_share_root(&base);
        assert!(!base.join(SHARE_ROOT).exists());
        purge_share_root(&base);
        assert!(base.exists(), "only the share root goes");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_swift_side_shares_only_from_the_share_root() {
        // One name, two languages: keep them in step.
        let swift = include_str!("../plugins/prism-ios/ios/Sources/PrismIos/PrismIosPlugin.swift");
        assert!(swift.contains(&format!(".appendingPathComponent(\"{SHARE_ROOT}\", isDirectory: true)")));
        assert!(swift.contains("file.path.hasPrefix(root.path + \"/\")"));
        assert!(swift.contains("shareableExtensions: Set<String> = [\"zip\", \"md\", \"html\", \"csv\", \"json\"]"));
        assert!(swift.contains("shareableExtensions.contains(file.pathExtension.lowercased())"));
        // …and those are exactly what the shell writes there.
        assert!(zip_name("x").ends_with(".zip"));
        use crate::export::Format;
        for fmt in [Format::Markdown, Format::Html, Format::Csv, Format::Json] {
            assert!(["md", "html", "csv", "json"].contains(&fmt.ext()));
        }
        // An attached file (attachment_save.rs) may carry exactly the extensions of its own list.
        let listed = swift
            .split("attachmentExtensions: Set<String> = [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .expect("the Swift attachment list exists");
        let swift_list: Vec<&str> = listed.split(',').map(|s| s.trim().trim_matches('"')).filter(|s| !s.is_empty()).collect();
        assert_eq!(swift_list, crate::attachment_save::SAVE_EXTENSIONS, "Swift attachmentExtensions must equal SAVE_EXTENSIONS");
        assert!(swift.contains("|| PrismIosPlugin.attachmentExtensions.contains(file.pathExtension.lowercased())"));
    }
}
