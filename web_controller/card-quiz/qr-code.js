(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/qrcodegen.js'));
  else root.CardQuizQr = factory(root.qrcodegen);
})(globalThis, function (encoder) {
  'use strict';
  function svg(text) {
    const qr = encoder.QrCode.encodeText(text, encoder.QrCode.Ecc.MEDIUM);
    const cells = [];
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) cells.push(`M${x + 4},${y + 4}h1v1h-1z`);
      }
    }
    const size = qr.size + 8;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path fill="black" d="${cells.join('')}"/></svg>`;
  }
  return {svg};
});
