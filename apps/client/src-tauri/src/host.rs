//! The `window.__PRISM_HOST__` initialization script (see host.js).

use crate::origin::ServerOrigin;

const TEMPLATE: &str = include_str!("host.js");
const PLACEHOLDER: &str = "__PRISM_ORIGIN__";

/// host.js with the origin injected as a JSON string literal (so no value can
/// break out of the string, whatever it contains).
pub fn init_script(origin: &ServerOrigin) -> String {
    let literal = serde_json::to_string(origin.as_str()).expect("a string serializes");
    TEMPLATE.replacen(PLACEHOLDER, &literal, 1)
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
        let js = init_script(&o);
        assert!(js.contains(r#"var ORIGIN = "https://prism.example.com";"#));
        assert!(!js.contains("var ORIGIN = __PRISM_ORIGIN__"));
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
