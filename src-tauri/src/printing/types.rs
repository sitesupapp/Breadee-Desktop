//! Typed inputs, outputs and errors for native printing.
//!
//! Everything in this file is PLATFORM-INDEPENDENT and pure, so the validation
//! that protects the native boundary is testable on any machine - including a
//! developer laptop with no printer attached, and a CI runner that must never
//! produce paper.
//!
//! THE BOUNDARY IS THE POINT. This is the first IPC surface the desktop app has
//! ever had. The webview runs with `csp: null`, so anything the frontend is
//! allowed to hand to Rust is also, in principle, something an injected script
//! could hand to Rust. That is why the request type below carries a printer
//! NAME, an enumerated paper width and a small copy count - and carries no
//! bytes, no path, no address, no port and no command string. There is no shape
//! of `TestPrintRequest` that can express "write these bytes to that device".

use serde::{Deserialize, Serialize};

/// Widths this phase can lay a diagnostic page out for.
///
/// An enum rather than a number: `serde` refuses anything else before our code
/// runs, so an unsupported width is a deserialisation failure at the boundary
/// rather than a page silently printed at the wrong size. A4 and `custom` exist
/// in the server registry and are deliberately NOT here - Level 3E-A prints one
/// diagnostic page onto thermal rolls, and inventing a sheet layout would be
/// pretending to a capability that has not been designed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PaperWidth {
    #[serde(rename = "58mm")]
    Mm58,
    #[serde(rename = "80mm")]
    Mm80,
}

impl PaperWidth {
    /// Nominal roll width. The PRINTABLE area is narrower and is read from the
    /// device itself at print time; this is only the layout target.
    pub fn millimetres(self) -> f32 {
        match self {
            PaperWidth::Mm58 => 58.0,
            PaperWidth::Mm80 => 80.0,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PaperWidth::Mm58 => "58mm",
            PaperWidth::Mm80 => "80mm",
        }
    }
}

pub const MIN_COPIES: u8 = 1;
pub const MAX_COPIES: u8 = 5;

/// What Windows says about a printer, reduced to what an operator can act on.
///
/// Deliberately tiny. `PRINTER_INFO_2W` is a large struct full of driver
/// internals, port names and security descriptors; none of that helps a cashier
/// and all of it would be a new thing to keep secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledPrinter {
    /// The exact Windows name. This is the only value that may be sent back in
    /// a print request, and it is re-checked against a fresh enumeration.
    pub name: String,
    /// True for the user's default printer, when Windows reports one.
    pub is_default: bool,
    /// Coarse, honest status. See `PrinterStatus`.
    pub status: PrinterStatus,
}

/// Printer availability, only as far as Windows will actually commit to it.
///
/// Windows exposes a rich status bitmask, but on most consumer and thermal
/// drivers it reads 0 ("ready") whether or not the device is powered on -
/// spooler status describes the QUEUE, not the hardware. So this stays coarse
/// and `Unknown` is a first-class answer rather than an optimistic "ready".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrinterStatus {
    /// The queue reports no problem. NOT a promise that paper will come out.
    Ready,
    /// The queue reports a fault the operator can usually fix (offline, paused,
    /// out of paper, error).
    NotReady,
    /// Windows gave us no usable status. Never guessed.
    Unknown,
}

/// A request to print the built-in diagnostic page.
///
/// Note what is absent, and see the module comment for why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestPrintRequest {
    pub printer_name: String,
    pub paper_width: PaperWidth,
    pub copies: u8,
}

/// The result of asking Windows to print.
///
/// `accepted` means the SPOOLER took the job. It is not a claim about paper -
/// see `PrintOutcome::acceptance_message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrintOutcome {
    pub accepted: bool,
    pub printer_name: String,
    pub copies_requested: u8,
    pub copies_accepted: u8,
    /// Spooler job ids, when the API returned one per copy. May be shorter than
    /// `copies_accepted` if a driver declined to report an id.
    pub job_ids: Vec<u32>,
    /// Set when something is worth saying despite acceptance - e.g. only some
    /// copies were taken.
    pub warning: Option<String>,
}

impl PrintOutcome {
    /// The ONLY sentence the UI should use on success.
    ///
    /// "Printed successfully" is a lie this layer cannot support: `EndDoc`
    /// returning a job id means the spooler queued the document, and everything
    /// after that - cable, power, paper, driver, the printer's own memory - is
    /// invisible from here. Physical output is a separate observation made by a
    /// human looking at the paper.
    pub fn acceptance_message(&self) -> &'static str {
        "Print job accepted by Windows."
    }
}

/// Errors the frontend can map to an actionable message.
///
/// `code` is stable and matched on; `detail` carries the technical remainder
/// for logs. The two are separate so an operator is never shown a Win32 error
/// dump and a developer never loses one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PrintError {
    PrinterEnumerationFailed { detail: String },
    PrinterNotFound { requested: String },
    InvalidPaperWidth { detail: String },
    InvalidCopyCount { requested: u32 },
    RenderFailed { detail: String },
    /// The receipt itself is not something this renderer should draw - empty,
    /// or carrying a field far beyond any real menu (Level 3E-B).
    InvalidReceipt { detail: String },
    OpenPrinterFailed { printer: String, detail: String },
    StartDocumentFailed { printer: String, detail: String },
    WriteFailed { printer: String, detail: String },
    FinishDocumentFailed { printer: String, detail: String },
    UnsupportedPlatform,
}

impl PrintError {
    /// Stable machine code. Kept as a method so the TypeScript adapter and the
    /// Rust tests can agree on one spelling.
    pub fn code(&self) -> &'static str {
        match self {
            PrintError::PrinterEnumerationFailed { .. } => "printer_enumeration_failed",
            PrintError::PrinterNotFound { .. } => "printer_not_found",
            PrintError::InvalidPaperWidth { .. } => "invalid_paper_width",
            PrintError::InvalidCopyCount { .. } => "invalid_copy_count",
            PrintError::RenderFailed { .. } => "render_failed",
            PrintError::InvalidReceipt { .. } => "invalid_receipt",
            PrintError::OpenPrinterFailed { .. } => "open_printer_failed",
            PrintError::StartDocumentFailed { .. } => "start_document_failed",
            PrintError::WriteFailed { .. } => "write_failed",
            PrintError::FinishDocumentFailed { .. } => "finish_document_failed",
            PrintError::UnsupportedPlatform => "unsupported_platform",
        }
    }
}

impl std::fmt::Display for PrintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for PrintError {}

/// Validate a copy count coming across the boundary.
///
/// Takes a `u32` rather than the `u8` the request carries, so an out-of-range
/// value is reported rather than silently truncating: a frontend that asked for
/// 300 copies has a bug worth surfacing, and `300 as u8` is 44.
pub fn validate_copies(requested: u32) -> Result<u8, PrintError> {
    if requested < MIN_COPIES as u32 || requested > MAX_COPIES as u32 {
        return Err(PrintError::InvalidCopyCount { requested });
    }
    Ok(requested as u8)
}

/// Resolve the requested printer against a FRESH enumeration.
///
/// Exact match only. A fuzzy or case-insensitive match would mean the operator
/// pressed "test print" for one device and paper came out of another - and on a
/// shared office network the other device may be in a different room. Windows
/// printer names are user-visible strings, so exactness is also what the
/// operator can verify by eye.
pub fn resolve_printer<'a>(
    requested: &str,
    installed: &'a [InstalledPrinter],
) -> Result<&'a InstalledPrinter, PrintError> {
    installed
        .iter()
        .find(|p| p.name == requested)
        .ok_or_else(|| PrintError::PrinterNotFound { requested: requested.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn printer(name: &str, is_default: bool) -> InstalledPrinter {
        InstalledPrinter { name: name.to_string(), is_default, status: PrinterStatus::Unknown }
    }

    #[test]
    fn paper_width_accepts_only_the_two_thermal_rolls() {
        assert_eq!(serde_json::from_str::<PaperWidth>("\"58mm\"").unwrap(), PaperWidth::Mm58);
        assert_eq!(serde_json::from_str::<PaperWidth>("\"80mm\"").unwrap(), PaperWidth::Mm80);
        // A4 and custom exist in the server registry; this phase has no layout
        // for them and refuses at the boundary rather than guessing one.
        assert!(serde_json::from_str::<PaperWidth>("\"a4\"").is_err());
        assert!(serde_json::from_str::<PaperWidth>("\"custom\"").is_err());
        assert!(serde_json::from_str::<PaperWidth>("\"120mm\"").is_err());
    }

    #[test]
    fn paper_width_reports_its_own_geometry_and_label() {
        assert_eq!(PaperWidth::Mm58.millimetres(), 58.0);
        assert_eq!(PaperWidth::Mm80.millimetres(), 80.0);
        assert_eq!(PaperWidth::Mm58.label(), "58mm");
        assert_eq!(PaperWidth::Mm80.label(), "80mm");
    }

    #[test]
    fn copies_are_bounded_at_both_ends() {
        assert_eq!(validate_copies(1).unwrap(), 1);
        assert_eq!(validate_copies(5).unwrap(), 5);
        assert!(matches!(validate_copies(0), Err(PrintError::InvalidCopyCount { requested: 0 })));
        assert!(matches!(validate_copies(6), Err(PrintError::InvalidCopyCount { requested: 6 })));
    }

    #[test]
    fn an_oversized_copy_count_is_reported_not_truncated() {
        // 300 as u8 is 44. Reporting the number actually asked for is how a
        // frontend bug stays visible instead of becoming 44 sheets of paper.
        assert!(matches!(
            validate_copies(300),
            Err(PrintError::InvalidCopyCount { requested: 300 })
        ));
    }

    #[test]
    fn a_printer_must_match_the_enumeration_exactly() {
        let installed = vec![printer("Star TSP100", true), printer("Microsoft Print to PDF", false)];
        assert_eq!(resolve_printer("Star TSP100", &installed).unwrap().name, "Star TSP100");
        assert!(matches!(
            resolve_printer("Star TSP-100", &installed),
            Err(PrintError::PrinterNotFound { .. })
        ));
    }

    #[test]
    fn printer_matching_is_never_fuzzy_or_case_insensitive() {
        let installed = vec![printer("Kitchen Printer", false)];
        // Each of these is a DIFFERENT device as far as this layer is concerned.
        for near_miss in ["kitchen printer", "KITCHEN PRINTER", "Kitchen Printer ", " Kitchen Printer", "Kitchen"] {
            assert!(
                matches!(resolve_printer(near_miss, &installed), Err(PrintError::PrinterNotFound { .. })),
                "{near_miss:?} must not resolve to a different printer"
            );
        }
    }

    #[test]
    fn an_unknown_printer_reports_what_was_asked_for() {
        let err = resolve_printer("Ghost", &[]).unwrap_err();
        assert!(matches!(&err, PrintError::PrinterNotFound { requested } if requested == "Ghost"));
        assert_eq!(err.code(), "printer_not_found");
    }

    #[test]
    fn every_error_has_a_stable_code() {
        let cases: Vec<(PrintError, &str)> = vec![
            (PrintError::PrinterEnumerationFailed { detail: String::new() }, "printer_enumeration_failed"),
            (PrintError::PrinterNotFound { requested: String::new() }, "printer_not_found"),
            (PrintError::InvalidPaperWidth { detail: String::new() }, "invalid_paper_width"),
            (PrintError::InvalidCopyCount { requested: 0 }, "invalid_copy_count"),
            (PrintError::RenderFailed { detail: String::new() }, "render_failed"),
            (PrintError::InvalidReceipt { detail: String::new() }, "invalid_receipt"),
            (PrintError::OpenPrinterFailed { printer: String::new(), detail: String::new() }, "open_printer_failed"),
            (PrintError::StartDocumentFailed { printer: String::new(), detail: String::new() }, "start_document_failed"),
            (PrintError::WriteFailed { printer: String::new(), detail: String::new() }, "write_failed"),
            (PrintError::FinishDocumentFailed { printer: String::new(), detail: String::new() }, "finish_document_failed"),
            (PrintError::UnsupportedPlatform, "unsupported_platform"),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code);
            // The serialised tag must match the code the TypeScript side maps on.
            let json = serde_json::to_value(&err).unwrap();
            assert_eq!(json.get("code").and_then(|c| c.as_str()), Some(code));
        }
    }

    #[test]
    fn the_request_cannot_express_a_raw_device_write() {
        // Anything carrying bytes, a path, an address or a command string must
        // fail to deserialise - there is no field for it to land in.
        let hostile = [
            r#"{"printer_name":"P","paper_width":"80mm","copies":1,"raw_bytes":[27,64]}"#,
            r#"{"printer_name":"P","paper_width":"80mm","copies":1,"file_path":"C:\\x.bin"}"#,
            r#"{"printer_name":"P","paper_width":"80mm","copies":1,"ip_address":"192.168.1.50"}"#,
            r#"{"printer_name":"P","paper_width":"80mm","copies":1,"port":9100}"#,
            r#"{"printer_name":"P","paper_width":"80mm","copies":1,"command":"ESC @"}"#,
        ];
        for body in hostile {
            let parsed: Result<TestPrintRequest, _> = serde_json::from_str(body);
            // Serde ignores unknown fields by default, so the assertion that
            // matters is that the extra data is UNREACHABLE, not that parsing
            // fails: the struct has nowhere to put it.
            if let Ok(req) = parsed {
                let round_trip = serde_json::to_value(&req).unwrap();
                // serde_json's default map is a BTreeMap, so keys come back
                // sorted rather than in declaration order. What matters is the
                // SET of fields, not their order.
                let mut keys: Vec<&str> =
                    round_trip.as_object().unwrap().keys().map(|k| k.as_str()).collect();
                keys.sort_unstable();
                assert_eq!(keys, vec!["copies", "paper_width", "printer_name"]);
            }
        }
    }

    #[test]
    fn success_is_worded_as_acceptance_never_as_paper() {
        let outcome = PrintOutcome {
            accepted: true,
            printer_name: "Star TSP100".into(),
            copies_requested: 1,
            copies_accepted: 1,
            job_ids: vec![42],
            warning: None,
        };
        assert_eq!(outcome.acceptance_message(), "Print job accepted by Windows.");
        assert!(!outcome.acceptance_message().to_lowercase().contains("printed successfully"));
    }
}
