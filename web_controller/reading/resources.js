(() => {
  'use strict';
  const requests = new Map();
  const revisions = { 'classic.txt': '20261018-ui2', 'rocket.txt': '20261018-ui3' };
  async function load(name, json) {
    const key = `${name}:${json}`;
    if (!requests.has(key)) {
      const work = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const revision = revisions[name] ? `?v=${revisions[name]}` : '';
          const response = await fetch(`/reading/assets/v2.2.4/${name}${revision}`, { signal: controller.signal });
          if (!response.ok) throw new Error('资源未能下载');
          return await (json ? response.json() : response.text());
        } catch (error) {
          throw new Error(error.name === 'AbortError' ? '加载超时，请检查网络后重试。' : '资源未能加载，请检查网络后重试。');
        } finally { clearTimeout(timer); }
      })();
      requests.set(key, work);
      work.catch(() => requests.delete(key));
    }
    return requests.get(key);
  }
  window.ReadingAssets = { text: name => load(name, false), json: name => load(name, true) };
})();
