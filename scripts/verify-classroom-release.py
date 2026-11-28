"""Exercise the released classroom ZIPs, authenticated update and native WebView2."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile

from aiohttp import ClientSession, web


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive']
# A PowerShell 7 parent can otherwise hide Windows PowerShell's built-in modules.
WINPS_ENV = {name: value for name, value in os.environ.items() if name.upper() != 'PSMODULEPATH'}
PACKAGE = Path('ICeClass/教室端')
LEGACY_RUNTIME_DIGEST = '7016c03ed2ec423fe68c187f4068ccdfafd49a52e59e7c55792142e8d8334906'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def unpack(archive, directory):
    with zipfile.ZipFile(archive) as package:
        package.extractall(directory)
    return directory


def install(package, target, *, verify=False):
    command = POWERSHELL + ['-ExecutionPolicy', 'Bypass', '-File', str(ROOT / 'tests/test_classroom_package.ps1'),
                            '-Package', str(package), '-InstallDirectory', str(target)]
    subprocess.run(command + (['-VerifyWebView2'] if verify else []), check=True, timeout=140, env=WINPS_ENV)


def old_runtime(archive, folder):
    if digest(archive) != LEGACY_RUNTIME_DIGEST:
        raise RuntimeError('The legacy WebView2 test fixture failed SHA-256 verification')
    return unpack(archive, folder) / 'contentFiles/any/any/WebView2'


def close_test_processes(installation, names, *, wait_for_browser=False):
    subprocess.run(POWERSHELL + ['-Command', r'''
        $root = [IO.Path]::GetFullPath($env:ICECLASS_COMPAT_TEST_ROOT).TrimEnd('\') + '\'
        $processes = @(Get-Process -Name ($env:ICECLASS_COMPAT_TEST_PROCESSES -split ',') -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
        if ($processes.Count -and $env:ICECLASS_COMPAT_WAIT_BROWSER -eq '1') { Start-Sleep -Seconds 2 }
        foreach ($process in $processes) {
            if (-not $process.HasExited) {
                Stop-Process -InputObject $process -ErrorAction Stop
                if (-not $process.WaitForExit(5000)) { throw 'Test process did not stop.' }
            }
        }
    '''], env={**WINPS_ENV, 'ICECLASS_COMPAT_TEST_ROOT': str(installation),
              'ICECLASS_COMPAT_TEST_PROCESSES': names, 'ICECLASS_COMPAT_WAIT_BROWSER': str(int(wait_for_browser))},
        check=True, timeout=20)


async def update(server, installation, checks, dotnet, previous_version):
    sys.path.insert(0, str(server / 'server'))
    import app as school

    release = server / 'receiver_release'
    plan = json.loads((release / 'update-plan.json').read_text('utf-8-sig'))
    cabinet = next(file for file in plan['files'] if file['path'] == 'VoiceResources/WebView2-x64.cab')
    executable = next(file for file in plan['files'] if file['path'] == 'ICeClass.exe')
    device, class_id, token = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    offset = 1024 * 1024
    resumed = []

    @web.middleware
    async def observe_resume(request, handler):
        response = await handler(request)
        if (request.path == '/api/receiver/update/payload' and request.query.get('sha256') == cabinet['sha256']
                and request.headers.get('Range') == f'bytes={offset}-'):
            resumed.append(response)
        return response

    app = school.create_app(server / 'compat.db', release, server / 'desktop_release')
    app.middlewares.append(observe_resume)
    store = app[school.STORE_KEY]
    store.run("INSERT INTO classes(id,name,enabled,created_at,updated_at) VALUES (?,'兼容验收班',1,1,1)", (class_id,))
    store.run("""INSERT INTO devices(id,class_id,name,token_hash,enabled,created_at,updated_at)
                 VALUES (?,?,'兼容验收白板',?,1,1,1)""", (device, class_id, school.sha256(token)))
    runner = web.AppRunner(app)
    await runner.setup()
    try:
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        endpoint = f'http://127.0.0.1:{runner.addresses[0][1]}'
        test_binding = {'Endpoint': endpoint, 'DeviceId': device, 'DeviceToken': token,
                        'ClassId': class_id, 'ClassName': '兼容验收班', 'StartWithWindows': False}
        binding_file = installation.parent / 'test-binding.json'
        binding_file.write_text(json.dumps(test_binding), encoding='utf-8')
        # Give the replacement an isolated paper-classroom scope to avoid the user's daily tray and shortcut.
        existing = {
            installation / 'config.json': json.dumps({**test_binding, 'DeviceId': 'old-test-device'}).encode(),
            installation / 'island-settings.json': b'{"fixture":"existing classroom preferences"}',
            installation / 'CardQuizData/retained-record.json': b'{"fixture":"existing local classroom data"}',
        }
        for file, content in existing.items():
            file.parent.mkdir(exist_ok=True)
            file.write_bytes(content)
        async with ClientSession() as client:
            async with client.get(f'{endpoint}/api/receiver/update/payload',
                                  params={'deviceId': device, 'sha256': cabinet['sha256']},
                                  headers={'Authorization': f'Bearer {token}', 'Range': f'bytes=0-{offset - 1}'}) as response:
                if response.status != 206 or response.headers.get('Content-Range') != f'bytes 0-{offset - 1}/{cabinet["size"]}':
                    raise RuntimeError('The released server did not support the real cabinet byte range')
                partial = await response.read()
        if len(partial) != offset:
            raise RuntimeError('Incomplete initial WebView2 byte range')
        updates = installation / '.updates'
        downloads = updates / 'voice-resources'
        downloads.mkdir(parents=True)
        (downloads / (cabinet['sha256'] + '.download')).write_bytes(partial)
        await asyncio.to_thread(subprocess.run, [dotnet, str(checks), '--classroom-package-update', endpoint,
                                                 previous_version, str(binding_file)], check=True, timeout=270)
        program = installation / 'ICeClass.exe'
        for _ in range(240):
            error = updates / 'last-error.txt'
            if error.exists():
                raise RuntimeError(error.read_text('utf-8-sig'))
            if not any((updates / name).exists() for name in ('pending.json', 'applying.json')):
                break
            await asyncio.sleep(.25)
        else:
            raise TimeoutError('The replacement classroom did not confirm startup')
        if digest(program) != executable['sha256'] or digest(installation / cabinet['path']) != cabinet['sha256']:
            raise RuntimeError('The production updater did not install the expected executable and cabinet')
        if not any(response.status == 206 for response in resumed):
            raise RuntimeError('The WebView2 download did not resume from the saved byte range')
        if any(file.read_bytes() != content for file, content in existing.items()):
            raise RuntimeError('The update modified preexisting classroom data')
        print(f'PASS {previous_version} to {plan["version"]} through authenticated HTTP resume and production update apply', flush=True)
    finally:
        await runner.cleanup()
        # The updater launches the real candidate. Stop only that exact test copy after confirmation.
        close_test_processes(installation, 'ICeClass')


def verify(args, work):
    directory = args.directory.resolve()
    full = unpack(directory / f'ICeClass-{args.version}-classroom-offline.zip', work / '完整 \U0001f680') / PACKAGE
    previous = unpack(args.previous.resolve(), work / 'previous') / PACKAGE
    previous_version = json.loads((previous / 'program-manifest.json').read_text('utf-8-sig'))['version']
    runtime = json.loads((full / 'program-manifest.json').read_text('utf-8-sig'))['webView2']
    fresh, upgraded = work / '安装 \U0001f680', work / '升级 \U0001f680'
    install(full, fresh, verify=True)
    install(previous, upgraded)
    for target in (fresh, upgraded):
        shutil.copytree(args.checks.resolve().parent, target, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('ICeClass.exe', '*.pdb'))

    card_video = work / 'two-cards.y4m'
    subprocess.run(['node', str(ROOT / 'tests/fixtures/paper-camera-fixture.cjs'), str(card_video)], check=True, timeout=15)
    candidate = old_runtime(args.old_runtime.resolve(), work / 'old-webview')

    def probe(target, expected):
        result = subprocess.run([args.dotnet, str(target / args.checks.name), '--classroom-webview-checks',
                                 expected, str(candidate), str(card_video)], capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=120)
        print(result.stdout + result.stderr, end='', flush=True)
        if result.returncode != 0 or 'Installed candidate: 109.0.1518.78' not in result.stdout.splitlines():
            raise RuntimeError(f'Expected a 109.0.1518.78 fallback probe in mode {expected}')

    try:
        probe(fresh, 'bundled')
        # Neither a too-old system runtime nor a corrupt local cabinet may admit navigation.
        damaged = upgraded / 'VoiceResources/WebView2-x64.cab'
        damaged.parent.mkdir(exist_ok=True)
        damaged.write_bytes(b'broken cabinet')
        probe(upgraded, 'recovery')
        if (upgraded / 'WebView2').exists():
            raise RuntimeError('Invalid cabinet was expanded')
        incomplete = upgraded / 'WebView2' / runtime['version']
        incomplete.mkdir(parents=True)
        # Exercise recovery when the version directory exists but extraction did not finish.
        (incomplete / 'msedgewebview2.exe').write_bytes(b'incomplete previous extraction')
        server = unpack(directory / f'ICeClass-{args.version}-server.zip', work / 'server') / 'ICeClass-server'
        asyncio.run(update(server, upgraded, upgraded / args.checks.name, args.dotnet, previous_version))
        probe(upgraded, 'bundled')
    finally:
        close_test_processes(work, 'ICeClass,msedgewebview2', wait_for_browser=True)

    report = {'version': args.version, 'previousVersion': previous_version, 'webView2Candidate': '109.0.1518.78',
              'passed': ['full ZIP install and runtime reuse', 'native home, reading and two-card scan',
                         'recovery for an old runtime with a corrupt cabinet',
                         'authenticated HTTP resume, upgrade confirmation and local data preservation',
                         'repair of an incomplete runtime and native two-card scan after upgrading']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'PASS classroom release compatibility, {args.output}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--previous', type=Path, required=True)
    parser.add_argument('--checks', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--old-runtime', type=Path, required=True)
    parser.add_argument('--dotnet', default='dotnet')
    arguments = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='iceclass-release-compat-') as temp:
        verify(arguments, Path(temp))
