"""Curated, read-only platform facts for Banban. No identities or audio leave here."""
from __future__ import annotations

from collections import Counter
import re
from types import SimpleNamespace

from reading import SHANGHAI, inside_period


CURRENT_TOPICS = {'devices', 'bindings', 'rules', 'accounts', 'help'}
PLATFORM_TOPICS = CURRENT_TOPICS | {'platform', 'sync'}
TITLES = {'platform': '平台检查', 'sync': '晨读同步', 'devices': '设备状态',
          'bindings': '班级绑定', 'rules': '运行规则', 'accounts': '账号概况', 'help': '使用指南'}
ADMIN_VIEWS = {'controls', 'classes', 'teachers'}
VIEW_LABELS = {'reading': '查看晨读', 'history': '查看回执', 'console': '班级通知',
               'classroom-voice': '查看来音', 'controls': '查看设备', 'classes': '班级管理',
               'teachers': '用户管理', 'quiet': '禁言时间', 'settings': '账号与设备'}


class BanbanPlatform:
    def __init__(self, feature):
        self.f, self.s, self.db = feature, feature.s, feature.db

    def devices(self, snapshot, admin=False):
        ids = [c['classId'] for c in snapshot['reading']['classes']]
        names = {c['classId']: c['className'] for c in snapshot['reading']['classes']}
        slots = ','.join('?' for _ in ids) or 'NULL'
        # Deliberately do not select names, computer identity, addresses, tokens or error text.
        rows = self.db.all(f'''SELECT d.id,d.class_id,d.enabled,d.last_seen_at,d.verified_at,
            t.volume,t.receiver_version,t.reported_at,t.command_id,t.command_error,
            cc.volume desired_volume,cc.command_id desired_command,cc.updated_at
            FROM devices d LEFT JOIN device_telemetry t ON t.device_id=d.id
            LEFT JOIN classroom_controls cc ON cc.class_id=d.class_id
            WHERE d.class_id IN ({slots}) AND d.deleted_at IS NULL ORDER BY d.class_id,d.created_at,d.id''', tuple(ids))
        now = snapshot['generatedAt']
        rooms = self.f.reading.rooms
        online_ids = {did for cid in ids for ws, did in rooms.sockets.get(cid, {}).items() if not ws.closed}
        result, counts, versions = [], Counter(), Counter()
        class_rows = {cid: {'className': names[cid], 'total': 0, 'enabled': 0, 'online': 0,
                            'lastContactAt': None} for cid in ids}
        for row in rows:
            enabled = bool(row['enabled'])
            online = enabled and row['id'] in online_ids
            fresh = bool(online and row['reported_at'] is not None and 0 <= now - row['reported_at'] < 120_000)
            counts.update(total=1, enabled=int(enabled), online=int(online), disabled=int(not enabled),
                          unverified=int(enabled and not row['verified_at']), staleTelemetry=int(enabled and not fresh))
            group = class_rows[row['class_id']]
            group['total'] += 1
            group['enabled'] += int(enabled)
            group['online'] += int(online)
            group['lastContactAt'] = max(group['lastContactAt'] or 0, row['last_seen_at'] or 0) or None
            if not admin:
                continue
            version = row['receiver_version'] or ''
            version = version if re.fullmatch(r'\d+(?:\.\d+){1,3}', version) else None
            versions[version or '未回报'] += 1
            control = 'not_requested'
            if row['desired_command']:
                if not fresh:
                    control = 'unconfirmed'
                elif row['command_id'] != row['desired_command'] or row['reported_at'] < row['updated_at']:
                    control = 'pending'
                elif row['command_error']:
                    control = 'failed'
                elif row['volume'] == row['desired_volume']:
                    control = 'confirmed'
                else:
                    control = 'mismatch'
            counts['controlUnconfirmed'] += int(control in {'unconfirmed', 'pending', 'failed', 'mismatch'})
            result.append({'className': names[row['class_id']], 'deviceLabel': f"设备 {group['total']}",
                           'enabled': enabled, 'online': online, 'lastContactAt': row['last_seen_at'],
                           'verified': bool(row['verified_at']), 'receiverVersion': version,
                           'reportedAt': row['reported_at'], 'telemetryFresh': fresh,
                           'lastReportedVolume': row['volume'], 'desiredVolume': row['desired_volume'],
                           'volumeResult': control})
        facts = {k: counts[k] for k in ('total', 'enabled', 'online', 'disabled')}
        facts.update(offlineEnabled=counts['enabled'] - counts['online'], classes=list(class_rows.values()),
                     basis='在线以当前连接为准；最近联系不代表持续在线，不能推断历史掉线时长。')
        if not admin:
            facts['checkPath'] = '班级通知可查看所选班级在线状态；设备版本、电脑信息与详细管理请联系超级管理员，当前账号没有设备详情页。'
        if admin:
            release = self.s.load_receiver_release(SimpleNamespace(app=self.f.app))
            latest = release[0]['version'] if release else None
            for device in result:
                parsed = self.s.parse_release_version(device['receiverVersion'])
                device['updateAvailable'] = bool(parsed < self.s.parse_release_version(latest)) if parsed and latest else None
            facts.update(unverified=counts['unverified'], staleTelemetry=counts['staleTelemetry'],
                         controlUnconfirmed=counts['controlUnconfirmed'], versions=dict(versions),
                         publishedVersion=latest, updatesAvailable=sum(d['updateAvailable'] is True for d in result),
                         devices=result[:200], deviceRowsOmitted=max(0, len(result) - 200),
                         telemetryBasis='仅在线且两分钟内回报为新鲜；音量为最近回报值，过期不能当作当前音量。控制结果须匹配本次指令。')
        return facts

    def bindings(self, snapshot, devices):
        classes = snapshot['reading']['classes']
        groups = {r['className']: r for r in devices['classes']}
        rows = [{'className': c['className'], 'enabled': bool(c['enabled']),
                 'enabledDevices': groups[c['className']]['enabled'],
                 'onlineDevices': groups[c['className']]['online']} for c in classes]
        active = [r for r in rows if r['enabled']]
        return {'totalClasses': len(rows), 'enabledClasses': len(active),
                'withoutDevice': sum(r['enabledDevices'] == 0 for r in active),
                'multipleDevices': sum(r['enabledDevices'] > 1 for r in active),
                'unverifiedDevices': devices['unverified'], 'classes': rows,
                'basis': '多设备绑定仅为核查线索，不能直接认定绑错。后台可查看电脑信息、核实、停用或重新对应班级；更名保留班级历史，重新绑定需确认实际电脑。'}

    def rules(self, snapshot, admin):
        quiet = self.s.quiet_schedule_payload(self.db)
        data = {'timezone': 'Asia/Shanghai', 'quiet': {
            'periods': [{k: p[k] for k in ('name', 'weekdays', 'startTime', 'endTime')} for p in quiet['periods']],
            'activeName': quiet['activePeriod']['name'] if quiet['activePeriod'] else None},
            'principles': [
                '晨读仅累计学校统计时段内的记录；有效发声按声量达标秒数累计，达标占比为有效发声除以运行时长。',
                '同一班级同一秒合并，重复补传不重复累计；各活动的完成数量分开计算，不跨模式硬比较。',
                '弱网时客户端保留记录，联网补传后按记录发生时的规则计算；待同步、待核实与缺少记录不能解释为没有晨读。',
                '禁言时段影响远程通知发送，与晨读统计时段是独立设置；白板显示回执不能证明师生已阅读。',
                '晨读数据只能反映软件记录，不能据此判断教学质量。来音仅使用数量和时长，不读取音频内容。']}
        if admin:
            cfg = self.f.reading.config()
            data['reading'] = {'enabled': cfg['enabled'], 'reminderEnabled': cfg.get('reminderEnabled', True),
                               'threshold': cfg['threshold'], 'periods': cfg['periods'],
                               'thresholdUnit': '应用归一化声量 0–100，不是声学分贝 dB',
                               'settingsPath': '早读统计 → 全校统计规则',
                               'inPeriod': inside_period(snapshot['generatedAt'], cfg)}
        return data

    def guides(self, admin):
        rows = [
            ('reading', '晨读与比较', '选择日期、年级或班级查看横向排行，点击班级进入日历，可导出 XLSX；同步未确认时先核对完整性。'),
            ('console', '发送班级通知', '在班级通知选择已授权班级，检查内容后手动发送；班班可以分析回执，不代为发送。'),
            ('history', '核对通知回执', '历史记录查看发送与白板显示状态；显示回执不等于已经阅读。'),
            ('classroom-voice', '查看教室来音', '在教室来音页面由您手动查看；班班只分析累计数量、时长，更早数据可能不完整。'),
            ('quiet', '通知禁言时间', '禁言时间页面查看禁言时段；超级管理员维护规则。'),
            ('settings', '个人账号与教室客户端', '网页“账号与设备”查看当前账号并修改自己的密码，超级管理员还可管理绑定电脑；网页没有客户端下载或检查更新按钮。安装包由管理员通过现有分发渠道提供，检查更新在教室电脑的 EXE 托盘菜单或客户端设置中完成，安装绑定也在教室电脑操作。')]
        if admin:
            rows += [('controls', '检查教室设备', '教室控制核对在线、最近联系、电脑信息、版本和音量回报；调整与停用由您确认执行。'),
                     ('classes', '班级换届与绑定', '班级管理可更名、重新对应班级；先核对实际电脑，多个设备不一定是绑错；更名保留原班级历史。'),
                     ('teachers', '管理平台账号', '用户管理可创建、停用或删除账号并分配班级；教师的班班分析限分配班级，主任、校长和超级管理员可做全校只读分析；其他页面操作权限不随之扩大。'),
                     ('reading', '修改统计规则', '早读统计页的全校统计规则由超级管理员维护星期、起止时间、提醒与声量门槛；本地活动参数在陪伴内设置。')]
        return [{'view': view, 'title': title, 'text': text} for view, title, text in rows]

    def read(self, snapshot, topic, user):
        admin = user['role'] == 'superadmin'
        if topic in {'bindings', 'accounts'} and not admin:
            raise PermissionError('此项仅超级管理员可查看。')
        card = {'topic': topic, 'title': TITLES[topic], 'scope': snapshot['scope'],
                'generatedAt': snapshot['generatedAt'], 'previousScope': None, 'metrics': [],
                'temporal': 'current' if topic in CURRENT_TOPICS else 'mixed' if topic in {'platform', 'sync'} else 'period',
                'actions': [], 'findings': [], 'details': [], 'note': ''}
        def metrics(*items):
            card['metrics'] = [dict(label=label, value=value, unit=unit) for label, value, unit in items]
        def action(view):
            if view not in ADMIN_VIEWS or admin:
                item = {'view': view, 'label': VIEW_LABELS[view]}
                if topic == 'rules' and view == 'reading' and admin:
                    item['anchor'] = 'rules'
                if item not in card['actions']:
                    card['actions'].append(item)
        def finding(title, text, view, count=None):
            card['findings'].append({'title': title, 'text': text, 'view': view if view not in ADMIN_VIEWS or admin else 'console', 'count': count})
        r, n, v = (snapshot[k] for k in ('reading', 'notifications', 'voice'))
        if topic in {'devices', 'bindings', 'platform'}:
            devices = self.devices(snapshot, admin)
        if topic == 'devices':
            data = devices
            metrics(('已绑定', data['total'], 'devices'), ('在线', data['online'], 'devices'), ('启用但离线', data['offlineEnabled'], 'devices'))
            for c in sorted(data['classes'], key=lambda c: (-int(c['enabled'] > c['online']), c['className']))[:6]:
                finding(c['className'], f"{c['online']} 台在线 / {c['enabled']} 台启用", 'controls')
            card['note'] = data['basis']
            if admin:
                card['details'] = [f"{d['className']} · {d['deviceLabel']} · {'在线' if d['online'] else '离线' if d['enabled'] else '停用'} · 版本 {d['receiverVersion'] or '未回报'} · 最近回报音量 {d['lastReportedVolume'] if d['lastReportedVolume'] is not None else '未知'}{'（回报已过期）' if not d['telemetryFresh'] else ''}"
                                   for d in data['devices'][:12]] + [data['telemetryBasis']]
            action('controls')
        elif topic == 'bindings':
            data = self.bindings(snapshot, devices)
            metrics(('未绑定设备', data['withoutDevice'], 'classes'), ('多设备班级', data['multipleDevices'], 'classes'), ('未核实设备', data['unverifiedDevices'], 'devices'))
            for c in data['classes']:
                if c['enabled'] and c['enabledDevices'] != 1:
                    finding(c['className'], f"{c['enabledDevices']} 台启用设备，需核对实际电脑", 'classes')
            card['note'] = data['basis']
            action('classes'); action('controls')
        elif topic == 'rules':
            data = self.rules(snapshot, admin)
            card['scopeLabel'] = '当前全校规则 · 北京时间'
            if admin:
                cfg = data['reading']
                finding('晨读统计', '已启用' if cfg['enabled'] else '未启用', 'reading')
                for period in cfg['periods']:
                    clock = lambda m: f'{m // 60:02d}:{m % 60:02d}'
                    finding('统计时段', '周' + '、'.join(str(d) for d in period['weekdays']) + f" · {clock(period['start'])}–{clock(period['end'])}", 'reading')
                card['details'] += [f"声量门槛 {cfg['threshold']}；到点提醒{'已启用' if cfg['reminderEnabled'] else '未启用'}。"]
            finding('当前禁言', data['quiet']['activeName'] or '不在禁言时段', 'quiet')
            card['details'] += data['principles']
            card['details'] += [f"{p['name']} · 周{'、'.join(str(d) for d in p['weekdays'])} · {p['startTime']}–{p['endTime']}" for p in data['quiet']['periods']]
            action('reading'); action('quiet')
        elif topic == 'accounts':
            roles = self.db.all('''SELECT role,enabled,COUNT(*) amount FROM users WHERE deleted_at IS NULL GROUP BY role,enabled''')
            data = {'total': sum(c['amount'] for c in roles), 'enabled': sum(c['amount'] for c in roles if c['enabled']),
                    'roles': [dict(role=c['role'], enabled=bool(c['enabled']), count=c['amount']) for c in roles],
                    'basis': '当前全校账号汇总，不含姓名、账号、密码、会话和已删除账号。'}
            metrics(('平台账号', data['total'], 'accounts'), ('已启用', data['enabled'], 'accounts'), ('已停用', data['total'] - data['enabled'], 'accounts'))
            card['scopeLabel'] = '当前全校账号'
            labels = {'teacher': '教师', 'director': '主任', 'principal': '校长', 'superadmin': '超级管理员'}
            card['details'] = [f"{labels.get(c['role'], '其他')} · {'启用' if c['enabled'] else '停用'} {c['amount']} 个" for c in roles]
            action('teachers')
        elif topic == 'help':
            data = {'guides': self.guides(admin), 'readOnly': True}
            if user['role'] == 'director':
                data['scopeNote'] = '主任可在班班内做全校只读分析；其他页面仍按原分配班级开放，不会因此扩大通知发送或管理权限。'
                card['details'].append(data['scopeNote'])
            card['scopeLabel'] = '与您当前权限对应的操作指南'
            for guide in data['guides']:
                finding(guide['title'], guide['text'], guide['view'])
            card['note'] = '班班负责分析和引导；发送、修改、删除操作在对应页面由您确认。'
        elif topic == 'sync':
            classes = [{'className': c['className'], 'state': c['sync']['state']} for c in r['classes']]
            counts = Counter(c['state'] for c in classes)
            data = {'classes': classes, 'states': dict(counts), 'unconfirmedClasses': r['pendingClasses'],
                    'basis': '同步状态是当前设备回报，晨读记录按选定日期；未确认不等于该时段没有记录，历史日期也不能保证设备已无待传记录。'}
            metrics(('已同步', counts['current'], 'classes'), ('待补传', counts['pending'], 'classes'), ('待核实', counts['review'], 'classes'))
            finding('待确认同步', f"{counts['unconfirmed']} 个班尚无近期完整同步确认", 'reading', counts['unconfirmed'])
            labels = {'current': '已同步', 'pending': '待补传', 'review': '待核实', 'unconfirmed': '待确认'}
            card['details'] = [f"{c['className']} · {labels[c['state']]}" for c in classes if c['state'] != 'current'][:60]
            card['note'] = data['basis']; action('reading')
        elif topic == 'platform':
            data = {'reading': {k: r[k] for k in ('activeSeconds', 'effectiveSeconds', 'sessions', 'usedClasses', 'pendingClasses')},
                    'notifications': {k: n[k] for k in ('total', 'displayed', 'failed', 'rows')},
                    'voice': {k: v[k] for k in ('total', 'durationMs', 'trackingStartedAt')}, 'devices': devices,
                    'correlations': [{'className': c['className'], 'activeSeconds': c['activeSeconds'], 'syncState': c['sync']['state'],
                                      'onlineDevices': next(d['online'] for d in devices['classes'] if d['className'] == c['className'])} for c in r['classes']],
                    'basis': '晨读、通知与来音按选定日期；设备与同步为当前状态。仅能指出同时出现的记录，不能认定网络或教学原因。'}
            metrics(('晨读使用', r['usedClasses'], 'classes'), ('白板已显示', n['displayed'], 'items'), ('当前在线', devices['online'], 'devices'))
            finding('晨读同步', f"{r['pendingClasses']} 个班待确认完整性", 'reading', r['pendingClasses'])
            finding('通知回执', f"{n['failed']} 条失败或离线，显示回执不等于已阅读", 'history', n['failed'])
            finding('设备连接', f"{devices['offlineEnabled']} 台启用设备当前离线", 'controls', devices['offlineEnabled'])
            finding('教室来音', f"累计 {v['total']} 条，只统计数量与时长", 'classroom-voice')
            if admin:
                data['bindings'] = self.bindings(snapshot, devices)
                b = data['bindings']
                finding('班级绑定', f"{b['withoutDevice']} 个班未绑定；{b['multipleDevices']} 个班有多台设备", 'classes', b['withoutDevice'] + b['multipleDevices'])
            card['note'] = data['basis']; action('reading'); action('history')
        else:
            raise ValueError('不支持的查询主题。')
        card['findingsOmitted'] = max(0, len(card['findings']) - 20)
        card['findings'] = card['findings'][:20]
        card['attention'] = (any((f.get('count') or 0) > 0 for f in card['findings'])
                             or topic == 'devices' and (devices['offlineEnabled'] > 0 or devices.get('controlUnconfirmed', 0) > 0)
                             or topic == 'bindings' and data['unverifiedDevices'] > 0)
        # IDs remain only in the local card's scope for existing page navigation.
        safe_scope = {k: v for k, v in snapshot['scope'].items() if k != 'classId'}
        return {'current': {'generatedAt': snapshot['generatedAt'], 'scope': safe_scope, topic: data}}, card

    @staticmethod
    def overview(card):
        findings = card['findings']
        if card['topic'] == 'platform':
            findings = sorted(findings, key=lambda f: -(f.get('count') or 0))
        parts = [f"{c['title']}：{c['text'].rstrip('。')}。" for c in findings[:2]]
        if not parts and card['metrics']:
            parts = ['；'.join(f"{m['label']} {m['value']}" for m in card['metrics']) + '。']
        if card['note']:
            parts.append(card['note'])
        return ''.join(parts) or '展开“查看依据”，可查看对应的操作方法。'
