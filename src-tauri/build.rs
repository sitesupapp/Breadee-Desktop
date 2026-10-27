// Explicit app-command ACL (Final Foundation, Track 4).
//
// Declaring the app's commands here makes Tauri generate one `allow-<command>`
// permission per command AND switches app commands from "allowed by default"
// to "denied unless a capability grants it". capabilities/default.json then
// names every command individually - no wildcard. This list, the
// `generate_handler!` list in src/lib.rs and the capability must stay in step;
// test/offline-foundation-security.test.ts pins that.
const APP_COMMANDS: &[&str] = &[
    "list_printers",
    "print_test_page",
    "print_receipt",
    "print_kitchen_ticket",
    "print_report",
    "device_public_key",
    "device_sign",
    "seal_secret",
    "unseal_secret",
    "clear_secret",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
