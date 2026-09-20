import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("android_artifacts", Path(__file__).with_name("android-artifacts.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AndroidArtifactsTest(unittest.TestCase):
    def test_badging_requires_separate_identity_and_correct_version(self):
        text = "package: name='nicelab.sourceweft.mobile.verification' versionCode='1000' versionName='0.1.0-verification'\nminSdkVersion:'24'\ntargetSdkVersion:'36'\nnative-code: 'arm64-v8a'\n"
        self.assertEqual(module.badging(text, "verification", "0.1.0", 1000), "nicelab.sourceweft.mobile.verification")
        for invalid in [text.replace(".verification", ""), text.replace("1000", "1"), text + "application-debuggable\n", text.replace("arm64-v8a", "x86_64")]:
            with self.assertRaises(ValueError):
                module.badging(invalid, "verification", "0.1.0", 1000)

    def library(self, alignment=16384, machine=183):
        data = bytearray(120)
        data[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", data, 18, machine)
        struct.pack_into("<Q", data, 32, 64)
        struct.pack_into("<HH", data, 54, 56, 1)
        struct.pack_into("<I", data, 64, 1)
        struct.pack_into("<Q", data, 112, alignment)
        return data

    def test_native_library_architecture_and_16k_alignment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.apk"
            for alignment, machine, valid in [(16384, 183, True), (4096, 183, False), (16384, 62, False)]:
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr("lib/arm64-v8a/libsourceweft_mobile_lib.so", self.library(alignment, machine))
                if valid:
                    module.native_libraries(path)
                else:
                    with self.assertRaises(ValueError):
                        module.native_libraries(path)

    def test_missing_native_library_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.aab"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("base/manifest/AndroidManifest.xml", "test")
            with self.assertRaises(ValueError):
                module.native_libraries(path)


if __name__ == "__main__":
    unittest.main()
