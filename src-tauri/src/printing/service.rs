//! Orchestration: validate, then drive a device through one document per copy.
//!
//! The platform lives behind two small traits, so the parts that are easy to get
//! wrong - refusing an unknown printer, bounding the copy count, aborting a
//! half-written document, and closing the handle on EVERY exit path - are
//! ordinary Rust that runs in CI on any machine, with no printer and no paper.
//! `windows_spooler.rs` is then only the Win32 calls themselves.

use super::page::{build_test_page, PageLine};
use super::types::{
    resolve_printer, validate_copies, InstalledPrinter, PaperWidth, PrintError, PrintOutcome,
    TestPageContext,
};

/// Enumerating printers.
pub trait PrinterCatalogue {
    fn list(&self) -> Result<Vec<InstalledPrinter>, PrintError>;
}

/// One printing device, driven one document at a time.
///
/// Split into steps rather than a single `print()` so the failure and cleanup
/// paths are reachable from a test. Each step maps to a Win32 call; the ordering
/// is the contract the spooler requires.
pub trait PrintDevice {
    fn open(&mut self, printer: &str) -> Result<(), PrintError>;
    fn start_document(&mut self, title: &str) -> Result<u32, PrintError>;
    fn draw(&mut self, paper: PaperWidth, lines: &[PageLine]) -> Result<(), PrintError>;
    fn finish_document(&mut self) -> Result<(), PrintError>;
    /// Cancel a document that was started but cannot be completed. Best-effort:
    /// there is nothing useful to do if cancelling itself fails.
    fn abort_document(&mut self);
    /// Release the handle. Must be safe to call once per successful `open`.
    fn close(&mut self);
}

pub const DOCUMENT_TITLE: &str = "Breadee printer test";

/// Print exactly one document.
///
/// Once `start_document` has succeeded the spooler holds a partially written
/// document, so every later failure aborts it before closing. Leaving it open
/// would strand a job in the queue that an operator has to find and cancel by
/// hand - and on a thermal roll a stranded document can hold the cutter.
pub fn print_one_copy<D: PrintDevice>(
    device: &mut D,
    printer: &str,
    paper: PaperWidth,
    lines: &[PageLine],
) -> Result<u32, PrintError> {
    // Nothing is open yet, so a failure here needs no cleanup.
    device.open(printer)?;

    let job_id = match device.start_document(DOCUMENT_TITLE) {
        Ok(id) => id,
        Err(e) => {
            device.close();
            return Err(e);
        }
    };

    if let Err(e) = device.draw(paper, lines) {
        device.abort_document();
        device.close();
        return Err(e);
    }

    if let Err(e) = device.finish_document() {
        device.abort_document();
        device.close();
        return Err(e);
    }

    device.close();
    Ok(job_id)
}

/// The printers Windows offers this user session.
pub fn list_printers<C: PrinterCatalogue>(catalogue: &C) -> Result<Vec<InstalledPrinter>, PrintError> {
    catalogue.list()
}

/// Validate a test-print request and run it.
///
/// COPIES ARE SEPARATE DOCUMENTS. Driver-level copy counts are honoured
/// inconsistently across thermal drivers - some ignore the field, some apply it
/// per page rather than per document - so N copies is N spool jobs. It is
/// slower and it is predictable, and for a diagnostic that a human is standing
/// over, predictable wins.
#[allow(clippy::too_many_arguments)]
pub fn print_test_page<C, D, F>(
    catalogue: &C,
    make_device: F,
    printer_name: &str,
    paper: PaperWidth,
    copies_requested: u32,
    now: &str,
    context: Option<&TestPageContext>,
) -> Result<PrintOutcome, PrintError>
where
    C: PrinterCatalogue,
    D: PrintDevice,
    F: Fn() -> D,
{
    let copies = validate_copies(copies_requested)?;

    // Re-enumerate rather than trusting the name the frontend sent. The list the
    // operator chose from may be minutes old, and a printer can be removed.
    let installed = catalogue.list()?;
    let target = resolve_printer(printer_name, &installed)?;
    let name = target.name.clone();

    let lines = build_test_page(&name, paper, now, context);

    let mut job_ids = Vec::new();
    let mut first_error = None;
    for _ in 0..copies {
        let mut device = make_device();
        match print_one_copy(&mut device, &name, paper, &lines) {
            Ok(id) => job_ids.push(id),
            Err(e) => {
                first_error = Some(e);
                // Stop at the first failure: if the device is refusing, further
                // copies would queue more failures, not more paper.
                break;
            }
        }
    }

    let copies_accepted = job_ids.len() as u8;

    // Nothing at all was taken: report the failure rather than an empty success.
    if copies_accepted == 0 {
        return Err(first_error.unwrap_or(PrintError::WriteFailed {
            printer: name,
            detail: "no copies were requested".into(),
        }));
    }

    let warning = first_error.map(|e| {
        format!(
            "Only {copies_accepted} of {copies} copies were accepted ({}).",
            e.code()
        )
    });

    Ok(PrintOutcome {
        accepted: true,
        printer_name: name,
        copies_requested: copies,
        copies_accepted,
        job_ids,
        warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::page::{ARABIC_SAMPLE, MIXED_SAMPLE};
    use super::super::types::PrinterStatus;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Step {
        Open(String),
        StartDoc(String),
        Draw(usize),
        FinishDoc,
        AbortDoc,
        Close,
    }

    /// Where a scripted device should fail.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FailAt {
        Never,
        Open,
        StartDoc,
        Draw,
        FinishDoc,
    }

    struct MockDevice {
        fail_at: FailAt,
        steps: Rc<RefCell<Vec<Step>>>,
        next_job: u32,
    }

    impl PrintDevice for MockDevice {
        fn open(&mut self, printer: &str) -> Result<(), PrintError> {
            self.steps.borrow_mut().push(Step::Open(printer.to_string()));
            if self.fail_at == FailAt::Open {
                return Err(PrintError::OpenPrinterFailed {
                    printer: printer.into(),
                    detail: "mock".into(),
                });
            }
            Ok(())
        }
        fn start_document(&mut self, title: &str) -> Result<u32, PrintError> {
            self.steps.borrow_mut().push(Step::StartDoc(title.to_string()));
            if self.fail_at == FailAt::StartDoc {
                return Err(PrintError::StartDocumentFailed {
                    printer: "mock".into(),
                    detail: "mock".into(),
                });
            }
            Ok(self.next_job)
        }
        fn draw(&mut self, _paper: PaperWidth, lines: &[PageLine]) -> Result<(), PrintError> {
            self.steps.borrow_mut().push(Step::Draw(lines.len()));
            if self.fail_at == FailAt::Draw {
                return Err(PrintError::WriteFailed { printer: "mock".into(), detail: "mock".into() });
            }
            Ok(())
        }
        fn finish_document(&mut self) -> Result<(), PrintError> {
            self.steps.borrow_mut().push(Step::FinishDoc);
            if self.fail_at == FailAt::FinishDoc {
                return Err(PrintError::FinishDocumentFailed {
                    printer: "mock".into(),
                    detail: "mock".into(),
                });
            }
            Ok(())
        }
        fn abort_document(&mut self) {
            self.steps.borrow_mut().push(Step::AbortDoc);
        }
        fn close(&mut self) {
            self.steps.borrow_mut().push(Step::Close);
        }
    }

    struct MockCatalogue {
        printers: Vec<InstalledPrinter>,
        fail: bool,
    }

    impl PrinterCatalogue for MockCatalogue {
        fn list(&self) -> Result<Vec<InstalledPrinter>, PrintError> {
            if self.fail {
                return Err(PrintError::PrinterEnumerationFailed { detail: "mock".into() });
            }
            Ok(self.printers.clone())
        }
    }

    fn catalogue(names: &[&str]) -> MockCatalogue {
        MockCatalogue {
            printers: names
                .iter()
                .enumerate()
                .map(|(i, n)| InstalledPrinter {
                    name: n.to_string(),
                    is_default: i == 0,
                    status: PrinterStatus::Unknown,
                })
                .collect(),
            fail: false,
        }
    }

    fn run(
        cat: &MockCatalogue,
        fail_at: FailAt,
        printer: &str,
        copies: u32,
    ) -> (Result<PrintOutcome, PrintError>, Vec<Step>) {
        let steps = Rc::new(RefCell::new(Vec::new()));
        let s = Rc::clone(&steps);
        let result = print_test_page(
            cat,
            || MockDevice { fail_at, steps: Rc::clone(&s), next_job: 7 },
            printer,
            PaperWidth::Mm80,
            copies,
            "2026-08-11 10:00",
            None,
        );
        let recorded = steps.borrow().clone();
        (result, recorded)
    }

    #[test]
    fn a_successful_copy_runs_the_spooler_sequence_in_order() {
        let (result, steps) = run(&catalogue(&["Star TSP100"]), FailAt::Never, "Star TSP100", 1);
        let outcome = result.unwrap();
        assert!(outcome.accepted);
        assert_eq!(outcome.copies_accepted, 1);
        assert_eq!(outcome.job_ids, vec![7]);
        assert!(outcome.warning.is_none());
        assert!(matches!(steps[0], Step::Open(_)));
        assert!(matches!(steps[1], Step::StartDoc(_)));
        assert!(matches!(steps[2], Step::Draw(_)));
        assert_eq!(steps[3], Step::FinishDoc);
        assert_eq!(steps[4], Step::Close);
        // Nothing was aborted on the happy path.
        assert!(!steps.contains(&Step::AbortDoc));
    }

    #[test]
    fn the_document_carries_the_diagnostic_page_including_arabic() {
        let steps = Rc::new(RefCell::new(Vec::new()));
        let s = Rc::clone(&steps);
        let mut device = MockDevice { fail_at: FailAt::Never, steps: s, next_job: 1 };
        let lines = build_test_page("P", PaperWidth::Mm80, "t", None);
        print_one_copy(&mut device, "P", PaperWidth::Mm80, &lines).unwrap();
        assert!(lines.iter().any(|l| l.text == ARABIC_SAMPLE));
        assert!(lines.iter().any(|l| l.text == MIXED_SAMPLE));
        assert!(steps.borrow().contains(&Step::Draw(lines.len())));
    }

    #[test]
    fn a_failure_to_open_leaves_nothing_to_clean_up() {
        let (result, steps) = run(&catalogue(&["P"]), FailAt::Open, "P", 1);
        assert!(matches!(result, Err(PrintError::OpenPrinterFailed { .. })));
        // No document was started, so no abort and no close are owed.
        assert_eq!(steps, vec![Step::Open("P".into())]);
    }

    #[test]
    fn a_failure_to_start_the_document_still_closes_the_handle() {
        let (result, steps) = run(&catalogue(&["P"]), FailAt::StartDoc, "P", 1);
        assert!(matches!(result, Err(PrintError::StartDocumentFailed { .. })));
        assert_eq!(*steps.last().unwrap(), Step::Close);
        // Nothing was started, so there is nothing to abort.
        assert!(!steps.contains(&Step::AbortDoc));
    }

    #[test]
    fn a_write_failure_aborts_the_document_and_then_closes() {
        let (result, steps) = run(&catalogue(&["P"]), FailAt::Draw, "P", 1);
        assert!(matches!(result, Err(PrintError::WriteFailed { .. })));
        let abort = steps.iter().position(|s| *s == Step::AbortDoc).expect("must abort");
        let close = steps.iter().position(|s| *s == Step::Close).expect("must close");
        assert!(abort < close, "the document must be aborted before the handle closes");
    }

    #[test]
    fn a_finish_failure_aborts_the_document_and_then_closes() {
        let (result, steps) = run(&catalogue(&["P"]), FailAt::FinishDoc, "P", 1);
        assert!(matches!(result, Err(PrintError::FinishDocumentFailed { .. })));
        assert!(steps.contains(&Step::AbortDoc));
        assert_eq!(*steps.last().unwrap(), Step::Close);
    }

    #[test]
    fn the_handle_is_closed_on_every_exit_path() {
        for fail_at in [FailAt::Never, FailAt::StartDoc, FailAt::Draw, FailAt::FinishDoc] {
            let (_, steps) = run(&catalogue(&["P"]), fail_at, "P", 1);
            assert_eq!(*steps.last().unwrap(), Step::Close, "close is owed after a successful open");
        }
    }

    #[test]
    fn each_copy_is_its_own_document() {
        let (result, steps) = run(&catalogue(&["P"]), FailAt::Never, "P", 3);
        assert_eq!(result.unwrap().copies_accepted, 3);
        assert_eq!(steps.iter().filter(|s| matches!(s, Step::StartDoc(_))).count(), 3);
        assert_eq!(steps.iter().filter(|s| **s == Step::FinishDoc).count(), 3);
        assert_eq!(steps.iter().filter(|s| **s == Step::Close).count(), 3);
    }

    #[test]
    fn an_unknown_printer_is_refused_before_any_device_is_touched() {
        let (result, steps) = run(&catalogue(&["Star TSP100"]), FailAt::Never, "Ghost", 1);
        assert!(matches!(result, Err(PrintError::PrinterNotFound { .. })));
        assert!(steps.is_empty(), "nothing may be opened for an unknown printer");
    }

    #[test]
    fn an_invalid_copy_count_is_refused_before_enumeration() {
        for bad in [0, 6, 99] {
            let (result, steps) = run(&catalogue(&["P"]), FailAt::Never, "P", bad);
            assert!(matches!(result, Err(PrintError::InvalidCopyCount { .. })), "copies={bad}");
            assert!(steps.is_empty());
        }
    }

    #[test]
    fn every_supported_width_reaches_the_device() {
        for paper in [PaperWidth::Mm58, PaperWidth::Mm80, PaperWidth::CustomMm(72)] {
            let steps = Rc::new(RefCell::new(Vec::new()));
            let s = Rc::clone(&steps);
            let cat = catalogue(&["P"]);
            let out = print_test_page(
                &cat,
                || MockDevice { fail_at: FailAt::Never, steps: Rc::clone(&s), next_job: 1 },
                "P",
                paper,
                1,
                "t",
                None,
            );
            assert!(out.unwrap().accepted, "{} must print", paper.label());
        }
    }

    #[test]
    fn enumeration_failure_is_reported_and_prints_nothing() {
        let cat = MockCatalogue { printers: vec![], fail: true };
        let (result, steps) = run(&cat, FailAt::Never, "P", 1);
        assert!(matches!(result, Err(PrintError::PrinterEnumerationFailed { .. })));
        assert!(steps.is_empty());
    }

    #[test]
    fn the_printer_name_used_is_the_enumerated_one_not_the_requested_string() {
        // They are equal today because matching is exact. Asserting it pins the
        // property: what is opened is what Windows listed.
        let (result, steps) = run(&catalogue(&["Star TSP100"]), FailAt::Never, "Star TSP100", 1);
        assert_eq!(result.unwrap().printer_name, "Star TSP100");
        assert_eq!(steps[0], Step::Open("Star TSP100".into()));
    }
}
