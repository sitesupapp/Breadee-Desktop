//! The end-of-shift report: document model, validation, and layout.
//!
//! A THIRD DOCUMENT ON THE SAME PATH, not a third printing system. Like the
//! receipt and the kitchen ticket, this produces a `Vec<PageLine>` for the
//! existing GDI renderer and goes out through `print_document`, so it inherits
//! the printer resolution, the copy bounds, the cleanup rules and the
//! Arabic/bidi handling without restating any of them.
//!
//! WHY THE LINES ARRIVE PRE-BUILT. A receipt and a ticket are structured
//! documents whose shape this crate owns, because their content is fixed. A
//! shift report is a SUMMARY whose sections depend on what the shift actually
//! contained - which routes were used, whether anything was reversed, which
//! items sold. The frontend already holds those server snapshots, so it composes
//! the label/value pairs and this file lays them out. That keeps every figure on
//! the report identical to the figure on the screen the operator just read.
//!
//! ONE DOCUMENT, NOT ONE PAGE PER ORDER. The whole shift prints as a single
//! spooled job.

use serde::{Deserialize, Serialize};

use super::page::{Direction, LineStyle, PageLine};
use super::receipt::{MAX_LINES, MAX_TEXT};
use super::types::{PaperWidth, PrintError};

/// How a report line should be drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportLineKind {
    /// A section header - "SALES", "BY ROUTE".
    Heading,
    /// A horizontal rule. The label is ignored.
    Rule,
    /// A figure that matters more than its neighbours.
    Total,
    /// Anything else: a label, optionally with a right-aligned value.
    Body,
}

impl Default for ReportLineKind {
    fn default() -> Self {
        ReportLineKind::Body
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportLine {
    pub label: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub kind: ReportLineKind,
}

/// One end-of-shift report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDoc {
    pub title: String,
    pub lines: Vec<ReportLine>,
}

fn too_long(value: &str, limit: usize) -> bool {
    value.chars().count() > limit
}

/// Reject a report this renderer should not be asked to draw.
///
/// The same bounds as the other two documents: these strings reach the same
/// Win32 text engine in the same loop. A report is longer than a receipt, so the
/// line limit is raised - but it is still bounded, because an unbounded document
/// is a spooler the operator has to go and rescue.
pub const MAX_REPORT_LINES: usize = MAX_LINES * 4;

pub fn validate_report(doc: &ReportDoc) -> Result<(), PrintError> {
    let invalid = |detail: &str| PrintError::InvalidReceipt { detail: detail.to_string() };
    if doc.lines.is_empty() {
        return Err(invalid("the report has no lines"));
    }
    if doc.lines.len() > MAX_REPORT_LINES {
        return Err(invalid("the report has too many lines"));
    }
    if too_long(&doc.title, MAX_TEXT) {
        return Err(invalid("the report title is too long"));
    }
    for line in &doc.lines {
        if too_long(&line.label, MAX_TEXT) {
            return Err(invalid("a report label is too long"));
        }
        if line.value.as_deref().is_some_and(|v| too_long(v, MAX_TEXT)) {
            return Err(invalid("a report value is too long"));
        }
    }
    Ok(())
}

fn is_rtl(text: &str) -> bool {
    text.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c) || ('\u{0750}'..='\u{077F}').contains(&c))
}

fn direction_for(text: &str) -> Direction {
    if is_rtl(text) { Direction::Rtl } else { Direction::Auto }
}

/// Lay the report out, one section after another as the caller composed them.
///
/// The caller's ORDER is preserved exactly. This file decides how a heading, a
/// rule and a total look; it never decides what a shift contained.
pub fn build_report_page(doc: &ReportDoc, paper: PaperWidth) -> Vec<PageLine> {
    let divider = "-".repeat(super::page::rule_chars(paper));
    let mut out: Vec<PageLine> = Vec::with_capacity(doc.lines.len() + 3);

    out.push(PageLine::new(&doc.title, LineStyle::Title, direction_for(&doc.title)));
    out.push(PageLine::new(divider.clone(), LineStyle::Rule, Direction::Auto));

    for line in &doc.lines {
        match line.kind {
            ReportLineKind::Rule => out.push(PageLine::new(divider.clone(), LineStyle::Rule, Direction::Auto)),
            ReportLineKind::Heading => {
                out.push(PageLine::new(&line.label, LineStyle::Heading, direction_for(&line.label)))
            }
            ReportLineKind::Total => out.push(PageLine::pair(
                &line.label,
                line.value.clone().unwrap_or_default(),
                LineStyle::Total,
                direction_for(&line.label),
            )),
            ReportLineKind::Body => match line.value.as_deref() {
                Some(v) => out.push(PageLine::pair(&line.label, v, LineStyle::Body, direction_for(&line.label))),
                None => out.push(PageLine::new(&line.label, LineStyle::Body, direction_for(&line.label))),
            },
        }
    }

    out.push(PageLine::new(divider, LineStyle::Rule, Direction::Auto));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(label: &str, value: Option<&str>, kind: ReportLineKind) -> ReportLine {
        ReportLine { label: label.into(), value: value.map(|v| v.into()), kind }
    }

    fn doc() -> ReportDoc {
        ReportDoc {
            title: "END OF SHIFT REPORT".into(),
            lines: vec![
                line("Dominos Pizza", None, ReportLineKind::Body),
                line("", None, ReportLineKind::Rule),
                line("SALES", None, ReportLineKind::Heading),
                line("Orders", Some("7"), ReportLineKind::Body),
                line("Net sales", Some("103.00 USD"), ReportLineKind::Total),
            ],
        }
    }

    fn texts(lines: &[PageLine]) -> Vec<String> {
        lines.iter().map(|l| l.text.clone()).collect()
    }

    #[test]
    fn the_report_titles_itself_and_keeps_the_callers_order() {
        let p = build_report_page(&doc(), PaperWidth::Mm80);
        assert_eq!(p[0].text, "END OF SHIFT REPORT");
        assert_eq!(p[0].style, LineStyle::Title);
        let t = texts(&p);
        let sales = t.iter().position(|x| x == "SALES").unwrap();
        let orders = t.iter().position(|x| x == "Orders").unwrap();
        let net = t.iter().position(|x| x == "Net sales").unwrap();
        assert!(sales < orders && orders < net, "sections must print in the order they were composed");
    }

    #[test]
    fn each_kind_draws_as_itself() {
        let p = build_report_page(&doc(), PaperWidth::Mm80);
        assert_eq!(p.iter().find(|l| l.text == "SALES").unwrap().style, LineStyle::Heading);
        let net = p.iter().find(|l| l.text == "Net sales").unwrap();
        assert_eq!(net.style, LineStyle::Total);
        assert_eq!(net.right.as_deref(), Some("103.00 USD"));
        // A body line with no value carries no amount column at all.
        assert!(p.iter().find(|l| l.text == "Dominos Pizza").unwrap().right.is_none());
    }

    #[test]
    fn it_is_one_document_however_long_the_shift_was() {
        let mut d = doc();
        for i in 0..120 {
            d.lines.push(line(&format!("Item {i}"), Some("1.00 USD"), ReportLineKind::Body));
        }
        let p = build_report_page(&d, PaperWidth::Mm80);
        // One page model, one title, no repeated header per order.
        assert_eq!(p.iter().filter(|l| l.style == LineStyle::Title).count(), 1);
    }

    #[test]
    fn arabic_content_is_laid_out_right_to_left() {
        let mut d = doc();
        d.lines.push(line("بيتزا مارغريتا", Some("7.00 USD"), ReportLineKind::Body));
        let p = build_report_page(&d, PaperWidth::Mm80);
        assert_eq!(p.iter().find(|l| l.text.contains("مارغريتا")).unwrap().direction, Direction::Rtl);
    }

    #[test]
    fn the_rule_narrows_with_the_paper() {
        let width = |p: &[PageLine]| p.iter().find(|l| l.style == LineStyle::Rule).unwrap().text.len();
        assert!(width(&build_report_page(&doc(), PaperWidth::Mm58)) < width(&build_report_page(&doc(), PaperWidth::Mm80)));
    }

    #[test]
    fn an_empty_report_is_refused() {
        let mut d = doc();
        d.lines.clear();
        assert!(matches!(validate_report(&d), Err(PrintError::InvalidReceipt { .. })));
    }

    #[test]
    fn pathological_input_is_refused_before_it_reaches_the_spooler() {
        let long = "x".repeat(MAX_TEXT + 1);
        let mut d = doc();
        d.lines[0].label = long.clone();
        assert!(matches!(validate_report(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.lines[0].value = Some(long);
        assert!(matches!(validate_report(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.lines = (0..MAX_REPORT_LINES + 1)
            .map(|_| line("x", None, ReportLineKind::Body))
            .collect();
        assert!(matches!(validate_report(&d), Err(PrintError::InvalidReceipt { .. })));
    }

    #[test]
    fn a_realistic_report_validates() {
        assert!(validate_report(&doc()).is_ok());
    }
}
