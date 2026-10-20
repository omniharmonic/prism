// No webview-callable commands: the app's own Rust commands (apps/client/src-tauri/src/ios.rs)
// call into the Swift side with `run_mobile_plugin`, so the page's IPC surface stays the
// shell's explicit command list (capabilities/mobile.json).
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
