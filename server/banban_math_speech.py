"""Read common algebra in Chinese without changing the displayed answer.

This is a notation reader, not a calculator or a general TeX interpreter.
Unsupported explicit math is announced instead of guessing its meaning.
"""
import re


_LETTERS = dict(zip('abcdefghijklmnopqrstuvwxyz', (
    '诶', '比', '西', '迪', '伊', '艾弗', '吉', '艾尺', '艾', '杰', '开', '艾尔', '艾姆',
    '恩', '欧', '屁', '丘', '阿尔', '艾斯', '提', '优', '维', '达布流', '艾克斯', '歪', '泽德')))
_GREEK = {'α': '阿尔法', 'β': '贝塔', 'γ': '伽马', 'θ': '西塔', 'π': '派', 'Δ': '德尔塔'}
_SUB = dict(zip('₀₁₂₃₄₅₆₇₈₉₊₋ₙᵢₖₘₓ', '0123456789+-nikmx'))
_SUPER = dict(zip('⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿ', '0123456789+-n'))
_SYMBOLS = str.maketrans({'−': '-', '–': '-', '×': '*', '·': '*', '÷': '/', '≤': '<=', '≥': '>=', '≠': '!=', '√': r'\sqrt'})
_COMMANDS = {'times': '*', 'cdot': '*', 'div': '/', 'le': '<=', 'leq': '<=', 'ge': '>=', 'geq': '>=',
             'ne': '!=', 'neq': '!=', 'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'theta': 'θ', 'pi': 'π', 'Delta': 'Δ'}
_RELATIONS = {'=': '等于', '<': '小于', '>': '大于', '<=': '小于等于', '>=': '大于等于', '!=': '不等于'}
_DIGITS = dict(zip('0123456789', '零一二三四五六七八九'))
_TOKEN = re.compile(r'\s*(\\[A-Za-z]+|[A-Za-z]+|\d+(?:\.\d+)?|<=|>=|!=|[αβγθπΔ+*/^_=<>(){}\[\]-])')
_DELIMITED = re.compile(r'\$\$(?P<display>[\s\S]*?)(?:\$\$|\Z)|\$(?P<inline>[^$]*)(?:\$|\Z)|'
                        r'\\\((?P<paren>[\s\S]*?)(?:\\\)|\Z)|\\\[(?P<bracket>[\s\S]*?)(?:\\\]|\Z)')
_ATOM = r'(?:\\[A-Za-z]+|[A-Za-z](?![A-Za-z])|\d+(?:\.\d+)?|[αβγθπΔ])'
_CANDIDATE = re.compile(r'(?<![A-Za-z0-9/\\._])(?:' + _ATOM + r'|[\s+*/^_=<>!(){}\[\]−–×·÷≤≥≠√₀-₉₊₋ₙᵢₖₘₓ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿ-])+')


class _Reader:
    def __init__(self, text):
        for alphabet, marker in ((_SUB, '_'), (_SUPER, '^')):
            text = re.sub('[' + ''.join(alphabet) + ']+',
                          lambda m: marker + '{' + ''.join(alphabet[c] for c in m[0]) + '}', text)
        text = text.translate(_SYMBOLS)
        text = re.sub(r'\\(?:left|right)\b|\\[,;! ]', ' ', text)
        text = re.sub(r'\\([A-Za-z]+)', lambda m: _COMMANDS.get(m[1], m[0]), text)
        self.tokens, position = [], 0
        if len(text) > 600:
            raise ValueError('formula too long')
        while position < len(text.rstrip()):
            match = _TOKEN.match(text, position)
            if not match:
                raise ValueError('unsupported notation')
            self.tokens.append(match[1])
            position = match.end()
        if len(self.tokens) > 160:
            raise ValueError('formula too long')
        self.position = self.depth = 0

    def peek(self):
        return self.tokens[self.position] if self.position < len(self.tokens) else ''

    def take(self):
        token = self.peek()
        if not token:
            raise ValueError('incomplete formula')
        self.position += 1
        return token

    def atom(self):
        self.depth += 1
        if self.depth > 12:
            raise ValueError('formula nesting too deep')
        try:
            token = self.take()
            if token in {'(', '[', '{'}:
                value = self.expression()
                if self.take() != {'(': ')', '[': ']', '{': '}'}[token]:
                    raise ValueError('unbalanced formula')
                return value
            if token in {r'\frac', r'\dfrac', r'\tfrac'}:
                return ('/', self.atom(), self.atom())
            if token == r'\sqrt':
                if self.peek() not in {'(', '{'}:
                    raise ValueError('root needs an explicit radicand')
                return ('root', self.atom())
            if re.fullmatch(r'\d+(?:\.\d+)?', token):
                return ('number', token)
            if len(token) == 1 and (token.lower() in _LETTERS or token in _GREEK):
                value = ('letter', token)
                if token in {'f', 'g', 'h'} and self.peek() == '(':
                    return ('function', value, self.atom())
                return value
            raise ValueError('unsupported notation')
        finally:
            self.depth -= 1

    def factor(self):
        if self.peek() in {'+', '-'}:
            sign = self.take()
            return ('negative', self.factor()) if sign == '-' else self.factor()
        value, scripts = self.atom(), {}
        while self.peek() in {'_', '^'}:
            marker = self.take()
            if marker in scripts:
                raise ValueError('ambiguous repeated script')
            if self.peek() in {'+', '-'}:
                sign = self.take()
                scripts[marker] = ('negative', self.atom()) if sign == '-' else self.atom()
            else:
                scripts[marker] = self.atom()
        if '_' in scripts:
            value = ('index', value, scripts['_'])
        if '^' in scripts:
            value = ('power', value, scripts['^'])
        return value

    def expression(self, minimum=0):
        left = self.factor()
        while self.peek():
            token = self.peek()
            if token in {')', ']', '}'}:
                break
            implicit = token not in {*_RELATIONS, '+', '-', '*', '/'}
            operator = '*' if implicit else token
            priority = 5 if operator in _RELATIONS else 10 if operator in {'+', '-'} else 20
            if priority < minimum:
                break
            if not implicit:
                self.take()
            left = (operator, left, self.expression(priority + 1))
        return left

    def read(self):
        value = self.expression()
        if self.peek():
            raise ValueError('unbalanced formula')
        return _read(value)


def _group(value):
    if value[0] in {'+', '-'}:
        return _group(value[1]) + '与' + _group(value[2]) + ('的和' if value[0] == '+' else '的差')
    if value[0] in {'*', '/', *_RELATIONS}:
        return '括号' + _read(value) + '括号结束'
    return _read(value)


def _read(value):
    operator, *args = value
    if operator == 'number':
        return _DIGITS.get(args[0], args[0])
    if operator == 'letter':
        return _GREEK.get(args[0], _LETTERS.get(args[0].lower(), args[0]))
    if operator == 'negative':
        return '负' + _group(args[0])
    if operator == 'index':
        index = _read(args[1])
        if args[1][0] not in {'letter', 'number'}:
            index = '括号' + index + '括号结束'
        return _read(args[0]) + '下标' + index
    if operator == 'power':
        power = '平方' if args[1] == ('number', '2') else '立方' if args[1] == ('number', '3') else None
        if power is None:
            exponent = _read(args[1])
            if args[1][0] not in {'letter', 'number', 'negative'}:
                exponent = '括号' + exponent + '括号结束'
            power = exponent + '次方'
        base = '括号' + _read(args[0]) + '括号结束' if args[0][0] == 'negative' else _group(args[0])
        return base + '的' + power
    if operator == 'root':
        return _group(args[0]) + '的平方根'
    if operator == 'function':
        return _read(args[0]) + '括号' + _read(args[1]) + '括号结束'
    left, right = args
    if operator in _RELATIONS:
        return _read(left) + _RELATIONS[operator] + _read(right)
    if operator in {'+', '-'}:
        return _read(left) + ('加' if operator == '+' else '减') + (_group(right) if right[0] in {'+', '-'} else _read(right))
    if operator == '*':
        return (_group(left) if left[0] in {'+', '-'} else _read(left)) + '乘以' + (_group(right) if right[0] in {'+', '-'} else _read(right))
    if operator == '/':
        return (_group(left) if left[0] in {'+', '-'} else _read(left)) + ('，再除以' if left[0] in {'*', '/'} else '除以') + _group(right)
    raise ValueError('unsupported notation')


def _plain_spans(text, offset=0):
    for match in _CANDIDATE.finditer(text):
        formula = match[0].strip()
        # Do not reinterpret dates, file paths, English words or numeric ranges.
        cue = re.search(r'[=<>+*^_≤≥≠√₀-₉ₙᵢₖₘₓ⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ]|\\(?:frac|dfrac|tfrac|sqrt|leq?|geq?|neq?)', formula)
        cue = cue or (re.search(r'[A-Za-zαβγθπΔ]', formula) and re.search(r'[/×·÷−-]', formula))
        if formula and cue and re.search(_ATOM, formula):
            leading = len(match[0]) - len(match[0].lstrip())
            yield offset + match.start() + leading, offset + match.end() - (len(match[0]) - len(match[0].rstrip())), formula, True


def math_spans(text):
    """Ranges protected from sentence/length splitting, including open TeX."""
    result, position = [], 0
    for match in _DELIMITED.finditer(text):
        result.extend(_plain_spans(text[position:match.start()], position))
        body = next(value for value in match.groupdict().values() if value is not None)
        opening = match[0][:2] if match[0].startswith(('$$', '\\')) else '$'
        closing = {'$$': '$$', '$': '$', r'\(': r'\)', r'\[': r'\]'}[opening]
        complete = len(match[0]) >= len(opening) + len(closing) and match[0].endswith(closing)
        result.append((match.start(), match.end(), body, complete))
        position = match.end()
    result.extend(_plain_spans(text[position:], position))
    return result


def spoken_math(text):
    parts, position = [], 0
    spans = math_spans(text)
    for start, end, formula, complete in spans:
        parts.append(text[position:start])
        try:
            reading = _Reader(formula).read() if complete else None
        except (ValueError, RecursionError):
            reading = None
        parts.append(reading or '这部分公式请看屏幕')
        position = end
    parts.append(text[position:])
    text = ''.join(parts)
    if spans:
        text = re.sub(r'(?<![A-Za-z0-9./\\_:])([A-Za-z])(?![A-Za-z0-9./\\_:])',
                      lambda m: _LETTERS[m[1].lower()], text)
    text = re.sub(r'([前第])\s*[nN]\s*(?=项)', r'\1恩', text)
    text = re.sub(r'(等于|乘以|除以)\s*([A-Za-z])(?![A-Za-z])\s*',
                  lambda m: m[1] + _LETTERS[m[2].lower()], text)
    return re.sub(r'(?<![A-Za-z])([A-Za-z])\s*(?=乘以|除以|的平方|的立方)',
                  lambda m: _LETTERS[m[1].lower()], text)
