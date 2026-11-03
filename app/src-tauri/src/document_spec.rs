//! Bounded, declarative input shared by local document writers.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextDocument {
    pub title: String,
    pub blocks: Vec<DocumentBlock>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum DocumentBlock {
    Paragraph {
        text: String,
    },
    Heading {
        text: String,
        level: u8,
    },
    BulletList {
        items: Vec<String>,
    },
    Table {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    PageBreak,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkbookDocument {
    pub title: String,
    pub sheets: Vec<WorkbookSheet>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkbookSheet {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<CellValue>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum CellValue {
    Text(String),
    Number(f64),
    Boolean(bool),
    Empty(()),
    Formula(FormulaCell),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FormulaCell {
    pub formula: String,
}
