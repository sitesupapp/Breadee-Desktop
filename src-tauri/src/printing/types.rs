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

/// Smallest and largest custom roll this layer will lay a page out for.
///
/// MIRRORED, not invented: `src/lib/receipt.ts` in the web app already declares
/// `CUSTOM_PAPER_MIN_MM = 40` / `CUSTOM_PAPER_MAX_MM = 120` as the range outside
/// which "custom thermal rolls are not safely printable". One product, one
/// range. The web CLAMPS into it; this boundary REJECTS instead - see
/// `PaperWidth::parse`.
pub const CUSTOM_PAPER_MIN_MM: u16 = 40;
pub const CUSTOM_PAPER_MAX_MM: u16 = 120;

/// Widths this layer can lay a page out for.
///
/// A closed type rather than a bare number, so an unsupported width is a
/// deserialisation failure at the boundary rather than a page silently printed
/// at the wrong size. A4 is still deliberately absent: these are thermal rolls,
/// and inventing a sheet layout would be pretending to a capability nobody has
/// designed.
///
/// WHY `CustomMm` EXISTS. A printer's marketed roll class and its actual
/// printable width are different facts. An Xprinter XP-80 is sold as 80mm and
/// marks about 72mm, and the web print bridge already sizes its raster to 72 for
/// exactly that reason. Laying out at a nominal 80 and letting the driver clip
/// is how the right-hand column of a total disappears, so the real printable
/// width is a first-class value here rather than something rounded to the
/// nearest preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaperWidth {
    Mm58,
    Mm80,
    /// A validated custom printable width, in whole millimetres.
    ///
    /// Only constructible through `parse`/`custom`, so a value of this shape has
    /// already been range-checked - there is no way to hand the renderer a
    /// 5000mm page by building the enum directly from frontend input.
    CustomMm(u16),
}

impl PaperWidth {
    /// The width to lay text out against, in millimetres.
    ///
    /// For the two presets this is the nominal roll; the driver's own printable
    /// area still caps it at draw time. For a custom width it is the printable
    /// figure the operator configured, which is the point of configuring one.
    pub fn millimetres(self) -> f32 {
        match self {
            PaperWidth::Mm58 => 58.0,
            PaperWidth::Mm80 => 80.0,
            PaperWidth::CustomMm(mm) => mm as f32,
        }
    }

    /// The wire and display form: `58mm`, `80mm` or `custom:72`.
    ///
    /// `custom:<mm>` is not a new spelling - it is the form the web app already
    /// stores in `pos_receipt_settings.paper_size` and parses in `resolvePaper`.
    /// Reusing it means one vocabulary across the product instead of a desktop
    /// dialect that has to be translated at every boundary.
    pub fn label(self) -> String {
        match self {
            PaperWidth::Mm58 => "58mm".to_string(),
            PaperWidth::Mm80 => "80mm".to_string(),
            PaperWidth::CustomMm(mm) => format!("custom:{mm}"),
        }
    }

    /// Build a custom width, refusing anything outside the shared range.
    pub fn custom(mm: u16) -> Result<Self, PrintError> {
        if !(CUSTOM_PAPER_MIN_MM..=CUSTOM_PAPER_MAX_MM).contains(&mm) {
            return Err(PrintError::InvalidPaperWidth {
                detail: format!(
                    "custom width {mm}mm is outside {CUSTOM_PAPER_MIN_MM}-{CUSTOM_PAPER_MAX_MM}mm"
                ),
            });
        }
        Ok(PaperWidth::CustomMm(mm))
    }

    /// Parse the wire form.
    ///
    /// REJECTS rather than clamps. The web clamps because it is laying out a
    /// preview and a slightly wrong column is survivable; this drives a physical
    /// head, and a request for a 400mm page is a caller bug that should surface
    /// as an error rather than quietly become a 120mm page. Whole millimetres
    /// only: the value originates in `pos_printer_settings.custom_paper_width`,
    /// which is an integer column.
    pub fn parse(raw: &str) -> Result<Self, PrintError> {
        let value = raw.trim().to_ascii_lowercase();
        match value.as_str() {
            "58mm" => return Ok(PaperWidth::Mm58),
            "80mm" => return Ok(PaperWidth::Mm80),
            _ => {}
        }
        let digits = value
            .strip_prefix("custom:")
            .map(|rest| rest.strip_suffix("mm").unwrap_or(rest))
            .ok_or_else(|| PrintError::InvalidPaperWidth { detail: raw.to_string() })?;
        let mm: u16 = digits
            .parse()
            .map_err(|_| PrintError::InvalidPaperWidth { detail: raw.to_string() })?;
        PaperWidth::custom(mm)
    }
}

/// Serialised as its label, so the wire form stays a plain string and the
/// existing `"58mm"` / `"80mm"` contract is unchanged.
impl Serialize for PaperWidth {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.label())
    }
}

impl<'de> Deserialize<'de> for PaperWidth {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        PaperWidth::parse(&raw).map_err(serde::de::Error::custom)
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

/// What the printer is for, as far as a test page is concerned.
///
/// Mirrors `pos_printer_settings.printer_type`. It selects a HEADING and
/// nothing else - there is no branch here where a role reaches a device
/// differently, so a wrong role misprints a word, never a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrinterRole {
    Cashier,
    Kitchen,
    Other,
}

impl PrinterRole {
    /// The banner that tells whoever picks the paper up what it is.
    pub fn test_page_title(self) -> &'static str {
        match self {
            PrinterRole::Cashier => "TEST RECEIPT",
            PrinterRole::Kitchen => "TEST KITCHEN TICKET",
            PrinterRole::Other => "TEST PAGE",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PrinterRole::Cashier => "Cashier",
            PrinterRole::Kitchen => "Kitchen",
            PrinterRole::Other => "Other",
        }
    }
}

/// Longest operator-supplied string a test page will draw.
///
/// These values are captions, not content. Capping them means a caller cannot
/// turn a diagnostic into an unbounded print job - the failure mode this guards
/// is a runaway roll, not a memory bug.
pub const MAX_CAPTION_CHARS: usize = 60;

/// Which Breadee printer a test page represents.
///
/// STILL SYNTHETIC. Every field is configuration an operator typed on the setup
/// screen - a printer alias, a branch name - and none of it is order, customer,
/// payment or shift data. A test page remains safe to leave on a printer in a
/// public area, which is the property `page.rs` tests directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestPageContext {
    /// The tenant's business name.
    pub business_name: String,
    pub branch_name: String,
    /// The Breadee alias, e.g. "Front Cashier" - not the Windows queue name.
    pub printer_alias: String,
    pub role: PrinterRole,
}

impl TestPageContext {
    /// Trim every caption to something a roll can hold.
    ///
    /// Truncating on a CHARACTER boundary, not a byte one: an Arabic branch
    /// name cut mid-codepoint would not be a string at all.
    pub fn clamped(&self) -> TestPageContext {
        let cut = |s: &str| s.chars().take(MAX_CAPTION_CHARS).collect::<String>();
        TestPageContext {
            business_name: cut(&self.business_name),
            branch_name: cut(&self.branch_name),
            printer_alias: cut(&self.printer_alias),
            role: self.role,
        }
    }
}

/// A request to print the built-in diagnostic page.
///
/// Note what is absent, and see the module comment for why. `context` is
/// optional so the Level 3E-A callers that send three fields keep working
/// unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestPrintRequest {
    pub printer_name: String,
    pub paper_width: PaperWidth,
    pub copies: u8,
    #[serde(default)]
    pub context: Option<TestPageContext>,
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
    fn paper_width_accepts_the_two_presets_and_a_validated_custom_roll() {
        assert_eq!(serde_json::from_str::<PaperWidth>("\"58mm\"").unwrap(), PaperWidth::Mm58);
        assert_eq!(serde_json::from_str::<PaperWidth>("\"80mm\"").unwrap(), PaperWidth::Mm80);
        // The XP-80 case: sold as 80mm, marks 72mm.
        assert_eq!(
            serde_json::from_str::<PaperWidth>("\"custom:72\"").unwrap(),
            PaperWidth::CustomMm(72)
        );
        // A4 is a sheet, not a roll: still refused rather than guessed at.
        assert!(serde_json::from_str::<PaperWidth>("\"a4\"").is_err());
        // Bare `custom` carries no width, so there is nothing to lay out against.
        assert!(serde_json::from_str::<PaperWidth>("\"custom\"").is_err());
        assert!(serde_json::from_str::<PaperWidth>("\"custom:\"").is_err());
        // Not a preset spelling, and not the custom form either.
        assert!(serde_json::from_str::<PaperWidth>("\"120mm\"").is_err());
    }

    #[test]
    fn a_custom_width_outside_the_shared_range_is_refused_not_clamped() {
        // The web clamps for a preview; this drives a head, so an impossible
        // width surfaces as an error instead of quietly becoming the maximum.
        for bad in [0u16, 1, CUSTOM_PAPER_MIN_MM - 1, CUSTOM_PAPER_MAX_MM + 1, 400, 5000] {
            let err = PaperWidth::custom(bad).unwrap_err();
            assert_eq!(err.code(), "invalid_paper_width", "{bad}mm must be refused");
        }
        // Both ends of the range are inclusive.
        assert_eq!(
            PaperWidth::custom(CUSTOM_PAPER_MIN_MM).unwrap(),
            PaperWidth::CustomMm(CUSTOM_PAPER_MIN_MM)
        );
        assert_eq!(
            PaperWidth::custom(CUSTOM_PAPER_MAX_MM).unwrap(),
            PaperWidth::CustomMm(CUSTOM_PAPER_MAX_MM)
        );
    }

    #[test]
    fn the_custom_range_matches_the_web_apps_declared_range() {
        // src/lib/receipt.ts: CUSTOM_PAPER_MIN_MM = 40, CUSTOM_PAPER_MAX_MM = 120.
        // One product, one answer to "what is a printable roll".
        assert_eq!(CUSTOM_PAPER_MIN_MM, 40);
        assert_eq!(CUSTOM_PAPER_MAX_MM, 120);
    }

    #[test]
    fn a_custom_width_never_arrives_as_a_fraction_or_junk() {
        // `custom_paper_width` is an integer column; anything else is a caller
        // that has invented a value, not a printer that has one.
        for bad in ["custom:72.5", "custom:-72", "custom:abc", "custom:72px", "custom: 72"] {
            assert!(PaperWidth::parse(bad).is_err(), "{bad:?} must not parse");
        }
    }

    #[test]
    fn paper_width_reports_its_own_geometry_and_label() {
        assert_eq!(PaperWidth::Mm58.millimetres(), 58.0);
        assert_eq!(PaperWidth::Mm80.millimetres(), 80.0);
        assert_eq!(PaperWidth::CustomMm(72).millimetres(), 72.0);
        assert_eq!(PaperWidth::Mm58.label(), "58mm");
        assert_eq!(PaperWidth::Mm80.label(), "80mm");
        assert_eq!(PaperWidth::CustomMm(72).label(), "custom:72");
    }

    #[test]
    fn every_width_survives_a_round_trip_through_the_wire_form() {
        for width in [PaperWidth::Mm58, PaperWidth::Mm80, PaperWidth::CustomMm(72)] {
            let json = serde_json::to_string(&width).unwrap();
            assert_eq!(serde_json::from_str::<PaperWidth>(&json).unwrap(), width);
            // The wire form is a plain string, so the 3E-A/3E-B contract that
            // sends "80mm" keeps working untouched.
            assert!(json.starts_with('"'), "{json} must serialise as a string");
        }
    }

    #[test]
    fn the_parser_tolerates_case_and_surrounding_space_but_nothing_else() {
        assert_eq!(PaperWidth::parse(" 80MM ").unwrap(), PaperWidth::Mm80);
        assert_eq!(PaperWidth::parse("CUSTOM:72mm").unwrap(), PaperWidth::CustomMm(72));
        assert!(PaperWidth::parse("").is_err());
        assert!(PaperWidth::parse("80 mm").is_err());
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
                // `context` carries only captions (see TestPageContext); there
                // is still nowhere for bytes, a path, an address or a command.
                assert_eq!(keys, vec!["context", "copies", "paper_width", "printer_name"]);
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
