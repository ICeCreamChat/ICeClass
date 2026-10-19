"""Streaming, read-only data tools and permission-bound conversation memory."""
from __future__ import annotations

import asyncio
import json
import re
import unicodedata
from contextlib import suppress
from datetime import date, datetime, timedelta

from aiohttp import ClientError, ClientSession, ClientTimeout, web
from reading import SHANGHAI
from banban_platform import BanbanPlatform, PLATFORM_TOPICS, TITLES
from banban_policy import AnswerStream, detail_requested, local_reply
from banban_history import BanbanHistory, HISTORY_KEY
from banban_connections import completion_url, provider_options, required_tool_choice, upstream_connector

TOPICS = {'reading': '晨读记录', 'notifications': '通知回执', 'voice': '教室来音', **TITLES}
VIEWS = {'reading': 'reading', 'notifications': 'history', 'voice': 'classroom-voice', 'devices': 'controls'}
PROPERTIES = {
    'topic': {'type': 'string', 'enum': list(TOPICS), 'description': '本次查询的主题'},
    'start': {'type': 'string', 'description': '北京时间起始日期 YYYY-MM-DD；省略沿用当前范围'},
    'end': {'type': 'string', 'description': '北京时间结束日期 YYYY-MM-DD，包含当天'},
    'className': {'type': 'string', 'description': '授权班级的完整名称；空字符串查看全部班级；省略沿用当前班级'},
    'grades': {'type': 'string', 'description': '高一、高二、高三、其他，多个用英文逗号分隔；空字符串表示全部'},
    'period': {'type': 'string', 'enum': ['current', 'today', 'yesterday', 'this_week', 'last_week'],
               'description': '优先使用日期预设；上周=last_week（上周一到周日），日期由服务器计算，避免自行推算错误'},
}
TOOLS = [
    {'type': 'function', 'function': {'name': 'query_data', 'description': '只读查询：platform 综合检查；reading 晨读；sync 同步；notifications 通知回执；voice 来音数量时长；devices 当前设备；rules 规则；bindings 绑定核查、accounts 账号汇总（后二者限超级管理员）；help 平台使用方法和操作入口。不会读取音频或修改数据。',
     'parameters': {'type': 'object', 'properties': PROPERTIES, 'required': ['topic'], 'additionalProperties': False}}},
    {'type': 'function', 'function': {'name': 'compare_periods', 'description': '只支持 reading、notifications、voice 的历史时段比较。比较选定时段与前一个同样长的时段，返回服务器计算的差值。',
     'parameters': {'type': 'object', 'properties': {**PROPERTIES, 'comparison': {'type': 'string', 'enum': ['previous_period', 'previous_week']}},
                    'required': ['topic'], 'additionalProperties': False}}},
]
AGENT_RULES = '''你可以使用服务器提供的只读工具，查询或比较不同日期、年级、班级的数据。
所有可见文字都使用中文，包括查询前的过渡句。调用工具时只返回工具调用，查询进度由界面呈现，不要额外解释打算做什么。
回答涉及具体统计、排名、趋势的问题前，必须调用工具读取新数据；不能把旧对话中的统计当作当前数据。
用户追问“那二班呢”“上周呢”时，结合本次对话、上次查询范围和当前页面理解。班级不明确时先简短确认，不能随意选班。
日期按提供的北京时间计算；“本周”从周一到今天，“上周”是上周一到周日。“较上周同期”使用 previous_week。
询问上周、本周、今天、昨天时使用 period 预设。“比较各班”是班级对比，未经要求不要附加上期对比。
工具返回的 errors 是查询失败，不代表零记录。工具不存在或没有权限的事情不能声称已经执行。
用户让你发送通知、删除数据或调整设备时，说明可协助分析和查看入口，实际操作需由用户在页面完成。
回答像一位有分寸的同事：直接回应这次问题，不反复使用固定开场，不在每次回答末尾重复隐私声明。
对简单问候和道谢自然简短回应，不强行添加数据。比较时明确日期和比较口径。
时长用几分几秒，不用小数分钟。无需复述工具调用的计划。
缺少记录的时段不能当作可信的零基数，不要使用“从零增长”“没开展”一类判断。
统计卡片和入口由界面自动呈现，正文不抄整张表，不生成网址，不输出动作标签、工具名或内部思考过程。
晨读时长变化不代表教学质量变化；未同步或缺少软件记录不能判断班级没有早读。'''
AGENT_RULES += '''
你了解整个平台：晨读、同步、班级通知回执、来音数量时长、设备、绑定、规则、账号和操作指南。
“检查整个平台/整体情况”优先一次查询 platform；只查询用户问题需要的数据，避免拆成许多重复工具调用。
设备、同步、绑定、账号、规则是当前状态，日期筛选不会产生历史在线状态；不能比较历史掉线时长。
设备 lastContactAt 是最近联系；lastReportedVolume 是最近回报，只有 telemetryFresh 才能视作近期回报。
版本只与服务器已发布版本比较，未回报版本不能判断新旧；指令结果 pending/unconfirmed 不能说已经生效。
多设备绑定、离线、未同步只提供核查线索，不推断绑错、网络故障或教学因果；综合数据里同时出现也不是因果证据。
账号与绑定核查仅超级管理员可查，详细设备遥测与学校晨读参数同样只给超级管理员；权限由服务器决定。
用户问怎样操作或请求修改时，可查询 help 或对应主题提供页面入口，不能称已发送、修改、删除或调整。
rules 返回当前规则和固定统计口径，help 返回现有平台功能；不要从自身常识编造平台不存在的按钮。
工具的 coverage 表示数据完整性；有缺失时说记录差值，不说实际教学增长。'''
AGENT_RULES += '\n综合检查最多选两项优先事项，每项用一句话；数字明细在卡片中，不复述全量汇总，不输出历史数据附注或 JSON。声量门槛是应用的 0–100 相对声量，不能称为分贝；设备播放音量是系统百分比。入口使用工具提供的现有页面名称与 settingsPath，不杜撰设置页。'


def install_agent(app, feature, system):
    agent = BanbanAgent(feature, system)
    app.router.add_get('/api/banban/conversation', agent.conversation)
    app.router.add_delete('/api/banban/conversation', agent.new_conversation_legacy)
    app.router.add_get('/api/banban/conversations', agent.conversations)
    app.router.add_post('/api/banban/conversations', agent.new_conversation)
    app.router.add_post('/api/banban/conversations/{conversation_id}/open', agent.open_conversation)
    app.router.add_delete('/api/banban/conversations/{conversation_id}', agent.delete_conversation)
    app.router.add_get('/api/banban/history-policy', agent.history_policy)
    app.router.add_put('/api/banban/history-policy', agent.save_history_policy)
    app.router.add_post('/api/banban/chat/stream', agent.chat)
    app.router.add_post('/api/banban/chat/cancel', agent.cancel)
    app.router.add_post('/api/banban/connection/test', agent.test_connection)

    async def shutdown(_):
        tasks = list(agent.jobs.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    app.on_shutdown.append(shutdown)


class BanbanAgent:
    def __init__(self, feature, system):
        self.f, self.s, self.db, self.system = feature, feature.s, feature.db, system
        self.jobs = {}
        self.platform = BanbanPlatform(feature)
        self.history = BanbanHistory(self.db, lambda: self.s.now_ms(), self.access)
        feature.app[HISTORY_KEY] = self.history

    def roster(self, user):
        return self.f.roster(user)

    def access(self, user):
        # A plain list, not a token. Permission changes invalidate old chat text too.
        return {'role': user['role'], 'classes': self.roster(user)}

    @staticmethod
    def needs_data(message):
        plain = re.sub(r'[\s，。？！、,.!?~～：:]', '', message).lower().replace('您', '你')
        if re.fullmatch(r'(?:班班)?(?:你好|您好|嗨|哈喽|hello|hi|谢谢|谢谢你|谢谢班班|辛苦了|晚安|早安|早上好|中午好|下午好|晚上好|再见|拜拜|好的|好哒)(?:呀|啊|啦|哦)?(?:班班)?', plain):
            return False
        if plain in {'你是谁', '你叫什么', '你叫什么名字', '你能做什么', '你有什么功能', '怎么使用班班', '如何使用班班', '你能帮我做什么', '班班你能做什么'}:
            return False
        # A continuation can be only "那二班呢" or "再简单点". Refresh its
        # scope too, instead of trusting a model to reuse old numbers correctly.
        return True

    def memory(self, user):
        return self.history.load(user)

    async def conversation(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        try:
            before = request.query.get('before')
            if before is not None and (not before.isdecimal() or len(before) > 18):
                raise ValueError('历史消息位置不正确。')
            data = self.history.load(user, request.query.get('conversationId'), int(before) if before else None)
            return self.s.json_response(data)
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 404)

    async def conversations(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        try:
            updated, cid = request.query.get('beforeUpdated'), request.query.get('beforeId')
            if (updated is None) != (cid is None) or updated is not None and (not updated.isdecimal() or len(updated) > 18 or len(cid) > 36):
                raise ValueError('历史会话位置不正确。')
            return self.s.json_response(self.history.listing(user, (int(updated), cid) if updated is not None else None))
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 400)

    async def new_conversation(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        if user['id'] in self.f.busy:
            return self.s.json_response({'error': '请先停止当前回答，再开始新对话。'}, 409)
        return self.s.json_response(self.history.create(user), 201)

    async def open_conversation(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        if user['id'] in self.f.busy:
            return self.s.json_response({'error': '请先停止当前回答，再切换对话。'}, 409)
        try:
            return self.s.json_response(self.history.open(user, request.match_info['conversation_id']))
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 404)

    async def history_policy(self, request):
        user = self.s.require_admin(request)
        return user if isinstance(user, web.Response) else self.s.json_response(self.history.policy())

    async def delete_conversation(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        if user['id'] in self.f.busy:
            return self.s.json_response({'error': '请先停止当前回答，再删除对话。'}, 409)
        try:
            cid = request.match_info['conversation_id']
            return self.s.json_response({'ok': True, 'deletedId': cid, 'conversation': self.history.delete(user, cid)})
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 404)

    async def save_history_policy(self, request):
        user = self.s.require_admin(request)
        if isinstance(user, web.Response):
            return user
        body = await self.s.read_json(request)
        if not isinstance(body, dict) or not isinstance(body.get('cycle'), str) or body['cycle'] not in {'weekly', 'monthly'}:
            return self.s.json_response({'error': '请选择每周或每月统一清理。'}, 400)
        return self.s.json_response(self.history.set_policy(body['cycle']))

    async def new_conversation_legacy(self, request):
        # Cached older pages used DELETE for their "new chat" button. Preserve
        # the old thread for those clients too, while selecting a fresh thread.
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        await self.cancel_job(user)
        return self.s.json_response({'ok': True, **self.history.create(user)})

    async def cancel_job(self, user):
        job = self.jobs.get(user['id'])
        if job:
            job.cancel()
            with suppress(asyncio.CancelledError, ConnectionError):
                await job
            if self.jobs.get(user['id']) is job:
                self.jobs.pop(user['id'], None)
                self.f.busy.discard(user['id'])
    async def cancel(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        await self.cancel_job(user)
        return self.s.json_response({'ok': True})

    def check_access(self, request, original):
        user = self.s.require_user(request)
        if isinstance(user, web.Response) or self.access(user) != original:
            raise PermissionError('登录或班级权限已变化，请刷新后开始新对话。')
        return user

    @staticmethod
    def safe_snapshot(snapshot):
        safe = json.loads(json.dumps(snapshot, ensure_ascii=False))
        safe['scope'].pop('classId', None)
        for row in safe['reading']['classes']:
            row.pop('classId', None)
            row['sync'] = {'state': row['sync']['state']}
        return safe

    @staticmethod
    def params(snapshot):
        return {**{k: snapshot['scope'].get(k, '') for k in ('start', 'end', 'classId')},
                'grades': ','.join(snapshot['scope']['grades'])}

    def tool_scope(self, args, scope, user, question=''):
        if not isinstance(args, dict) or set(args) - (set(PROPERTIES) | {'comparison'}):
            raise ValueError('查询参数无法识别，请重新选择查询范围。')
        if any(not isinstance(v, str) for v in args.values()) or args.get('topic') not in TOPICS:
            raise ValueError('查询主题或参数格式不正确。')
        selected = {**scope, **{k: args[k] for k in ('start', 'end', 'grades') if k in args}}
        period = args.get('period', 'current')
        # A single explicit "last week" means the full calendar week, even if the
        # model accidentally carries a prior weekday-only range into its call.
        if re.search(r'(?<!上)上周', question) and not re.search(r'同期|本周|这周|比较|对比|相比|较上周|\d{4}-\d{2}-\d{2}', question):
            period = 'last_week'
        today = datetime.fromtimestamp(self.s.now_ms() / 1000, SHANGHAI).date()
        monday = today - timedelta(days=today.weekday())
        periods = {'today': (today, today), 'yesterday': (today - timedelta(days=1), today - timedelta(days=1)),
                   'this_week': (monday, today), 'last_week': (monday - timedelta(days=7), monday - timedelta(days=1))}
        if period in periods:
            selected.update(zip(('start', 'end'), (d.isoformat() for d in periods[period])))
        elif period != 'current':
            raise ValueError('日期预设不正确。')
        if 'grades' in args and 'className' not in args:
            selected['classId'] = ''
        if 'className' in args:
            def normal(text):
                return ''.join(c for c in unicodedata.normalize('NFKC', text) if c.isalnum())
            name = args['className'].strip()
            found = [r for r in self.roster(user) if normal(r['name']) == normal(name)]
            if name and len(found) != 1:
                raise PermissionError('没有找到这个完整名称的授权班级，请确认年级和班号。')
            selected['classId'] = found[0]['id'] if name else ''
            if name:
                selected['grades'] = ''
        return selected

    def bundle(self, snapshot, topic, previous=None):
        r, n, v, d = (snapshot[k] for k in ('reading', 'notifications', 'voice', 'devices'))
        figures = {
            'reading': [('有效发声', r['effectiveSeconds'], 'seconds'), ('使用班级', r['usedClasses'], 'classes'), ('使用次数', r['sessions'], 'times')],
            'notifications': [('发送通知', n['total'], 'items'), ('白板已显示', n['displayed'], 'items'), ('失败或离线', n['failed'], 'items')],
            'voice': [('累计来音', v['total'], 'items'), ('总时长', round(v['durationMs'] / 1000), 'seconds')],
            'devices': [('已绑定', d['total'], 'devices'), ('已启用', d['enabled'], 'devices')],
        }[topic]
        metrics = [dict(label=label, value=value, unit=unit) for label, value, unit in figures]
        if previous:
            old = self.bundle(previous, topic)
            for metric, before in zip(metrics, old['metrics']):
                metric.update(previous=before['value'], delta=metric['value'] - before['value'])
        leaders = sorted((c for c in r['classes'] if c['activeSeconds']), key=lambda c: -c['effectiveSeconds'])[:3]
        note = f"{r['pendingClasses']} 个班待确认同步，排名供参考" if r['pendingClasses'] else ''
        if topic == 'voice':
            note = '累计收到数量，包含已过期或删除的来音；更早记录可能不完整。'
        if topic == 'notifications':
            note = '白板显示回执不代表师生已阅读。'
        if topic == 'devices':
            note = '绑定与启用状态；实时在线情况请到教室控制查看。'
        return {'topic': topic, 'title': TOPICS[topic], 'scope': snapshot['scope'], 'generatedAt': snapshot['generatedAt'],
                'metrics': metrics, 'note': note, 'view': VIEWS[topic],
                'rows': [dict(classId=c['classId'], label=c['className'], value=c['effectiveSeconds']) for c in leaders] if topic == 'reading' else [],
                'previousScope': previous['scope'] if previous else None}

    def query(self, name, args, scope, user, question=''):
        if name not in {'query_data', 'compare_periods'}:
            raise ValueError('班班只能查询和比较统计数据，不能执行此操作。')
        selected = self.tool_scope(args, scope, user, question)
        topic = args['topic']
        if name == 'compare_periods' and topic not in {'reading', 'notifications', 'voice'}:
            raise ValueError('此主题仅提供当前状态，不能比较历史时段。')
        snapshot = self.f.snapshot(selected, user)
        if topic in PLATFORM_TOPICS:
            data, card = self.platform.read(snapshot, topic, user)
            return data, card, self.params(snapshot)
        previous = None
        if name == 'compare_periods':
            kind = args.get('comparison', 'previous_period')
            if kind not in {'previous_period', 'previous_week'}:
                raise ValueError('比较方式不正确。')
            first, last = (date.fromisoformat(snapshot['scope'][k]) for k in ('start', 'end'))
            offset = timedelta(days=7 if kind == 'previous_week' else (last - first).days + 1)
            previous = self.f.snapshot({**selected, 'start': (first - offset).isoformat(), 'end': (last - offset).isoformat()}, user)
        def focused(value):
            safe = self.safe_snapshot(value)
            result = {k: safe[k] for k in ('generatedAt', 'scope', args['topic'])}
            result['coverage'] = {'hasRecords': bool(safe[topic]['activeSeconds'] if topic == 'reading' else safe[topic]['total']),
                                  'syncUnconfirmedClasses': safe['reading']['pendingClasses'] if topic == 'reading' else None,
                                  'basis': '无记录不代表实际未开展；差值仅反映服务器已有记录。'}
            return result
        data = {'current': focused(snapshot)}
        if previous:
            data['previous'] = focused(previous)
        return data, self.bundle(snapshot, args['topic'], previous), self.params(snapshot)

    @staticmethod
    def overview_topic(message):
        choices = [('platform', '整体|全平台|整个平台|全校检查|综合|整个后台|平台检查'),
                   ('help', '(?:怎么|怎样|如何)(?!样)(?:用|使用|操作|设置|修改|绑定|安装|更新|打开|发送|查看|导出|比较|调整|管理|删除|停用|重置|进入|找到|登录)|操作|使用指南'), ('sync', '同步|补传'),
                   ('rules', '规则|时段|门槛|禁言'), ('accounts', '账号|用户管理'),
                   ('bindings', '绑定|换届|更名|更替|升年级'), ('devices', '设备|白板|电脑|版本|音量|在线'),
                   ('voice', '来音|录音|语音'), ('notifications', '通知|送达|喊话|回执')]
        return next((topic for topic, pattern in choices if re.search(pattern, message)), 'reading')

    @staticmethod
    def provider_error(status):
        if status in {401, 403}:
            return '班班连接验证失败，请在连接设置中检查密钥、服务地址和模型。'
        if status in {402, 429}:
            return '班班当前可用额度或请求次数不足，请稍后重试。'
        return '班班暂时无法完成分析，请稍后重试。'

    async def provider(self, cfg, messages, allow_tools=True):
        """Parse the actual upstream SSE; never simulate streaming a buffered reply."""
        payload = {'model': cfg['model'], 'messages': messages, 'stream': True,
                   **provider_options(cfg), 'max_tokens': cfg.get('answerTokens', 700)}
        if allow_tools:
            payload['tools'] = TOOLS
            if allow_tools == 'required':
                payload['tool_choice'] = required_tool_choice(cfg)
                if payload['tool_choice'] == 'auto':
                    payload['messages'] = [{'role': 'system', 'content': '本轮必须先调用可用的数据工具核对记录，再回答。不要凭记忆猜测当前数据。'}, *messages]
        async with ClientSession(timeout=ClientTimeout(total=55, connect=10, sock_read=35), connector=upstream_connector()) as client:
            async with client.post(completion_url(cfg),
                                   headers={'Authorization': 'Bearer ' + cfg['apiKey']}, json=payload, allow_redirects=False) as response:
                if response.status != 200:
                    raise ValueError(self.provider_error(response.status))
                total, done, finish = 0, False, None
                async for raw in response.content:
                    total += len(raw)
                    if total > 500_000 or len(raw) > 200_000:
                        raise ValueError('回答过长，请缩小范围后重试。')
                    if not raw.startswith(b'data:'):
                        continue
                    value = raw[5:].strip()
                    if value == b'[DONE]':
                        done = True
                        break
                    try:
                        event = json.loads(value)
                        if event.get('error'):
                            raise ValueError()
                        choices = event.get('choices', [])
                        if not choices:
                            continue
                        choice = choices[0]
                        delta = choice.get('delta', {})
                        if isinstance(delta.get('content'), str) and delta['content']:
                            yield {'text': delta['content']}
                        if delta.get('tool_calls'):
                            yield {'tool_calls': delta['tool_calls']}
                        if choice.get('finish_reason'):
                            finish = choice['finish_reason']
                    except (ValueError, KeyError, IndexError, TypeError, UnicodeError):
                        raise ValueError('班班回复格式异常，请稍后重试。') from None
                if not done or finish not in {'stop', 'tool_calls'}:
                    raise ValueError('回复中断或未完成，已收到的文字保留在窗口，可重试。')

    async def run(self, request, user, message, snapshot, memory, cfg, emit, page='reading'):
        access = self.access(user)
        scope = self.params(snapshot)
        cards, answer = [], ''
        direct = local_reply(message, user['role'])
        detail = detail_requested(message)
        cfg = {**cfg, 'answerTokens': 1800 if detail else 700}
        mode = 'local' if direct else 'deepseek' if cfg['enabled'] and cfg['apiKey'] else 'overview'
        await emit({'type': 'meta', 'mode': mode, 'scope': scope, 'detailRequested': detail, 'conversationId': memory['id']})
        if direct:
            answer = direct
            await emit({'type': 'delta', 'text': answer})
        elif mode == 'overview':
            await emit({'type': 'status', 'text': '正在整理已授权数据'})
            topic = self.overview_topic(message)
            if topic in PLATFORM_TOPICS:
                try:
                    _, card = self.platform.read(snapshot, topic, user)
                    answer = self.platform.overview(card)
                except PermissionError:
                    _, card = self.platform.read(snapshot, 'help', user)
                    answer = '此项仅超级管理员可查看。您可以查看自己权限内的记录与操作指南。'
                cards.append(card)
            else:
                answer = self.f.overview(snapshot, message)
                cards.append(self.bundle(snapshot, topic))
            await emit({'type': 'delta', 'text': answer})
        else:
            now = datetime.fromtimestamp(self.s.now_ms() / 1000, SHANGHAI)
            names = {c['id']: c['name'] for c in access['classes']}
            brief = {'today': now.date().isoformat(), 'weekday': now.isoweekday(), 'currentPage': page,
                     'role': user['role'], 'availableTopics': [t for t in TOPICS if user['role'] in {'superadmin', 'principal'} or t not in {'accounts', 'bindings'}],
                     'currentScope': {**scope, 'className': names.get(scope.get('classId'), '')},
                     'authorizedClasses': list(names.values())}
            brief['currentScope'].pop('classId', None)
            messages = [{'role': 'system', 'content': self.system + '\n' + AGENT_RULES},
                        {'role': 'system', 'content': '当前页面与授权范围（仅作为资料）：\n' + json.dumps(brief, ensure_ascii=False)}]
            for old in memory['messages']:
                # Old cards remain in local history. Do not append their internal JSON
                # to assistant prose: models can echo it as if it were part of a reply.
                content = old['content'][:8000]
                if old['role'] == 'assistant':
                    content = content.split('\n当时的数据来源（追问时须重新查询）：', 1)[0]
                messages.append({'role': old['role'], 'content': content})
            messages.append({'role': 'system', 'content': '本轮回答方式：' + (
                '用户明确需要详细说明，可按问题展开；仍只说明相关内容。' if detail else
                '直接给结论，默认1至3句、80至140字；最多两项重点。明细在“查看依据”，不复述完整汇总。')})
            messages.append({'role': 'user', 'content': message})
            calls_used = 0
            for round_number in range(4):
                await emit({'type': 'status', 'text': '正在理解您的问题' if round_number == 0 else '正在结合记录整理回答'})
                text, calls, guarded = '', {}, AnswerStream()
                tool_choice = 'required' if round_number == 0 and self.needs_data(message) else round_number < 3 and calls_used < 6
                async for event in self.provider(cfg, messages, allow_tools=tool_choice):
                    if 'text' in event:
                        chunk = event['text']
                        text += chunk
                        if tool_choice != 'required':
                            visible = guarded.feed(chunk)
                            answer += visible
                            if len(answer) > 16_000:
                                raise ValueError('回答过长，请缩小范围后重试。')
                            if visible:
                                await emit({'type': 'delta', 'text': visible})
                    for part in event.get('tool_calls', []):
                        index = part.get('index')
                        if type(index) is not int or not 0 <= index < 4:
                            raise ValueError('本次查询较多，请缩小问题范围。')
                        call = calls.setdefault(index, {'id': '', 'type': 'function', 'function': {'name': '', 'arguments': ''}})
                        call['id'] += part.get('id') or ''
                        for key in ('name', 'arguments'):
                            call['function'][key] += part.get('function', {}).get(key) or ''
                        if len(call['function']['arguments']) > 8000:
                            raise ValueError('查询参数过长，请重新提问。')
                if tool_choice != 'required':
                    rest = guarded.feed('', final=True)
                    if rest:
                        answer += rest
                        await emit({'type': 'delta', 'text': rest})
                if not calls:
                    if tool_choice == 'required':
                        raise ValueError('这次未能核对到数据，请重新提问。')
                    if not text.strip():
                        raise ValueError('这次没有收到回答，请重新提问。')
                    break
                if round_number == 3 or calls_used + len(calls) > 6:
                    raise ValueError('这次需要查询的范围较多，请分开提问。')
                messages.append({'role': 'assistant', 'content': text or None, 'tool_calls': list(calls.values())})
                for call in calls.values():
                    self.check_access(request, access)
                    calls_used += 1
                    topic = None
                    try:
                        args = json.loads(call['function']['arguments'])
                        topic = args.get('topic', 'reading') if isinstance(args, dict) else 'reading'
                        await emit({'type': 'status', 'text': '正在核对' + TOPICS.get(topic, '统计记录')})
                        data, card, scope = self.query(call['function']['name'], args, scope, user, message)
                        same = next((i for i, c in enumerate(cards) if c['topic'] == card['topic'] and c['scope'] == card['scope']), None)
                        if same is None:
                            cards.append(card)
                        elif card['previousScope'] or not cards[same]['previousScope']:
                            cards[same] = card
                        cards = cards[-6:]
                        await emit({'type': 'card', 'card': card})
                        result = json.dumps(data, ensure_ascii=False)
                    except (ValueError, PermissionError, OverflowError) as error:
                        reason = '未能查询这个范围，请检查日期、授权班级全称和查询主题。'
                        if isinstance(error, PermissionError) and topic in {'accounts', 'bindings'}:
                            reason = '此项仅超级管理员可查看。'
                        elif call['function']['name'] == 'compare_periods' and topic in PLATFORM_TOPICS:
                            reason = '此主题仅提供当前状态，不能比较历史时段。'
                        result = json.dumps({'error': reason + '不能把查询失败当成零记录。'}, ensure_ascii=False)
                    messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': result})
                if text and tool_choice != 'required':
                    answer += '\n\n'
                    await emit({'type': 'delta', 'text': '\n\n'})
        self.check_access(request, access)
        if mode == 'overview':
            for card in cards:
                await emit({'type': 'card', 'card': card})
        assistant = {'role': 'assistant', 'content': answer, 'mode': mode, 'cards': cards, 'detailRequested': detail}
        timestamp = self.history.append(user, memory['id'], access, scope, [{'role': 'user', 'content': message}, assistant])
        await emit({'type': 'done', 'message': assistant, 'scope': scope, 'updatedAt': timestamp, 'conversationId': memory['id']})

    async def chat(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        body = await self.s.read_json(request) or {}
        if not isinstance(body, dict):
            return self.s.json_response({'error': '问题格式不正确。'}, 400)
        message, scope = body.get('message'), body.get('scope', {})
        cid = body.get('conversationId')
        if cid is not None and (not isinstance(cid, str) or not 1 <= len(cid) <= 36):
            return self.s.json_response({'error': '会话编号不正确。'}, 400)
        page = body.get('page', 'reading')
        if not isinstance(page, str) or page not in {'reading', 'history', 'console', 'classroom-voice', 'controls', 'classes', 'teachers', 'quiet', 'settings'}:
            return self.s.json_response({'error': '页面范围不正确。'}, 400)
        if not isinstance(message, str) or not 1 <= len(message.strip()) <= 2000:
            return self.s.json_response({'error': '请输入问题，最多 2000 字。'}, 400)
        if not isinstance(scope, dict) or set(scope) - {'start', 'end', 'classId', 'grades'} or any(not isinstance(v, str) for v in scope.values()):
            return self.s.json_response({'error': '分析范围格式不正确。'}, 400)
        if user['id'] in self.f.busy:
            return self.s.json_response({'error': '班班正在回答上一条问题，请稍等。'}, 429)
        try:
            memory = self.history.context(user, cid)
            snapshot = self.f.snapshot(self.f.question_scope(scope or memory['scope'], message, user), user)
            if memory['id'] is None:
                memory = self.history.create(user)
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 400)
        except PermissionError:
            return self.s.json_response({'error': '没有查看该班级的权限。'}, 403)
        self.f.busy.add(user['id'])
        response = web.StreamResponse(headers={**self.s.SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8',
                                              'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})
        job = None
        try:
            await response.prepare(request)
            async def emit(event):
                await response.write((json.dumps(event, ensure_ascii=False) + '\n').encode('utf-8'))
            job = asyncio.create_task(self.run(request, user, message.strip(), snapshot, memory, self.f.config(user), emit, page))
            self.jobs[user['id']] = job
            async with asyncio.timeout(95):
                ticks = 0
                while not job.done():
                    await asyncio.wait({job}, timeout=.3)
                    if request.transport is None or request.transport.is_closing():
                        raise ConnectionResetError()
                    ticks += 1
                    if ticks % 30 == 0:
                        await emit({'type': 'ping'})
                await job
        except asyncio.CancelledError:
            raise
        except (ConnectionError, RuntimeError):
            pass
        except (ValueError, PermissionError, ClientError, asyncio.TimeoutError) as error:
            message = str(error) if isinstance(error, (ValueError, PermissionError)) else '连接较慢或已中断，可以重试这次问题。'
            with suppress(ConnectionError, RuntimeError):
                await response.write((json.dumps({'type': 'error', 'error': message}, ensure_ascii=False) + '\n').encode('utf-8'))
        finally:
            if job and not job.done():
                job.cancel()
            if job:
                await asyncio.gather(job, return_exceptions=True)
            if job is None or self.jobs.get(user['id']) is job:
                self.jobs.pop(user['id'], None)
                self.f.busy.discard(user['id'])
        with suppress(ConnectionError, RuntimeError):
            await response.write_eof()
        return response

    async def test_connection(self, request):
        user = self.s.require_admin(request) if request.query.get('target') == 'school' else self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        cfg = self.f.config() if request.query.get('target') == 'school' else self.f.config(user)
        if not cfg['apiKey']:
            return self.s.json_response({'error': '请先保存 API Key。'}, 400)
        if user['id'] in self.f.busy:
            return self.s.json_response({'error': '请等待当前问题完成后再测试连接。'}, 429)
        self.f.busy.add(user['id'])
        try:
            async for _ in self.provider(cfg, [{'role': 'user', 'content': '请只回复：连接成功'}], allow_tools=True):
                pass
            return self.s.json_response({'ok': True})
        except (ClientError, asyncio.TimeoutError):
            return self.s.json_response({'error': '连接较慢，请稍后再试。'}, 504)
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 502)
        finally:
            self.f.busy.discard(user['id'])
