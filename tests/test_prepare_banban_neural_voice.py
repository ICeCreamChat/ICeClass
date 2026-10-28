"""A first-time neural voice build must finish with usable packs and notices."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location(
    "prepare_neural_voice",
    Path(__file__).resolve().parents[1] / "scripts/prepare-banban-neural-voice.py",
)
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)


class NeuralVoicePreparationTest(unittest.TestCase):
    def test_first_build_finishes_with_extractable_packs_and_license(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "upstream"
            source.mkdir()
            names = ("model.onnx", "tokens.txt", "lexicon.txt", "date.fst",
                     "number.fst", "phone.fst", "new_heteronym.fst", "LICENSE")
            for name in names:
                (source / name).write_bytes(name.encode("utf-8"))
            notices = root / "docs/licenses"
            notices.mkdir(parents=True)
            (notices / "SileroVAD-LICENSE.txt").write_text("MIT", encoding="utf-8")
            vad = root / "Receiver/Assets/Voice/Vad"
            vad.mkdir(parents=True)
            (vad / "silero_vad_v5.onnx").write_bytes(b"fixture vad")
            target = root / "Receiver/Assets/Voice/Tts"
            model_sha = hashlib.sha256(b"model.onnx").hexdigest()

            with patch.object(voice, "ROOT", root), patch.object(voice, "TARGET", target), \
                    patch.object(voice, "MODEL_SHA256", model_sha):
                voice.prepare(source, root / "voice.zip")

            self.assertEqual((notices / "MeloTTS-LICENSE.txt").read_bytes(), b"LICENSE")
            manifest = json.loads((target / "manifest.json").read_text("utf-8"))
            packed = b"".join((target / part["name"]).read_bytes() for part in manifest["parts"])
            self.assertEqual(hashlib.sha256(packed).hexdigest(), manifest["archiveSha256"])
            for part in manifest["parts"]:
                data = (target / part["name"]).read_bytes()
                self.assertEqual(len(data), part["size"])
                self.assertEqual(hashlib.sha256(data).hexdigest(), part["sha256"])
            with zipfile.ZipFile(root / "voice.zip") as archive:
                self.assertEqual(set(archive.namelist()), set(names))
                self.assertEqual(archive.read("model.onnx"), b"model.onnx")
                self.assertEqual(archive.read("LICENSE"), b"LICENSE")


if __name__ == "__main__":
    unittest.main()
