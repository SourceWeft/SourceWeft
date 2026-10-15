"""Hermetic shell failure regressions; never mounts or writes outside a temp directory."""

import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class Reliability(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.env = dict(os.environ, PATH=str(self.bin) + ":" + os.environ["PATH"])

    def mock(self, name, body):
        p = self.bin / name
        p.write_text("#!/bin/sh\n" + body + "\n")
        p.chmod(0o755)

    def boot(self, mode):
        b = self.base / "state"
        b.mkdir()
        run = self.base / "run"
        run.mkdir()
        share = self.base / "share"
        share.mkdir()
        fuse = self.base / "fuse"
        fuse.touch()
        native = self.base / "swlazy"
        native.touch()
        native.chmod(0o755)
        workspace = self.base / "workspace"
        workspace.mkdir()
        conf = self.base / "fuse.conf"
        conf.write_text("user_allow_other\n")
        if mode != "missing-plan":
            (b / "plan.json").write_text("{}")
        if mode == "gzip-fail":
            (b / "plan.json").unlink()
            (share / "plan.json.gz").write_bytes(b"bad")
        for x in ["chmod", "chown", "useradd", "sleep", "setpriv"]:
            self.mock(x, "exit 0")
        self.mock("seq", "echo 1")
        self.mock(
            "id", r'case "$*" in -u) echo 0;; -u\ *|-g\ *) echo 1000;; *) exit 0;; esac'
        )
        self.mock("stat", 'case "$*" in *-f*) echo ext4;; *) echo 666;; esac')
        self.mock(
            "mountpoint",
            f'case "$*" in *lower*) {"exit 1" if mode == "no-fuse-mount" else "exit 0"};; *) [ -f "{self.base}/mounted" ];; esac',
        )
        self.mock(
            "mount",
            f"{'exit 9' if mode == 'overlay-fail' else 'touch ' + str(self.base / 'mounted')};",
        )
        text = (ROOT / "image/swvol-init").read_text()
        for old, new in [
            ("/var/lib/swvol", str(b)),
            ("/run/swvol", str(run)),
            ("/usr/local/share/swvol", str(share)),
            ("/workspace", str(workspace)),
            ("/dev/fuse", str(fuse)),
            ("/etc/fuse.conf", str(conf)),
        ]:
            text = text.replace(old, new)
        text = text.replace("/usr/local/sbin/swlazy", str(native)).replace(
            "[ -c " + str(fuse) + " ]", "[ -f " + str(fuse) + " ]"
        )
        if mode == "nonroot":
            self.mock("id", "echo 1000")
        p = self.base / "boot"
        p.write_text(text)
        r = subprocess.run(["sh", str(p)], env=self.env, capture_output=True, text=True)
        return r, b

    def test_missing_plan_fails(self):
        self.assertNotEqual(self.boot("missing-plan")[0].returncode, 0)

    def test_corrupt_compressed_plan_fails_atomically(self):
        r, b = self.boot("gzip-fail")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((b / "plan.json").exists())

    def test_missing_fuse_mount_fails(self):
        self.assertNotEqual(self.boot("no-fuse-mount")[0].returncode, 0)

    def test_overlay_failure_cannot_fallback(self):
        r, _ = self.boot("overlay-fail")
        self.assertNotEqual(r.returncode, 0)

    def test_success_requires_both_mounts(self):
        self.assertEqual(self.boot("success")[0].returncode, 0)

    def test_nonroot_rejected(self):
        self.assertNotEqual(self.boot("nonroot")[0].returncode, 0)

    def failed_build(self, rust_version, arch="x86_64"):
        helper = self.base / "helper"
        shutil.copytree(
            ROOT / "helper", helper, ignore=shutil.ignore_patterns("target", "dist")
        )
        (helper / "dist").mkdir()
        (helper / f"dist/swvol-{arch}").write_text("stale")
        target = self.base / "target"
        (target / "x86_64-unknown-linux-musl/release").mkdir(parents=True)
        (target / "x86_64-unknown-linux-musl/release/swvol").write_text("stale")
        (target / "x86_64-unknown-linux-musl/release/swvol").chmod(0o755)
        self.mock("sha256sum", 'exec shasum -a 256 "$@"')
        self.mock("cargo", f'printf "%s\\n" "$*" > "{self.base}/cargo-args"; exit 17')
        self.mock("rustc", f'echo "rustc {rust_version} (test)"')
        self.mock(
            "docker",
            f'''while [ "$#" -gt 0 ]; do case "$1" in -v) case "$2" in *:/dist) dist="${{2%:/dist}}";; *) ;; esac;shift 2;; -e) export "$2";shift 2;; bash|sh) break;; *) shift;; esac;done
shell="$1";shift; [ "$1" = -c ] && shift
command=$(printf '%s' "$1" | sed 's|/target|{target}|g;s|/dist|{helper}/dist|g;s|/home/rust/src|{helper}/swvol|g')
export CARGO_TARGET_DIR="{target}"
cd "{helper}/swvol"
"$shell" -c "$command"''',
        )
        r = subprocess.run(
            ["bash", str(helper / "build.sh")],
            env=dict(self.env, SWVOL_ARCHES=arch),
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((helper / f"dist/swvol-{arch}").exists(), r.stdout + r.stderr)
        self.assertFalse((helper / "dist/VERSION").exists())
        return r

    def test_failed_build_never_copies_old_binary(self):
        r = self.failed_build("1.96.1")
        self.assertEqual(r.returncode, 17)
        self.assertIn("--locked", (self.base / "cargo-args").read_text())

    def test_toolchain_mismatch_stops_before_compilation(self):
        r = self.failed_build("1.95.0")
        self.assertEqual(r.returncode, 1)
        self.assertIn("expected 1.96.1, actual 1.95.0", r.stderr)
        self.assertFalse((self.base / "cargo-args").exists())

    def test_original_arm_toolchain_passes_strict_gate(self):
        r = self.failed_build("1.95.0", "aarch64")
        self.assertEqual(r.returncode, 17)
        self.assertIn("--locked", (self.base / "cargo-args").read_text())
        self.assertIn(
            "aarch64-unknown-linux-musl", (self.base / "cargo-args").read_text()
        )

    def test_arm_genuine_toolchain_mismatch_stops_before_compilation(self):
        r = self.failed_build("1.96.1", "aarch64")
        self.assertEqual(r.returncode, 1)
        self.assertIn("expected 1.95.0, actual 1.96.1", r.stderr)
        self.assertFalse((self.base / "cargo-args").exists())

    def test_installer_rejects_receipt_mismatch_before_image_mutation(self):
        import hashlib
        import json

        stage = self.base / "image"
        stage.mkdir()
        for crate in ["swvol", "swlazy", "swvol-supervisor"]:
            content = b"tampered"
            (stage / (crate + "-x86_64")).write_bytes(content)
            (stage / (crate + "-x86_64.receipt.json")).write_text(
                json.dumps(
                    {
                        "architecture": "x86_64",
                        "crate": crate,
                        "target": "x86_64-unknown-linux-musl",
                        "binarySha256": hashlib.sha256(b"original").hexdigest(),
                    },
                    separators=(",", ":"),
                )
            )
            (stage / (crate + "-x86_64.sha256")).write_text(
                hashlib.sha256(content).hexdigest() + "  " + crate + "-x86_64\n"
            )
        (stage / "VERSION").write_text("test")
        self.mock("id", "echo 0")
        self.mock("uname", "echo x86_64")
        self.mock("sha256sum", 'exec shasum -a 256 "$@"')
        self.mock("apt-get", f'touch "{self.base}/mutated"')
        self.mock("install", "exit 0")
        self.mock("chmod", "exit 0")
        self.mock("chown", "exit 0")
        text = (ROOT / "image/install-swvol.sh").read_text()
        for old in [
            "/var/lib/swvol",
            "/usr/local/share/swvol",
            "/usr/local/sbin",
            "/etc/fuse.conf",
            "/var/lib/apt/lists",
        ]:
            text = text.replace(old, str(self.base / old.lstrip("/")))
        script = stage / "install-swvol.sh"
        script.write_text(text)
        r = subprocess.run(
            ["sh", str(script)], env=self.env, capture_output=True, text=True
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.base / "mutated").exists())


if __name__ == "__main__":
    unittest.main()
