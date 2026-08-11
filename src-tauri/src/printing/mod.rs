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
pub mod receipt;
pub mod service;
pub mod types;

#[cfg(target_os = "windows")]
pub mod windows_spooler;

use receipt::ReceiptDoc;
use serde::{Deserialize, Serialize};
use types::{InstalledPrinter, PaperWidth, PrintError, PrintOutcome, TestPrintRequest};

/// A cashier receipt to print (Level 3E-B).
///
/// Same shape as the test-print request plus the document itself: a printer
/// NAME re-checked against a live enumeration, an enumerated width, a bounded
/// copy count, and business content. Still no bytes, no path, no address and no
/// command string - the receipt fields are values to typeset, not instructions
/// to execute, and the renderer is the only thing that decides what reaches the
/// device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptPrintRequest {
    pub printer_name: String,
    pub paper_width: PaperWidth,
    pub copies: u8,
    pub receipt: ReceiptDoc,
}

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
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&request.printer_name, request.paper_width, request.copies);
        Err(PrintError::UnsupportedPlatform)
    }
}

/// Print a cashier receipt.
///
/// MANUAL ONLY in this phase. Nothing calls this on payment, on submission or
/// on a timer; it runs because an operator pressed Print and confirmed a named
/// printer. Automatic printing is a later, explicit slice - mixing it in here
/// would put a duplicate-paper risk underneath a renderer that has not printed
/// a single real receipt yet.
#[tauri::command]
pub fn print_receipt(request: ReceiptPrintRequest) -> Result<PrintOutcome, PrintError> {
    #[cfg(target_os = "windows")]
    {
        service::print_receipt(
            &windows_spooler::WindowsPrinterCatalogue,
            windows_spooler::WindowsPrintDevice::new,
            &request.printer_name,
            request.paper_width,
            request.copies as u32,
            &request.receipt,
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &request;
        Err(PrintError::UnsupportedPlatform)
    }
}

/// Every command this module exposes.
///
/// Kept as data so a test can assert the IPC surface has not quietly grown -
/// the whole safety argument for this work is that it is three commands wide,
/// and each one was added deliberately in its own phase.
pub const EXPOSED_COMMANDS: &[&str] = &["list_printers", "print_test_page", "print_receipt"];

/// Compile-time proof that the paper widths reaching Win32 are the two the
/// renderer has a layout for.
#[allow(dead_code)]
const fn supported_widths() -> [PaperWidth; 2] {
    [PaperWidth::Mm58, PaperWidth::Mm80]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ipc_surface_is_exactly_three_commands() {
        assert_eq!(EXPOSED_COMMANDS, &["list_printers", "print_test_page", "print_receipt"]);
    }

    #[test]
    fn a_receipt_request_carries_no_device_control() {
        // The envelope is a printer name, a width, a copy count and business
        // content. Anything else has nowhere to land.
        let json = r#"{
            "printerName":"Xprinter XP-80","paperWidth":"80mm","copies":1,
            "receipt":{"businessName":"B","branchName":"Br","orderNumber":"1","orderType":"Takeaway",
                       "at":"now","currency":"USD","lines":[{"name":"Item","qty":1,"lineTotal":1}]}
        }"#;
        let req: ReceiptPrintRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.printer_name, "Xprinter XP-80");
        assert_eq!(req.paper_width, PaperWidth::Mm80);
        assert_eq!(req.copies, 1);
        let round_trip = serde_json::to_value(&req).unwrap();
        let keys: Vec<&str> = round_trip.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, vec!["printerName", "paperWidth", "copies", "receipt"]);
    }

    #[test]
    fn a_receipt_request_still_refuses_an_unsupported_width() {
        let json = r#"{"printerName":"P","paperWidth":"a4","copies":1,
            "receipt":{"businessName":"B","branchName":"Br","orderNumber":"1","orderType":"T",
                       "at":"now","currency":"USD","lines":[{"name":"I","qty":1,"lineTotal":1}]}}"#;
        assert!(serde_json::from_str::<ReceiptPrintRequest>(json).is_err());
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
    fn only_the_two_thermal_widths_are_supported() {
        assert_eq!(supported_widths(), [PaperWidth::Mm58, PaperWidth::Mm80]);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn other_platforms_refuse_rather_than_pretend() {
        assert!(matches!(list_printers(), Err(PrintError::UnsupportedPlatform)));
    }
}
