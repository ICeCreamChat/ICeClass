import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "prepare_speaker", Path(__file__).resolve().parents[1] / "scripts/prepare-banban-speaker.py"
)
speaker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(speaker)


class TaggedSpeakerTests(unittest.TestCase):
    def test_restore_pinned_bytes_preserves_tagged_manifest_and_cache(self):
        payload = b"verified original"
        checksum = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = json.dumps({"source": "original URL", "files": [{"name": "speaker.onnx", "sha256": checksum}]})
            (root / "manifest.json").write_text(metadata, encoding="utf-8")
            with patch.object(speaker, "SHA256", checksum), patch.object(
                speaker.urllib.request, "urlopen", return_value=io.BytesIO(payload)
            ) as download:
                speaker.main(root)
                speaker.main(root)
                download.assert_called_once_with(speaker.SOURCE, timeout=90)
            self.assertEqual((root / "speaker.onnx").read_bytes(), payload)
            self.assertEqual((root / "manifest.json").read_text("utf-8"), metadata)

    def test_other_tagged_models_are_left_to_the_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text(json.dumps({
                "files": [{"name": "speaker.onnx", "sha256": "a" * 64}]
            }))
            with patch.object(speaker.urllib.request, "urlopen") as download:
                speaker.main(root)
                download.assert_not_called()
            self.assertFalse((root / "speaker.onnx").exists())
