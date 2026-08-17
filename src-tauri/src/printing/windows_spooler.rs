//! Windows implementation: enumerate printers, and print through GDI.
//!
//! WHY GDI AND NOT RAW ESC/POS.
//!
//! The obvious way to drive a thermal printer is to open the spooler in RAW
//! mode and `WritePrinter` some ESC/POS. That is a trap for this product.
//! ESC/POS text mode selects glyphs from a codepage the printer holds in
//! firmware: there is no contextual shaping, no bidirectional reordering, and
//! no guarantee any Arabic page is present at all. Breadee runs in Lebanese
//! restaurants where a single line is routinely Arabic and English together, so
//! a path that renders Arabic as disconnected letters in reverse order is not a
//! cosmetic compromise - it is unusable.
//!
//! Printing through a device context instead hands the text to Windows' own
//! layout engine. `DrawTextW` shapes the run (Uniscribe/DirectWrite), applies
//! the bidirectional algorithm, and the printer driver rasterises the result.
//! Arabic, English and mixed lines all come out the way the operating system
//! draws them on screen. It needs no new crate, no bundled font and no
//! hand-written raster renderer - all of which were the alternatives.
//!
//! The cost is that this path goes through the installed Windows driver, so it
//! serves `connection_type = system` printers. Direct network ESC/POS is a
//! later phase with a different adapter, and its Arabic story will have to be
//! solved by rasterising - which is exactly why it is not in this one.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateDCW, CreateFontW, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, FillRect,
    GetDeviceCaps, SelectObject, SetBkMode, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH,
    DEFAULT_QUALITY, DRAW_TEXT_FORMAT, DT_CALCRECT, DT_LEFT, DT_NOPREFIX, DT_RIGHT, DT_RTLREADING,
    DT_SINGLELINE, DT_WORDBREAK, FF_DONTCARE, HBRUSH, HDC, HFONT, HGDIOBJ, HORZRES, LOGPIXELSX,
    LOGPIXELSY,
    OUT_DEFAULT_PRECIS, TRANSPARENT, VERTRES,
};
use windows::Win32::Graphics::Printing::{
    EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    PRINTER_INFO_2W, PRINTER_STATUS_ERROR, PRINTER_STATUS_NOT_AVAILABLE, PRINTER_STATUS_OFFLINE,
    PRINTER_STATUS_OUT_OF_MEMORY, PRINTER_STATUS_PAPER_JAM, PRINTER_STATUS_PAPER_OUT,
    PRINTER_STATUS_PAUSED, PRINTER_STATUS_USER_INTERVENTION,
};
use windows::Win32::Storage::Xps::{AbortDoc, EndDoc, EndPage, StartDocW, StartPage, DOCINFOW};

use super::page::{Direction, LineStyle, PageLine, CUT_CLEARANCE_MM, QR_QUIET_MM, QR_SIZE_MM};
use super::service::{PrintDevice, PrinterCatalogue};
use super::types::{InstalledPrinter, PaperWidth, PrintError, PrinterStatus};

/// Font used for the diagnostic page.
///
/// Tahoma ships with every supported Windows and contains Arabic, so the test
/// page renders without installing or bundling anything. `DEFAULT_CHARSET` lets
/// GDI font-link to a fallback face for any codepoint Tahoma lacks rather than
/// drawing boxes.
const FONT_FACE: &str = "Tahoma";

/// Any of these bits means the QUEUE is reporting a fault an operator can act
/// on. Deliberately a short list of unambiguous conditions - the full status
/// mask includes transient states like "printing" that say nothing about
/// readiness.
const FAULT_BITS: u32 = PRINTER_STATUS_OFFLINE
    | PRINTER_STATUS_ERROR
    | PRINTER_STATUS_PAPER_OUT
    | PRINTER_STATUS_PAPER_JAM
    | PRINTER_STATUS_PAUSED
    | PRINTER_STATUS_NOT_AVAILABLE
    | PRINTER_STATUS_OUT_OF_MEMORY
    | PRINTER_STATUS_USER_INTERVENTION;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Read a `PWSTR` that Windows filled in for us.
///
/// # Safety
/// `ptr` must be a NUL-terminated UTF-16 string owned by the enumeration buffer
/// and still alive.
unsafe fn read_wide(ptr: windows::core::PWSTR) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { ptr.to_string().unwrap_or_default() }
}

fn last_error() -> String {
    windows::core::Error::from_win32().message()
}

/// Windows' own list of printers for this user session.
pub struct WindowsPrinterCatalogue;

impl PrinterCatalogue for WindowsPrinterCatalogue {
    fn list(&self) -> Result<Vec<InstalledPrinter>, PrintError> {
        // LOCAL covers printers installed on this machine; CONNECTIONS covers
        // per-user network connections. Together these are what the operator
        // sees in the Windows print dialog, which is the list they expect.
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;

        // First call sizes the buffer. It is EXPECTED to fail with
        // ERROR_INSUFFICIENT_BUFFER, so the result is deliberately ignored and
        // `needed` is what matters.
        unsafe {
            let _ = EnumPrintersW(flags, PCWSTR::null(), 2, None, &mut needed, &mut returned);
        }

        if needed == 0 {
            // No printers installed at all. An empty list, not an error: a
            // terminal with no printer is a normal state this UI must show.
            return Ok(Vec::new());
        }

        let mut buffer = vec![0u8; needed as usize];
        unsafe {
            EnumPrintersW(flags, PCWSTR::null(), 2, Some(&mut buffer), &mut needed, &mut returned)
                .map_err(|e| PrintError::PrinterEnumerationFailed { detail: e.message() })?;
        }

        let default_name = default_printer_name();

        let mut printers = Vec::with_capacity(returned as usize);
        // SAFETY: on success Windows has written `returned` PRINTER_INFO_2W
        // structures into the start of `buffer`, with their string data
        // elsewhere in the same allocation.
        let infos = unsafe {
            std::slice::from_raw_parts(buffer.as_ptr() as *const PRINTER_INFO_2W, returned as usize)
        };
        for info in infos {
            let name = unsafe { read_wide(info.pPrinterName) };
            if name.is_empty() {
                continue;
            }
            let status = if info.Status & FAULT_BITS != 0 {
                PrinterStatus::NotReady
            } else if info.Status == 0 {
                // The queue reports nothing wrong. That is as far as Windows
                // will commit, and as far as we will.
                PrinterStatus::Ready
            } else {
                PrinterStatus::Unknown
            };
            let is_default = default_name.as_deref() == Some(name.as_str());
            printers.push(InstalledPrinter { name, is_default, status });
        }

        printers.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(printers)
    }
}

/// The user's default printer, when Windows reports one.
fn default_printer_name() -> Option<String> {
    let mut len: u32 = 0;
    unsafe {
        // Sizing call; failure here simply means "no default", which is a
        // normal state on a machine with no printers.
        let _ = GetDefaultPrinterW(None, &mut len);
    }
    if len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    // Returns a Win32 BOOL, not a Result: false simply means "no default
    // printer", which is a normal state on a terminal with none installed.
    let ok = unsafe { GetDefaultPrinterW(Some(windows::core::PWSTR(buf.as_mut_ptr())), &mut len) };
    if !ok.as_bool() {
        return None;
    }
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

/// A printer device context, driven through one document.
pub struct WindowsPrintDevice {
    hdc: Option<HDC>,
    started: bool,
}

impl WindowsPrintDevice {
    pub fn new() -> Self {
        Self { hdc: None, started: false }
    }
}

impl Default for WindowsPrintDevice {
    fn default() -> Self {
        Self::new()
    }
}

impl PrintDevice for WindowsPrintDevice {
    fn open(&mut self, printer: &str) -> Result<(), PrintError> {
        let name = wide(printer);
        // A device context for the printer itself. Null driver/output/devmode
        // means "use the installed driver's own defaults", which is what the
        // operator configured in Windows.
        let hdc = unsafe {
            CreateDCW(PCWSTR::null(), PCWSTR(name.as_ptr()), PCWSTR::null(), None)
        };
        if hdc.is_invalid() {
            return Err(PrintError::OpenPrinterFailed {
                printer: printer.to_string(),
                detail: last_error(),
            });
        }
        self.hdc = Some(hdc);
        Ok(())
    }

    fn start_document(&mut self, title: &str) -> Result<u32, PrintError> {
        let Some(hdc) = self.hdc else {
            return Err(PrintError::StartDocumentFailed {
                printer: String::new(),
                detail: "no device context".into(),
            });
        };
        let mut doc_name = wide(title);
        let info = DOCINFOW {
            cbSize: std::mem::size_of::<DOCINFOW>() as i32,
            lpszDocName: windows::core::PCWSTR(doc_name.as_mut_ptr()),
            ..Default::default()
        };
        // A positive return is the spooler JOB ID. Zero or negative is failure.
        let job = unsafe { StartDocW(hdc, &info) };
        if job <= 0 {
            return Err(PrintError::StartDocumentFailed {
                printer: title.to_string(),
                detail: last_error(),
            });
        }
        self.started = true;
        Ok(job as u32)
    }

    fn draw(&mut self, paper: PaperWidth, lines: &[PageLine]) -> Result<(), PrintError> {
        let Some(hdc) = self.hdc else {
            return Err(PrintError::WriteFailed {
                printer: String::new(),
                detail: "no device context".into(),
            });
        };

        if unsafe { StartPage(hdc) } <= 0 {
            return Err(PrintError::WriteFailed {
                printer: String::new(),
                detail: format!("StartPage: {}", last_error()),
            });
        }

        let result = draw_page(hdc, paper, lines);

        if unsafe { EndPage(hdc) } <= 0 && result.is_ok() {
            return Err(PrintError::WriteFailed {
                printer: String::new(),
                detail: format!("EndPage: {}", last_error()),
            });
        }
        result
    }

    fn finish_document(&mut self) -> Result<(), PrintError> {
        let Some(hdc) = self.hdc else { return Ok(()) };
        let rc = unsafe { EndDoc(hdc) };
        self.started = false;
        if rc <= 0 {
            return Err(PrintError::FinishDocumentFailed {
                printer: String::new(),
                detail: last_error(),
            });
        }
        Ok(())
    }

    fn abort_document(&mut self) {
        if let (Some(hdc), true) = (self.hdc, self.started) {
            // Best effort. If the spooler will not cancel there is nothing
            // further this process can do, and reporting it would replace a
            // real error with a cleanup one.
            unsafe { AbortDoc(hdc) };
            self.started = false;
        }
    }

    fn close(&mut self) {
        if let Some(hdc) = self.hdc.take() {
            unsafe {
                let _ = DeleteDC(hdc);
            }
        }
    }
}

impl Drop for WindowsPrintDevice {
    /// Belt and braces. `print_one_copy` closes on every path, but a panic
    /// between `open` and `close` would otherwise leak a device context and, if
    /// a document was open, strand a job in the queue.
    fn drop(&mut self) {
        self.abort_document();
        self.close();
    }
}

/// Millimetres to device pixels, using the device's own reported resolution.
fn mm_to_px(mm: f32, dpi: i32) -> i32 {
    ((mm / 25.4) * dpi as f32).round() as i32
}

/// Lay a document out and draw it.
///
/// Text is measured with `DT_CALCRECT` before it is drawn, so a long line wraps
/// and advances the cursor by its real height instead of overprinting the next
/// line - which is what makes the Arabic samples legible rather than a smear.
///
/// MEASURING ALSO DECIDES WHETHER A LINE MAY BE DRAWN AT ALL, and that is the
/// fix for a receipt that came off a real till with its TOTAL sliced in half.
/// This loop used to draw every line and only afterwards ask whether the cursor
/// had passed the bottom of what the driver says it can mark. By then the line
/// was already on the page, so GDI clipped it mid-glyph, and everything below it
/// was dropped. A financial document that ends in half a total is worse than one
/// that ends a line early, so the height is now known BEFORE anything is
/// committed: a line that does not fit moves to the next page instead of being
/// cut through, and nothing is silently discarded.
///
/// The bottom of the usable area also reserves `CUT_CLEARANCE_MM`, because the
/// blade passes below the print head - see the constant.
fn draw_page(hdc: HDC, paper: PaperWidth, lines: &[PageLine]) -> Result<(), PrintError> {
    let dpi_x = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSX) };
    let dpi_y = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSY) };
    if dpi_x <= 0 || dpi_y <= 0 {
        return Err(PrintError::RenderFailed { detail: "device reported no resolution".into() });
    }
    let printable_width = unsafe { GetDeviceCaps(Some(hdc), HORZRES) };
    let printable_height = unsafe { GetDeviceCaps(Some(hdc), VERTRES) };

    // The roll is the target, but never wider than the driver says it can mark.
    let target = mm_to_px(paper.millimetres(), dpi_x);
    let width = if printable_width > 0 { target.min(printable_width) } else { target };
    let margin = mm_to_px(2.0, dpi_x).max(1);
    let column = (width - margin * 2).max(mm_to_px(20.0, dpi_x));

    // Where TEXT has to stop. The clearance band below it is not free space
    // going spare - it is the paper the cutter needs, and the trailing feed line
    // is what occupies it. A driver that reports no page length gets no limit,
    // which is the same as before: there is nothing to compare against.
    let content_bottom = if printable_height > 0 {
        Some(printable_height - margin - mm_to_px(CUT_CLEARANCE_MM, dpi_y).max(1))
    } else {
        None
    };

    unsafe {
        SetBkMode(hdc, TRANSPARENT);
    }

    let mut y = margin;
    for line in lines {
        // Measured and painted under separate font selections so that no GDI
        // object is still selected into the DC if the page has to be broken
        // between the two.
        let height = with_font(hdc, line.style, dpi_y, |hdc| measure_line(hdc, line, margin, y, column))?;

        // The trailing feed is exempt: it is the tail itself, and breaking the
        // page for it would eject a blank slip rather than clear the blade.
        if line.style != LineStyle::Feed {
            if let Some(bottom) = content_bottom {
                // `y > margin` keeps a line taller than a whole page from
                // bouncing between pages forever; it is drawn where it is.
                if y + height > bottom && y > margin {
                    continue_on_a_new_page(hdc)?;
                    y = margin;
                }
            }
        }

        with_font(hdc, line.style, dpi_y, |hdc| paint_line(hdc, line, margin, y, column, height))?;
        y += height;
    }

    Ok(())
}

/// End this page and begin another, so a line that will not fit is continued
/// rather than clipped.
///
/// Only reachable when the driver reports a page shorter than the document.
/// `draw` opened the first page and closes the last one, so the pair here keeps
/// the document balanced.
fn continue_on_a_new_page(hdc: HDC) -> Result<(), PrintError> {
    if unsafe { EndPage(hdc) } <= 0 {
        return Err(PrintError::WriteFailed {
            printer: String::new(),
            detail: format!("EndPage: {}", last_error()),
        });
    }
    if unsafe { StartPage(hdc) } <= 0 {
        return Err(PrintError::WriteFailed {
            printer: String::new(),
            detail: format!("StartPage: {}", last_error()),
        });
    }
    // Page attributes are not guaranteed to survive a page boundary.
    unsafe {
        SetBkMode(hdc, TRANSPARENT);
    }
    Ok(())
}

/// Run `f` with the font this line's style asks for selected into the DC.
///
/// Selecting and restoring in ONE place is what guarantees the font is always
/// restored and deleted - including on the error paths, and before any page
/// break - rather than leaking a GDI object into a long-running till process.
fn with_font<T>(
    hdc: HDC,
    style: LineStyle,
    dpi_y: i32,
    f: impl FnOnce(HDC) -> Result<T, PrintError>,
) -> Result<T, PrintError> {
    with_points(hdc, style_points(style), style_bold(style), dpi_y, f)
}

fn style_points(style: LineStyle) -> i32 {
    match style {
        LineStyle::Title => 16,
        LineStyle::Total => 13,
        LineStyle::Heading => 10,
        LineStyle::Body | LineStyle::Rule => 10,
        LineStyle::Small => 8,
        // None of these draws a glyph; the size only has to be legal. A QR is
        // measured and painted as geometry and never consults the font, but the
        // shared `with_font` wrapper still selects one, so it needs a value.
        LineStyle::Blank | LineStyle::Feed | LineStyle::Qr => 8,
    }
}

fn style_bold(style: LineStyle) -> bool {
    matches!(style, LineStyle::Title | LineStyle::Heading | LineStyle::Total)
}

/// Select a font of an explicit size, run `f`, then restore and delete it.
///
/// Split out of `with_font` so the amount column can be re-measured at a smaller
/// size without duplicating the create/select/restore/delete dance - the part
/// that must never be got wrong, because a leaked HFONT in a till process that
/// runs all day is a slow resource leak rather than an obvious failure.
fn with_points<T>(
    hdc: HDC,
    points: i32,
    bold: bool,
    dpi_y: i32,
    f: impl FnOnce(HDC) -> Result<T, PrintError>,
) -> Result<T, PrintError> {
    let height_px = -(points * dpi_y) / 72;

    let face = wide(FONT_FACE);
    let font: HFONT = unsafe {
        CreateFontW(
            height_px,
            0,
            0,
            0,
            if bold { 700 } else { 400 },
            0,
            0,
            0,
            // DEFAULT_CHARSET keeps GDI font linking available so a codepoint
            // outside the face still renders.
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            DEFAULT_QUALITY,
            (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
            PCWSTR(face.as_ptr()),
        )
    };
    if font.is_invalid() {
        return Err(PrintError::RenderFailed { detail: "could not create the page font".into() });
    }
    let previous: HGDIOBJ = unsafe { SelectObject(hdc, font.into()) };

    let result = f(hdc);

    unsafe {
        SelectObject(hdc, previous);
        let _ = DeleteObject(font.into());
    }
    result
}

/// Smallest size the amount may shrink to before it is moved to its own row.
///
/// 8pt is the same size the receipt already uses for `Small`, so an amount that
/// has shrunk is still a size this paper is known to render legibly.
const AMOUNT_MIN_POINTS: i32 = 8;

/// How the amount on a row is going to be laid out.
///
/// Decided by MEASURING, never by assuming a fixed share of the paper. The old
/// code reserved two fifths of the column for the amount and drew into exactly
/// that rectangle, so any figure wider than the reservation was clipped by GDI -
/// and the TOTAL row clipped first because it is set in a larger bold face. A
/// receipt that shows a customer a chopped total is worse than one that is ugly,
/// so width is now established before anything is committed to paper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AmountPlan {
    /// No amount on this row.
    None,
    /// The amount shares the row. `left` is what the description may use.
    SameRow { left: i32, points: i32, bold: bool },
    /// The amount did not fit beside the description at any allowed size, so it
    /// takes its own right-aligned row underneath.
    OwnRow { points: i32, bold: bool },
}

/// Gap kept between the description and the amount so they never touch.
fn amount_gap(column: i32) -> i32 {
    (column / 40).max(4)
}

/// Measure a single run of text under the currently selected font.
fn measure_text(hdc: HDC, text: &str) -> Result<(i32, i32), PrintError> {
    let mut wide_text = wide(text);
    let len = wide_text.len().saturating_sub(1);
    let mut rect = RECT { left: 0, top: 0, right: 1, bottom: 1 };
    let measured = unsafe {
        DrawTextW(
            hdc,
            &mut wide_text[..len],
            &mut rect,
            DT_CALCRECT | DT_SINGLELINE | DT_NOPREFIX,
        )
    };
    if measured == 0 {
        return Err(PrintError::RenderFailed { detail: "could not measure an amount".into() });
    }
    Ok((rect.right - rect.left, (rect.bottom - rect.top).max(1)))
}

/// Work out where this row's amount can go without losing a digit.
///
/// Deterministic for a given (line, column, dpi): the measuring pass and the
/// painting pass both call it and must reach the same answer, which is why the
/// decision is recomputed rather than carried between them.
fn plan_amount(
    hdc: HDC,
    line: &PageLine,
    column: i32,
    dpi_y: i32,
) -> Result<AmountPlan, PrintError> {
    let Some(amount) = line.right.as_deref().filter(|r| !r.is_empty()) else {
        return Ok(AmountPlan::None);
    };

    let bold = style_bold(line.style);
    let base_points = style_points(line.style);
    let mut measured: Result<(), PrintError> = Ok(());
    let plan = plan_amount_from(base_points, bold, column, |points| {
        match with_points(hdc, points, bold, dpi_y, |hdc| measure_text(hdc, amount)) {
            Ok((w, _)) => w,
            Err(e) => {
                // Remember the first failure and starve the search, so the error
                // is reported rather than silently becoming a layout decision.
                if measured.is_ok() {
                    measured = Err(e);
                }
                i32::MAX / 4
            }
        }
    });
    measured?;
    Ok(plan)
}

/// The width-only decision, separated from GDI so it can be tested.
///
/// `measure(points)` returns the amount's width at that size.
fn plan_amount_from(
    base_points: i32,
    bold: bool,
    column: i32,
    mut measure: impl FnMut(i32) -> i32,
) -> AmountPlan {
    let gap = amount_gap(column);
    // The description keeps at least two fifths of the paper, otherwise an item
    // name is squeezed to a column of single letters to make room for a figure.
    let widest_shared = (column * 3) / 5;
    // Preserve today's geometry whenever the figure fits the historic
    // reservation: an ordinary receipt must look exactly as it did.
    let reserved = (column * 2) / 5;

    let mut points = base_points;
    loop {
        let needed = measure(points).saturating_add(gap);
        if needed <= reserved {
            return AmountPlan::SameRow { left: (column - reserved).max(1), points, bold };
        }
        if needed <= widest_shared {
            return AmountPlan::SameRow { left: (column - needed).max(1), points, bold };
        }
        if points <= AMOUNT_MIN_POINTS {
            // Even at the smallest allowed size it wants more than its share of
            // the row, so it gets a row to itself and the full paper width.
            return AmountPlan::OwnRow { points, bold };
        }
        points -= 1;
    }
}

/// The width the description may use once the amount column is reserved.
fn left_column_for(plan: AmountPlan, column: i32) -> i32 {
    match plan {
        // On its own row the description is free to use the whole width.
        AmountPlan::None | AmountPlan::OwnRow { .. } => column.max(1),
        AmountPlan::SameRow { left, .. } => left.max(1),
    }
}

fn line_format(line: &PageLine) -> DRAW_TEXT_FORMAT {
    let alignment = match line.direction {
        Direction::Rtl => DT_RIGHT | DT_RTLREADING,
        Direction::Auto => DT_LEFT,
    };
    // DT_NOPREFIX: a printer name may legitimately contain "&", which would
    // otherwise be swallowed as an accelerator marker.
    alignment | DT_WORDBREAK | DT_NOPREFIX
}

/// How tall this line will be, measured before anything is committed.
fn measure_line(hdc: HDC, line: &PageLine, x: i32, y: i32, column: i32) -> Result<i32, PrintError> {
    // A QR is geometry, not glyphs, so its height comes from millimetres rather
    // than from a font. Checked BEFORE the empty-text branch below: a QR line
    // carries no text on purpose, and would otherwise be measured as a spacer
    // and painted over by whatever came next.
    if line.style == LineStyle::Qr {
        let dpi_y = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSY) };
        return Ok(mm_to_px(QR_SIZE_MM + QR_QUIET_MM * 2.0, dpi_y).max(8));
    }

    if line.text.is_empty() {
        let dpi_y = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSY) };
        let mm = match line.style {
            // The tail the cutter needs. This is the whole of Fix 1's spacing.
            LineStyle::Feed => CUT_CLEARANCE_MM,
            // Blank spacer: roughly one line, drawing nothing.
            _ => 2.0,
        };
        return Ok(mm_to_px(mm, dpi_y).max(4));
    }

    let dpi_y = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSY) };
    let plan = plan_amount(hdc, line, column, dpi_y)?;

    let mut text = wide(&line.text);
    // `wide` appends a NUL for the C APIs; DrawTextW takes a counted slice, so
    // the terminator must not be part of it.
    let len = text.len().saturating_sub(1);
    let mut rect =
        RECT { left: x, top: y, right: x + left_column_for(plan, column), bottom: y + 1 };

    let measured =
        unsafe { DrawTextW(hdc, &mut text[..len], &mut rect, line_format(line) | DT_CALCRECT) };
    if measured == 0 {
        return Err(PrintError::RenderFailed { detail: "could not measure a line".into() });
    }
    let described = (rect.bottom - rect.top).max(1);

    // An amount that had to move below the description adds its own row, and
    // that height has to be reserved here or the next line paints over it.
    if let AmountPlan::OwnRow { points, bold } = plan {
        let amount = line.right.as_deref().unwrap_or_default();
        let extra = with_points(hdc, points, bold, dpi_y, |hdc| measure_text(hdc, amount))?.1;
        return Ok(described + extra);
    }
    Ok(described)
}

/// Draw one line that has already been measured and found to fit.
///
/// The rectangles are built fresh from `height` rather than reused from the
/// measuring pass: `DT_CALCRECT` with `DT_RIGHT` collapses the rect to the text
/// width, which would then right-align against the wrong edge.
fn paint_line(
    hdc: HDC,
    line: &PageLine,
    x: i32,
    y: i32,
    column: i32,
    height: i32,
) -> Result<(), PrintError> {
    if line.style == LineStyle::Qr {
        return paint_qr(hdc, line, x, y, column, height);
    }

    // Spacers and the trailing feed are paper, not marks.
    if line.text.is_empty() {
        return Ok(());
    }

    let dpi_y = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSY) };
    let plan = plan_amount(hdc, line, column, dpi_y)?;
    let left_column = left_column_for(plan, column);

    // When the amount takes its own row the description keeps only the height it
    // measured, so the figure below is drawn on clean paper rather than over it.
    let amount_height = match plan {
        AmountPlan::OwnRow { points, bold } => {
            let amount = line.right.as_deref().unwrap_or_default();
            with_points(hdc, points, bold, dpi_y, |hdc| measure_text(hdc, amount))?.1
        }
        _ => 0,
    };
    let text_height = (height - amount_height).max(1);

    let mut text = wide(&line.text);
    let len = text.len().saturating_sub(1);
    let mut draw_rect = RECT { left: x, top: y, right: x + left_column, bottom: y + text_height };

    let painted = unsafe { DrawTextW(hdc, &mut text[..len], &mut draw_rect, line_format(line)) };
    if painted == 0 {
        return Err(PrintError::RenderFailed { detail: "could not draw a line".into() });
    }

    // The amount. Always left-to-right: a price is a number, and reversing it
    // would be wrong in any language. Its rectangle is the width MEASURED for
    // it, so the last digit always lands on paper.
    let (amount_top, amount_bottom, points, bold) = match plan {
        AmountPlan::None => return Ok(()),
        AmountPlan::SameRow { points, bold, .. } => (y, y + text_height, points, bold),
        AmountPlan::OwnRow { points, bold } => {
            (y + text_height, y + text_height + amount_height, points, bold)
        }
    };
    let amount = line.right.as_deref().unwrap_or_default();
    let left_edge = match plan {
        // Its own row: right-aligned across the whole paper width.
        AmountPlan::OwnRow { .. } => x,
        _ => x + left_column,
    };

    with_points(hdc, points, bold, dpi_y, |hdc| {
        let mut right_wide = wide(amount);
        let right_len = right_wide.len().saturating_sub(1);
        let mut right_rect =
            RECT { left: left_edge, top: amount_top, right: x + column, bottom: amount_bottom };
        let drawn = unsafe {
            DrawTextW(hdc, &mut right_wide[..right_len], &mut right_rect, DT_RIGHT | DT_NOPREFIX)
        };
        if drawn == 0 {
            return Err(PrintError::RenderFailed { detail: "could not draw an amount".into() });
        }
        Ok(())
    })
}

/// Draw a QR symbol as filled rectangles.
///
/// WHY RECTANGLES AND NOT A BITMAP. A bitmap would have to be built at the
/// device's own resolution, blitted with `StretchDIBits`, and then dithered by
/// whatever the driver felt like doing to it - which on a 1-bit thermal head is
/// how a QR turns into a grey smear that will not scan. Filling each module as
/// its own black rectangle asks the driver for exactly the marks the symbol is
/// made of, at device resolution, with no resampling anywhere.
///
/// MODULE SIZE IS ROUNDED DOWN TO A WHOLE DEVICE PIXEL, and the symbol's true
/// width is then recomputed from it. A fractional module size would put some
/// modules one pixel wider than their neighbours, and an unevenly-spaced grid
/// is the classic reason a printed code scans on one phone and not another.
fn paint_qr(hdc: HDC, line: &PageLine, x: i32, y: i32, column: i32, height: i32) -> Result<(), PrintError> {
    let Some(matrix) = line.qr.as_ref() else { return Ok(()) };
    if !matrix.is_well_formed() {
        // Validation refuses this at the boundary; reaching here means a caller
        // inside this process built one by hand. Draw nothing rather than a
        // partial symbol - half a QR scans as nothing at all.
        return Ok(());
    }

    let dpi_x = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSX) };
    let dpi_y = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSY) };
    if dpi_x <= 0 || dpi_y <= 0 {
        return Err(PrintError::RenderFailed { detail: "device reported no resolution".into() });
    }

    let wanted = mm_to_px(QR_SIZE_MM, dpi_x).min(column);
    let module = (wanted / matrix.size as i32).max(1);
    let side = module * matrix.size as i32;
    // Centred on the paper, and vertically inside its own quiet zone.
    let left = x + ((column - side) / 2).max(0);
    let quiet = mm_to_px(QR_QUIET_MM, dpi_y).max(1);
    let top = y + quiet.min((height - side).max(0) / 2);

    // One brush for the whole symbol. Creating one per module would be a few
    // thousand GDI objects for a single receipt.
    // Pure black, as a COLORREF (0x00BBGGRR). A thermal head is one bit deep,
    // so anything else would be dithered into a grey mesh that will not scan.
    let brush: HBRUSH = unsafe { CreateSolidBrush(COLORREF(0x0000_0000)) };
    if brush.is_invalid() {
        return Err(PrintError::RenderFailed { detail: "could not create the QR brush".into() });
    }

    for row in 0..matrix.size {
        for col in 0..matrix.size {
            if !matrix.is_dark(row, col) {
                continue;
            }
            let cell = RECT {
                left: left + col as i32 * module,
                top: top + row as i32 * module,
                right: left + (col as i32 + 1) * module,
                bottom: top + (row as i32 + 1) * module,
            };
            unsafe { FillRect(hdc, &cell, brush) };
        }
    }

    // Always deleted, including when nothing was drawn: a till runs for a whole
    // shift and a leaked brush per receipt is a leak per sale. `.into()` rather
    // than a hand-built HGDIOBJ, matching how `with_font` disposes of its font.
    unsafe {
        let _ = DeleteObject(brush.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn millimetres_convert_at_the_devices_own_resolution() {
        // 80mm at 203dpi is the classic thermal head width.
        assert_eq!(mm_to_px(80.0, 203), 639);
        assert_eq!(mm_to_px(58.0, 203), 464);
        // Same paper, finer head.
        assert_eq!(mm_to_px(80.0, 300), 945);
    }

    #[test]
    fn the_fault_mask_covers_the_conditions_an_operator_can_fix() {
        for bit in [
            PRINTER_STATUS_OFFLINE,
            PRINTER_STATUS_ERROR,
            PRINTER_STATUS_PAPER_OUT,
            PRINTER_STATUS_PAPER_JAM,
            PRINTER_STATUS_PAUSED,
        ] {
            assert!(FAULT_BITS & bit != 0);
        }
    }

    #[test]
    fn wide_strings_are_nul_terminated_utf16() {
        let w = wide("AB");
        assert_eq!(w, vec![65u16, 66u16, 0u16]);
        // Arabic survives the conversion unchanged.
        let arabic = wide("بريدي");
        assert_eq!(*arabic.last().unwrap(), 0);
        assert!(arabic.len() > 1);
    }

    #[test]
    fn the_cut_clearance_is_real_paper_at_every_thermal_resolution() {
        // The tail is declared in millimetres, so it has to survive the
        // conversion the renderer actually performs. 15mm at 203dpi is 120
        // device rows - about four body lines of paper below the last glyph.
        assert_eq!(mm_to_px(CUT_CLEARANCE_MM, 203), 120);
        assert_eq!(mm_to_px(CUT_CLEARANCE_MM, 300), 177);
        // And it is never rounded away on a low-resolution device.
        assert!(mm_to_px(CUT_CLEARANCE_MM, 96) > 0);
    }

    #[test]
    fn a_line_may_not_be_drawn_into_the_cutters_band() {
        // The usable height is the page less the top margin, less the tail. A
        // renderer that forgets the second term draws the last line where the
        // blade lands, which is the receipt this hotfix was raised for.
        let dpi = 203;
        let page_height = mm_to_px(100.0, dpi);
        let margin = mm_to_px(2.0, dpi).max(1);
        let content_bottom = page_height - margin - mm_to_px(CUT_CLEARANCE_MM, dpi).max(1);
        assert!(content_bottom < page_height - margin, "no clearance was reserved");
        assert!(content_bottom > page_height / 2, "the reserve must not eat the page");
    }

    #[test]
    fn the_font_face_is_a_stock_windows_face() {
        // Nothing is bundled or copied into the repository; this must stay a
        // face that Windows already has, and one that contains Arabic.
        assert_eq!(FONT_FACE, "Tahoma");
    }

    // --- The clipped TOTAL (1.0.4) --------------------------------------------
    //
    // A production receipt showed a TOTAL whose digits ran off the paper. The
    // cause was a FIXED two-fifths reservation for the amount: anything wider
    // was cut off by the drawing rectangle, and TOTAL clipped first because it
    // is set larger and bold. These tests pin the rule that replaced it - the
    // amount is measured, and it either fits or it moves, but it is never cut.

    /// A column roughly matching 80mm at 203dpi once margins are removed.
    const COLUMN: i32 = 560;

    /// Width the real face charges for a run of digits, near enough for layout:
    /// Tahoma's digits are about 0.55em, and the em is the point size in px.
    fn width_at(text: &str, points: i32) -> i32 {
        let em = (points * 203) / 72;
        (text.chars().count() as i32 * em * 55) / 100
    }

    fn plan_for(amount: &str, points: i32) -> AmountPlan {
        plan_amount_from(points, true, COLUMN, |p| width_at(amount, p))
    }

    #[test]
    fn an_ordinary_total_keeps_the_historic_two_fifths_geometry() {
        // The look of a normal receipt must not change: a short figure still
        // sits in the same reserved column it always did.
        let plan = plan_for("8.00 USD", 13);
        let reserved = (COLUMN * 2) / 5;
        assert_eq!(plan, AmountPlan::SameRow { left: COLUMN - reserved, points: 13, bold: true });
    }

    #[test]
    fn the_reported_amount_is_not_clipped() {
        // 450,000 LBP is the figure from the incident report.
        match plan_for("450,000 LBP", 13) {
            AmountPlan::SameRow { left, points, .. } => {
                let available = COLUMN - left;
                assert!(
                    width_at("450,000 LBP", points) <= available,
                    "the amount still does not fit its column",
                );
            }
            AmountPlan::OwnRow { .. } => {}
            AmountPlan::None => panic!("an amount was supplied"),
        }
    }

    #[test]
    fn every_escalating_amount_still_fits_somewhere() {
        // The four magnitudes the hotfix must cover, at the TOTAL size.
        for amount in ["450,000 LBP", "1,250,000 LBP", "12,500,000 LBP", "125,000,000 LBP"] {
            match plan_for(amount, 13) {
                AmountPlan::SameRow { left, points, .. } => {
                    assert!(
                        width_at(amount, points) <= COLUMN - left,
                        "{amount} overflows the shared row",
                    );
                    assert!(left >= 1, "{amount} left the description no width");
                }
                AmountPlan::OwnRow { points, .. } => {
                    assert!(
                        width_at(amount, points) <= COLUMN,
                        "{amount} overflows even its own row",
                    );
                }
                AmountPlan::None => panic!("{amount} produced no plan"),
            }
        }
    }

    #[test]
    fn the_description_never_loses_more_than_two_fifths_of_the_paper() {
        // A long figure may take space from the item name, but not all of it.
        for amount in ["450,000 LBP", "1,250,000 LBP", "12,500,000 LBP", "125,000,000 LBP"] {
            if let AmountPlan::SameRow { left, .. } = plan_for(amount, 13) {
                assert!(
                    left >= (COLUMN * 2) / 5,
                    "{amount} squeezed the description below two fifths",
                );
            }
        }
    }

    #[test]
    fn shrinking_stops_at_a_readable_size() {
        // An absurd figure must move to its own row rather than shrink away to
        // something a customer cannot read.
        match plan_amount_from(13, true, COLUMN, |_| COLUMN * 4) {
            AmountPlan::OwnRow { points, .. } => assert_eq!(points, AMOUNT_MIN_POINTS),
            other => panic!("expected its own row, got {other:?}"),
        }
    }

    #[test]
    fn a_row_without_an_amount_uses_the_whole_width() {
        assert_eq!(left_column_for(AmountPlan::None, COLUMN), COLUMN);
        assert_eq!(left_column_for(AmountPlan::OwnRow { points: 8, bold: true }, COLUMN), COLUMN);
    }
}
