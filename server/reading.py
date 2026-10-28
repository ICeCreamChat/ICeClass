"""Morning reading statistics and classroom controls for the Tencent service."""
from __future__ import annotations

import csv
import io
import json
import math
import secrets
import re
import unicodedata
import uuid
from datetime import date, datetime, timedelta, timezone

from aiohttp import web


SHANGHAI = timezone(timedelta(hours=8))
MODES = {"classic", "carving", "particle", "rocket"}
EVENTS = {"carrots", "poems", "badges", "launches", "energy"}
COOKIE = "iceclass_reading"
GRADES = ("高一", "高二", "高三", "其他")
DEFAULT = {"enabled": False, "reminderEnabled": True, "threshold": 30, "periods": [],
           "classic": {"duration": 15, "targetCount": 10},
           "rocket": {"duration": 15, "targetCount": 10},
           "carving": {"speed": 1}, "particle": {"speed": 1}}

SCHEMA = """
CREATE TABLE IF NOT EXISTS reading_settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reading_launches(token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reading_browser_sessions(token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reading_sessions(id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), class_id TEXT NOT NULL REFERENCES classes(id), mode TEXT NOT NULL, started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reading_session_days(session_id TEXT NOT NULL REFERENCES reading_sessions(id), day TEXT NOT NULL, PRIMARY KEY(session_id,day));
CREATE TABLE IF NOT EXISTS reading_buckets(class_id TEXT NOT NULL REFERENCES classes(id), day TEXT NOT NULL, bucket INTEGER NOT NULL, active_mask INTEGER NOT NULL, effective_mask INTEGER NOT NULL, PRIMARY KEY(class_id,bucket));
CREATE INDEX IF NOT EXISTS reading_buckets_day ON reading_buckets(day,class_id);
CREATE TABLE IF NOT EXISTS reading_events(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES reading_sessions(id), class_id TEXT NOT NULL REFERENCES classes(id), day TEXT NOT NULL, occurred_at INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, counted INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reading_events_day ON reading_events(day,class_id);
CREATE TABLE IF NOT EXISTS classroom_controls(class_id TEXT PRIMARY KEY REFERENCES classes(id), volume INTEGER NOT NULL, command_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS device_telemetry(device_id TEXT PRIMARY KEY REFERENCES devices(id), volume INTEGER, receiver_version TEXT, capabilities TEXT NOT NULL DEFAULT '[]', command_id TEXT, command_error TEXT, reported_at INTEGER NOT NULL);
"""


def local_day(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp / 1000, SHANGHAI).date().isoformat()


def class_grade(name: str) -> str:
    name = ''.join(unicodedata.normalize('NFKC', str(name)).split())
    match = re.match(r'^高([一二三123])(?=[^0-9]|$)', name)
    return '高' + {'1': '一', '2': '二', '3': '三'}.get(match[1], match[1]) if match else '其他'


def inside_period(timestamp: int, config: dict) -> bool:
    if not config["enabled"]:
        return False
    local = datetime.fromtimestamp(timestamp / 1000, SHANGHAI)
    minute = local.hour * 60 + local.minute
    return any(local.isoweekday() in p["weekdays"] and p["start"] <= minute < p["end"]
               for p in config["periods"])


def validate_config(body: dict) -> dict:
    if not isinstance(body.get("enabled"), bool):
        raise ValueError("请选择是否启用统计。")
    if not isinstance(body.get("reminderEnabled", True), bool):
        raise ValueError("请选择是否启用到点提醒。")
    threshold = body.get("threshold")
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 5 <= threshold <= 90:
        raise ValueError("声量门槛需要在 5 至 90 之间。")
    periods = body.get("periods")
    if not isinstance(periods, list) or len(periods) > 30:
        raise ValueError("统计时段最多设置 30 个。")
    normalized = []
    for p in periods:
        if not isinstance(p, dict):
            raise ValueError("统计时段格式不正确。")
        days, start, end = p.get("weekdays"), p.get("start"), p.get("end")
        if not isinstance(days, list) or not days or any(type(d) is not int or not 1 <= d <= 7 for d in days):
            raise ValueError("每个时段至少选择一个星期。")
        if type(start) is not int or type(end) is not int or not 0 <= start < end <= 1440:
            raise ValueError("结束时间必须晚于开始时间；跨夜时段请拆成两段。")
        normalized.append({"weekdays": sorted(set(days)), "start": start, "end": end})
    if body["enabled"] and not normalized:
        raise ValueError("请先添加早读统计时段。")
    result = {"enabled": body["enabled"], "reminderEnabled": body.get("reminderEnabled", True), "threshold": threshold, "periods": normalized}
    for mode in MODES:
        value = body.get(mode, DEFAULT[mode])
        if not isinstance(value, dict):
            raise ValueError("陪伴参数格式不正确。")
        if mode in {"classic", "rocket"}:
            duration, target = value.get("duration"), value.get("targetCount")
            if type(duration) is not int or not 1 <= duration <= 120 or type(target) is not int or not 1 <= target <= 180:
                raise ValueError("每个目标的时长为 1 至 120 秒，数量为 1 至 180。")
            result[mode] = {"duration": duration, "targetCount": target}
        else:
            speed = value.get("speed")
            if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not .01 <= speed <= 4:
                raise ValueError("点亮与汇聚速度需要在 0.01 至 4 倍之间。")
            result[mode] = {"speed": speed}
    return result


class ReadingFeature:
    def __init__(self, db, rooms, *, user, admin, authenticate, access, reply, clock, digest, class_sort=None):
        self.db, self.rooms = db, rooms
        self.user, self.admin, self.authenticate, self.access = user, admin, authenticate, access
        self.reply, self.clock, self.digest = reply, clock, digest
        self.class_sort = class_sort or (lambda name: name)
        db.db.executescript(SCHEMA)
        db.run("INSERT OR IGNORE INTO reading_settings VALUES(1,?)", (json.dumps(DEFAULT),))
        from offline_reading import OfflineReading
        self.offline = OfflineReading(self)

    def config(self):
        return json.loads(self.db.one("SELECT value FROM reading_settings WHERE id=1")["value"])

    def payload(self):
        now = self.clock()
        config = self.config()
        return {"config": config, "serverTime": now, "inPeriod": inside_period(now, config)}

    async def get_settings(self, request):
        user = self.admin(request)
        return user if isinstance(user, web.Response) else self.reply(self.payload())

    async def save_settings(self, request):
        user = self.admin(request)
        if isinstance(user, web.Response):
            return user
        try:
            body = await request.json()
            # Gameplay stays in the companion's local controls; this endpoint only changes statistics.
            previous = self.config()
            fields = {key: body[key] for key in ('enabled', 'reminderEnabled', 'threshold', 'periods') if key in body} if isinstance(body, dict) else {}
            config = validate_config({**{mode: previous[mode] for mode in MODES}, 'reminderEnabled': previous.get('reminderEnabled', True), **fields})
        except (ValueError, TypeError):
            return self.reply({"error": "请检查声量门槛、星期和起止时间。"}, 400)
        with self.db.transaction():
            self.db.run("UPDATE reading_settings SET value=? WHERE id=1", (json.dumps(config),))
            self.offline.save_rule(config)
        return self.reply(self.payload())

    async def schedule(self, request):
        device = self.authenticate(request)
        if not device:
            return self.reply({"error": "教室设备未绑定或已停用。"}, 401)
        config = self.config()
        classroom = self.db.one("SELECT name FROM classes WHERE id=?", (device["class_id"],))
        return self.reply({"enabled": config["enabled"], "reminderEnabled": config.get("reminderEnabled", True),
                           "periods": config["periods"], "serverTime": self.clock(),
                           "classId": device["class_id"], "className": classroom["name"]})

    async def launch(self, request):
        device = self.authenticate(request)
        if not device:
            return self.reply({"error": "教室设备未绑定或已停用。"}, 401)
        token = secrets.token_urlsafe(32)
        now = self.clock()
        with self.db.transaction():
            self.db.run("DELETE FROM reading_launches WHERE expires_at<=?", (now,))
            self.db.run("DELETE FROM reading_browser_sessions WHERE expires_at<=?", (now,))
            self.db.run("INSERT INTO reading_launches VALUES(?,?,?)", (self.digest(token), device["id"], now + 90_000))
        return self.reply({"launchToken": token})

    async def connect_browser(self, request):
        try:
            body = await request.json()
            token = body.get("launchToken", "") if isinstance(body, dict) else ""
        except ValueError:
            token = ""
        if not isinstance(token, str) or not 20 <= len(token) <= 100:
            return self.reply({"error": "请从已绑定的教室端打开早读陪伴。"}, 401)
        now = self.clock()
        with self.db.transaction():
            device = self.db.one("""SELECT d.id,d.class_id,c.name FROM reading_launches l
                JOIN devices d ON d.id=l.device_id JOIN classes c ON c.id=d.class_id
                WHERE l.token_hash=? AND l.expires_at>? AND d.enabled=1 AND c.enabled=1""", (self.digest(token), now))
            if not device:
                return self.reply({"error": "打开链接已过期，请在教室端重新打开。"}, 401)
            self.db.run("DELETE FROM reading_launches WHERE token_hash=?", (self.digest(token),))
            browser_token = secrets.token_urlsafe(32)
            self.db.run("INSERT INTO reading_browser_sessions VALUES(?,?,?)", (self.digest(browser_token), device["id"], now + 12 * 3600_000))
        response = self.reply({"className": device["name"], **self.payload()})
        response.set_cookie(COOKIE, browser_token, max_age=12*3600, httponly=True, samesite="Strict",
                            secure=request.headers.get("X-Forwarded-Proto", request.scheme) == "https", path="/api/reading/device")
        return response

    def browser_device(self, request):
        token = request.cookies.get(COOKIE, "")
        # Device cookies are restricted to the reading routes. Check origin on writes as well.
        origin = request.headers.get("Origin")
        if request.method != "GET" and origin and origin != f"{request.headers.get('X-Forwarded-Proto', request.scheme)}://{request.host}":
            return None
        return self.db.one("""SELECT d.id,d.class_id,c.name FROM reading_browser_sessions b
            JOIN devices d ON d.id=b.device_id JOIN classes c ON c.id=d.class_id
            WHERE b.token_hash=? AND b.expires_at>? AND d.enabled=1 AND c.enabled=1""", (self.digest(token), self.clock())) if token else None

    async def device_settings(self, request):
        device = self.browser_device(request)
        return self.reply({"className": device["name"], **self.payload()}) if device else self.reply({"error": "请从教室端重新打开早读陪伴。"}, 401)

    async def start_session(self, request):
        device = self.browser_device(request)
        if not device:
            return self.reply({"error": "请从教室端重新打开早读陪伴。"}, 401)
        try:
            body = await request.json()
            mode = body.get("mode") if isinstance(body, dict) else None
        except ValueError:
            mode = None
        if not isinstance(mode, str) or mode not in MODES:
            return self.reply({"error": "请选择有效的陪伴模式。"}, 400)
        now, session_id = self.clock(), str(uuid.uuid4())
        self.db.run("INSERT INTO reading_sessions VALUES(?,?,?,?,?,?)", (session_id, device["id"], device["class_id"], mode, now, now))
        return self.reply({"sessionId": session_id, **self.payload()}, 201)

    async def pulse(self, request):
        device = self.browser_device(request)
        if not device:
            return self.reply({"error": "请从教室端重新打开早读陪伴。"}, 401)
        try:
            body = await request.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self.reply({"error": "统计数据格式不正确。"}, 400)
        session = self.db.one("SELECT * FROM reading_sessions WHERE id=? AND device_id=?", (str(body.get("sessionId", "")), device["id"]))
        samples, events = body.get("samples", []), body.get("events", [])
        if not session or not isinstance(samples, list) or len(samples) > 90 or not isinstance(events, list) or len(events) > 100:
            return self.reply({"error": "统计会话或数据格式不正确。"}, 400)
        now, config = self.clock(), self.config()
        accepted = effective = 0
        with self.db.transaction():
            for sample in samples:
                if not isinstance(sample, dict):
                    continue
                at, level = sample.get("at"), sample.get("volume")
                if type(at) is not int or isinstance(level, bool) or not isinstance(level, (int, float)) or not math.isfinite(level) or not 0 <= level <= 100:
                    continue
                if at < max(session["started_at"] - 1000, now - 90_000) or at > now + 1500 or sample.get("active") is not True:
                    continue
                second = at // 1000
                if not inside_period(second * 1000, config):
                    continue
                bucket, bit, day = second // 10, 1 << (second % 10), local_day(at)
                is_effective = level >= config["threshold"]
                self.db.run("""INSERT INTO reading_buckets VALUES(?,?,?,?,?) ON CONFLICT(class_id,bucket)
                    DO UPDATE SET active_mask=active_mask | excluded.active_mask,effective_mask=effective_mask | excluded.effective_mask""",
                    (device["class_id"], day, bucket, bit, bit if is_effective else 0))
                self.db.run("INSERT OR IGNORE INTO reading_session_days VALUES(?,?)", (session["id"], day))
                accepted += 1
                effective += int(is_effective)
            for event in events:
                if not isinstance(event, dict):
                    continue
                event_id, at, kind = event.get("id"), event.get("at"), event.get("kind")
                if not isinstance(event_id, str) or not 1 <= len(event_id) <= 80 or type(at) is not int or not isinstance(kind, str) or kind not in EVENTS:
                    continue
                allowed = {"classic": {"carrots"}, "carving": {"poems"}, "particle": {"badges"}, "rocket": {"energy", "launches"}}[session["mode"]]
                if kind not in allowed or at < max(session["started_at"] - 1000, now - 90_000) or at > now + 1500:
                    continue
                self.db.run("INSERT OR IGNORE INTO reading_events VALUES(?,?,?,?,?,?,?,?)", (event_id, session["id"], device["class_id"], local_day(at), at,
                    kind, str(event.get("title", ""))[:100], int(inside_period(at, config))))
            self.db.run("UPDATE reading_sessions SET last_seen_at=? WHERE id=?", (now, session["id"]))
        return self.reply({"accepted": accepted, "effective": effective, **self.payload()})

    def query_report(self, request, user, *, class_access=None):
        today = local_day(self.clock())
        start, end = request.query.get("start", today), request.query.get("end", today)
        try:
            first, last = date.fromisoformat(start), date.fromisoformat(end)
            if not 0 <= (last - first).days <= 366:
                raise ValueError()
        except ValueError:
            raise ValueError("请选择有效日期范围，最长一年。")
        class_id = request.query.get("classId", "")
        grades = set(request.query.get('grades', '').split(',')) - {''}
        if not grades.issubset(GRADES):
            raise ValueError('请选择有效的年级范围。')
        access = self.access if class_access is None else class_access
        classes = [c for c in self.db.all("SELECT id,name,enabled FROM classes ORDER BY name")
                   if access(self.db, user, c['id'], include_disabled=True)]
        if class_id and not any(c['id'] == class_id for c in classes):
            raise PermissionError()
        rows = {c["id"]: {"classId": c["id"], "className": c["name"], "grade": class_grade(c['name']), "enabled": c["enabled"], "activeSeconds": 0, "effectiveSeconds": 0,
                         "sessions": 0, "days": 0, "modes": [], "completed": {k: 0 for k in sorted(EVENTS)}}
                for c in classes if (not class_id or c["id"] == class_id) and (not grades or class_grade(c['name']) in grades)}
        daily = {}
        def day_row(class_id, day):
            return daily.setdefault((class_id, day), {"className": rows[class_id]["className"], "day": day,
                "activeSeconds": 0, "effectiveSeconds": 0, "sessions": 0,
                "completed": {kind: 0 for kind in sorted(EVENTS)}})

        for bucket in self.db.all("SELECT * FROM reading_buckets WHERE day BETWEEN ? AND ?", (start, end)):
            if bucket["class_id"] not in rows:
                continue
            row = rows[bucket["class_id"]]
            active, effective = bucket["active_mask"].bit_count(), bucket["effective_mask"].bit_count()
            row["activeSeconds"] += active
            row["effectiveSeconds"] += effective
            dayrow = day_row(bucket["class_id"], bucket["day"])
            dayrow["activeSeconds"] += active
            dayrow["effectiveSeconds"] += effective
        for item in self.db.all("""SELECT s.class_id,s.mode,COUNT(DISTINCT s.id) sessions,COUNT(DISTINCT sd.day) days
            FROM reading_session_days sd JOIN reading_sessions s ON s.id=sd.session_id WHERE sd.day BETWEEN ? AND ? GROUP BY s.class_id,s.mode""", (start, end)):
            if item["class_id"] in rows:
                row = rows[item["class_id"]]
                row["sessions"] += item["sessions"]
                row["modes"].append(item["mode"])
        for item in self.db.all("""SELECT s.class_id,sd.day,COUNT(DISTINCT s.id) sessions
            FROM reading_session_days sd JOIN reading_sessions s ON s.id=sd.session_id
            WHERE sd.day BETWEEN ? AND ? GROUP BY s.class_id,sd.day""", (start, end)):
            if item["class_id"] in rows:
                day_row(item["class_id"], item["day"])["sessions"] = item["sessions"]
        for item in self.db.all("SELECT class_id,day,kind,COUNT(*) amount FROM reading_events WHERE counted=1 AND day BETWEEN ? AND ? GROUP BY class_id,day,kind", (start, end)):
            if item["class_id"] in rows:
                rows[item["class_id"]]["completed"][item["kind"]] += item["amount"]
                day_row(item["class_id"], item["day"])["completed"][item["kind"]] = item["amount"]
        for class_id_key, row in rows.items():
            row["days"] = len({day for (cid, day), record in daily.items() if cid == class_id_key and record["activeSeconds"]})
            row["sync"] = self.offline.report_status(class_id_key)
        result = sorted(rows.values(), key=lambda row: (-row["effectiveSeconds"], self.class_sort(row["className"])))
        previous, rank = None, 0
        for index, row in enumerate(result):
            if row["effectiveSeconds"] != previous:
                rank, previous = index + 1, row["effectiveSeconds"]
            row["rank"] = rank if row["activeSeconds"] else None
            row["ratio"] = round(row["effectiveSeconds"] / row["activeSeconds"] * 100, 1) if row["activeSeconds"] else None
        return {"start": start, "end": end, "grades": [grade for grade in GRADES if grade in grades], "rows": result,
                "daily": sorted(daily.values(), key=lambda row: (row["day"], self.class_sort(row["className"])))}

    async def report(self, request):
        user = self.user(request)
        if isinstance(user, web.Response):
            return user
        try:
            return self.reply(self.query_report(request, user))
        except ValueError as error:
            return self.reply({"error": str(error)}, 400)
        except PermissionError:
            return self.reply({"error": "没有查看该班级的权限。"}, 403)

    async def export(self, request):
        user = self.user(request)
        if isinstance(user, web.Response):
            return user
        try:
            report = self.query_report(request, user)
        except ValueError as error:
            return self.reply({"error": str(error)}, 400)
        except PermissionError:
            return self.reply({"error": "没有查看该班级的权限。"}, 403)
        if request.query.get('format') == 'xlsx':
            from reading_xlsx import export_reading_xlsx
            return web.Response(body=export_reading_xlsx(report),
                                content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                headers={'Content-Disposition': f'attachment; filename="morning-reading-{report["start"]}-{report["end"]}.xlsx"'})
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["名次", "班级", "开始日期", "结束日期", "使用次数", "使用天数", "运行秒数", "有效发声秒数", "达标占比", "萝卜", "诗词", "徽章", "发射", "能量格", "同步状态"])
        for row in report["rows"]:
            name = row["className"]
            if name.startswith(("=", "+", "-", "@", "\t", "\r")):
                name = "'" + name
            writer.writerow([row["rank"] or ("暂无记录" if row["sync"]["state"] == "current" else "待同步确认"), name, report["start"], report["end"], row["sessions"], row["days"], row["activeSeconds"], row["effectiveSeconds"], row["ratio"],
                             *[row["completed"][k] for k in ("carrots", "poems", "badges", "launches", "energy")],
                             {"current": "已同步", "pending": "待补传", "review": "待核实", "unconfirmed": "待同步确认"}[row["sync"]["state"]]])
        return web.Response(body=("\ufeff" + output.getvalue()).encode("utf-8"), content_type="text/csv", charset="utf-8", headers={"Content-Disposition": 'attachment; filename="morning-reading.csv"'})

    async def controls(self, request):
        user = self.user(request)
        if isinstance(user, web.Response):
            return user
        from management import device_summary
        rows = self.db.all("""SELECT d.id,d.class_id,c.name class_name,d.name,d.enabled,d.last_seen_at,
            d.computer_name,d.os_version,d.local_addresses,d.identity_seen_at,d.binding_note,d.verified_at,
            cc.volume desired_volume,cc.command_id desired_command,t.volume actual_volume,t.receiver_version,t.capabilities,t.command_id,t.command_error,t.reported_at
            FROM devices d JOIN classes c ON c.id=d.class_id LEFT JOIN classroom_controls cc ON cc.class_id=c.id
            LEFT JOIN device_telemetry t ON t.device_id=d.id WHERE d.deleted_at IS NULL ORDER BY c.name,d.name""")
        counts = {r['class_id']: r['n'] for r in self.db.all('SELECT class_id,COUNT(*) n FROM devices WHERE enabled=1 AND deleted_at IS NULL GROUP BY class_id')}
        rows = [r for r in rows if self.access(self.db, user, r['class_id'], include_disabled=True)]
        for row in rows:
            device_summary(row, self.rooms, counts)
            row["capabilities"] = json.loads(row["capabilities"] or "[]")
        return self.reply({"devices": rows})

    async def command(self, request):
        user = self.user(request)
        if isinstance(user, web.Response):
            return user
        class_id = request.match_info["class_id"]
        if not self.access(self.db, user, class_id):
            return self.reply({"error": "没有此班级的操作权限，或班级已停用。"}, 403)
        if not self.db.one("SELECT id FROM devices WHERE class_id=? AND enabled=1 AND deleted_at IS NULL", (class_id,)):
            return self.reply({"error": "该班级尚未绑定启用的教室设备。"}, 409)
        try:
            body = await request.json()
        except ValueError:
            body = {}
        if not isinstance(body, dict) or body.get("action") not in ("set_volume", "open_reading"):
            return self.reply({"error": "请选择有效的教室操作。"}, 400)
        payload = {"type": "device_command", "commandId": str(uuid.uuid4()), "action": body["action"]}
        if body["action"] == "set_volume":
            value = body.get("volume")
            if type(value) is not int or not 0 <= value <= 100:
                return self.reply({"error": "播放音量需要在 0 至 100 之间。"}, 400)
            payload["volume"] = value
            self.db.run("""INSERT INTO classroom_controls VALUES(?,?,?,?) ON CONFLICT(class_id)
                DO UPDATE SET volume=excluded.volume,command_id=excluded.command_id,updated_at=excluded.updated_at""", (class_id, value, payload["commandId"], self.clock()))
        delivered = await self.rooms.broadcast(class_id, payload)
        return self.reply({"commandId": payload["commandId"], "delivered": delivered, "saved": body["action"] == "set_volume"}, 202)

    async def on_connect(self, socket, class_id):
        control = self.db.one("SELECT * FROM classroom_controls WHERE class_id=?", (class_id,))
        if control:
            await socket.send_json({"type": "device_command", "commandId": control["command_id"], "action": "set_volume", "volume": control["volume"]})

    def telemetry(self, device_id, message):
        volume = message.get("outputVolume")
        volume = volume if type(volume) is int and 0 <= volume <= 100 else None
        if message.get("type") == "device_status":
            capabilities = message.get("capabilities", [])
            capabilities = [v for v in capabilities if isinstance(v, str) and v in {"reading", "volume", "agent_control_v1"}] if isinstance(capabilities, list) else []
            self.db.run("""INSERT INTO device_telemetry(device_id,volume,receiver_version,capabilities,reported_at) VALUES(?,?,?,?,?)
                ON CONFLICT(device_id) DO UPDATE SET volume=excluded.volume,receiver_version=excluded.receiver_version,capabilities=excluded.capabilities,reported_at=excluded.reported_at""",
                (device_id, volume, str(message.get("version", ""))[:30], json.dumps(capabilities), self.clock()))
        elif message.get("action") == "set_volume":
            control = self.db.one("SELECT cc.command_id FROM classroom_controls cc JOIN devices d ON d.class_id=cc.class_id WHERE d.id=?", (device_id,))
            if not control or control["command_id"] != message.get("commandId"):
                return
            error = str(message.get("error", "音量设置失败。"))[:200] if message.get("success") is not True else None
            self.db.run("""INSERT INTO device_telemetry(device_id,volume,command_id,command_error,reported_at) VALUES(?,?,?,?,?)
                ON CONFLICT(device_id) DO UPDATE SET volume=excluded.volume,command_id=excluded.command_id,command_error=excluded.command_error,reported_at=excluded.reported_at""",
                (device_id, volume, control["command_id"], error, self.clock()))


def install_reading(app, db, rooms, **callbacks):
    feature = ReadingFeature(db, rooms, **callbacks)
    rooms.reading = feature
    app.router.add_get("/api/reading/offline/context", feature.offline.bootstrap)
    app.router.add_post("/api/reading/offline/sync", feature.offline.sync)
    app.router.add_get("/api/reading/settings", feature.get_settings)
    app.router.add_put("/api/reading/settings", feature.save_settings)
    app.router.add_get("/api/reading/schedule", feature.schedule)
    app.router.add_post("/api/reading/launch", feature.launch)
    app.router.add_post("/api/reading/device/connect", feature.connect_browser)
    app.router.add_get("/api/reading/device/settings", feature.device_settings)
    app.router.add_post("/api/reading/device/sessions", feature.start_session)
    app.router.add_post("/api/reading/device/pulse", feature.pulse)
    app.router.add_get("/api/reading/report", feature.report)
    app.router.add_get("/api/reading/export", feature.export)
    app.router.add_get("/api/classroom-controls", feature.controls)
    app.router.add_post("/api/classes/{class_id}/control", feature.command)
