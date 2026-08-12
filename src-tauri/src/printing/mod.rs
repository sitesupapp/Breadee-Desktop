//! Native printing: the desktop app's first frontend-to-Rust surface.
//!
//! SCOPE OF THIS PHASE. Two commands. One enumerates the printers Windows shows
//! this user; the other prints a synthetic diagnostic page to one of them. No
//! order, no payment, no shift, no receipt and no server row is read or written
//! anywhere below this line - a printer failure and a POS transaction cannot
//! reach each other, which is the property that matters most here.
//!
//! WHY THE INPUT IS SO NARROW. The webview runs with `csp: null`, so the honest
//! assumption is that anything the frontend can send, injected script can send.
//! `print_test_page` therefore takes a printer NAME (re-checked against a live
//! enumeration), an enumerated paper width and a copy count of 1..=5. It takes
//! no bytes, no path, no address, no port and no command string, and it prints
//! content this module owns rather than content the caller supplies. There is
//! no argument shape that turns this into "write these bytes to that device".

pub mod page;
pub mod service;
pub mod types;

#[cfg(target_os = "windows")]
pub mod windows_spooler;

use types::{InstalledPrinter, PaperWidth, PrintError, PrintOutcome, TestPrintRequest};

/// Local wall-clock stamp for the diagnostic page.
///
/// Formatted here rather than pulled from a date crate: the page needs a human
/// timestamp, not calendar arithmetic, and this phase adds no dependency it can
/// avoid.
fn local_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Days since epoch -> civil date (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02} UTC",
        year,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60
    )
}

/// The printers Windows offers this user session.
#[tauri::command]
pub fn list_printers() -> Result<Vec<InstalledPrinter>, PrintError> {
    #[cfg(target_os = "windows")]
    {
        service::list_printers(&windows_spooler::WindowsPrinterCatalogue)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(PrintError::UnsupportedPlatform)
    }
}

/// Print the built-in diagnostic page.
#[tauri::command]
pub fn print_test_page(request: TestPrintRequest) -> Result<PrintOutcome, PrintError> {
    #[cfg(target_os = "windows")]
    {
        service::print_test_page(
            &windows_spooler::WindowsPrinterCatalogue,
            windows_spooler::WindowsPrintDevice::new,
            &request.printer_name,
            request.paper_width,
            request.copies as u32,
            &local_timestamp(),
            request.context.as_ref(),
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&request.printer_name, request.paper_width, request.copies, &request.context);
        Err(PrintError::UnsupportedPlatform)
    }
}

/// Every command this module exposes.
///
/// Kept as data so a test can assert the IPC surface has not quietly grown -
/// the whole safety argument for this phase is that it is two commands wide.
pub const EXPOSED_COMMANDS: &[&str] = &["list_printers", "print_test_page"];

/// The preset rolls, kept as data so a test can pin them.
///
/// Custom widths are deliberately NOT enumerable: they are any whole
/// millimetre inside `CUSTOM_PAPER_MIN_MM..=CUSTOM_PAPER_MAX_MM`, and the
/// guarantee that matters is that every one of them has been validated by
/// `PaperWidth::parse` before it can exist - see the tests below.
#[allow(dead_code)]
const fn preset_widths() -> [PaperWidth; 2] {
    [PaperWidth::Mm58, PaperWidth::Mm80]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ipc_surface_is_exactly_two_commands() {
        assert_eq!(EXPOSED_COMMANDS, &["list_printers", "print_test_page"]);
    }

    #[test]
    fn the_timestamp_is_human_readable_and_dated() {
        let ts = local_timestamp();
        // YYYY-MM-DD HH:MM UTC
        assert_eq!(ts.len(), 20, "unexpected stamp: {ts}");
        assert!(ts.ends_with(" UTC"));
        let year: i32 = ts[..4].parse().expect("a four digit year");
        assert!(year >= 2024, "clock looks wrong: {ts}");
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
    }

    #[test]
    fn the_presets_are_the_two_thermal_rolls() {
        assert_eq!(preset_widths(), [PaperWidth::Mm58, PaperWidth::Mm80]);
    }

    #[test]
    fn a_width_can_only_reach_the_renderer_through_validation() {
        use types::{CUSTOM_PAPER_MAX_MM, CUSTOM_PAPER_MIN_MM};
        // The request type carries a PaperWidth, and the only ways to build one
        // from frontend input are `parse` (deserialisation) and `custom` - both
        // of which range-check. This test states the property the safety of the
        // custom width rests on.
        let request: Result<TestPrintRequest, _> = serde_json::from_str(
            r#"{"printer_name":"P","paper_width":"custom:400","copies":1}"#,
        );
        assert!(request.is_err(), "an out-of-range width must not deserialise");

        let ok: TestPrintRequest = serde_json::from_str(
            r#"{"printer_name":"P","paper_width":"custom:72","copies":1}"#,
        )
        .expect("72mm is printable");
        assert_eq!(ok.paper_width, PaperWidth::CustomMm(72));

        for mm in [CUSTOM_PAPER_MIN_MM, 72, CUSTOM_PAPER_MAX_MM] {
            assert!(PaperWidth::custom(mm).is_ok(), "{mm}mm is inside the range");
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn other_platforms_refuse_rather_than_pretend() {
        assert!(matches!(list_printers(), Err(PrintError::UnsupportedPlatform)));
    }
}
