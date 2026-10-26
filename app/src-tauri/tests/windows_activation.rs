//! The native test binaries must activate Common Controls v6 before Wry loads.
#[cfg(windows)]
#[test]
fn common_controls_v6_is_available_in_the_test_activation_context() {
    use std::ffi::{c_char, c_void};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
    }
    let name: Vec<u16> = "comctl32.dll\0".encode_utf16().collect();
    unsafe {
        let module = LoadLibraryW(name.as_ptr());
        assert!(!module.is_null(), "Common Controls could not be loaded");
        let entry = GetProcAddress(module, c"TaskDialogIndirect".as_ptr());
        FreeLibrary(module);
        assert!(!entry.is_null(), "Common Controls v6 was not activated");
    }
}
