'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const cards = require('../web_controller/card-quiz/print-card.js');

async function printCards() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'docs', '纸卡');
  const css = ['assets/typography.css', 'card-quiz/print.css']
    .map(file => fs.readFileSync(path.join(root, 'web_controller', file), 'utf8')).join('\n');
  const sheets = Array.from({length: 60}, (_, index) => cards.renderPublic(index + 1));
  const browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined});
  try {
    const page = await browser.newPage();
    await page.emulateMedia({media: 'print'});
    await page.setContent(`<!doctype html><html lang="zh-CN" class="card-quiz-print-page">
      <head><meta charset="utf-8"><title>班班课堂通用纸卡</title><style>${css}</style></head>
      <body class="teacher-liquid card-quiz-print"><main id="cards">${sheets.join('')}</main></body></html>`);
    await page.evaluate(() => Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode())]));
    fs.mkdirSync(output, {recursive: true});
    for (const count of [2, 40, 60]) {
      await page.pdf({path: path.join(output, `通用纸卡-1-${count}.pdf`), pageRanges: `1-${count}`,
        preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false});
    }
  } finally {
    await browser.close();
  }
}

printCards().catch(error => { console.error(error); process.exitCode = 1; });
