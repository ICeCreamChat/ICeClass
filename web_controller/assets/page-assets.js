(() => {
  'use strict';
  const nonce = document.currentScript.nonce;
  const pending = new Map();

  function load(url, sheet) {
    if (pending.has(url)) return pending.get(url);
    const node = sheet || document.createElement('script');
    const ready = new Promise((resolve, reject) => {
      node.onload = () => resolve();
      node.onerror = () => {
        pending.delete(url);
        if (sheet) sheet.removeAttribute('href');
        else node.remove();
        reject(new Error('页面资源未能载入，请检查连接后重试。'));
      };
      if (sheet) sheet.href = url;
      else {
        node.nonce = nonce;
        node.src = url;
        document.head.append(node);
      }
    });
    pending.set(url, ready);
    return ready;
  }

  window.ICeClassAssets = {
    script: url => load(url),
    styles: group => Promise.all(Array.from(document.querySelectorAll('link[data-style-group="' + group + '"]'),
      sheet => load(sheet.dataset.href, sheet)))
  };
})();
