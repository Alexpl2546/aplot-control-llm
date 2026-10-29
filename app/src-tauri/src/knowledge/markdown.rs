//! Read-only Markdown parsing for the index: YAML properties, heading sections and
//! links. Note text is data; nothing in it is interpreted beyond its structure.

use serde_json::{Map, Value};

/// Sections longer than this are split at paragraph breaks outside code blocks.
const MAX_CHUNK_CHARS: usize = 6000;

#[derive(Debug, Default, PartialEq)]
pub struct Note {
    pub title: String,
    pub properties: Map<String, Value>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub aplot_id: Option<String>,
    /// Text after the properties block, unchanged.
    pub body: String,
    /// One-based line of the first body line in the file.
    pub body_line: usize,
    pub chunks: Vec<Chunk>,
    pub links: Vec<Link>,
}

#[derive(Debug, PartialEq)]
pub struct Chunk {
    /// Heading path such as `Plan › Risks`; empty before the first heading.
    pub heading: String,
    pub level: u8,
    pub line_start: usize,
    pub line_end: usize,
    pub text: String,
}

#[derive(Debug, PartialEq)]
pub struct Link {
    pub target: String,
    /// `wiki`, `embed`, `markdown` or `url`.
    pub kind: &'static str,
    pub line: usize,
}

pub fn parse(text: &str, file_stem: &str) -> Note {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let (properties, body, body_line) = split_front_matter(text);
    let mut note = Note {
        properties,
        body: body.to_owned(),
        body_line,
        ..Note::default()
    };
    note.tags = strings(note.properties.get("tags").or(note.properties.get("tag")));
    note.aliases = strings(
        note.properties
            .get("aliases")
            .or(note.properties.get("alias")),
    );
    note.aplot_id = note
        .properties
        .get("aplot_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|s| !s.is_empty());
    sections(&mut note);
    let first_h1 = note
        .chunks
        .iter()
        .find(|c| c.level == 1)
        .map(|c| c.heading.clone());
    note.title = note
        .properties
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or(first_h1)
        .unwrap_or_else(|| file_stem.to_owned());
    for tag in &mut note.tags {
        *tag = tag.trim_start_matches('#').to_owned();
    }
    note.tags.retain(|t| !t.is_empty());
    note.tags.dedup();
    note
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s.trim().to_owned()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .filter(|s| !s.is_empty())
            .collect(),
        Some(Value::String(s)) => s
            .split([',', ' '])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

/// Split a leading `---` block. Malformed properties leave the whole file as body.
fn split_front_matter(text: &str) -> (Map<String, Value>, &str, usize) {
    let mut lines = text.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return (Map::new(), text, 1);
    };
    if first.trim_end() != "---" {
        return (Map::new(), text, 1);
    }
    let mut offset = first.len();
    let mut yaml = Vec::new();
    for (index, line) in lines.enumerate() {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            let body = &text[offset + line.len()..];
            return (parse_yaml(&yaml), body, index + 3);
        }
        yaml.push(trimmed);
        offset += line.len();
    }
    (Map::new(), text, 1)
}

/// A deliberately small YAML subset that covers Obsidian properties: flat
/// `key: value`, inline `[a, b]` lists and indented `- item` lists. Anything else
/// is kept as text; nothing is evaluated.
fn parse_yaml(lines: &[&str]) -> Map<String, Value> {
    let mut map = Map::new();
    let mut list_key: Option<String> = None;
    for line in lines {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with([' ', '\t']);
        let trimmed = line.trim();
        if let (true, Some(key)) = (trimmed.starts_with("- ") || trimmed == "-", &list_key) {
            let item = scalar(trimmed.trim_start_matches('-').trim());
            if let Some(Value::Array(items)) = map.get_mut(key) {
                items.push(item);
            }
            continue;
        }
        if indented {
            continue;
        }
        list_key = None;
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = unquote(key.trim()).to_owned();
        if key.is_empty() || map.len() >= 200 {
            continue;
        }
        let value = value.trim();
        if value.is_empty() {
            map.insert(key.clone(), Value::Array(Vec::new()));
            list_key = Some(key);
        } else if value.starts_with('[') && value.ends_with(']') {
            let items = value[1..value.len() - 1]
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(scalar)
                .collect();
            map.insert(key, Value::Array(items));
        } else {
            map.insert(key, scalar(value));
        }
    }
    // An empty key followed by nothing is a null property, not an empty list.
    for value in map.values_mut() {
        if matches!(value, Value::Array(items) if items.is_empty()) {
            *value = Value::Null;
        }
    }
    map
}

fn unquote(text: &str) -> &str {
    let bytes = text.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &text[1..text.len() - 1]
    } else {
        text
    }
}

fn scalar(text: &str) -> Value {
    let quoted = text.starts_with(['"', '\'']);
    let text = unquote(text);
    if quoted {
        return Value::String(text.to_owned());
    }
    match text {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" | "~" => Value::Null,
        _ => text
            .parse::<i64>()
            .map(Value::from)
            .unwrap_or_else(|_| Value::String(text.to_owned())),
    }
}

fn fence(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    ["```", "~~~"].into_iter().find(|f| trimmed.starts_with(f))
}

fn heading(line: &str) -> Option<(u8, String)> {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    if !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    let title = rest.trim().trim_end_matches('#').trim();
    Some((hashes as u8, title.to_owned()))
}

/// Split the body at ATX headings outside fenced code and collect links and inline tags.
fn sections(note: &mut Note) {
    let mut path: Vec<(u8, String)> = Vec::new();
    let mut current = Chunk {
        heading: String::new(),
        level: 0,
        line_start: note.body_line,
        line_end: note.body_line,
        text: String::new(),
    };
    let mut open_fence: Option<&str> = None;
    let body = note.body.clone();
    for (index, line) in body.lines().enumerate() {
        let number = note.body_line + index;
        if let Some(f) = fence(line) {
            open_fence = match open_fence {
                Some(open) if open == f => None,
                None => Some(f),
                other => other,
            };
        } else if open_fence.is_none() {
            if let Some((level, title)) = heading(line) {
                push_chunk(
                    &mut note.chunks,
                    std::mem::replace(
                        &mut current,
                        Chunk {
                            heading: String::new(),
                            level,
                            line_start: number,
                            line_end: number,
                            text: String::new(),
                        },
                    ),
                );
                path.retain(|(l, _)| *l < level);
                path.push((level, title));
                current.heading = path
                    .iter()
                    .map(|(_, t)| t.as_str())
                    .collect::<Vec<_>>()
                    .join(" › ");
                current.text.push_str(line);
                current.text.push('\n');
                continue;
            }
            links(line, number, &mut note.links);
            inline_tags(line, &mut note.tags);
        }
        current.text.push_str(line);
        current.text.push('\n');
        current.line_end = number;
    }
    push_chunk(&mut note.chunks, current);
}

fn push_chunk(chunks: &mut Vec<Chunk>, chunk: Chunk) {
    if chunk.text.trim().is_empty() {
        return;
    }
    if chunk.text.chars().count() <= MAX_CHUNK_CHARS {
        chunks.push(chunk);
        return;
    }
    // Long sections are cut at blank lines outside code, never inside a fence.
    let mut part = String::new();
    let mut start = chunk.line_start;
    let mut open = false;
    for (index, line) in chunk.text.lines().enumerate() {
        if fence(line).is_some() {
            open = !open;
        }
        if !open && line.trim().is_empty() && part.chars().count() >= MAX_CHUNK_CHARS / 2 {
            chunks.push(Chunk {
                heading: chunk.heading.clone(),
                level: chunk.level,
                line_start: start,
                line_end: chunk.line_start + index,
                text: std::mem::take(&mut part),
            });
            start = chunk.line_start + index + 1;
            continue;
        }
        part.push_str(line);
        part.push('\n');
    }
    if !part.trim().is_empty() {
        chunks.push(Chunk {
            heading: chunk.heading,
            level: chunk.level,
            line_start: start,
            line_end: chunk.line_end,
            text: part,
        });
    }
}

fn links(line: &str, number: usize, out: &mut Vec<Link>) {
    let mut rest = line;
    while let Some(start) = rest.find("[[") {
        let embed = start > 0 && rest.as_bytes()[start - 1] == b'!';
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let inner = &after[..end];
        let target = inner
            .split(['|', '#', '^'])
            .next()
            .unwrap_or_default()
            .trim();
        if !target.is_empty() && out.len() < 2000 {
            out.push(Link {
                target: target.to_owned(),
                kind: if embed { "embed" } else { "wiki" },
                line: number,
            });
        }
        rest = &after[end + 2..];
    }
    let mut rest = line;
    while let Some(start) = rest.find("](") {
        let after = &rest[start + 2..];
        let Some(end) = after.find(')') else { break };
        let target = after[..end].split_whitespace().next().unwrap_or_default();
        let target = target.trim_matches(['<', '>']);
        if !target.is_empty() && !target.starts_with('#') && out.len() < 2000 {
            let external = target.contains("://") || target.starts_with("mailto:");
            let target = if external {
                target.to_owned()
            } else {
                target
                    .split('#')
                    .next()
                    .unwrap_or_default()
                    .replace("%20", " ")
            };
            if !target.is_empty() {
                out.push(Link {
                    target,
                    kind: if external { "url" } else { "markdown" },
                    line: number,
                });
            }
        }
        rest = &after[end + 1..];
    }
}

/// Obsidian inline tags: `#tag` after whitespace, with letters, digits, `_`, `-`, `/`.
fn inline_tags(line: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace()) {
            let tag: String = chars[i + 1..]
                .iter()
                .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
                .collect();
            if tag.chars().any(char::is_alphabetic) && !out.contains(&tag) && out.len() < 200 {
                out.push(tag.clone());
            }
            i += tag.chars().count() + 1;
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_properties_without_changing_the_body() {
        let text = "---\r\naplot_id: \"note-1\"\r\ntitle: Решение по поиску\r\ntags:\r\n  - architecture\r\n  - '#knowledge'\r\naliases: [Поиск, Search]\r\nweight: 3\r\nempty:\r\n---\r\n# Heading\r\nBody\r\n";
        let note = parse(text, "file");
        assert_eq!(note.aplot_id.as_deref(), Some("note-1"));
        assert_eq!(note.title, "Решение по поиску");
        assert_eq!(note.tags, vec!["architecture", "knowledge"]);
        assert_eq!(note.aliases, vec!["Поиск", "Search"]);
        assert_eq!(note.properties["weight"], 3);
        assert_eq!(note.properties["empty"], Value::Null);
        assert_eq!(note.body, "# Heading\r\nBody\r\n");
        assert_eq!(note.body_line, 11);
        assert_eq!(note.chunks[0].line_start, 11);
    }

    #[test]
    fn unterminated_properties_stay_in_the_body() {
        let note = parse("---\ntitle: x\nno end", "stem");
        assert!(note.properties.is_empty());
        assert_eq!(note.title, "stem");
        assert!(note.body.starts_with("---"));
    }

    #[test]
    fn splits_by_headings_outside_code_and_keeps_heading_paths() {
        let text = "Intro line\n# Plan\nText\n## Risks\n```bash\n# not a heading\n```\n## Steps\nGo\n# Next\nEnd\n";
        let note = parse(text, "x");
        let headings: Vec<&str> = note.chunks.iter().map(|c| c.heading.as_str()).collect();
        assert_eq!(
            headings,
            vec!["", "Plan", "Plan › Risks", "Plan › Steps", "Next"]
        );
        assert!(note.chunks[2].text.contains("# not a heading"));
        assert_eq!(note.title, "Plan");
        assert_eq!((note.chunks[1].line_start, note.chunks[1].line_end), (2, 3));
    }

    #[test]
    fn long_sections_split_at_paragraphs() {
        let paragraph = "слово ".repeat(400);
        let text = format!("# Long\n{paragraph}\n\n{paragraph}\n\n{paragraph}\n");
        let note = parse(&text, "x");
        assert!(note.chunks.len() > 1);
        assert!(note.chunks.iter().all(|c| c.heading == "Long"));
    }

    #[test]
    fn collects_links_and_inline_tags() {
        let text = "See [[Decisions/Search|search]] and ![[diagram.png]] and [doc](Other%20Note.md#part) or [site](https://example.com). #idea #2026 x#no\n```\n[[Inside code]]\n```\n";
        let note = parse(text, "x");
        let links: Vec<(&str, &str)> = note
            .links
            .iter()
            .map(|l| (l.target.as_str(), l.kind))
            .collect();
        assert_eq!(
            links,
            vec![
                ("Decisions/Search", "wiki"),
                ("diagram.png", "embed"),
                ("Other Note.md", "markdown"),
                ("https://example.com", "url")
            ]
        );
        assert_eq!(note.tags, vec!["idea"]);
    }
}
