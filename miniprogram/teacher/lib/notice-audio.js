'use strict';

const { validateWav } = require('./notice-data');
const recorders = new WeakMap();

async function authorizeRecording(runtime, current) {
  if (typeof runtime.getRecorderManager !== 'function' || typeof runtime.authorize !== 'function') {
    throw new Error('当前设备无法录音，请选择 WAV 文件。');
  }
  if (typeof runtime.requirePrivacyAuthorize === 'function') {
    await new Promise((resolve, reject) => runtime.requirePrivacyAuthorize({
      success: resolve, fail: () => reject(new Error('未获得微信隐私授权，无法录音。你仍可使用文字通知。'))
    }));
  }
  if (!current()) return;
  await new Promise((resolve, reject) => runtime.authorize({
    scope: 'scope.record', success: resolve,
    fail: () => reject(new Error('无法使用麦克风。请在微信小程序设置中允许录音，或选择 WAV 文件。'))
  }));
}

function recorder(runtime) {
  if (recorders.has(runtime)) return recorders.get(runtime);
  const manager = runtime.getRecorderManager();
  let active = null;
  const finish = (error, result) => {
    const session = active;
    active = null;
    if (session && !session.cancelled) session.callbacks.finish(error, result);
  };
  manager.onStart(() => {
    if (!active) return;
    if (active.cancelled) manager.stop();
    else active.callbacks.start();
  });
  manager.onStop(result => finish(null, result));
  manager.onError(() => finish(new Error('录音失败。请检查麦克风权限后重试，或选择 WAV 文件。')));
  const service = {
    start(callbacks) {
      if (active) throw new Error('上一段录音正在停止，请稍后重试。');
      const session = { callbacks, cancelled: false };
      active = session;
      try { manager.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1, duration: 30000 }); }
      catch (error) { active = null; throw error; }
      return {
        stop() { if (active === session) manager.stop(); },
        cancel() { if (active === session) { session.cancelled = true; manager.stop(); } }
      };
    }
  };
  recorders.set(runtime, service);
  return service;
}

async function readWav(runtime, path, name) {
  if (!path) throw new Error('没有找到录音文件，请重新录制或选择。');
  const buffer = await new Promise((resolve, reject) => runtime.getFileSystemManager().readFile({
    filePath: path, success: value => resolve(value.data), fail: reject
  }));
  const metadata = validateWav(buffer);
  return { name, path, ...metadata, durationLabel: `${(metadata.durationMs / 1000).toFixed(1)} 秒` };
}

module.exports = { authorizeRecording, recorder, readWav };
