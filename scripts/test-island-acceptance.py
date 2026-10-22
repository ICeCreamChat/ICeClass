"""Exercise native island lifecycles against the real backend on loopback only.

Run after building tests/ReceiverOfflineChecks in Release. Each run copies the
native host to its own directory and uses a new SQLite database, fictional
device and random local port. No installed classroom state is loaded.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
from datetime import datetime
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
from aiohttp import ClientSession, CookieJar, web
import app as service
from island import defaults
from preview import create_preview


async def run(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    client = output / "native-client"
    shutil.copytree(args.checks.parent, client, ignore=shutil.ignore_patterns(
        "config.json", "island-settings.json", "IslandData", "ReadingData", "ReadingOffline", "WebView2", "logs", "*.log"))
    assembly = client / args.checks.name
    application = create_preview(output / "acceptance.db")
    online = True
    session = None
    class_id = ""

    @web.middleware
    async def network(request, handler):
        if not online and not request.path.startswith("/__acceptance__/"):
            return web.json_response({"error": "isolated acceptance offline"}, status=503)
        return await handler(request)
    application.middlewares.insert(0, network)

    async def api(method, path, body=None):
        async with session.request(method, path, json=body) as response:
            data = await response.json()
            if response.status >= 400:
                raise RuntimeError(f"{method} {path}: {response.status}: {data}")
            return data

    async def disconnect():
        for sockets in list(application[service.ROOMS_KEY].sockets.values()):
            await asyncio.gather(*(socket.close(code=1001, message=b"Acceptance offline") for socket in list(sockets)))

    async def control(request):
        nonlocal online
        action = request.match_info["action"]
        body = await request.json()
        if action == "offline":
            online = False
            await disconnect()
            return web.json_response({"online": False})
        if action == "online":
            online = True
            if body.get("update"):
                current = await api("GET", "/api/island/classes/" + class_id)
                changed = copy.deepcopy(current["config"])
                changed["lessons"][0]["subject"] = "班会"
                await api("PUT", "/api/island/classes/" + class_id, {"revision": current["revision"], "config": changed})
            return web.json_response({"online": True})
        if action == "shout":
            data = await api("POST", "/api/shouts", {"classId": class_id, "text": body["text"], "alertLevel": body["level"],
                "displayDurationSec": 30, "ttsVolume": 0, "ttsSpeed": 0})
            return web.json_response({"id": data["id"]})
        if action == "state":
            history = await api("GET", "/api/history?classId=" + class_id)
            profile = await api("GET", "/api/island/classes/" + class_id)
            state = {"statuses": {row["text"]: "acknowledged" if row.get("acknowledged_at") else row["status"] for row in history["history"]},
                "ackRevision": next((row["revision"] for row in profile["devices"] if row["id"] == binding["DeviceId"]), 0),
                "history": history["history"]}
            (output / "server-state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            return web.json_response(state)
        raise web.HTTPNotFound()
    application.router.add_post("/__acceptance__/{action}", control)
    runner = web.AppRunner(application)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    endpoint = f"http://127.0.0.1:{port}"
    results = []
    try:
        async with ClientSession(base_url=endpoint, cookie_jar=CookieJar(unsafe=True)) as session:
            async with session.post("/api/auth/login", json={"username": "ICe", "password": "LocalDemo2026"}) as response:
                response.raise_for_status()
                login = await response.json()
                session.headers["Cookie"] = response.headers["Set-Cookie"].split(";", 1)[0]
            session.headers["X-CSRF-Token"] = login["user"]["csrfToken"]
            db = application[service.STORE_KEY]
            device = db.one("SELECT d.*, c.name AS class_name FROM devices d JOIN classes c ON c.id=d.class_id WHERE d.token_hash=?",
                (service.sha256("local-demo-device-1"),))
            class_id = device["class_id"]
            profile = defaults()
            profile["slots"] = [{"id": "p1", "label": "第一节", "start": 480, "end": 520},
                {"id": "p2", "label": "第二节", "start": 530, "end": 570}]
            profile["lessons"] = [{"weekday": day, "slotId": slot, "week": "all", "subject": subject,
                "teacher": "验收教师", "location": "验收教室"}
                for day in range(1, 8) for slot, subject in [("p1", "语文"), ("p2", "数学")]]
            profile["reminders"]["enabled"] = False
            await api("PUT", "/api/island/classes/" + class_id, {"revision": 0, "config": profile})
            binding = {"Endpoint": endpoint, "DeviceId": device["id"], "DeviceToken": "local-demo-device-1",
                "ClassId": class_id, "ClassName": device["class_name"], "DeviceName": device["name"], "StartWithWindows": False}
            config = output / "config.json"
            config.write_text(json.dumps(binding, ensure_ascii=False), encoding="utf-8")
            for stage in ["write", "read", "acceptance"]:
                online = stage != "read"
                flag = "--island-acceptance" if stage == "acceptance" else "--island-restart-" + stage
                log = output / (stage + ".log")
                print(f"Running {stage}: isolated native process", flush=True)
                with log.open("wb") as stream:
                    process = await asyncio.create_subprocess_exec(str(args.dotnet), str(assembly), flag, str(config), str(output),
                        stdout=stream, stderr=asyncio.subprocess.STDOUT, cwd=ROOT)
                    try:
                        code = await asyncio.wait_for(process.wait(), 240)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
                        raise RuntimeError(f"{stage} exceeded 240 seconds; see {log}")
                if code:
                    print(log.read_text(encoding="utf-8", errors="replace")[-9000:], flush=True)
                    raise RuntimeError(f"{stage} failed with exit code {code}")
                result = json.loads((output / (stage + ".json")).read_text(encoding="utf-8"))
                if result["failure"]:
                    raise RuntimeError(result["failure"])
                results.append(result)
                print(f"Passed {len(result['passed'])} {stage} checks", flush=True)
            if len({result["processId"] for result in results}) != 3:
                raise RuntimeError("Restart checks did not use three distinct native processes")
    finally:
        await runner.cleanup()
        summary = {"backend": "real Python service, temporary SQLite, loopback only", "endpoint": endpoint,
            "completedAt": datetime.now().astimezone().isoformat(), "stages": results,
            "passed": sum(len(result["passed"]) for result in results), "complete": len(results) == 3}
        (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{summary['passed']} lifecycle checks passed. {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="A new dedicated directory for one acceptance run")
    parser.add_argument("--dotnet", type=Path, default=Path(shutil.which("dotnet") or ROOT / ".tools/desktop-sdk/runtime/dotnet.exe"))
    parser.add_argument("--checks", type=Path, default=ROOT / "tests/ReceiverOfflineChecks/bin/Release/net8.0-windows/ICeClass.ReceiverOfflineChecks.dll")
    asyncio.run(run(parser.parse_args()))
