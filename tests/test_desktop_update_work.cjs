const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(require('node:path').join(__dirname, '../Desktop/DesktopWindow.cs'), 'utf8');
const script = source.match(/private const string UpdateWorkScript = """\r?\n([\s\S]*?)\r?\n""";/)[1];
function frame() {
  const messages = [], requests = [], mutations = [], events = {};
  const state = { dialog: false };
  class Recorder extends EventTarget { start() {} stop() { this.dispatchEvent(new Event('stop')); } }
  const context = {
    crypto: webcrypto, MediaRecorder: Recorder,
    MutationObserver: class { constructor(callback) { mutations.push(callback); } observe() {} },
    document: { querySelectorAll: () => state.dialog ? [{ getClientRects: () => [1] }] : [] },
    navigator: { mediaDevices: { getUserMedia() { return new Promise((resolve, reject) => requests.push({resolve, reject})); } } },
    window: { chrome: { webview: { postMessage: message => messages.push(message) } },
      addEventListener: (name, callback) => { events[name] = callback; } },
  };
  vm.runInNewContext(script, context);
  return { messages, requests, mutations, events, state, context };
}

(async () => {
  const first = frame(), second = frame();
  const pending = first.context.navigator.mediaDevices.getUserMedia({audio: true});
  assert.equal(first.messages.at(-1).busy, true, 'Opening the microphone cancels downloading before permission completes');
  assert.match(first.messages.at(-1).id, /^[0-9a-f-]{36}$/, 'Work reports identify the individual frame');
  const track = new EventTarget(); track.stop = () => {};
  first.requests[0].resolve({getTracks: () => [track]}); await pending;
  assert.equal(first.messages.at(-1).busy, true, 'An acquired microphone remains busy');
  track.stop();
  assert.equal(first.messages.at(-1).busy, false, 'track.stop clears recording without requiring an ended event');
  const denied = first.context.navigator.mediaDevices.getUserMedia({audio: true});
  first.requests[1].reject(new Error('denied')); await assert.rejects(denied);
  assert.equal(first.messages.at(-1).busy, false, 'Permission failure cannot leave a permanent busy flag');
  const recorder = new first.context.MediaRecorder(); recorder.start();
  assert.equal(first.messages.at(-1).busy, true, 'Recording existing media also pauses downloading');
  recorder.stop();
  assert.equal(first.messages.at(-1).busy, false);
  first.state.dialog = true; first.mutations.forEach(callback => callback());
  assert.equal(first.messages.at(-1).busy, true, 'A visible HTML dialog pauses downloading');
  first.state.dialog = false; first.mutations.forEach(callback => callback());
  assert.equal(first.messages.at(-1).busy, false);
  const secondRecording = new second.context.MediaRecorder(); secondRecording.start();
  assert.notEqual(first.messages.at(-1).id, second.messages.at(-1).id, 'An idle frame cannot clear another frame recording');
  second.events.pagehide();
  assert.equal(second.messages.at(-1).busy, false, 'Removing a frame releases its work state');
  console.log('Teacher update media, dialog and frame work checks passed: 12');
})().catch(error => { console.error(error); process.exitCode = 1; });
