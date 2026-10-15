#!/usr/bin/env bash
# Update an existing installation without rerunning first-time setup.
set -Eeuo pipefail
umask 077
PACKAGE=${1:?Usage: update-ubuntu.sh server.zip version}
VERSION=${2:?Specify the release version}
[[ $EUID -eq 0 && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
APP=/opt/iceclass/app
DATABASE=/var/lib/iceclass/iceclass.db
PYTHON=/opt/iceclass/venv/bin/python
DOWNLOAD=/opt/iceclass/downloads/ICeClass-classroom.zip
[[ -d "$APP" && ! -L "$APP" && -f "$DATABASE" && -f /etc/iceclass.env && -x "$PYTHON" ]]
systemctl is-active --quiet iceclass.service
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/var/backups/iceclass/deploy-$VERSION-$STAMP
STAGE=$(mktemp -d /opt/iceclass/update-$VERSION-XXXXXX)
PREVIOUS=/opt/iceclass/app-before-$VERSION-$STAMP
install -d -m 0700 "$BACKUP"
printf 'Preparing ICeClass %s\n' "$VERSION"
python3 - "$PACKAGE" "$STAGE" "$VERSION" <<'PY'
import ast, hashlib, json, sys, zipfile
from pathlib import Path
package, stage, version = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
with zipfile.ZipFile(package) as archive:
    assert archive.testzip() is None
    for item in archive.infolist():
        assert (stage / item.filename).resolve().is_relative_to(stage.resolve())
    archive.extractall(stage)
root = stage / 'ICeClass-server'
for name in ('server/app.py', 'server/reading.py', 'server/management.py', 'web_controller/reading/desktop.js', 'web_controller/reading/particle-relief.js'):
    assert (root / name).is_file(), name
for name in root.glob('server/*.py'):
    ast.parse(name.read_text('utf8'), filename=str(name))
manifest = json.loads((root / 'receiver_release/manifest.json').read_text('utf-8-sig'))
executable = root / 'receiver_release/ICeClass.exe'
assert manifest['version'] == version
assert manifest['size'] == executable.stat().st_size
with executable.open('rb') as stream:
    checksum = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        checksum.update(chunk)
    assert checksum.hexdigest() == manifest['sha256']
endpoint = 'https://iceclass.icecreamchat.top'
prefix = 'ICeClass/教室端/'
note = '''班伴教室端

将“教室端”整个文件夹解压到固定位置，双击 ICeClass.exe。
首次输入全校绑定码 mas22，依次选择年级和班级。班级名单可刷新。
新版首次运行创建桌面图标。关闭窗口只收起到托盘。
早读在客户端内全屏打开；长按屏幕空白处 2 秒退出全屏。
窗口顶栏“返回”结束本次早读并返回教室首页，“全屏”继续沉浸显示。
首次使用麦克风需允许权限。Windows 10/11 x64 需要 WebView2，缺少时提供官方安装入口。
已绑定的设备优先使用托盘或设置里的“检查更新”，原班级绑定和设置保留。
正式网址已内置。绑定资料保存在本机用户数据目录，无需放在分发文件夹。
从旧版升级时，先保留旧 config.json；新版首次启动验证并迁移成功后自动移走。
许可与第三方说明可在托盘菜单“关于班伴”查看。
'''
with zipfile.ZipFile(stage / 'ICeClass-classroom.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    archive.write(executable, prefix + 'ICeClass.exe')
    archive.writestr(prefix + '一步使用说明.txt', ('\ufeff版本 ' + version + '\n\n' + note).encode('utf8'))
    archive.writestr('ICeClass/教师端.url', '[InternetShortcut]\r\nURL=' + endpoint + '\r\n')
print('Package and classroom download ready.', flush=True)
PY
"$PYTHON" -c 'import aiohttp; assert tuple(map(int, aiohttp.__version__.split(".")[:2])) >= (3,13)'
chown -R root:root "$STAGE/ICeClass-server"
chmod -R a+rX "$STAGE/ICeClass-server"
cp -a /etc/iceclass.env "$BACKUP/iceclass.env"
cp -a /etc/systemd/system/iceclass.service "$BACKUP/iceclass.service"
if [[ -f /etc/nginx/sites-available/iceclass ]]; then cp -a /etc/nginx/sites-available/iceclass "$BACKUP/nginx.conf"; fi
if [[ -f "$DOWNLOAD" ]]; then cp -a "$DOWNLOAD" "$BACKUP/ICeClass-classroom.zip"; fi
STOPPED=0
SWAPPED=0
rollback() {
    rc=$?
    trap - ERR
    if [[ "$STOPPED" == 1 ]]; then
        printf 'Update failed; restoring the previous application and database.\n'
        systemctl stop iceclass.service || true
        if [[ "$SWAPPED" == 1 ]]; then
            if [[ -d "$APP" ]]; then mv "$APP" "$BACKUP/failed-app"; fi
            mv "$PREVIOUS" "$APP"
        fi
        if [[ -f "$BACKUP/iceclass.db" ]]; then
            python3 - "$BACKUP/iceclass.db" "$DATABASE" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as target:
    source.backup(target)
PY
        fi
        if [[ -f "$BACKUP/ICeClass-classroom.zip" ]]; then cp -a "$BACKUP/ICeClass-classroom.zip" "$DOWNLOAD"; fi
        systemctl start iceclass.service || true
    fi
    printf 'Deployment failed. Backup: %s\n' "$BACKUP"
    exit "$rc"
}
trap rollback ERR
STOPPED=1
systemctl stop iceclass.service
python3 - "$DATABASE" "$BACKUP" <<'PY'
import json, sqlite3, sys
from pathlib import Path
backup = Path(sys.argv[2])
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(backup / 'iceclass.db') as target:
    source.backup(target)
    preserved = {}
    for table, columns in (
        ('users', 'id,username,password_hash,role,enabled'),
        ('classes', 'id,name,enabled'),
        ('devices', 'id,class_id,name,token_hash,enabled'),
        ('reading_settings', 'id,value'),
    ):
        if source.execute('SELECT 1 FROM sqlite_master WHERE name=?', (table,)).fetchone():
            preserved[table] = {'columns': columns, 'rows': source.execute('SELECT ' + columns + ' FROM ' + table + ' ORDER BY 1').fetchall()}
    (backup / 'preserved.json').write_text(json.dumps(preserved), 'utf8')
print('Existing database, credentials, bindings and reading rules backed up.', flush=True)
PY
mv "$APP" "$PREVIOUS"
# If the second move fails, the error handler can still restore the previous app.
SWAPPED=1
mv "$STAGE/ICeClass-server" "$APP"
install -m 0644 "$STAGE/ICeClass-classroom.zip" "$DOWNLOAD.new"
mv "$DOWNLOAD.new" "$DOWNLOAD"
systemctl start iceclass.service
for attempt in {1..30}; do
    if curl -fsS http://127.0.0.1:8865/api/bootstrap > "$STAGE/bootstrap.json"; then break; fi
    if [[ "$attempt" == 30 ]]; then journalctl -u iceclass.service -n 40 --no-pager; false; fi
    sleep 1
done
python3 - "$DATABASE" "$BACKUP" "$STAGE" <<'PY'
import json, sqlite3, sys
from pathlib import Path
database, backup, stage = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
bootstrap = json.loads((stage / 'bootstrap.json').read_text())
assert bootstrap['platform'] == 'ICeClass' and bootstrap['required'] is False
with sqlite3.connect(database) as connection:
    assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not connection.execute('PRAGMA foreign_key_check').fetchall()
    for table, expected in json.loads((backup / 'preserved.json').read_text()).items():
        actual = [list(row) for row in connection.execute('SELECT ' + expected['columns'] + ' FROM ' + table + ' ORDER BY 1')]
        assert actual == expected['rows'], 'Existing data changed: ' + table
        print(table + ': existing records preserved (' + str(len(actual)) + ')', flush=True)
PY
curl -fsS http://127.0.0.1:8865/reading/desktop.js -o "$STAGE/desktop.js"
cmp "$STAGE/desktop.js" "$APP/web_controller/reading/desktop.js"
curl -fsS http://127.0.0.1:8865/reading-calendar.js -o "$STAGE/calendar.js"
cmp "$STAGE/calendar.js" "$APP/web_controller/reading-calendar.js"
for resource in integration.js resources.js; do
    curl -fsS "http://127.0.0.1:8865/reading/$resource" -o "$STAGE/$resource"
    cmp "$STAGE/$resource" "$APP/web_controller/reading/$resource"
done
systemctl is-active --quiet iceclass.service
STOPPED=0
trap - ERR
printf 'ICeClass %s deployed successfully.\nBackup: %s\nPrevious app: %s\n' "$VERSION" "$BACKUP" "$PREVIOUS"
