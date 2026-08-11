//! The cashier receipt: document model, validation, and layout.
//!
//! PURE AND PLATFORM-INDEPENDENT, like `page.rs`. The layout is a `Vec<PageLine>`
//! that the existing GDI renderer already knows how to draw, so this file adds a
//! document - not a second printing path. Every rule below is therefore testable
//! on a machine with no printer, which is the only way the wrapping, the totals
//! and the Arabic handling get checked at all before paper is involved.
//!
//! WHAT THIS FILE REFUSES TO INVENT. A receipt is a financial document, and the
//! fastest way to make one untrustworthy is to compute something on it. Every
//! figure here arrives already decided by the server and is only formatted.
//! There is no tax line, no service charge, no receipt sequence number and no
//! rounding: none of those exist authoritatively in this system, and printing a
//! plausible-looking one would be inventing a record.
//!
//! TENDERED AND CHANGE ARE CONDITIONAL, AND THAT IS THE POINT. They are captured
//! at the till during a live payment and are stored nowhere. A reprint of last
//! week's order genuinely does not know what the customer handed over, so those
//! lines are rendered only when the caller actually has them - see Level 3D,
//! which already nulls them on the historical path.

use serde::{Deserialize, Serialize};

use super::page::{Direction, LineStyle, PageLine};
use super::types::{PaperWidth, PrintError};

/// Bounds on what may cross the native boundary.
///
/// Not arbitrary tidiness: these strings are handed to a Win32 text engine and
/// drawn in a loop, so a caller sending a megabyte item name would be asking the
/// print spooler to chew through it. The limits are far above any real menu.
pub const MAX_TEXT: usize = 200;
pub const MAX_NOTE: usize = 500;
pub const MAX_LINES: usize = 200;
pub const MAX_MODIFIERS: usize = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiptModifier {
    pub name: String,
    #[serde(default)]
    pub price_delta: f64,
    #[serde(default)]
    pub quantity: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptLine {
    pub name: String,
    pub qty: f64,
    #[serde(default)]
    pub line_total: f64,
    #[serde(default)]
    pub modifiers: Vec<ReceiptModifier>,
    #[serde(default)]
    pub note: Option<String>,
}

/// The receipt, mirroring the desktop's existing `ReceiptData`.
///
/// Deliberately the SAME shape the on-screen preview already uses, so the paper
/// and the screen cannot drift apart: one builder, one document, two renderers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptDoc {
    pub business_name: String,
    pub branch_name: String,
    #[serde(default)]
    pub staff_name: Option<String>,
    pub order_number: String,
    pub order_type: String,
    pub at: String,
    #[serde(default)]
    pub paid: bool,
    #[serde(default)]
    pub method: Option<String>,
    pub currency: String,
    pub lines: Vec<ReceiptLine>,
    #[serde(default)]
    pub subtotal: f64,
    #[serde(default)]
    pub discount: f64,
    #[serde(default)]
    pub total: f64,
    // --- cash handling: present ONLY during a live payment ------------------
    #[serde(default)]
    pub tender_currency: Option<String>,
    #[serde(default)]
    pub tender_total: Option<f64>,
    #[serde(default)]
    pub tendered: Option<f64>,
    #[serde(default)]
    pub change: Option<f64>,
    // --- route identity -----------------------------------------------------
    #[serde(default)]
    pub shift_ref: Option<String>,
    #[serde(default)]
    pub table_name: Option<String>,
    #[serde(default)]
    pub seats: Option<f64>,
    #[serde(default)]
    pub customer_name: Option<String>,
    #[serde(default)]
    pub customer_phone: Option<String>,
    #[serde(default)]
    pub delivery_address: Option<String>,
}

fn too_long(value: &str, limit: usize) -> bool {
    value.chars().count() > limit
}

/// Reject a document this renderer should not be asked to draw.
pub fn validate_receipt(doc: &ReceiptDoc) -> Result<(), PrintError> {
    let invalid = |detail: &str| PrintError::InvalidReceipt { detail: detail.to_string() };

    if doc.lines.is_empty() {
        // A receipt with no items is not a receipt. Refusing here is kinder
        // than printing a page with a total and nothing to explain it.
        return Err(invalid("the receipt has no items"));
    }
    if doc.lines.len() > MAX_LINES {
        return Err(invalid("the receipt has too many lines"));
    }
    for field in [&doc.business_name, &doc.branch_name, &doc.order_number, &doc.order_type, &doc.currency] {
        if too_long(field, MAX_TEXT) {
            return Err(invalid("a receipt heading is too long"));
        }
    }
    if doc.delivery_address.as_deref().is_some_and(|a| too_long(a, MAX_NOTE)) {
        return Err(invalid("the delivery address is too long"));
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

/// Format money the way the on-screen receipt does.
///
/// USD to two decimals; LBP has no minor unit in practice and is printed whole
/// with thousands separators, which is how prices are written and read here. A
/// receipt showing "150000" instead of "150,000" is technically correct and
/// practically unreadable at a till.
pub fn format_money(amount: f64, currency: &str) -> String {
    if currency.eq_ignore_ascii_case("LBP") {
        let rounded = amount.round().abs() as i64;
        let sign = if amount < 0.0 { "-" } else { "" };
        let digits = rounded.to_string();
        let mut grouped = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(c);
        }
        return format!("{sign}{grouped} LBP");
    }
    format!("{amount:.2} {currency}")
}

/// Quantities print as integers when they are whole, which they almost always
/// are. "2x" reads better than "2.00x" and takes less of a narrow roll.
fn format_qty(qty: f64) -> String {
    if (qty - qty.round()).abs() < f64::EPSILON {
        format!("{}", qty.round() as i64)
    } else {
        format!("{qty}")
    }
}

/// Does this string contain Arabic script?
///
/// Used only to decide paragraph DIRECTION. Latin text laid out right-to-left
/// looks wrong, and Arabic laid out left-to-right looks wrong; the engine does
/// the shaping either way, but it needs to be told which edge the paragraph
/// starts from.
fn is_rtl(text: &str) -> bool {
    text.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c) || ('\u{0750}'..='\u{077F}').contains(&c))
}

fn direction_for(text: &str) -> Direction {
    if is_rtl(text) { Direction::Rtl } else { Direction::Auto }
}

fn rule(paper: PaperWidth) -> String {
    "-".repeat(match paper {
        PaperWidth::Mm58 => 24,
        PaperWidth::Mm80 => 32,
    })
}

/// Lay the receipt out.
///
/// Order is fixed and mirrors the on-screen preview: who and where, what the
/// order is, when and by whom, what was bought, what it came to, how it was
/// paid. An operator comparing paper against the screen should not have to
/// hunt.
pub fn build_receipt_page(doc: &ReceiptDoc, paper: PaperWidth) -> Vec<PageLine> {
    let mut out: Vec<PageLine> = Vec::new();
    let divider = rule(paper);

    // --- header -------------------------------------------------------------
    out.push(PageLine::new(&doc.business_name, LineStyle::Title, direction_for(&doc.business_name)));
    if !doc.branch_name.is_empty() {
        out.push(PageLine::new(&doc.branch_name, LineStyle::Small, direction_for(&doc.branch_name)));
    }
    out.push(PageLine::new(divider.clone(), LineStyle::Rule, Direction::Auto));

    // --- order identity -----------------------------------------------------
    out.push(PageLine::pair(
        &doc.order_type,
        format!("#{}", doc.order_number),
        LineStyle::Body,
        Direction::Auto,
    ));

    // Dine-in: the tenant's STORED table name, verbatim. Never prefixed with
    // "Table" - a tenant may already call it "Table 5", and m256 produced
    // "Table Table 4" on a real receipt by decorating it.
    if let Some(table) = doc.table_name.as_deref().filter(|t| !t.is_empty()) {
        let seats = doc.seats.map(|s| format!("{} seats", format_qty(s))).unwrap_or_default();
        out.push(PageLine::pair(table, seats, LineStyle::Body, direction_for(table)));
    }

    // Delivery: who the food is for and where it goes - the two things a
    // delivery receipt exists to carry.
    if let Some(name) = doc.customer_name.as_deref().filter(|n| !n.is_empty()) {
        out.push(PageLine::pair(
            name,
            doc.customer_phone.clone().unwrap_or_default(),
            LineStyle::Body,
            direction_for(name),
        ));
    }
    if let Some(address) = doc.delivery_address.as_deref().filter(|a| !a.is_empty()) {
        out.push(PageLine::new(address, LineStyle::Small, direction_for(address)));
    }

    // --- when and who -------------------------------------------------------
    out.push(PageLine::pair(
        &doc.at,
        doc.staff_name.clone().unwrap_or_default(),
        LineStyle::Small,
        Direction::Auto,
    ));
    out.push(PageLine::new(divider.clone(), LineStyle::Rule, Direction::Auto));

    // --- items --------------------------------------------------------------
    for line in &doc.lines {
        out.push(PageLine::pair(
            format!("{}x {}", format_qty(line.qty), line.name),
            format_money(line.line_total, &doc.currency),
            LineStyle::Body,
            direction_for(&line.name),
        ));
        for m in &line.modifiers {
            let count = if m.quantity > 1.0 { format!("{} x ", format_qty(m.quantity)) } else { String::new() };
            let amount = if m.price_delta != 0.0 {
                format_money(m.price_delta, &doc.currency)
            } else {
                String::new()
            };
            out.push(PageLine::pair(
                format!("  + {count}{}", m.name),
                amount,
                LineStyle::Small,
                direction_for(&m.name),
            ));
        }
        if let Some(note) = line.note.as_deref().filter(|n| !n.is_empty()) {
            out.push(PageLine::new(format!("  {note}"), LineStyle::Small, direction_for(note)));
        }
    }

    out.push(PageLine::new(divider.clone(), LineStyle::Rule, Direction::Auto));

    // --- money --------------------------------------------------------------
    out.push(PageLine::pair(
        "Subtotal",
        format_money(doc.subtotal, &doc.currency),
        LineStyle::Body,
        Direction::Auto,
    ));
    if doc.discount > 0.0 {
        out.push(PageLine::pair(
            "Discount",
            format!("-{}", format_money(doc.discount, &doc.currency)),
            LineStyle::Body,
            Direction::Auto,
        ));
    }
    out.push(PageLine::pair(
        "TOTAL",
        format_money(doc.total, &doc.currency),
        LineStyle::Total,
        Direction::Auto,
    ));

    // A different tender currency is real information: the customer paid LBP
    // against a USD total, and the paper should say what was actually charged.
    if let (Some(tc), Some(tt)) = (doc.tender_currency.as_deref(), doc.tender_total) {
        if !tc.eq_ignore_ascii_case(&doc.currency) {
            out.push(PageLine::pair(
                format!("Charged in {tc}"),
                format_money(tt, tc),
                LineStyle::Small,
                Direction::Auto,
            ));
        }
    }

    // --- cash handling, only when it genuinely exists ------------------------
    if let (Some(tendered), Some(tc)) = (doc.tendered, doc.tender_currency.as_deref()) {
        out.push(PageLine::pair("Tendered", format_money(tendered, tc), LineStyle::Small, Direction::Auto));
        out.push(PageLine::pair(
            "Change",
            format_money(doc.change.unwrap_or(0.0), tc),
            LineStyle::Small,
            Direction::Auto,
        ));
    }

    // --- payment ------------------------------------------------------------
    let status = if doc.paid {
        format!("Paid - {}", doc.method.as_deref().unwrap_or("cash"))
    } else {
        "Unpaid".to_string()
    };
    out.push(PageLine::pair(status, doc.currency.clone(), LineStyle::Body, Direction::Auto));
    if let Some(shift) = doc.shift_ref.as_deref().filter(|s| !s.is_empty()) {
        out.push(PageLine::new(format!("Shift {shift}"), LineStyle::Small, Direction::Auto));
    }

    out.push(PageLine::new(divider, LineStyle::Rule, Direction::Auto));
    out.push(PageLine::new("Thank you!", LineStyle::Small, Direction::Auto));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(name: &str, qty: f64, total: f64) -> ReceiptLine {
        ReceiptLine { name: name.into(), qty, line_total: total, modifiers: vec![], note: None }
    }

    fn doc() -> ReceiptDoc {
        ReceiptDoc {
            business_name: "Dominos Pizza".into(),
            branch_name: "Main Branch".into(),
            staff_name: Some("Cashier".into()),
            order_number: "260809-0001".into(),
            order_type: "Delivery".into(),
            at: "8/9/2026, 8:12:54 PM".into(),
            paid: true,
            method: Some("cash".into()),
            currency: "USD".into(),
            lines: vec![line("Margherita", 1.0, 7.0)],
            subtotal: 7.0,
            discount: 0.0,
            total: 7.0,
            tender_currency: None,
            tender_total: None,
            tendered: None,
            change: None,
            shift_ref: None,
            table_name: None,
            seats: None,
            customer_name: None,
            customer_phone: None,
            delivery_address: None,
        }
    }

    fn texts(lines: &[PageLine]) -> Vec<String> {
        lines.iter().map(|l| l.text.clone()).collect()
    }

    fn rights(lines: &[PageLine]) -> Vec<String> {
        lines.iter().filter_map(|l| l.right.clone()).collect()
    }

    #[test]
    fn a_receipt_carries_the_business_branch_order_and_time() {
        let p = build_receipt_page(&doc(), PaperWidth::Mm80);
        let t = texts(&p);
        assert!(t.contains(&"Dominos Pizza".to_string()));
        assert!(t.contains(&"Main Branch".to_string()));
        assert!(t.contains(&"Delivery".to_string()));
        assert!(rights(&p).contains(&"#260809-0001".to_string()));
        assert!(t.contains(&"8/9/2026, 8:12:54 PM".to_string()));
    }

    #[test]
    fn items_carry_quantity_name_and_amount() {
        let p = build_receipt_page(&doc(), PaperWidth::Mm80);
        assert!(texts(&p).contains(&"1x Margherita".to_string()));
        assert!(rights(&p).contains(&"7.00 USD".to_string()));
    }

    #[test]
    fn modifiers_and_notes_hang_under_their_item() {
        let mut d = doc();
        d.lines[0].modifiers = vec![ReceiptModifier { name: "Small".into(), price_delta: 0.0, quantity: 1.0 }];
        d.lines[0].note = Some("No olives".into());
        let p = build_receipt_page(&d, PaperWidth::Mm80);
        let t = texts(&p);
        let item = t.iter().position(|x| x.contains("Margherita")).unwrap();
        let modifier = t.iter().position(|x| x.contains("Small")).unwrap();
        let note = t.iter().position(|x| x.contains("No olives")).unwrap();
        assert!(item < modifier && modifier < note, "modifier and note must follow the item");
        // A zero price delta prints no amount - "+ Small  0.00" is noise.
        let modifier_line = &p[modifier];
        assert_eq!(modifier_line.right.as_deref(), Some(""));
    }

    #[test]
    fn a_priced_modifier_shows_its_amount() {
        let mut d = doc();
        d.lines[0].modifiers = vec![ReceiptModifier { name: "Extra cheese".into(), price_delta: 0.5, quantity: 1.0 }];
        let p = build_receipt_page(&d, PaperWidth::Mm80);
        assert!(rights(&p).contains(&"0.50 USD".to_string()));
    }

    #[test]
    fn totals_run_subtotal_discount_total() {
        let mut d = doc();
        d.subtotal = 10.0;
        d.discount = 2.0;
        d.total = 8.0;
        let p = build_receipt_page(&d, PaperWidth::Mm80);
        let t = texts(&p);
        assert!(t.contains(&"Subtotal".to_string()));
        assert!(t.contains(&"Discount".to_string()));
        assert!(t.contains(&"TOTAL".to_string()));
        assert!(rights(&p).contains(&"-2.00 USD".to_string()));
        // The total is the figure the customer looks for.
        let total = p.iter().find(|l| l.text == "TOTAL").unwrap();
        assert_eq!(total.style, LineStyle::Total);
        assert_eq!(total.right.as_deref(), Some("8.00 USD"));
    }

    #[test]
    fn a_zero_discount_prints_no_discount_line() {
        let p = build_receipt_page(&doc(), PaperWidth::Mm80);
        assert!(!texts(&p).contains(&"Discount".to_string()));
    }

    #[test]
    fn tendered_and_change_print_only_when_the_caller_has_them() {
        // Live payment: both present.
        let mut live = doc();
        live.tender_currency = Some("USD".into());
        live.tendered = Some(10.0);
        live.change = Some(3.0);
        let t = texts(&build_receipt_page(&live, PaperWidth::Mm80));
        assert!(t.contains(&"Tendered".to_string()));
        assert!(t.contains(&"Change".to_string()));

        // Historical reprint: neither is known, so neither is invented.
        let t = texts(&build_receipt_page(&doc(), PaperWidth::Mm80));
        assert!(!t.contains(&"Tendered".to_string()));
        assert!(!t.contains(&"Change".to_string()));
    }

    #[test]
    fn a_different_tender_currency_is_stated() {
        let mut d = doc();
        d.tender_currency = Some("LBP".into());
        d.tender_total = Some(626_500.0);
        let p = build_receipt_page(&d, PaperWidth::Mm80);
        assert!(texts(&p).contains(&"Charged in LBP".to_string()));
        assert!(rights(&p).contains(&"626,500 LBP".to_string()));
    }

    #[test]
    fn the_same_tender_currency_adds_no_noise() {
        let mut d = doc();
        d.tender_currency = Some("USD".into());
        d.tender_total = Some(7.0);
        assert!(!texts(&build_receipt_page(&d, PaperWidth::Mm80)).contains(&"Charged in USD".to_string()));
    }

    #[test]
    fn lbp_is_grouped_and_usd_has_two_decimals() {
        assert_eq!(format_money(7.0, "USD"), "7.00 USD");
        assert_eq!(format_money(626500.0, "LBP"), "626,500 LBP");
        assert_eq!(format_money(1000.0, "LBP"), "1,000 LBP");
        assert_eq!(format_money(999.0, "LBP"), "999 LBP");
        assert_eq!(format_money(-2.5, "USD"), "-2.50 USD");
    }

    #[test]
    fn payment_status_reflects_paid_and_unpaid() {
        let p = build_receipt_page(&doc(), PaperWidth::Mm80);
        assert!(texts(&p).iter().any(|t| t == "Paid - cash"));
        let mut unpaid = doc();
        unpaid.paid = false;
        unpaid.method = None;
        assert!(texts(&build_receipt_page(&unpaid, PaperWidth::Mm80)).iter().any(|t| t == "Unpaid"));
    }

    #[test]
    fn the_dine_in_table_name_is_printed_verbatim() {
        // m256: prefixing produced "Table Table 4" on a real receipt.
        let mut d = doc();
        d.order_type = "Dine-in".into();
        d.table_name = Some("Table 4".into());
        d.seats = Some(2.0);
        let p = build_receipt_page(&d, PaperWidth::Mm80);
        assert!(texts(&p).contains(&"Table 4".to_string()));
        assert!(!texts(&p).iter().any(|t| t.contains("Table Table")));
        assert!(rights(&p).contains(&"2 seats".to_string()));
    }

    #[test]
    fn delivery_identity_is_carried() {
        let mut d = doc();
        d.customer_name = Some("Desktop Level 3A QA".into());
        d.customer_phone = Some("03 111 999".into());
        d.delivery_address = Some("QA, Hamra, QA Street 2".into());
        let p = build_receipt_page(&d, PaperWidth::Mm80);
        assert!(texts(&p).contains(&"Desktop Level 3A QA".to_string()));
        assert!(rights(&p).contains(&"03 111 999".to_string()));
        assert!(texts(&p).contains(&"QA, Hamra, QA Street 2".to_string()));
    }

    #[test]
    fn arabic_content_is_laid_out_right_to_left() {
        let mut d = doc();
        d.lines = vec![line("بيتزا مارغريتا", 1.0, 7.0)];
        d.customer_name = Some("أحمد".into());
        let p = build_receipt_page(&d, PaperWidth::Mm80);
        let arabic_item = p.iter().find(|l| l.text.contains("مارغريتا")).unwrap();
        assert_eq!(arabic_item.direction, Direction::Rtl);
        let customer = p.iter().find(|l| l.text.contains("أحمد")).unwrap();
        assert_eq!(customer.direction, Direction::Rtl);
    }

    #[test]
    fn latin_content_stays_engine_decided() {
        let p = build_receipt_page(&doc(), PaperWidth::Mm80);
        let item = p.iter().find(|l| l.text.contains("Margherita")).unwrap();
        assert_eq!(item.direction, Direction::Auto);
    }

    #[test]
    fn a_mixed_item_name_is_treated_as_right_to_left() {
        // "بيتزا Margherita" starts in Arabic; the engine reorders the Latin run.
        let mut d = doc();
        d.lines = vec![line("بيتزا Margherita", 1.0, 7.0)];
        let p = build_receipt_page(&d, PaperWidth::Mm80);
        assert_eq!(p.iter().find(|l| l.text.contains("Margherita")).unwrap().direction, Direction::Rtl);
    }

    #[test]
    fn the_rule_narrows_with_the_paper() {
        let narrow = build_receipt_page(&doc(), PaperWidth::Mm58);
        let wide = build_receipt_page(&doc(), PaperWidth::Mm80);
        let width = |p: &[PageLine]| p.iter().find(|l| l.style == LineStyle::Rule).unwrap().text.len();
        assert!(width(&narrow) < width(&wide));
    }

    #[test]
    fn both_widths_produce_the_same_information() {
        // Layout differs; content must not. A 58mm receipt that quietly drops
        // the delivery address would be a different document.
        let mut d = doc();
        d.delivery_address = Some("QA, Hamra".into());
        let narrow: Vec<String> = texts(&build_receipt_page(&d, PaperWidth::Mm58))
            .into_iter()
            .filter(|t| !t.starts_with('-'))
            .collect();
        let wide: Vec<String> = texts(&build_receipt_page(&d, PaperWidth::Mm80))
            .into_iter()
            .filter(|t| !t.starts_with('-'))
            .collect();
        assert_eq!(narrow, wide);
    }

    #[test]
    fn quantities_print_as_whole_numbers_when_they_are_whole() {
        assert_eq!(format_qty(1.0), "1");
        assert_eq!(format_qty(12.0), "12");
        assert_eq!(format_qty(1.5), "1.5");
    }

    #[test]
    fn an_empty_receipt_is_refused() {
        let mut d = doc();
        d.lines.clear();
        assert!(matches!(validate_receipt(&d), Err(PrintError::InvalidReceipt { .. })));
    }

    #[test]
    fn pathological_input_is_refused_before_it_reaches_the_spooler() {
        let long = "x".repeat(MAX_TEXT + 1);

        let mut d = doc();
        d.lines[0].name = long.clone();
        assert!(matches!(validate_receipt(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.business_name = long.clone();
        assert!(matches!(validate_receipt(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.lines[0].note = Some("y".repeat(MAX_NOTE + 1));
        assert!(matches!(validate_receipt(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.lines = (0..MAX_LINES + 1).map(|_| line("Item", 1.0, 1.0)).collect();
        assert!(matches!(validate_receipt(&d), Err(PrintError::InvalidReceipt { .. })));

        let mut d = doc();
        d.lines[0].modifiers = (0..MAX_MODIFIERS + 1)
            .map(|_| ReceiptModifier { name: "M".into(), price_delta: 0.0, quantity: 1.0 })
            .collect();
        assert!(matches!(validate_receipt(&d), Err(PrintError::InvalidReceipt { .. })));
    }

    #[test]
    fn a_realistic_receipt_validates() {
        assert!(validate_receipt(&doc()).is_ok());
    }

    #[test]
    fn the_receipt_invents_no_fiscal_fields() {
        let mut d = doc();
        d.delivery_address = Some("QA, Hamra".into());
        let joined = texts(&build_receipt_page(&d, PaperWidth::Mm80)).join(" ").to_lowercase();
        for invented in ["vat", "tax", "service charge", "invoice no", "fiscal", "receipt no"] {
            assert!(!joined.contains(invented), "the receipt must not invent {invented:?}");
        }
    }
}
