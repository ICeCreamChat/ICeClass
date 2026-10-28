"""Sentence events for committed voice answers; never consumes tool-round drafts."""
import re
import unicodedata

from banban_math_speech import math_spans, spoken_math


VOICE_RULES = '''本轮为语音对话，像一位熟悉校园工作的助理与用户自然交谈。
先直接回答或报告实际结果，默认一至两句，大多数回复不超过80字；用户明确要求详细讲解时再展开。
简单计算先报答案，不逐项复述用户给的数值；公式默认只讲一种，其他写法等用户追问时再补充。
普通知识、数学和日常交流直接回答，不为这类问题查询校园数据，不主动提起旧操作或问用户是否继续旧任务。
用户的“再简单点”“刚才那个”等追问结合当前对话理解；说错后更正时以本次明确要求为准。
语音转写可能出现同音、近音、应用缩写或多余字母。结合当前对话、用户目标以及inspect返回的真实应用和窗口进行容错理解：例如“熄火白板”可对应已安装的“希沃白板”，“WPSX”在做PPT的上下文中可对应“WPS 演示”。不要求用户准确说出应用全名，也不反复解释转写错误。
只有上下文与实际候选指向唯一合理目标时才采用该理解；多个合理候选或关键内容缺失时，只问一个简短具体的问题。模糊理解不能扩大授权，不猜班级、设备、收件人、文件路径、数量、否定词和待写入的原文；关闭、删除、覆盖等操作的目标有歧义时先确认。
不重复用户的问题，不复述计划、工具过程、核验步骤和卡片参数；成功时一句话，失败或结果待确认时说清实际状态。
不在每个回答末尾追加问题、建议或能力介绍；只有缺少执行所必需的信息时，问一个具体问题。
用自然口语和正常标点，不说“首先、其次、综上所述”，不朗读Markdown、编号或LaTeX；公式优先用一句能听懂的话解释。
用户明确说出的执行要求已包含本次操作授权，按要求直接调用工具并连续办完，不再询问“要执行吗”或要求点击、口述“确认执行”。不代替用户补出未说过的任务；必要目标、内容或密码缺失时才询问所缺信息。仍按当前权限、允许的应用和新鲜界面执行，不猜选未保存提示。只有真实回执确认后才能说已完成。'''


def social_reply(message):
    """Exact social utterances only; never consume an instruction after a greeting."""
    value = re.sub(r'[\W_]', '', message, flags=re.UNICODE).lower().replace('您', '你')
    if value.startswith('班班'):
        value = value[2:]
    if value.endswith('班班'):
        value = value[:-2]
    if re.fullmatch(r'(?:你好|嗨|哈喽|hello|hi|你在吗|在吗)(?:呀|啊|啦|哦)?', value):
        return '我在。'
    if re.fullmatch(r'(?:谢谢|谢谢你|多谢|辛苦了)(?:呀|啊|啦|哦)?', value):
        return '不客气。'
    for greeting in ('早安', '早上好', '中午好', '下午好', '晚上好', '晚安'):
        if re.fullmatch(greeting + r'(?:呀|啊|啦|哦)?', value):
            return greeting + '。'
    return None


def quick_computer_action(message, observed):
    """Match a complete one-step command against this turn's unique targets."""
    def normal(value):
        return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value)).casefold()

    def unique(items):
        return items[0] if len(items) == 1 else None

    applications = [item for item in observed.get('applications', []) if isinstance(item, dict) and item.get('id')]
    windows = [item for item in observed.get('windows', []) if isinstance(item, dict) and item.get('id') and not item.get('isPopup')]
    aliases = {'ppt': {'powerpoint', 'wps-presentation'}, 'wps': {'wps-writer', 'wps-presentation', 'wps-sheet'},
               '希沃': {'seewo'}}

    def apps_named(name):
        exact = [app for app in applications if normal(app.get('name', '')) == name]
        return exact or [app for app in applications if app.get('kind') in aliases.get(name, set())]

    value = re.sub(r'^(?:请帮我|帮我|请)', '', normal(message).rstrip('。.!！'))
    opened = re.fullmatch(r'打开(.+)', value)
    if opened:
        app = unique(apps_named(opened[1]))
        return {'action': 'open_app', 'appId': app['id']} if app else None

    presentation = {'下一页': 'presentation_next', '上一页': 'presentation_previous',
                    '开始放映': 'presentation_start', '开始ppt放映': 'presentation_start',
                    '退出放映': 'presentation_end', '结束放映': 'presentation_end',
                    '退出ppt放映': 'presentation_end', '退出ppt全屏': 'presentation_end',
                    '结束ppt放映': 'presentation_end'}
    if value in presentation:
        candidates = [w for w in windows if w.get('kind') in {'powerpoint', 'wps-presentation'}
                      and w.get('presentationMode') == 'slideshow']
        if not candidates and presentation[value] == 'presentation_start':
            candidates = [w for w in windows if w.get('kind') in {'powerpoint', 'wps-presentation'}
                          and w.get('presentationMode') == 'editor']
        target = unique(candidates)
        return {'action': presentation[value], 'targetId': target['id']} if target else None

    suffix = re.fullmatch(r'把(.+?)(最大化|最小化|还原|全屏)', value)
    prefix = re.fullmatch(r'(最大化|最小化|还原|切到|切换到|关闭|关掉)(.+)', value)
    if suffix:
        name, verb = suffix.groups()
    elif prefix:
        verb, name = prefix.groups()
    else:
        return None
    if name in {'当前窗口', '这个窗口', '当前软件', '这个软件'}:
        candidates = [w for w in windows if w.get('foreground') is True]
    else:
        candidates = [w for w in windows if normal(w.get('title', '')) == name]
        if not candidates:
            app_ids = {app['id'] for app in apps_named(name)}
            candidates = [w for w in windows if w.get('appId') in app_ids or normal(w.get('application', '')) == name]
    target = unique(candidates)
    if not target:
        return None
    action = {'最大化': 'maximize_window', '全屏': 'maximize_window', '最小化': 'minimize_window',
              '还原': 'restore_window', '切到': 'focus_window', '切换到': 'focus_window',
              '关闭': 'close_window', '关掉': 'close_window'}[verb]
    return {'action': action, 'targetId': target['id']}


def quick_computer_reply(action, result):
    """Only called after the existing operation flow verifies execution."""
    if action == 'open_app':
        return '应用已打开并最大化。' if result.get('maximized') is True and result.get('foreground') is True else '应用已打开。'
    return {'focus_window': '已切到应用。', 'maximize_window': '窗口已最大化。',
            'minimize_window': '窗口已最小化。', 'restore_window': '窗口已还原。', 'close_window': '窗口已关闭。',
            'presentation_start': '已开始放映。', 'presentation_end': '已退出放映。',
            'presentation_next': '已翻到下一页。', 'presentation_previous': '已翻到上一页。'}[action]


class SpokenAnswer:
    def __init__(self, turn_id):
        self.turn_id = turn_id
        self.sequence = 0
        self.pending = ''
        self.characters = 0
        self.ended = False

    @staticmethod
    def clean(text):
        text = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', text)
        text = re.sub(r'https?://\S+', '网址请看文字', text)
        text = re.sub(r'^\s*(?:[-*#>]+|\d+[.、])\s+', '', text, flags=re.M)
        text = re.sub(r'(\*\*|__)([^\n]+?)\1', r'\2', text)
        text = re.sub(r'(?<![\w*])\*([^*\n]+)\*(?!\w)', r'\1', text)
        text = spoken_math(text)
        text = re.sub(r'[`*_]', '', text)
        return re.sub(r'\s+', ' ', text).strip()

    def feed(self, text='', final=False):
        if self.ended:
            return []
        self.pending += text
        events = []
        while self.pending:
            # Keep unfinished code blocks out of speech, including across deltas.
            self.pending = re.sub(r'```[\s\S]*?```', '', self.pending)
            fence = self.pending.find('```')
            available = self.pending if fence < 0 else self.pending[:fence]
            spans = math_spans(available)
            masked = list(available)
            for start, stop, _, _ in spans:
                masked[start:stop] = ' ' * (stop - start)
            boundary = re.search(r'[。！？!?；;\n]', ''.join(masked))
            end = boundary.end() if boundary else 0
            if not end and len(available) >= 100:
                comma = max(available.rfind('，', 20, 100), available.rfind(',', 20, 100))
                end = comma + 1 if comma >= 0 else 100
                for start, stop, _, complete in spans:
                    if start < end < stop:
                        end = start or (stop if complete else 0)
                        break
                if not end and not final:
                    break
            if not end:
                if not final:
                    break
                end = len(available)
                if not end:
                    self.pending = ''
                    break
            sentence, self.pending = self.pending[:end], self.pending[end:]
            sentence = self.clean(sentence)
            if sentence and self.characters < 2500:
                sentence = sentence[:2500 - self.characters]
                events.append({'type': 'speech', 'turnId': self.turn_id, 'sequence': self.sequence,
                               'text': sentence, 'end': False})
                self.sequence += 1
                self.characters += len(sentence)
        if final:
            self.ended = True
            events.append({'type': 'speech', 'turnId': self.turn_id, 'sequence': self.sequence, 'text': '', 'end': True})
        return events
