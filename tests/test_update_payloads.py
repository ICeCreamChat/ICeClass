"""Exercise release plans and real Windows MSDelta with small, offline fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/prepare-update-payloads.py"
spec = importlib.util.spec_from_file_location("update_payloads", SCRIPT)
payloads = importlib.util.module_from_spec(spec) if SCRIPT.exists() else None
if payloads is not None:
    spec.loader.exec_module(payloads)


def checksum(data):
    return hashlib.sha256(data).hexdigest()


class UpdatePayloadTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(payloads, "The file-level update payload generator is missing")
        self.temporary = tempfile.TemporaryDirectory(prefix="iceclass-payload-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.project = self.root / "Receiver.csproj"
        self.project.write_text("<Project><PropertyGroup><Version>9.8.7</Version></PropertyGroup></Project>", encoding="utf-8")
        self.executable = self.root / "core/ICeClass.exe"
        self.executable.parent.mkdir()
        self.executable.write_bytes(b"MZ core application\x00" * 4096)
        self.voice = self.root / "Voice"
        for directory, filename in (("", "wake.onnx"), ("Asr", "model.onnx"),
                                    ("Tts", "voice-01.pack"), ("Vad", "vad.onnx"),
                                    ("Speaker", "speaker.onnx")):
            folder = self.voice / directory
            folder.mkdir(parents=True, exist_ok=True)
            data = (directory + " offline fixture").encode() * 40
            (folder / filename).write_bytes(data)
            entry = {"name": filename, "size": len(data), "sha256": checksum(data)}
            manifest = {"files": [entry]}
            if directory == "Tts":
                manifest = {"parts": [entry], "files": [{"name": "unpacked-model.onnx"}]}
            (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.release = self.root / "release"

    def prepare(self, previous=None, destination=None):
        return payloads.prepare_release(self.project, self.executable, destination or self.release,
                                        voice_directory=self.voice,
                                        previous_release_directory=previous)

    def read_plan(self, directory=None):
        return json.loads(((directory or self.release) / "update-plan.json").read_text("utf-8"))

    def change_manifest(self, directory, edit):
        path = self.voice / directory / "manifest.json"
        value = json.loads(path.read_text("utf-8"))
        edit(value)
        path.write_text(json.dumps(value), encoding="utf-8")

    def test_receiver_plan_has_core_first_and_all_voice_files(self):
        (self.voice / "Tts/extra.zip").write_bytes(b"extra originally embedded archive")
        self.prepare()
        plan = self.read_plan()
        self.assertEqual(set(plan), {"version", "files"})
        self.assertEqual(plan["version"], "9.8.7")
        self.assertEqual(plan["files"][0], {"path": "ICeClass.exe", "size": self.executable.stat().st_size,
                                          "sha256": checksum(self.executable.read_bytes()), "deltas": []})
        expected = {"ICeClass.exe"} | {"VoiceResources/" + path.relative_to(self.voice).as_posix()
                                      for path in self.voice.rglob("*") if path.is_file()}
        self.assertEqual({entry["path"] for entry in plan["files"]}, expected)
        for entry in plan["files"]:
            data = (self.release / "payloads" / entry["sha256"]).read_bytes()
            self.assertEqual(len(data), entry["size"])
            self.assertEqual(checksum(data), entry["sha256"])
            self.assertEqual(entry["deltas"], [])

    def test_teacher_plan_contains_only_teacher_executable(self):
        desktop = self.root / "ICeClass.Desktop.exe"
        desktop.write_bytes(b"MZ teacher app")
        payloads.prepare_release(self.project, desktop, self.release)
        self.assertEqual(self.read_plan()["files"], [{"path": "ICeClass.Desktop.exe", "size": 14,
                                                     "sha256": checksum(b"MZ teacher app"), "deltas": []}])

    @unittest.skipUnless(os.name == "nt", "MSDelta is built into Windows")
    def test_real_msdelta_roundtrip_accepts_unicode_paths(self):
        source = self.root / "旧版本.bin"
        target = self.root / "新版本.bin"
        delta = self.root / "补丁.bin"
        rebuilt = self.root / "回建.bin"
        source.write_bytes(random.Random(12).randbytes(65536))
        target.write_bytes(source.read_bytes()[:30000] + b"changed content" + source.read_bytes()[30014:])
        engine = payloads.MsDelta()
        engine.create(source, target, delta)
        engine.apply(source, delta, rebuilt)
        self.assertEqual(rebuilt.read_bytes(), target.read_bytes())
        self.assertLess(delta.stat().st_size, target.stat().st_size)

    @unittest.skipUnless(os.name == "nt", "MSDelta is built into Windows")
    def test_changed_file_has_verified_smaller_content_addressed_patch(self):
        self.prepare()
        previous = self.release
        old_hash = checksum(self.executable.read_bytes())
        self.executable.write_bytes(self.executable.read_bytes() + b"new version")
        current = self.root / "next"
        self.prepare(previous, current)
        entry = self.read_plan(current)["files"][0]
        self.assertEqual(len(entry["deltas"]), 1)
        delta = entry["deltas"][0]
        self.assertEqual(set(delta), {"sourceSha256", "size", "sha256"})
        self.assertEqual(delta["sourceSha256"], old_hash)
        patch_file = current / "payloads" / delta["sha256"]
        self.assertEqual(checksum(patch_file.read_bytes()), delta["sha256"])
        self.assertEqual(patch_file.stat().st_size, delta["size"])
        self.assertLess(delta["size"], entry["size"])
        rebuilt = self.root / "rebuilt.exe"
        payloads.MsDelta().apply(previous / "payloads" / old_hash, patch_file, rebuilt)
        self.assertEqual(rebuilt.read_bytes(), self.executable.read_bytes())

    def test_unchanged_files_keep_hashes_without_invoking_delta(self):
        self.prepare()
        current = self.root / "next"
        with patch.object(payloads, "MsDelta", side_effect=AssertionError("Unchanged files must not generate patches")):
            self.prepare(self.release, current)
        self.assertEqual(self.read_plan(), self.read_plan(current))
        self.assertEqual({p.name for p in (self.release / "payloads").iterdir()},
                         {p.name for p in (current / "payloads").iterdir()})

    @unittest.skipUnless(os.name == "nt", "MSDelta is built into Windows")
    def test_changed_voice_pack_and_manifest_each_use_their_own_previous_payload(self):
        self.prepare()
        previous_plan = {entry["path"]: entry for entry in self.read_plan()["files"]}
        pack = self.voice / "Tts/voice-01.pack"
        pack.write_bytes(pack.read_bytes() + b"updated voice")
        self.change_manifest("Tts", lambda value: value["parts"][0].update(
            size=pack.stat().st_size, sha256=checksum(pack.read_bytes())))
        current = self.root / "next"
        self.prepare(self.release, current)
        for entry in self.read_plan(current)["files"]:
            if entry["path"] in ("VoiceResources/Tts/voice-01.pack", "VoiceResources/Tts/manifest.json"):
                self.assertEqual(len(entry["deltas"]), 1)
                self.assertEqual(entry["deltas"][0]["sourceSha256"], previous_plan[entry["path"]]["sha256"])
            else:
                self.assertEqual(entry, previous_plan[entry["path"]])

    @unittest.skipUnless(os.name == "nt", "Path junctions are a Windows feature")
    def test_linked_voice_directory_is_rejected_without_reading_external_files(self):
        outside = self.root / "private"
        outside.mkdir()
        (outside / "credentials.dpapi").write_bytes(b"private")
        result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(self.voice / "outside"), str(outside)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        with self.assertRaisesRegex(ValueError, "[Uu]nsafe|[Ll]ink"):
            self.prepare()
        self.assertFalse((self.release / "update-plan.json").exists())

    @unittest.skipUnless(os.name == "nt", "MSDelta is built into Windows")
    def test_patch_larger_than_full_is_omitted(self):
        self.executable.write_bytes(b"a")
        self.prepare()
        self.executable.write_bytes(b"b")
        current = self.root / "next"
        self.prepare(self.release, current)
        self.assertEqual(self.read_plan(current)["files"][0]["deltas"], [])
        self.assertEqual(len(list((current / "payloads").iterdir())), len(self.read_plan(current)["files"]))

    @unittest.skipUnless(os.name == "nt", "MSDelta is built into Windows")
    def test_failed_reconstruction_never_publishes_a_plan(self):
        self.prepare()
        self.executable.write_bytes(self.executable.read_bytes() + b"changed")
        current = self.root / "next"

        def corrupt_rebuild(engine, source, delta, target):
            target.write_bytes(b"incorrect reconstruction")

        with patch.object(payloads.MsDelta, "apply", corrupt_rebuild):
            with self.assertRaisesRegex(ValueError, "reconstruct|checksum|SHA"):
                self.prepare(self.release, current)
        self.assertFalse((current / "update-plan.json").exists())

    def test_missing_or_corrupt_voice_asset_is_rejected(self):
        path = self.voice / "Asr/model.onnx"
        path.unlink()
        with self.assertRaisesRegex(ValueError, "Missing|missing"):
            self.prepare()
        path.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum|SHA|corrupt"):
            self.prepare()
        self.assertFalse((self.release / "update-plan.json").exists())

    def test_missing_voice_manifest_or_entire_group_is_rejected(self):
        shutil.rmtree(self.voice / "Speaker")
        with self.assertRaisesRegex(ValueError, "manifest|Missing|missing"):
            self.prepare()

    def test_duplicate_voice_manifest_entry_is_rejected(self):
        self.change_manifest("Asr", lambda value: value["files"].append(value["files"][0]))
        with self.assertRaisesRegex(ValueError, "[Dd]uplicate"):
            self.prepare()

    def test_dangerous_voice_manifest_paths_are_rejected(self):
        for name in ("../escape", "..\\escape", "/absolute", "C:/escape", "C:escape", "a:b",
                     "CON", "LPT1.bin", "trailing.", "nested/file", "", "a\x00b"):
            with self.subTest(name=name):
                self.change_manifest("Asr", lambda value: value["files"][0].update(name=name))
                with self.assertRaisesRegex(ValueError, "[Uu]nsafe|[Ii]nvalid"):
                    self.prepare()

    def test_duplicate_and_unsafe_previous_plan_paths_are_rejected(self):
        self.prepare()
        original = self.read_plan()
        for path in ("../escape", "VoiceResources/../escape", "VoiceResources\\escape", "C:/escape", "con.txt"):
            with self.subTest(path=path):
                invalid = json.loads(json.dumps(original))
                invalid["files"][0]["path"] = path
                (self.release / "update-plan.json").write_text(json.dumps(invalid), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "[Uu]nsafe|[Ii]nvalid"):
                    self.prepare(self.release, self.root / "next")
        original["files"].append({**original["files"][0], "path": "iceclass.EXE"})
        (self.release / "update-plan.json").write_text(json.dumps(original), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "[Dd]uplicate"):
            self.prepare(self.release, self.root / "next")

    def test_corrupt_previous_payload_stops_generation(self):
        self.prepare()
        old_hash = self.read_plan()["files"][0]["sha256"]
        (self.release / "payloads" / old_hash).write_bytes(b"tampered")
        self.executable.write_bytes(b"different")
        with self.assertRaisesRegex(ValueError, "checksum|SHA|corrupt|size"):
            self.prepare(self.release, self.root / "next")

    def test_invalid_previous_payload_hash_cannot_escape_payloads(self):
        self.prepare()
        plan = self.read_plan()
        plan["files"][0]["sha256"] = "../../private"
        (self.release / "update-plan.json").write_text(json.dumps(plan), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "[Ii]nvalid|SHA|hash"):
            self.prepare(self.release, self.root / "next")

    def test_equal_payload_contents_are_stored_once(self):
        (self.voice / "same.bin").write_bytes(self.executable.read_bytes())
        self.prepare()
        plan = self.read_plan()
        self.assertEqual(len(list((self.release / "payloads").iterdir())), len(plan["files"]) - 1)

    def test_private_siblings_never_enter_plan_or_payloads(self):
        secret = b"private device binding and cloud credentials"
        for relative in (".env", "config.json", "credentials.dpapi", "data/iceclass.db", "core/config.json"):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(secret)
        self.prepare()
        self.assertNotIn("private", (self.release / "update-plan.json").read_text("utf-8"))
        self.assertNotIn(checksum(secret), {path.name for path in (self.release / "payloads").iterdir()})

    @unittest.skipUnless(os.name == "nt", "Release packaging uses Windows PowerShell")
    def test_package_release_keeps_full_download_and_adds_core_plan(self):
        # Run the real packaging and delivery scripts in a tiny isolated checkout.
        workspace = self.root / "workspace"
        for folder in ("scripts", "Receiver", "Desktop", "server", "web_controller", "cloud/migrations", "docs"):
            (workspace / folder).mkdir(parents=True, exist_ok=True)
        for name in ("package-release.ps1", "prepare-update-payloads.py", "prepare-delivery.ps1",
                     "install-classroom.ps1", "install-desktop.ps1", "update-ubuntu.sh"):
            shutil.copyfile(ROOT / "scripts" / name, workspace / "scripts" / name)
        shutil.copyfile(self.project, workspace / "Receiver/Receiver.csproj")
        shutil.copyfile(self.project, workspace / "Desktop/ICeClass.Desktop.csproj")
        shutil.copytree(self.voice, workspace / "Receiver/Assets/Voice")
        for name in ("README.md", "LICENSE", "server/app.py", "server/requirements.txt", "server/install-ubuntu.sh",
                     "web_controller/index.html", "cloud/migrations/0001_initial.sql",
                     "cloud/migrations/0002_reading.sql", "cloud/migrations/0003_classroom.sql", "docs/public.md"):
            (workspace / name).write_text("public fixture", encoding="utf-8")
        private = b"DO NOT DISTRIBUTE PRIVATE CREDENTIALS"
        for name in (".env", "AGENTS.md", "server/.env", "server/iceclass.db", "docs/腾讯云API运维.md"):
            (workspace / name).write_bytes(private)
        distribution = workspace / "dist"
        for folder, filename, data in (("receiver", "ICeClass.exe", b"MZ full offline application"),
                                       ("receiver-core", "ICeClass.exe", self.executable.read_bytes()),
                                       ("desktop", "ICeClass.Desktop.exe", b"MZ teacher application")):
            (distribution / folder).mkdir(parents=True)
            (distribution / folder / filename).write_bytes(data)
            (distribution / folder / "config.json").write_bytes(private)
        environment = os.environ.copy()
        environment["ICECLASS_PYTHON"] = sys.executable
        # PowerShell 7's module path must not hide Windows PowerShell's built-in modules.
        environment.pop("PSMODULEPATH", None)
        result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                                 str(workspace / "scripts/package-release.ps1"), "-SkipBuild"],
                                capture_output=True, timeout=90, env=environment)
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr).decode(errors="replace"))
        with zipfile.ZipFile(distribution / "release/ICeClass-9.8.7-server.zip") as archive:
            self.assertEqual(
                sorted(name for name in archive.namelist() if name.startswith("ICeClass-server/cloud/migrations/")),
                ["ICeClass-server/cloud/migrations/0001_initial.sql",
                 "ICeClass-server/cloud/migrations/0002_reading.sql",
                 "ICeClass-server/cloud/migrations/0003_classroom.sql"],
            )
            prefix = "ICeClass-server/receiver_release/"
            self.assertEqual(archive.read(prefix + "ICeClass.exe"), b"MZ full offline application")
            manifest = json.loads(archive.read(prefix + "manifest.json"))
            self.assertEqual(manifest["sha256"], checksum(b"MZ full offline application"))
            plan = json.loads(archive.read(prefix + "update-plan.json"))
            self.assertEqual(plan["files"][0]["sha256"], checksum(self.executable.read_bytes()))
            self.assertEqual(archive.read(prefix + "payloads/" + plan["files"][0]["sha256"]), self.executable.read_bytes())
            desktop_plan = json.loads(archive.read("ICeClass-server/desktop_release/update-plan.json"))
            self.assertEqual([entry["path"] for entry in desktop_plan["files"]], ["ICeClass.Desktop.exe"])
            for name in archive.namelist():
                self.assertNotIn(private, archive.read(name))
        for archive_path in (distribution / "release").glob("*.zip"):
            with zipfile.ZipFile(archive_path) as archive:
                for name in archive.namelist():
                    self.assertNotIn(Path(name).name.lower(), {"config.json", ".env", "agents.md", "credentials.dpapi", "iceclass.db", "腾讯云api运维.md"})

        previous = self.root / "previous-server"
        with zipfile.ZipFile(distribution / "release/ICeClass-9.8.7-server.zip") as archive:
            archive.extractall(previous)
        (distribution / "receiver-core/ICeClass.exe").write_bytes(self.executable.read_bytes() + b"new release")
        result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                                 str(workspace / "scripts/package-release.ps1"), "-SkipBuild",
                                 "-PreviousServerDirectory", str(previous / "ICeClass-server")],
                                capture_output=True, timeout=90, env=environment)
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr).decode(errors="replace"))
        with zipfile.ZipFile(distribution / "release/ICeClass-9.8.7-server.zip") as archive:
            next_plan = json.loads(archive.read(prefix + "update-plan.json"))
            self.assertEqual(next_plan["files"][0]["deltas"][0]["sourceSha256"], plan["files"][0]["sha256"])
            self.assertEqual(next_plan["files"][1:], plan["files"][1:])


@unittest.skipUnless(os.name == "nt", "Classroom build uses Windows PowerShell")
class BuildClassroomTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / "scripts/build-classroom.ps1").is_file(), "The isolated full/core build script is missing")
        self.temporary = tempfile.TemporaryDirectory(prefix="iceclass-build-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        shutil.copyfile(ROOT / "scripts/build-classroom.ps1", self.root / "scripts/build-classroom.ps1")
        shutil.copyfile(ROOT / "build.bat", self.root / "build.bat")
        (self.root / "scripts/prepare-banban-voice.py").write_text("print('fixture voice assets verified')", encoding="utf-8")
        self.trace = self.root / "build-trace.jsonl"
        self.fake_dotnet = self.root / "fake-dotnet.ps1"
        self.fake_dotnet.write_text('''
if ($args[0] -eq '--version') { Write-Output '8.0.421'; exit 0 }
$outputIndex = [Array]::IndexOf($args, '-o')
$output = $args[$outputIndex + 1]
New-Item -ItemType Directory -Path $output -Force | Out-Null
$content = if ($args -contains '-p:EmbedVoiceResources=true') { 'MZ FULL' } else { 'MZ CORE' }
[IO.File]::WriteAllText((Join-Path $output 'ICeClass.exe'), $content)
[IO.File]::AppendAllText($env:ICECLASS_BUILD_TRACE, (ConvertTo-Json -InputObject @($args) -Compress) + "`n")
exit 0
''', encoding="utf-8-sig")
        self.environment = os.environ.copy()
        self.environment.pop("PSMODULEPATH", None)
        self.environment["ICECLASS_DOTNET"] = str(self.fake_dotnet)
        self.environment["ICECLASS_PYTHON"] = sys.executable
        self.environment["ICECLASS_NO_PAUSE"] = "1"
        self.environment["ICECLASS_BUILD_TRACE"] = str(self.trace)

    def run_build(self):
        return subprocess.run(["cmd.exe", "/d", "/c", str(self.root / "build.bat")],
                              env=self.environment, capture_output=True, timeout=40)

    def test_build_bat_produces_full_and_core_using_separate_intermediates(self):
        (self.root / "dist/receiver").mkdir(parents=True)
        sentinel = self.root / "dist/receiver/config.json"
        sentinel.write_text("existing local binding", encoding="utf-8")
        result = self.run_build()
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr).decode(errors="replace"))
        self.assertEqual((self.root / "dist/receiver/ICeClass.exe").read_text(), "MZ FULL")
        self.assertEqual((self.root / "dist/receiver-core/ICeClass.exe").read_text(), "MZ CORE")
        self.assertEqual(sentinel.read_text(), "existing local binding")
        invocations = [json.loads(line) for line in self.trace.read_text("utf-8-sig").splitlines()]
        self.assertEqual(len(invocations), 2)
        artifacts = [Path(args[args.index("--artifacts-path") + 1]) for args in invocations]
        self.assertNotEqual(artifacts[0], artifacts[1])
        for directory in artifacts:
            self.assertTrue(directory.is_relative_to(self.root))
            self.assertFalse(directory.exists(), "Temporary build outputs should be safely cleaned")

    def test_build_refuses_junction_for_temporary_cleanup(self):
        outside = self.root / "outside"
        outside.mkdir()
        sentinel = outside / "keep.txt"
        sentinel.write_text("keep", encoding="utf-8")
        (self.root / ".tools").mkdir()
        link = self.root / ".tools/classroom-build"
        result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertFalse(self.trace.exists())


if __name__ == "__main__":
    unittest.main()
