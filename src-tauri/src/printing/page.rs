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

use super::types::PaperWidth;

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
    pub style: LineStyle,
    pub direction: Direction,
}

impl PageLine {
    fn new(text: impl Into<String>, style: LineStyle, direction: Direction) -> Self {
        Self { text: text.into(), style, direction }
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

/// Build the diagnostic page.
///
/// `now` is passed in rather than read here so the page is deterministic under
/// test - the same reason the receipt builders take their timestamp.
pub fn build_test_page(printer_name: &str, paper: PaperWidth, now: &str) -> Vec<PageLine> {
    let rule = "-".repeat(match paper {
        PaperWidth::Mm58 => 24,
        PaperWidth::Mm80 => 32,
    });

    vec![
        PageLine::new("BREADEE", LineStyle::Title, Direction::Auto),
        PageLine::new("Native Printer Test", LineStyle::Body, Direction::Auto),
        PageLine::new(rule.clone(), LineStyle::Rule, Direction::Auto),
        PageLine::new("Printer", LineStyle::Heading, Direction::Auto),
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
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> Vec<PageLine> {
        build_test_page("Star TSP100", PaperWidth::Mm80, "2026-08-11 10:00")
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

    #[test]
    fn the_rule_narrows_with_the_paper() {
        let narrow = build_test_page("P", PaperWidth::Mm58, "t");
        let wide = build_test_page("P", PaperWidth::Mm80, "t");
        let width_of = |p: &[PageLine]| p.iter().find(|l| l.style == LineStyle::Rule).unwrap().text.len();
        assert!(width_of(&narrow) < width_of(&wide));
    }

    #[test]
    fn the_printer_name_is_reproduced_verbatim() {
        // Windows printer names contain spaces, punctuation and sometimes
        // non-ASCII. The page shows what was actually targeted.
        let odd = "HP LaserJet Pro M404-dn (Ahmad's desk)";
        let lines = build_test_page(odd, PaperWidth::Mm58, "t");
        assert!(lines.iter().any(|l| l.text == odd));
    }
}
