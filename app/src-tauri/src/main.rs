#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if let Some(code) = llama_control_lib::component_maintenance_cli() {
        std::process::exit(code);
    }
    if let Some(code) = llama_control_lib::component_inventory_cli() {
        std::process::exit(code);
    }
    llama_control_lib::run();
}
