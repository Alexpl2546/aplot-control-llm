use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::Command,
};

pub struct CodexFixture {
    pub executable: PathBuf,
    pub root: PathBuf,
}

impl CodexFixture {
    pub fn build() -> io::Result<Self> {
        let root = env::temp_dir().join(format!("aplot-codex-fixture-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root)?;
        let mut executable = root.join("codex-fixture");
        if cfg!(windows) {
            executable.set_extension("exe");
        }
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("codex_app_server.rs");
        let rustc = env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        let output = Command::new(rustc)
            .arg("--edition=2021")
            .arg(source)
            .arg("-o")
            .arg(&executable)
            .output()?;
        if !output.status.success() {
            let _ = fs::remove_dir_all(&root);
            return Err(io::Error::other(format!(
                "fixture rustc failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        Ok(Self { executable, root })
    }

    pub fn prepare_home(&self, home: &Path, mode: &str) -> io::Result<()> {
        fs::create_dir_all(home)?;
        fs::write(home.join("fixture-mode"), mode)
    }
}

impl Drop for CodexFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
