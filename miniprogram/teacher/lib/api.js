'use strict';

const BASE_URL = 'https://iceclass.icecreamchat.top';
const LOGIN_PATH = '/api/auth/login';
const STORAGE_KEY = 'iceclass.wechat.session.v1';
const AGREEMENTS_VERSION = 1;

class ApiError extends Error {
  constructor(message, status = 0, data = {}, ambiguous = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = data && data.code || '';
    this.data = data || {};
    this.ambiguous = ambiguous;
  }
}

function createClient(runtime) {
  let session = null;
  let epoch = 0;
  let persistenceWarning = '';
  const readOnly = method => ['GET', 'HEAD', 'OPTIONS'].includes(method);
  const validUser = value => value && typeof value.id === 'string' && typeof value.csrfToken === 'string' && value.csrfToken.length > 0;

  try {
    const saved = runtime && runtime.getStorageSync(STORAGE_KEY);
    if (saved && saved.agreementsVersion !== AGREEMENTS_VERSION) runtime.removeStorageSync(STORAGE_KEY);
    else if (saved && /^iceclass_session=[A-Za-z0-9_-]+$/.test(saved.cookie) && validUser(saved.user) && saved.expiresAt > Date.now()) session = saved;
  } catch (_) { /* A blocked storage area does not prevent an in-memory login. */ }

  function persist() {
    if (!runtime) return;
    try {
      if (session) runtime.setStorageSync(STORAGE_KEY, session);
      else runtime.removeStorageSync(STORAGE_KEY);
      persistenceWarning = '';
    } catch (_) {
      persistenceWarning = '本机未能保存登录状态，关闭小程序后可能需要重新登录。';
    }
  }

  function clearSession() {
    epoch += 1;
    session = null;
    persist();
  }

  function getUser() {
    if (session && session.expiresAt <= Date.now()) clearSession();
    return session ? session.user : null;
  }

  function validatePath(path) {
    if (typeof path !== 'string' || !/^\/api\/[A-Za-z0-9_/?=&%.+,:@-]+$/.test(path) || path.split('?')[0].split('/').some(part => part === '..' || /%2e|%2f|%5c/i.test(part))) {
      throw new ApiError('接口地址无效。');
    }
  }

  function headers(auth, method) {
    const result = { 'Content-Type': 'application/json' };
    if (auth) {
      if (!getUser()) throw new ApiError('登录已过期，请重新登录；当前页面内容会保留。', 401);
      result.Cookie = session.cookie;
      if (!readOnly(method)) result['X-CSRF-Token'] = session.user.csrfToken;
    }
    return result;
  }

  function responseData(response) {
    let data = response.data;
    if (typeof data === 'string') {
      if (!data && response.statusCode === 204) return {};
      try { data = JSON.parse(data); } catch (_) { throw new ApiError('服务器返回了无法读取的内容，请稍后重试。', response.statusCode); }
    }
    if (data === undefined && response.statusCode === 204) return {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('服务器返回了无法读取的内容，请稍后重试。', response.statusCode);
    return data;
  }

  function checked(response, auth, requestEpoch, method = 'GET') {
    if (requestEpoch !== epoch) throw new ApiError('账号已切换，本次结果已丢弃。', 0, { code: 'session_changed' });
    const succeeded = response.statusCode >= 200 && response.statusCode < 300;
    const uncertainFailure = !readOnly(method) && (response.statusCode === 408 || response.statusCode >= 500);
    const uncertainMessage = '未能确认操作结果。请先刷新记录核对，避免重复提交。';
    let data;
    try { data = responseData(response); }
    catch (error) {
      if ((!readOnly(method) && succeeded) || uncertainFailure) throw new ApiError(uncertainMessage, response.statusCode, {}, true);
      if (response.statusCode !== 401 && response.statusCode !== 403) throw error;
      data = {};
    }
    if (!succeeded) {
      if (auth && response.statusCode === 401) clearSession();
      const fallback = response.statusCode === 401 ? '登录已过期，请重新登录；当前页面内容会保留。'
        : response.statusCode === 403 ? '当前账号没有执行此操作的权限。'
          : `请求失败（${response.statusCode || '未知状态'}），请稍后重试。`;
      throw new ApiError(uncertainFailure ? uncertainMessage : typeof data.error === 'string' ? data.error : fallback, response.statusCode, data, uncertainFailure);
    }
    return data;
  }

  function networkError(method, path, failure) {
    if (path === LOGIN_PATH) {
      const blockedDomain = /url not in domain list/i.test(failure && failure.errMsg || '');
      return new ApiError(blockedDomain
        ? '微信未允许连接学校服务器。请联系管理员配置小程序服务器域名。'
        : '未能连接学校服务器。请检查网络后重试。', 0, {}, !blockedDomain);
    }
    return new ApiError(readOnly(method)
      ? '网络连接失败。请检查网络，或联系管理员核对小程序服务器域名。'
      : '未能确认操作结果。请先刷新记录核对，避免重复提交。', 0, {}, !readOnly(method));
  }

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      let header;
      const method = (options.method || 'GET').toUpperCase();
      const auth = options.auth !== false;
      try { validatePath(path); header = headers(auth, method); } catch (error) { reject(error); return; }
      if (!runtime || typeof runtime.request !== 'function') { reject(new ApiError('微信网络功能暂不可用。')); return; }
      const requestEpoch = epoch;
      runtime.request({
        url: BASE_URL + path, method, data: options.data, header, timeout: options.timeout || 15000,
        success(response) {
          try {
            const data = checked(response, auth, requestEpoch, method);
            resolve(options.response ? { data, response } : data);
          } catch (error) { reject(error); }
        },
        fail(failure) { reject(requestEpoch !== epoch ? new ApiError('账号已切换。', 0, { code: 'session_changed' }) : networkError(method, path, failure)); }
      });
    });
  }

  function extractCookie(response) {
    const lines = Array.isArray(response.cookies) ? response.cookies.slice() : [];
    Object.keys(response.header || {}).forEach(key => {
      if (key.toLowerCase() === 'set-cookie') {
        const value = response.header[key];
        lines.push(...(Array.isArray(value) ? value : [String(value)]));
      }
    });
    for (const line of lines) {
      const match = /(?:^|,\s*)iceclass_session=([A-Za-z0-9_-]+)(?:;|$)/.exec(line);
      if (match) {
        const maxAge = /;\s*max-age=(\d+)/i.exec(line);
        const expires = /;\s*expires=([^;]+)/i.exec(line);
        const expiresAt = maxAge ? Date.now() + Number(maxAge[1]) * 1000 : expires ? Date.parse(expires[1]) : Date.now() + 86400000;
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
        return { cookie: `iceclass_session=${match[1]}`, expiresAt };
      }
    }
    return null;
  }

  async function login(username, password, isCurrent = () => true) {
    clearSession();
    const loginEpoch = epoch;
    const result = await request(LOGIN_PATH, { method: 'POST', data: { username: String(username).trim(), password }, auth: false, response: true });
    if (loginEpoch !== epoch) throw new ApiError('账号已切换。', 0, { code: 'session_changed' });
    if (!isCurrent()) return null;
    const cookie = extractCookie(result.response);
    if (!cookie || !validUser(result.data.user)) throw new ApiError('未能建立有效登录会话，请重试或联系学校管理员。');
    session = { ...cookie, user: result.data.user, classId: '', agreementsVersion: AGREEMENTS_VERSION };
    persist();
    return session.user;
  }

  async function restoreSession() {
    const user = getUser();
    if (!user) return null;
    const restoreEpoch = epoch;
    try {
      const data = await request('/api/session');
      if (restoreEpoch !== epoch || !session || session.user.id !== user.id) throw new ApiError('账号已切换。', 0, { code: 'session_changed' });
      if (!data.authenticated || !validUser(data.user) || data.user.id !== user.id) { clearSession(); return null; }
      session.user = data.user;
      persist();
      return session.user;
    } catch (error) {
      if (error.status === 401) return null;
      throw error;
    }
  }

  async function logout() {
    if (!getUser()) { clearSession(); return; }
    const logoutEpoch = epoch;
    await request('/api/auth/logout', { method: 'POST' });
    if (logoutEpoch !== epoch) throw new ApiError('账号已切换。', 0, { code: 'session_changed' });
    clearSession();
  }

  function upload(path, filePath, formData) {
    return new Promise((resolve, reject) => {
      let header;
      try { validatePath(path); header = headers(true, 'POST'); delete header['Content-Type']; } catch (error) { reject(error); return; }
      if (!runtime || typeof runtime.uploadFile !== 'function') { reject(new ApiError('微信文件上传功能暂不可用。')); return; }
      const requestEpoch = epoch;
      runtime.uploadFile({
        url: BASE_URL + path, filePath, name: 'audio', formData, header, timeout: 30000,
        success(response) { try { resolve(checked(response, true, requestEpoch, 'POST')); } catch (error) { reject(error); } },
        fail() { reject(requestEpoch !== epoch ? new ApiError('账号已切换。', 0, { code: 'session_changed' }) : networkError('POST')); }
      });
    });
  }

  function download(path) {
    return new Promise((resolve, reject) => {
      let header;
      try { validatePath(path); header = headers(true, 'GET'); } catch (error) { reject(error); return; }
      if (!runtime || typeof runtime.downloadFile !== 'function') { reject(new ApiError('微信文件下载功能暂不可用。')); return; }
      const requestEpoch = epoch;
      runtime.downloadFile({
        url: BASE_URL + path, header, timeout: 30000,
        success(response) {
          try {
            checked({ ...response, data: {} }, true, requestEpoch);
            if (!response.tempFilePath) throw new ApiError('没有收到文件，请重新下载。');
            resolve(response.tempFilePath);
          } catch (error) { reject(error); }
        },
        fail() { reject(requestEpoch !== epoch ? new ApiError('账号已切换。', 0, { code: 'session_changed' }) : networkError('GET')); }
      });
    });
  }

  return {
    request, login, logout, restoreSession, getUser, clearSession, upload, download,
    getClassId() { return getUser() ? session.classId || '' : ''; },
    selectClass(classId) { if (getUser()) { session.classId = String(classId || ''); persist(); } },
    getPersistenceWarning() { return persistenceWarning; }
  };
}

module.exports = Object.assign(createClient(typeof wx === 'undefined' ? null : wx), { createClient, ApiError, BASE_URL });
