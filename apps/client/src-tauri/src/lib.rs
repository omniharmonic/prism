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
mod commands;
mod confirm;
mod host;
#[cfg(desktop)]
mod loopback;
#[cfg(desktop)]
mod menu;
mod origin;
mod pkce;
mod secure_store;
mod settings;
mod signin;
mod state;
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
        .invoke_handler(tauri::generate_handler![
            commands::get_token,
            commands::sign_in,
            commands::sign_out,
            commands::get_server_origin,
            commands::set_server_origin,
            commands::open_external,
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
            window::geometry::ensure_visible(&_w);
            Ok(())
        });

    #[cfg(desktop)]
    {
        builder = builder.on_window_event(|w, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                save_geometry(w.app_handle());
            }
        });
    }

    let app = builder
        .build(context)
        .expect("error while building Prism Client");
    app.run(|_app, _event| {
        #[cfg(desktop)]
        if let tauri::RunEvent::ExitRequested { .. } = _event {
            save_geometry(_app);
        }
    });
}

#[cfg(desktop)]
fn save_geometry<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    if let (Some(dir), Some(w)) = (
        state.settings_dir.as_deref(),
        app.get_webview_window(MAIN_WINDOW),
    ) {
        window::geometry::save(&w, dir);
    }
}
