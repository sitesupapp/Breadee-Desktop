// 1.0.41 (Server Off F-CRASH) — recover from a dead WebView2 renderer, boundedly.
//
// WHY: when the WebView2 RENDER process dies (a GPU/driver fault, an access violation in the renderer, memory
// pressure) the window stays open but blank: the cashier sees a white till and, through 1.0.40, the only way out
// was to kill and relaunch Breadee. Everything the till had captured is durable in IndexedDB (the WebView2
// profile), so reloading the page is enough to bring the POS back with its queue intact.
//
// WHAT THIS DOES — and only this:
//   - registers ONE ProcessFailed handler on the main webview at startup;
//   - on RENDER_PROCESS_EXITED (the renderer is already gone — nothing in memory left to lose) it reloads the
//     page, at most RELOAD_BUDGET times within RELOAD_WINDOW (no crash loop: past the budget it does nothing);
//   - every other kind is ignored: an UNRESPONSIVE renderer may be mid-operation and is never reloaded from here;
//     a BROWSER process exit is not "fixed" by a silent relaunch (the single-instance guard and an operator who
//     is mid-sale make that a decision for a person).
// It reads and writes nothing else: no order, no payment, no queue, no file.

#[cfg(windows)]
pub fn install<R: tauri::Runtime>(app: &tauri::App<R>) {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    };
    use webview2_com::ProcessFailedEventHandler;

    const RELOAD_BUDGET: usize = 3;
    const RELOAD_WINDOW: Duration = Duration::from_secs(600);

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let recent: Arc<Mutex<Vec<Instant>>> = Arc::new(Mutex::new(Vec::new()));
    let _ = window.with_webview(move |webview| {
        let recent = recent.clone();
        // SAFETY: plain WebView2 COM calls on the webview's own controller, on the thread wry hands us.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let mut token: i64 = 0;
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    return Ok(());
                }
                let allowed = {
                    let mut r = match recent.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    let now = Instant::now();
                    r.retain(|t| now.duration_since(*t) < RELOAD_WINDOW);
                    if r.len() < RELOAD_BUDGET {
                        r.push(now);
                        true
                    } else {
                        false
                    }
                };
                if allowed {
                    if let Some(s) = sender {
                        let _ = s.Reload();
                    }
                }
                Ok(())
            }));
            let _ = core.add_ProcessFailed(&handler, &mut token);
        }
    });
}

#[cfg(not(windows))]
pub fn install<R: tauri::Runtime>(_app: &tauri::App<R>) {}
