fn main() {
    tauri_build::build();
    // Tauri links its Windows resource only into bin targets. Unit-test
    // executables also import Common Controls v6 through Wry, and need the
    // generated activation manifest before the Rust test harness can start.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let resource =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("resource.lib");
        assert!(
            resource.is_file(),
            "Tauri's Windows resource was not generated"
        );
        println!("cargo:rustc-link-arg-tests={}", resource.display());
        // Cargo's link-arg-tests covers integration tests, but not the library
        // harness. Put the COFF resource object in a real archive and link it
        // only from cfg(test) in lib.rs, avoiding duplicate bin resources.
        let out = resource.parent().unwrap();
        let target = std::env::var("TARGET").unwrap();
        let librarian = cc::windows_registry::find_tool(&target, "lib.exe")
            .expect("MSVC librarian is required for Windows resources");
        let status = librarian
            .to_command()
            .arg("/NOLOGO")
            .arg(format!(
                "/OUT:{}",
                out.join("aplot_test_resource.lib").display()
            ))
            .arg(&resource)
            .status()
            .expect("Cannot archive test resources");
        assert!(status.success(), "Cannot archive Windows test resources");
        println!("cargo:rustc-link-search=native={}", out.display());
    }
}
