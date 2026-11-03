//! Bounded DOCX generation for declarative text documents.
//!
//! Text is written only into WordprocessingML text nodes and is XML-escaped;
//! this module does not interpret HTML, links, fields, macros, or formulas.

use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::document_spec::{DocumentBlock, TextDocument};

const MAX_TEXT_BYTES: usize = 64_000;
const MAX_BLOCKS: usize = 100;
const MAX_LIST_ITEMS: usize = 200;
const MAX_TABLE_ROWS: usize = 200;
const MAX_TABLE_COLUMNS: usize = 8;
const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;

const WORD_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/// Builds a compact, styled DOCX package from a validated document specification.
pub(crate) fn build(document: &TextDocument) -> Result<Vec<u8>, String> {
    validate_document(document)?;

    let bullet_lists = document
        .blocks
        .iter()
        .filter(|block| matches!(block, DocumentBlock::BulletList { .. }))
        .count();
    let document_xml = build_document_xml(document)?;
    let styles_xml = styles_xml();
    let numbering_xml = numbering_xml(bullet_lists);
    let relationships_xml = document_relationships_xml();
    let content_types_xml = content_types_xml();
    let root_relationships_xml = root_relationships_xml();
    let core_properties_xml = core_properties_xml(&document.title);

    let package = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(package);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, contents) in [
        ("[Content_Types].xml", content_types_xml),
        ("_rels/.rels", root_relationships_xml),
        ("docProps/core.xml", core_properties_xml),
        ("word/document.xml", document_xml),
        ("word/styles.xml", styles_xml),
        ("word/numbering.xml", numbering_xml),
        ("word/_rels/document.xml.rels", relationships_xml),
    ] {
        writer
            .start_file(name, options)
            .map_err(|_| "could not create DOCX package".to_string())?;
        writer
            .write_all(contents.as_bytes())
            .map_err(|_| "could not write DOCX package".to_string())?;
    }

    let package = writer
        .finish()
        .map_err(|_| "could not finish DOCX package".to_string())?;
    let bytes = package.into_inner();
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(format!(
            "DOCX output exceeds the {MAX_OUTPUT_BYTES}-byte limit"
        ));
    }
    Ok(bytes)
}

fn validate_document(document: &TextDocument) -> Result<(), String> {
    if document.blocks.len() > MAX_BLOCKS {
        return Err(format!("document has more than {MAX_BLOCKS} blocks"));
    }

    let mut total_text_bytes = 0_usize;
    validate_text(&document.title, &mut total_text_bytes)?;
    for block in &document.blocks {
        match block {
            DocumentBlock::Paragraph { text } => validate_text(text, &mut total_text_bytes)?,
            DocumentBlock::Heading { text, level } => {
                if !(1..=3).contains(level) {
                    return Err("heading level must be between 1 and 3".to_string());
                }
                validate_text(text, &mut total_text_bytes)?;
            }
            DocumentBlock::BulletList { items } => {
                if items.len() > MAX_LIST_ITEMS {
                    return Err(format!("bullet list has more than {MAX_LIST_ITEMS} items"));
                }
                for item in items {
                    validate_text(item, &mut total_text_bytes)?;
                }
            }
            DocumentBlock::Table { headers, rows } => {
                if headers.is_empty() || headers.len() > MAX_TABLE_COLUMNS {
                    return Err(format!(
                        "table must have between 1 and {MAX_TABLE_COLUMNS} columns"
                    ));
                }
                if rows.len() > MAX_TABLE_ROWS {
                    return Err(format!("table has more than {MAX_TABLE_ROWS} data rows"));
                }
                for header in headers {
                    validate_text(header, &mut total_text_bytes)?;
                }
                for row in rows {
                    if row.len() != headers.len() {
                        return Err("table row width must match its header width".to_string());
                    }
                    for cell in row {
                        validate_text(cell, &mut total_text_bytes)?;
                    }
                }
            }
            DocumentBlock::PageBreak => {}
        }
    }
    Ok(())
}

fn validate_text(text: &str, total_text_bytes: &mut usize) -> Result<(), String> {
    let next_text_bytes = (*total_text_bytes)
        .checked_add(text.len())
        .ok_or_else(|| "document text size overflow".to_string())?;
    if next_text_bytes > MAX_TEXT_BYTES {
        return Err(format!(
            "document text exceeds the {MAX_TEXT_BYTES}-byte limit"
        ));
    }
    for character in text.chars() {
        if !is_valid_xml_char(character) {
            return Err(
                "document text contains a character that is invalid in XML 1.0".to_string(),
            );
        }
    }
    *total_text_bytes = next_text_bytes;
    Ok(())
}

fn is_valid_xml_char(character: char) -> bool {
    matches!(character, '\u{9}' | '\u{A}' | '\u{D}')
        || ('\u{20}'..='\u{D7FF}').contains(&character)
        || ('\u{E000}'..='\u{FFFD}').contains(&character)
        || ('\u{10000}'..='\u{10FFFF}').contains(&character)
}

fn build_document_xml(document: &TextDocument) -> Result<String, String> {
    let mut xml = String::with_capacity(document.title.len() + 2_048);
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
    xml.push_str("<w:document xmlns:w=\"");
    xml.push_str(WORD_NS);
    xml.push_str("\"><w:body>");

    xml.push_str("<w:p><w:pPr><w:pStyle w:val=\"Title\"/></w:pPr>");
    append_run_text(&mut xml, &document.title);
    xml.push_str("</w:p>");

    let mut next_number_id = 1_u32;
    for block in &document.blocks {
        match block {
            DocumentBlock::Paragraph { text } => {
                xml.push_str("<w:p>");
                append_run_text(&mut xml, text);
                xml.push_str("</w:p>");
            }
            DocumentBlock::Heading { text, level } => {
                xml.push_str("<w:p><w:pPr><w:pStyle w:val=\"Heading");
                xml.push(char::from(b'0' + *level));
                xml.push_str("\"/></w:pPr>");
                append_run_text(&mut xml, text);
                xml.push_str("</w:p>");
            }
            DocumentBlock::BulletList { items } => {
                let number_id = next_number_id;
                next_number_id += 1;
                for item in items {
                    xml.push_str("<w:p><w:pPr><w:pStyle w:val=\"ListParagraph\"/><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"");
                    xml.push_str(&number_id.to_string());
                    xml.push_str("\"/></w:numPr></w:pPr>");
                    append_run_text(&mut xml, item);
                    xml.push_str("</w:p>");
                }
            }
            DocumentBlock::Table { headers, rows } => append_table(&mut xml, headers, rows),
            DocumentBlock::PageBreak => {
                xml.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
            }
        }
    }

    xml.push_str("<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1200\" w:bottom=\"1440\" w:left=\"1200\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/><w:cols w:space=\"720\"/></w:sectPr></w:body></w:document>");
    Ok(xml)
}

fn append_table(xml: &mut String, headers: &[String], rows: &[Vec<String>]) {
    let column_count = headers.len();
    let base_width = 9_506 / column_count as u32;
    let remainder = 9_506 % column_count as u32;

    xml.push_str("<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblLayout w:type=\"autofit\"/><w:tblCellMar><w:top w:w=\"100\" w:type=\"dxa\"/><w:left w:w=\"120\" w:type=\"dxa\"/><w:bottom w:w=\"100\" w:type=\"dxa\"/><w:right w:w=\"120\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr><w:tblGrid>");
    for column in 0..column_count {
        xml.push_str("<w:gridCol w:w=\"");
        xml.push_str(&(base_width + if (column as u32) < remainder { 1 } else { 0 }).to_string());
        xml.push_str("\"/>");
    }
    xml.push_str("</w:tblGrid>");

    xml.push_str("<w:tr><w:trPr><w:tblHeader w:val=\"true\"/></w:trPr>");
    for (column, header) in headers.iter().enumerate() {
        append_table_cell(xml, header, true, cell_width(column, base_width, remainder));
    }
    xml.push_str("</w:tr>");

    for row in rows {
        xml.push_str("<w:tr>");
        for (column, cell) in row.iter().enumerate() {
            append_table_cell(xml, cell, false, cell_width(column, base_width, remainder));
        }
        xml.push_str("</w:tr>");
    }
    xml.push_str("</w:tbl>");
}

fn cell_width(column: usize, base_width: u32, remainder: u32) -> u32 {
    base_width + if (column as u32) < remainder { 1 } else { 0 }
}

fn append_table_cell(xml: &mut String, text: &str, header: bool, width: u32) {
    xml.push_str("<w:tc><w:tcPr><w:tcW w:w=\"");
    xml.push_str(&width.to_string());
    xml.push_str("\" w:type=\"dxa\"/>");
    if header {
        xml.push_str("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"E9EEF4\"/>");
    }
    xml.push_str("</w:tcPr><w:p><w:pPr><w:spacing w:after=\"0\"/></w:pPr>");
    if header {
        xml.push_str("<w:r><w:rPr><w:b/><w:color w:val=\"263548\"/></w:rPr>");
        append_text_nodes(xml, text);
        xml.push_str("</w:r>");
    } else {
        append_run_text(xml, text);
    }
    xml.push_str("</w:p></w:tc>");
}

fn append_run_text(xml: &mut String, text: &str) {
    xml.push_str("<w:r>");
    append_text_nodes(xml, text);
    xml.push_str("</w:r>");
}

fn append_text_nodes(xml: &mut String, text: &str) {
    xml.push_str("<w:t xml:space=\"preserve\">");
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '&' => xml.push_str("&amp;"),
            '<' => xml.push_str("&lt;"),
            '>' => xml.push_str("&gt;"),
            '"' => xml.push_str("&quot;"),
            '\'' => xml.push_str("&apos;"),
            '\r' => {
                if characters.peek() == Some(&'\n') {
                    characters.next();
                }
                xml.push_str("</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space=\"preserve\">");
            }
            '\n' => xml.push_str("</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space=\"preserve\">"),
            '\t' => {
                xml.push_str("</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space=\"preserve\">")
            }
            _ => xml.push(character),
        }
    }
    xml.push_str("</w:t>");
}

fn styles_xml() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<w:styles xmlns:w=\"{WORD_NS}\">\
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:eastAsia=\"Calibri\" w:cs=\"Calibri\"/><w:color w:val=\"273449\"/><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"140\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>\
<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:spacing w:before=\"0\" w:after=\"300\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\"/><w:b/><w:color w:val=\"1F2937\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading 1\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"300\" w:after=\"120\"/><w:outlineLvl w:val=\"0\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\"/><w:b/><w:color w:val=\"344A62\"/><w:sz w:val=\"30\"/><w:szCs w:val=\"30\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Heading2\"><w:name w:val=\"heading 2\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"240\" w:after=\"100\"/><w:outlineLvl w:val=\"1\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\"/><w:b/><w:color w:val=\"405B78\"/><w:sz w:val=\"26\"/><w:szCs w:val=\"26\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Heading3\"><w:name w:val=\"heading 3\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"180\" w:after=\"80\"/><w:outlineLvl w:val=\"2\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\"/><w:b/><w:color w:val=\"51677F\"/><w:sz w:val=\"24\"/><w:szCs w:val=\"24\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:uiPriority w:val=\"34\"/><w:pPr><w:spacing w:after=\"80\"/></w:pPr></w:style>\
<w:style w:type=\"table\" w:styleId=\"TableGrid\"><w:name w:val=\"Table Grid\"/><w:uiPriority w:val=\"59\"/><w:tblPr><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C6D0DC\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C6D0DC\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C6D0DC\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C6D0DC\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"D5DDE6\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"D5DDE6\"/></w:tblBorders></w:tblPr></w:style>\
</w:styles>"
    )
}

fn numbering_xml(bullet_lists: usize) -> String {
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:numbering xmlns:w=\"{WORD_NS}\">\
<w:abstractNum w:abstractNumId=\"0\"><w:multiLevelType w:val=\"singleLevel\"/><w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"•\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:tabs><w:tab w:val=\"num\" w:pos=\"720\"/></w:tabs><w:ind w:left=\"720\" w:hanging=\"360\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\"/></w:rPr></w:lvl></w:abstractNum>"
    );
    for number_id in 1..=bullet_lists {
        xml.push_str("<w:num w:numId=\"");
        xml.push_str(&number_id.to_string());
        xml.push_str("\"><w:abstractNumId w:val=\"0\"/></w:num>");
    }
    xml.push_str("</w:numbering>");
    xml
}

fn document_relationships_xml() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
<Relationship Id=\"rIdNumbering\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>\
</Relationships>"
        .to_string()
}

fn content_types_xml() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>\
</Types>"
        .to_string()
}

fn root_relationships_xml() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
</Relationships>"
        .to_string()
}

fn core_properties_xml(title: &str) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>",
    );
    append_escaped_text(&mut xml, title);
    xml.push_str("</dc:title></cp:coreProperties>");
    xml
}

fn append_escaped_text(xml: &mut String, text: &str) {
    for character in text.chars() {
        match character {
            '&' => xml.push_str("&amp;"),
            '<' => xml.push_str("&lt;"),
            '>' => xml.push_str("&gt;"),
            '"' => xml.push_str("&quot;"),
            '\'' => xml.push_str("&apos;"),
            _ => xml.push(character),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    use std::io::Read;
    use std::path::PathBuf;
    use zip::ZipArchive;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("aplot-document-docx-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn text(value: &str) -> DocumentBlock {
        DocumentBlock::Paragraph {
            text: value.to_string(),
        }
    }

    fn unzip(bytes: &[u8]) -> ZipArchive<Cursor<&[u8]>> {
        ZipArchive::new(Cursor::new(bytes)).expect("open generated DOCX")
    }

    fn part(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> String {
        let mut contents = String::new();
        archive
            .by_name(name)
            .unwrap_or_else(|error| panic!("missing {name}: {error}"))
            .read_to_string(&mut contents)
            .expect("read generated XML part");
        contents
    }

    fn assert_well_formed(xml: &str) {
        let mut reader = Reader::from_str(xml);
        reader.config_mut().enable_all_checks(true);
        let mut buffer = Vec::new();
        loop {
            match reader
                .read_event_into(&mut buffer)
                .expect("parse generated XML")
            {
                Event::Eof => break,
                Event::DocType(_) => panic!("generated XML must not contain a DOCTYPE"),
                _ => {}
            }
            buffer.clear();
        }
    }

    fn simple_document(blocks: Vec<DocumentBlock>) -> TextDocument {
        TextDocument {
            title: "Document".to_string(),
            blocks,
        }
    }

    #[test]
    fn writes_valid_package_with_escaped_unicode_text_tables_and_numbering() {
        let document = simple_document(vec![
            DocumentBlock::Heading {
                text: "Résumé & 東京".to_string(),
                level: 1,
            },
            text("5 < 7 & 9 > 2"),
            DocumentBlock::BulletList {
                items: vec!["First".to_string(), "Second • 東京".to_string()],
            },
            DocumentBlock::BulletList {
                items: vec!["Separate list".to_string()],
            },
            DocumentBlock::Table {
                headers: vec!["Name".to_string(), "Notes".to_string()],
                rows: vec![vec!["Zoë".to_string(), "A & B < C".to_string()]],
            },
            DocumentBlock::PageBreak,
        ]);
        let bytes = build(&document).expect("build document");
        assert!(bytes.len() <= MAX_OUTPUT_BYTES);

        let mut archive = unzip(&bytes);
        let expected_parts = [
            "[Content_Types].xml",
            "_rels/.rels",
            "docProps/core.xml",
            "word/document.xml",
            "word/styles.xml",
            "word/numbering.xml",
            "word/_rels/document.xml.rels",
        ];
        for name in expected_parts {
            let xml = part(&mut archive, name);
            assert_well_formed(&xml);
        }

        let document_xml = part(&mut archive, "word/document.xml");
        assert!(document_xml.contains("Résumé &amp; 東京"));
        assert!(document_xml.contains("5 &lt; 7 &amp; 9 &gt; 2"));
        assert!(document_xml.contains("w:tblHeader w:val=\"true\""));
        assert!(document_xml.contains("w:br w:type=\"page\""));
        assert!(!document_xml.contains("w:trHeight"));
        assert!(!document_xml.contains("w:noWrap"));
        assert!(document_xml.contains("w:numId w:val=\"1\""));
        assert!(document_xml.contains("w:numId w:val=\"2\""));

        let numbering_xml = part(&mut archive, "word/numbering.xml");
        assert!(numbering_xml.contains("w:numFmt w:val=\"bullet\""));
        assert!(numbering_xml.contains("w:lvlText w:val=\"•\""));
        let relationships = part(&mut archive, "word/_rels/document.xml.rels");
        assert!(relationships.contains("relationships/styles"));
        assert!(relationships.contains("relationships/numbering"));
        let root_relationships = part(&mut archive, "_rels/.rels");
        assert!(root_relationships.contains("word/document.xml"));
        assert!(root_relationships.contains("docProps/core.xml"));
    }

    #[test]
    fn round_trips_through_the_office_text_extractor() {
        let document = simple_document(vec![
            DocumentBlock::Heading {
                text: "Overview".to_string(),
                level: 2,
            },
            text("Line one\nLine two & <safe>"),
            DocumentBlock::BulletList {
                items: vec!["Alpha".to_string(), "Beta".to_string()],
            },
            DocumentBlock::Table {
                headers: vec!["City".to_string(), "Population".to_string()],
                rows: vec![vec!["東京".to_string(), "14 million".to_string()]],
            },
            DocumentBlock::PageBreak,
        ]);
        let bytes = build(&document).expect("build document");
        let directory = TestDirectory::new();
        let path = directory.file("roundtrip.docx");
        std::fs::write(&path, bytes).expect("write generated DOCX");

        let extracted = crate::document_text::extract_office(&path)
            .expect("extract generated DOCX")
            .expect("DOCX extension is supported");
        assert!(extracted.text.contains("Document\n"));
        assert!(extracted.text.contains("Overview\n"));
        assert!(extracted.text.contains("Line one\nLine two & <safe>\n"));
        assert!(extracted.text.contains("Alpha\nBeta\n"));
        assert!(extracted
            .text
            .contains("City\nPopulation\n東京\n14 million\n"));
        assert!(!extracted.truncated);
    }

    #[test]
    fn rejects_invalid_shapes_unsafe_controls_and_size_limits() {
        assert!(build(&simple_document(vec![DocumentBlock::Heading {
            text: "bad level".to_string(),
            level: 4,
        }]))
        .unwrap_err()
        .contains("heading level"));

        assert!(build(&simple_document(vec![DocumentBlock::Table {
            headers: vec!["A".to_string(), "B".to_string()],
            rows: vec![vec!["short".to_string()]],
        }]))
        .unwrap_err()
        .contains("row width"));

        assert!(build(&simple_document(vec![text("unsafe \u{1}")]))
            .unwrap_err()
            .contains("XML 1.0"));

        let too_much_text = "x".repeat(MAX_TEXT_BYTES + 1);
        assert!(build(&simple_document(vec![text(&too_much_text)]))
            .unwrap_err()
            .contains("text exceeds"));

        let too_many_blocks = vec![text(""); MAX_BLOCKS + 1];
        assert!(build(&simple_document(too_many_blocks))
            .unwrap_err()
            .contains("blocks"));

        assert!(build(&simple_document(vec![DocumentBlock::Table {
            headers: (0..=MAX_TABLE_COLUMNS)
                .map(|index| format!("C{index}"))
                .collect(),
            rows: Vec::new(),
        }]))
        .unwrap_err()
        .contains("columns"));

        assert!(build(&simple_document(vec![DocumentBlock::BulletList {
            items: vec![String::new(); MAX_LIST_ITEMS + 1],
        }]))
        .unwrap_err()
        .contains("items"));

        assert!(build(&simple_document(vec![DocumentBlock::Table {
            headers: vec!["only".to_string()],
            rows: vec![vec![String::new()]; MAX_TABLE_ROWS + 1],
        }]))
        .unwrap_err()
        .contains("data rows"));
    }
}
