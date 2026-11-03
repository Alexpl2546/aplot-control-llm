//! Bounded XLSX workbook generation for the local document writer.
//!
//! Strings are always emitted as explicit inline strings, so text that begins
//! with `=`, `+`, `-`, or `@` remains text. Formula values have a small parser
//! and allow-list; formulas are stored for Excel to recalculate and are never
//! evaluated here. Quoted formula strings, named ranges, and sheet or external
//! references are outside the supported formula subset.

use std::io::{self, Cursor, Seek, SeekFrom, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::document_spec::{CellValue, WorkbookDocument, WorkbookSheet};

const MAX_SHEETS: usize = 16;
const MAX_COLUMNS: usize = 128;
const MAX_ROWS: usize = 2_000;
const MAX_CELLS: usize = 10_000;
const MAX_TEXT_BYTES: usize = 64_000;
const MAX_FORMULA_BYTES: usize = 512;
const MAX_OUTPUT_BYTES: u64 = 10 * 1024 * 1024;
const XLSX_MAX_COLUMNS: u32 = 16_384;
const XLSX_MAX_ROWS: u32 = 1_048_576;

const MAIN_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const OFFICE_REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";

/// Builds an Office Open XML workbook package from a bounded declarative spec.
pub(crate) fn build(document: &WorkbookDocument) -> Result<Vec<u8>, String> {
    validate_document(document)?;

    let mut zip = ZipWriter::new(BoundedCursor::default());
    write_part(
        &mut zip,
        "[Content_Types].xml",
        write_content_types(document),
    )?;
    write_part(&mut zip, "_rels/.rels", write_package_relationships())?;
    write_part(
        &mut zip,
        "docProps/core.xml",
        write_core_properties(document),
    )?;
    write_part(&mut zip, "xl/workbook.xml", write_workbook(document))?;
    write_part(
        &mut zip,
        "xl/_rels/workbook.xml.rels",
        write_workbook_relationships(document),
    )?;
    write_part(&mut zip, "xl/styles.xml", write_styles())?;
    for (index, sheet) in document.sheets.iter().enumerate() {
        let path = format!("xl/worksheets/sheet{}.xml", index + 1);
        zip.start_file(&path, file_options())
            .map_err(|error| format!("could not add XLSX worksheet: {error}"))?;
        write_worksheet(&mut zip, sheet)
            .map_err(|error| format!("could not write XLSX worksheet: {error}"))?;
    }

    let output = zip
        .finish()
        .map_err(|error| format!("could not finish XLSX package: {error}"))?;
    let bytes = output.0.into_inner();
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err(format!(
            "XLSX output exceeds the {MAX_OUTPUT_BYTES}-byte limit"
        ));
    }
    Ok(bytes)
}

fn validate_document(document: &WorkbookDocument) -> Result<(), String> {
    validate_text("workbook title", &document.title)?;
    if document.sheets.is_empty() || document.sheets.len() > MAX_SHEETS {
        return Err(format!(
            "workbook must contain between 1 and {MAX_SHEETS} sheets"
        ));
    }

    let mut names = std::collections::HashSet::new();
    let mut total_cells = 0usize;
    for sheet in &document.sheets {
        validate_sheet_name(&sheet.name)?;
        if !names.insert(sheet.name.to_lowercase()) {
            return Err(format!("worksheet name is duplicated: {}", sheet.name));
        }
        if sheet.columns.is_empty() || sheet.columns.len() > MAX_COLUMNS {
            return Err(format!(
                "worksheet {} must contain between 1 and {MAX_COLUMNS} columns",
                sheet.name
            ));
        }
        if sheet.rows.len() > MAX_ROWS {
            return Err(format!(
                "worksheet {} exceeds the {MAX_ROWS}-row limit",
                sheet.name
            ));
        }
        let rows_with_header = sheet
            .rows
            .len()
            .checked_add(1)
            .ok_or_else(|| "worksheet row count overflow".to_string())?;
        let sheet_cells = sheet
            .columns
            .len()
            .checked_mul(rows_with_header)
            .ok_or_else(|| "worksheet cell count overflow".to_string())?;
        total_cells = total_cells
            .checked_add(sheet_cells)
            .ok_or_else(|| "workbook cell count overflow".to_string())?;
        if total_cells > MAX_CELLS {
            return Err(format!("workbook exceeds the {MAX_CELLS}-cell limit"));
        }

        for heading in &sheet.columns {
            validate_text("column heading", heading)?;
        }
        for (row_index, row) in sheet.rows.iter().enumerate() {
            if row.len() != sheet.columns.len() {
                return Err(format!(
                    "worksheet {} row {} has {} cells; expected {}",
                    sheet.name,
                    row_index + 1,
                    row.len(),
                    sheet.columns.len()
                ));
            }
            for cell in row {
                match cell {
                    CellValue::Text(text) => validate_text("cell text", text)?,
                    CellValue::Number(number) if !number.is_finite() => {
                        return Err("XLSX numeric cells must be finite".to_string());
                    }
                    CellValue::Formula(formula) => {
                        validate_formula(&formula.formula)?;
                    }
                    CellValue::Number(_) | CellValue::Boolean(_) | CellValue::Empty(()) => {}
                }
            }
        }
    }
    Ok(())
}

fn validate_text(label: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_TEXT_BYTES {
        return Err(format!("{label} exceeds the {MAX_TEXT_BYTES}-byte limit"));
    }
    if !value.chars().all(is_valid_xml_char) {
        return Err(format!("{label} contains a character forbidden by XML 1.0"));
    }
    Ok(())
}

fn validate_sheet_name(name: &str) -> Result<(), String> {
    validate_text("worksheet name", name)?;
    let utf16_length = name.encode_utf16().count();
    if name.is_empty() || utf16_length > 31 {
        return Err("worksheet names must contain between 1 and 31 UTF-16 code units".to_string());
    }
    if name.starts_with('\'') || name.ends_with('\'') {
        return Err("worksheet names cannot begin or end with an apostrophe".to_string());
    }
    if name.eq_ignore_ascii_case("History") {
        return Err("worksheet name History is reserved by Excel".to_string());
    }
    if name.chars().any(|character| {
        character.is_control() || matches!(character, '[' | ']' | ':' | '*' | '?' | '/' | '\\')
    }) {
        return Err("worksheet name contains a character Excel does not allow".to_string());
    }
    Ok(())
}

fn is_valid_xml_char(character: char) -> bool {
    matches!(character, '\u{9}' | '\u{A}' | '\u{D}')
        || ('\u{20}'..='\u{D7FF}').contains(&character)
        || ('\u{E000}'..='\u{FFFD}').contains(&character)
        || ('\u{10000}'..='\u{10FFFF}').contains(&character)
}

fn validate_formula(formula: &str) -> Result<(), String> {
    if formula.len() > MAX_FORMULA_BYTES {
        return Err(format!(
            "formula exceeds the {MAX_FORMULA_BYTES}-byte limit"
        ));
    }
    let formula = formula.strip_prefix('=').unwrap_or(formula);
    if formula.is_empty() {
        return Err("formula cannot be empty".to_string());
    }
    FormulaParser::new(formula).parse()
}

struct FormulaParser<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> FormulaParser<'a> {
    fn new(formula: &'a str) -> Self {
        Self {
            bytes: formula.as_bytes(),
            position: 0,
        }
    }

    fn parse(mut self) -> Result<(), String> {
        if !self.bytes.is_ascii() {
            return Err("formulas may contain only ASCII syntax and cell references".to_string());
        }
        self.parse_comparison()?;
        self.skip_whitespace();
        if self.position != self.bytes.len() {
            return Err(format!(
                "formula contains unsupported syntax near byte {}",
                self.position + 1
            ));
        }
        Ok(())
    }

    fn parse_comparison(&mut self) -> Result<(), String> {
        self.parse_additive()?;
        self.skip_whitespace();
        if self.consume(b"<=")
            || self.consume(b">=")
            || self.consume(b"<>")
            || self.consume(b"=")
            || self.consume(b"<")
            || self.consume(b">")
        {
            self.parse_additive()?;
        }
        Ok(())
    }

    fn parse_additive(&mut self) -> Result<(), String> {
        self.parse_multiplicative()?;
        loop {
            self.skip_whitespace();
            if self.consume(b"+") || self.consume(b"-") {
                self.parse_multiplicative()?;
            } else {
                return Ok(());
            }
        }
    }

    fn parse_multiplicative(&mut self) -> Result<(), String> {
        self.parse_power()?;
        loop {
            self.skip_whitespace();
            if self.consume(b"*") || self.consume(b"/") {
                self.parse_power()?;
            } else {
                return Ok(());
            }
        }
    }

    fn parse_power(&mut self) -> Result<(), String> {
        self.parse_unary()?;
        self.skip_whitespace();
        if self.consume(b"^") {
            self.parse_power()?;
        }
        Ok(())
    }

    fn parse_unary(&mut self) -> Result<(), String> {
        self.skip_whitespace();
        if self.consume(b"+") || self.consume(b"-") {
            return self.parse_unary();
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<(), String> {
        self.skip_whitespace();
        if self.consume(b"(") {
            self.parse_comparison()?;
            self.skip_whitespace();
            if !self.consume(b")") {
                return Err("formula is missing a closing parenthesis".to_string());
            }
            return Ok(());
        }
        if self
            .peek()
            .is_some_and(|byte| byte.is_ascii_digit() || *byte == b'.')
        {
            return self.parse_number();
        }
        if self
            .peek()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'$')
        {
            return self.parse_cell_or_function();
        }
        Err(
            "formula expected a number, cell reference, function, or parenthesized expression"
                .to_string(),
        )
    }

    fn parse_number(&mut self) -> Result<(), String> {
        let start = self.position;
        let mut digits = 0usize;
        while self.peek().is_some_and(u8::is_ascii_digit) {
            self.position += 1;
            digits += 1;
        }
        if self.consume(b".") {
            while self.peek().is_some_and(u8::is_ascii_digit) {
                self.position += 1;
                digits += 1;
            }
        }
        if digits == 0 {
            return Err("formula contains an invalid number".to_string());
        }
        if self
            .peek()
            .is_some_and(|byte| *byte == b'e' || *byte == b'E')
        {
            self.position += 1;
            if self
                .peek()
                .is_some_and(|byte| *byte == b'+' || *byte == b'-')
            {
                self.position += 1;
            }
            let exponent_start = self.position;
            while self.peek().is_some_and(u8::is_ascii_digit) {
                self.position += 1;
            }
            if exponent_start == self.position {
                return Err("formula contains an invalid exponent".to_string());
            }
        }
        let parsed = std::str::from_utf8(&self.bytes[start..self.position])
            .ok()
            .and_then(|text| text.parse::<f64>().ok());
        if !parsed.is_some_and(f64::is_finite) {
            return Err("formula numeric literals must be finite".to_string());
        }
        Ok(())
    }

    fn parse_cell_or_function(&mut self) -> Result<(), String> {
        let start = self.position;
        let has_leading_dollar = self.consume(b"$");
        let column_start = self.position;
        while self.peek().is_some_and(u8::is_ascii_alphabetic) {
            self.position += 1;
        }
        if column_start == self.position {
            return Err("formula contains an invalid cell reference".to_string());
        }
        let column_bytes = &self.bytes[column_start..self.position];
        let has_row_dollar = self.consume(b"$");
        let row_start = self.position;
        while self.peek().is_some_and(u8::is_ascii_digit) {
            self.position += 1;
        }

        if row_start != self.position {
            let column = parse_column_number(column_bytes)?;
            let row_text = std::str::from_utf8(&self.bytes[row_start..self.position])
                .map_err(|_| "formula contains an invalid cell row".to_string())?;
            if row_text.starts_with('0') {
                return Err("formula cell rows must start at 1 without leading zeroes".to_string());
            }
            let row = row_text
                .parse::<u32>()
                .map_err(|_| "formula cell row is outside Excel's bounds".to_string())?;
            if column == 0 || column > XLSX_MAX_COLUMNS || row == 0 || row > XLSX_MAX_ROWS {
                return Err(
                    "formula cell reference is outside Excel's worksheet bounds".to_string()
                );
            }
            self.skip_whitespace();
            if self.consume(b":") {
                self.skip_whitespace();
                self.parse_required_cell_reference()?;
            }
            return Ok(());
        }

        if has_leading_dollar || has_row_dollar {
            return Err("absolute markers require a complete cell reference".to_string());
        }
        self.position = start;
        let identifier_start = self.position;
        while self.peek().is_some_and(u8::is_ascii_alphabetic) {
            self.position += 1;
        }
        let identifier = std::str::from_utf8(&self.bytes[identifier_start..self.position])
            .map_err(|_| "formula contains an invalid function name".to_string())?
            .to_ascii_uppercase();
        self.skip_whitespace();
        if !self.consume(b"(") {
            return Err(format!(
                "formula name {identifier} is not an allowed function"
            ));
        }
        if !matches!(
            identifier.as_str(),
            "SUM" | "AVERAGE" | "MIN" | "MAX" | "COUNT" | "ROUND" | "IF"
        ) {
            return Err(format!("formula function {identifier} is not allowed"));
        }

        let mut argument_count = 0usize;
        self.skip_whitespace();
        if !self.consume(b")") {
            loop {
                self.parse_comparison()?;
                argument_count += 1;
                self.skip_whitespace();
                if self.consume(b")") {
                    break;
                }
                if !self.consume(b",") {
                    return Err("formula function arguments must be comma-separated".to_string());
                }
            }
        }
        let valid_arity = match identifier.as_str() {
            "ROUND" => argument_count == 2,
            "IF" => argument_count == 3,
            _ => argument_count > 0,
        };
        if !valid_arity {
            return Err(format!(
                "formula function {identifier} has an invalid number of arguments"
            ));
        }
        Ok(())
    }

    fn parse_required_cell_reference(&mut self) -> Result<(), String> {
        let _ = self.consume(b"$");
        let column_start = self.position;
        while self.peek().is_some_and(u8::is_ascii_alphabetic) {
            self.position += 1;
        }
        if column_start == self.position {
            return Err("formula ranges must end in a cell reference".to_string());
        }
        let column = parse_column_number(&self.bytes[column_start..self.position])?;
        let _ = self.consume(b"$");
        let row_start = self.position;
        while self.peek().is_some_and(u8::is_ascii_digit) {
            self.position += 1;
        }
        if row_start == self.position {
            return Err("formula ranges must end in a cell reference".to_string());
        }
        let row_text = std::str::from_utf8(&self.bytes[row_start..self.position])
            .map_err(|_| "formula contains an invalid cell row".to_string())?;
        if row_text.starts_with('0') {
            return Err("formula cell rows must start at 1 without leading zeroes".to_string());
        }
        let row = row_text
            .parse::<u32>()
            .map_err(|_| "formula cell row is outside Excel's bounds".to_string())?;
        if column == 0 || column > XLSX_MAX_COLUMNS || row == 0 || row > XLSX_MAX_ROWS {
            return Err("formula cell reference is outside Excel's worksheet bounds".to_string());
        }
        Ok(())
    }

    fn skip_whitespace(&mut self) {
        while self
            .peek()
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.position += 1;
        }
    }

    fn consume(&mut self, token: &[u8]) -> bool {
        if self.bytes[self.position..].starts_with(token) {
            self.position += token.len();
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<&u8> {
        self.bytes.get(self.position)
    }
}

fn parse_column_number(bytes: &[u8]) -> Result<u32, String> {
    let mut value = 0u32;
    for byte in bytes {
        let upper = byte.to_ascii_uppercase();
        if !upper.is_ascii_uppercase() {
            return Err("formula contains an invalid cell column".to_string());
        }
        value = value
            .checked_mul(26)
            .and_then(|value| value.checked_add(u32::from(upper - b'A' + 1)))
            .ok_or_else(|| "formula cell column is outside Excel's bounds".to_string())?;
    }
    Ok(value)
}

fn file_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

fn write_part(zip: &mut ZipWriter<BoundedCursor>, path: &str, xml: String) -> Result<(), String> {
    zip.start_file(path, file_options())
        .map_err(|error| format!("could not add XLSX package part {path}: {error}"))?;
    zip.write_all(xml.as_bytes())
        .map_err(|error| format!("could not write XLSX package part {path}: {error}"))
}

fn write_content_types(document: &WorkbookDocument) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         <Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
         <Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>\
         <Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>",
    );
    for index in 0..document.sheets.len() {
        xml.push_str(&format!(
            "<Override PartName=\"/xl/worksheets/sheet{}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
            index + 1
        ));
    }
    xml.push_str("</Types>");
    xml
}

fn write_package_relationships() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"{PACKAGE_REL_NS}\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
         </Relationships>"
    )
}

fn write_core_properties(document: &WorkbookDocument) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\
         <dc:title>{}</dc:title><dc:creator>Aplot Control</dc:creator>\
         </cp:coreProperties>",
        escape_xml_text(&document.title)
    )
}

fn write_workbook(document: &WorkbookDocument) -> String {
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <workbook xmlns=\"{MAIN_NS}\" xmlns:r=\"{OFFICE_REL_NS}\">\
         <bookViews><workbookView activeTab=\"0\"/></bookViews><sheets>"
    );
    for (index, sheet) in document.sheets.iter().enumerate() {
        xml.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{}\" r:id=\"rId{}\"/>",
            escape_xml_attribute(&sheet.name),
            index + 1,
            index + 1
        ));
    }
    xml.push_str(&format!(
        "</sheets><calcPr calcMode=\"auto\" fullCalcOnLoad=\"1\" forceFullCalc=\"1\"/></workbook>"
    ));
    xml
}

fn write_workbook_relationships(document: &WorkbookDocument) -> String {
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"{PACKAGE_REL_NS}\">"
    );
    for index in 0..document.sheets.len() {
        xml.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"{OFFICE_REL_NS}/worksheet\" Target=\"worksheets/sheet{}.xml\"/>",
            index + 1,
            index + 1
        ));
    }
    xml.push_str(&format!(
        "<Relationship Id=\"rId{}\" Type=\"{OFFICE_REL_NS}/styles\" Target=\"styles.xml\"/></Relationships>",
        document.sheets.len() + 1
    ));
    xml
}

fn write_styles() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <styleSheet xmlns=\"{MAIN_NS}\">\
         <fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font></fonts>\
         <fills count=\"3\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF1F4E78\"/><bgColor indexed=\"64\"/></patternFill></fill></fills>\
         <borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>\
         <cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>\
         <cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"2\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\"/></cellXfs>\
         <cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles><dxfs count=\"0\"/>\
         <tableStyles count=\"0\" defaultTableStyle=\"TableStyleMedium2\" defaultPivotStyle=\"PivotStyleLight16\"/>\
         </styleSheet>"
    )
}

fn write_worksheet<W: Write>(writer: &mut W, sheet: &WorkbookSheet) -> io::Result<()> {
    let final_row = sheet.rows.len() + 1;
    let final_column = column_name(sheet.columns.len() as u32);
    let mut widths = vec![10usize; sheet.columns.len()];
    for (index, heading) in sheet.columns.iter().enumerate() {
        widths[index] = widths[index].max(display_width(heading));
    }
    for row in &sheet.rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(cell_display_width(cell));
        }
    }
    write!(
        writer,
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <worksheet xmlns=\"{MAIN_NS}\"><dimension ref=\"A1:{final_column}{final_row}\"/>\
         <sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/><selection pane=\"bottomLeft\" activeCell=\"A2\" sqref=\"A2\"/></sheetView></sheetViews>\
         <sheetFormatPr defaultRowHeight=\"15\"/><cols>"
    )?;
    for (index, width) in widths.iter().enumerate() {
        let width = width.saturating_add(2).clamp(10, 60);
        let column = index + 1;
        write!(
            writer,
            "<col min=\"{column}\" max=\"{column}\" width=\"{width}.0\" customWidth=\"1\"/>"
        )?;
    }
    write!(writer, "</cols><sheetData><row r=\"1\">")?;
    for (column, heading) in sheet.columns.iter().enumerate() {
        write_inline_string(writer, &cell_reference(column, 1), heading, true)?;
    }
    write!(writer, "</row>")?;
    for (row_index, row) in sheet.rows.iter().enumerate() {
        let row_number = row_index + 2;
        write!(writer, "<row r=\"{row_number}\">")?;
        for (column, cell) in row.iter().enumerate() {
            write_cell(writer, &cell_reference(column, row_number), cell)?;
        }
        write!(writer, "</row>")?;
    }
    write!(
        writer,
        "</sheetData><autoFilter ref=\"A1:{final_column}{final_row}\"/></worksheet>"
    )
}

fn write_inline_string<W: Write>(
    writer: &mut W,
    reference: &str,
    text: &str,
    header: bool,
) -> io::Result<()> {
    let style = if header { " s=\"1\"" } else { "" };
    write!(
        writer,
        "<c r=\"{reference}\"{style} t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
        escape_xml_text(text)
    )
}

fn write_cell<W: Write>(writer: &mut W, reference: &str, cell: &CellValue) -> io::Result<()> {
    match cell {
        CellValue::Text(text) => write_inline_string(writer, reference, text, false),
        CellValue::Number(number) => {
            write!(writer, "<c r=\"{reference}\" t=\"n\"><v>{number}</v></c>")
        }
        CellValue::Boolean(value) => write!(
            writer,
            "<c r=\"{reference}\" t=\"b\"><v>{}</v></c>",
            if *value { 1 } else { 0 }
        ),
        CellValue::Empty(()) => write!(writer, "<c r=\"{reference}\"/>"),
        CellValue::Formula(formula) => {
            let formula = formula
                .formula
                .strip_prefix('=')
                .unwrap_or(&formula.formula);
            write!(
                writer,
                "<c r=\"{reference}\"><f>{}</f></c>",
                escape_xml_text(formula)
            )
        }
    }
}

fn cell_display_width(cell: &CellValue) -> usize {
    match cell {
        CellValue::Text(text) => display_width(text),
        CellValue::Number(number) => display_width(&number.to_string()),
        CellValue::Boolean(value) => {
            if *value {
                4
            } else {
                5
            }
        }
        CellValue::Empty(()) => 0,
        CellValue::Formula(formula) => display_width(&formula.formula),
    }
}

fn display_width(text: &str) -> usize {
    text.chars().count().min(60)
}

fn cell_reference(column: usize, row: usize) -> String {
    format!("{}{}", column_name(column as u32 + 1), row)
}

fn column_name(mut column: u32) -> String {
    let mut name = Vec::with_capacity(3);
    while column > 0 {
        column -= 1;
        name.push((b'A' + (column % 26) as u8) as char);
        column /= 26;
    }
    name.iter().rev().collect()
}

fn escape_xml_text(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn escape_xml_attribute(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[derive(Default)]
struct BoundedCursor(Cursor<Vec<u8>>);

impl Write for BoundedCursor {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let end = self
            .0
            .position()
            .checked_add(buffer.len() as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "XLSX output size overflow"))?;
        if end > MAX_OUTPUT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("XLSX output exceeds the {MAX_OUTPUT_BYTES}-byte limit"),
            ));
        }
        self.0.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl Seek for BoundedCursor {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.0.seek(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_spec::FormulaCell;
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    use std::io::Read;
    use std::path::PathBuf;
    use zip::read::ZipArchive;

    fn sample_document() -> WorkbookDocument {
        WorkbookDocument {
            title: "Quarterly <sales> & planning".to_string(),
            sheets: vec![
                WorkbookSheet {
                    name: "Résumé & data".to_string(),
                    columns: vec![
                        "Name".to_string(),
                        "Amount".to_string(),
                        "Check".to_string(),
                    ],
                    rows: vec![
                        vec![
                            CellValue::Text("=HYPERLINK(\"https://bad\",\"x\")".to_string()),
                            CellValue::Number(12.5),
                            CellValue::Formula(FormulaCell {
                                formula: "=IF(B2>10,ROUND(B2/2,1),0)".to_string(),
                            }),
                        ],
                        vec![
                            CellValue::Text("A < B & C".to_string()),
                            CellValue::Boolean(false),
                            CellValue::Empty(()),
                        ],
                    ],
                },
                WorkbookSheet {
                    name: "第二シート".to_string(),
                    columns: vec!["München".to_string()],
                    rows: vec![vec![CellValue::Text("雪 & <sun>".to_string())]],
                },
            ],
        }
    }

    fn package(bytes: &[u8]) -> ZipArchive<Cursor<&[u8]>> {
        ZipArchive::new(Cursor::new(bytes)).expect("valid ZIP package")
    }

    fn read_part(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> String {
        let mut file = archive.by_name(name).expect("package part exists");
        let mut xml = String::new();
        file.read_to_string(&mut xml).expect("read package part");
        xml
    }

    fn assert_valid_xml(xml: &str) {
        let mut reader = Reader::from_reader(xml.as_bytes());
        reader.config_mut().enable_all_checks(true);
        loop {
            match reader.read_event() {
                Ok(Event::Eof) => break,
                Ok(_) => {}
                Err(error) => panic!("invalid XML: {error}"),
            }
        }
    }

    #[test]
    fn builds_a_well_formed_workbook_package_with_ordered_sheets_and_cells() {
        let bytes = build(&sample_document()).expect("build workbook");
        let mut archive = package(&bytes);
        for name in [
            "[Content_Types].xml",
            "_rels/.rels",
            "docProps/core.xml",
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/styles.xml",
            "xl/worksheets/sheet1.xml",
            "xl/worksheets/sheet2.xml",
        ] {
            assert_valid_xml(&read_part(&mut archive, name));
        }
        let workbook = read_part(&mut archive, "xl/workbook.xml");
        assert!(workbook.contains("name=\"Résumé &amp; data\""));
        assert!(workbook.contains("name=\"第二シート\""));
        assert!(workbook.find("Résumé &amp; data").unwrap() < workbook.find("第二シート").unwrap());
        assert!(workbook.contains("calcMode=\"auto\""));
        let worksheet = read_part(&mut archive, "xl/worksheets/sheet1.xml");
        assert!(worksheet.contains("r=\"C3\""));
        assert!(worksheet.contains("<f>IF(B2&gt;10,ROUND(B2/2,1),0)</f>"));
        assert!(worksheet.contains("state=\"frozen\""));
        assert!(worksheet.contains("<autoFilter ref=\"A1:C3\"/>"));
        let second_sheet = read_part(&mut archive, "xl/worksheets/sheet2.xml");
        assert!(second_sheet.contains("<c r=\"A2\" t=\"inlineStr\">"));
        assert!(second_sheet.contains("雪 &amp; &lt;sun&gt;"));
        assert_eq!(cell_reference(26, 27), "AA27");
        assert_eq!(column_name(128), "DX");
    }

    #[test]
    fn spreadsheet_text_is_written_as_text_even_when_it_looks_like_a_formula() {
        let bytes = build(&sample_document()).expect("build workbook");
        let mut archive = package(&bytes);
        let worksheet = read_part(&mut archive, "xl/worksheets/sheet1.xml");
        assert!(worksheet.contains(
            "<c r=\"A2\" t=\"inlineStr\"><is><t xml:space=\"preserve\">=HYPERLINK(\"https://bad\",\"x\")</t></is></c>"
        ));
        assert!(!worksheet.contains("<f>HYPERLINK"));
    }

    #[test]
    fn deserializes_untagged_cell_values_and_formula_objects_without_ambiguity() {
        let document: WorkbookDocument = serde_json::from_value(serde_json::json!({
            "title": "Serialized",
            "sheets": [{
                "name": "Data",
                "columns": ["Text", "Number", "Boolean", "Empty", "Formula"],
                "rows": [[
                    "=SUM(1,2)",
                    3.5,
                    true,
                    null,
                    { "formula": "=SUM(1,2)" }
                ]]
            }]
        }))
        .expect("deserialize workbook spec");
        let row = &document.sheets[0].rows[0];
        assert!(matches!(&row[0], CellValue::Text(text) if text == "=SUM(1,2)"));
        assert!(matches!(&row[1], CellValue::Number(value) if *value == 3.5));
        assert!(matches!(&row[2], CellValue::Boolean(true)));
        assert!(matches!(&row[3], CellValue::Empty(())));
        assert!(matches!(&row[4], CellValue::Formula(formula) if formula.formula == "=SUM(1,2)"));

        let bytes = build(&document).expect("build deserialized workbook");
        let mut archive = package(&bytes);
        let worksheet = read_part(&mut archive, "xl/worksheets/sheet1.xml");
        assert!(worksheet.contains("<f>SUM(1,2)</f>"));
        assert!(worksheet.contains("<c r=\"A2\" t=\"inlineStr\">"));
    }

    #[test]
    fn formula_parser_accepts_only_complete_allow_list_expressions() {
        for formula in [
            "SUM(A1:A8)",
            "=AVERAGE($A$1,B2)+MIN(C2:C9)",
            "IF(A1>=0,ROUND(A1/2,2),MAX(1,2,3))",
            "COUNT(A1:B8)<>0",
            "-2^3+4*5/2",
        ] {
            validate_formula(formula).unwrap_or_else(|error| panic!("{formula}: {error}"));
        }
        for formula in [
            "SUM(A1)WEBSERVICE(A2)",
            "SUM(A1)junk",
            "SUM1(A1)",
            "MYFUNC(A1)",
            "HYPERLINK(A1,B1)",
            "WEBSERVICE(A1)",
            "SUM([Book.xlsx]Sheet1!A1)",
            "SUM(Sheet2!A1)",
            "IF(A1>0,\"yes\",\"no\")",
            "SUM(A1)+DDE(A2)",
            "A1 name",
            "XFE1",
            "A1048577",
            "A0",
            "SUM()",
            "ROUND(1)",
            "IF(1,2)",
        ] {
            assert!(
                validate_formula(formula).is_err(),
                "accepted unsafe formula: {formula}"
            );
        }
    }

    #[test]
    fn rejects_malformed_shapes_and_out_of_bounds_values() {
        let mut document = sample_document();
        document.sheets[0].rows[0].pop();
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets[0].name = "bad/name".to_string();
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets[0].name = "history".to_string();
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets.push(document.sheets[0].clone());
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets[0].rows[0][1] = CellValue::Number(f64::NAN);
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets[0].rows[0][0] = CellValue::Text("x".repeat(MAX_TEXT_BYTES + 1));
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets[0].name = "Data".to_string();
        document.sheets[1].name = "data".to_string();
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets[0].rows[0][2] = CellValue::Formula(FormulaCell {
            formula: format!("SUM(A1){}", " ".repeat(MAX_FORMULA_BYTES)),
        });
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets = (0..=MAX_SHEETS)
            .map(|index| WorkbookSheet {
                name: format!("Sheet {index}"),
                columns: vec!["A".to_string()],
                rows: Vec::new(),
            })
            .collect();
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets[0].columns = vec!["A".to_string(); MAX_COLUMNS + 1];
        document.sheets[0].rows.clear();
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets[0].columns = vec!["A".to_string()];
        document.sheets[0].rows = vec![vec![CellValue::Empty(())]; MAX_ROWS + 1];
        document.sheets.truncate(1);
        assert!(build(&document).is_err());

        let mut document = sample_document();
        document.sheets[0].columns = vec!["A".to_string(); 5];
        document.sheets[0].rows = vec![vec![CellValue::Empty(()); 5]; MAX_ROWS];
        document.sheets.truncate(1);
        assert!(build(&document).is_err());
    }

    #[test]
    fn refuses_output_writes_over_the_package_size_limit() {
        let mut cursor = BoundedCursor::default();
        let oversized = vec![0; MAX_OUTPUT_BYTES as usize + 1];
        assert!(cursor.write_all(&oversized).is_err());
    }

    #[test]
    fn generated_workbook_round_trips_through_bounded_office_text_extraction() {
        let bytes = build(&sample_document()).expect("build workbook");
        let directory = TestDirectory::new();
        let path = directory.path().join("round-trip.xlsx");
        std::fs::write(&path, bytes).expect("write test workbook");
        let extracted = crate::document_text::extract_office(&path)
            .expect("extract workbook")
            .expect("XLSX is recognized");
        assert!(extracted
            .text
            .contains("Cell A2: =HYPERLINK(\"https://bad\",\"x\")"));
        assert!(extracted
            .text
            .contains("Cell C2: [cached formula value unavailable; not recalculated]"));
        assert!(!extracted.truncated);
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("aplot-document-xlsx-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &PathBuf {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
