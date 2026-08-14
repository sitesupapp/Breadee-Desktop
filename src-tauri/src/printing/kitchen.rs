//! The kitchen ticket: document model, validation, and layout.
//!
//! PURE AND PLATFORM-INDEPENDENT, like `page.rs` and `receipt.rs`. It produces a
//! `Vec<PageLine>` for the existing GDI renderer, so this is a third DOCUMENT and
//! not a third printing path.
//!
//! A KITCHEN TICKET IS NOT A RECEIPT WITH THE PRICES REMOVED. The two documents
//! answer different questions and are read by different people under different
//! pressure. A receipt is a financial record a customer keeps; a ticket is a work
//! order a cook reads at arm's length in a hot room, one line at a time. So the
//! layout is built for that reading:
//!
//!   * NO MONEY AT ALL. No unit price, no line total, no subtotal, no discount,
//!     no total, no payment status, no currency. A cook has no decision that
//!     depends on any of them, and a price on a ticket is one more thing to
//!     misread as a quantity. `KitchenTicketDoc` has no monetary field to print,
//!     so this is a property of the type rather than a discipline of the layout.
//!   * QUANTITY IS THE LOUDEST THING ON THE PAGE. It is drawn at `Total` weight -
//!     the same emphasis the receipt gives the one figure a customer looks for -
//!     because "2x" misread as "1x" is the error that actually happens.
//!   * MODIFIERS AND NOTES BELONG TO THEIR ITEM, and print under it. A note that
//!     drifts to the bottom of a ticket is a note the cook attaches to the wrong
//!     dish.
//!
//! WHAT IT REFUSES TO INVENT, exactly as the receipt does: nothing here computes,
//! summarises or reorders. The lines arrive in the order they were sent and are
//! only formatted.

use serde::{Deserialize, Serialize};

use super::page::{Direction, LineStyle, PageLine};
use super::receipt::{MAX_LINES, MAX_MODIFIERS, MAX_NOTE, MAX_TEXT};
use super::types::{PaperWidth, PrintError};

/// Printed when the ticket is a rehearsal rather than a real order.
///
/// The same banner the diagnostic page carries, and for the same reason: a
/// ticket-shaped page found on a pass gets cooked.
pub const NOT_A_REAL_ORDER: &str = "TEST PRINT - NOT A REAL ORDER";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KitchenModifier {
    pub name: String,
    /// How many of this modifier. `price_delta` is deliberately ABSENT from this
    /// type - see the module note about money.
    #[serde(default)]
    pub quantity: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitchenLine {
    pub name: String,
    pub qty: f64,
    #[serde(default)]
    pub modifiers: Vec<KitchenModifier>,
    /// The item's kitchen note - the field the cook is most likely to be looking
    /// for and the one most easily lost.
    #[serde(default)]
    pub note: Option<String>,
}

/// One kitchen ticket.
///
/// `lines` is the BATCH that was just submitted, never the whole bill. For a
/// dine-in table that distinction is the entire feature: reprinting round 1
/// alongside round 2 makes the kitchen cook the first round twice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitchenTicketDoc {
    pub business_name: String,
    pub branch_name: String,
    #[serde(default)]
    pub staff_name: Option<String>,
    pub order_number: String,
    /// "Takeaway", "Dine-In", "Delivery" - display wording, printed verbatim.
    pub order_type: String,
    pub at: String,
    /// Dine-in only: the tenant's STORED table name, printed verbatim. Never
    /// prefixed with "Table" - m256 produced "Table Table 4" on a real receipt
    /// by decorating it, and the same trap is here.
    #[serde(default)]
    pub table_name: Option<String>,
    /// Dine-in only: which round this batch is, in the server's own numbering.
    #[serde(default)]
    pub batch_label: Option<String>,
    /// Delivery only: who the food is for. No address and no phone - a cook does
    /// not deliver, and a customer's address on a ticket left on a pass is
    /// personal data with no operational purpose.
    #[serde(default)]
    pub customer_name: Option<String>,
    /// The order-level note, separate from the per-item ones.
    #[serde(default)]
    pub order_note: Option<String>,
    pub lines: Vec<KitchenLine>,
    /// True for a rehearsal ticket, which prints the NOT-A-REAL-ORDER banner.
    #[serde(default)]
    pub test: bool,
}

fn too_long(value: &str, limit: usize) -> bool {
    value.chars().count() > limit
}

/// Reject a ticket this renderer should not be asked to draw.
///
/// The same bounds as the receipt, deliberately: both are handed to the same
/// Win32 text engine and drawn in the same loop, so a limit that differed
/// between them would be an accident rather than a decision.
pub fn validate_kitchen_ticket(doc: &KitchenTicketDoc) -> Result<(), PrintError> {
    let invalid = |detail: &str| PrintError::InvalidReceipt { detail: detail.to_string() };

    if doc.lines.is_empty() {
        // A ticket with no items tells the kitchen to cook nothing, which is
        // indistinguishable from a printer fault. Refuse it here.
        return Err(invalid("the kitchen ticket has no items"));
    }
    if doc.lines.len() > MAX_LINES {
        return Err(invalid("the kitchen ticket has too many lines"));
    }
    for field in [&doc.business_name, &doc.branch_name, &doc.order_number, &doc.order_type] {
        if too_long(field, MAX_TEXT) {
            return Err(invalid("a kitchen ticket heading is too long"));
        }
    }
    if doc.order_note.as_deref().is_some_and(|n| too_long(n, MAX_NOTE)) {
        return Err(invalid("the order note is too long"));
    }
    for line in &doc.lines {
        if too_long(&line.name, MAX_TEXT) {
            return Err(invalid("an item name is too long"));
        }
        if line.modifiers.len() > MAX_MODIFIERS {
            return Err(invalid("an item has too many modifiers"));
        }
        if line.note.as_deref().is_some_and(|n| too_long(n, MAX_NOTE)) {
            return Err(invalid("an item note is too long"));
        }
        for m in &line.modifiers {
            if too_long(&m.name, MAX_TEXT) {
                return Err(invalid("a modifier name is too long"));
            }
        }
    }
    Ok(())
}

/// Quantities print as integers when they are whole. Same rule as the receipt.
fn format_qty(qty: f64) -> String {
    if (qty - qty.round()).abs() < f64::EPSILON {
        format!("{}", qty.round() as i64)
    } else {
        format!("{qty}")
    }
}

fn is_rtl(text: &str) -> bool {
    text.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c) || ('\u{0750}'..='\u{077F}').contains(&c))
}

fn direction_for(text: &str) -> Direction {
    if is_rtl(text) { Direction::Rtl } else { Direction::Auto }
}

/// The divider, sized to the roll by the one shared rule.
fn rule(paper: PaperWidth) -> String {
    "-".repeat(super::page::rule_chars(paper))
}

/// Lay the kitchen ticket out.
///
/// Order is fixed: what kind of work this is, which order and round, when and
/// for whom, then the items. A cook scanning a spike of tickets reads the top
/// three lines to find the right one and never reads further.
pub fn build_kitchen_page(doc: &KitchenTicketDoc, paper: PaperWidth) -> Vec<PageLine> {
    let mut out: Vec<PageLine> = Vec::new();
    let divider = rule(paper);

    // --- header -------------------------------------------------------------
    // "KITCHEN" first and largest. The business name is secondary here - unlike
    // on a receipt, the reader already knows which restaurant they are standing
    // in, and what they need to know at a glance is that this is a work order.
    out.push(PageLine::new("KITCHEN", LineStyle::Title, Direction::Auto));
    if doc.test {
        out.push(PageLine::new(NOT_A_REAL_ORDER, LineStyle::Body, Direction::Auto));
    }
    if !doc.business_name.is_empty() {
        out.push(PageLine::new(&doc.business_name, LineStyle::Small, direction_for(&doc.business_name)));
    }
    if !doc.branch_name.is_empty() {
        out.push(PageLine::new(&doc.branch_name, LineStyle::Small, direction_for(&doc.branch_name)));
    }
    out.push(PageLine::new(divider.clone(), LineStyle::Rule, Direction::Auto));

    // --- order identity -----------------------------------------------------
    out.push(PageLine::pair(
        &doc.order_type,
        format!("#{}", doc.order_number),
        LineStyle::Heading,
        Direction::Auto,
    ));

    // Table and round sit together: for a dine-in cook they are one fact -
    // "the second round for table 4".
    if let Some(table) = doc.table_name.as_deref().filter(|t| !t.is_empty()) {
        out.push(PageLine::pair(
            table,
            doc.batch_label.clone().unwrap_or_default(),
            LineStyle::Heading,
            direction_for(table),
        ));
    } else if let Some(batch) = doc.batch_label.as_deref().filter(|b| !b.is_empty()) {
        out.push(PageLine::new(batch, LineStyle::Heading, Direction::Auto));
    }

    if let Some(name) = doc.customer_name.as_deref().filter(|n| !n.is_empty()) {
        out.push(PageLine::new(name, LineStyle::Body, direction_for(name)));
    }

    out.push(PageLine::pair(
        &doc.at,
        doc.staff_name.clone().unwrap_or_default(),
        LineStyle::Small,
        Direction::Auto,
    ));

    // The order note is prep instruction for the whole ticket, so it goes ABOVE
    // the items rather than after them - a cook who has already started the
    // first dish has read it too late.
    if let Some(note) = doc.order_note.as_deref().filter(|n| !n.is_empty()) {
        out.push(PageLine::new(divider.clone(), LineStyle::Rule, Direction::Auto));
        out.push(PageLine::new(note, LineStyle::Body, direction_for(note)));
    }

    out.push(PageLine::new(divider.clone(), LineStyle::Rule, Direction::Auto));

    // --- items --------------------------------------------------------------
    // No right-hand column anywhere below: there is no money, and an empty money
    // column would just invite someone to fill it.
    for line in &doc.lines {
        out.push(PageLine::new(
            format!("{}x {}", format_qty(line.qty), line.name),
            LineStyle::Total,
            direction_for(&line.name),
        ));
        for m in &line.modifiers {
            let count = if m.quantity > 1.0 { format!("{} x ", format_qty(m.quantity)) } else { String::new() };
            out.push(PageLine::new(
                format!("  + {count}{}", m.name),
                LineStyle::Body,
                direction_for(&m.name),
            ));
        }
        if let Some(note) = line.note.as_deref().filter(|n| !n.is_empty()) {
            // Body weight, not Small: the note is the instruction, and shrinking
            // it is how "no olives" gets missed.
            out.push(PageLine::new(format!("  {note}"), LineStyle::Body, direction_for(note)));
        }
    }

    out.push(PageLine::new(divider, LineStyle::Rule, Direction::Auto));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(name: &str, qty: f64) -> KitchenLine {
        KitchenLine { name: name.into(), qty, modifiers: vec![], note: None }
    }

    fn doc() -> KitchenTicketDoc {
        KitchenTicketDoc {
            business_name: "Dominos Pizza".into(),
            branch_name: "Main Branch".into(),
            staff_name: Some("Cashier".into()),
            order_number: "260814-0001".into(),
            order_type: "Takeaway".into(),
            at: "8/14/2026, 11:20:00 AM".into(),
            table_name: None,
            batch_label: None,
            customer_name: None,
            order_note: None,
            lines: vec![line("Margherita", 1.0)],
            test: false,
        }
    }

    fn texts(lines: &[PageLine]) -> Vec<String> {
        lines.iter().map(|l| l.text.clone()).collect()
    }

    #[test]
    fn a_ticket_says_it_is_a_kitchen_ticket_first() {
        let p = build_kitchen_page(&doc(), PaperWidth::Mm80);
        assert_eq!(p[0].text, "KITCHEN");
        assert_eq!(p[0].style, LineStyle::Title);
    }

    #[test]
    fn a_ticket_carries_the_order_source_number_and_time() {
        let p = build_kitchen_page(&doc(), PaperWidth::Mm80);
        let t = texts(&p);
        assert!(t.contains(&"Takeaway".to_string()));
        assert!(p.iter().filter_map(|l| l.right.clone()).any(|r| r == "#260814-0001"));
        assert!(t.contains(&"8/14/2026, 11:20:00 AM".to_string()));
    }

    #[test]
    fn items_carry_quantity_name_modifiers_and_notes() {
        let mut d = doc();
        d.lines[0].modifiers = vec![KitchenModifier { name: "Small".into(), quantity: 1.0 }];
        d.lines[0].note = Some("No olives".into());
        let p = build_kitchen_page(&d, PaperWidth::Mm80);
        let t = texts(&p);
        let item = t.iter().position(|x| x.contains("Margherita")).unwrap();
        let modifier = t.iter().position(|x| x.contains("Small")).unwrap();
        let note = t.iter().position(|x| x.contains("No olives")).unwrap();
        assert!(item < modifier && modifier < note, "modifier and note must follow their item");
        assert!(t.contains(&"1x Margherita".to_string()));
    }

    #[test]
    fn the_quantity_line_is_the_loudest_thing_on_the_page() {
        let p = build_kitchen_page(&doc(), PaperWidth::Mm80);
        let item = p.iter().find(|l| l.text.contains("Margherita")).unwrap();
        assert_eq!(item.style, LineStyle::Total);
    }

    #[test]
    fn a_kitchen_ticket_carries_no_money_anywhere() {
        // The type has no monetary field, so the strongest statement available
        // is that nothing money-shaped reaches the page - including the empty
        // right-hand column a receipt uses for amounts.
        let mut d = doc();
        d.lines[0].modifiers = vec![KitchenModifier { name: "Extra cheese".into(), quantity: 1.0 }];
        d.lines[0].note = Some("No olives".into());
        d.order_note = Some("Ring the bell".into());
        d.customer_name = Some("Desktop Level 3A QA".into());
        let p = build_kitchen_page(&d, PaperWidth::Mm80);
        let joined = texts(&p).join(" ").to_lowercase();
        for money in ["total", "subtotal", "discount", "usd", "lbp", "paid", "unpaid", "change", "tendered", "$"] {
            assert!(!joined.contains(money), "a kitchen ticket must not mention {money:?}");
        }
        // Only the identity row uses a right-hand column; no item line does.
        for l in p.iter().filter(|l| l.text.contains('x') && l.style == LineStyle::Total) {
            assert!(l.right.is_none(), "an item line must have no amount column");
        }
    }

    #[test]
    fn the_dine_in_table_name_is_printed_verbatim_beside_its_round() {
        let mut d = doc();
        d.order_type = "Dine-In".into();
        d.table_name = Some("Table 4".into());
        d.batch_label = Some("Round 2".into());
        let p = build_kitchen_page(&d, PaperWidth::Mm80);
        assert!(texts(&p).contains(&"Table 4".to_string()));
        assert!(!texts(&p).iter().any(|t| t.contains("Table Table")));
        assert!(p.iter().filter_map(|l| l.right.clone()).any(|r| r == "Round 2"));
    }

    #[test]
    fn a_round_without_a_table_still_prints_its_round() {
        let mut d = doc();
        d.batch_label = Some("Round 2".into());
        assert!(texts(&build_kitchen_page(&d, PaperWidth::Mm80)).contains(&"Round 2".to_string()));
    }

    #[test]
    fn the_order_note_prints_above_the_items() {
        let mut d = doc();
        d.order_note = Some("Allergy: nuts".into());
        let t = texts(&build_kitchen_page(&d, PaperWidth::Mm80));
        let note = t.iter().position(|x| x.contains("Allergy")).unwrap();
        let item = t.iter().position(|x| x.contains("Margherita")).unwrap();
        assert!(note < item, "a whole-ticket instruction must be read before the first dish");
    }

    #[test]
    fn delivery_carries_the_customer_but_never_the_address() {
        let mut d = doc();
        d.order_type = "Delivery".into();
        d.customer_name = Some("Desktop Level 3A QA".into());
        let t = texts(&build_kitchen_page(&d, PaperWidth::Mm80));
        assert!(t.contains(&"Desktop Level 3A QA".to_string()));
        // There is no address field on the type at all; this pins the intent.
        assert!(!t.iter().any(|x| x.contains("Hamra") || x.contains("Street")));
    }

    #[test]
    fn a_test_ticket_says_so_and_a_real_one_does_not() {
        let mut d = doc();
        d.test = true;
        assert!(texts(&build_kitchen_page(&d, PaperWidth::Mm80)).contains(&NOT_A_REAL_ORDER.to_string()));
        assert!(!texts(&build_kitchen_page(&doc(), PaperWidth::Mm80)).contains(&NOT_A_REAL_ORDER.to_string()));
    }

    #[test]
    fn arabic_content_is_laid_out_right_to_left() {
        let mut d = doc();
        d.lines = vec![line("بيتزا مارغريتا", 1.0)];
        d.lines[0].note = Some("بدون زيتون".into());
        let p = build_kitchen_page(&d, PaperWidth::Mm80);
        assert_eq!(p.iter().find(|l| l.text.contains("مارغريتا")).unwrap().direction, Direction::Rtl);
        assert_eq!(p.iter().find(|l| l.text.contains("زيتون")).unwrap().direction, Direction::Rtl);
    }

    #[test]
    fn the_rule_narrows_with_the_paper_and_the_content_does_not() {
        let width = |p: &[PageLine]| p.iter().find(|l| l.style == LineStyle::Rule).unwrap().text.len();
        let narrow = build_kitchen_page(&doc(), PaperWidth::Mm58);
        let wide = build_kitchen_page(&doc(), PaperWidth::Mm80);
        assert!(width(&narrow) < width(&wide));

        let strip = |p: Vec<String>| p.into_iter().filter(|t| !t.starts_with('-')).collect::<Vec<_>>();
        assert_eq!(strip(texts(&narrow)), strip(texts(&wide)));
    }

    #[test]
    fn an_empty_ticket_is_refused() {
        let mut d = doc();
        d.lines.clear();
        assert!(matches!(validate_kitchen_ticket(&d), Err(PrintError::InvalidReceipt { .. })));
    }

    #[test]
    fn pathological_input_is_refused_before_it_reaches_the_spooler() {
        let long = "x".repeat(MAX_TEXT + 1);

        let mut d = doc();
        d.lines[0].name = long.clone();
        assert!(matches!(validate_kitchen_ticket(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.business_name = long;
        assert!(matches!(validate_kitchen_ticket(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.lines[0].note = Some("y".repeat(MAX_NOTE + 1));
        assert!(matches!(validate_kitchen_ticket(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.order_note = Some("y".repeat(MAX_NOTE + 1));
        assert!(matches!(validate_kitchen_ticket(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.lines = (0..MAX_LINES + 1).map(|_| line("Item", 1.0)).collect();
        assert!(matches!(validate_kitchen_ticket(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.lines[0].modifiers =
            (0..MAX_MODIFIERS + 1).map(|_| KitchenModifier { name: "M".into(), quantity: 1.0 }).collect();
        assert!(matches!(validate_kitchen_ticket(&d), Err(PrintError::InvalidReceipt { .. })));
    }

    #[test]
    fn a_realistic_ticket_validates() {
        assert!(validate_kitchen_ticket(&doc()).is_ok());
    }
}
