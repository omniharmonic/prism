fn main() {
    // Rebuild when the baked-in default server origin changes.
    println!("cargo:rerun-if-env-changed=PRISM_SERVER_ORIGIN");
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
        ]),
    ))
    .expect("failed to run tauri-build");
}
