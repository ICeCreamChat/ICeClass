"""Build content-addressed update plans; optional deltas use Windows MSDelta only."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import xml.etree.ElementTree as ET


class _DeltaInput(ctypes.Structure):
    _fields_ = [("start", ctypes.c_void_p), ("size", ctypes.c_size_t), ("editable", ctypes.c_int32)]


class MsDelta:
    """The ABI follows Microsoft's WinSDK msdelta.h, including signed __int64 flags."""

    def __init__(self):
        if os.name != "nt":
            raise OSError("Creating update deltas requires Windows msdelta.dll")
        # LOAD_LIBRARY_SEARCH_SYSTEM32: never load a DLL from the checkout or cwd.
        self.library = ctypes.WinDLL("msdelta.dll", use_last_error=True, winmode=0x800)
        self.library.CreateDeltaW.argtypes = [ctypes.c_int64, ctypes.c_int64, ctypes.c_int64,
                                            ctypes.c_wchar_p, ctypes.c_wchar_p,
                                            ctypes.c_wchar_p, ctypes.c_wchar_p, _DeltaInput,
                                            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_wchar_p]
        self.library.CreateDeltaW.restype = ctypes.c_int32
        self.library.ApplyDeltaW.argtypes = [ctypes.c_int64, ctypes.c_wchar_p,
                                           ctypes.c_wchar_p, ctypes.c_wchar_p]
        self.library.ApplyDeltaW.restype = ctypes.c_int32

    def create(self, source: Path, target: Path, delta: Path):
        # DELTA_FILE_TYPE_RAW=1; no PE transforms, options, timestamp or hash algorithm.
        if not self.library.CreateDeltaW(1, 0, 0, str(source), str(target), None, None,
                                        _DeltaInput(), None, 0, str(delta)):
            raise ctypes.WinError(ctypes.get_last_error())

    def apply(self, source: Path, delta: Path, target: Path):
        if not self.library.ApplyDeltaW(0, str(source), str(delta), str(target)):
            raise ctypes.WinError(ctypes.get_last_error())


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _safe_relative_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError(f"Unsafe update path: {value!r}")
    for part in value.split("/"):
        if (not part or part in (".", "..") or part.endswith((".", " "))
                or any(ord(char) < 32 or char in '<>:"|?*' for char in part)
                or re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part)):
            raise ValueError(f"Unsafe update path: {value!r}")
    return value


def _safe_child(root: Path, relative: str) -> Path:
    _safe_relative_path(relative)
    path = root
    for part in relative.split("/"):
        path = path / part
        if path.exists() or path.is_symlink():
            # Includes junctions on Windows, not just Python symlinks.
            if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400:
                raise ValueError(f"Unsafe linked update path: {relative!r}")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Unsafe update path: {relative!r}")
    return path


def _file_info(path: Path) -> dict:
    if not path.is_file():
        raise ValueError(f"Missing update file: {path}")
    return {"size": path.stat().st_size, "sha256": sha256_file(path)}


def _validate_info(value: dict):
    if (not isinstance(value, dict) or type(value.get("size")) is not int or value["size"] < 0
            or not isinstance(value.get("sha256"), str)
            or re.fullmatch(r"[0-9a-f]{64}", value["sha256"]) is None):
        raise ValueError("Invalid update size or SHA256")


def _voice_files(root: Path) -> dict[str, tuple[Path, dict]]:
    files = {}
    seen = set()

    def visit(directory):
        if not directory.is_dir():
            raise ValueError(f"Missing voice directory: {directory}")
        for path in sorted(directory.iterdir()):
            relative = path.relative_to(root).as_posix()
            _safe_child(root, relative)
            key = relative.casefold()
            if key in seen:
                raise ValueError(f"Duplicate voice path: {relative}")
            seen.add(key)
            if path.is_dir():
                visit(path)
            else:
                files[relative] = (path, _file_info(path))

    visit(root)
    for directory in ("", "Asr", "Tts", "Vad", "Speaker"):
        manifest_name = f"{directory}/manifest.json" if directory else "manifest.json"
        if manifest_name not in files:
            raise ValueError(f"Missing voice manifest: {manifest_name}")
    for relative, (manifest_path, _) in files.items():
        if manifest_path.name != "manifest.json":
            continue
        manifest = json.loads(manifest_path.read_text("utf-8-sig"))
        entries = manifest.get("parts") or manifest.get("files")
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"Invalid voice manifest: {relative}")
        seen_names = set()
        for entry in entries:
            name = entry.get("name") if isinstance(entry, dict) else None
            _safe_relative_path(name)
            if "/" in name:
                raise ValueError(f"Unsafe voice manifest name: {name!r}")
            if name.casefold() in seen_names:
                raise ValueError(f"Duplicate voice manifest entry: {name}")
            seen_names.add(name.casefold())
            asset_name = (Path(relative).parent / name).as_posix()
            if asset_name not in files:
                raise ValueError(f"Missing voice asset: {asset_name}")
            info = files[asset_name][1]
            if info["sha256"] != entry.get("sha256"):
                raise ValueError(f"Voice asset checksum mismatch: {asset_name}")
            if "size" in entry and (type(entry["size"]) is not int or info["size"] != entry["size"]):
                raise ValueError(f"Voice asset size mismatch: {asset_name}")
    return files


def _previous_files(directory: Path | None) -> dict[str, dict]:
    if directory is None:
        return {}
    plan_path = _safe_child(directory, "update-plan.json")
    if not plan_path.is_file() or not _safe_child(directory, "payloads").is_dir():
        raise ValueError(f"Missing previous update-plan.json or payloads: {directory}")
    plan = json.loads(plan_path.read_text("utf-8-sig"))
    if not isinstance(plan, dict) or not isinstance(plan.get("version"), str) or not plan["version"]:
        raise ValueError("Invalid previous update plan version")
    entries = plan.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Invalid previous update plan files")
    files = {}
    for entry in entries:
        _validate_info(entry)
        key = _safe_relative_path(entry.get("path")).casefold()
        if key in files:
            raise ValueError(f"Duplicate previous update path: {entry['path']}")
        deltas = entry.get("deltas")
        if not isinstance(deltas, list):
            raise ValueError("Invalid previous update deltas")
        for delta in deltas:
            _validate_info(delta)
            if not isinstance(delta.get("sourceSha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", delta["sourceSha256"]):
                raise ValueError("Invalid previous delta source SHA256")
        files[key] = entry
    return files


def _store_payload(source: Path, directory: Path, info: dict):
    destination = _safe_child(directory, info["sha256"])
    if not destination.exists():
        shutil.copyfile(source, destination)
    if _file_info(destination) != info:
        raise ValueError(f"Payload checksum or size mismatch: {source.name}")


def prepare_release(project_file: Path, executable: Path, release_directory: Path, *,
                    voice_directory: Path | None = None,
                    previous_release_directory: Path | None = None) -> dict:
    """Always publish full file payloads; advertise only smaller, verified RAW patches."""
    versions = {element.text.strip() for element in ET.parse(project_file).getroot().iter()
                if element.tag.rsplit("}", 1)[-1] == "Version" and element.text and element.text.strip()}
    if len(versions) != 1:
        raise ValueError(f"Missing or ambiguous project Version: {project_file}")
    expected_executable = "ICeClass.exe" if voice_directory is not None else "ICeClass.Desktop.exe"
    if executable.name != expected_executable:
        raise ValueError(f"Invalid update executable: {executable.name}")
    sources = {expected_executable: (executable.resolve(), _file_info(executable))}
    if voice_directory is not None:
        for relative, value in _voice_files(voice_directory.resolve()).items():
            sources["VoiceResources/" + relative] = value
    previous = _previous_files(previous_release_directory)
    if previous_release_directory is not None and release_directory.resolve() == previous_release_directory.resolve():
        raise ValueError("Previous and new release directories must differ")
    release_directory.mkdir(parents=True, exist_ok=True)
    payload_directory = _safe_child(release_directory, "payloads")
    payload_directory.mkdir(exist_ok=True)
    plan = {"version": versions.pop(), "files": []}
    engine = None
    with tempfile.TemporaryDirectory(prefix=".update-payloads-", dir=release_directory) as temporary:
        work = Path(temporary)
        for relative, (source, info) in sources.items():
            _store_payload(source, payload_directory, info)
            entry = {"path": relative, **info, "deltas": []}
            old = previous.get(relative.casefold())
            if old is not None and old["sha256"] != info["sha256"]:
                old_source = _safe_child(previous_release_directory, "payloads/" + old["sha256"])
                if _file_info(old_source) != {"size": old["size"], "sha256": old["sha256"]}:
                    raise ValueError(f"Previous payload checksum or size mismatch: {relative}")
                if engine is None:
                    engine = MsDelta()
                delta, rebuilt = work / "patch", work / "rebuilt"
                engine.create(old_source.resolve(), source, delta)
                # Rebuild even a large patch: no generated patch escapes verification.
                engine.apply(old_source.resolve(), delta, rebuilt)
                if _file_info(rebuilt) != info:
                    raise ValueError(f"Delta reconstruction checksum mismatch: {relative}")
                delta_info = _file_info(delta)
                if delta_info["size"] < info["size"]:
                    _store_payload(delta, payload_directory, delta_info)
                    entry["deltas"].append({"sourceSha256": old["sha256"], **delta_info})
                delta.unlink()
                rebuilt.unlink()
            plan["files"].append(entry)
        temporary_plan = work / "update-plan.json"
        temporary_plan.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary_plan.replace(_safe_child(release_directory, "update-plan.json"))
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--release-directory", type=Path, required=True)
    parser.add_argument("--voice-directory", type=Path)
    parser.add_argument("--previous-release-directory", type=Path)
    args = parser.parse_args()
    plan = prepare_release(args.project, args.executable, args.release_directory,
                           voice_directory=args.voice_directory,
                           previous_release_directory=args.previous_release_directory)
    delta_count = sum(len(entry["deltas"]) for entry in plan["files"])
    print(f"Update {plan['version']}: {len(plan['files'])} files, {delta_count} verified MSDelta patches; {args.release_directory}")


if __name__ == "__main__":
    main()
