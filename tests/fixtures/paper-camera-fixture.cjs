'use strict';
const fs = require('node:fs');
const {matrix} = require('../../web_controller/card-quiz/cards.js');

const destination = process.argv[2];
if (!destination) throw new Error('Provide an output path for the two-card Y4M fixture.');
const width = 640, height = 480, cell = 22;
const luma = Buffer.alloc(width * height, 224);
for (const [card, left, top] of [[1, 90, 136], [2, 369, 169]]) {
  matrix(card).forEach((row, y) => row.forEach((white, x) => {
    for (let line = 0; line < cell; line++) {
      const start = (top + y * cell + line) * width + left + x * cell;
      luma.fill(white ? 235 : 16, start, start + cell);
    }
  }));
}

const file = fs.openSync(destination, 'wx');
try {
  fs.writeSync(file, `YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`);
  const chroma = Buffer.alloc(width * height / 2, 128);
  for (let frame = 0; frame < 20; frame++) {
    // Vary the background slightly to model distinct camera frames.
    luma.fill(214 + frame, 0, width * 55);
    fs.writeSync(file, 'FRAME\n');
    fs.writeSync(file, luma);
    fs.writeSync(file, chroma);
  }
} finally {
  fs.closeSync(file);
}
