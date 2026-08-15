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

pub mod kitchen;
pub mod page;
pub mod receipt;
pub mod report;
pub mod service;
pub mod types;

#[cfg(target_os = "windows")]
pub mod windows_spooler;

use kitchen::KitchenTicketDoc;
use receipt::ReceiptDoc;
use report::ReportDoc;
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

/// A kitchen ticket to print.
///
/// Same envelope as the receipt request - a printer NAME re-checked against a
/// live enumeration, an enumerated width, a bounded copy count, and content to
/// typeset. The document differs; the surface does not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitchenPrintRequest {
    pub printer_name: String,
    pub paper_width: PaperWidth,
    pub copies: u8,
    pub ticket: KitchenTicketDoc,
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
            request.context.as_ref(),
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&request.printer_name, request.paper_width, request.copies, &request.context);
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

/// Print a kitchen ticket.
///
/// Unlike `print_receipt` this one CAN be reached automatically - the POS may
/// print a ticket as part of completing a successful order submission. The
/// safety argument does not change, because it never rested on "a human pressed
/// the button": this function reads no order, takes no lock and returns no
/// value the caller's transaction depends on. What the automatic path adds is a
/// duplicate risk, and that is bounded on the frontend by one attempt per
/// successful submission with no retry - see `lib/pos/autoPrint.ts`.
#[tauri::command]
pub fn print_kitchen_ticket(request: KitchenPrintRequest) -> Result<PrintOutcome, PrintError> {
    #[cfg(target_os = "windows")]
    {
        service::print_kitchen_ticket(
            &windows_spooler::WindowsPrinterCatalogue,
            windows_spooler::WindowsPrintDevice::new,
            &request.printer_name,
            request.paper_width,
            request.copies as u32,
            &request.ticket,
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &request;
        Err(PrintError::UnsupportedPlatform)
    }
}

/// An end-of-shift report to print.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPrintRequest {
    pub printer_name: String,
    pub paper_width: PaperWidth,
    pub copies: u8,
    pub report: ReportDoc,
}

/// Print an end-of-shift report.
///
/// Reads no shift and no order - the caller hands over lines it has already
/// shown on screen, so the paper cannot disagree with the report the operator
/// just read and approved. A print failure cannot affect the shift close.
#[tauri::command]
pub fn print_report(request: ReportPrintRequest) -> Result<PrintOutcome, PrintError> {
    #[cfg(target_os = "windows")]
    {
        service::print_report(
            &windows_spooler::WindowsPrinterCatalogue,
            windows_spooler::WindowsPrintDevice::new,
            &request.printer_name,
            request.paper_width,
            request.copies as u32,
            &request.report,
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
/// the whole safety argument for this work is that it is four commands wide,
/// and each one was added deliberately in its own phase.
pub const EXPOSED_COMMANDS: &[&str] = &[
    "list_printers",
    "print_test_page",
    "print_receipt",
    "print_kitchen_ticket",
    "print_report",
];

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
    fn the_ipc_surface_is_exactly_five_commands() {
        assert_eq!(
            EXPOSED_COMMANDS,
            &["list_printers", "print_test_page", "print_receipt", "print_kitchen_ticket", "print_report"]
        );
    }

    #[test]
    fn a_report_request_carries_no_device_control() {
        let json = r#"{
            "printerName":"Xprinter XP-80","paperWidth":"custom:72","copies":1,
            "report":{"title":"END OF SHIFT REPORT",
                      "lines":[{"label":"Orders","value":"7"},{"label":"","kind":"rule"}]}
        }"#;
        let req: ReportPrintRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.printer_name, "Xprinter XP-80");
        assert_eq!(req.paper_width, PaperWidth::CustomMm(72));
        let round_trip = serde_json::to_value(&req).unwrap();
        let mut keys: Vec<&str> = round_trip.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["copies", "paperWidth", "printerName", "report"]);
    }

    #[test]
    fn a_kitchen_request_carries_no_device_control() {
        let json = r#"{
            "printerName":"Xprinter XP-80","paperWidth":"custom:72","copies":1,
            "ticket":{"businessName":"B","branchName":"Br","orderNumber":"1","orderType":"Dine-In",
                      "at":"now","lines":[{"name":"Item","qty":1}]}
        }"#;
        let req: KitchenPrintRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.printer_name, "Xprinter XP-80");
        assert_eq!(req.paper_width, PaperWidth::CustomMm(72));
        assert_eq!(req.copies, 1);
        let round_trip = serde_json::to_value(&req).unwrap();
        let mut keys: Vec<&str> = round_trip.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["copies", "paperWidth", "printerName", "ticket"]);
    }

    #[test]
    fn a_kitchen_request_still_refuses_an_unsupported_width() {
        let json = r#"{"printerName":"P","paperWidth":"a4","copies":1,
            "ticket":{"businessName":"B","branchName":"Br","orderNumber":"1","orderType":"T",
                      "at":"now","lines":[{"name":"I","qty":1}]}}"#;
        assert!(serde_json::from_str::<KitchenPrintRequest>(json).is_err());
    }

    #[test]
    fn a_kitchen_ticket_has_nowhere_to_put_a_price() {
        // Deserialisation is the boundary: a caller that sends money fields gets
        // them dropped rather than printed, because the type has no home for
        // them. Asserting it here means the guarantee survives a future edit to
        // the frontend mapper.
        let json = r#"{"printerName":"P","paperWidth":"80mm","copies":1,
            "ticket":{"businessName":"B","branchName":"Br","orderNumber":"1","orderType":"T",
                      "at":"now","total":99.0,"subtotal":99.0,
                      "lines":[{"name":"I","qty":1,"lineTotal":99.0,
                                "modifiers":[{"name":"M","quantity":1,"price_delta":5.0}]}]}}"#;
        let req: KitchenPrintRequest = serde_json::from_str(json).expect("unknown fields are ignored");
        let round_trip = serde_json::to_string(&req.ticket).unwrap();
        for money in ["total", "lineTotal", "price_delta", "subtotal", "99"] {
            assert!(!round_trip.contains(money), "a kitchen ticket must not carry {money:?}");
        }
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
        // The field SET, not the order. `serde_json`'s default map is sorted, so
        // asserting declaration order tests the serialiser rather than the
        // envelope - the same trap 3E-A's test-print request fell into.
        let round_trip = serde_json::to_value(&req).unwrap();
        let mut keys: Vec<&str> = round_trip.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["copies", "paperWidth", "printerName", "receipt"]);
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
