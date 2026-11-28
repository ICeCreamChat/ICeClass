'use strict';

async function authorize(page, runtime, current) {
  if (typeof runtime.getPrivacySetting !== 'function') throw new Error('当前微信版本无法核对隐私授权，请更新微信后重试。');
  const result = await new Promise((resolve, reject) => runtime.getPrivacySetting({
    success: resolve, fail: () => reject(new Error('无法核对微信隐私授权，请重试。'))
  }));
  if (!current()) return false;
  if (result && result.needAuthorization === false) return true;
  if (!result || result.needAuthorization !== true) throw new Error('无法核对微信隐私授权，请重试。');
  return new Promise(resolve => {
    page._privacyDecision = resolve;
    page.setData({ privacyNeeded: true });
  });
}

function settle(page, accepted) {
  const pending = page._privacyDecision;
  if (!pending) return;
  page._privacyDecision = null;
  page.setData({ privacyNeeded: false });
  pending(accepted);
}

function openPolicy(page, runtime) {
  page.setData({ error: '' });
  const fail = () => page.setData({ error: '未能打开隐私保护指引，可取消本次操作后重试。' });
  if (typeof runtime.openPrivacyContract === 'function') runtime.openPrivacyContract({ fail });
  else fail();
}

module.exports = { authorize, settle, openPolicy };
