const encoder = new TextEncoder(), decoder = new TextDecoder();
export function decode(value) {
  if (typeof value !== 'string' || value.length > 32768) throw new Error('连接信息不可用，请重新扫码。');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}
export function encode(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function additionalData(session, purpose) { return encoder.encode('VideoBooth phone preparation ' + purpose + ' ' + session); }
async function cipherKey(bootstrap) {
  if (!/^[a-f0-9]{32}$/.test(bootstrap.sessionId || '') || decode(bootstrap.key).length !== 32) throw new Error('连接信息不可用，请重新扫码。');
  return crypto.subtle.importKey('raw', decode(bootstrap.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function open(bootstrap, purpose, payload) {
  const packet = decode(payload);
  if (packet.length <= 28) throw new Error('连接信息不完整，请重新扫码。');
  const encrypted = new Uint8Array(packet.length - 12);
  encrypted.set(packet.slice(28)); encrypted.set(packet.slice(12, 28), packet.length - 28);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packet.slice(0, 12),
    additionalData: additionalData(bootstrap.sessionId, purpose), tagLength: 128 }, await cipherKey(bootstrap), encrypted);
  return JSON.parse(decoder.decode(plaintext));
}
export async function seal(bootstrap, purpose, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: additionalData(bootstrap.sessionId, purpose), tagLength: 128 }, await cipherKey(bootstrap), encoder.encode(JSON.stringify(value))));
  const packet = new Uint8Array(12 + encrypted.length);
  packet.set(iv); packet.set(encrypted.slice(-16), 12); packet.set(encrypted.slice(0, -16), 28);
  return encode(packet);
}
function serviceUrl(value) {
  const uri = new URL(value);
  if ((uri.protocol !== 'https:' && !(uri.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(uri.hostname)))
    || uri.username || uri.password || uri.search || uri.hash) throw new Error('准备服务不可用，请联系软件提供方。');
  return uri;
}
async function json(service, path, token, body, recovery = null) {
  for (let attempt = 0; ; attempt++) {
    try { return await requestJson(service, path, token, body, recovery?.signal); }
    catch (error) {
      if (!recovery || !error.transient || attempt >= 3) throw error;
      const wait = Math.max(error.retryAfter || 0, [2000, 5000, 10000][attempt]);
      await recovery.wait(wait, '网络暂时不稳定，正在自动恢复连接');
    }
  }
}
async function requestJson(service, path, token, body, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const cancellation = new AbortController();
  let rejectCancellation;
  const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
  const abort = () => {
    cancellation.abort();
    rejectCancellation(Object.assign(new Error('连接请求超时或已取消。'), { name: 'AbortError' }));
  };
  // Some mobile fetch implementations ignore AbortSignal, including while reading a body.
  // Bound the wait as well as requesting cancellation; late results cannot advance preparation.
  const timeout = setTimeout(abort, 30000);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await Promise.race([fetch(new URL(path, service), { method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: cancellation.signal }), cancelled]);
    if (!response.ok) {
      const error = new Error(response.status === 429 ? '准备服务繁忙，将按提示时间自动重试。' : '暂时无法准备连接，请保持手机联网。');
      error.transient = response.status === 408 || response.status === 429 || response.status >= 500;
      error.retryAfter = response.status === 429 ? Math.max(600000, Number(response.headers.get('Retry-After') || 0) * 1000) : 0;
      throw error;
    }
    // Keep the timeout until the body has arrived too; receiving headers is not completion.
    return await Promise.race([response.json(), cancelled]);
  } catch (error) {
    if (!signal?.aborted && (error.name === 'TypeError' || error.name === 'AbortError')) {
      error.transient = true;
      error.message = '网络暂时不稳定，请保持移动数据和展台 Wi-Fi 开启。';
    }
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
export async function prepare(bootstrap, payload, progress = () => {}, recovery = null) {
  const request = await open(bootstrap, 'request', payload), service = serviceUrl(request.serviceUrl);
  if (!/^[a-f0-9]{32}$/.test(request.id || '') || !/^[a-f0-9]{64}$/.test(request.token || '')
    || !request.cameraHost?.startsWith('device-' + request.id + '.') || !request.publicKeyPem || !request.csrPem)
    throw new Error('连接信息不可用，请重新扫描电脑当前的二维码。');
  if (!request.registered) {
    progress('正在连接这台展台…', 1);
    const device = await json(service, 'api/devices', null,
      { id: request.id, token: request.token, publicKeyPem: request.publicKeyPem }, recovery);
    if (device.id !== request.id || device.token !== request.token || device.cameraHost !== request.cameraHost)
      throw new Error('准备结果不属于这台电脑，请联系软件提供方。');
  }
  progress('首次连接正在自动准备，请保持页面打开…', 2);
  const operation = new AbortController(), abort = () => operation.abort();
  if (recovery?.signal?.aborted) abort(); else recovery?.signal?.addEventListener('abort', abort, { once: true });
  const retry = recovery && { signal: operation.signal, wait: (ms, text) => recovery.wait(ms, text, operation.signal) };
  try {
    // Publish the local address while the CA works. Both results are required.
    const addressResult = json(service, 'api/devices/' + request.id + '/connection', request.token,
      { address: request.address }, retry).then(value => ({ value }), error => ({ error }));
    const path = 'api/devices/' + request.id + '/certificate';
    let order = await json(service, path, request.token, { csrPem: request.csrPem }, retry);
    const deadline = Date.now() + 360000;
    while (order.status === 'pending' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      order = await json(service, path, request.token, undefined, retry);
    }
    if (order.status !== 'ready' || !order.certificatePem) {
      const error = new Error('首次准备暂未完成，将稍后自动继续。');
      error.transient = order.status === 'pending' || order.status === 'failed';
      error.retryAfter = 60000;
      throw error;
    }
    const address = await addressResult;
    if (address.error) throw address.error;
    progress('准备完成，正在打开摄像头…', 3);
    return await seal(bootstrap, 'response', { cameraHost: request.cameraHost, certificatePem: order.certificatePem });
  } finally { operation.abort(); recovery?.signal?.removeEventListener('abort', abort); }
}

let maintaining = false, nextAttempt = 0, failures = 0;
export async function maintainPhoneCertificate(params) {
  if (maintaining || Date.now() < nextAttempt || document.hidden) return null;
  maintaining = true;
  try {
    const offerResponse = await fetch('/api/phone-preparation/request?' + params.toString(), { cache: 'no-store' });
    if (offerResponse.status === 404 || offerResponse.status === 401) return null;
    if (!offerResponse.ok) throw new Error();
    const offer = await offerResponse.json();
    if (!offer) return null;
    const payload = await prepare(offer.bootstrap, offer.payload);
    const result = await fetch('/api/phone-preparation/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: offer.bootstrap.sessionId, payload }), cache: 'no-store' });
    if (!result.ok) throw new Error();
    failures = 0; nextAttempt = 0;
    return (await result.json()).phoneUrl;
  } catch (error) {
    failures = Math.min(failures + 1, 4);
    nextAttempt = Date.now() + Math.max(error.retryAfter || 0, [60000, 600000, 6000000, 86400000][failures - 1]);
    return null;
  } finally { maintaining = false; }
}
