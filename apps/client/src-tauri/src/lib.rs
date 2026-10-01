//! Prism Client — a thin Tauri 2 shell (docs/client-app.md).
//!
//! It bundles the native build of apps/web, signs in through the system
//! browser (PKCE, docs/native-auth.md), keeps the device token in the
//! keychain, and talks to exactly one Prism Server. It holds no vault token,
//! runs no ingest, spawns no CLI, and has no fs/shell capability.
//!
//! Layout (platform code kept separate so iOS can join in WP5):
//!   shared   origin, pkce, auth, secure_store, settings, state, host, commands
//!   desktop  loopback (RFC 8252 redirect), menu, window::geometry
//!   mobile   signin.rs's `#[cfg(mobile)]` arm (WP5.2)

mod auth;
mod capture;
#[cfg(desktop)]
mod capture_window;
mod commands;
mod confirm;
mod dropfiles;
mod export;
mod host;
#[cfg(desktop)]
mod loopback;
#[cfg(desktop)]
mod menu;
mod native_cmds;
mod notify;
mod origin;
mod pkce;
mod secure_store;
mod settings;
#[cfg(desktop)]
mod shortcut;
mod signin;
mod state;
#[cfg(desktop)]
mod tray;
mod window;

use tauri::utils::config::Csp;
use tauri::Manager;

use crate::origin::{build_csp, ServerOrigin};
use crate::state::AppState;

pub const MAIN_WINDOW: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();

    // Resolve the server origin BEFORE building the app: the CSP is derived
    // from it and is fixed for the life of the process.
    let identifier = context.config().identifier.clone();
    let settings_dir = settings::settings_dir(&identifier);
    let origin = settings_dir
        .as_deref()
        .map(settings::load)
        .and_then(|s| s.server_origin)
        .and_then(|o| match ServerOrigin::parse(&o) {
            Ok(v) => Some(v),
            Err(e) => {
                log::warn!("ignoring saved server origin: {e}");
                None
            }
        })
        .unwrap_or_else(ServerOrigin::build_default);
    context.config_mut().app.security.csp = Some(Csp::Policy(build_csp(&origin)));

    let state = AppState::new(origin, identifier, settings_dir);

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .manage(notify::NotifyState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_token,
            commands::sign_in,
            commands::sign_out,
            commands::get_server_origin,
            commands::set_server_origin,
            commands::open_external,
            native_cmds::quick_capture,
            native_cmds::notify,
            native_cmds::export_note,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                let menu = menu::build(app.handle())?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()));
            }
            let _w = window::create_main_window(app)?;
            #[cfg(desktop)]
            {
                window::geometry::ensure_visible(&_w);
                // WP4.2: menu-bar icon + global quick-capture shortcut.
                if let Err(e) = tray::init(app.handle()) {
                    log::warn!("could not create the tray icon: {e}");
                }
                let dir = app.state::<AppState>().settings_dir.clone();
                shortcut::register(app.handle(), dir.as_deref());
            }
            Ok(())
        });

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .on_window_event(on_window_event);
    }

    let app = builder
        .build(context)
        .expect("error while building Prism Client");
    app.run(|_app, _event| {
        #[cfg(desktop)]
        match _event {
            tauri::RunEvent::ExitRequested { .. } => save_geometry(_app),
            // Dock-icon click while the main window is hidden (WP4.2: closing
            // the main window hides it so the tray keeps working).
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => tray::show_main(_app),
            _ => {}
        }
    });
}

#[cfg(desktop)]
fn on_window_event(w: &tauri::Window, event: &tauri::WindowEvent) {
    if w.label() != MAIN_WINDOW {
        return;
    }
    let app = w.app_handle();
    match event {
        // Closing the main window hides it: the app lives on in the menu bar
        // (tray). Quit = Cmd-Q / tray "Quit Prism".
        tauri::WindowEvent::CloseRequested { api, .. } => {
            save_geometry(app);
            api.prevent_close();
            let _ = w.hide();
        }
        // A notification click activates the app; if one for an agent session
        // was shown moments ago, open that session (a DOM event, not a
        // navigation: see notify.rs).
        tauri::WindowEvent::Focused(true) => {
            let pending = app
                .state::<notify::NotifyState>()
                .take_pending(std::time::Instant::now());
            if let (Some(id), Some(win)) = (pending, app.get_webview_window(MAIN_WINDOW)) {
                let _ = win.eval(notify::open_session_js(&id));
            }
        }
        // Files dropped on the window: the shell reads the text ones (caps in
        // dropfiles.rs) and hands CONTENT to the page as a DOM event.
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
            let paths = paths.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let outcome =
                    tauri::async_runtime::spawn_blocking(move || dropfiles::process(&paths))
                        .await
                        .unwrap_or_default();
                if outcome.notes.is_empty() && outcome.skipped.is_empty() {
                    return;
                }
                if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = win.eval(dropfiles::deliver_js(&outcome));
                }
            });
        }
        _ => {}
    }
}

#[cfg(desktop)]
pub(crate) fn save_geometry<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    if let (Some(dir), Some(w)) = (
        state.settings_dir.as_deref(),
        app.get_webview_window(MAIN_WINDOW),
    ) {
        window::geometry::save(&w, dir);
    }
}
