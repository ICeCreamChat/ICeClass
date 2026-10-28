"""Prepare the small, local conversation speaker model; never downloads user audio."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "Receiver/Assets/Voice/Speaker"
NAME = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
SOURCE = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/{NAME}"
SHA256 = "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    TARGET.mkdir(parents=True, exist_ok=True)
    model = TARGET / "speaker.onnx"
    if not model.is_file() or digest(model) != SHA256:
        temporary = model.with_suffix(".tmp")
        try:
            with urllib.request.urlopen(SOURCE, timeout=90) as response, temporary.open("wb") as stream:
                while chunk := response.read(1024 * 1024):
                    stream.write(chunk)
            if digest(temporary) != SHA256:
                raise ValueError("Speaker model checksum differs from the verified upstream asset")
            temporary.replace(model)
        finally:
            temporary.unlink(missing_ok=True)
    (TARGET / "manifest.json").write_text(json.dumps({
        "version": "campplus-zh-en-20261027", "source": SOURCE,
        "license": "Apache-2.0", "files": [
            {"name": model.name, "size": model.stat().st_size, "sha256": SHA256}
        ]
    }, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"modelMiB": round(model.stat().st_size / 1048576, 2), "verified": True}))


if __name__ == "__main__":
    main()
