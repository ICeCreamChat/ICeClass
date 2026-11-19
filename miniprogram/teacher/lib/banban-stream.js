'use strict';

const LIMIT = 2000000;
const hex = '0123456789ABCDEF';

function decode(bytes) {
  if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let encoded = '';
  for (const byte of bytes) encoded += '%' + hex[byte >> 4] + hex[byte & 15];
  return decodeURIComponent(encoded);
}

function events(emit) {
  let partial = new Uint8Array(0), count = 0, terminal = false, received = false;
  function line(text) {
    if (!text.trim()) return;
    if (terminal) throw new Error('班班回复格式异常。');
    const value = JSON.parse(text);
    if (!value || typeof value.type !== 'string') throw new Error('班班回复格式异常。');
    if (value.type === 'done' || value.type === 'error') terminal = true;
    emit(value);
  }
  return {
    chunk(data) {
      const bytes = new Uint8Array(data);
      if (!bytes.length) return;
      received = true;
      count += bytes.length;
      if (count > LIMIT) throw new Error('回复过长。');
      let start = 0, end;
      while ((end = bytes.indexOf(10, start)) !== -1) {
        const next = bytes.subarray(start, end);
        if (partial.length) {
          const combined = new Uint8Array(partial.length + next.length);
          combined.set(partial);
          combined.set(next, partial.length);
          line(decode(combined));
          partial = new Uint8Array(0);
        } else line(decode(next));
        start = end + 1;
      }
      if (start < bytes.length) {
        const tail = bytes.subarray(start);
        const next = new Uint8Array(partial.length + tail.length);
        next.set(partial);
        next.set(tail, partial.length);
        partial = next;
      }
    },
    finish(data) {
      if (!received) {
        if (typeof data !== 'string' || data.length > LIMIT) throw new Error('未收到完整回复。');
        data.split('\n').forEach(line);
      } else if (partial.length) line(decode(partial));
      if (!terminal) throw new Error('未收到完整回复。');
    }
  };
}

module.exports = { events };
