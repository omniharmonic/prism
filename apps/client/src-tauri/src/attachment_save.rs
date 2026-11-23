//! "Save attachment" (`save_attachment`): ONE file of a page — an uploaded image,
//! a PDF, a recording, any attached file — saved where the USER says.
//!
//! Why Rust does it: the webview cancels `<a download>` (this shell sets no
//! download handler on purpose — one would let page script download arbitrary
//! URLs) and the navigation policy refuses `blob:`, so the page's own "Download"
//! did nothing in the apps. Same shape as `save_export` (export_archive.rs).
//!
//! 🔒 What the page controls: an ATTACHMENT ID (strict shape) and a suggested
//! name. It supplies no URL, no path and no token:
//!  - the URL is built here: `<configured origin>/api/attachments/<id>`;
//!  - the bearer comes from the keychain cache and goes to that URL only;
//!  - redirects are refused (the client never follows one), so the bearer and
//!    the bytes cannot be steered to another host;
//!  - the response must be `200`, of a type that is not a web page or script,
//!    within [`MAX_ATTACHMENT_BYTES`] by its declared length AND while
//!    streaming, and exactly as long as declared;
//!  - the bytes are streamed into a private folder under the app's tmp
//!    directory (`export_archive::share_dir`, 0700) and never cross IPC;
//!  - the file's NAME is a sanitised stem plus an extension from a fixed list
//!    ([`SAVE_EXTENSIONS`]) — the suggested one when it is on the list, else the
//!    one that fits the type the SERVER declared, else `.bin`. The page cannot
//!    make the file a `.command`, `.app`, `.html` or `.svg`;
//!  - macOS: the destination is exactly what the native save panel returned
//!    (plus that extension when none was typed); the bytes are copied into a
//!    fresh sibling `.part` (`create_new`) and renamed over the target only when
//!    complete. iOS: the file is handed to the system share sheet (Save to
//!    Files, Save Image, AirDrop, …) by the Swift plugin, which accepts only
//!    that folder and that list;
//!  - the tmp folder is removed whatever happened.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Runtime, State, WebviewWindow};

use crate::export_archive::{self as archive, SaveError};
use crate::origin::ServerOrigin;
use crate::state::AppState;
use crate::MAIN_WINDOW;

/// Far above the server's upload cap (25 MB by default, `ATTACHMENT_MAX_BYTES`)
/// and its copy cap (100 MB): room for an operator who raised them, not for an
/// unbounded body.
pub const MAX_ATTACHMENT_BYTES: u64 = 512 * 1024 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// The page's own rule for an attachment reference (`/api/attachments/<id>`,
/// packages/core `OWN_ATTACHMENT`): 1–64 of `[A-Za-z0-9_-]`.
pub fn valid_attachment_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The ONLY URL this module ever requests.
pub fn attachment_url(origin: &ServerOrigin, id: &str) -> Option<String> {
    valid_attachment_id(id).then(|| origin.join(&format!("/api/attachments/{id}")))
}

/// Every extension a saved attachment may carry. The Swift plugin shares files
/// with these extensions only (`PrismIosPlugin.attachmentExtensions`) — keep the
/// two lists identical (verify-client.mjs compares them).
pub const SAVE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "bmp", "tiff", "pdf", "mp3", "m4a", "wav", "ogg", "oga", "flac", "aac", "opus", "mp4",
    "m4v", "mov", "webm", "mkv", "txt", "csv", "tsv", "json", "md", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
    "pages", "numbers", "key", "epub", "ics", "vcf", "zip", "gz", "tar", "7z", "bin",
];

/// The media type without its parameters, lower-cased.
fn essence(content_type: &str) -> String {
    content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase()
}

/// Types that are never written to disk from here: a page, a script or an SVG
/// (the server refuses to store them; a response of that type is not a file of ours).
pub fn refused_type(content_type: &str) -> bool {
    let t = essence(content_type);
    t.is_empty()
        || matches!(
            t.as_str(),
            "text/html" | "application/xhtml+xml" | "image/svg+xml" | "text/javascript" | "application/javascript" | "application/ecmascript" | "text/css" | "text/xml" | "application/xml"
        )
}

/// The extension that fits a declared type, when we know one.
pub fn extension_for_type(content_type: &str) -> Option<&'static str> {
    Some(match essence(content_type).as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/heic" => "heic",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "application/pdf" => "pdf",
        "audio/mpeg" => "mp3",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/aac" => "aac",
        "audio/opus" => "opus",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" | "audio/webm" => "webm",
        "video/x-matroska" => "mkv",
        "text/plain" => "txt",
        "text/csv" => "csv",
        "text/markdown" => "md",
        "application/json" => "json",
        "application/rtf" | "text/rtf" => "rtf",
        "application/zip" => "zip",
        "application/gzip" => "gz",
        "application/epub+zip" => "epub",
        "text/calendar" => "ics",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        _ => return None,
    })
}

fn listed(ext: &str) -> Option<&'static str> {
    let lower = ext.to_ascii_lowercase();
    SAVE_EXTENSIONS.iter().copied().find(|e| *e == lower)
}

/// The file's name: a sanitised stem + an extension from [`SAVE_EXTENSIONS`].
/// The suggested extension is kept only when it is on the list; otherwise the
/// declared type decides; otherwise `.bin`.
pub fn file_name(suggested: &str, content_type: &str) -> String {
    let trimmed = suggested.trim();
    let (stem, ext) = match trimmed.rsplit_once('.') {
        Some((s, e)) if !s.trim().is_empty() && listed(e).is_some() => (s, listed(e)),
        _ => (trimmed, None),
    };
    let ext = ext.or_else(|| extension_for_type(content_type)).unwrap_or("bin");
    let clean = crate::export::sanitize_stem(stem);
    // sanitize_stem's own fallback name is for notes.
    let fallback = clean == "note" && !stem.trim().eq_ignore_ascii_case("note");
    format!("{}.{ext}", if fallback { "file" } else { &clean })
}

/// Exactly what the user chose, with `ext` added only when they typed no extension.
pub fn target_path(chosen: &Path, ext: &str) -> PathBuf {
    if chosen.extension().is_some() {
        chosen.to_path_buf()
    } else {
        let mut os = chosen.as_os_str().to_owned();
        os.push(".");
        os.push(ext);
        PathBuf::from(os)
    }
}

fn refusal(status: u16) -> String {
    match status {
        300..=399 => "The server tried to send the file from somewhere else. Nothing was saved.".into(),
        401 | 403 => "You’re signed out, or you can no longer open this file.".into(),
        404 | 410 => "This file is no longer there.".into(),
        429 => "Too many downloads at once. Try again in a moment.".into(),
        s => format!("The server couldn’t send the file (HTTP {s})."),
    }
}

/// One save at a time.
#[derive(Default)]
pub struct AttachmentSaves(AtomicBool);

pub struct Busy<'a>(&'a AtomicBool);
impl AttachmentSaves {
    pub fn begin(&self) -> Result<Busy<'_>, String> {
        if self.0.swap(true, Ordering::SeqCst) {
            return Err("Another file is being saved. Wait for it to finish.".into());
        }
        Ok(Busy(&self.0))
    }
}
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Stream the attachment at `url` into the private folder `dir` and give it its
/// final name there. Returns the file's path. Leaves nothing in `dir` on failure.
pub async fn fetch(client: &reqwest::Client, url: &str, token: &str, dir: &Path, suggested: &str, max_bytes: u64) -> Result<PathBuf, SaveError> {
    let failed = |m: &str| SaveError::Failed(m.to_string());
    let sent = client.get(url).bearer_auth(token).send();
    let mut resp = match tokio::time::timeout(IDLE_TIMEOUT, sent).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => return Err(failed("Couldn’t reach the server. Nothing was saved.")),
        Err(_) => return Err(failed("The server didn’t answer. Nothing was saved.")),
    };
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(SaveError::Failed(refusal(status)));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if refused_type(&content_type) {
        return Err(failed("The server didn’t send a file. Nothing was saved."));
    }
    let declared = resp.content_length();
    if declared.is_some_and(|n| n > max_bytes) {
        return Err(failed("This file is too large to save."));
    }
    let part = dir.join(format!(".{}.part", &crate::pkce::random_token()[..12]));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
        .map_err(|e| SaveError::Failed(format!("could not prepare the file: {e}")))?;
    let outcome = async {
        let mut received: u64 = 0;
        loop {
            let chunk = match tokio::time::timeout(IDLE_TIMEOUT, resp.chunk()).await {
                Ok(Ok(Some(c))) => c,
                Ok(Ok(None)) => break,
                Ok(Err(_)) => return Err(failed("The download was interrupted. Nothing was saved.")),
                Err(_) => return Err(failed("The download stalled. Nothing was saved.")),
            };
            received += chunk.len() as u64;
            if received > max_bytes || declared.is_some_and(|n| received > n) {
                return Err(failed("The server sent more than it announced. Nothing was saved."));
            }
            file.write_all(&chunk)
                .map_err(|e| SaveError::Failed(format!("could not write the file: {e}")))?;
        }
        if declared.is_some_and(|n| received != n) {
            return Err(failed("The download was incomplete. Nothing was saved."));
        }
        file.sync_all()
            .map_err(|e| SaveError::Failed(format!("could not write the file: {e}")))?;
        Ok(())
    }
    .await;
    drop(file);
    let named = dir.join(file_name(suggested, &content_type));
    match outcome.and_then(|()| std::fs::rename(&part, &named).map_err(|e| SaveError::Failed(format!("could not prepare the file: {e}")))) {
        Ok(()) => Ok(named),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Copy the fetched file to the user-chosen place: a fresh sibling `.part`
/// (`create_new`), renamed over the target only when complete.
#[cfg_attr(target_os = "ios", allow(dead_code))]
pub fn place(fetched: &Path, chosen: &Path) -> Result<PathBuf, String> {
    let ext = fetched.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let target = target_path(chosen, ext);
    if chosen.is_dir() || target.is_dir() {
        return Err("That location is a folder.".into());
    }
    let part = archive::part_path(&target, &crate::pkce::random_token()[..12]);
    let copied = (|| -> std::io::Result<()> {
        let mut from = std::fs::File::open(fetched)?;
        let mut to = std::fs::OpenOptions::new().write(true).create_new(true).open(&part)?;
        std::io::copy(&mut from, &mut to)?;
        to.sync_all()?;
        std::fs::rename(&part, &target)
    })();
    match copied {
        Ok(()) => Ok(target),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(format!("could not save the file: {e}"))
        }
    }
}

/// Show the native save panel (main thread) and return the chosen path.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn choose_path_blocking(file_name: &str) -> Option<PathBuf> {
    rfd::FileDialog::new().set_title("Save file").set_file_name(file_name).save_file()
}

/// Save one attachment of a page to a place the user chooses (macOS: the native
/// save panel; iOS: the system share sheet). The page supplies the attachment id
/// and a suggested name — never a URL, a path or a credential. Returns the saved
/// file's NAME, or null if the user cancelled.
#[tauri::command]
pub async fn save_attachment<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    saves: State<'_, AttachmentSaves>,
    attachment_id: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    if window.label() != MAIN_WINDOW {
        return Err("This window can't do that.".into());
    }
    if !valid_attachment_id(&attachment_id) {
        return Err("That file can't be saved.".into());
    }
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", target_os = "ios"))]
    {
        let bearer = state
            .token()
            .await?
            .ok_or("You're signed out. Sign in and try again.")?;
        let source = attachment_url(&state.require_origin()?, &attachment_id).ok_or("That file can't be saved.")?;
        let busy = saves.begin()?;
        let dir = archive::share_dir(&std::env::temp_dir(), &crate::pkce::random_token()[..16]);
        archive::create_private_dir(&dir).map_err(|e| format!("could not prepare the file: {e}"))?;
        let client = archive::client()?;
        let fetched = fetch(&client, &source, &bearer, &dir, &suggested_name, MAX_ATTACHMENT_BYTES).await;
        let result = match fetched {
            Ok(path) => hand_over(&app, &path).await,
            Err(SaveError::Cancelled) => Ok(None),
            Err(SaveError::Failed(m)) => Err(m),
        };
        // Whatever happened, the file does not stay in the app's tmp folder.
        let _ = std::fs::remove_dir_all(&dir);
        drop(busy);
        result
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux", target_os = "ios")))]
    {
        let _ = (&app, &state, &saves, &suggested_name);
        Err("Saving a file isn't available on this platform yet.".into())
    }
}

/// Desktop: the native save panel, then the copy.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
async fn hand_over<R: Runtime>(app: &AppHandle<R>, fetched: &Path) -> Result<Option<String>, String> {
    let name = fetched.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file.bin".into());
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(choose_path_blocking(&name));
    })
    .map_err(|e| format!("could not open the save panel: {e}"))?;
    let Some(chosen) = rx.await.map_err(|_| "the save panel was closed".to_string())? else {
        return Ok(None);
    };
    let from = fetched.to_path_buf();
    let target = tauri::async_runtime::spawn_blocking(move || place(&from, &chosen))
        .await
        .map_err(|e| format!("save task failed: {e}"))??;
    Ok(target.file_name().map(|n| n.to_string_lossy().into_owned()))
}

/// iOS: the system share sheet (the Swift plugin accepts only this folder and
/// the extensions of [`SAVE_EXTENSIONS`]). Null when the sheet was dismissed.
#[cfg(target_os = "ios")]
async fn hand_over<R: Runtime>(app: &AppHandle<R>, fetched: &Path) -> Result<Option<String>, String> {
    let ios = crate::ios::plugin(app)?;
    let Some(path) = fetched.to_str() else {
        return Err("That file can't be shared.".into());
    };
    let shared = ios.share_file(path).await?;
    Ok(shared
        .then(|| fetched.file_name().map(|n| n.to_string_lossy().into_owned()))
        .flatten())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const ID: &str = "a_AbCdEfGhIjKlMnOpQrStUv";
    const TOKEN: &str = "pd_test-token";

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prism-attachment-save-{}-{name}-{}", std::process::id(), &crate::pkce::random_token()[..8]));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    /// A one-connection fake server: answers `head` then `body`, returns the request head it saw.
    async fn fake(head: String, body: Vec<u8>) -> (ServerOrigin, tokio::task::JoinHandle<String>) {
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
            let _ = s.write_all(&body).await;
            let _ = s.shutdown().await;
            String::from_utf8_lossy(&buf).to_string()
        });
        (ServerOrigin::parse(&format!("http://127.0.0.1:{port}")).unwrap(), h)
    }
    fn ok_head(len: Option<usize>, content_type: &str) -> String {
        let length = len.map(|n| format!("Content-Length: {n}\r\n")).unwrap_or_default();
        let ct = if content_type.is_empty() { String::new() } else { format!("Content-Type: {content_type}\r\n") };
        format!("HTTP/1.1 200 OK\r\n{ct}{length}Connection: close\r\n\r\n")
    }
    async fn run(origin: &ServerOrigin, dir: &Path, suggested: &str, max: u64) -> Result<PathBuf, SaveError> {
        fetch(&archive::client().unwrap(), &attachment_url(origin, ID).unwrap(), TOKEN, dir, suggested, max).await
    }

    #[test]
    fn ids_are_strict_and_the_url_is_built_here() {
        for ok in [ID, "a", "A-_9", &"x".repeat(64)] {
            assert!(valid_attachment_id(ok), "{ok:?}");
        }
        for bad in [
            "", &"x".repeat(65), "a/b", "../etc", "a?b", "a#b", "a%2f", "a.b", "a b", "a\\b", "a@evil.example", "a:b", "a\nb", "é", "https://evil.example/x",
            "a_AbCdEfGhIjKlMnOpQrStUv/../../export",
        ] {
            assert!(!valid_attachment_id(bad), "{bad:?}");
        }
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        assert_eq!(attachment_url(&o, ID).as_deref(), Some("https://prism.example.com/api/attachments/a_AbCdEfGhIjKlMnOpQrStUv"));
        assert_eq!(attachment_url(&o, "x@evil.example"), None);
        assert_eq!(attachment_url(&o, "//evil.example/x"), None);
    }

    #[test]
    fn the_name_is_sanitised_and_its_extension_comes_from_the_list() {
        assert_eq!(file_name("Site plan.pdf", "application/pdf"), "Site plan.pdf");
        assert_eq!(file_name("photo.JPEG", "image/jpeg"), "photo.jpeg");
        // No (or an unlisted) extension: the declared type decides.
        assert_eq!(file_name("River at dawn", "image/png"), "River at dawn.png");
        assert_eq!(file_name("River at dawn", "image/jpeg; charset=binary"), "River at dawn.jpg");
        assert_eq!(file_name("notes.v2", "text/plain"), "notes.v2.txt");
        // Nothing the page names can make the file runnable or a web page.
        for evil in ["run.command", "Prism.app", "page.html", "x.svg", "a.sh", "a.exe", "a.js", "a.terminal", "a.webloc", "a.pkg", "a.dmg", "a.scpt"] {
            let n = file_name(evil, "application/octet-stream");
            assert!(n.ends_with(".bin"), "{evil} → {n}");
        }
        assert_eq!(file_name("run.command", "image/png"), "run.command.png");
        // Paths, control characters and hidden names do not survive.
        for evil in ["../../etc/passwd", "/abs/olute.pdf", "C:\\x\\y.pdf", ".hidden.pdf", "a\u{0}b\n.pdf", "~/x.pdf"] {
            let n = file_name(evil, "application/pdf");
            assert!(!n.contains('/') && !n.contains('\\') && !n.starts_with('.') && !n.chars().any(|c| c.is_control()), "{evil:?} → {n:?}");
            assert!(n.ends_with(".pdf"), "{n}");
        }
        assert_eq!(file_name("", "application/octet-stream"), "file.bin");
        assert_eq!(file_name("   ", "image/webp"), "file.webp");
        assert_eq!(file_name(".pdf", "application/pdf"), "pdf.pdf");
        assert!(file_name(&"x".repeat(500), "image/png").chars().count() <= crate::export::MAX_STEM_CHARS + 4);
        // Every extension the type table can produce is on the shared list.
        for t in ["image/png", "image/jpeg", "application/pdf", "audio/mpeg", "video/mp4", "video/quicktime", "text/csv", "application/zip", "audio/x-m4a"] {
            assert!(SAVE_EXTENSIONS.contains(&extension_for_type(t).unwrap()), "{t}");
        }
    }

    #[test]
    fn pages_scripts_and_untyped_answers_are_not_files() {
        for bad in ["", "text/html", "TEXT/HTML; charset=utf-8", "application/xhtml+xml", "image/svg+xml", "text/javascript", "application/javascript", "text/css", "application/xml"] {
            assert!(refused_type(bad), "{bad:?}");
        }
        for ok in ["image/png", "application/pdf", "application/octet-stream", "audio/mpeg", "text/plain; charset=utf-8", "application/json"] {
            assert!(!refused_type(ok), "{ok:?}");
        }
    }

    #[test]
    fn target_path_is_what_the_user_chose() {
        assert_eq!(target_path(Path::new("/Users/me/Desktop/out"), "png"), PathBuf::from("/Users/me/Desktop/out.png"));
        assert_eq!(target_path(Path::new("/Users/me/Desktop/out.jpeg"), "png"), PathBuf::from("/Users/me/Desktop/out.jpeg"));
    }

    #[test]
    fn the_command_takes_no_path_url_or_token_from_the_page() {
        let src = include_str!("attachment_save.rs");
        let start = src.find("pub async fn save_attachment").expect("save_attachment exists");
        let sig = &src[start..start + src[start..].find(") ->").unwrap()];
        for forbidden in ["path", "url", "token", "origin", "bearer"] {
            assert!(!sig.to_lowercase().contains(forbidden), "save_attachment must not take a {forbidden}: {sig}");
        }
        assert!(sig.contains("attachment_id: String") && sig.contains("suggested_name: String"));
    }

    #[test]
    fn one_save_at_a_time() {
        let saves = AttachmentSaves::default();
        let first = saves.begin().unwrap();
        assert!(saves.begin().is_err());
        drop(first);
        assert!(saves.begin().is_ok());
    }

    #[tokio::test]
    async fn a_file_is_fetched_with_the_bearer_named_by_its_type_and_placed_where_chosen() {
        let body = b"\x89PNG fake image bytes".to_vec();
        let (origin, server) = fake(ok_head(Some(body.len()), "image/png"), body.clone()).await;
        let dir = tmp("ok");
        let fetched = run(&origin, &dir, "River at dawn", 1024).await.unwrap();
        assert_eq!(fetched.file_name().unwrap(), "River at dawn.png");
        assert_eq!(std::fs::read(&fetched).unwrap(), body);
        assert_eq!(names(&dir), vec!["River at dawn.png"], "no .part is left");
        let seen = server.await.unwrap();
        assert!(seen.starts_with(&format!("GET /api/attachments/{ID} HTTP/1.1")), "{seen}");
        assert!(seen.to_lowercase().contains(&format!("authorization: bearer {}", TOKEN.to_lowercase())), "{seen}");
        assert!(!seen.to_lowercase().contains("cookie:"));
        // The chosen place: our extension is added only when none was typed; nothing else appears beside it.
        let out = tmp("out");
        let placed = place(&fetched, &out.join("saved")).unwrap();
        assert_eq!(placed, out.join("saved.png"));
        assert_eq!(std::fs::read(&placed).unwrap(), body);
        assert_eq!(names(&out), vec!["saved.png"]);
        assert_eq!(place(&fetched, &out.join("other.jpeg")).unwrap(), out.join("other.jpeg"));
        assert!(place(&fetched, &out).is_err(), "a folder is refused");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&out);
    }

    #[tokio::test]
    async fn a_redirect_is_refused_and_never_followed() {
        // Where the redirect points: it must never be contacted.
        let elsewhere = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = elsewhere.local_addr().unwrap().port();
        for status in ["301 Moved Permanently", "302 Found", "307 Temporary Redirect", "308 Permanent Redirect"] {
            let (origin, _server) = fake(format!("HTTP/1.1 {status}\r\nLocation: http://127.0.0.1:{port}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), vec![]).await;
            let dir = tmp("redirect");
            let err = run(&origin, &dir, "x.png", 1024).await.unwrap_err();
            assert_eq!(err, SaveError::Failed("The server tried to send the file from somewhere else. Nothing was saved.".into()));
            assert!(names(&dir).is_empty());
            let _ = std::fs::remove_dir_all(&dir);
        }
        let contacted = tokio::time::timeout(Duration::from_millis(200), elsewhere.accept()).await;
        assert!(contacted.is_err(), "the redirect target was contacted");
    }

    #[tokio::test]
    async fn refusals_leave_nothing_behind() {
        let cases: Vec<(String, Vec<u8>, u64, &str)> = vec![
            (ok_head(Some(5), "text/html"), b"<p>x".to_vec(), 1024, "The server didn’t send a file. Nothing was saved."),
            (ok_head(Some(5), ""), b"hello".to_vec(), 1024, "The server didn’t send a file. Nothing was saved."),
            (ok_head(Some(5), "image/svg+xml"), b"<svg>".to_vec(), 1024, "The server didn’t send a file. Nothing was saved."),
            (ok_head(Some(4096), "image/png"), vec![0; 4096], 1024, "This file is too large to save."),
            (ok_head(None, "image/png"), vec![0; 4096], 1024, "The server sent more than it announced. Nothing was saved."),
            (ok_head(Some(10), "image/png"), vec![0; 4], 1024, "The download was incomplete. Nothing was saved."),
            ("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), vec![], 1024, "This file is no longer there."),
            ("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), vec![], 1024, "You’re signed out, or you can no longer open this file."),
            ("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), vec![], 1024, "The server couldn’t send the file (HTTP 502)."),
        ];
        for (head, body, max, want) in cases {
            let (origin, _server) = fake(head.clone(), body).await;
            let dir = tmp("refused");
            let err = run(&origin, &dir, "x.png", max).await.unwrap_err();
            match err {
                SaveError::Failed(m) => assert!(m == want || (want.contains("incomplete") && m.contains("Nothing was saved")), "{head:?}: {m}"),
                other => panic!("{other:?}"),
            }
            assert!(names(&dir).is_empty(), "{head:?} left {:?}", names(&dir));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
