'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const cards = require('../web_controller/card-quiz/cards.js');

async function printCards() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'docs', '纸卡');
  const css = ['assets/typography.css', 'card-quiz/print.css']
    .map(file => fs.readFileSync(path.join(root, 'web_controller', file), 'utf8')).join('\n');
  const sheets = Array.from({length: 40}, (_, index) => {
    const number = index + 1;
    return `<article class="card-sheet">
      <header class="card-caption"><strong>班班纸卡</strong><div class="card-number"><span>卡号</span><strong>${number}</strong></div></header>
      ${cards.svg(number)}
      <footer class="card-instructions">
        <p>单选举所选字母。判断举 A 表示正确，举 B 表示错误。</p>
        <p>多选只在选中项举 A，改为不选举 B。整题没举卡记弃权。</p>
        <p>举卡时保持字母朝上，手指避开黑白图案。</p>
      </footer></article>`;
  });
  const browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined});
  try {
    const page = await browser.newPage();
    await page.emulateMedia({media: 'print'});
    await page.setContent(`<!doctype html><html lang="zh-CN" class="card-quiz-print-page">
      <head><meta charset="utf-8"><title>班班课堂通用纸卡</title><style>${css}
        * {box-sizing:border-box} body {margin:0} .card-caption {justify-content:space-between}
      </style></head><body class="teacher-liquid card-quiz-print"><main id="cards">${sheets.join('')}</main></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    fs.mkdirSync(output, {recursive: true});
    for (const count of [2, 40]) {
      await page.pdf({path: path.join(output, `通用纸卡-1-${count}.pdf`), pageRanges: `1-${count}`,
        preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false});
    }
  } finally {
    await browser.close();
  }
}

printCards().catch(error => { console.error(error); process.exitCode = 1; });
