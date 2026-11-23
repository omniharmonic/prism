use std::path::Path;

use base64::Engine as _;

/// The ONE public key an update may be signed with (docs/client-app.md § Release (CI)). Committed
/// by the owner after `npm run tauri signer generate`; absent = the updater is not built in.
const UPDATER_PUBKEY_FILE: &str = "updater/updater.key.pub";

fn main() {
    // Rebuild when the baked-in default server origin changes.
    println!("cargo:rerun-if-env-changed=PRISM_SERVER_ORIGIN");
    updater_config();
    // Declaring the app's commands makes Tauri generate one `allow-<command>`
    // permission per command and DENY any command a capability does not grant
    // (capabilities/default.json). Nothing is callable by default.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_token",
            "sign_in",
            "sign_out",
            "get_server_origin",
            "set_server_origin",
            "open_external",
            // WP4.2
            "quick_capture",
            "notify",
            "export_note",
            // Export archives (docs/client-app.md "Saving an export archive")
            "save_export",
            // One attachment of a page → the save panel / share sheet (attachment_save.rs)
            "save_attachment",
            // WP5 (iOS only; capabilities/mobile.json)
            "reset_server",
            "get_app_settings",
            "set_app_lock",
            "push_register",
            "push_status",
            "push_take_opened",
        ]),
    ))
    .expect("failed to run tauri-build");
}

/// The in-app updater is built in ONLY when both exist (fail closed — never a placeholder key):
///   - the committed public key `updater/updater.key.pub` (Tauri's base64 minisign `.pub` file);
///   - `PRISM_UPDATER_ENDPOINT` at build time (the release job's update channel, https only).
///
/// Then `PRISM_UPDATER_PUBKEY` / `PRISM_UPDATER_ENDPOINT` are compiled in (src/updater.rs reads
/// them with `option_env!`). A key file that is present but malformed fails the build.
fn updater_config() {
    println!("cargo:rerun-if-changed=updater");
    println!("cargo:rerun-if-env-changed=PRISM_UPDATER_ENDPOINT");
    let key = match std::fs::read_to_string(Path::new(UPDATER_PUBKEY_FILE)) {
        Ok(k) => Some(k.trim().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => panic!("{UPDATER_PUBKEY_FILE}: {e}"),
    };
    if let Some(k) = &key {
        if let Err(e) = check_pubkey(k) {
            panic!("{UPDATER_PUBKEY_FILE} is not a minisign public key ({e}); regenerate it with `npm run tauri signer generate`");
        }
    }
    let endpoint = std::env::var("PRISM_UPDATER_ENDPOINT")
        .ok()
        .filter(|e| !e.trim().is_empty());
    if let Some(e) = &endpoint {
        if let Err(why) = check_endpoint(e) {
            panic!("PRISM_UPDATER_ENDPOINT {why}");
        }
    }
    match (key, endpoint) {
        (Some(k), Some(e)) => {
            println!("cargo:rustc-env=PRISM_UPDATER_PUBKEY={k}");
            println!("cargo:rustc-env=PRISM_UPDATER_ENDPOINT={e}");
        }
        (None, Some(_)) => println!("cargo:warning=PRISM_UPDATER_ENDPOINT is set but {UPDATER_PUBKEY_FILE} is not committed: the updater is NOT built in"),
        _ => {}
    }
}

/// Tauri's `.pub` = base64 of "untrusted comment: …\n<base64 of 'Ed' + key id (8) + key (32)>".
fn check_pubkey(k: &str) -> Result<(), String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let text = b64.decode(k).map_err(|e| format!("not base64: {e}"))?;
    let text = String::from_utf8(text).map_err(|_| "not UTF-8".to_string())?;
    let mut lines = text.lines();
    if !lines.next().unwrap_or("").starts_with("untrusted comment:") {
        return Err("no minisign comment line".into());
    }
    let raw = b64
        .decode(lines.next().unwrap_or("").trim())
        .map_err(|e| format!("key line: {e}"))?;
    if raw.len() != 42 || &raw[..2] != b"Ed" {
        return Err("key line is not an Ed25519 minisign key".into());
    }
    Ok(())
}

fn check_endpoint(e: &str) -> Result<(), String> {
    if !e.starts_with("https://") {
        return Err("must be https://".into());
    }
    if e.len() > 2048
        || e.chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '@' || c == '\\')
    {
        return Err("must be a plain https URL (no spaces, userinfo or backslashes)".into());
    }
    Ok(())
}
