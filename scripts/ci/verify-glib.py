"""Verify the reviewed glib source and the applications' target dependency graphs."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "third_party/rust/glib-0.18.5"
SOURCE = ROOT / "third_party/rust/glib-0.18.5-source.json"
ARCHIVE_SHA = "233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5"
PATCHED_SHA = "a0f5ee8acb8faa089bcdfbc9a57372609fce7654026ccef7d9a224d05a654ccc"


def verify_sources():
    evidence = json.loads(SOURCE.read_text())
    assert evidence["archiveSha256"] == ARCHIVE_SHA
    assert evidence["patchedFiles"] == {"src/variant_iter.rs": PATCHED_SHA}
    assert len(evidence["originalFiles"]) == 121
    assert evidence["originalFiles"]["src/variant_iter.rs"] == "1fd02859333761c45321b32f28b24233446b97d0022a90d3a937ed162585b90e"
    for name, original in evidence["originalFiles"].items():
        expected = evidence["patchedFiles"].get(name, original)
        assert hashlib.sha256((VENDOR / name).read_bytes()).hexdigest() == expected, name
    for app in ("desktop", "mobile"):
        manifest = ROOT / "apps" / app / "src-tauri/Cargo.toml"
        config = tomllib.loads(manifest.read_text())
        configured = config["patch"]["crates-io"]["glib"]["path"]
        assert (manifest.parent / configured).resolve() == VENDOR
        lock = tomllib.loads(manifest.with_name("Cargo.lock").read_text())
        entries = [p for p in lock["package"] if p["name"] == "glib"]
        assert len(entries) == 1 and entries[0]["version"] == "0.18.5"
        assert "source" not in entries[0] and "checksum" not in entries[0], app
    return {"sourceFilesChecked": len(evidence["originalFiles"]), "archiveSha256": ARCHIVE_SHA,
            "patchedVariantSha256": PATCHED_SHA, "applicationLocksUseLocalBackport": True}


def verify_target(app, target, expected_runtime):
    manifest = ROOT / "apps" / app / "src-tauri/Cargo.toml"
    result = subprocess.run(["cargo", "metadata", "--locked", "--format-version", "1",
                             "--manifest-path", str(manifest), "--filter-platform", target],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"cargo metadata failed for {app}/{target}:\n{result.stderr}")
    data = json.loads(result.stdout)
    packages = {p["id"]: p for p in data["packages"]}
    glib_ids = {p["id"] for p in data["packages"] if p["name"] == "glib"}
    for identity in glib_ids:
        package = packages[identity]
        assert package["version"] == "0.18.5" and package["source"] is None
        assert Path(package["manifest_path"]).resolve() == VENDOR / "Cargo.toml"
    nodes = {node["id"]: node for node in data["resolve"]["nodes"]}
    pending = [data["resolve"]["root"]]
    reachable = set()
    while pending:
        current = pending.pop()
        if current in reachable:
            continue
        reachable.add(current)
        for dependency in nodes[current]["deps"]:
            # Host build scripts and test-only dependencies do not establish
            # that glib is linked into the target application's runtime.
            if any(kind["kind"] is None for kind in dependency["dep_kinds"]):
                pending.append(dependency["pkg"])
    actual_runtime = bool(reachable & glib_ids)
    assert actual_runtime == expected_runtime, (app, target, actual_runtime)
    return {"application": app, "target": target, "glibInRuntimeGraph": actual_runtime,
            "allResolvedGlibSourcesPatched": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--metadata", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args()
    report = verify_sources()
    if args.metadata:
        report["targets"] = [verify_target(*entry) for entry in (
            ("desktop", "x86_64-unknown-linux-gnu", True),
            ("mobile", "x86_64-unknown-linux-gnu", True),
            ("mobile", "aarch64-linux-android", False),
            ("mobile", "aarch64-apple-ios", False),
            ("desktop", "aarch64-apple-darwin", False),
        )]
    report["passed"] = True
    content = json.dumps(report, indent=2) + "\n"
    if args.output:
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content)
    print(content, end="")


if __name__ == "__main__":
    main()
