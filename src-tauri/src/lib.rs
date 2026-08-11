// Breadee Desktop shell.
//
// SINGLE INSTANCE IS A POS SAFETY PROPERTY, NOT A NICETY.
//
// Packaged QA on 2026-08-08 opened three concurrent Breadee processes simply by
// launching the installed app three times. Nobody was double-charged - the
// server refuses a second settlement on an already-paid table - but each
// process carried its OWN React state: its own cart, its own selected table,
// and its own in-memory duplicate-payment latch. Two tills on one terminal is
// an operational hazard before it is ever a financial one: the cashier can add
// items in one window and settle in another, and the window that took the money
// is not necessarily the one they are looking at.
//
// So the second launch must not become a second till. It hands focus back to
// the instance that already exists and exits.

pub mod printing;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Registered FIRST, as the plugin requires: it has to claim the lock before
    // anything else in the second process starts doing work.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        focus_existing_window(app);
    }));

    builder
        .plugin(tauri_plugin_opener::init())
        // THE APP'S FIRST IPC SURFACE (Level 3E-A).
        //
        // Two commands, both in `printing`. Deliberately listed here in full
        // rather than behind a generated macro over a module, so that widening
        // the surface is a visible edit to this file and shows up in review as
        // one. Neither command reads or writes an order, a payment, a shift or
        // any server row - see `printing/mod.rs` for why the inputs are shaped
        // the way they are.
        .invoke_handler(tauri::generate_handler![
            printing::list_printers,
            printing::print_test_page,
            // Level 3E-B. Manual cashier receipts only - never called on
            // payment, submission or a timer.
            printing::print_receipt
        ])
        .run(tauri::generate_context!())
        .expect("error while running Breadee desktop application");
}

/// Bring the already-running window back to the operator.
///
/// Deliberately the smallest possible action: unminimise, show, focus. It does
/// NOT navigate, reload, emit an event, reset the tenant/branch context, clear
/// the cart, touch the shift or create a window. The running instance may be
/// mid-order or mid-payment, and a "helpful" reset here would destroy work the
/// cashier has already read out to a table.
///
/// The launch arguments and working directory of the second process are ignored
/// on purpose: this app has no deep-link or file-open handling, so there is
/// nothing in them to act on, and acting on them would be a way to drive the
/// POS from outside it.
#[cfg(desktop)]
fn focus_existing_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    // "main" is the label declared in tauri.conf.json. If it is ever absent the
    // right move is to do nothing rather than invent a replacement window.
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    // Each step is independently best-effort: a window that is already visible
    // returns an error from `unminimize` on some platforms, and that must not
    // stop the focus call that actually matters to the operator.
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}
