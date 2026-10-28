"""Restore and verify bundled voice assets before building a clean checkout."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "Receiver/Assets/Voice"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_manifest(directory):
    manifest = json.loads((directory / "manifest.json").read_text("utf-8"))
    entries = manifest.get("parts") or manifest["files"]
    for entry in entries:
        name = entry["name"]
        if Path(name).name != name or "\\" in name:
            raise ValueError(f"Unsafe voice asset name: {name}")
        path = directory / name
        if not path.is_file() or digest(path) != entry["sha256"]:
            raise ValueError(f"Missing or corrupt voice asset: {path}")
        if "size" in entry and path.stat().st_size != entry["size"]:
            raise ValueError(f"Voice asset size mismatch: {path}")
    return manifest


def prepare_wake_assets():
    manifest = json.loads((ASSETS / "manifest.json").read_text("utf-8"))
    missing = {entry["name"]: entry for entry in manifest["files"]
               if not (ASSETS / entry["name"]).is_file()
               or digest(ASSETS / entry["name"]) != entry["sha256"]}
    if not missing:
        return
    with tempfile.TemporaryDirectory(prefix="iceclass-wake-assets-") as temporary:
        archive = Path(temporary) / "wake.tar.bz2"
        with urllib.request.urlopen(manifest["source"], timeout=90) as response, archive.open("wb") as target:
            shutil.copyfileobj(response, target, length=1024 * 1024)
        with tarfile.open(archive) as package:
            for member in package:
                name = Path(member.name).name
                if name not in missing or not member.isfile():
                    continue
                path = Path(temporary) / name
                with package.extractfile(member) as source, path.open("wb") as target:
                    shutil.copyfileobj(source, target)
                if digest(path) != missing[name]["sha256"]:
                    raise ValueError(f"Wake asset checksum mismatch: {name}")
                shutil.copyfile(path, ASSETS / name)
    verify_manifest(ASSETS)


def main():
    prepare_wake_assets()
    for script in ("prepare-banban-asr.py", "prepare-banban-neural-voice.py", "prepare-banban-speaker.py"):
        subprocess.run([sys.executable, str(ROOT / "scripts" / script)], check=True)
    for name in ("", "Asr", "Tts", "Vad", "Speaker"):
        verify_manifest(ASSETS / name)
    print("PASS bundled wake, SenseVoice, MeloTTS, VAD and speaker assets verified")


if __name__ == "__main__":
    main()
