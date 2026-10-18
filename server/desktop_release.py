"""Public desktop shell updates; no teacher credentials or classroom binding required."""
from __future__ import annotations

import json
import re
from pathlib import Path
from aiohttp import web


def install_desktop_updates(app, root: Path, *, reply, parse_version):
    executable = root / 'ICeClass.Desktop.exe'

    def release():
        try:
            data = json.loads((root / 'manifest.json').read_text(encoding='utf-8-sig'))
            if not isinstance(data, dict) or parse_version(data.get('version')) is None:
                return None
            size, digest = data.get('size'), data.get('sha256')
            if (type(size) is not int or not 0 < size <= 180 * 1024 * 1024
                    or not isinstance(digest, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', digest)
                    or not executable.is_file() or executable.stat().st_size != size):
                return None
            return {'version': data['version'], 'size': size, 'sha256': digest.lower()}
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
            return None

    async def check(request):
        current = parse_version(request.query.get('currentVersion', ''))
        if current is None:
            return reply({'error': '当前版本号格式不正确。'}, 400)
        data = release()
        if data is None:
            return reply({'available': False})
        if parse_version(data['version']) <= current:
            return reply({'available': False, 'version': data['version']})
        return reply({'available': True, **data, 'downloadUrl': '/api/desktop/update/download'})

    async def download(request):
        if release() is None:
            return reply({'error': '学校暂未发布桌面端更新。'}, 404)
        return web.FileResponse(executable, headers={
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="ICeClass.Desktop.exe"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        })

    app.router.add_get('/api/desktop/update', check)
    app.router.add_get('/api/desktop/update/download', download)
