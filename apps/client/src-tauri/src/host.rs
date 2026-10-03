//! The `window.__PRISM_HOST__` initialization script (see host.js).

use crate::origin::ServerOrigin;

const TEMPLATE: &str = include_str!("host.js");
const PLACEHOLDER: &str = "__PRISM_ORIGIN__";
const PLATFORM_PLACEHOLDER: &str = "__PRISM_PLATFORM__";

/// The shell platform the host hook reports (`__PRISM_SHELL__.platform`).
pub const PLATFORM: &str = if cfg!(target_os = "ios") {
    "ios"
} else if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(target_os = "windows") {
    "windows"
} else if cfg!(target_os = "android") {
    "android"
} else {
    "linux"
};

/// host.js with the origin and platform injected as JSON string literals (so
/// no value can break out of the string, whatever it contains). `None` (iOS)
/// injects "": the hook then reads the live origin from the page's
/// `prism-server-origin` meta (window.rs `retarget_page`).
pub fn init_script(origin: Option<&ServerOrigin>) -> String {
    let literal = serde_json::to_string(origin.map(|o| o.as_str()).unwrap_or(""))
        .expect("a string serializes");
    let platform = serde_json::to_string(PLATFORM).expect("a string serializes");
    TEMPLATE
        .replacen(PLACEHOLDER, &literal, 1)
        .replacen(PLATFORM_PLACEHOLDER, &platform, 1)
}

/// JS the shell evals to open the Server settings dialog with a fresh grant.
pub fn show_server_settings_js(grant: &str) -> String {
    let literal = serde_json::to_string(grant).expect("a string serializes");
    format!("window.__PRISM_SHELL__ && window.__PRISM_SHELL__.showServerSettings({literal});")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_origin_once_as_a_string_literal() {
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        let js = init_script(Some(&o));
        assert!(js.contains(r#"var ORIGIN = "https://prism.example.com";"#));
        assert!(!js.contains("var ORIGIN = __PRISM_ORIGIN__"));
        assert!(js.contains(&format!("var PLATFORM = \"{PLATFORM}\";")));
        assert!(!js.contains("__PRISM_PLATFORM__"));
        assert!(init_script(None).contains(r#"var ORIGIN = "";"#));
        // The contract keys the web app reads.
        for k in [
            "__PRISM_HOST__",
            "apiOrigin",
            "getToken",
            "onUnauthorized",
            "signIn",
            "onSignedOut",
        ] {
            assert!(js.contains(k), "host hook must define {k}");
        }
        // The only IPC commands the hook uses are the allowlisted ones.
        for cmd in [
            "\"get_token\"",
            "\"sign_in\"",
            "\"sign_out\"",
            "\"set_server_origin\"",
            "\"open_external\"",
            "\"notify\"",
            "\"export_note\"",
        ] {
            assert!(js.contains(cmd));
        }
        assert!(
            !js.contains("localStorage"),
            "the token never touches web storage"
        );
    }

    #[test]
    fn grant_is_escaped() {
        assert_eq!(
            show_server_settings_js("a\"b"),
            r#"window.__PRISM_SHELL__ && window.__PRISM_SHELL__.showServerSettings("a\"b");"#
        );
    }
}
