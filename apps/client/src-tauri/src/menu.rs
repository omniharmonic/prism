//! Native app menu (desktop). WP4.2 adds quick capture / global shortcut here.
//!
//! Besides Prism's own items it carries the standard Edit menu: on macOS the
//! clipboard shortcuts (Cmd-C/V/X/A/Z) only reach the webview through it.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;
use crate::MAIN_WINDOW;

const ID_RELOAD: &str = "prism.reload";
const ID_SIGN_OUT: &str = "prism.sign_out";
const ID_SERVER: &str = "prism.server_settings";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let server = MenuItem::with_id(
        app,
        ID_SERVER,
        "Server Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let sign_out = MenuItem::with_id(app, ID_SIGN_OUT, "Sign Out", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, ID_RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?;

    let app_menu = Submenu::with_items(
        app,
        "Prism",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &server,
            &PredefinedMenuItem::separator(app)?,
            &sign_out,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&reload, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(w) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    match id {
        ID_RELOAD => {
            let _ = w.eval("window.location.reload()");
        }
        ID_SERVER => {
            let grant = app.state::<AppState>().mint_settings_grant();
            let _ = w.eval(crate::host::show_server_settings_js(&grant));
        }
        ID_SIGN_OUT => {
            // host.js signOut(): revoke + forget (sign_out), drop the offline
            // read cache, reload into the sign-in screen.
            let _ = w.eval("window.__PRISM_SHELL__ && window.__PRISM_SHELL__.signOut()");
        }
        _ => {}
    }
}
