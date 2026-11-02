"""Run the installer's real staging commands without privileged host changes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "server/install-ubuntu.sh"


def find_bash():
    if os.name == "nt":
        candidate = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
        return str(candidate) if candidate.is_file() else None
    return shutil.which("bash")


@unittest.skipUnless(find_bash(), "Bash and coreutils are required (Git Bash on Windows)")
class ServerInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="iceclass-install-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.package = self.root / "package with spaces"
        self.destination = self.root / "installed"
        self.modules = (
            "app", "desktop_release", "reading", "reading_xlsx", "offline_reading",
            "management", "banban", "banban_agent", "banban_operations",
            "banban_connections", "banban_history", "banban_platform", "banban_policy",
            "banban_speech", "banban_math_speech", "banban_vision", "feedback", "ideas",
            "island", "island_timetable_xlsx", "island_xlsx", "permissions", "update_payloads",
            "new_runtime_module",
        )
        for name in self.modules:
            self.write(f"server/{name}.py", f"NAME = {name!r}\n".encode())
        # A real import verifies that the installed application can resolve its modules.
        self.write("server/app.py", ("\n".join(
            f"import {name}" for name in self.modules if name != "app") + "\n").encode())
        self.write("server/requirements.txt", b"aiohttp>=3.13,<4\n")
        for name in ("test_private.py", "preview.py", ".env", "credentials.dpapi"):
            self.write(f"server/{name}", b"not a runtime file")
        self.migrations = (
            "0001_initial.sql", "0002_voice_messages.sql", "0003_quiet_hours.sql",
            "0004_fixture.sql",
        )
        for name in self.migrations:
            self.write(f"cloud/migrations/{name}", f"-- {name}\nSELECT 1;\n".encode())
        self.write("cloud/migrations/notes.txt", b"not a migration")
        self.write("web_controller/index.html", b"<!doctype html><title>fixture</title>")
        self.write("web_controller/assets/nested.js", b"window.fixture = true;\n")
        for directory, executable in (
            ("receiver_release", "ICeClass.exe"),
            ("desktop_release", "ICeClass.Desktop.exe"),
        ):
            full = b"MZ complete offline application\x00" + directory.encode()
            core = b"MZ incremental core\x00" + directory.encode()
            digest = hashlib.sha256(core).hexdigest()
            patch = b"delta fixture\x00" + directory.encode()
            patch_digest = hashlib.sha256(patch).hexdigest()
            self.write(f"{directory}/{executable}", full)
            self.write(f"{directory}/manifest.json", json.dumps({
                "version": "2.5.2", "size": len(full),
                "sha256": hashlib.sha256(full).hexdigest(),
            }).encode())
            self.write(f"{directory}/update-plan.json", json.dumps({
                "version": "2.5.2", "files": [{
                    "path": executable, "size": len(core), "sha256": digest,
                    "deltas": [{"sourceSha256": "0" * 64, "size": len(patch),
                                "sha256": patch_digest}],
                }],
            }).encode())
            self.write(f"{directory}/payloads/{digest}", core)
            self.write(f"{directory}/payloads/{patch_digest}", patch)
        for name in ("install.ps1", "安装或升级.cmd", "program-manifest.json", "一步使用说明.txt"):
            self.write(f"receiver_release/{name}", name.encode("utf-8"))

    def write(self, relative, content):
        path = self.package / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def stage(self):
        # Execute the actual staging phase, stopping before venv/network/service work.
        # Do not run the root-only installer or rewrite any of its copy commands.
        source = INSTALLER.read_text(encoding="utf-8")
        start = source.index('STAGING_DIR="$APP_ROOT/app.new"')
        end = source.index('python3 -m venv "$VENV_DIR"', start)
        commands = source[start:end]
        harness = '''set -Eeuo pipefail
PACKAGE_ROOT="$(cd "$1" && pwd)"
APP_ROOT="$PWD/installed"
mkdir -p "$APP_ROOT"
# Ownership changes require root; all copy/install/chmod commands stay real.
chown() { :; }
''' + commands
        result = subprocess.run(
            [find_bash(), "--noprofile", "--norc", "-c", harness,
             "installer-fixture", self.package.as_posix()],
            cwd=self.root, capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return self.destination / "app.new"

    def assert_file_equal(self, installed, relative):
        self.assertTrue((installed / relative).is_file(), f"Not installed: {relative}")
        self.assertEqual((installed / relative).read_bytes(), (self.package / relative).read_bytes())

    def test_installed_runtime_can_import_all_packaged_modules(self):
        installed = self.stage()
        for name in self.modules:
            self.assert_file_equal(installed, f"server/{name}.py")
        self.assert_file_equal(installed, "server/requirements.txt")
        import sys
        result = subprocess.run(
            [sys.executable, "-B", str(installed / "server/app.py")],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_installs_all_sql_migrations_including_0002_and_0003(self):
        installed = self.stage()
        for name in self.migrations:
            self.assert_file_equal(installed, f"cloud/migrations/{name}")
        self.assertFalse((installed / "cloud/migrations/notes.txt").exists())

    def test_installs_both_update_plans_full_downloads_and_payloads_unchanged(self):
        installed = self.stage()
        for directory in ("receiver_release", "desktop_release", "web_controller"):
            for path in (self.package / directory).rglob("*"):
                if path.is_file():
                    self.assert_file_equal(installed, path.relative_to(self.package).as_posix())

    def test_optional_teacher_release_may_be_absent(self):
        shutil.rmtree(self.package / "desktop_release")
        installed = self.stage()
        self.assert_file_equal(installed, "receiver_release/ICeClass.exe")
        self.assertFalse((installed / "desktop_release").exists())

    def test_does_not_install_server_tests_preview_or_local_configuration(self):
        installed = self.stage()
        for name in ("test_private.py", "preview.py", ".env", "credentials.dpapi"):
            self.assertFalse((installed / "server" / name).exists(), name)


if __name__ == "__main__":
    unittest.main()
