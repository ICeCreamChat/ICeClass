"""Verify release archives and boot the packaged backend in an isolated process."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


async def boot_packaged_server(root):
    # This process imports only the extracted modules, not the working tree.
    sys.path.insert(0, str(root / "server"))
    import app as service
    from aiohttp import ClientSession, web
    with tempfile.TemporaryDirectory(prefix="iceclass-package-db-") as database:
        application = service.create_app(Path(database) / "test.db", root / "receiver_release")
        assert "/api/island/device" in {route.resource.canonical for route in application.router.routes()}
        runner = web.AppRunner(application)
        await runner.setup()
        try:
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            async with ClientSession() as client:
                async with client.get(f"http://127.0.0.1:{port}/api/bootstrap") as response:
                    assert response.status == 200, await response.text()
                    await response.json()
                async with client.get(f"http://127.0.0.1:{port}/api/island/device?deviceId=unbound") as response:
                    assert response.status == 401, await response.text()
        finally:
            await runner.cleanup()
    print("PASS extracted backend imports, database initialization, HTTP startup and island routes")


def verify(args):
    root, version = args.directory.resolve(), args.version
    checks, artifacts = [], []
    for kind in ["windows-x64", "server", "classroom", "desktop-windows-x64"]:
        path = root / f"ICeClass-{version}-{kind}.zip"
        with zipfile.ZipFile(path) as archive:
            assert archive.testzip() is None, path.name
            for name in archive.namelist():
                parts = Path(name.replace("\\", "/")).parts
                assert ".." not in parts and not Path(name).is_absolute(), name
                assert Path(name).name.lower() not in {"config.json", ".env", "iceclass.db", "island-settings.json", "banban-settings.json", "credentials.dpapi", "agents.md", "腾讯云api运维.md"}, name
        checks.append(path.name + ": CRC, safe paths and no machine binding/preferences")
        artifacts.append({"file": path.name, "size": path.stat().st_size, "sha256": sha256(path)})
    with tempfile.TemporaryDirectory(prefix="iceclass-package-") as temporary:
        with zipfile.ZipFile(root / f"ICeClass-{version}-server.zip") as archive:
            archive.extractall(temporary)
        server = Path(temporary) / "ICeClass-server"
        hashes = {}
        for directory, filename in [("receiver_release", "ICeClass.exe"), ("desktop_release", "ICeClass.Desktop.exe")]:
            manifest = json.loads((server / directory / "manifest.json").read_text("utf-8-sig"))
            executable = server / directory / filename
            assert manifest["version"] == version, directory
            assert manifest["size"] == executable.stat().st_size, directory
            assert manifest["sha256"] == sha256(executable), directory
            assert executable.read_bytes()[:2] == b"MZ", filename
            hashes[filename] = manifest["sha256"]
            checks.append(directory + ": version, size and executable checksum")
        assert (server / "web_controller/island-admin.js").is_file()
        assert (server / "web_controller/island-ribbon.css").is_file()
        assert (server / "web_controller/banban-voice.js").is_file()
        assert (server / "web_controller/banban-voice.css").is_file()
        assert (server / "server/banban_speech.py").is_file()
        assert (server / "server/banban_math_speech.py").is_file()
        assert (server / "server/banban_operations.py").is_file()
        assert (server / "server/banban_vision.py").is_file()
        assert (server / "web_controller/banban-operations.js").is_file()
        assert (server / "web_controller/banban-operations.css").is_file()
        assert (server / "web_controller/island-schedule.js").is_file()
        for notice in ["THIRD_PARTY_NOTICES.md", "SenseVoice-MODEL-LICENSE.txt", "MeloTTS-LICENSE.txt", "SileroVAD-LICENSE.txt",
                       "sherpa-onnx-LICENSE.txt", "ONNXRuntime-LICENSE.txt", "3D-Speaker-LICENSE.txt"]:
            assert (server / "docs/licenses" / notice).is_file(), notice
        checks.append("voice sentence protocol, client assets and third-party notices are included")
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--server-root", str(server)],
            cwd=temporary, capture_output=True, text=True, encoding="utf-8", timeout=40)
        assert result.returncode == 0, result.stdout + result.stderr
        checks.append("extracted backend imports, initializes a fresh database and serves authenticated island routes")
        for kind, filename in [("classroom", "ICeClass.exe"), ("desktop-windows-x64", "ICeClass.Desktop.exe")]:
            with zipfile.ZipFile(root / f"ICeClass-{version}-{kind}.zip") as archive:
                names = [name for name in archive.namelist() if name.endswith("/" + filename)]
                assert len(names) == 1, names
                assert hashlib.sha256(archive.read(names[0])).hexdigest() == hashes[filename], filename
            checks.append(kind + ": client executable matches server update manifest")
    report = {"version": version, "checks": checks, "artifacts": artifacts, "executables": hashes}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    for check in checks:
        print("PASS " + check)
    print(f"Verified {version} archives; {args.output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent.parent / "dist/release")
    parser.add_argument("--version", default="2.4.0")
    parser.add_argument("--output", type=Path, default=Path("output/release-verification.json"))
    parser.add_argument("--server-root", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.server_root:
        asyncio.run(boot_packaged_server(args.server_root))
    else:
        verify(args)
