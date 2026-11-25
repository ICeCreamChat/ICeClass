(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./cards.js'), require('./qr-code.js'));
  else root.CardQuizPrintCard = factory(root.CardQuizCards, root.CardQuizQr);
})(globalThis, function (cards, qr) {
  'use strict';

  const studentAddress = 'iceclass.icecreamchat.top/student';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let portalImage;

  function portal(numberCard) {
    const url = 'https://' + studentAddress;
    portalImage ||= 'data:image/svg+xml,' + encodeURIComponent(qr.svg(url));
    return `<a class="card-portal" target="_blank" rel="noopener" href="${url}">
      <span class="card-portal-copy"><strong>扫码查看我的AI课后报告</strong>
        <span>${numberCard ? '查看本卡最近一节课堂的作答和知识点' : '查看本人的作答、错题和知识点'}</span>
        <span class="card-url">${studentAddress}</span>
        <span>备案号　皖ICP备2025106471号</span></span>
      <img width="119" height="119" src="${esc(portalImage)}" alt="学生入口二维码"></a>`;
  }

  function sheet(number, className, credentials, label, numberCard = false) {
    return `<article class="card-sheet" aria-label="${esc(label)}">
      <div class="card-login">${credentials}${portal(numberCard)}</div>
      <header class="card-caption">
        <strong class="card-brand">ICeClass <span>班班课堂</span></strong>
        <span class="card-class${className.length > 35 ? ' card-long-class' : ''}">${esc(className)}</span>
        <div class="card-number"><span>卡号</span><strong>${String(number).padStart(2, '0')}</strong></div>
      </header>
      ${cards.svg(number)}
      <footer class="card-instructions" aria-label="纸卡使用说明">
        <div class="card-guide">
          <div><strong>图案朝镜头，捏白边举稳</strong>
            <p><b>单选</b> 所选字母朝上　　<b>判断</b> A 对，B 错</p>
            <p><b>多选</b> 只在选中项举 A，改为不选举 B</p>
            <p class="card-note">整题未举记弃权，免答另计。</p></div>
          <div class="card-report"><strong>教师查看本班课后数据</strong>
            <p>ICeClass 教师端 · 纸卡答题 · 课堂报告</p>
            <p>微信小程序「班伴班班」可逐题查看全班作答</p>
            <p class="card-note">管局备案中，上线后开放</p></div>
        </div>
        <div class="card-rights"><p><b>本纸卡版式著作权归许斌所有。</b> 获授权学校的师生可为本班教学打印、补印。</p>
          <p>未经书面许可，不得销售或公开分发本纸卡版式。侵权必究。</p></div>
      </footer></article>`;
  }

  function render(card) {
    if (!card || !Number.isInteger(card.cardNumber) || card.cardNumber < 1 || card.cardNumber > cards.capacity ||
        !/^[0-9]+$/.test(card.username) || !/^[0-9]{6}$/.test(card.password) || !card.className) {
      throw new Error('纸卡信息不完整，请重新准备打印。');
    }
    if (card.numberCard && !new RegExp(`^[0-9]{2}1[0-9]{3}${String(card.cardNumber).padStart(2, '0')}$`).test(card.username)) {
      throw new Error('通用卡登录编号与当前卡号不符，请重新核对发放编号。');
    }
    const credentials = `<div class="card-account"><div class="card-credentials">
      <div>学生编号<strong>${esc(card.username)}</strong></div>
      <div>登录密码<strong class="card-password">${esc(card.password)}</strong></div></div>
      <div class="card-fold"><img src="icons/card-fold.png" alt="" width="53" height="40">沿虚线向后折，举卡时遮住密码</div></div>`;
    return sheet(card.cardNumber, card.className + (card.numberCard ? ' · 按号发卡' : ''), credentials, '编号 ' + card.username + '，卡号 ' + card.cardNumber, card.numberCard);
  }

  function renderPublic(number) {
    return sheet(number, '通用纸卡', '', '通用纸卡 ' + number);
  }
  return {render, renderPublic};
});
