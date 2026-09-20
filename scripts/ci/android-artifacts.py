"""Validate Android output and write a safe, reproducible artifact receipt."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = "nicelab.sourceweft.mobile"


def badging(text, mode, version, code):
    package = re.search(r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", text)
    if not package:
        raise ValueError("APK package metadata is missing")
    expected_id = PACKAGE + (".verification" if mode == "verification" else "")
    expected_name = version + ("-verification" if mode == "verification" else "")
    if package.groups() != (expected_id, str(code), expected_name):
        raise ValueError("APK package identity or version does not match the requested build")
    if "application-debuggable" in text:
        raise ValueError("Verification and release APKs must use the optimized, non-debuggable build")
    abi = re.search(r"native-code:\s*(.+)", text)
    if not abi or re.findall(r"'([^']+)'", abi.group(1)) != ["arm64-v8a"]:
        raise ValueError("Expected exactly the Android ARM64 ABI")
    if "minSdkVersion:'24'" not in text or "targetSdkVersion:'36'" not in text:
        raise ValueError("Unexpected Android SDK levels")
    return expected_id


def native_libraries(path):
    with zipfile.ZipFile(path) as archive:
        prefix = "base/lib/" if path.suffix == ".aab" else "lib/"
        libraries = [name for name in archive.namelist() if name.startswith(prefix) and name.endswith(".so")]
        if prefix + "arm64-v8a/libsourceweft_mobile_lib.so" not in libraries:
            raise ValueError("The SourceWeft native library is missing")
        for name in libraries:
            if name.split("/")[-2] != "arm64-v8a":
                raise ValueError("Unexpected native ABI")
            data = archive.read(name)
            if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", data, 18)[0] != 183:
                raise ValueError("Expected an AArch64 ELF library")
            offset = struct.unpack_from("<Q", data, 32)[0]
            stride, count = struct.unpack_from("<HH", data, 54)
            if stride < 56 or count == 0 or offset + stride * count > len(data):
                raise ValueError("Invalid ELF program headers")
            loads = 0
            for index in range(count):
                entry = offset + index * stride
                if struct.unpack_from("<I", data, entry)[0] == 1:
                    loads += 1
                    if struct.unpack_from("<Q", data, entry + 48)[0] < 16384:
                        raise ValueError("Native library does not support 16 KiB page alignment")
            if not loads:
                raise ValueError("Native library has no loadable segments")


def command(args):
    completed = subprocess.run([str(arg) for arg in args], capture_output=True, text=True)
    if completed.returncode:
        raise RuntimeError(f"{Path(str(args[0])).name} failed: {completed.stderr.strip()}")
    return completed.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["verification", "release"])
    args = parser.parse_args()
    config = json.loads((ROOT / "apps/mobile/src-tauri/tauri.conf.json").read_text())
    version, code = config["version"], config["bundle"]["android"]["versionCode"]
    tools = Path(os.environ["ANDROID_HOME"]) / "build-tools/36.0.0"
    executable = lambda name: tools / (name + (".bat" if name == "apksigner" and os.name == "nt" else ".exe" if os.name == "nt" else ""))
    outputs = ROOT / "apps/mobile/src-tauri/gen/android/app/build/outputs"
    apks = list(outputs.glob("apk/universal/release/*.apk"))
    if len(apks) != 1:
        raise ValueError("Expected exactly one universal ARM64 release APK; clean stale outputs first")
    apk = apks[0]
    identity = badging(command([executable("aapt2"), "dump", "badging", apk]), args.mode, version, code)
    signing = command([executable("apksigner"), "verify", "--verbose", "--print-certs", apk])
    fingerprint = re.search(r"Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]+)", signing)
    if not fingerprint or len(fingerprint.group(1)) != 64:
        raise ValueError("APK signer fingerprint is missing")
    if args.mode == "release" and "CN=Android Debug" in signing:
        raise ValueError("A release cannot use the Android debug certificate")
    command([executable("zipalign"), "-c", "-P", "16", "4", apk])
    files = [apk]
    if args.mode == "release":
        bundles = list(outputs.glob("bundle/universalRelease/*.aab"))
        if len(bundles) != 1:
            raise ValueError("Expected exactly one release AAB")
        jarsigner = Path(os.environ["JAVA_HOME"]) / "bin" / ("jarsigner.exe" if os.name == "nt" else "jarsigner")
        command([jarsigner, "-verify", "-strict", "-keystore", os.environ["ANDROID_KEYSTORE_PATH"], "-storepass:env", "ANDROID_STORE_PASSWORD", bundles[0], os.environ["ANDROID_KEY_ALIAS"]])
        files += bundles
    target = ROOT / "output/android" / args.mode
    target.mkdir(parents=True, exist_ok=True)
    artifacts = []
    for path in files:
        native_libraries(path)
        name = f"SourceWeft-Mobile_{version}_arm64_{args.mode}{path.suffix}"
        destination = target / name
        shutil.copy2(path, destination)
        artifacts.append({"filename": name, "size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    receipt = {"schemaVersion": 1, "platform": "android", "arch": "arm64", "applicationId": identity, "version": version, "versionCode": code,
               "mode": args.mode, "verificationOnly": args.mode == "verification", "certificateSha256": fingerprint.group(1).lower(),
               "commit": os.environ.get("GITHUB_SHA"), "artifacts": artifacts}
    (target / "android-manifest.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
