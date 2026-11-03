"""Teacher capabilities declared on the same handlers used by the normal UI.

The catalog is discovered from the *current* application's router, including
features installed after Banban. Model input can never supply a handler or URL.
"""
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class Capability:
    id: str
    title: str
    fields: str = ''
    target: str = ''
    confirm: bool = True
    impact: str = ''
    roles: tuple[str, ...] = ()
    head_only: bool = False
    workflow: str = ''
    method: str = ''
    path: str = ''
    handler: object = None

    def allows(self, user):
        return not self.roles or user['role'] in self.roles


def _declare(kind, capability_id, title, **options):
    spec = Capability(capability_id, title, **options)

    def decorate(handler):
        declarations = dict(getattr(handler, '__teacher_capabilities__', {}))
        if kind in declarations:
            raise ValueError('同一处理器重复声明教师能力：' + capability_id)
        declarations[kind] = spec
        handler.__teacher_capabilities__ = declarations
        return handler

    return decorate


def teacher_action(capability_id, title, **options):
    return _declare('action', capability_id, title, **options)


def teacher_read(capability_id, title, **options):
    return _declare('read', capability_id, title, confirm=False, **options)


def teacher_manual(reason):
    """Explicitly document an interface requiring private/manual user input."""
    if not reason.strip():
        raise ValueError('手动入口需要说明原因。')

    def decorate(handler):
        handler.__teacher_manual__ = reason
        return handler

    return decorate


def _discover(app, kind):
    result = {}
    for route in app.router.routes():
        if route.method == 'HEAD':
            continue
        spec = getattr(route.handler, '__teacher_capabilities__', {}).get(kind)
        if spec is None:
            continue
        if spec.id in result:
            raise ValueError('教师能力编号重复：' + spec.id)
        result[spec.id] = replace(spec, method=route.method, path=route.resource.canonical, handler=route.handler)
    return result


def actions(app):
    return _discover(app, 'action')


def reads(app):
    return _discover(app, 'read')


PROTOCOL_NAMESPACES = {
    '/api/auth': '登录、登出和本人密码使用私密输入。',
    '/api/bootstrap': '首次初始化需要部署者凭据。',
    '/api/session': '当前登录会话协议。',
    '/api/banban': '班班对话、私密模型连接与已确认操作的执行协议，不能递归调用自身。',
    '/api/device': '教室设备凭据、绑定和现场初始化协议。',
    '/api/reading/device': '现场晨读设备协议。',
    '/api/reading/offline': '离线记录及补传协议。',
    '/api/island/device': '教室设备配置同步及回执协议。',
    '/api/receiver/update': '客户端更新下载协议，由更新器完成校验。',
    '/api/desktop/update': '教师端更新下载协议，由原生更新器处理。',
    '/api/receiver/computer/stop': '现场教室电脑停止协议。',
    '/api/ideas/student': '学生提交与撤回使用教室设备身份。',
    '/api/ideas/showcase': '学生端成果展示。',
    '/api/ideas/media': '原始学生图片与录音由授权本人查看，不能传给模型。',
    '/api/feedback': '反馈含本人选择的日志及截图，由反馈表单确认发送。',
}


def undeclared_routes(app, *, prefixes=('/api',)):
    """CI guard: a teacher business route needs a capability or manual reason."""
    result = []
    for route in app.router.routes():
        path = route.resource.canonical
        if route.method == 'HEAD' or not any(path == p or path.startswith(p + '/') for p in prefixes):
            continue
        if any(path == p or path.startswith(p + '/') for p in PROTOCOL_NAMESPACES):
            continue
        if not getattr(route.handler, '__teacher_capabilities__', None) and not getattr(route.handler, '__teacher_manual__', None):
            result.append(route.method + ' ' + path)
    return sorted(result)
