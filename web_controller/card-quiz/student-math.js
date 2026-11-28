(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
  const scripts = '₀₁₂₃₄₅₆₇₈₉₊₋₍₎ₐₑₓ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾ᵐⁿ⁄';
  const baseline = '0123456789+−()aex0123456789+−()mn/';
  const normalize = text => Array.from(text, ch => scripts.includes(ch) ? baseline[scripts.indexOf(ch)] : ch).join('').replace(/[-－]/g, '−');
  const tokens = /log(?<base>[₍₎₀-₉₊₋ₐₑₓ⁄]+|_(?:\([^()\n]+\)|\{[^{}\n]+\}|[−－-]?(?:\d+(?:\/\d+)?|[a-z])))(?<space>[ \t]*)(?<argument>\([^()\n]+\)|[−－-]?\d+(?:\.\d+)?|[A-Za-z](?![A-Za-z]))?|(?<powerBase>\([−－+\d./a-z -]+\)|\d+(?:\.\d+)?|[A-Za-z])(?:\^(?<power>\([−－+\d./a-z -]+\)|\{[−－+\d./a-z -]+\}|[−－-]?\d+|[A-Za-z])|(?<sup>[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ᵐⁿ]+))|(?<fraction>\d+\/\d+)(?![\d/])/gu;

  function row(text) {
    let previous = '';
    return '<mrow>' + (text.match(/\d+(?:\.\d+)?|[A-Za-z]+|\s+|./gu) || []).map(part => {
      if (/^\s+$/.test(part)) return ' ';
      const unary = (part === '−' || part === '+') && (!previous || /[=(+−×÷]/.test(previous));
      previous = part;
      if (unary) return '<mo form="prefix" lspace="0" rspace="0">' + part + '</mo>';
      const element = /^\d/.test(part) ? 'mn' : /^[A-Za-z]/.test(part) ? 'mi' : 'mo';
      return '<' + element + '>' + escape(part) + '</' + element + '>';
    }).join('') + '</mrow>';
  }
  function script(text) {
    const value = normalize(text).replace(/^\((.*)\)$|^\{(.*)\}$/u, (_, parens, braces) => parens ?? braces);
    const fraction = /^([−+]?\d+)\/(\d+)$/.exec(value);
    return fraction ? '<mfrac displaystyle="true">' + row(fraction[1]) + row(fraction[2]) + '</mfrac>' : row(value);
  }
  function prose(text) {
    // A minus introducing a number in Chinese prose is distinct from the hyphens in dates and identifiers.
    return escape(text.replace(/[-－](?=\d)/gu, (sign, index) => /[\dA-Za-z]/.test(text.charAt(index - 1)) ? sign : '−'));
  }
  function math(value) {
    const source = String(value ?? '');
    let html = '', offset = 0;
    for (const match of source.matchAll(tokens)) {
      const {base, space, argument, powerBase, power, sup, fraction} = match.groups;
      const preceding = source.charAt(match.index - 1);
      if ((base && /[A-Za-z]/.test(preceding)) || (fraction && /[\d/]/.test(preceding))) continue;
      html += prose(source.slice(offset, match.index));
      let content;
      if (base) {
        content = '<msub><mi mathvariant="normal">log</mi>' + script(base.replace(/^_/, '')) + '</msub>';
        if (argument) content += '<mo>&#x2061;</mo>' + (argument.startsWith('(') ? '' : '<mspace width="0.16em"/>') + row(normalize(argument));
      } else if (powerBase) {
        content = '<msup>' + row(normalize(powerBase)) + script(power ?? sup) + '</msup>';
      } else {
        content = script(fraction);
      }
      html += '<math>' + content + '</math>';
      if (base && !argument) html += space;
      offset = match.index + match[0].length;
    }
    return html + prose(source.slice(offset));
  }
  window.StudentReportText = {escape, math};
})();
