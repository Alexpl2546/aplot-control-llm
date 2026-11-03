//! Bounded text extraction from DOCX and XLSX package files.
//!
//! Office documents are ZIP packages. This module reads only the XML parts needed
//! for display, never extracts package entries to disk, and never evaluates
//! formulas, macros, or external relationships.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;

use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use zip::read::ZipArchive;

const MAX_OUTPUT_BYTES: usize = 200_000;
const MAX_ARCHIVE_ENTRIES: usize = 4_096;
const MAX_DECLARED_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_XML_PART_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES: usize = 32 * 1024 * 1024;
const MAX_XML_DEPTH: usize = 1_024;
const MAX_WORKBOOK_SHEETS: usize = 4_096;
const MAX_SHARED_STRINGS: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExtractedText {
    pub text: String,
    pub truncated: bool,
}

/// Extracts displayable text from `.docx` and `.xlsx` files.
///
/// Other extensions are not inspected and return `Ok(None)`. XLSX formula
/// results are reported only from their stored cache; formulas are never run.
pub(crate) fn extract_office(path: &Path) -> Result<Option<ExtractedText>, String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);

    let kind = match extension.as_deref() {
        Some("docx") => OfficeKind::Docx,
        Some("xlsx") => OfficeKind::Xlsx,
        _ => return Ok(None),
    };

    let mut package = OfficePackage::open(path)?;
    let mut output = TextOutput::default();
    match kind {
        OfficeKind::Docx => extract_docx(&mut package, &mut output)?,
        OfficeKind::Xlsx => extract_xlsx(&mut package, &mut output)?,
    }

    Ok(Some(ExtractedText {
        text: output.text,
        truncated: output.truncated,
    }))
}

#[derive(Clone, Copy)]
enum OfficeKind {
    Docx,
    Xlsx,
}

#[derive(Default)]
struct TextOutput {
    text: String,
    truncated: bool,
}

impl TextOutput {
    fn append(&mut self, text: &str) {
        if self.truncated || text.is_empty() {
            return;
        }

        let remaining = MAX_OUTPUT_BYTES.saturating_sub(self.text.len());
        if text.len() <= remaining {
            self.text.push_str(text);
            return;
        }

        let mut end = remaining.min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        self.text.push_str(&text[..end]);
        self.truncated = true;
    }

    fn append_line(&mut self, text: &str) {
        self.append(text);
        self.append("\n");
    }
}

struct OfficePackage {
    archive: ZipArchive<File>,
    xml_bytes_read: usize,
}

impl OfficePackage {
    fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|_| "could not open office document".to_string())?;
        let mut archive =
            ZipArchive::new(file).map_err(|_| "invalid office ZIP package".to_string())?;

        if archive.len() > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "office package has too many entries (limit: {MAX_ARCHIVE_ENTRIES})"
            ));
        }

        let mut names = HashSet::with_capacity(archive.len());
        let mut declared_total = 0_u64;
        for index in 0..archive.len() {
            let file = archive
                .by_index(index)
                .map_err(|_| "invalid office ZIP entry".to_string())?;
            let name = file.name();
            if file.enclosed_name().is_none() || !safe_package_name(name) {
                return Err(format!("unsafe path in office package: {name}"));
            }
            if !names.insert(name.to_owned()) {
                return Err(format!("duplicate path in office package: {name}"));
            }

            declared_total = declared_total
                .checked_add(file.size())
                .ok_or_else(|| "office package declared size overflow".to_string())?;
            if declared_total > MAX_DECLARED_ARCHIVE_BYTES {
                return Err(format!(
                    "office package declares more than {} bytes uncompressed",
                    MAX_DECLARED_ARCHIVE_BYTES
                ));
            }
        }

        Ok(Self {
            archive,
            xml_bytes_read: 0,
        })
    }

    fn read_xml(&mut self, name: &str) -> Result<Option<Vec<u8>>, String> {
        read_xml_part(
            &mut self.archive,
            name,
            &mut self.xml_bytes_read,
            MAX_XML_PART_BYTES,
            MAX_TOTAL_XML_BYTES,
        )
    }
}

fn safe_package_name(name: &str) -> bool {
    if name.is_empty()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains('\0')
        || name.contains(':')
    {
        return false;
    }

    // ZIP paths use `/`, but checking `\` as a separator also prevents a path
    // that is harmless on Unix from becoming a traversal on Windows.
    !name.split(['/', '\\']).any(|component| component == "..")
}

fn read_xml_part<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    total_read: &mut usize,
    max_part_bytes: usize,
    max_total_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    if archive.index_for_name(name).is_none() {
        return Ok(None);
    }

    let mut file = archive
        .by_name(name)
        .map_err(|_| format!("could not read office XML part {name}"))?;
    let declared_size = file.size();
    let max_part_bytes_u64 = u64::try_from(max_part_bytes).unwrap_or(u64::MAX);
    if declared_size > max_part_bytes_u64 {
        return Err(format!(
            "office XML part {name} exceeds the {max_part_bytes}-byte limit"
        ));
    }
    let declared_total = total_read
        .checked_add(usize::try_from(declared_size).unwrap_or(usize::MAX))
        .ok_or_else(|| "office XML total size overflow".to_string())?;
    if declared_total > max_total_bytes {
        return Err(format!(
            "office XML parts exceed the {max_total_bytes}-byte total limit"
        ));
    }

    let capacity = usize::try_from(declared_size).unwrap_or(max_part_bytes);
    let mut bytes = Vec::with_capacity(capacity.min(max_part_bytes));
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let total_before_read = (*total_read)
            .checked_add(bytes.len())
            .ok_or_else(|| "office XML total size overflow".to_string())?;
        let remaining_part = max_part_bytes.saturating_sub(bytes.len());
        let remaining_total = max_total_bytes.saturating_sub(total_before_read);
        // Read at most one byte beyond the remaining budget so we can detect
        // an overlong stream without decompressing a full extra chunk.
        let read_limit = remaining_part
            .min(remaining_total)
            .saturating_add(1)
            .min(chunk.len());
        let read = file
            .read(&mut chunk[..read_limit])
            .map_err(|_| format!("could not decompress office XML part {name}"))?;
        if read == 0 {
            break;
        }

        let actual_part_size = bytes
            .len()
            .checked_add(read)
            .ok_or_else(|| "office XML part size overflow".to_string())?;
        let actual_total_size = total_read
            .checked_add(actual_part_size)
            .ok_or_else(|| "office XML total size overflow".to_string())?;
        if actual_part_size > max_part_bytes {
            return Err(format!(
                "office XML part {name} exceeds the {max_part_bytes}-byte read limit"
            ));
        }
        if actual_total_size > max_total_bytes {
            return Err(format!(
                "office XML parts exceed the {max_total_bytes}-byte read limit"
            ));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }

    if bytes.len() as u64 != declared_size {
        return Err(format!(
            "office XML part {name} size does not match its ZIP directory entry"
        ));
    }
    *total_read = total_read
        .checked_add(bytes.len())
        .ok_or_else(|| "office XML total size overflow".to_string())?;
    Ok(Some(bytes))
}

fn extract_docx(package: &mut OfficePackage, output: &mut TextOutput) -> Result<(), String> {
    let xml = package
        .read_xml("word/document.xml")?
        .ok_or_else(|| "DOCX package is missing word/document.xml".to_string())?;
    let mut reader = xml_reader(&xml);
    let mut buffer = Vec::new();
    let mut depth = 0_usize;
    let mut paragraph_depth = 0_usize;
    let mut text_depth = 0_usize;

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("invalid XML in word/document.xml: {error}"))?;
        match event {
            Event::Start(start) => {
                increase_depth(&mut depth)?;
                match local_name(&start) {
                    "p" => paragraph_depth += 1,
                    "t" if paragraph_depth > 0 => text_depth += 1,
                    "tab" if paragraph_depth > 0 => output.append("\t"),
                    "br" | "cr" if paragraph_depth > 0 => output.append("\n"),
                    _ => {}
                }
            }
            Event::Empty(start) => match local_name(&start) {
                "p" => output.append("\n"),
                "tab" if paragraph_depth > 0 => output.append("\t"),
                "br" | "cr" if paragraph_depth > 0 => output.append("\n"),
                _ => {}
            },
            Event::End(end) => {
                let name = end.local_name();
                if name.as_ref() == "t" && text_depth > 0 {
                    text_depth -= 1;
                } else if name.as_ref() == "p" && paragraph_depth > 0 {
                    paragraph_depth -= 1;
                    output.append("\n");
                }
                decrease_depth(&mut depth)?;
            }
            Event::Text(text) if text_depth > 0 => {
                output.append(&text.xml10_content());
            }
            Event::CData(text) if text_depth > 0 => {
                output.append(&text.xml10_content());
            }
            Event::GeneralRef(reference) if text_depth > 0 => {
                output.append(&resolve_reference(&reference)?);
            }
            Event::DocType(_) => {
                return Err("DOCTYPE is not supported in office XML".to_string());
            }
            Event::Eof => {
                if depth != 0 {
                    return Err("incomplete XML in word/document.xml".to_string());
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
        if output.truncated {
            break;
        }
    }

    Ok(())
}

#[derive(Debug)]
struct SheetInfo {
    name: String,
    relationship_id: String,
}

#[derive(Default)]
struct WorkbookRelations {
    worksheets: HashMap<String, String>,
    external_ids: HashSet<String>,
    shared_strings: Option<String>,
}

fn extract_xlsx(package: &mut OfficePackage, output: &mut TextOutput) -> Result<(), String> {
    let workbook_xml = package
        .read_xml("xl/workbook.xml")?
        .ok_or_else(|| "XLSX package is missing xl/workbook.xml".to_string())?;
    let sheets = parse_workbook(&workbook_xml)?;

    let relations = match package.read_xml("xl/_rels/workbook.xml.rels")? {
        Some(xml) => parse_workbook_relations(&xml)?,
        None if sheets.is_empty() => WorkbookRelations::default(),
        None => return Err("XLSX package is missing workbook relationships".to_string()),
    };

    let shared_strings = match relations.shared_strings.as_deref() {
        Some(path) => package
            .read_xml(path)?
            .map(|xml| parse_shared_strings(&xml))
            .transpose()?
            .unwrap_or_default(),
        None => Vec::new(),
    };

    for sheet in sheets {
        if output.truncated {
            break;
        }

        output.append_line(&format!("Sheet: {}", sheet.name));
        if output.truncated {
            break;
        }

        let target = if relations.external_ids.contains(&sheet.relationship_id) {
            None
        } else {
            Some(
                relations
                    .worksheets
                    .get(&sheet.relationship_id)
                    .ok_or_else(|| {
                        format!(
                            "XLSX sheet {:?} has no internal worksheet relationship",
                            sheet.name
                        )
                    })?,
            )
        };

        if let Some(target) = target {
            let xml = package
                .read_xml(target)?
                .ok_or_else(|| format!("XLSX package is missing worksheet {target}"))?;
            parse_worksheet(&xml, &shared_strings, output)?;
        }
    }

    Ok(())
}

fn parse_workbook(xml: &[u8]) -> Result<Vec<SheetInfo>, String> {
    let mut reader = xml_reader(xml);
    let mut buffer = Vec::new();
    let mut depth = 0_usize;
    let mut sheets = Vec::new();

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("invalid XML in xl/workbook.xml: {error}"))?;
        match event {
            Event::Start(start) => {
                increase_depth(&mut depth)?;
                if local_name(&start) == "sheet" {
                    push_sheet(&start, &reader, &mut sheets)?;
                }
            }
            Event::Empty(start) if local_name(&start) == "sheet" => {
                push_sheet(&start, &reader, &mut sheets)?;
            }
            Event::End(_) => decrease_depth(&mut depth)?,
            Event::DocType(_) => {
                return Err("DOCTYPE is not supported in office XML".to_string());
            }
            Event::Eof => {
                if depth != 0 {
                    return Err("incomplete XML in xl/workbook.xml".to_string());
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
    }

    Ok(sheets)
}

fn push_sheet(
    start: &BytesStart<'_>,
    reader: &Reader<&[u8]>,
    sheets: &mut Vec<SheetInfo>,
) -> Result<(), String> {
    if sheets.len() >= MAX_WORKBOOK_SHEETS {
        return Err(format!(
            "XLSX workbook has more than {MAX_WORKBOOK_SHEETS} sheets"
        ));
    }
    let attributes = xml_attributes(start, reader, "xl/workbook.xml")?;
    let name = attributes
        .get("name")
        .cloned()
        .ok_or_else(|| "XLSX sheet is missing its name".to_string())?;
    let relationship_id = attributes
        .iter()
        .find(|(key, _)| key.rsplit(':').next() == Some("id"))
        .map(|(_, value)| value.clone())
        .ok_or_else(|| format!("XLSX sheet {name:?} is missing its relationship id"))?;
    sheets.push(SheetInfo {
        name,
        relationship_id,
    });
    Ok(())
}

fn parse_workbook_relations(xml: &[u8]) -> Result<WorkbookRelations, String> {
    let mut reader = xml_reader(xml);
    let mut buffer = Vec::new();
    let mut depth = 0_usize;
    let mut relations = WorkbookRelations::default();

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("invalid XML in workbook relationships: {error}"))?;
        let relationship = match &event {
            Event::Start(start) if local_name(start) == "Relationship" => Some(start),
            Event::Empty(start) if local_name(start) == "Relationship" => Some(start),
            _ => None,
        };

        match &event {
            Event::Start(_) => increase_depth(&mut depth)?,
            Event::End(_) => decrease_depth(&mut depth)?,
            Event::DocType(_) => {
                return Err("DOCTYPE is not supported in office XML".to_string());
            }
            Event::Eof => {
                if depth != 0 {
                    return Err("incomplete XML in workbook relationships".to_string());
                }
                break;
            }
            _ => {}
        }

        if let Some(start) = relationship {
            let attributes = xml_attributes(start, &reader, "workbook relationships")?;
            let id = attributes
                .get("Id")
                .cloned()
                .ok_or_else(|| "XLSX relationship is missing its id".to_string())?;
            let relation_type = attributes.get("Type").map(String::as_str).unwrap_or("");
            let target = attributes.get("Target").map(String::as_str).unwrap_or("");
            let is_external = attributes
                .get("TargetMode")
                .is_some_and(|mode| mode.eq_ignore_ascii_case("external"));

            if is_external {
                relations.external_ids.insert(id);
            } else if relation_type.ends_with("/worksheet") {
                let target = normalize_target(target, "xl/worksheets/")?;
                if relations.worksheets.insert(id, target).is_some() {
                    return Err("duplicate XLSX worksheet relationship id".to_string());
                }
            } else if relation_type.ends_with("/sharedStrings") {
                let target = normalize_target(target, "xl/")?;
                if target.starts_with("xl/externalLinks/") {
                    return Err("invalid shared strings relationship target".to_string());
                }
                if relations.shared_strings.replace(target).is_some() {
                    return Err("duplicate XLSX shared strings relationship".to_string());
                }
            }
        }
        buffer.clear();
    }

    Ok(relations)
}

fn normalize_target(target: &str, required_prefix: &str) -> Result<String, String> {
    if target.is_empty()
        || target.contains('\\')
        || target.contains(':')
        || target.contains('?')
        || target.contains('#')
    {
        return Err(format!(
            "unsafe internal XLSX relationship target: {target}"
        ));
    }

    let (absolute, path) = if let Some(path) = target.strip_prefix('/') {
        if path.starts_with('/') {
            return Err(format!(
                "unsafe internal XLSX relationship target: {target}"
            ));
        }
        (true, path)
    } else {
        (false, target)
    };

    let mut parts: Vec<&str> = if absolute { Vec::new() } else { vec!["xl"] };
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                return Err(format!(
                    "unsafe internal XLSX relationship target: {target}"
                ));
            }
            part => parts.push(part),
        }
    }

    let normalized = parts.join("/");
    if !normalized.starts_with(required_prefix) || !normalized.ends_with(".xml") {
        return Err(format!("unsupported XLSX relationship target: {target}"));
    }
    Ok(normalized)
}

fn parse_shared_strings(xml: &[u8]) -> Result<Vec<String>, String> {
    let mut reader = xml_reader(xml);
    let mut buffer = Vec::new();
    let mut depth = 0_usize;
    let mut in_shared_string = false;
    let mut in_text = false;
    let mut phonetic_depth = 0_usize;
    let mut current = String::new();
    let mut strings = Vec::new();

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("invalid XML in shared strings: {error}"))?;
        match event {
            Event::Start(start) => {
                increase_depth(&mut depth)?;
                match local_name(&start) {
                    "si" if !in_shared_string => {
                        in_shared_string = true;
                        current.clear();
                    }
                    "rPh" if in_shared_string => phonetic_depth += 1,
                    "t" if in_shared_string && phonetic_depth == 0 => in_text = true,
                    _ => {}
                }
            }
            Event::Empty(start) => match local_name(&start) {
                "si" if !in_shared_string => {
                    push_shared_string(String::new(), &mut strings)?;
                }
                "t" if in_shared_string => {}
                _ => {}
            },
            Event::End(end) => {
                match end.local_name().as_ref() {
                    "t" if in_text => in_text = false,
                    "rPh" if phonetic_depth > 0 => phonetic_depth -= 1,
                    "si" if in_shared_string => {
                        in_shared_string = false;
                        push_shared_string(std::mem::take(&mut current), &mut strings)?;
                    }
                    _ => {}
                }
                decrease_depth(&mut depth)?;
            }
            Event::Text(text) if in_shared_string && in_text => {
                current.push_str(&text.xml10_content());
            }
            Event::CData(text) if in_shared_string && in_text => {
                current.push_str(&text.xml10_content());
            }
            Event::GeneralRef(reference) if in_shared_string && in_text => {
                current.push_str(&resolve_reference(&reference)?);
            }
            Event::DocType(_) => {
                return Err("DOCTYPE is not supported in office XML".to_string());
            }
            Event::Eof => {
                if depth != 0 {
                    return Err("incomplete XML in shared strings".to_string());
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
    }

    Ok(strings)
}

fn push_shared_string(value: String, strings: &mut Vec<String>) -> Result<(), String> {
    if strings.len() >= MAX_SHARED_STRINGS {
        return Err(format!(
            "XLSX shared strings exceed the {MAX_SHARED_STRINGS}-entry limit"
        ));
    }
    strings.push(value);
    Ok(())
}

fn parse_worksheet(
    xml: &[u8],
    shared_strings: &[String],
    output: &mut TextOutput,
) -> Result<(), String> {
    let mut reader = xml_reader(xml);
    let mut buffer = Vec::new();
    let mut depth = 0_usize;
    let mut cell: Option<CellBuilder> = None;

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("invalid XML in worksheet: {error}"))?;
        match event {
            Event::Start(start) => {
                increase_depth(&mut depth)?;
                match local_name(&start) {
                    "c" => {
                        if cell.is_some() {
                            return Err("nested XLSX cells are invalid".to_string());
                        }
                        cell = Some(CellBuilder::new(&start, &reader)?);
                    }
                    "f" if cell.is_some() => {
                        cell.as_mut().expect("cell checked above").has_formula = true;
                    }
                    "v" if cell.is_some() => {
                        cell.as_mut().expect("cell checked above").in_value = true;
                    }
                    "is" if cell.is_some() => {
                        cell.as_mut().expect("cell checked above").in_inline_string = true;
                    }
                    "rPh" if cell.as_ref().is_some_and(|cell| cell.in_inline_string) => {
                        cell.as_mut().expect("cell checked above").phonetic_depth += 1;
                    }
                    "t" if cell
                        .as_ref()
                        .is_some_and(|cell| cell.in_inline_string && cell.phonetic_depth == 0) =>
                    {
                        cell.as_mut().expect("cell checked above").in_inline_text = true;
                    }
                    _ => {}
                }
            }
            Event::Empty(start) => match local_name(&start) {
                "c" => {
                    let empty = CellBuilder::new(&start, &reader)?;
                    append_cell(empty, shared_strings, output)?;
                }
                "f" if cell.is_some() => {
                    cell.as_mut().expect("cell checked above").has_formula = true;
                }
                _ => {}
            },
            Event::End(end) => {
                match end.local_name().as_ref() {
                    "v" if cell.is_some() => {
                        cell.as_mut().expect("cell checked above").in_value = false;
                    }
                    "t" if cell.as_ref().is_some_and(|cell| cell.in_inline_text) => {
                        cell.as_mut().expect("cell checked above").in_inline_text = false;
                    }
                    "rPh" if cell.as_ref().is_some_and(|cell| cell.phonetic_depth > 0) => {
                        cell.as_mut().expect("cell checked above").phonetic_depth -= 1;
                    }
                    "is" if cell.is_some() => {
                        cell.as_mut().expect("cell checked above").in_inline_string = false;
                    }
                    "c" if cell.is_some() => {
                        append_cell(
                            cell.take().expect("cell checked above"),
                            shared_strings,
                            output,
                        )?;
                    }
                    _ => {}
                }
                decrease_depth(&mut depth)?;
            }
            Event::Text(text) => {
                if let Some(cell) = cell.as_mut() {
                    let text = text.xml10_content();
                    if cell.in_value {
                        cell.value.push_str(&text);
                    } else if cell.in_inline_text {
                        cell.inline_string.push_str(&text);
                    }
                }
            }
            Event::CData(text) => {
                if let Some(cell) = cell.as_mut() {
                    let text = text.xml10_content();
                    if cell.in_value {
                        cell.value.push_str(&text);
                    } else if cell.in_inline_text {
                        cell.inline_string.push_str(&text);
                    }
                }
            }
            Event::GeneralRef(reference) => {
                if let Some(cell) = cell.as_mut() {
                    let reference = resolve_reference(&reference)?;
                    if cell.in_value {
                        cell.value.push_str(&reference);
                    } else if cell.in_inline_text {
                        cell.inline_string.push_str(&reference);
                    }
                }
            }
            Event::DocType(_) => {
                return Err("DOCTYPE is not supported in office XML".to_string());
            }
            Event::Eof => {
                if depth != 0 {
                    return Err("incomplete XML in worksheet".to_string());
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
        if output.truncated {
            break;
        }
    }

    Ok(())
}

struct CellBuilder {
    reference: String,
    kind: String,
    value: String,
    inline_string: String,
    has_formula: bool,
    in_value: bool,
    in_inline_string: bool,
    in_inline_text: bool,
    phonetic_depth: usize,
}

impl CellBuilder {
    fn new(start: &BytesStart<'_>, reader: &Reader<&[u8]>) -> Result<Self, String> {
        let attributes = xml_attributes(start, reader, "worksheet")?;
        Ok(Self {
            reference: attributes
                .get("r")
                .cloned()
                .unwrap_or_else(|| "?".to_string()),
            kind: attributes.get("t").cloned().unwrap_or_default(),
            value: String::new(),
            inline_string: String::new(),
            has_formula: false,
            in_value: false,
            in_inline_string: false,
            in_inline_text: false,
            phonetic_depth: 0,
        })
    }
}

fn append_cell(
    cell: CellBuilder,
    shared_strings: &[String],
    output: &mut TextOutput,
) -> Result<(), String> {
    let value = if cell.kind == "inlineStr" {
        cell.inline_string
    } else if cell.kind == "s" && !cell.value.is_empty() {
        let index = cell
            .value
            .trim()
            .parse::<usize>()
            .map_err(|_| format!("invalid shared string index in cell {}", cell.reference))?;
        shared_strings.get(index).cloned().ok_or_else(|| {
            format!(
                "shared string index {index} is missing for cell {}",
                cell.reference
            )
        })?
    } else {
        cell.value
    };

    if cell.has_formula {
        let display = if value.is_empty() {
            "[cached formula value unavailable; not recalculated]".to_string()
        } else {
            format!("[cached formula value: {value}; not recalculated]")
        };
        output.append_line(&format!("Cell {}: {display}", cell.reference));
    } else if !value.is_empty() {
        output.append_line(&format!("Cell {}: {value}", cell.reference));
    }
    Ok(())
}

fn xml_reader(xml: &[u8]) -> Reader<&[u8]> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().enable_all_checks(true);
    reader
}

fn local_name<'a>(start: &'a BytesStart<'_>) -> &'a str {
    start.name().local_name().into_inner()
}

fn xml_attributes(
    start: &BytesStart<'_>,
    _reader: &Reader<&[u8]>,
    part_name: &str,
) -> Result<HashMap<String, String>, String> {
    let mut attributes = HashMap::new();
    for attribute in start.attributes().with_checks(true) {
        let attribute =
            attribute.map_err(|error| format!("invalid XML attribute in {part_name}: {error}"))?;
        let key = attribute.key.as_ref().to_owned();
        let value = attribute
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map_err(|error| format!("invalid XML attribute value in {part_name}: {error}"))?
            .into_owned();
        if attributes.insert(key.clone(), value).is_some() {
            return Err(format!("duplicate XML attribute {key} in {part_name}"));
        }
    }
    Ok(attributes)
}

fn resolve_reference(reference: &quick_xml::events::BytesRef<'_>) -> Result<String, String> {
    if let Some(character) = reference
        .resolve_char_ref()
        .map_err(|error| format!("invalid XML character reference: {error}"))?
    {
        if !is_valid_xml_char(character) {
            return Err("XML character reference is not legal in XML 1.0".to_string());
        }
        return Ok(character.to_string());
    }

    resolve_predefined_entity(reference.as_ref())
        .map(str::to_owned)
        .ok_or_else(|| format!("unsupported XML entity reference: &{};", reference.as_ref()))
}

fn is_valid_xml_char(character: char) -> bool {
    matches!(character, '\u{9}' | '\u{A}' | '\u{D}')
        || ('\u{20}'..='\u{D7FF}').contains(&character)
        || ('\u{E000}'..='\u{FFFD}').contains(&character)
        || ('\u{10000}'..='\u{10FFFF}').contains(&character)
}

fn increase_depth(depth: &mut usize) -> Result<(), String> {
    *depth = depth
        .checked_add(1)
        .ok_or_else(|| "office XML nesting depth overflow".to_string())?;
    if *depth > MAX_XML_DEPTH {
        return Err(format!("office XML nesting exceeds {MAX_XML_DEPTH} levels"));
    }
    Ok(())
}

fn decrease_depth(depth: &mut usize) -> Result<(), String> {
    *depth = depth
        .checked_sub(1)
        .ok_or_else(|| "unexpected closing tag in office XML".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::{SimpleFileOptions, ZipWriter};
    use zip::CompressionMethod;

    struct TestDirectory(std::path::PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("aplot-document-text-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn file(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).expect("create ZIP fixture");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, contents) in entries {
            writer.start_file(*name, options).expect("start ZIP entry");
            writer.write_all(contents).expect("write ZIP entry");
        }
        writer.finish().expect("finish ZIP fixture");
    }

    fn underdeclare_entry_size(path: &Path, entry_name: &str, declared_size: u32) {
        let mut bytes = std::fs::read(path).expect("read ZIP fixture");
        let mut patched = false;
        for offset in 0..bytes.len().saturating_sub(46) {
            if &bytes[offset..offset + 4] != b"PK\x01\x02" {
                continue;
            }
            let name_len = u16::from_le_bytes([bytes[offset + 28], bytes[offset + 29]]) as usize;
            let name_start = offset + 46;
            let name_end = name_start + name_len;
            if name_end <= bytes.len() && &bytes[name_start..name_end] == entry_name.as_bytes() {
                bytes[offset + 24..offset + 28].copy_from_slice(&declared_size.to_le_bytes());
                patched = true;
                break;
            }
        }
        assert!(patched, "find ZIP central directory entry");
        std::fs::write(path, bytes).expect("write modified ZIP fixture");
    }

    fn extract(path: &Path) -> ExtractedText {
        extract_office(path)
            .expect("extract fixture")
            .expect("supported file extension")
    }

    #[test]
    fn extracts_docx_paragraphs_and_xml_entities() {
        let directory = TestDirectory::new();
        let path = directory.file("paragraphs.docx");
        let document = br#"<?xml version="1.0" encoding="UTF-8"?>
<word:document xmlns:word="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <word:body>
    <word:p><word:r><word:t>Hello &amp; &lt;world&gt; &#x1F30D;</word:t></word:r></word:p>
    <word:p><word:r><word:t>Second paragraph</word:t></word:r><word:r><word:tab/><word:t>Tab</word:t><word:br/><word:t>Break</word:t></word:r></word:p>
  </word:body>
</word:document>"#;
        write_zip(&path, &[("word/document.xml", document)]);

        let extracted = extract(&path);
        assert_eq!(
            extracted.text,
            "Hello & <world> 🌍\nSecond paragraph\tTab\nBreak\n"
        );
        assert!(!extracted.truncated);
    }

    #[test]
    fn rejects_dtds_and_undeclared_entities() {
        let directory = TestDirectory::new();
        let path = directory.file("doctype.docx");
        let document = br#"<!DOCTYPE w:document [<!ENTITY x "unsafe">]>
<w:document><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>"#;
        write_zip(&path, &[("word/document.xml", document)]);

        let error = extract_office(&path).expect_err("DOCTYPE must be rejected");
        assert!(error.contains("DOCTYPE"));

        let undeclared_path = directory.file("undeclared-entity.docx");
        let document = br#"<w:document><w:body><w:p><w:r><w:t>&notDeclared;</w:t></w:r></w:p></w:body></w:document>"#;
        write_zip(&undeclared_path, &[("word/document.xml", document)]);
        let error = extract_office(&undeclared_path)
            .expect_err("undeclared entities must not be silently resolved");
        assert!(error.contains("unsupported XML entity"));

        let malformed_path = directory.file("unclosed.docx");
        write_zip(
            &malformed_path,
            &[("word/document.xml", b"<w:document><w:body>")],
        );
        assert!(extract_office(&malformed_path).is_err());
    }

    #[test]
    fn extracts_multiple_sheets_shared_inline_numeric_and_cached_formula_values() {
        let directory = TestDirectory::new();
        let path = directory.file("workbook.xlsx");
        let workbook = br#"<book:workbook xmlns:book="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <book:sheets>
    <book:sheet name="First &amp; Main" sheetId="1" rel:id="rId1"/>
    <book:sheet name="Second" sheetId="2" rel:id="rId2"/>
  </book:sheets>
</book:workbook>"#;
        let relationships = br#"<pkg:Relationships xmlns:pkg="http://schemas.openxmlformats.org/package/2006/relationships">
  <pkg:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <pkg:Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/custom.xml"/>
  <pkg:Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</pkg:Relationships>"#;
        let shared_strings = br#"<sst><si><t>Shared &amp; text</t></si></sst>"#;
        let sheet1 = br#"<ws:worksheet xmlns:ws="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><ws:sheetData><ws:row r="1">
  <ws:c r="A1" t="s"><ws:v>0</ws:v></ws:c>
  <ws:c r="B1" t="inlineStr"><ws:is><ws:t>Inline &#x26; safe</ws:t></ws:is></ws:c>
  <ws:c r="C1"><ws:v>12.5</ws:v></ws:c>
  <ws:c r="D1"><ws:f>SUM(C1:C1)</ws:f><ws:v>12.5</ws:v></ws:c>
  <ws:c r="E1"><ws:f>NOW()</ws:f></ws:c>
</ws:row></ws:sheetData></ws:worksheet>"#;
        let sheet2 = br#"<ws:worksheet xmlns:ws="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><ws:sheetData><ws:row r="3"><ws:c r="A3" t="inlineStr"><ws:is><ws:t>Second sheet</ws:t></ws:is></ws:c></ws:row></ws:sheetData></ws:worksheet>"#;
        write_zip(
            &path,
            &[
                ("xl/workbook.xml", workbook),
                ("xl/_rels/workbook.xml.rels", relationships),
                ("xl/sharedStrings.xml", shared_strings),
                ("xl/worksheets/sheet1.xml", sheet1),
                ("xl/worksheets/custom.xml", sheet2),
            ],
        );

        let extracted = extract(&path);
        assert!(extracted.text.contains("Sheet: First & Main\n"));
        assert!(extracted.text.contains("Cell A1: Shared & text\n"));
        assert!(extracted.text.contains("Cell B1: Inline & safe\n"));
        assert!(extracted.text.contains("Cell C1: 12.5\n"));
        assert!(extracted
            .text
            .contains("Cell D1: [cached formula value: 12.5; not recalculated]\n"));
        assert!(extracted
            .text
            .contains("Cell E1: [cached formula value unavailable; not recalculated]\n"));
        assert!(extracted.text.contains("Sheet: Second\n"));
        assert!(extracted.text.contains("Cell A3: Second sheet\n"));
        assert!(!extracted.text.contains("SUM(C1:C1)"));
        assert!(!extracted.truncated);
    }

    #[test]
    fn phonetic_runs_are_not_duplicated_into_shared_or_inline_strings() {
        let shared_strings = parse_shared_strings(
            r#"<sst><si><r><t>漢</t></r><r><t>字</t></r><rPh sb="0" eb="2"><t>かんじ</t></rPh></si></sst>"#
                .as_bytes(),
        )
        .expect("parse shared strings");
        assert_eq!(shared_strings, vec!["漢字"]);

        let worksheet = r#"<worksheet><sheetData><row>
  <c r="A1" t="inlineStr"><is><r><t>東京</t></r><rPh sb="0" eb="2"><t>とうきょう</t></rPh></is></c>
</row></sheetData></worksheet>"#;
        let mut output = TextOutput::default();
        parse_worksheet(worksheet.as_bytes(), &[], &mut output).expect("parse inline string");
        assert_eq!(output.text, "Cell A1: 東京\n");
    }

    #[test]
    fn rejects_traversal_entries_without_extracting_them() {
        let directory = TestDirectory::new();
        let path = directory.file("traversal.docx");
        let escaped_name = format!("office-escape-{}.txt", uuid::Uuid::new_v4());
        let traversal = format!("../{escaped_name}");
        write_zip(
            &path,
            &[
                (traversal.as_str(), b"outside"),
                ("word/document.xml", b"<document/>"),
            ],
        );

        let error = extract_office(&path).expect_err("traversal package should be rejected");
        assert!(error.contains("unsafe path"));
        assert!(!directory.0.parent().unwrap().join(escaped_name).exists());
    }

    #[test]
    fn rejects_corrupt_and_oversized_archives() {
        let directory = TestDirectory::new();
        let corrupt = directory.file("corrupt.docx");
        std::fs::write(&corrupt, b"not a ZIP archive").expect("write corrupt fixture");
        assert!(extract_office(&corrupt).is_err());

        let oversized = directory.file("oversized.docx");
        let contents = vec![b'x'; MAX_XML_PART_BYTES + 1];
        write_zip(&oversized, &[("word/document.xml", contents.as_slice())]);
        let error = extract_office(&oversized).expect_err("oversized XML must be rejected");
        assert!(error.contains("exceeds"));

        let underdeclared = directory.file("underdeclared.docx");
        write_zip(
            &underdeclared,
            &[("word/document.xml", contents.as_slice())],
        );
        underdeclare_entry_size(&underdeclared, "word/document.xml", 1);
        let error = extract_office(&underdeclared)
            .expect_err("actual XML bytes must be bounded even with a false ZIP size");
        assert!(error.contains("read limit"));

        let mismatched = directory.file("mismatched.docx");
        let small_contents = vec![b'x'; 4_096];
        write_zip(
            &mismatched,
            &[("word/document.xml", small_contents.as_slice())],
        );
        underdeclare_entry_size(&mismatched, "word/document.xml", 1);
        let error = extract_office(&mismatched).expect_err("ZIP size mismatches must be rejected");
        assert!(error.contains("size does not match"));
    }

    #[test]
    fn output_limit_preserves_utf8_and_reports_truncation() {
        let directory = TestDirectory::new();
        let path = directory.file("long.docx");
        let text = "🌍".repeat(MAX_OUTPUT_BYTES / 4 + 1);
        let mut document = String::from("<document><p><r><t>");
        document.push_str(&text);
        document.push_str("</t></r></p></document>");
        write_zip(&path, &[("word/document.xml", document.as_bytes())]);

        let extracted = extract(&path);
        assert_eq!(extracted.text.len(), MAX_OUTPUT_BYTES);
        assert!(extracted.text.is_char_boundary(extracted.text.len()));
        assert!(extracted.truncated);
    }

    #[test]
    fn unsupported_extensions_are_ignored() {
        assert_eq!(extract_office(Path::new("notes.txt")).unwrap(), None);
    }
}
