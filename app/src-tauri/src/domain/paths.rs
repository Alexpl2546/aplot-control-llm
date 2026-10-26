use std::path::Path;

/// Staging files are never part of the model library, including when a caller
/// accidentally supplies a path nested below the staging directory directly.
pub fn is_aplot_staging_path(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".aplot-staging")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_exclusion_is_case_insensitive_and_component_scoped() {
        assert!(is_aplot_staging_path(Path::new(
            "C:/models/.aplot-staging/id/model.gguf"
        )));
        assert!(is_aplot_staging_path(Path::new(
            "C:/models/.APLOT-STAGING/id/model.gguf"
        )));
        assert!(!is_aplot_staging_path(Path::new(
            "C:/models/aplot-staging/model.gguf"
        )));
    }
}
