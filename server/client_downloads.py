"""Public, fixed client installers. Model and application credentials are never required."""
from aiohttp import web
from teacher_capabilities import teacher_manual


def install_client_downloads(app, root, reply):
    @teacher_manual('本机客户端安装包传输；下载并安装需使用客户端分发入口。')
    async def download(request):
        kind = request.match_info['kind']
        if kind not in ('classroom', 'classroom-offline', 'teacher', 'teacher-offline'):
            return reply({'error': '安装包不存在。'}, 404)
        target = root / f'ICeClass-{kind}.zip'
        if not target.is_file() or target.is_symlink():
            return reply({'error': '学校暂未提供此安装包，请联系管理员。'}, 404)
        return web.FileResponse(target, headers={
            'Content-Type': 'application/zip', 'Content-Disposition': f'attachment; filename="ICeClass-{kind}.zip"',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        })
    app.router.add_get('/api/client/download/{kind}', download)
    app.router.add_get('/download/ICeClass-{kind}.zip', download)
