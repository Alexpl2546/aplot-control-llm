//! Shared validation for local HTTP server addresses.

/// Parses a base HTTP endpoint used to reach a local inference server.
///
/// Server APIs are rooted at `/`; credentials, query strings, and fragments
/// belong in their dedicated fields rather than in the address.
pub fn server_endpoint(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| "Enter a valid HTTP server address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use an HTTP server address without a path, credentials or query.".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_root_http_endpoints_and_rejects_embedded_credentials_or_paths() {
        assert_eq!(
            server_endpoint(" http://localhost:8080 ").unwrap().as_str(),
            "http://localhost:8080/"
        );
        for invalid in [
            "file:///tmp/server",
            "http://user@localhost:8080",
            "http://localhost:8080/path",
            "http://localhost:8080/?key=secret",
            "http://localhost:8080/#fragment",
        ] {
            assert!(server_endpoint(invalid).is_err(), "{invalid}");
        }
    }
}
