(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function render(card) {
    if (!card || !Number.isInteger(card.cardNumber) || card.cardNumber < 1 || card.cardNumber > 157 ||
        !/^[0-9]+$/.test(card.username) || !/^[0-9]{6}$/.test(card.password) || !card.className) {
      throw new Error('纸卡信息不完整，请重新准备打印。');
    }
    return `<article class="card-sheet" aria-label="编号 ${esc(card.username)}，卡号 ${card.cardNumber}">
      <header class="card-caption">
        <div class="card-identity">
          <p><span>班级</span><strong class="card-class-name${card.className.length > 80 ? ' card-long-class' : ''}">${esc(card.className)}</strong></p>
          <p><span>编号</span><strong>${esc(card.username)}</strong></p>
          <p><span>密码</span><strong class="card-password">${esc(card.password)}</strong></p>
        </div>
        <div class="card-number"><span>卡号</span><strong>${card.cardNumber}</strong></div>
      </header>
      ${window.CardQuizCards.svg(card.cardNumber)}
      <footer class="card-instructions" aria-label="纸卡使用说明">
        <p>单选：所选字母朝上。判断：A 正确，B 错误。</p>
        <p>多选：按当前收答项，A 选，B 不选；逐项完成。</p>
        <p>举卡保持稳定、卡面平整，手指不要遮挡黑白图案。</p>
        <p>在 ICeClass 登录页选“学生”，用编号和密码登录。请妥善保管纸卡。</p>
      </footer>
    </article>`;
  }
  window.CardQuizPrintCard = {render};
})();
