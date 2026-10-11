// Prevents a console window on Windows; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    manorama_desktop_lib::run()
}
