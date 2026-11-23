//! Menu-bar (tray) icon: Quick capture…, Open Prism, Sign out, Quit.
//! Desktop only. Every item acts through the same shell paths as the app menu;
//! the tray adds no IPC.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

use crate::MAIN_WINDOW;

const ID_CAPTURE: &str = "tray.capture";
const ID_OPEN: &str = "tray.open";
const ID_SIGN_OUT: &str = "tray.sign_out";
const ID_QUIT: &str = "tray.quit";

pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let capture = MenuItem::with_id(app, ID_CAPTURE, "Quick capture…", true, None::<&str>)?;
    let open = MenuItem::with_id(app, ID_OPEN, "Open Prism", true, None::<&str>)?;
    let sign_out = MenuItem::with_id(app, ID_SIGN_OUT, "Sign out", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit Prism", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &capture,
            &open,
            &PredefinedMenuItem::separator(app)?,
            &sign_out,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("prism")
        .tooltip("Prism")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_event(app, event.id().as_ref()));
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Show and focus the main window (it is hidden, not destroyed, when closed).
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        ID_CAPTURE => {
            if let Err(e) = crate::capture_window::show(app) {
                log::warn!("could not open quick capture: {e}");
            }
        }
        ID_OPEN => show_main(app),
        ID_SIGN_OUT => {
            // Same path as the app menu's Sign Out (host.js signOut(): revoke +
            // forget, drop the offline cache, reload to the sign-in screen).
            if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                let _ = w.eval("window.__PRISM_SHELL__ && window.__PRISM_SHELL__.signOut()");
                show_main(app);
            }
        }
        ID_QUIT => {
            crate::save_geometry(app);
            app.exit(0);
        }
        _ => {}
    }
}
