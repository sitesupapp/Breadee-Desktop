//! The diagnostic test page.
//!
//! SYNTHETIC ON PURPOSE. This page is built from a machine name, a paper width
//! and the local clock. It reads no order, no customer, no payment, no tenant
//! and no shift, so a test print can never disclose trading data to whoever is
//! standing at the printer - and a printer test can never be confused for a
//! receipt if the paper is later found lying around.
//!
//! WHY THE ARABIC LINES ARE HERE. Breadee runs in Lebanese restaurants, where a
//! menu is routinely mixed Arabic and English. Arabic is not a font problem: it
//! is a SHAPING problem. Each letter takes a different glyph depending on its
//! neighbours, and a line mixing scripts has to be reordered for display by the
//! bidirectional algorithm. A page that only proves "English came out" proves
//! almost nothing about whether this printer path is usable here, so the three
//! samples below are the actual point of the diagnostic.

use super::types::{PaperWidth, TestPageContext};

/// How a line should be laid out. The renderer maps these onto the platform's
/// text engine; nothing here knows about Windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineStyle {
    /// Large, centred. The page title.
    Title,
    /// Bold, left-aligned. Section labels.
    Heading,
    /// Normal weight.
    Body,
    /// Smaller, muted. Footnotes.
    Small,
    /// A horizontal rule drawn as repeated characters.
    Rule,
    /// Deliberate vertical space.
    Blank,
    /// The one figure a customer looks for. Larger and bold (Level 3E-B).
    Total,
}

/// Paragraph direction. `Rtl` asks the text engine for right-to-left reading
/// order AND right alignment, which is what an Arabic paragraph needs; `Auto`
/// lets the engine decide from the first strong character, which is the correct
/// behaviour for a mixed line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Auto,
    Rtl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageLine {
    pub text: String,
    /// Right-aligned text on the SAME line - a money column (Level 3E-B).
    ///
    /// A receipt is two columns: a description that wraps, and an amount that
    /// must stay flush right. Padding with spaces cannot do this in a
    /// proportional font, and a receipt whose figures do not line up reads as
    /// broken however correct the arithmetic is. The renderer draws this with a
    /// second right-aligned pass on the same row.
    pub right: Option<String>,
    pub style: LineStyle,
    pub direction: Direction,
}

impl PageLine {
    pub fn new(text: impl Into<String>, style: LineStyle, direction: Direction) -> Self {
        Self { text: text.into(), right: None, style, direction }
    }

    /// A description on the left and an amount on the right.
    pub fn pair(
        text: impl Into<String>,
        right: impl Into<String>,
        style: LineStyle,
        direction: Direction,
    ) -> Self {
        Self { text: text.into(), right: Some(right.into()), style, direction }
    }
}

/// Arabic sample: "Breadee - a printer test".
///
/// Written as a plain Rust string literal in logical (typing) order, which is
/// exactly how it arrives from a database or a menu. If the printer path is
/// correct this renders as connected, right-to-left Arabic script; if the path
/// falls back to a byte-oriented mode it will come out as disconnected letters
/// in the wrong order, or as boxes - which is precisely the failure this page
/// exists to expose.
pub const ARABIC_SAMPLE: &str = "بريدي - اختبار الطابعة";

/// Mixed sample. The hardest of the three: the digits and the Latin word must
/// stay left-to-right INSIDE a right-to-left sentence.
pub const MIXED_SAMPLE: &str = "الطلب رقم 260810-0001 - Delivery";

pub const ENGLISH_SAMPLE: &str = "The quick brown fox jumps over the lazy dog.";

pub const FOOTER: &str = "If this page is readable, native printing is connected.";

/// Printed on every test page, whatever the role.
///
/// A cashier test page is receipt-shaped by design - that is what makes it a
/// useful test - which is exactly why it has to say what it is. Paper left on a
/// counter gets picked up by staff and customers.
pub const NOT_A_REAL_ORDER: &str = "TEST PRINT - NOT A REAL ORDER";

/// How many characters wide the horizontal rule should be.
///
/// Derived from the width in millimetres rather than matched preset-by-preset,
/// so a custom roll gets a rule that fits it instead of borrowing 58mm's or
/// 80mm's. The two presets keep exactly the widths they had (24 and 32), because
/// changing the look of the existing page was not the point of adding custom
/// widths. The floor stops a very narrow roll producing a rule of two dashes.
/// Shared with the receipt renderer: one rule width for both documents, so a
/// custom roll cannot end up with a diagnostic page and a receipt that disagree
/// about how wide the paper is.
pub(super) fn rule_chars(paper: PaperWidth) -> usize {
    const CHARS_PER_MM: f32 = 32.0 / 80.0;
    match paper {
        PaperWidth::Mm58 => 24,
        PaperWidth::Mm80 => 32,
        PaperWidth::CustomMm(mm) => ((mm as f32) * CHARS_PER_MM).round().max(12.0) as usize,
    }
}

/// Build the diagnostic page.
///
/// `now` is passed in rather than read here so the page is deterministic under
/// test - the same reason the receipt builders take their timestamp.
pub fn build_test_page(
    printer_name: &str,
    paper: PaperWidth,
    now: &str,
    context: Option<&TestPageContext>,
) -> Vec<PageLine> {
    let rule = "-".repeat(rule_chars(paper));
    let context = context.map(|c| c.clamped());

    let mut lines = vec![
        PageLine::new("BREADEE", LineStyle::Title, Direction::Auto),
        // The banner an operator reads first. Without it a receipt-shaped page
        // found on a counter is indistinguishable from a real one.
        PageLine::new(
            context.as_ref().map_or("Native Printer Test", |c| c.role.test_page_title()),
            LineStyle::Body,
            Direction::Auto,
        ),
        PageLine::new(NOT_A_REAL_ORDER, LineStyle::Body, Direction::Auto),
        PageLine::new(rule.clone(), LineStyle::Rule, Direction::Auto),
    ];

    if let Some(c) = context.as_ref() {
        lines.push(PageLine::new("Business", LineStyle::Heading, Direction::Auto));
        // A branch or business name may be Arabic, so the engine decides.
        lines.push(PageLine::new(c.business_name.clone(), LineStyle::Body, Direction::Auto));
        lines.push(PageLine::new("Branch", LineStyle::Heading, Direction::Auto));
        lines.push(PageLine::new(c.branch_name.clone(), LineStyle::Body, Direction::Auto));
        lines.push(PageLine::new("Breadee printer", LineStyle::Heading, Direction::Auto));
        lines.push(PageLine::new(c.printer_alias.clone(), LineStyle::Body, Direction::Auto));
        lines.push(PageLine::new("Role", LineStyle::Heading, Direction::Auto));
        lines.push(PageLine::new(c.role.label(), LineStyle::Body, Direction::Auto));
    }

    lines.extend([
        PageLine::new("Windows printer", LineStyle::Heading, Direction::Auto),
        PageLine::new(printer_name, LineStyle::Body, Direction::Auto),
        PageLine::new("Paper", LineStyle::Heading, Direction::Auto),
        PageLine::new(paper.label(), LineStyle::Body, Direction::Auto),
        PageLine::new("Date / time", LineStyle::Heading, Direction::Auto),
        PageLine::new(now, LineStyle::Body, Direction::Auto),
        PageLine::new(rule.clone(), LineStyle::Rule, Direction::Auto),
        PageLine::new("English", LineStyle::Heading, Direction::Auto),
        PageLine::new(ENGLISH_SAMPLE, LineStyle::Body, Direction::Auto),
        PageLine::new("", LineStyle::Blank, Direction::Auto),
        // Right-to-left paragraph: the engine is told the direction explicitly.
        PageLine::new("Arabic", LineStyle::Heading, Direction::Auto),
        PageLine::new(ARABIC_SAMPLE, LineStyle::Body, Direction::Rtl),
        PageLine::new("", LineStyle::Blank, Direction::Auto),
        // Mixed: direction is left to the engine, which must reorder the runs.
        PageLine::new("Mixed", LineStyle::Heading, Direction::Auto),
        PageLine::new(MIXED_SAMPLE, LineStyle::Body, Direction::Rtl),
        PageLine::new(rule, LineStyle::Rule, Direction::Auto),
        PageLine::new(FOOTER, LineStyle::Small, Direction::Auto),
    ]);

    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::types::PrinterRole;

    fn page() -> Vec<PageLine> {
        build_test_page("Star TSP100", PaperWidth::Mm80, "2026-08-11 10:00", None)
    }

    fn context(role: PrinterRole) -> TestPageContext {
        TestPageContext {
            business_name: "Dominos Pizza".into(),
            branch_name: "Main Branch".into(),
            printer_alias: "Front Cashier".into(),
            role,
        }
    }

    fn texts(lines: &[PageLine]) -> Vec<String> {
        lines.iter().map(|l| l.text.clone()).collect()
    }

    #[test]
    fn the_page_identifies_itself_the_printer_the_paper_and_the_time() {
        // Bound to a local first: borrowing straight out of `page()` would let
        // the Vec drop at the end of the statement while these &str still point
        // into it.
        let lines = page();
        let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert!(text.contains(&"BREADEE"));
        assert!(text.contains(&"Native Printer Test"));
        assert!(text.contains(&"Star TSP100"));
        assert!(text.contains(&"80mm"));
        assert!(text.contains(&"2026-08-11 10:00"));
        assert!(text.contains(&FOOTER));
    }

    #[test]
    fn the_page_carries_english_arabic_and_mixed_samples() {
        let lines = page();
        let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert!(text.contains(&ENGLISH_SAMPLE));
        assert!(text.contains(&ARABIC_SAMPLE));
        assert!(text.contains(&MIXED_SAMPLE));
    }

    #[test]
    fn the_arabic_sample_really_is_arabic_script() {
        // Guards against the samples being "fixed" into transliteration by a
        // later editor whose terminal could not display them: without Arabic
        // codepoints the page proves nothing about shaping.
        let arabic = ARABIC_SAMPLE.chars().filter(|c| ('\u{0600}'..='\u{06FF}').contains(c)).count();
        assert!(arabic >= 8, "the Arabic sample must contain Arabic codepoints");
    }

    #[test]
    fn the_mixed_sample_contains_both_scripts_and_digits() {
        assert!(MIXED_SAMPLE.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)));
        assert!(MIXED_SAMPLE.chars().any(|c| c.is_ascii_alphabetic()));
        assert!(MIXED_SAMPLE.chars().any(|c| c.is_ascii_digit()));
    }

    #[test]
    fn arabic_paragraphs_are_marked_right_to_left() {
        let lines = page();
        let arabic = lines.iter().find(|l| l.text == ARABIC_SAMPLE).unwrap();
        let mixed = lines.iter().find(|l| l.text == MIXED_SAMPLE).unwrap();
        assert_eq!(arabic.direction, Direction::Rtl);
        assert_eq!(mixed.direction, Direction::Rtl);
        // English stays engine-decided.
        let english = lines.iter().find(|l| l.text == ENGLISH_SAMPLE).unwrap();
        assert_eq!(english.direction, Direction::Auto);
    }

    #[test]
    fn every_page_says_it_is_not_a_real_order() {
        // With and without context: paper found on a counter must always
        // announce itself, and the receipt-shaped one most of all.
        assert!(texts(&page()).contains(&NOT_A_REAL_ORDER.to_string()));
        for role in [PrinterRole::Cashier, PrinterRole::Kitchen, PrinterRole::Other] {
            let lines = build_test_page("P", PaperWidth::Mm80, "t", Some(&context(role)));
            assert!(texts(&lines).contains(&NOT_A_REAL_ORDER.to_string()), "{role:?}");
        }
    }

    #[test]
    fn the_role_chooses_the_banner() {
        let title = |role| {
            let lines = build_test_page("P", PaperWidth::Mm80, "t", Some(&context(role)));
            texts(&lines)
        };
        assert!(title(PrinterRole::Cashier).contains(&"TEST RECEIPT".to_string()));
        assert!(title(PrinterRole::Kitchen).contains(&"TEST KITCHEN TICKET".to_string()));
        assert!(title(PrinterRole::Other).contains(&"TEST PAGE".to_string()));
    }

    #[test]
    fn a_context_page_names_the_breadee_printer_not_just_the_windows_queue() {
        // The whole point for support: paper coming out of an unlabelled box
        // has to say WHICH configured printer produced it.
        let lines = build_test_page("Xprinter XP-80", PaperWidth::CustomMm(72), "t",
            Some(&context(PrinterRole::Cashier)));
        let t = texts(&lines);
        assert!(t.contains(&"Front Cashier".to_string()), "the Breadee alias");
        assert!(t.contains(&"Xprinter XP-80".to_string()), "the Windows queue");
        assert!(t.contains(&"Main Branch".to_string()));
        assert!(t.contains(&"Dominos Pizza".to_string()));
        assert!(t.contains(&"Cashier".to_string()));
        assert!(t.contains(&"custom:72".to_string()));
    }

    #[test]
    fn a_page_without_context_is_unchanged_apart_from_the_banner() {
        // Level 3E-A's caller sends no context and must keep working.
        let t = texts(&page());
        assert!(t.contains(&"Native Printer Test".to_string()));
        assert!(!t.contains(&"Breadee printer".to_string()), "no empty caption headings");
        assert!(!t.contains(&"Branch".to_string()));
    }

    #[test]
    fn captions_are_clamped_so_a_test_page_cannot_run_away() {
        let long = TestPageContext {
            business_name: "A".repeat(5_000),
            branch_name: "ب".repeat(5_000),
            printer_alias: "C".repeat(5_000),
            role: PrinterRole::Cashier,
        };
        let lines = build_test_page("P", PaperWidth::Mm80, "t", Some(&long));
        for line in &lines {
            assert!(
                line.text.chars().count() <= 60usize.max(FOOTER.chars().count()),
                "a caption escaped the clamp: {} chars",
                line.text.chars().count()
            );
        }
        // Truncation is by character, so a multi-byte branch name survives.
        let branch = lines.iter().find(|l| l.text.starts_with('ب')).expect("branch caption");
        assert_eq!(branch.text.chars().count(), 60);
    }

    #[test]
    fn the_page_contains_no_trading_data() {
        // A diagnostic page must be safe to leave on a printer in a public area.
        let joined = page().iter().map(|l| l.text.clone()).collect::<Vec<_>>().join(" ").to_lowercase();
        for forbidden in [
            "total", "subtotal", "discount", "payment", "paid", "cash", "usd", "lbp",
            "customer", "phone", "address", "shift", "tenant", "order #", "table",
        ] {
            assert!(!joined.contains(forbidden), "diagnostic page must not mention {forbidden:?}");
        }
    }

    fn rule_width(paper: PaperWidth) -> usize {
        build_test_page("P", paper, "t", None)
            .iter()
            .find(|l| l.style == LineStyle::Rule)
            .unwrap()
            .text
            .len()
    }

    #[test]
    fn the_rule_narrows_with_the_paper() {
        assert!(rule_width(PaperWidth::Mm58) < rule_width(PaperWidth::Mm80));
    }

    #[test]
    fn the_two_presets_keep_the_rule_widths_they_already_had() {
        // Adding custom widths must not restyle the page operators already know.
        assert_eq!(rule_width(PaperWidth::Mm58), 24);
        assert_eq!(rule_width(PaperWidth::Mm80), 32);
    }

    #[test]
    fn a_custom_roll_gets_a_rule_sized_for_itself() {
        // 72mm sits between the presets, so its rule must too - not borrow 80's
        // and overhang the paper, nor borrow 58's and look broken.
        let custom72 = rule_width(PaperWidth::CustomMm(72));
        assert!(
            custom72 > rule_width(PaperWidth::Mm58) && custom72 < rule_width(PaperWidth::Mm80),
            "72mm rule ({custom72}) must fall between the 58mm and 80mm rules"
        );
    }

    #[test]
    fn a_very_narrow_custom_roll_still_draws_a_usable_rule() {
        assert!(rule_width(PaperWidth::CustomMm(40)) >= 12);
    }

    #[test]
    fn the_page_names_the_custom_width_it_was_laid_out_for() {
        let lines = build_test_page("XP-80", PaperWidth::CustomMm(72), "t", None);
        let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        // The operator reading the paper can see which width produced it.
        assert!(text.contains(&"custom:72"));
    }

    #[test]
    fn the_printer_name_is_reproduced_verbatim() {
        // Windows printer names contain spaces, punctuation and sometimes
        // non-ASCII. The page shows what was actually targeted.
        let odd = "HP LaserJet Pro M404-dn (Ahmad's desk)";
        let lines = build_test_page(odd, PaperWidth::Mm58, "t", None);
        assert!(lines.iter().any(|l| l.text == odd));
    }
}
