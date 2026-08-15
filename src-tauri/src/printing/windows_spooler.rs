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
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    CreateDCW, CreateFontW, DeleteDC, DeleteObject, DrawTextW, GetDeviceCaps, SelectObject,
    SetBkMode, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DEFAULT_QUALITY, DRAW_TEXT_FORMAT,
    DT_CALCRECT, DT_LEFT, DT_NOPREFIX, DT_RIGHT, DT_RTLREADING, DT_WORDBREAK, FF_DONTCARE, HDC,
    HFONT, HGDIOBJ, HORZRES, LOGPIXELSX, LOGPIXELSY, OUT_DEFAULT_PRECIS, TRANSPARENT, VERTRES,
};
use windows::Win32::Graphics::Printing::{
    EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    PRINTER_INFO_2W, PRINTER_STATUS_ERROR, PRINTER_STATUS_NOT_AVAILABLE, PRINTER_STATUS_OFFLINE,
    PRINTER_STATUS_OUT_OF_MEMORY, PRINTER_STATUS_PAPER_JAM, PRINTER_STATUS_PAPER_OUT,
    PRINTER_STATUS_PAUSED, PRINTER_STATUS_USER_INTERVENTION,
};
use windows::Win32::Storage::Xps::{AbortDoc, EndDoc, EndPage, StartDocW, StartPage, DOCINFOW};

use super::page::{Direction, LineStyle, PageLine, CUT_CLEARANCE_MM};
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
    let points = match style {
        LineStyle::Title => 16,
        LineStyle::Total => 13,
        LineStyle::Heading => 10,
        LineStyle::Body | LineStyle::Rule => 10,
        LineStyle::Small => 8,
        // Neither draws a glyph; the size only has to be legal.
        LineStyle::Blank | LineStyle::Feed => 8,
    };
    let bold = matches!(style, LineStyle::Title | LineStyle::Heading | LineStyle::Total);
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

/// The width the description may use once the amount column is reserved.
///
/// A money column on the right narrows the space the description has, so the
/// two are laid out against different widths. Without this the description
/// would wrap under the amount and the receipt would look like the figures
/// belonged to the wrong line.
fn left_column_width(line: &PageLine, column: i32) -> i32 {
    let reserved = if line.right.as_deref().is_some_and(|r| !r.is_empty()) {
        (column * 2) / 5
    } else {
        0
    };
    (column - reserved).max(1)
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

    let mut text = wide(&line.text);
    // `wide` appends a NUL for the C APIs; DrawTextW takes a counted slice, so
    // the terminator must not be part of it.
    let len = text.len().saturating_sub(1);
    let mut rect =
        RECT { left: x, top: y, right: x + left_column_width(line, column), bottom: y + 1 };

    let measured =
        unsafe { DrawTextW(hdc, &mut text[..len], &mut rect, line_format(line) | DT_CALCRECT) };
    if measured == 0 {
        return Err(PrintError::RenderFailed { detail: "could not measure a line".into() });
    }
    Ok((rect.bottom - rect.top).max(1))
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
    // Spacers and the trailing feed are paper, not marks.
    if line.text.is_empty() {
        return Ok(());
    }

    let left_column = left_column_width(line, column);
    let mut text = wide(&line.text);
    let len = text.len().saturating_sub(1);
    let mut draw_rect = RECT { left: x, top: y, right: x + left_column, bottom: y + height };

    let painted = unsafe { DrawTextW(hdc, &mut text[..len], &mut draw_rect, line_format(line)) };
    if painted == 0 {
        return Err(PrintError::RenderFailed { detail: "could not draw a line".into() });
    }

    // The amount, flush right on the SAME row. Always left-to-right: a price is
    // a number, and reversing it would be wrong in any language.
    if let Some(right) = line.right.as_deref().filter(|r| !r.is_empty()) {
        let mut right_wide = wide(right);
        let right_len = right_wide.len().saturating_sub(1);
        let mut right_rect =
            RECT { left: x + left_column, top: y, right: x + column, bottom: y + height };
        let drawn = unsafe {
            DrawTextW(hdc, &mut right_wide[..right_len], &mut right_rect, DT_RIGHT | DT_NOPREFIX)
        };
        if drawn == 0 {
            return Err(PrintError::RenderFailed { detail: "could not draw an amount".into() });
        }
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
}
