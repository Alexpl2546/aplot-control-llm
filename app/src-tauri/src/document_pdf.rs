//! Bounded A4 PDF rendering for the declarative text document format.
//!
//! The renderer embeds the bundled Noto Sans font. Text is encoded as two-byte
//! CIDs with a ToUnicode map so extracted text remains Unicode (including
//! Cyrillic) instead of depending on a viewer's fallback font.

use std::collections::{HashMap, HashSet};

use pdf_writer::types::{CidFontType, FontFlags, SystemInfo, UnicodeCmap};
use pdf_writer::{Content, Name, Pdf, Rect, Ref, Str, TextStr};
use ttf_parser::Face;

use crate::document_spec::{DocumentBlock, TextDocument};

const NOTO_SANS: &[u8] = include_bytes!("../resources/fonts/NotoSans-Regular.ttf");

const MAX_DOCUMENT_BYTES: usize = 64_000;
const MAX_BLOCKS: usize = 100;
const MAX_TABLE_COLUMNS: usize = 8;
const MAX_TABLE_ROWS: usize = 200;
const MAX_BULLETS: usize = 200;
const MAX_PAGES: usize = 100;

const PAGE_WIDTH: f32 = 595.0;
const PAGE_HEIGHT: f32 = 842.0;
const MARGIN: f32 = 42.0;
const BODY_WIDTH: f32 = PAGE_WIDTH - MARGIN * 2.0;
const BOTTOM: f32 = MARGIN + 10.0;

const CATALOG_ID: Ref = Ref::new(1);
const PAGES_ID: Ref = Ref::new(2);
const TYPE0_FONT_ID: Ref = Ref::new(3);
const CID_FONT_ID: Ref = Ref::new(4);
const FONT_DESCRIPTOR_ID: Ref = Ref::new(5);
const FONT_FILE_ID: Ref = Ref::new(6);
const CID_TO_GID_ID: Ref = Ref::new(7);
const TO_UNICODE_ID: Ref = Ref::new(8);
const PAGE_REF_BASE: i32 = 100;
const CONTENT_REF_BASE: i32 = 200;

/// Builds a searchable PDF for a bounded [`TextDocument`].
pub(crate) fn build(document: &TextDocument) -> Result<Vec<u8>, String> {
    validate_document(document)?;

    let font = EmbeddedFont::new(document)?;
    let mut layout = Layout::new(&font, &document.title)?;

    let mut break_before_next = false;
    for block in &document.blocks {
        if break_before_next {
            layout.start_new_page()?;
            break_before_next = false;
        }

        match block {
            DocumentBlock::Paragraph { text } => layout.paragraph(text)?,
            DocumentBlock::Heading { text, level } => layout.heading(text, *level)?,
            DocumentBlock::BulletList { items } => layout.bullet_list(items)?,
            DocumentBlock::Table { headers, rows } => layout.table(headers, rows)?,
            DocumentBlock::PageBreak => break_before_next = true,
        }
    }

    let pages = layout.finish()?;
    font.write_pdf(pages, &document.title)
}

fn validate_document(document: &TextDocument) -> Result<(), String> {
    if document.blocks.len() > MAX_BLOCKS {
        return Err(format!(
            "document-pdf-limit: document has more than {MAX_BLOCKS} blocks"
        ));
    }

    let mut text_bytes = document.title.len();
    for (index, block) in document.blocks.iter().enumerate() {
        match block {
            DocumentBlock::Paragraph { text } | DocumentBlock::Heading { text, .. } => {
                text_bytes = add_text_bytes(text_bytes, text.len())?;
            }
            DocumentBlock::BulletList { items } => {
                if items.len() > MAX_BULLETS {
                    return Err(format!(
                        "document-pdf-limit: bullet list {} has more than {MAX_BULLETS} items",
                        index + 1
                    ));
                }
                for item in items {
                    text_bytes = add_text_bytes(text_bytes, item.len())?;
                }
            }
            DocumentBlock::Table { headers, rows } => {
                if headers.is_empty() || headers.len() > MAX_TABLE_COLUMNS {
                    return Err(format!(
                        "document-pdf-limit: table {} must have 1 to {MAX_TABLE_COLUMNS} columns",
                        index + 1
                    ));
                }
                if rows.len() > MAX_TABLE_ROWS {
                    return Err(format!(
                        "document-pdf-limit: table {} has more than {MAX_TABLE_ROWS} rows",
                        index + 1
                    ));
                }
                for header in headers {
                    text_bytes = add_text_bytes(text_bytes, header.len())?;
                }
                for (row_index, row) in rows.iter().enumerate() {
                    if row.len() != headers.len() {
                        return Err(format!(
                            "document-pdf-table: table {} row {} has {} cells; expected {}",
                            index + 1,
                            row_index + 1,
                            row.len(),
                            headers.len()
                        ));
                    }
                    for cell in row {
                        text_bytes = add_text_bytes(text_bytes, cell.len())?;
                    }
                }
            }
            DocumentBlock::PageBreak => {}
        }
    }

    if text_bytes > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "document-pdf-limit: document text exceeds {MAX_DOCUMENT_BYTES} bytes"
        ));
    }

    for text in document_texts(document) {
        for character in normalized_text(text).chars() {
            if character.is_control() && character != '\n' {
                return Err(format!(
                    "document-pdf-text: control character U+{:04X} is not supported",
                    character as u32
                ));
            }
        }
    }

    Ok(())
}

fn add_text_bytes(current: usize, addition: usize) -> Result<usize, String> {
    current
        .checked_add(addition)
        .ok_or_else(|| "document-pdf-limit: document text size overflow".to_string())
}

fn document_texts(document: &TextDocument) -> impl Iterator<Item = &str> {
    std::iter::once(document.title.as_str()).chain(document.blocks.iter().flat_map(|block| {
        let texts: Vec<&str> = match block {
            DocumentBlock::Paragraph { text } | DocumentBlock::Heading { text, .. } => {
                vec![text]
            }
            DocumentBlock::BulletList { items } => items.iter().map(String::as_str).collect(),
            DocumentBlock::Table { headers, rows } => headers
                .iter()
                .map(String::as_str)
                .chain(rows.iter().flat_map(|row| row.iter().map(String::as_str)))
                .collect(),
            DocumentBlock::PageBreak => Vec::new(),
        };
        texts
    }))
}

fn normalized_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\t', " ")
}

struct EmbeddedFont {
    face: Face<'static>,
    char_to_cid: HashMap<char, u16>,
    unicode_by_cid: Vec<char>,
    cid_to_glyph: Vec<u16>,
    widths: Vec<f32>,
    units_per_em: f32,
}

impl EmbeddedFont {
    fn new(document: &TextDocument) -> Result<Self, String> {
        let face = Face::parse(NOTO_SANS, 0)
            .map_err(|_| "document-pdf-font: bundled Noto Sans font is invalid".to_string())?;
        if !face.is_outline_embedding_allowed() {
            return Err("document-pdf-font: bundled font does not allow outline embedding".into());
        }

        let mut ordered_chars = Vec::new();
        let mut seen = HashSet::new();
        for character in document_texts(document)
            .flat_map(|text| normalized_text(text).chars().collect::<Vec<_>>())
            .chain("0123456789/ •".chars())
        {
            if seen.insert(character) {
                ordered_chars.push(character);
            }
        }

        let units_per_em = f32::from(face.units_per_em());
        let mut char_to_cid = HashMap::with_capacity(ordered_chars.len());
        let mut unicode_by_cid = vec!['\0'];
        let mut cid_to_glyph = vec![0_u16];
        let mut widths = Vec::with_capacity(ordered_chars.len());
        for (index, character) in ordered_chars.into_iter().enumerate() {
            let cid = u16::try_from(index + 1).map_err(|_| {
                "document-pdf-limit: document uses too many distinct Unicode characters".to_string()
            })?;
            let glyph = face.glyph_index(character).ok_or_else(|| {
                format!(
                    "document-pdf-glyph: U+{:04X} is not supported by bundled Noto Sans",
                    character as u32
                )
            })?;
            let advance = face.glyph_hor_advance(glyph).ok_or_else(|| {
                format!(
                    "document-pdf-glyph: no horizontal advance is available for U+{:04X}",
                    character as u32
                )
            })?;

            char_to_cid.insert(character, cid);
            unicode_by_cid.push(character);
            cid_to_glyph.push(glyph.0);
            widths.push(f32::from(advance) * 1000.0 / units_per_em);
        }

        Ok(Self {
            face,
            char_to_cid,
            unicode_by_cid,
            cid_to_glyph,
            widths,
            units_per_em,
        })
    }

    fn advance(&self, character: char, font_size: f32) -> Result<f32, String> {
        let cid = self.char_to_cid.get(&character).ok_or_else(|| {
            format!(
                "document-pdf-glyph: U+{:04X} is not supported by bundled Noto Sans",
                character as u32
            )
        })?;
        let width = self
            .widths
            .get(usize::from(*cid - 1))
            .copied()
            .unwrap_or(0.0);
        Ok(width * font_size / 1000.0)
    }

    fn measure(&self, text: &str, font_size: f32) -> Result<f32, String> {
        text.chars().try_fold(0.0, |width, character| {
            self.advance(character, font_size)
                .map(|advance| width + advance)
        })
    }

    fn encode(&self, text: &str) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::with_capacity(text.chars().count() * 2);
        for character in text.chars() {
            let cid = self.char_to_cid.get(&character).ok_or_else(|| {
                format!(
                    "document-pdf-glyph: U+{:04X} is not supported by bundled Noto Sans",
                    character as u32
                )
            })?;
            bytes.extend_from_slice(&cid.to_be_bytes());
        }
        Ok(bytes)
    }

    fn write_pdf(&self, pages: Vec<Content>, title: &str) -> Result<Vec<u8>, String> {
        let mut pdf = Pdf::with_capacity(NOTO_SANS.len() + 128 * 1024);
        let page_ids: Vec<Ref> = (0..pages.len())
            .map(|index| Ref::new(PAGE_REF_BASE + index as i32))
            .collect();
        let content_ids: Vec<Ref> = (0..pages.len())
            .map(|index| Ref::new(CONTENT_REF_BASE + index as i32))
            .collect();

        pdf.catalog(CATALOG_ID).pages(PAGES_ID);
        pdf.document_info(Ref::new(9))
            .title(TextStr(title))
            .creator(TextStr("Aplot Control"));
        pdf.pages(PAGES_ID)
            .kids(page_ids.iter().copied())
            .count(pages.len() as i32);

        let cid_to_gid_bytes = self
            .cid_to_glyph
            .iter()
            .flat_map(|glyph| glyph.to_be_bytes())
            .collect::<Vec<_>>();
        let unicode_cmap = self.to_unicode_cmap();
        let unicode_bytes = unicode_cmap.finish();
        let system_info = SystemInfo {
            registry: Str(b"Adobe"),
            ordering: Str(b"Identity"),
            supplement: 0,
        };

        pdf.type0_font(TYPE0_FONT_ID)
            .base_font(Name(b"NotoSans"))
            .encoding_predefined(Name(b"Identity-H"))
            .descendant_font(CID_FONT_ID)
            .to_unicode(TO_UNICODE_ID);
        {
            let mut cid_font = pdf.cid_font(CID_FONT_ID);
            cid_font
                .subtype(CidFontType::Type2)
                .base_font(Name(b"NotoSans"))
                .system_info(system_info)
                .font_descriptor(FONT_DESCRIPTOR_ID)
                .default_width(1000.0)
                .cid_to_gid_map_stream(CID_TO_GID_ID);
            cid_font
                .widths()
                .consecutive(1, self.widths.iter().copied());
        }

        let bbox = self.face.global_bounding_box();
        let scale = 1000.0 / self.units_per_em;
        let mut descriptor = pdf.font_descriptor(FONT_DESCRIPTOR_ID);
        descriptor
            .name(Name(b"NotoSans"))
            .flags(FontFlags::NON_SYMBOLIC)
            .bbox(Rect::new(
                f32::from(bbox.x_min) * scale,
                f32::from(bbox.y_min) * scale,
                f32::from(bbox.x_max) * scale,
                f32::from(bbox.y_max) * scale,
            ))
            .italic_angle(0.0)
            .ascent(f32::from(self.face.ascender()) * scale)
            .descent(f32::from(self.face.descender()) * scale)
            .leading(f32::from(self.face.line_gap()) * scale)
            .cap_height(
                f32::from(self.face.capital_height().unwrap_or(self.face.ascender())) * scale,
            )
            .x_height(f32::from(self.face.x_height().unwrap_or(0)) * scale)
            .stem_v(80.0)
            .font_file2(FONT_FILE_ID);
        drop(descriptor);

        pdf.stream(FONT_FILE_ID, NOTO_SANS)
            .pair(Name(b"Length1"), NOTO_SANS.len() as i32);
        pdf.stream(CID_TO_GID_ID, &cid_to_gid_bytes);
        let unicode_system_info = SystemInfo {
            registry: Str(b"Adobe"),
            ordering: Str(b"UCS"),
            supplement: 0,
        };
        pdf.cmap(TO_UNICODE_ID, unicode_bytes.as_slice())
            .name(Name(b"NotoSansToUnicode"))
            .system_info(unicode_system_info);

        for (index, (page, content)) in pages.into_iter().zip(content_ids.iter()).enumerate() {
            let content_bytes = page.finish();
            pdf.stream(*content, content_bytes.as_slice());
            let page_id = page_ids[index];
            let mut page_writer = pdf.page(page_id);
            page_writer
                .parent(PAGES_ID)
                .media_box(Rect::new(0.0, 0.0, PAGE_WIDTH, PAGE_HEIGHT))
                .contents(*content);
            page_writer
                .resources()
                .fonts()
                .insert(Name(b"F1"))
                .primitive(TYPE0_FONT_ID);
        }

        Ok(pdf.finish())
    }

    fn to_unicode_cmap(&self) -> UnicodeCmap<u16> {
        let mut cmap = UnicodeCmap::new(
            Name(b"NotoSansToUnicode"),
            SystemInfo {
                registry: Str(b"Adobe"),
                ordering: Str(b"UCS"),
                supplement: 0,
            },
        );
        for (cid, character) in self.unicode_by_cid.iter().enumerate().skip(1) {
            cmap.pair(cid as u16, *character);
        }
        cmap
    }
}

struct Layout<'a> {
    font: &'a EmbeddedFont,
    content: Content,
    pages: Vec<Content>,
    y: f32,
    title: String,
}

impl<'a> Layout<'a> {
    fn new(font: &'a EmbeddedFont, title: &str) -> Result<Self, String> {
        let mut layout = Self {
            font,
            content: Content::new(),
            pages: Vec::new(),
            y: PAGE_HEIGHT - MARGIN,
            title: normalized_text(title),
        };
        let title_lines = wrap_text(&layout.title, BODY_WIDTH, 20.0, font)?;
        for line in title_lines {
            layout.ensure_space(25.0)?;
            layout.draw_text(&line, MARGIN, layout.y - 20.0, 20.0, (0.11, 0.17, 0.25))?;
            layout.y -= 25.0;
        }
        layout.y -= 8.0;
        Ok(layout)
    }

    fn paragraph(&mut self, text: &str) -> Result<(), String> {
        self.y -= 3.0;
        self.draw_wrapped(text, MARGIN, BODY_WIDTH, 10.5, 14.5, (0.12, 0.15, 0.18))?;
        self.y -= 9.0;
        Ok(())
    }

    fn heading(&mut self, text: &str, level: u8) -> Result<(), String> {
        if !(1..=6).contains(&level) {
            return Err(format!(
                "document-pdf-heading: heading level {level} is outside the supported range 1 to 6"
            ));
        }
        let font_size = match level {
            1 => 16.0,
            2 => 13.5,
            3 => 12.0,
            _ => 11.0,
        };
        let leading = font_size + 4.0;
        self.y -= if level == 1 { 10.0 } else { 7.0 };
        self.ensure_space(leading * 2.0)?;
        let indent = f32::from(level.saturating_sub(1)) * 5.0;
        self.draw_wrapped(
            text,
            MARGIN + indent,
            BODY_WIDTH - indent,
            font_size,
            leading,
            (0.12, 0.21, 0.31),
        )?;
        self.y -= 5.0;
        Ok(())
    }

    fn bullet_list(&mut self, items: &[String]) -> Result<(), String> {
        for item in items {
            let x = MARGIN + 17.0;
            let lines = wrap_text(item, BODY_WIDTH - 17.0, 10.5, self.font)?;
            for (line_index, line) in lines.iter().enumerate() {
                self.ensure_space(14.5)?;
                if line_index == 0 {
                    self.draw_text("•", MARGIN + 2.0, self.y - 10.5, 10.5, (0.12, 0.15, 0.18))?;
                }
                self.draw_text(line, x, self.y - 10.5, 10.5, (0.12, 0.15, 0.18))?;
                self.y -= 14.5;
            }
            self.y -= 3.0;
        }
        self.y -= 5.0;
        Ok(())
    }

    fn table(&mut self, headers: &[String], rows: &[Vec<String>]) -> Result<(), String> {
        let columns = headers.len();
        let column_widths = self.table_column_widths(headers, rows)?;
        let header_font = 8.8;
        let body_font = 8.6;
        let leading = 11.2;
        let padding = 4.0;
        let header_lines = headers
            .iter()
            .enumerate()
            .map(|(column, text)| {
                wrap_text(
                    text,
                    column_widths[column] - padding * 2.0,
                    header_font,
                    self.font,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let header_line_count = header_lines.iter().map(Vec::len).max().unwrap_or(1).max(1);
        let header_height = header_line_count as f32 * leading + padding * 2.0;
        if header_height + leading + padding * 2.0 > PAGE_HEIGHT - BOTTOM - MARGIN {
            return Err(
                "document-pdf-layout: table header is too tall to fit above a table row".into(),
            );
        }

        let total_width = column_widths.iter().sum::<f32>();
        let x_positions = column_widths
            .iter()
            .scan(MARGIN, |x, width| {
                let current = *x;
                *x += *width;
                Some(current)
            })
            .collect::<Vec<_>>();

        self.y -= 4.0;
        if self.y - BOTTOM < header_height + leading + padding * 2.0 {
            self.start_new_page()?;
        }
        self.draw_table_header(
            &header_lines,
            &x_positions,
            &column_widths,
            total_width,
            header_font,
            leading,
            padding,
            header_height,
        )?;

        for row in rows {
            let cells = row
                .iter()
                .enumerate()
                .map(|(column, text)| {
                    wrap_text(
                        text,
                        column_widths[column] - padding * 2.0,
                        body_font,
                        self.font,
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            let row_line_count = cells.iter().map(Vec::len).max().unwrap_or(1).max(1);
            let mut offset = 0;
            while offset < row_line_count {
                let available_height = self.y - BOTTOM;
                let available_lines = ((available_height - padding * 2.0) / leading).floor();
                if available_lines < 1.0 {
                    self.start_new_page()?;
                    self.draw_table_header(
                        &header_lines,
                        &x_positions,
                        &column_widths,
                        total_width,
                        header_font,
                        leading,
                        padding,
                        header_height,
                    )?;
                    continue;
                }

                let line_count = (row_line_count - offset)
                    .min(available_lines as usize)
                    .max(1);
                let chunk_height = line_count as f32 * leading + padding * 2.0;
                let top = self.y;
                for column in 0..columns {
                    for line_index in 0..line_count {
                        if let Some(line) = cells[column].get(offset + line_index) {
                            self.draw_text(
                                line,
                                x_positions[column] + padding,
                                top - padding - body_font - line_index as f32 * leading,
                                body_font,
                                (0.13, 0.15, 0.17),
                            )?;
                        }
                    }
                }

                let bottom = top - chunk_height;
                self.content
                    .set_stroke_rgb(0.82, 0.85, 0.88)
                    .set_line_width(0.45)
                    .move_to(MARGIN, bottom)
                    .line_to(MARGIN + total_width, bottom)
                    .stroke();
                self.y = bottom;
                offset += line_count;

                if offset < row_line_count {
                    self.start_new_page()?;
                    self.draw_table_header(
                        &header_lines,
                        &x_positions,
                        &column_widths,
                        total_width,
                        header_font,
                        leading,
                        padding,
                        header_height,
                    )?;
                }
            }
        }

        self.y -= 10.0;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_table_header(
        &mut self,
        lines: &[Vec<String>],
        x_positions: &[f32],
        widths: &[f32],
        total_width: f32,
        font_size: f32,
        leading: f32,
        padding: f32,
        height: f32,
    ) -> Result<(), String> {
        let top = self.y;
        self.content
            .set_fill_rgb(0.91, 0.94, 0.97)
            .rect(MARGIN, top - height, total_width, height)
            .fill_nonzero();
        for (column, column_lines) in lines.iter().enumerate() {
            for (line_index, line) in column_lines.iter().enumerate() {
                self.draw_text(
                    line,
                    x_positions[column] + padding,
                    top - padding - font_size - line_index as f32 * leading,
                    font_size,
                    (0.10, 0.16, 0.22),
                )?;
            }
            if column + 1 < widths.len() {
                let x = x_positions[column] + widths[column];
                self.content
                    .set_stroke_rgb(0.80, 0.84, 0.88)
                    .set_line_width(0.45)
                    .move_to(x, top - height)
                    .line_to(x, top)
                    .stroke();
            }
        }
        self.y -= height;
        Ok(())
    }

    fn table_column_widths(
        &self,
        headers: &[String],
        rows: &[Vec<String>],
    ) -> Result<Vec<f32>, String> {
        let count = headers.len();
        let equal = BODY_WIDTH / count as f32;
        let mut preferred = vec![equal; count];
        for column in 0..count {
            let header_width = self.font.measure(&headers[column], 8.6)?;
            let mut maximum = header_width.min(160.0);
            for row in rows {
                maximum = maximum.max(self.font.measure(&row[column], 8.6)?.min(160.0));
            }
            preferred[column] = equal.max(maximum + 10.0);
        }
        let sum = preferred.iter().sum::<f32>();
        if sum <= BODY_WIDTH {
            return Ok(preferred);
        }
        Ok(preferred
            .into_iter()
            .map(|width| width * BODY_WIDTH / sum)
            .collect())
    }

    fn draw_wrapped(
        &mut self,
        text: &str,
        x: f32,
        width: f32,
        font_size: f32,
        leading: f32,
        color: (f32, f32, f32),
    ) -> Result<(), String> {
        for line in wrap_text(text, width, font_size, self.font)? {
            self.ensure_space(leading)?;
            self.draw_text(&line, x, self.y - font_size, font_size, color)?;
            self.y -= leading;
        }
        Ok(())
    }

    fn draw_text(
        &mut self,
        text: &str,
        x: f32,
        baseline: f32,
        font_size: f32,
        color: (f32, f32, f32),
    ) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        let encoded = self.font.encode(text)?;
        self.content
            .begin_text()
            .set_fill_rgb(color.0, color.1, color.2)
            .set_font(Name(b"F1"), font_size)
            .set_text_matrix([1.0, 0.0, 0.0, 1.0, x, baseline])
            .show(Str(&encoded))
            .end_text();
        Ok(())
    }

    fn ensure_space(&mut self, height: f32) -> Result<(), String> {
        if self.y - height < BOTTOM {
            self.start_new_page()?;
        }
        Ok(())
    }

    fn start_new_page(&mut self) -> Result<(), String> {
        if self.pages.len() + 1 >= MAX_PAGES {
            return Err(format!(
                "document-pdf-limit: document exceeds the {MAX_PAGES}-page limit"
            ));
        }
        self.pages
            .push(std::mem::replace(&mut self.content, Content::new()));
        self.y = PAGE_HEIGHT - MARGIN;
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<Content>, String> {
        let total_pages = self.pages.len() + 1;
        if total_pages > MAX_PAGES {
            return Err(format!(
                "document-pdf-limit: document exceeds the {MAX_PAGES}-page limit"
            ));
        }
        let mut pages = std::mem::take(&mut self.pages);
        pages.push(self.content);
        for (index, page) in pages.iter_mut().enumerate() {
            let number = format!("{} / {}", index + 1, total_pages);
            page.set_stroke_rgb(0.78, 0.81, 0.84)
                .set_line_width(0.5)
                .move_to(MARGIN, MARGIN)
                .line_to(PAGE_WIDTH - MARGIN, MARGIN)
                .stroke();
            let encoded = self.font.encode(&number)?;
            let number_width = self.font.measure(&number, 8.5)?;
            page.begin_text()
                .set_fill_rgb(0.38, 0.42, 0.47)
                .set_font(Name(b"F1"), 8.5)
                .set_text_matrix([1.0, 0.0, 0.0, 1.0, PAGE_WIDTH - MARGIN - number_width, 22.0])
                .show(Str(&encoded))
                .end_text();
        }
        Ok(pages)
    }
}

fn wrap_text(
    text: &str,
    max_width: f32,
    font_size: f32,
    font: &EmbeddedFont,
) -> Result<Vec<String>, String> {
    let normalized = normalized_text(text);
    let mut output = Vec::new();
    for paragraph in normalized.split('\n') {
        if paragraph.trim().is_empty() {
            output.push(String::new());
            continue;
        }

        let mut line = String::new();
        let mut line_width = 0.0;
        let space_width = font.advance(' ', font_size)?;
        for word in paragraph.split_whitespace() {
            let word_width = font.measure(word, font_size)?;
            let separator_width = if line.is_empty() { 0.0 } else { space_width };
            if line_width + separator_width + word_width <= max_width {
                if !line.is_empty() {
                    line.push(' ');
                    line_width += space_width;
                }
                line.push_str(word);
                line_width += word_width;
                continue;
            }

            if !line.is_empty() {
                output.push(std::mem::take(&mut line));
                line_width = 0.0;
            }

            for character in word.chars() {
                let advance = font.advance(character, font_size)?;
                if !line.is_empty() && line_width + advance > max_width {
                    output.push(std::mem::take(&mut line));
                    line_width = 0.0;
                }
                line.push(character);
                line_width += advance;
                if line_width > max_width && line.chars().count() == 1 {
                    output.push(std::mem::take(&mut line));
                    line_width = 0.0;
                }
            }
        }
        if !line.is_empty() {
            output.push(line);
        } else if paragraph.trim().is_empty() {
            output.push(String::new());
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(title: &str, blocks: Vec<DocumentBlock>) -> TextDocument {
        TextDocument {
            title: title.to_string(),
            blocks,
        }
    }

    fn count_bytes(haystack: &[u8], needle: &[u8]) -> usize {
        haystack
            .windows(needle.len())
            .filter(|window| *window == needle)
            .count()
    }

    #[test]
    fn embeds_searchable_unicode_font_and_document_metadata() {
        let pdf = build(&document(
            "Отчёт Aplot",
            vec![DocumentBlock::Paragraph {
                text: "Привет, мир! Unicode PDF.".into(),
            }],
        ))
        .expect("valid Unicode document");

        assert!(pdf.starts_with(b"%PDF-1.7"));
        assert!(pdf
            .windows(b"/Type0".len())
            .any(|window| window == b"/Type0"));
        assert!(pdf
            .windows(b"/FontFile2".len())
            .any(|window| window == b"/FontFile2"));
        assert!(pdf
            .windows(b"/ToUnicode".len())
            .any(|window| window == b"/ToUnicode"));
        assert!(pdf.windows(b"/Info".len()).any(|window| window == b"/Info"));
        assert!(pdf
            .windows(b"/Length1".len())
            .any(|window| window == b"/Length1"));
        assert!(pdf
            .windows(b"<041E>".len())
            .any(|window| window == b"<041E>")); // Cyrillic capital O in ToUnicode.
    }

    #[test]
    fn wraps_long_words_and_splits_tall_table_rows_across_pages() {
        let long_word = "длинноеслово".repeat(260);
        let pdf = build(&document(
            "Таблица",
            vec![DocumentBlock::Table {
                headers: vec!["Ключ".into(), "Значение".into()],
                rows: vec![vec!["один".into(), long_word]],
            }],
        ))
        .expect("bounded table can wrap and paginate");

        let page_count = count_bytes(&pdf, b"/Type /Page\n");
        assert!(page_count > 1, "expected row to split across pages");
        assert!(page_count <= MAX_PAGES);
    }

    #[test]
    fn rejects_unsupported_glyphs_with_a_specific_error() {
        let error = build(&document(
            "Unsupported glyph",
            vec![DocumentBlock::Paragraph { text: "漢".into() }],
        ))
        .expect_err("Noto Sans regular does not cover CJK");
        assert!(error.starts_with("document-pdf-glyph:"), "{error}");
        assert!(error.contains("U+6F22"), "{error}");
    }

    #[test]
    fn enforces_document_and_table_bounds() {
        let too_many_blocks = document(
            "Bounded",
            (0..=MAX_BLOCKS)
                .map(|_| DocumentBlock::Paragraph {
                    text: String::new(),
                })
                .collect(),
        );
        assert!(build(&too_many_blocks)
            .expect_err("block count is bounded")
            .contains("blocks"));

        let mismatched_table = document(
            "Bounded",
            vec![DocumentBlock::Table {
                headers: vec!["A".into(), "B".into()],
                rows: vec![vec!["only one cell".into()]],
            }],
        );
        assert!(build(&mismatched_table)
            .expect_err("rows must match table width")
            .contains("expected 2"));
    }
}
