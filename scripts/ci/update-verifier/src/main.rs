use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: sourceweft-update-verifier PACKAGE SIGNATURE".into());
    }
    let path = &args[1];
    if std::fs::metadata(path)?.len() > 512 * 1024 * 1024 {
        return Err("update exceeds 512 MiB".into());
    }
    let key =
        String::from_utf8(STANDARD.decode(std::env::var("TAURI_UPDATER_PUBLIC_KEY")?.trim())?)?;
    let signature = String::from_utf8(STANDARD.decode(std::fs::read_to_string(&args[2])?.trim())?)?;
    PublicKey::decode(&key)?.verify(
        &std::fs::read(path)?,
        &Signature::decode(&signature)?,
        true,
    )?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
