const COMMANDS: &[&str] = &["sign_in"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
