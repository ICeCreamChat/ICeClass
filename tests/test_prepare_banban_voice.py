"""A missing or corrupt bundled model must stop a release build."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_voice", Path(__file__).resolve().parents[1] / "scripts/prepare-banban-voice.py")
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)


class VoiceAssetManifestTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.content = b"verified model fixture"
        (self.root / "model.onnx").write_bytes(self.content)
        self.entry = {"name": "model.onnx", "size": len(self.content),
                      "sha256": hashlib.sha256(self.content).hexdigest()}

    def manifest(self, value):
        (self.root / "manifest.json").write_text(json.dumps(value), encoding="utf-8")

    def test_verified_model_is_accepted(self):
        self.manifest({"files": [self.entry]})
        voice.verify_manifest(self.root)

    def test_missing_model_stops_build(self):
        self.manifest({"files": [self.entry]})
        (self.root / "model.onnx").unlink()
        with self.assertRaisesRegex(ValueError, "Missing or corrupt"):
            voice.verify_manifest(self.root)

    def test_corrupt_model_stops_build(self):
        self.manifest({"files": [self.entry]})
        (self.root / "model.onnx").write_bytes(b"wrong")
        with self.assertRaisesRegex(ValueError, "Missing or corrupt"):
            voice.verify_manifest(self.root)

    def test_size_mismatch_stops_build(self):
        self.manifest({"files": [{**self.entry, "size": 0}]})
        with self.assertRaisesRegex(ValueError, "size mismatch"):
            voice.verify_manifest(self.root)

    def test_voice_packs_are_verified_without_unpacked_model(self):
        self.manifest({"parts": [self.entry], "files": [{"name": "unpacked.onnx"}]})
        voice.verify_manifest(self.root)

    def test_manifest_cannot_reference_external_files(self):
        for name in ("../model.onnx", "..\\model.onnx", "/model.onnx"):
            with self.subTest(name=name):
                self.manifest({"files": [{**self.entry, "name": name}]})
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    voice.verify_manifest(self.root)


if __name__ == "__main__":
    unittest.main()
