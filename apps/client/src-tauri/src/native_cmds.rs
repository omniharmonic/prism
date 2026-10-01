//! IPC commands added by WP4.2. Same rules as commands.rs: declared in
//! build.rs, granted per window in capabilities/*.json, nothing else callable.
//!
//!   quick_capture  quick-capture window ONLY (capabilities/quick-capture.json)
//!   notify         main window (capabilities/default.json)
//!   export_note    main window (capabilities/default.json)
//!
//! Each command also checks the CALLING window's label, so a mistaken or
//! future capability grant can't widen who may call it.

use tauri::{AppHandle, Runtime, State, WebviewWindow};

use crate::state::AppState;
use crate::MAIN_WINDOW;

fn require_label<R: Runtime>(w: &WebviewWindow<R>, label: &str) -> Result<(), String> {
    if w.label() == label {
        Ok(())
    } else {
        Err("This window can't do that.".into())
    }
}

/// Save a note typed into the quick-capture window. The text is the ONLY thing
/// the window controls (see capture.rs). Empty text means "dismiss" (Esc /
/// Cancel): the window closes and nothing is sent. Returns whether a note was
/// saved.
#[tauri::command]
pub async fn quick_capture<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    text: String,
) -> Result<bool, String> {
    require_label(&window, crate::capture::WINDOW_LABEL)?;
    if text.trim().is_empty() {
        let _ = window.close();
        return Ok(false);
    }
    let body = crate::capture::build_body(
        &text,
        crate::capture::now_secs(),
        &crate::capture::random_suffix(),
    )?;
    let token = state
        .token()
        .await?
        .ok_or("You're signed out. Open Prism and sign in first.")?;
    crate::capture::post(&state.origin, &token, &body).await?;
    let _ = window.close();
    Ok(true)
}

/// Show a native notification for an agent turn, only while the main window
/// is not focused. Title/body are untrusted text: sanitised and capped in
/// Rust. Returns whether one was shown.
#[tauri::command]
pub async fn notify<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    notify_state: State<'_, crate::notify::NotifyState>,
    title: String,
    body: String,
    session_id: Option<String>,
) -> Result<bool, String> {
    require_label(&window, MAIN_WINDOW)?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        use std::time::Instant;
        use tauri::Manager;

        let focused = app
            .get_webview_window(MAIN_WINDOW)
            .map(|w| w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false))
            .unwrap_or(false);
        if focused {
            return Ok(false);
        }
        let prepared = crate::notify::prepare(&title, &body, session_id.as_deref());
        if !notify_state.allow(Instant::now()) {
            return Ok(false);
        }
        let identifier = app.config().identifier.clone();
        let shown = {
            let p = crate::notify::Prepared {
                title: prepared.title.clone(),
                body: prepared.body.clone(),
                session_id: None,
            };
            tauri::async_runtime::spawn_blocking(move || crate::notify::show(&identifier, &p))
                .await
                .map_err(|e| format!("notification task failed: {e}"))?
        };
        shown?;
        notify_state.set_pending(prepared.session_id, Instant::now());
        Ok(true)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (&app, &notify_state, &title, &body, &session_id);
        Ok(false)
    }
}

/// Export a note to a file the user chooses in a NATIVE save panel. The page
/// supplies content, a suggested name and a format; the destination path comes
/// only from the panel (export.rs). Returns the saved file's NAME, or null if
/// the user cancelled.
#[tauri::command]
pub async fn export_note<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    content: String,
    suggested_name: String,
    format: String,
) -> Result<Option<String>, String> {
    require_label(&window, MAIN_WINDOW)?;
    let fmt = crate::export::Format::parse(&format)?;
    crate::export::check_size(&content)?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let file_name = crate::export::suggested_file_name(&suggested_name, fmt);
        let rendered = crate::export::render(fmt, &suggested_name, &content);

        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(crate::export::choose_path_blocking(&file_name, fmt));
        })
        .map_err(|e| format!("could not open the save panel: {e}"))?;
        let Some(chosen) = rx
            .await
            .map_err(|_| "the save panel was closed".to_string())?
        else {
            return Ok(None);
        };
        let written = tauri::async_runtime::spawn_blocking(move || {
            crate::export::write_chosen(&chosen, fmt, &rendered)
        })
        .await
        .map_err(|e| format!("export task failed: {e}"))??;
        Ok(written
            .file_name()
            .map(|n| n.to_string_lossy().into_owned()))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (&app, &suggested_name, fmt);
        Err("Export isn't available on this platform yet.".into())
    }
}
