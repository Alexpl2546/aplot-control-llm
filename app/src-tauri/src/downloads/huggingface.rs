use super::{
    paths, DownloadFile, DownloadSearchPage, DownloadSearchResult, DownloadSelection,
    DownloadVariant, ResolvedDownload,
};
use reqwest::{Client, Url};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

pub fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent("Aplot-Control-LLM/model-downloads")
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("Too many redirects");
            }
            let url = attempt.url();
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                attempt.error("Unsafe download redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

fn decode(text: &str) -> Result<String, String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut n = 0;
    while n < bytes.len() {
        if bytes[n] == b'%' {
            if n + 2 >= bytes.len() {
                return Err("Invalid URL encoding".into());
            }
            let digit = |b: u8| match b {
                b'0'..=b'9' => Some(b - b'0'),
                b'a'..=b'f' => Some(b - b'a' + 10),
                b'A'..=b'F' => Some(b - b'A' + 10),
                _ => None,
            };
            out.push(
                digit(bytes[n + 1]).ok_or("Invalid URL encoding")? * 16
                    + digit(bytes[n + 2]).ok_or("Invalid URL encoding")?,
            );
            n += 3;
        } else {
            out.push(bytes[n]);
            n += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Invalid UTF-8 URL".into())
}

pub fn source(text: &str) -> Result<(String, String, Option<String>), String> {
    let trimmed = text.trim();
    let pieces: Vec<String> = if trimmed.contains("://") {
        // Url normalizes dot segments, so reject traversal before parsing it.
        for raw in trimmed.split('/').skip(3) {
            let piece = decode(raw.split(['?', '#']).next().unwrap_or(raw))?;
            if piece == "." || piece == ".." || piece.contains('\\') {
                return Err("Unsafe Hugging Face URL path".into());
            }
        }
        let url = Url::parse(trimmed).map_err(|_| "Invalid Hugging Face URL")?;
        if url.scheme() != "https"
            || url.host_str() != Some("huggingface.co")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query_pairs().any(|(key, value)| {
                !matches!(
                    (key.as_ref(), value.as_ref()),
                    ("download", "true" | "1") | ("local-app", "llama.cpp")
                )
            })
            || url.fragment().is_some()
        {
            return Err("Use a public HTTPS huggingface.co repository or file URL".into());
        }
        url.path()
            .trim_matches('/')
            .split('/')
            .map(decode)
            .collect::<Result<_, _>>()?
    } else {
        if trimmed.split('/').count() != 2 {
            return Err(
                "Enter owner/repository; use a complete HTTPS URL for a file or revision".into(),
            );
        }
        trimmed.split('/').map(String::from).collect()
    };
    if pieces.len() < 2 {
        return Err("Enter owner/repository or a Hugging Face model URL".into());
    }
    for piece in &pieces[..2] {
        if piece.is_empty()
            || piece == "."
            || piece == ".."
            || !piece
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        {
            return Err("Invalid Hugging Face repository ID".into());
        }
    }
    let repo = format!("{}/{}", pieces[0], pieces[1]);
    let mut revision = "main".to_string();
    let mut file = None;
    if pieces.len() > 2 {
        if pieces.len() < 4 || !matches!(pieces[2].as_str(), "blob" | "resolve" | "tree") {
            return Err("Unsupported Hugging Face URL; use repository/blob/revision/file".into());
        }
        revision = pieces[3].clone();
        if pieces.len() > 4 && pieces[2] != "tree" {
            file = Some(pieces[4..].join("/"));
        }
    }
    if let Some(path) = &file {
        paths::validate_relative(path)?;
    }
    if revision.is_empty() || revision.chars().any(char::is_control) {
        return Err("Invalid revision".into());
    }
    Ok((repo, revision, file))
}

fn url(parts: &[&str]) -> Result<Url, String> {
    let mut url = Url::parse("https://huggingface.co").unwrap();
    url.path_segments_mut()
        .map_err(|_| "Invalid base URL")?
        .extend(parts.iter().copied());
    Ok(url)
}

pub fn file_url(repo: &str, revision: &str, path: &str) -> Result<Url, String> {
    paths::validate_relative(path)?;
    let mut parts: Vec<&str> = repo.split('/').collect();
    parts.extend(["resolve", revision]);
    parts.extend(path.split('/'));
    url(&parts)
}

async fn json_response(mut response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("This repository requires access approval or authentication. Open its Hugging Face page; this release downloads public repositories only.".into());
    }
    if !status.is_success() {
        return Err(format!("Hugging Face returned HTTP {}", status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > 32 * 1024 * 1024)
    {
        return Err("Repository metadata is too large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| e.without_url().to_string())?
    {
        if body.len().saturating_add(chunk.len()) > 32 * 1024 * 1024 {
            return Err("Repository metadata is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

fn search_url(query: &str, engine: &str, limit: Option<usize>) -> Result<(Url, usize), String> {
    if !matches!(engine, "llama_cpp" | "llama.cpp") {
        return Err("Hugging Face GGUF search is for llama.cpp. Use the Strata model catalog to download and prepare Strata models.".into());
    }
    let query = query.trim();
    if query.chars().count() > 256 || query.chars().any(char::is_control) {
        return Err("Use a model search query of at most 256 characters".into());
    }
    let limit = limit.unwrap_or(12).clamp(1, 50);
    let mut url = url(&["api", "models"])?;
    // These are the Hub API's app and library/tag filters, not name searches.
    // GGUF discovery does not certify an architecture for the installed engine.
    let mut params = url.query_pairs_mut();
    params
        .append_pair("apps", "llama.cpp")
        .append_pair("filter", "gguf")
        .append_pair("sort", "downloads")
        .append_pair("limit", &limit.to_string());
    if !query.is_empty() {
        params.append_pair("search", query);
    }
    for field in [
        "downloads",
        "likes",
        "tags",
        "pipeline_tag",
        "lastModified",
        "gated",
        "gguf",
        "safetensors",
        "cardData",
        "config",
    ] {
        params.append_pair("expand", field);
    }
    drop(params);
    Ok((url, limit))
}

fn search_results(value: &Value, limit: usize) -> Result<Vec<DownloadSearchResult>, String> {
    let mut seen = BTreeSet::new();
    let mut results = Vec::new();
    for entry in value
        .as_array()
        .ok_or("Invalid Hugging Face model search response")?
    {
        let Some(repo) = entry["id"].as_str() else {
            continue;
        };
        let Ok((repo, _, _)) = source(repo) else {
            continue;
        };
        if !seen.insert(repo.clone()) || entry["private"].as_bool() == Some(true) {
            continue;
        }
        let tags: Vec<String> = entry["tags"]
            .as_array()
            .map(|tags| {
                tags.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        // Do not silently expose an unfiltered response if API semantics change.
        if !tags.iter().any(|tag| tag == "gguf") {
            continue;
        }
        results.push(DownloadSearchResult {
            parameter_count: entry["gguf"]["total"]
                .as_u64()
                .or_else(|| entry["safetensors"]["total"].as_u64()),
            context_length: entry["gguf"]["context_length"].as_u64(),
            size_bytes: entry["gguf"]["totalFileSize"].as_u64(),
            architecture: short_text(&entry["gguf"]["architecture"])
                .or_else(|| short_text(&entry["config"]["model_type"])),
            base_model: short_text(&entry["cardData"]["base_model"]).or_else(|| {
                entry["cardData"]["base_model"]
                    .as_array()?
                    .first()
                    .and_then(short_text)
            }),
            license: short_text(&entry["cardData"]["license"]),
            description: short_text(&entry["cardData"]["description"]),
            publisher: repo.split('/').next().unwrap_or_default().into(),
            repository_url: format!("https://huggingface.co/{repo}"),
            repo_id: repo,
            downloads: entry["downloads"].as_u64().unwrap_or(0),
            likes: entry["likes"].as_u64().unwrap_or(0),
            tags,
            pipeline_tag: entry["pipeline_tag"].as_str().map(str::to_owned),
            last_modified: entry["lastModified"].as_str().map(str::to_owned),
            gated: entry["gated"].as_bool().unwrap_or_else(|| {
                entry["gated"]
                    .as_str()
                    .is_some_and(|value| matches!(value, "auto" | "manual"))
            }),
        });
        if results.len() == limit {
            break;
        }
    }
    Ok(results)
}

pub async fn search(
    query: &str,
    engine: &str,
    limit: Option<usize>,
    cursor: Option<&str>,
    sort: Option<&str>,
    all_gguf: bool,
) -> Result<DownloadSearchPage, String> {
    let (url, limit) = paged_search_url(query, engine, limit, cursor, sort, all_gguf)?;
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let next_cursor = response
        .headers()
        .get(reqwest::header::LINK)
        .and_then(|value| value.to_str().ok())
        .and_then(search_next_cursor);
    Ok(DownloadSearchPage {
        items: search_results(&json_response(response).await?, limit)?,
        next_cursor,
    })
}

fn short_text(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| {
        text.chars()
            .filter(|ch| !ch.is_control())
            .take(240)
            .collect()
    })
}

fn paged_search_url(
    query: &str,
    engine: &str,
    limit: Option<usize>,
    cursor: Option<&str>,
    sort: Option<&str>,
    all_gguf: bool,
) -> Result<(Url, usize), String> {
    let (mut url, limit) = search_url(query, engine, limit)?;
    let sort = sort.unwrap_or("downloads");
    if !matches!(sort, "downloads" | "lastModified" | "likes") {
        return Err("Unsupported model sort order".into());
    }
    let pairs: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key != "sort" && !(all_gguf && key == "apps"))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.set_query(None);
    url.query_pairs_mut()
        .extend_pairs(pairs)
        .append_pair("sort", sort)
        .append_pair("direction", "-1");
    if let Some(cursor) = cursor {
        if cursor.len() > 8192 || cursor.is_empty() || cursor.chars().any(char::is_control) {
            return Err("Invalid model search cursor".into());
        }
        url.query_pairs_mut().append_pair("cursor", cursor);
    }
    Ok((url, limit))
}

fn search_next_cursor(header: &str) -> Option<String> {
    for part in header.split(',') {
        let (target, relation) = part.trim().split_once('>')?;
        if !relation
            .split(';')
            .any(|value| value.trim() == "rel=\"next\"")
        {
            continue;
        }
        let next = Url::parse(target.strip_prefix('<')?).ok()?;
        if next.scheme() != "https"
            || next.host_str() != Some("huggingface.co")
            || next.path() != "/api/models"
            || next.port().is_some()
            || !next.username().is_empty()
            || next.password().is_some()
        {
            return None;
        }
        return next
            .query_pairs()
            .find(|(key, value)| key == "cursor" && !value.is_empty() && value.len() <= 8192)
            .map(|(_, value)| value.into_owned());
    }
    None
}

fn next_page(response: &reqwest::Response, first: &Url) -> Result<Option<Url>, String> {
    for header in response.headers().get_all(reqwest::header::LINK) {
        let link = header
            .to_str()
            .map_err(|_| "Invalid repository pagination header")?;
        if let Some(page) = pagination_link(link, response.url(), first)? {
            return Ok(Some(page));
        }
    }
    Ok(None)
}

fn pagination_link(link: &str, current: &Url, first: &Url) -> Result<Option<Url>, String> {
    for part in link.split(',') {
        let Some((href, attributes)) = part
            .trim()
            .strip_prefix('<')
            .and_then(|s| s.split_once('>'))
        else {
            continue;
        };
        if !attributes.split(';').any(|attribute| {
            attribute.trim().strip_prefix("rel=").is_some_and(|rels| {
                rels.trim_matches('"')
                    .split_whitespace()
                    .any(|rel| rel == "next")
            })
        }) {
            continue;
        }
        let page = current
            .join(href)
            .map_err(|_| "Invalid repository pagination URL")?;
        // Keep every page in the exact repository and immutable revision.
        if page.scheme() != first.scheme()
            || page.host_str() != first.host_str()
            || page.port_or_known_default() != first.port_or_known_default()
            || !page.username().is_empty()
            || page.password().is_some()
            || page.fragment().is_some()
            || page.path() != first.path()
        {
            return Err("Unsafe repository pagination URL".into());
        }
        return Ok(Some(page));
    }
    Ok(None)
}

pub fn split_name(path: &str) -> Option<(String, usize, usize)> {
    if !path.to_ascii_lowercase().ends_with(".gguf") {
        return None;
    }
    let name = &path[..path.len() - 5];
    let (left, total) = name.rsplit_once("-of-")?;
    let (base, index) = left.rsplit_once('-')?;
    if index.len() != 5 || total.len() != 5 {
        return None;
    }
    Some((base.into(), index.parse().ok()?, total.parse().ok()?))
}

fn quantization(path: &str) -> Option<String> {
    let upper = path.to_ascii_uppercase();
    upper
        .split(['-', '.', '/'])
        .rev()
        .find(|part| {
            let suffix = part
                .strip_prefix("IQ")
                .or_else(|| part.strip_prefix("TQ"))
                .or_else(|| part.strip_prefix('Q'));
            suffix.is_some_and(|s| s.as_bytes().first().is_some_and(u8::is_ascii_digit))
                || matches!(*part, "F16" | "BF16" | "F32" | "F64" | "MXFP4" | "NVFP4")
        })
        .map(str::to_string)
}

pub fn variants(files: &[DownloadFile]) -> Vec<DownloadVariant> {
    let mut groups: BTreeMap<String, Vec<&DownloadFile>> = BTreeMap::new();
    for file in files.iter().filter(|f| f.role != "mmproj") {
        let id = split_name(&file.path)
            .map(|s| s.0)
            .unwrap_or_else(|| file.path.clone());
        groups.entry(id).or_default().push(file);
    }
    groups
        .into_iter()
        .map(|(id, mut group)| {
            group.sort_by(|a, b| a.path.cmp(&b.path));
            let complete = if let Some((_, _, total)) = split_name(&group[0].path) {
                total > 0
                    && group.len() == total
                    && group.iter().enumerate().all(|(i, f)| {
                        split_name(&f.path).is_some_and(|(_, n, t)| n == i + 1 && t == total)
                    })
            } else {
                group.len() == 1
            };
            DownloadVariant {
                label: group[0]
                    .quantization
                    .clone()
                    .map(|q| format!("{q} · {id}"))
                    .unwrap_or_else(|| id.clone()),
                id,
                files: group.iter().map(|f| f.path.clone()).collect(),
                total_bytes: group
                    .iter()
                    .fold(0u64, |sum, f| sum.saturating_add(f.size_bytes)),
                complete,
            }
        })
        .collect()
}

pub async fn resolve(text: &str, pinned: Option<&str>) -> Result<ResolvedDownload, String> {
    let (repo, requested, suggested) = source(text)?;
    let client = client()?;
    let rp: Vec<_> = repo.split('/').collect();
    let info = url(&[
        "api",
        "models",
        rp[0],
        rp[1],
        "revision",
        pinned.unwrap_or(&requested),
    ])?;
    let metadata = json_response(client.get(info).send().await.map_err(|e| e.to_string())?).await?;
    let revision = metadata["sha"]
        .as_str()
        .filter(|s| s.len() == 40 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("Repository did not return an immutable commit SHA")?
        .to_string();
    if pinned.is_some_and(|p| p != revision) {
        return Err("Repository revision changed unexpectedly".into());
    }
    let mut first_page = url(&["api", "models", rp[0], rp[1], "tree", &revision])?;
    first_page
        .query_pairs_mut()
        .append_pair("recursive", "true")
        .append_pair("expand", "false");
    let mut next = Some(first_page.clone());
    let mut files = Vec::new();
    let mut visited = BTreeSet::new();
    let mut seen_files = BTreeMap::new();
    let mut pages = 0;
    while let Some(page) = next.take() {
        pages += 1;
        if pages > 200 {
            return Err("Repository has too many metadata pages".into());
        }
        if !visited.insert(page.as_str().to_owned()) {
            return Err("Repository pagination repeated a page".into());
        }
        let response = client.get(page).send().await.map_err(|e| e.to_string())?;
        next = next_page(&response, &first_page)?;
        let value = json_response(response).await?;
        for entry in value.as_array().ok_or("Invalid repository tree")? {
            let Some(path) = entry["path"].as_str() else {
                continue;
            };
            if entry["type"] != "file" || !path.to_ascii_lowercase().ends_with(".gguf") {
                continue;
            }
            paths::validate_relative(path)?;
            let size = entry["size"]
                .as_u64()
                .ok_or("Repository file has no size")?;
            let sha = entry["lfs"]["oid"]
                .as_str()
                .or_else(|| entry["lfs"]["sha256"].as_str())
                .map(|s| s.trim_start_matches("sha256:"));
            let sha = sha
                .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
                .map(|s| s.to_ascii_lowercase());
            if let Some(previous) = seen_files.insert(path.to_string(), (size, sha.clone())) {
                if previous != (size, sha.clone()) {
                    return Err("Repository metadata contains conflicting file entries".into());
                }
                continue;
            }
            let role = if path
                .rsplit('/')
                .next()
                .unwrap_or(path)
                .to_ascii_lowercase()
                .contains("mmproj")
            {
                "mmproj"
            } else if split_name(path).is_some() {
                "shard"
            } else {
                "model"
            };
            files.push(DownloadFile {
                path: path.into(),
                size_bytes: size,
                sha256: sha,
                local_sha256: None,
                role: role.into(),
                quantization: quantization(path),
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    if suggested
        .as_ref()
        .is_some_and(|path| !files.iter().any(|file| &file.path == path))
    {
        return Err("The requested GGUF file is absent from the pinned repository revision".into());
    }
    let variants = variants(&files);
    Ok(ResolvedDownload {
        source: text.trim().into(),
        repo_id: repo.clone(),
        revision: revision.clone(),
        publisher: rp[0].into(),
        repository_url: format!("https://huggingface.co/{repo}"),
        license_url: format!("https://huggingface.co/{repo}/blob/{revision}/README.md"),
        files,
        variants,
        suggested_file: suggested,
    })
}

pub fn select(
    resolved: &ResolvedDownload,
    selection: &DownloadSelection,
) -> Result<Vec<DownloadFile>, String> {
    let mut wanted: BTreeSet<String> = selection.files.iter().cloned().collect();
    if wanted.is_empty() {
        return Err("Select a GGUF model".into());
    }
    for variant in &resolved.variants {
        if variant.files.iter().any(|f| wanted.contains(f)) {
            if !variant.complete {
                return Err(format!("Incomplete split-GGUF set: {}", variant.id));
            }
            wanted.extend(variant.files.iter().cloned());
        }
    }
    let files: Vec<_> = resolved
        .files
        .iter()
        .filter(|f| wanted.contains(&f.path))
        .cloned()
        .collect();
    if files.len() != wanted.len() {
        return Err("Selected file is not in the pinned repository revision".into());
    }
    let groups = resolved
        .variants
        .iter()
        .filter(|v| v.files.iter().any(|f| wanted.contains(f)))
        .count();
    if groups != 1 {
        return Err(
            "Select exactly one model/quantization and its optional explicitly selected mmproj"
                .into(),
        );
    }
    if files.iter().filter(|f| f.role == "mmproj").count() > 1 {
        return Err("Select at most one explicit mmproj".into());
    }
    let mut windows = BTreeSet::new();
    for f in &files {
        if !windows.insert(f.path.to_lowercase()) {
            return Err("Repository paths conflict on Windows".into());
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "Read-only live Hugging Face catalog check; no model files are downloaded"]
    async fn live_catalog_metadata_and_next_page() {
        let first = search("", "llama_cpp", Some(3), None, Some("downloads"), false)
            .await
            .unwrap();
        assert!(!first.items.is_empty());
        assert!(first
            .items
            .iter()
            .any(|model| model.parameter_count.is_some() && model.size_bytes.is_some()));
        let cursor = first.next_cursor.as_deref().expect("next catalog page");
        let next = search(
            "",
            "llama_cpp",
            Some(3),
            Some(cursor),
            Some("downloads"),
            false,
        )
        .await
        .unwrap();
        assert!(!next.items.is_empty());
        assert_ne!(first.items[0].repo_id, next.items[0].repo_id);
        println!(
            "PASS: {} + {} public models, metadata and next page",
            first.items.len(),
            next.items.len()
        );
    }

    #[test]
    fn model_search_paginates_without_following_an_untrusted_url() {
        let (page, _) = paged_search_url(
            "Gemma",
            "llama_cpp",
            Some(20),
            Some("opaque+/="),
            Some("lastModified"),
            true,
        )
        .unwrap();
        assert!(!page.query_pairs().any(|(key, _)| key == "apps"));
        assert!(page
            .query_pairs()
            .any(|(key, value)| key == "cursor" && value == "opaque+/="));
        assert!(page
            .query_pairs()
            .any(|(key, value)| key == "sort" && value == "lastModified"));
        assert!(paged_search_url("", "llama_cpp", None, None, Some("bad"), false).is_err());
        assert!(paged_search_url("", "llama_cpp", None, Some("bad\n"), None, false).is_err());
        assert_eq!(
            search_next_cursor("<https://huggingface.co/api/models?cursor=abc%2B>; rel=\"next\""),
            Some("abc+".into())
        );
        for header in [
            "<https://evil.example/api/models?cursor=abc>; rel=\"next\"",
            "<https://huggingface.co/api/datasets?cursor=abc>; rel=\"next\"",
            "<http://huggingface.co/api/models?cursor=abc>; rel=\"next\"",
        ] {
            assert_eq!(search_next_cursor(header), None);
        }
    }

    #[test]
    fn model_search_preserves_reported_metadata_without_inventing_missing_sizes() {
        let rows = search_results(&serde_json::json!([
            {"id":"alice/8B-GGUF","tags":["gguf"],"gguf":{"total":8000000000_u64,"context_length":131072,"totalFileSize":4000000000_u64,"architecture":"llama"},"cardData":{"base_model":["alice/Base"],"license":"apache-2.0","description":"Model card description"}},
            {"id":"alice/Unknown-GGUF","tags":["gguf"]}
        ]), 20).unwrap();
        assert_eq!(rows[0].parameter_count, Some(8000000000));
        assert_eq!(rows[0].context_length, Some(131072));
        assert_eq!(rows[0].size_bytes, Some(4000000000));
        assert_eq!(rows[0].base_model.as_deref(), Some("alice/Base"));
        assert_eq!(rows[0].license.as_deref(), Some("apache-2.0"));
        assert!(rows[1].size_bytes.is_none());
        assert!(rows[1].parameter_count.is_none());
    }

    #[test]
    fn search_uses_hub_engine_and_format_filters_and_bounds_input() {
        let (url, limit) = search_url(" Qwen & Gemma ", "llama_cpp", None).unwrap();
        let pairs: Vec<_> = url.query_pairs().collect();
        assert_eq!(limit, 12);
        for expected in [
            ("apps", "llama.cpp"),
            ("filter", "gguf"),
            ("sort", "downloads"),
            ("limit", "12"),
            ("search", "Qwen & Gemma"),
            ("expand", "tags"),
            ("expand", "downloads"),
        ] {
            assert!(pairs
                .iter()
                .any(|(key, value)| key == expected.0 && value == expected.1));
        }
        assert_eq!(search_url("", "llama.cpp", Some(500)).unwrap().1, 50);
        assert_eq!(search_url("", "llama.cpp", Some(0)).unwrap().1, 1);
        assert!(search_url("Qwen", "strata", None).is_err());
        assert!(search_url("Qwen\nGemma", "llama_cpp", None).is_err());
        assert!(search_url(&"a".repeat(257), "llama_cpp", None).is_err());
    }

    #[test]
    fn search_requires_gguf_and_preserves_gated_metadata_without_claiming_compatibility() {
        let value = serde_json::json!([
            {"id":"alice/model-GGUF","downloads":123,"likes":45,"tags":["gguf","text-generation"],"pipeline_tag":"text-generation","lastModified":"2026-10-23T00:00:00Z","gated":false},
            {"id":"alice/model-GGUF","tags":["gguf"]},
            {"id":"alice/source","tags":["transformers"]},
            {"id":"alice/private","tags":["gguf"],"private":true},
            {"id":"../invalid","tags":["gguf"]},
            {"id":"bob/gated-GGUF","tags":["gguf"],"gated":"manual"}
        ]);
        let results = search_results(&value, 12).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].repo_id, "alice/model-GGUF");
        assert_eq!(results[0].publisher, "alice");
        assert_eq!(results[0].downloads, 123);
        assert_eq!(results[0].likes, 45);
        assert_eq!(results[0].pipeline_tag.as_deref(), Some("text-generation"));
        assert!(!results[0].gated);
        assert!(results[1].gated);
        assert_eq!(search_results(&value, 1).unwrap().len(), 1);
        assert!(search_results(&serde_json::json!({"error":"bad"}), 12).is_err());
    }

    #[test]
    fn pagination_keeps_the_exact_repository_commit_and_supports_relative_links() {
        let first = Url::parse(&format!(
            "https://huggingface.co/api/models/alice/model/tree/{}?recursive=true",
            "a".repeat(40)
        ))
        .unwrap();
        let next = pagination_link(
            "<?recursive=true&cursor=abc>; rel=\"next\", <?cursor=old>; rel=\"prev\"",
            &first,
            &first,
        )
        .unwrap()
        .unwrap();
        assert_eq!(next.path(), first.path());
        assert_eq!(next.query(), Some("recursive=true&cursor=abc"));
        assert!(pagination_link("<?cursor=abc>; rel=next", &first, &first)
            .unwrap()
            .is_some());
        assert!(
            pagination_link("<?cursor=old>; rel=\"prev\"", &first, &first)
                .unwrap()
                .is_none()
        );
        for href in [
            "https://evil.test/api/models/alice/model/tree/main",
            "https://user:pass@huggingface.co/api/models/alice/model/tree/main",
            "https://huggingface.co/api/models/alice/other/tree/main",
            "https://huggingface.co/api/models/alice/model/tree/main",
            "https://huggingface.co:444/api/models/alice/model/tree/main",
            "?cursor=abc#fragment",
        ] {
            assert!(
                pagination_link(&format!("<{href}>; rel=\"next\""), &first, &first).is_err(),
                "{href}"
            );
        }
    }

    #[test]
    fn quantization_does_not_mistake_qwen_for_a_quantization() {
        assert_eq!(quantization("Qwen3-4B.gguf"), None);
        assert_eq!(
            quantization("Qwen3-4B-Q4_K_M.gguf").as_deref(),
            Some("Q4_K_M")
        );
        assert_eq!(
            quantization("IQ4_XS/model-00001-of-00002.gguf").as_deref(),
            Some("IQ4_XS")
        );
        assert_eq!(quantization("model-MXFP4.gguf").as_deref(), Some("MXFP4"));
    }

    #[test]
    fn file_urls_encode_revisions_and_nested_paths_without_changing_them() {
        let file = file_url("alice/model", "refs/pr/123", "Q4_K_M/model a.gguf").unwrap();
        assert_eq!(
            file.as_str(),
            "https://huggingface.co/alice/model/resolve/refs%2Fpr%2F123/Q4_K_M/model%20a.gguf"
        );
        let (_, rev, path) =
            source("https://huggingface.co/alice/model/blob/refs%2Fpr%2F123/Q4_K_M/model%20a.gguf")
                .unwrap();
        assert_eq!(rev, "refs/pr/123");
        assert_eq!(path.as_deref(), Some("Q4_K_M/model a.gguf"));
    }

    #[test]
    fn parses_sources_without_trusting_hosts() {
        assert_eq!(source("alice/model").unwrap().0, "alice/model");
        assert_eq!(
            source("https://huggingface.co/alice/model?local-app=llama.cpp")
                .unwrap()
                .0,
            "alice/model"
        );
        let (_, rev, file) =
            source("https://huggingface.co/alice/model/blob/dev/a%20b.gguf").unwrap();
        assert_eq!(rev, "dev");
        assert_eq!(file.as_deref(), Some("a b.gguf"));
        for s in [
            "https://evil.test/a/b",
            "http://huggingface.co/a/b",
            "https://user:pass@huggingface.co/a/b",
            "https://huggingface.co/a/b/resolve/main/../x",
            "../x",
            "alice/model/resolve/../file.gguf",
        ] {
            assert!(source(s).is_err(), "{s}");
        }
    }
    #[test]
    fn split_sets_are_complete() {
        let file = |path: &str| DownloadFile {
            path: path.into(),
            size_bytes: 10,
            sha256: None,
            local_sha256: None,
            role: "shard".into(),
            quantization: None,
        };
        assert!(!variants(&[file("x-Q4-00001-of-00002.gguf")])[0].complete);
        let set = vec![
            file("x-Q4-00002-of-00002.gguf"),
            file("x-Q4-00001-of-00002.gguf"),
        ];
        assert!(variants(&set)[0].complete);
        assert_eq!(variants(&set)[0].total_bytes, 20);
    }

    #[test]
    fn expands_all_shards_and_requires_explicit_projector_and_one_variant() {
        let file = |name: &str, role: &str| DownloadFile {
            path: name.into(),
            size_bytes: 10,
            sha256: None,
            local_sha256: None,
            role: role.into(),
            quantization: None,
        };
        let files = vec![
            file("model-Q4-00001-of-00002.gguf", "shard"),
            file("model-Q4-00002-of-00002.gguf", "shard"),
            file("model-Q8.gguf", "model"),
            file("mmproj.gguf", "mmproj"),
        ];
        let mut resolved = ResolvedDownload {
            source: "a/b".into(),
            repo_id: "a/b".into(),
            revision: "a".repeat(40),
            publisher: "a".into(),
            repository_url: "https://huggingface.co/a/b".into(),
            license_url: String::new(),
            variants: variants(&files),
            files,
            suggested_file: None,
        };
        let selection = |files: Vec<&str>| DownloadSelection {
            source: resolved.source.clone(),
            revision: resolved.revision.clone(),
            files: files.into_iter().map(str::to_string).collect(),
        };
        let selected = select(&resolved, &selection(vec!["model-Q4-00002-of-00002.gguf"])).unwrap();
        assert_eq!(selected.len(), 2);
        assert!(selected.iter().all(|f| f.role == "shard"));
        assert_eq!(
            select(
                &resolved,
                &selection(vec!["model-Q4-00002-of-00002.gguf", "mmproj.gguf"])
            )
            .unwrap()
            .len(),
            3
        );
        for paths in [
            vec!["mmproj.gguf"],
            vec!["model-Q8.gguf", "model-Q4-00001-of-00002.gguf"],
            vec!["not-present.gguf"],
        ] {
            assert!(select(&resolved, &selection(paths)).is_err());
        }
        let incomplete = selection(vec!["model-Q4-00001-of-00002.gguf"]);
        resolved.files.remove(1);
        resolved.variants = variants(&resolved.files);
        assert!(select(&resolved, &incomplete)
            .unwrap_err()
            .contains("Incomplete"));
    }
}
