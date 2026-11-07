/* Device authentication belongs to the native host's same-origin request interceptor.
 * Boot: deferred script / DOMContentLoaded. Completion: document event iceclass-ideas-ready.
 * Native lifecycle: await window.ICeClassIdeas.suspend() or .prepareToLeave().
 * Both stop capture immediately, finish an attachment recording, cancel dictation,
 * and flush the scoped draft.
 */
(() => {
  'use strict';

  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  const SAMPLE_RATE = 16000;
  const MAX_AUDIO_SECONDS = 60;
  const PAGE_SIZE = 20;
  const STATUS = Object.freeze({ pending: '待评审', adopted: '已采纳', implementing: '实现中', launched: '已上线', declined: '暂不采纳' });

  function newRequestId() {
    if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function encodePcm16Wav(samples) {
    const length = Math.min(samples.length, SAMPLE_RATE * MAX_AUDIO_SECONDS);
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    const ascii = (offset, text) => Array.from(text).forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, length * 2, true);
    for (let i = 0; i < length; i += 1) {
      const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
      view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function mediaPath(value) {
    return typeof value === 'string' && /^\/api\/ideas\/media\/[a-z0-9_-]+$/i.test(value) ? value : null;
  }

  function isRetryUncertain(status) {
    return !status || status >= 500 || status === 408 || status === 409;
  }

  // The same WAV encoder and retry rules are checked by the dependency-free Node tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { encodePcm16Wav, mediaPath, isRetryUncertain, newRequestId };
  }
  if (typeof document === 'undefined') return;

  function boot() {
    const $ = id => document.getElementById(id);
    const node = (tag, className, text) => {
      const result = document.createElement(tag);
      if (className) result.className = className;
      if (text !== undefined) result.textContent = text;
      return result;
    };
    const listen = (id, event, handler) => $(id).addEventListener(event, handler);
    const blankDraft = () => ({ requestId: newRequestId(), text: '', transcript: '', ink: [], inkImage: null, name: '', signed: false, images: [], audio: null, rawAudio: null, pending: false, completed: null });
    const dictationFields = Object.freeze({
      name: { input: 'ideaName', button: 'dictateName', label: 'dictateNameLabel', cancel: 'cancelDictateName', status: 'dictationNameStatus' }
    });
    const cleanupError = '创意已提交，但本机草稿清理失败。请点击“重试清理草稿”。';
    const listState = () => ({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE, loaded: false, loading: false, error: '', epoch: 0, controller: null });
    const initialView = new URL(window.location.href).searchParams.get('view');
    const state = {
      view: ['class', 'showcase'].includes(initialView) ? initialView : 'submit',
      context: null, key: null, authed: false, connecting: false, restoring: false,
      draft: blankDraft(), sending: false, filesBusy: false, filesTask: null, filesJob: null, storageAvailable: null,
      camera: { generation: 0, visible: false, opening: false, capturing: false, stream: null },
      step: 'express', reviewJob: null, reviewInk: null, textVisible: false,
      tool: 'pen', transcription: null,
      voice: null, class: listState(), showcase: listState(), recent: null, highlightId: null, deletion: null
    };
    let saveTimer = null;
    let persistence = Promise.resolve(true);
    let databasePromise = null;
    let readyDispatched = false;
    let leaving = null;
    let contextTask = null;
    const ink = window.ICeClassIdeasInk.create($('inkCanvas'), {
      onChange(strokes) {
        state.draft.ink = strokes; state.draft.inkImage = null;
        feedback('submitError', ''); feedback('inkMessage', ''); scheduleSave(); updateUI();
      },
      onError(message) { feedback('inkMessage', message, true); }
    });

    function feedback(id, text, error = false) {
      $(id).textContent = text;
      $(id).hidden = !text;
      $(id).classList.toggle('ideas-error', error);
    }

    function hasContent(draft = state.draft) {
      return Boolean(draft.text.trim() || draft.transcript.trim() || draft.ink.length || draft.images.length || draft.audio || draft.rawAudio || draft.completed);
    }

    function imageCount() { return state.draft.images.length + Number(state.draft.ink.length > 0); }
    function combinedText(draft = state.draft) { return [draft.text.trim(), draft.transcript.trim()].filter(Boolean).join('\n\n'); }
    function nativeSend(message) {
      if (!window.ICeClassIdeasDesktop || typeof window.ICeClassIdeasDesktop.send !== 'function') return false;
      window.ICeClassIdeasDesktop.send(message); return true;
    }

    function cancelTranscription(message = '') {
      const job = state.transcription;
      if (!job) return;
      state.transcription = null; clearTimeout(job.timer);
      try { nativeSend({ type: 'ideas-transcribe-cancel', requestId: job.requestId }); } catch { /* Host already detached. */ }
      feedback(job.statusId || 'transcriptionStatus', message); updateUI();
    }

    function cancelDictation(message = '', target = null) {
      const recording = state.voice;
      if (recording?.target && (!target || recording.target === target)) {
        recording.cancelled = true; clearVoiceTimers(recording); stopTracks(recording.stream);
        state.voice = null;
        try { if (recording.recorder?.state !== 'inactive') recording.recorder?.stop(); } catch { /* Capture has already stopped. */ }
        recording.resolve(true);
        feedback(dictationFields[recording.target].status, message);
      }
      if (state.transcription?.target && (!target || state.transcription.target === target)) cancelTranscription(message);
      updateUI();
    }

    async function transcribeVoice() {
      if (locked() || state.step !== 'express' || state.voice || state.filesBusy || state.transcription || state.draft.rawAudio || !state.draft.audio || state.draft.audio.transcribed) return;
      await transcribeAudio(state.draft.audio);
    }

    async function transcribeAudio(audio, dictation = null) {
      const job = { requestId: newRequestId(), draft: state.draft, audio, ...dictation };
      job.statusId = job.target ? dictationFields[job.target].status : 'transcriptionStatus';
      state.transcription = job;
      feedback(job.statusId, '正在转文字…'); updateUI();
      job.timer = setTimeout(() => cancelTranscription(job.target ? '转文字超时，请重新语音输入。' : '转写超时，原录音已保留，可以重试。'), 120000);
      try {
        const bytes = new Uint8Array(await job.audio.blob.arrayBuffer());
        if (state.transcription !== job) return;
        let binary = '';
        for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        if (!nativeSend({ type: 'ideas-transcribe', requestId: job.requestId, audioBase64: btoa(binary) })) throw new Error('请在教室端小窗中使用转文字。');
      } catch (error) {
        if (state.transcription !== job) return;
        state.transcription = null; clearTimeout(job.timer);
        feedback(job.statusId, error.message || '暂时无法转文字，请重试。', true); updateUI();
      }
    }

    function receiveTranscription(event) {
      const value = event.data, job = state.transcription;
      if (!job || !value || value.type !== 'ideas-transcription' || value.requestId !== job.requestId) return;
      if (job.draft !== state.draft || (!job.target && job.audio !== state.draft.audio)
        || (job.target === 'name' && (state.step !== 'review' || !state.draft.signed))) { cancelTranscription(); return; }
      state.transcription = null; clearTimeout(job.timer);
      if (typeof value.error !== 'string' || typeof value.text !== 'string') feedback(job.statusId, '转写结果异常，请重试。', true);
      else if (value.error || !value.text.trim()) feedback(job.statusId, value.error || '没有识别到文字，请重新语音输入。', true);
      else if (job.target) {
        const field = $(dictationFields[job.target].input);
        const text = value.text.trim();
        const next = job.originalValue.slice(0, job.start) + text + job.originalValue.slice(job.end);
        if (field.value !== job.originalValue) feedback(job.statusId, '原文字已修改，请重新语音输入。', true);
        else if (next.length > 40) feedback(job.statusId, '名字最多 40 字，请重新说出名字。', true);
        else {
          field.value = next; state.draft[job.target] = next;
          if (job.target === 'name') { feedback('signatureError', ''); field.removeAttribute('aria-invalid'); }
          feedback(job.statusId, '已填入，可继续修改。'); scheduleSave(); updateUI(); field.focus();
          field.setSelectionRange?.(job.start + text.length, job.start + text.length);
        }
      }
      else if (combinedText({ ...state.draft, transcript: value.text.trim() }).length > 3000)
        feedback('transcriptionStatus', '文字合计超过 3000 字，原录音已保留。请缩短文字后重试。', true);
      else {
        state.draft.transcript = value.text.trim(); state.textVisible = true; $('ideaText').value = combinedText();
        job.audio.transcribed = true;
        feedback('transcriptionStatus', '已转文字，原录音一并保留。'); scheduleSave();
      }
      updateUI();
    }

    function locked() {
      return !state.authed || state.restoring || state.sending || Boolean(state.reviewJob) || state.draft.pending || Boolean(state.draft.completed);
    }

    function stopTracks(stream) {
      if (stream) stream.getTracks().forEach(track => track.stop());
    }

    function revoke(attachment) {
      if (attachment && attachment.url) URL.revokeObjectURL(attachment.url);
    }

    function attachment(blob) {
      return { blob, url: URL.createObjectURL(blob) };
    }

    function pausePlayback() {
      document.querySelectorAll('audio, video').forEach(media => media.pause());
    }

    function updateVoiceUI() {
      const job = state.voice;
      $('voicePanel').hidden = !job || Boolean(job.target);
      if (!job) return;
      if (job.target) {
        feedback(dictationFields[job.target].status, job.converting ? '正在处理声音…' : job.stopping ? '正在结束…'
          : !job.recorder ? '正在等待麦克风权限…' : `正在聆听 ${Math.min(60, Math.floor((performance.now() - job.startedAt) / 1000))} / 60 秒`);
        return;
      }
      $('voiceStatus').textContent = job.converting ? '正在保存录音…' : job.stopping ? '正在结束录音…'
        : !job.recorder ? '正在等待麦克风权限…'
          : `录音中 ${Math.min(60, Math.floor((performance.now() - job.startedAt) / 1000))} / 60 秒`;
    }

    function updateUI() {
      const reviewing = state.step === 'review';
      const retrying = state.draft.pending || Boolean(state.draft.completed);
      $('draftFields').disabled = locked() || reviewing;
      $('draftFields').hidden = reviewing;
      $('reviewFields').disabled = locked();
      $('reviewFields').hidden = !reviewing;
      $(reviewing ? 'step-express' : 'step-review').removeAttribute('aria-current');
      $(reviewing ? 'step-review' : 'step-express').setAttribute('aria-current', 'step');
      $('textCount').textContent = `${combinedText().length} / 3000`;
      const count = imageCount();
      const drawingDisabled = locked() || reviewing || state.filesBusy || Boolean(state.voice) || state.camera.visible;
      ink.setDisabled(drawingDisabled);
      $('inkEmpty').hidden = ink.hasContent();
      $('inkCanvas').setAttribute('aria-disabled', String(drawingDisabled));
      $('inkCanvas').dataset.tool = state.tool;
      $('inkPen').disabled = drawingDisabled; $('inkEraser').disabled = drawingDisabled;
      $('inkUndo').disabled = drawingDisabled || !ink.canUndo();
      $('inkClear').disabled = drawingDisabled || !ink.hasContent();
      $('imageCount').textContent = state.draft.ink.length ? `手写与图片 ${count} / 3` : `图片 ${count} / 3`;
      $('imageCount').hidden = count === 0;
      const busy = !state.authed || state.restoring || state.sending || Boolean(state.reviewJob) || state.filesBusy || Boolean(state.voice) || Boolean(state.transcription) || Boolean(state.draft.rawAudio) || state.camera.visible;
      $('submitIdea').disabled = busy || count > 3 || !hasContent();
      $('submitIdea').hidden = reviewing && !retrying;
      $('submitIdea').textContent = state.sending ? (state.draft.completed ? '正在清理…' : '正在提交…') : state.draft.completed ? '重试清理草稿' : state.draft.pending ? '重试确认提交' : state.reviewJob ? '正在准备…' : '下一步';
      $('reviewActions').hidden = !reviewing || retrying;
      $('confirmSubmit').disabled = busy || locked();
      $('confirmSubmit').textContent = state.sending ? '正在提交…' : '确认提交';
      $('cancelSubmit').disabled = locked() || state.sending;
      $('ideaForm').setAttribute('aria-busy', String(state.sending || state.restoring || Boolean(state.reviewJob)));
      $('openCamera').disabled = locked() || reviewing || state.filesBusy || Boolean(state.voice) || count >= 3 || state.camera.visible;
      $('addImages').disabled = locked() || reviewing || state.filesBusy || Boolean(state.voice) || state.camera.visible || count >= 3;
      const recording = state.voice && !state.voice.target ? state.voice : null;
      $('recordVoice').disabled = locked() || reviewing || state.filesBusy || Boolean(state.voice?.target) || Boolean(state.transcription) || Boolean(recording && (recording.stopping || recording.converting)) || Boolean(state.draft.rawAudio) || state.camera.visible;
      $('recordVoice').setAttribute('aria-pressed', String(Boolean(recording)));
      $('recordVoiceLabel').textContent = recording?.converting ? '保存中…' : recording?.stopping ? '正在结束…' : recording ? (recording.recorder ? '结束录音' : '取消录音') : state.transcription && !state.transcription.target ? '转文字中…' : state.draft.audio ? '重新说' : '说创意';
      $('textEditor').hidden = !state.textVisible;
      $('ideaText').disabled = locked() || reviewing || Boolean(state.voice) || Boolean(state.transcription);
      $('openCamera').setAttribute('aria-expanded', String(state.camera.visible));
      $('cameraGuide').hidden = state.camera.opening || !state.camera.stream;
      $('retryCamera').hidden = state.camera.opening || Boolean(state.camera.stream);
      $('retryCamera').disabled = locked() || state.camera.opening || state.camera.capturing;
      $('capturePhoto').disabled = state.camera.opening || state.camera.capturing || !state.camera.stream || !$('cameraVideo').videoWidth;
      $('cameraSelect').disabled = state.camera.opening || state.camera.capturing;
      $('transcriptionActions').hidden = !state.draft.audio;
      $('transcribeVoice').hidden = Boolean(state.draft.audio?.transcribed) || Boolean(state.transcription && !state.transcription.target);
      $('transcribeVoice').disabled = locked() || Boolean(state.voice) || state.filesBusy || Boolean(state.draft.rawAudio) || Boolean(state.transcription);
      $('transcribeVoice').textContent = state.transcription && !state.transcription.target ? '正在转文字…' : state.draft.transcript ? '重新转文字' : '重试转文字';
      $('cancelTranscription').hidden = !state.transcription || Boolean(state.transcription.target);
      Object.entries(dictationFields).forEach(([kind, field]) => {
        const recording = state.voice?.target === kind ? state.voice : null;
        const transcribing = state.transcription?.target === kind;
        const busy = Boolean(recording || transcribing);
        $(field.input).disabled = locked() || busy || !reviewing;
        $(field.button).disabled = locked() || state.filesBusy || state.camera.visible || Boolean(state.draft.rawAudio)
          || Boolean(state.voice && !recording) || Boolean(state.transcription) || Boolean(recording && (recording.converting || recording.stopping))
          || (kind === 'name' && (!state.draft.signed || !reviewing));
        $(field.button).setAttribute('aria-pressed', String(busy));
        $(field.label).textContent = transcribing ? '转文字中…' : recording?.converting ? '处理中…' : recording ? '结束' : '说出名字';
        $(field.cancel).hidden = !busy;
      });
      $('signNamed').disabled = locked(); $('signAnonymous').disabled = locked();
      $('retryContext').disabled = state.connecting;
      if (state.sending) $('draftNotice').textContent = state.draft.completed ? '正在清理已提交的草稿，请稍候。' : '正在提交，请稍候。';
      else if (state.draft.completed) $('draftNotice').textContent = '创意已送达。请重试清理本机草稿。';
      else if (state.draft.pending) $('draftNotice').textContent = '上次提交结果尚未确认。请重试确认，内容和附件已锁定。';
      else if (state.restoring) $('draftNotice').textContent = '正在恢复草稿…';
      else if (state.reviewJob) $('draftNotice').textContent = '正在准备核对内容…';
      else if (state.filesBusy) $('draftNotice').textContent = '正在处理图片…';
      else if (state.camera.visible) $('draftNotice').textContent = '拍照裁剪后再提交。';
      else if (state.voice) $('draftNotice').textContent = state.voice.target ? '正在语音输入…' : '最长 60 秒，说完自动转文字。';
      else if (state.transcription) $('draftNotice').textContent = state.transcription.target ? '正在填入语音文字…' : '正在转文字，原录音会保留。';
      else if (count > 3) $('draftNotice').textContent = '手写与图片合计最多 3 份，请删去一张图片。';
      else if (state.draft.rawAudio) $('draftNotice').textContent = '录音尚未保存，请重试保存或删除这段录音。';
      else if (hasContent() && state.storageAvailable === false) $('draftNotice').textContent = '草稿仅保留在当前窗口，请勿关闭。';
      else if (reviewing) $('draftNotice').textContent = '提交给创意评审';
      else if (hasContent() && state.storageAvailable === true) $('draftNotice').textContent = '草稿已保存在本机。';
      else $('draftNotice').textContent = '手写、语音和图片可以一起提交。';
      updateVoiceUI();
    }

    class ApiError extends Error {
      constructor(message, status = 0) { super(message); this.status = status; }
    }

    async function request(path, options = {}, externalSignal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', abort, { once: true });
      }
      const timer = setTimeout(abort, options.method === 'POST' ? 45000 : 18000);
      try {
        const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) throw new ApiError('请从已绑定教室端打开。若已在教室端，请重新连接后重试。', response.status);
          const detail = body && (typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : '');
          throw new ApiError(detail || (response.status === 413 ? '附件过大，请检查图片和录音大小。' : response.status === 429 ? '操作过于频繁，请稍后重试。' : '暂时无法完成请求，请稍后重试。'), response.status);
        }
        if (!body || typeof body !== 'object') throw new ApiError('服务返回异常，请稍后重试。');
        return body;
      } catch (error) {
        if (error instanceof ApiError || (externalSignal && externalSignal.aborted)) throw error;
        throw new ApiError(error.name === 'AbortError' ? '连接超时，请检查网络后重试。' : '暂时无法连接，请检查网络后重试。');
      } finally {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', abort);
      }
    }

    function database() {
      if (databasePromise) return databasePromise;
      databasePromise = new Promise(resolve => {
        if (!window.indexedDB) { resolve(null); return; }
        let finished = false;
        const finish = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } else if (value) value.close(); };
        const timer = setTimeout(() => finish(null), 2500);
        try {
          const opening = window.indexedDB.open('iceclass-ideas-student', 1);
          opening.onupgradeneeded = () => opening.result.createObjectStore('drafts');
          opening.onerror = () => finish(null);
          opening.onblocked = () => finish(null);
          opening.onsuccess = () => {
            opening.result.onversionchange = () => opening.result.close();
            finish(opening.result);
          };
        } catch { finish(null); }
      });
      return databasePromise;
    }

    async function stored(action, key, value) {
      const db = await database();
      if (!db) return { ok: false };
      return new Promise(resolve => {
        try {
          const tx = db.transaction('drafts', action === 'get' ? 'readonly' : 'readwrite');
          const store = tx.objectStore('drafts');
          const operation = action === 'get' ? store.get(key) : action === 'delete' ? store.delete(key) : store.put(value, key);
          tx.oncomplete = () => resolve({ ok: true, value: action === 'get' ? operation.result : undefined });
          tx.onerror = tx.onabort = () => resolve({ ok: false });
        } catch { resolve({ ok: false }); }
      });
    }

    function snapshot() {
      const draft = state.draft;
      return { requestId: draft.requestId, text: draft.text, transcript: draft.transcript, ink: draft.ink, inkImage: draft.inkImage, name: draft.name, signed: draft.signed, pending: draft.pending,
        completed: draft.completed, rawAudio: draft.rawAudio ? draft.rawAudio.blob : null,
        images: draft.images.map(image => image.blob), audio: draft.audio ? { blob: draft.audio.blob, durationMs: draft.audio.durationMs, transcribed: draft.audio.transcribed === true } : null };
    }

    function persistDraft() {
      clearTimeout(saveTimer);
      if (!state.key || state.restoring) return Promise.resolve(false);
      const key = state.key;
      const draft = state.draft;
      const value = snapshot();
      persistence = persistence.then(async () => {
        if (draft !== state.draft) return true;
        if (draft.completed || state.restoring) return false;
        const result = await stored('put', key, value);
        state.storageAvailable = result.ok;
        updateUI();
        return result.ok;
      }).catch(() => { state.storageAvailable = false; updateUI(); return false; });
      return persistence;
    }

    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void persistDraft(); }, 300);
    }

    async function deleteStoredDraft(key) {
      clearTimeout(saveTimer);
      const confirmed = state.draft.completed ? snapshot() : null;
      persistence = persistence.then(async () => {
        const result = await stored('delete', key);
        state.storageAvailable = result.ok;
        // Preserve the server confirmation if deletion fails, so reopening only retries cleanup.
        if (!result.ok && confirmed) {
          const marker = await stored('put', key, confirmed);
          state.storageAvailable = marker.ok;
        }
        return result.ok;
      }).catch(() => false);
      return persistence;
    }

    async function restoreDraft() {
      state.restoring = true;
      updateUI();
      const result = await stored('get', state.key);
      state.storageAvailable = result.ok;
      const value = result.value;
      if (value && typeof value.text === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId)) {
        state.draft = { requestId: value.requestId, text: value.text.slice(0, 3000), transcript: typeof value.transcript === 'string' ? value.transcript.slice(0, 3000) : '',
          ink: window.ICeClassIdeasInk.sanitize(value.ink), inkImage: value.inkImage instanceof Blob && value.inkImage.type === 'image/jpeg' && value.inkImage.size <= MAX_IMAGE_BYTES ? value.inkImage : null,
          name: typeof value.name === 'string' ? value.name.slice(0, 40) : '',
          signed: typeof value.signed === 'boolean' ? value.signed : Boolean(typeof value.name === 'string' && value.name.trim()), pending: value.pending === true,
          completed: value.completed && typeof value.completed === 'object' && value.completed.id != null ? value.completed : null,
          images: Array.isArray(value.images) ? value.images.filter(blob => blob instanceof Blob && blob.type === 'image/jpeg' && blob.size <= MAX_IMAGE_BYTES).slice(0, 3).map(attachment) : [], audio: null, rawAudio: null };
        if (value.audio && value.audio.blob instanceof Blob && value.audio.blob.type === 'audio/wav' && value.audio.blob.size <= MAX_IMAGE_BYTES && value.audio.durationMs > 0 && value.audio.durationMs <= 60000) {
          state.draft.audio = { ...attachment(value.audio.blob), durationMs: value.audio.durationMs, transcribed: value.audio.transcribed === true || Boolean(state.draft.transcript) };
        }
        if (value.rawAudio instanceof Blob && value.rawAudio.size > 0 && /^audio\//i.test(value.rawAudio.type)) state.draft.rawAudio = attachment(value.rawAudio);
      }
      $('ideaText').value = combinedText();
      state.textVisible = Boolean(combinedText());
      $('ideaName').value = state.draft.name;
      ink.replace(state.draft.ink);
      renderAttachments();
      state.restoring = false;
      if (state.draft.completed) feedback('submitError', cleanupError, true);
      else if (state.draft.pending) feedback('submitError', '上次提交结果尚未确认，请用下方按钮重试确认。草稿和附件已保留。', true);
      if (state.draft.rawAudio) feedback('attachmentMessage', '上次录音尚未保存，请重试保存或删除这段录音。', true);
    }

    function connectContext() {
      if (state.connecting) return contextTask;
      state.connecting = true;
      $('classContext').textContent = '正在连接教室…';
      updateUI();
      contextTask = (async () => {
        try {
          const context = await request('/api/ideas/student/context');
          if (context.classId == null || !context.deviceId || !context.className) throw new ApiError('尚未获取到班级，请从已绑定教室端重新打开。');
          const key = JSON.stringify([String(context.classId), String(context.deviceId)]);
          if (state.key !== key) {
            ink.finish(); returnToDraft(false); cancelDictation(); cancelTranscription(); cancelImages();
            closeCamera(); closeDelete(false, true);
            await stopRecording(false);
            if (state.key) await persistDraft();
            state.draft.images.forEach(revoke); revoke(state.draft.audio); revoke(state.draft.rawAudio);
            state.draft = blankDraft();
            state.key = key;
            state.context = context;
            state.class = listState(); state.showcase = listState();
            state.recent = null; state.highlightId = null;
            await restoreDraft();
          }
          state.context = context;
          state.authed = true;
          $('classContext').textContent = context.className;
          $('connectionNotice').hidden = true;
        } catch (error) {
          state.authed = false;
          $('classContext').textContent = '未连接教室';
          $('connectionMessage').textContent = error.message;
          $('connectionNotice').hidden = false;
        } finally {
          state.connecting = false; contextTask = null;
          updateUI();
          setView(state.view, false);
          if (!readyDispatched) {
            readyDispatched = true;
            document.dispatchEvent(new CustomEvent('iceclass-ideas-ready', { detail: { authenticated: state.authed, view: state.view } }));
          }
        }
      })();
      return contextTask;
    }

    function showImage(url, title) {
      $('imageDialogTitle').textContent = title;
      $('imageDialogPhoto').src = url;
      $('imageDialogPhoto').alt = title;
      if (!$('imageDialog').open) $('imageDialog').showModal();
    }

    function closeImage() {
      if ($('imageDialog').open) $('imageDialog').close();
      $('imageDialogPhoto').removeAttribute('src');
    }

    function renderAttachments() {
      const images = $('imageAttachments');
      images.replaceChildren();
      state.draft.images.forEach((image, i) => {
        const item = node('div', 'ideas-image-attachment');
        const preview = node('button', 'ideas-preview-button');
        preview.type = 'button';
        preview.setAttribute('aria-label', `查看待提交图片 ${i + 1}`);
        const img = node('img'); img.src = image.url; img.alt = `待提交图片 ${i + 1}`; img.width = 150; img.height = 112;
        preview.append(img);
        preview.addEventListener('click', () => showImage(image.url, `待提交图片 ${i + 1}`));
        const remove = node('button', 'ideas-button', `删除图片 ${i + 1}`); remove.type = 'button';
        remove.addEventListener('click', () => {
          if (locked() || state.step !== 'express' || state.filesBusy) return;
          revoke(state.draft.images.splice(i, 1)[0]);
          renderAttachments(); scheduleSave(); updateUI();
          $('addImages').focus();
        });
        item.append(preview, remove); images.append(item);
      });
      const audioContainer = $('audioAttachment');
      audioContainer.querySelectorAll('audio').forEach(audio => audio.pause());
      audioContainer.replaceChildren();
      audioContainer.hidden = !state.draft.audio && !state.draft.rawAudio;
      if (state.draft.audio) {
        const audio = node('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = state.draft.audio.url;
        audio.setAttribute('aria-label', '待提交录音');
        const label = node('p', '', `原录音 · ${Math.ceil(state.draft.audio.durationMs / 1000)} 秒`);
        const remove = node('button', 'ideas-button', '删除录音'); remove.type = 'button';
        remove.addEventListener('click', () => {
          if (locked() || state.step !== 'express' || state.voice) return;
          // Keep words already transcribed or edited when the student removes the audio.
          cancelTranscription(); state.draft.text = combinedText(); state.draft.transcript = ''; feedback('transcriptionStatus', '');
          audio.pause(); revoke(state.draft.audio); state.draft.audio = null;
          renderAttachments(); scheduleSave(); updateUI(); $('recordVoice').focus();
        });
        audioContainer.append(label, audio, remove);
      }
      if (state.draft.rawAudio) {
        const audio = node('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = state.draft.rawAudio.url;
        audio.setAttribute('aria-label', '尚未保存的录音');
        const label = node('p', '', '这段录音尚未保存，可重试保存或删除。');
        const retry = node('button', 'ideas-button', '重试保存录音'); retry.type = 'button';
        retry.addEventListener('click', () => { void retryRecording(); });
        const remove = node('button', 'ideas-button', '删除未保存录音'); remove.type = 'button';
        remove.addEventListener('click', () => {
          if (locked() || state.step !== 'express' || state.voice) return;
          audio.pause(); revoke(state.draft.rawAudio); state.draft.rawAudio = null;
          renderAttachments(); scheduleSave(); feedback('attachmentMessage', ''); updateUI(); $('recordVoice').focus();
        });
        audioContainer.append(label, audio, retry, remove);
      }
    }

    function cameraError(error) {
      if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return '相机未获允许。你可以添加已有图片，或直接写下创意。';
      if (error && error.name === 'NotFoundError') return '没有找到摄像头。你可以添加已有图片，或直接写下创意。';
      return '暂时无法使用相机。请重试相机，或关闭后添加已有图片。';
    }

    function closeCamera(restoreFocus = false) {
      const camera = state.camera;
      const wasVisible = camera.visible;
      camera.generation += 1;
      camera.visible = false; camera.opening = false; camera.capturing = false;
      stopTracks(camera.stream); camera.stream = null;
      $('cameraVideo').pause(); $('cameraVideo').srcObject = null;
      if ($('cameraPanel').open) $('cameraPanel').close();
      updateUI();
      if (restoreFocus && wasVisible) $('openCamera').focus({ preventScroll: true });
    }

    async function startCamera(deviceId) {
      if (locked() || state.step !== 'express' || state.voice || state.filesBusy || imageCount() >= 3) return;
      ink.finish();
      const camera = state.camera;
      const generation = ++camera.generation;
      camera.visible = true; camera.opening = true; camera.capturing = false;
      stopTracks(camera.stream); camera.stream = null;
      $('cameraVideo').srcObject = null;
      if (!deviceId) $('cameraSelectField').hidden = true;
      $('cameraStatus').textContent = '正在等待相机权限…';
      updateUI();
      if (!$('cameraPanel').open) $('cameraPanel').showModal();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        camera.opening = false;
        $('cameraStatus').textContent = '当前设备无法使用相机。你可以添加已有图片，或直接写下创意。';
        updateUI(); return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 }, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }) } });
        if (generation !== camera.generation || !camera.visible || document.hidden || locked()) { stopTracks(stream); return; }
        camera.stream = stream;
        $('cameraVideo').srcObject = stream;
        await $('cameraVideo').play();
        if (generation !== camera.generation) return;
        camera.opening = false;
        $('cameraStatus').textContent = '对准纸上的创意，拍照后只保留纸张。';
        updateUI();
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (generation !== camera.generation) return;
          const cameras = devices.filter(device => device.kind === 'videoinput');
          const select = $('cameraSelect'); select.replaceChildren();
          const active = stream.getVideoTracks()[0].getSettings().deviceId;
          cameras.forEach((device, i) => {
            const option = node('option', '', device.label || `摄像头 ${i + 1}`); option.value = device.deviceId;
            option.selected = device.deviceId === active; select.append(option);
          });
          $('cameraSelectField').hidden = cameras.length < 2;
        } catch { $('cameraSelectField').hidden = true; }
      } catch (error) {
        if (generation !== camera.generation) return;
        stopTracks(camera.stream); camera.stream = null;
        $('cameraVideo').srcObject = null;
        camera.opening = false;
        $('cameraStatus').textContent = cameraError(error);
        updateUI();
      }
    }

    async function capturePhoto() {
      const camera = state.camera;
      const video = $('cameraVideo');
      if (locked() || state.filesBusy || camera.opening || camera.capturing || !camera.stream || !video.videoWidth) return;
      camera.capturing = true; updateUI();
      let canvas = null;
      try {
        if (video.videoWidth * video.videoHeight > 24000000) throw new Error('相机画面过大，请换用较低分辨率。');
        canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('无法读取相机画面，请重试。');
        context.drawImage(video, 0, 0);
        // Stop capture before showing any local crop preview. The full frame is never encoded or saved.
        closeCamera();
        await processImages([canvas]);
      } catch (error) {
        closeCamera(); feedback('attachmentMessage', error.message || '拍照失败，请重试。', true);
      } finally {
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        updateUI();
      }
    }

    function cancelImages() {
      if (state.filesJob) state.filesJob.cancelled = true;
      window.ICeClassIdeasPaper.cancel();
    }

    async function processImages(sources) {
      if (locked() || state.step !== 'express' || state.filesBusy || state.camera.visible || state.voice || !sources.length) return;
      ink.finish();
      const draft = state.draft;
      const job = { draft, cancelled: false };
      let finish;
      state.filesTask = new Promise(resolve => { finish = resolve; });
      state.filesJob = job; state.filesBusy = true; updateUI();
      const messages = [];
      let changed = false;
      try {
        const slots = Math.max(0, 3 - imageCount());
        if (sources.length > slots) messages.push(draft.ink.length ? '手写与图片合计最多 3 份，超出的图片未添加。' : '最多添加 3 张图片，超出的图片未添加。');
        for (const source of sources.slice(0, slots)) {
          if (job.cancelled) break;
          if (source instanceof Blob && !/^image\/(jpeg|png|webp)$/i.test(source.type)) { messages.push('请选择 JPG、PNG 或静态 WebP 图片。'); continue; }
          if (source instanceof Blob && (!source.size || source.size > MAX_IMAGE_BYTES)) { messages.push('单张图片不能超过 2 MB，也不能为空。'); continue; }
          try {
            const blob = await window.ICeClassIdeasPaper.open(source);
            if (job.cancelled || draft !== state.draft || document.hidden || state.view !== 'submit') break;
            if (!blob) continue;
            if (blob.type !== 'image/jpeg' || !blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('裁剪图片无法保存，请重试。');
            draft.images.push(attachment(blob)); changed = true;
          } catch (error) { messages.push(error.message || '有图片无法读取，请换一张重试。'); }
        }
      } finally {
        state.filesBusy = false; state.filesJob = null;
        if (draft === state.draft) {
          renderAttachments(); if (changed) scheduleSave();
          feedback('attachmentMessage', [...new Set(messages)].join(' '), Boolean(messages.length));
        }
        updateUI(); state.filesTask = null; finish();
      }
    }

    async function convertRecording(blob) {
      const Audio = window.AudioContext;
      const Offline = window.OfflineAudioContext;
      if (!Audio || !Offline) throw new Error('当前设备无法处理录音，请用文字或图片提交。');
      const context = new Audio();
      try {
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        const length = Math.min(SAMPLE_RATE * MAX_AUDIO_SECONDS, Math.ceil(decoded.duration * SAMPLE_RATE));
        if (length < 1) throw new Error('没有录到声音，请重新录一段。');
        const offline = new Offline(1, length, SAMPLE_RATE);
        const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
        const rendered = await offline.startRendering();
        return { blob: encodePcm16Wav(rendered.getChannelData(0)), durationMs: Math.round(length / SAMPLE_RATE * 1000) };
      } finally { await context.close(); }
    }

    function clearVoiceTimers(job) {
      clearTimeout(job.limitTimer); clearInterval(job.tickTimer);
    }

    async function finishRecording(job) {
      if (job.finished) return;
      job.finished = true; clearVoiceTimers(job); stopTracks(job.stream);
      job.converting = true; updateUI();
      let converted = false;
      try {
        if (job.draft !== state.draft || job.cancelled) return;
        const blob = job.blob || new Blob(job.chunks, { type: job.recorder.mimeType || 'audio/webm' });
        if (!blob.size) throw new Error('没有录到声音，请检查麦克风后重试。');
        if (!job.target && (!state.draft.rawAudio || state.draft.rawAudio.blob !== blob)) {
          revoke(state.draft.rawAudio); state.draft.rawAudio = attachment(blob);
        }
        if (job.error) throw job.error;
        const result = await convertRecording(blob);
        if (job.draft !== state.draft || job.cancelled) return;
        if (job.target) {
          if (state.voice === job) state.voice = null;
          await transcribeAudio(result, { target: job.target, originalValue: job.originalValue, start: job.start, end: job.end });
          converted = true;
          return;
        }
        cancelTranscription(); state.draft.transcript = ''; $('ideaText').value = combinedText(); feedback('transcriptionStatus', '');
        revoke(state.draft.audio);
        state.draft.audio = { ...attachment(result.blob), durationMs: result.durationMs };
        revoke(state.draft.rawAudio); state.draft.rawAudio = null;
        converted = true;
        renderAttachments();
        feedback('attachmentMessage', '');
        await persistDraft();
        if (state.voice === job) state.voice = null;
        if (job.autoTranscribe && job.draft === state.draft && state.view === 'submit' && state.step === 'express' && !document.hidden && !locked())
          await transcribeAudio(state.draft.audio);
      } catch (error) {
        if (job.draft === state.draft && !job.cancelled) {
          if (job.target) feedback(dictationFields[job.target].status, error.message || '语音输入失败，请重试。', true);
          else {
            feedback('attachmentMessage', `${error.message || '录音保存失败。'}${state.draft.rawAudio ? '录音已保留，请重试保存或删除。' : ''}${state.draft.audio ? '原有录音已保留。' : ''}`, true);
            renderAttachments(); await persistDraft();
          }
        }
      } finally {
        if (state.voice === job) state.voice = null;
        updateUI(); job.resolve(converted);
      }
    }

    function stopRecording(autoTranscribe = true) {
      const job = state.voice;
      if (!job) return Promise.resolve(!state.draft.rawAudio);
      if (!autoTranscribe) job.autoTranscribe = false;
      clearVoiceTimers(job);
      if (job.converting) return job.done;
      if (!job.recorder) {
        job.cancelled = true; stopTracks(job.stream); state.voice = null;
        if (job.target) feedback(dictationFields[job.target].status, '已取消语音输入。');
        job.resolve(true); updateUI(); return job.done;
      }
      if (!job.stopping && !job.converting) {
        job.stopping = true;
        try { if (job.recorder.state !== 'inactive') job.recorder.stop(); else void finishRecording(job); }
        catch (error) { job.error = error; void finishRecording(job); }
        stopTracks(job.stream); updateUI();
      }
      return job.done;
    }

    async function retryRecording() {
      if (locked() || state.step !== 'express' || state.filesBusy || state.voice || state.camera.visible || !state.draft.rawAudio) return;
      pausePlayback();
      cancelTranscription();
      const job = { draft: state.draft, blob: state.draft.rawAudio.blob, stream: null, autoTranscribe: true };
      job.done = new Promise(resolve => { job.resolve = resolve; });
      state.voice = job; feedback('attachmentMessage', '');
      void finishRecording(job);
      await job.done;
      if (state.view === 'submit' && !document.hidden) {
        const audio = $('audioAttachment').querySelectorAll('audio')[0];
        (audio || $('recordVoice')).focus();
      }
    }

    async function startRecording(target = null) {
      if (locked() || state.filesBusy || state.voice || state.draft.rawAudio || state.camera.visible || document.hidden || state.view !== 'submit') return;
      if (target ? (!dictationFields[target] || state.transcription || state.step !== 'review' || !state.draft.signed) : state.step !== 'express') return;
      const statusId = target ? dictationFields[target].status : 'attachmentMessage';
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder || !window.AudioContext || !window.OfflineAudioContext) {
        feedback(statusId, '当前设备无法录音，你可以手写或添加图片。', true); return;
      }
      pausePlayback();
      ink.finish(); cancelTranscription();
      const field = target ? $(dictationFields[target].input) : null;
      const originalValue = field?.value || '';
      const job = { draft: state.draft, target, originalValue,
        start: Math.min(originalValue.length, field?.selectionStart ?? originalValue.length), end: Math.min(originalValue.length, field?.selectionEnd ?? originalValue.length),
        stream: null, recorder: null, chunks: [], startedAt: 0, cancelled: false, stopping: false, converting: false, finished: false, error: null, autoTranscribe: true };
      job.done = new Promise(resolve => { job.resolve = resolve; });
      state.voice = job; feedback(statusId, ''); updateUI();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { channelCount: { ideal: 1 }, sampleRate: { ideal: 16000 }, echoCancellation: true } });
        if (job.cancelled || state.voice !== job || document.hidden || state.view !== 'submit' || locked()) {
          stopTracks(stream);
          if (state.voice === job) { state.voice = null; job.resolve(true); updateUI(); }
          return;
        }
        job.stream = stream;
        const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => window.MediaRecorder.isTypeSupported(type));
        job.recorder = new window.MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        job.recorder.addEventListener('dataavailable', event => { if (event.data.size) job.chunks.push(event.data); });
        job.recorder.addEventListener('stop', () => { void finishRecording(job); }, { once: true });
        job.recorder.addEventListener('error', () => { job.error = new Error('录音中断，请检查麦克风后重新录音。'); if (state.voice === job) void stopRecording(); });
        job.startedAt = performance.now(); job.recorder.start(1000);
        job.limitTimer = setTimeout(() => { if (state.voice === job) void stopRecording(); }, 60000);
        job.tickTimer = setInterval(updateVoiceUI, 250);
        updateUI();
      } catch (error) {
        clearVoiceTimers(job); stopTracks(job.stream);
        if (state.voice === job) {
          state.voice = null;
          feedback(statusId, error.name === 'NotAllowedError' || error.name === 'SecurityError'
            ? '麦克风未获允许。请允许使用后重试。'
            : error.name === 'NotFoundError' ? '没有找到麦克风，请检查设备。' : '暂时无法录音，请重试。', true);
          updateUI();
        }
        job.resolve(true);
      }
    }

    function formatDate(value) {
      const date = new Date(value);
      if (!value || Number.isNaN(date.getTime())) return '时间待同步';
      return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    }

    function statusNode(value) {
      const result = node('span', 'ideas-status', STATUS[value] || '状态待更新'); result.dataset.status = value || ''; return result;
    }

    function appendMedia(container, media) {
      const group = node('div', 'ideas-original-media');
      (Array.isArray(media) ? media : []).forEach((item, i) => {
        const path = mediaPath(item.url);
        if (!path || !['image', 'audio'].includes(item.kind)) return;
        const error = () => {
          const message = node('p', 'ideas-media-error', `${item.kind === 'image' ? '图片' : '录音'}暂时无法载入，请刷新后重试。`);
          group.append(message);
        };
        if (item.kind === 'image') {
          const button = node('button', 'ideas-preview-button'); button.type = 'button'; button.setAttribute('aria-label', `查看创意图片 ${i + 1}`);
          const image = node('img'); image.src = path; image.alt = `创意图片 ${i + 1}`; image.width = 150; image.height = 112; image.loading = 'lazy'; image.decoding = 'async';
          image.addEventListener('error', error, { once: true });
          button.append(image); button.addEventListener('click', () => showImage(path, `创意图片 ${i + 1}`)); group.append(button);
        } else {
          const audio = node('audio'); audio.controls = true; audio.preload = 'none'; audio.src = path; audio.setAttribute('aria-label', '创意录音说明');
          audio.addEventListener('error', error, { once: true }); group.append(audio);
        }
      });
      if (group.childElementCount) container.append(group);
    }

    function classItem(item, highlighted = false) {
      const article = node('article', 'ideas-item');
      if (highlighted) article.classList.add('ideas-highlight');
      const details = node('details');
      const summary = node('summary');
      summary.append(node('span', 'ideas-item-title', item.title || (item.text ? String(item.text).slice(0, 48) : '一份新创意')));
      const meta = node('span', 'ideas-item-meta'); meta.append(statusNode(item.status), node('span', '', `提交于 ${formatDate(item.createdAt)}`)); summary.append(meta);
      const body = node('div', 'ideas-item-body');
      if (item.text) body.append(node('p', 'ideas-original', item.text));
      body.append(node('p', 'ideas-author', item.name ? `署名：${item.name}` : '未留名'));
      const reply = node('div', 'ideas-reply'); reply.append(node('h3', '', '评审回复'), node('p', '', item.reply || '收到你的创意后，评审进展和回复会显示在这里。')); body.append(reply);
      let mediaLoaded = false;
      details.addEventListener('toggle', () => {
        if (details.open && !mediaLoaded) { mediaLoaded = true; appendMedia(body, item.media); }
        if (!details.open) body.querySelectorAll('audio').forEach(audio => audio.pause());
      });
      details.append(summary, body); article.append(details);
      if (item.canDelete === true && item.status === 'pending' && Number.isInteger(item.version)) {
        article.classList.add('ideas-deletable');
        const remove = node('button', 'ideas-button ideas-quiet ideas-item-remove', '删除'); remove.type = 'button';
        remove.setAttribute('aria-label', `删除创意：${item.title || '一份新创意'}`);
        remove.addEventListener('click', () => openDelete(item, remove)); article.append(remove);
      }
      if (highlighted) details.open = true;
      return article;
    }

    function updateDeleteUI() {
      const job = state.deletion;
      $('confirmDelete').disabled = !job || job.sending || job.blocked;
      $('confirmDelete').textContent = job?.sending ? '正在删除…' : '删除创意';
      $('cancelDelete').disabled = Boolean(job?.sending);
    }

    function openDelete(item, trigger) {
      if (!state.authed || state.deletion || !item.canDelete || item.status !== 'pending') return;
      state.deletion = { item, trigger, key: state.key, sending: false, blocked: false };
      $('deleteIdeaTitle').textContent = item.title || '一份新创意';
      feedback('deleteError', ''); updateDeleteUI(); $('deleteDialog').showModal();
    }

    function closeDelete(restoreFocus = true, force = false) {
      const job = state.deletion;
      if (job?.sending && !force) return;
      state.deletion = null;
      if ($('deleteDialog').open) $('deleteDialog').close();
      if (restoreFocus && job) (job.blocked ? $('refreshClass') : job.trigger).focus({ preventScroll: true });
    }

    async function confirmDelete() {
      const job = state.deletion;
      if (!job || job.sending || job.blocked || !state.authed || job.key !== state.key) return;
      job.sending = true; feedback('deleteError', ''); updateDeleteUI();
      try {
        try {
          const result = await request(`/api/ideas/student/${encodeURIComponent(String(job.item.id))}`, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: job.item.version })
          });
          if (result.deleted !== true) throw new ApiError('删除结果尚未确认，请重试。');
        } catch (error) { if (error.status !== 404) throw error; }
        if (job.key !== state.key || !state.authed) return;
        const id = String(job.item.id);
        state.class.items = state.class.items.filter(item => String(item.id) !== id);
        state.class.total = Math.max(0, state.class.total - 1);
        if (state.recent && String(state.recent.id) === id) state.recent = null;
        if (state.highlightId === id) state.highlightId = null;
        closeImage(); pausePlayback();
        const activeDialog = state.deletion === job;
        if (activeDialog) closeDelete(false, true);
        renderList('class'); feedback('globalNotice', '创意已删除。');
        const page = Math.min(state.class.page, Math.max(1, Math.ceil(state.class.total / state.class.pageSize)));
        await loadList('class', page);
        if (activeDialog && state.view === 'class' && !state.deletion) $('refreshClass').focus({ preventScroll: true });
      } catch (error) {
        if (state.deletion !== job || job.key !== state.key) return;
        job.blocked = [401, 403, 409].includes(error.status);
        feedback('deleteError', error.message, true);
        if (error.status === 409) {
          if (state.recent && String(state.recent.id) === String(job.item.id)) state.recent = null;
          await loadList('class');
        }
      } finally { job.sending = false; updateDeleteUI(); }
    }

    function showcaseItem(item) {
      // Deliberately use only the curated showcase fields, even if a server sends extras.
      const article = node('article', 'ideas-item ideas-showcase-item');
      article.append(node('h3', '', item.publishedTitle || '校园新改变'));
      const meta = node('p', 'ideas-item-meta');
      meta.append(node('span', '', item.className || ''), statusNode(item.status), node('span', '', `更新于 ${formatDate(item.updatedAt)}`));
      article.append(meta, node('p', 'ideas-showcase-text', item.publishedText || ''));
      return article;
    }

    function listControls(kind) {
      const list = state[kind];
      const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
      $(`${kind}Pagination`).hidden = !list.loaded || list.total <= list.pageSize;
      $(`${kind}Previous`).disabled = list.loading || list.page <= 1 || !state.authed;
      $(`${kind}Next`).disabled = list.loading || list.page >= pages || !state.authed;
      $(`${kind}Page`).textContent = `第 ${list.page} / ${pages} 页`;
      $(kind === 'class' ? 'refreshClass' : 'refreshShowcase').disabled = list.loading || !state.authed;
      $(kind === 'class' ? 'retryClass' : 'retryShowcase').hidden = !list.error;
      $(`${kind}List`).setAttribute('aria-busy', String(list.loading));
    }

    function renderList(kind) {
      const list = state[kind];
      const container = $(`${kind}List`); container.querySelectorAll('audio').forEach(audio => audio.pause()); container.replaceChildren();
      list.items.forEach(item => container.append(kind === 'class' ? classItem(item, String(item.id) === state.highlightId) : showcaseItem(item)));
      $(`${kind}Total`).textContent = list.loaded ? `共 ${list.total} 条` : '';
      if (kind === 'class') {
        $('recentSubmission').replaceChildren();
        const showRecent = state.recent && !list.items.some(item => String(item.id) === state.highlightId);
        $('recentSubmission').hidden = !showRecent;
        if (showRecent) $('recentSubmission').append(classItem(state.recent, true));
      }
      const notice = $(`${kind}ListNotice`);
      const message = list.error || (list.loading ? '正在加载…' : !state.authed ? '请从已绑定教室端打开。' : !list.items.length ? kind === 'class' ? '本班还没有创意。到「提交创意」说说你的想法吧。' : '还没有发布成果。已采纳的创意会在整理后展示在这里。' : '');
      notice.textContent = message; notice.hidden = !message;
      listControls(kind);
    }

    async function loadList(kind, page = state[kind].page) {
      if (!state.authed) { renderList(kind); return; }
      const list = state[kind];
      if (list.controller) list.controller.abort();
      list.controller = new AbortController();
      const signal = list.controller.signal;
      const epoch = ++list.epoch;
      list.loading = true; list.error = ''; listControls(kind);
      $(`${kind}ListNotice`).textContent = '正在加载…';
      $(`${kind}ListNotice`).hidden = false;
      try {
        const path = kind === 'class' ? '/api/ideas/student' : '/api/ideas/showcase';
        const result = await request(`${path}?page=${page}&pageSize=${PAGE_SIZE}`, {}, signal);
        if (epoch !== list.epoch) return;
        if (!Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0 || !Number.isInteger(result.page) || result.page < 1 || !Number.isInteger(result.pageSize) || result.pageSize < 1) throw new ApiError('列表返回异常，请刷新后重试。');
        list.items = result.items; list.total = result.total; list.page = result.page; list.pageSize = result.pageSize; list.loaded = true;
      } catch (error) {
        if (epoch !== list.epoch || signal.aborted) return;
        list.error = error.message;
      } finally {
        if (epoch === list.epoch) { list.loading = false; renderList(kind); }
      }
    }

    function setView(view, updateLocation = true) {
      if (!['submit', 'class', 'showcase'].includes(view)) return;
      // Reselecting a tab keeps expanded replies and playing media intact.
      // Boot and reconnect still initialize the active view with updateLocation=false.
      if (view === state.view && updateLocation) return;
      if (view !== state.view) {
        ink.finish(); returnToDraft(false); cancelDictation(); cancelTranscription(); cancelImages();
        closeCamera(); closeDelete(false, true); void stopRecording(false); pausePlayback();
        if (state.view !== 'submit') {
          const previous = state[state.view];
          if (previous.controller && previous.loading) { previous.controller.abort(); previous.epoch += 1; previous.loading = false; }
        }
      }
      state.view = view;
      ['submit', 'class', 'showcase'].forEach(kind => {
        $(`tab-${kind}`).setAttribute('aria-selected', String(view === kind));
        $(`tab-${kind}`).tabIndex = view === kind ? 0 : -1;
        $(`panel-${kind}`).hidden = view !== kind;
      });
      if (updateLocation) {
        const url = new URL(window.location.href);
        if (view === 'submit') url.searchParams.delete('view'); else url.searchParams.set('view', view);
        window.history.replaceState(null, '', url);
      }
      if (view !== 'submit') {
        renderList(view);
        if (!state[view].loaded && !state[view].loading && state.authed) void loadList(view);
      }
    }

    function readyToSubmit() {
      if (!state.authed || state.restoring || state.sending || state.reviewJob || state.filesBusy || state.voice || state.transcription || state.draft.rawAudio || state.camera.visible) return false;
      ink.finish();
      if (!hasContent()) { feedback('submitError', '请手写、录音，或添加纸条图片。', true); return false; }
      if (combinedText().length > 3000) { feedback('submitError', '文字合计最多 3000 字。', true); return false; }
      if (imageCount() > 3) { feedback('submitError', '手写与图片合计最多 3 份，请删去一张图片。', true); return false; }
      return true;
    }

    function syncSignature() {
      $('signNamed').checked = state.draft.signed;
      $('signAnonymous').checked = !state.draft.signed;
      $('signatureFields').hidden = !state.draft.signed;
      $('ideaName').setAttribute('aria-required', String(state.draft.signed));
      updateUI();
    }

    function returnToDraft(restoreFocus = true) {
      state.reviewJob = null;
      cancelDictation('', 'name');
      state.step = 'express';
      $('reviewContent').querySelectorAll('audio').forEach(audio => audio.pause());
      $('reviewContent').replaceChildren();
      revoke(state.reviewInk); state.reviewInk = null;
      feedback('signatureError', ''); $('ideaName').removeAttribute('aria-invalid');
      updateUI();
      if (restoreFocus && !document.hidden && state.view === 'submit') $('submitIdea').focus();
    }

    function chooseSignature(signed) {
      if (locked()) return;
      cancelDictation('', 'name'); state.draft.signed = signed;
      feedback('signatureError', ''); $('ideaName').removeAttribute('aria-invalid');
      syncSignature(); scheduleSave();
    }

    async function beginSubmit(event) {
      event?.preventDefault();
      if (!readyToSubmit()) return;
      // An uncertain request must reuse its exact, already confirmed payload.
      if (state.draft.pending || state.draft.completed) { await submitDraft(); return; }
      if (state.step !== 'express') return;
      const job = { draft: state.draft };
      state.reviewJob = job; pausePlayback(); feedback('submitError', ''); updateUI();
      try {
        if (job.draft.ink.length && !job.draft.inkImage) {
          const image = await ink.toBlob();
          if (state.reviewJob !== job || job.draft !== state.draft) return;
          if (!image) throw new Error('手写原稿暂时无法保存，请重试。');
          job.draft.inkImage = image;
        }
        if (state.reviewJob !== job || job.draft !== state.draft || document.hidden || state.view !== 'submit') return;
        renderReview();
        $('ideaName').value = state.draft.name;
        feedback('signatureError', ''); $('ideaName').removeAttribute('aria-invalid');
        state.step = 'review'; syncSignature();
      } catch (error) {
        feedback('submitError', error.message || '暂时无法准备核对内容，请重试。', true);
      } finally {
        if (state.reviewJob === job) state.reviewJob = null;
        updateUI();
      }
      if (state.step === 'review') { $('reviewFields').scrollTop = 0; $('reviewTitle').focus(); }
    }

    function renderReview() {
      const parts = [];
      if (state.draft.ink.length) parts.push('手写 1 份');
      if (state.draft.images.length) parts.push(`图片 ${state.draft.images.length} 张`);
      if (state.draft.audio) parts.push('录音 1 段');
      if (combinedText()) parts.push(`文字 ${combinedText().length} 字`);
      $('reviewSummary').textContent = parts.join(' · ');
      const content = $('reviewContent'); content.replaceChildren();
      revoke(state.reviewInk); state.reviewInk = null;
      if (combinedText()) {
        const text = node('section', 'ideas-review-part');
        text.append(node('h3', '', '创意文字'), node('p', 'ideas-original', combinedText())); content.append(text);
      }
      function preview(url, title, width, height, className) {
        const button = node('button', `ideas-preview-button ${className}`);
        button.type = 'button'; button.setAttribute('aria-label', `查看${title}`);
        const image = node('img'); image.src = url; image.alt = title; image.width = width; image.height = height;
        button.append(image); button.addEventListener('click', () => showImage(url, title));
        return button;
      }
      if (state.draft.inkImage) {
        state.reviewInk = attachment(state.draft.inkImage);
        const handwriting = node('section', 'ideas-review-part');
        handwriting.append(node('h3', '', '手写原稿'), preview(state.reviewInk.url, '手写原稿', 1600, 853, 'ideas-review-ink')); content.append(handwriting);
      }
      if (state.draft.images.length) {
        const pictures = node('section', 'ideas-review-part');
        const list = node('div', 'ideas-review-images');
        state.draft.images.forEach((image, i) => list.append(preview(image.url, `纸条图片 ${i + 1}`, 150, 112, 'ideas-review-photo')));
        pictures.append(node('h3', '', '图片'), list); content.append(pictures);
      }
      if (state.draft.audio) {
        const recording = node('section', 'ideas-review-part');
        const audio = node('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = state.draft.audio.url;
        audio.setAttribute('aria-label', '核对创意原录音');
        recording.append(node('h3', '', `原录音 · ${Math.ceil(state.draft.audio.durationMs / 1000)} 秒`), audio); content.append(recording);
      }
    }

    async function confirmSubmit(event) {
      event.preventDefault();
      if (state.step !== 'review' || locked() || !readyToSubmit()) return;
      const name = state.draft.signed ? $('ideaName').value.trim() : '';
      if (state.draft.signed && (!name || name.length > 40)) {
        feedback('signatureError', !name ? '请填写或说出你的名字，也可以选择不署名。' : '名字最多 40 字。', true);
        $('ideaName').setAttribute('aria-invalid', 'true'); $('ideaName').focus(); return;
      }
      state.draft.name = name; $('ideaName').value = name;
      await submitDraft();
    }

    async function submitDraft() {
      if (!readyToSubmit()) return;
      const draft = state.draft;
      const previouslyPending = draft.pending;
      const key = state.key;
      let posted = false;
      state.sending = true;
      closeCamera(); pausePlayback(); feedback('submitError', ''); feedback('globalNotice', ''); updateUI();
      try {
        if (!draft.completed) {
          if (draft.ink.length && !draft.inkImage) {
            draft.inkImage = await ink.toBlob();
            if (!draft.inkImage) throw new Error('手写原稿暂时无法保存，请重试。');
          }
          draft.pending = true;
          await persistDraft();
          const form = new FormData();
          form.append('report', JSON.stringify({ requestId: draft.requestId, text: combinedText(draft), name: draft.name }));
          if (draft.inkImage) form.append('image', draft.inkImage, 'idea-handwriting.jpg');
          draft.images.forEach((image, i) => form.append('image', image.blob, `idea-${i + 1}.jpg`));
          if (draft.audio) form.append('audio', draft.audio.blob, 'idea-voice.wav');
          posted = true;
          const result = await request('/api/ideas/student', { method: 'POST', body: form });
          if (!result.item || result.item.id == null) throw new ApiError('服务返回异常，请重试确认提交结果。');
          draft.completed = result.item;
        }
        if (!await deleteStoredDraft(key)) {
          feedback('submitError', cleanupError, true);
          return;
        }
        draft.images.forEach(revoke); revoke(draft.audio);
        state.draft = blankDraft();
        returnToDraft(false); state.textVisible = false; ink.replace([]);
        $('ideaText').value = ''; $('ideaName').value = ''; renderAttachments();
        feedback('transcriptionStatus', '');
        Object.values(dictationFields).forEach(field => feedback(field.status, ''));
        feedback('attachmentMessage', '');
        state.recent = draft.completed; state.highlightId = String(draft.completed.id);
        feedback('globalNotice', '创意已提交。');
        state.class.loaded = false; state.class.page = 1;
        setView('class');
        $('tab-class').focus();
      } catch (error) {
        if (draft.completed) feedback('submitError', cleanupError, true);
        else if (error.status === 410) {
          draft.pending = false; draft.requestId = newRequestId(); returnToDraft(false);
          feedback('submitError', '原提交已被删除，内容已保留。可修改后作为新创意提交。', true);
          await persistDraft();
        } else {
          draft.pending = previouslyPending || (posted && isRetryUncertain(error.status));
          feedback('submitError', draft.pending ? `${error.message} 提交结果尚未确认，请重试确认；内容和附件已保留。` : `${error.message} 内容和附件已保留，请调整后重试。`, true);
          await persistDraft();
        }
      } finally { state.sending = false; updateUI(); }
    }

    function prepareToLeave() {
      ink.finish(); returnToDraft(false); cancelDictation(); cancelTranscription(); cancelImages();
      closeCamera(); closeImage(); closeDelete(false, true); pausePlayback();
      const recording = stopRecording(false);
      const images = state.filesTask;
      if (leaving) return leaving;
      leaving = (async () => {
        const [converted] = await Promise.all([recording, images, contextTask]);
        const saved = state.key ? await persistDraft() : !hasContent();
        return { saved: saved && converted && !state.draft.rawAudio, hasDraft: hasContent(), submissionPending: state.sending || (state.draft.pending && !state.draft.completed) };
      })().finally(() => { leaving = null; });
      return leaving;
    }

    window.ICeClassIdeas = Object.freeze({ prepareToLeave, suspend: prepareToLeave });
    ['pen', 'eraser'].forEach(tool => listen(tool === 'pen' ? 'inkPen' : 'inkEraser', 'click', () => {
      if (locked()) return;
      state.tool = tool; ink.setTool(tool);
      $('inkPen').setAttribute('aria-pressed', String(tool === 'pen')); $('inkEraser').setAttribute('aria-pressed', String(tool === 'eraser'));
      updateUI();
    }));
    listen('inkUndo', 'click', () => { ink.undo(); updateUI(); });
    listen('inkClear', 'click', () => { ink.clear(); updateUI(); });
    listen('inkCanvas', 'pointerdown', () => { if (!locked() && !state.filesBusy && state.tool === 'pen') $('inkEmpty').hidden = true; });
    listen('transcribeVoice', 'click', () => { void transcribeVoice(); });
    listen('cancelTranscription', 'click', () => cancelTranscription('已取消，原录音已保留。'));
    Object.entries(dictationFields).forEach(([kind, field]) => {
      listen(field.button, 'click', () => {
        if (state.voice?.target === kind) void stopRecording();
        else void startRecording(kind);
      });
      listen(field.cancel, 'click', () => cancelDictation('已取消语音输入。', kind));
    });
    window.chrome?.webview?.addEventListener('message', receiveTranscription);
    listen('retryContext', 'click', () => { void connectContext(); });
    listen('ideaText', 'input', () => {
      if (locked() || state.step !== 'express' || state.voice || state.transcription) return;
      state.draft.text = $('ideaText').value; state.draft.transcript = ''; state.textVisible = true;
      feedback('submitError', ''); scheduleSave(); updateUI();
    });
    listen('ideaName', 'input', () => {
      if (locked() || state.step !== 'review') return;
      state.draft.name = $('ideaName').value;
      feedback('signatureError', ''); feedback('dictationNameStatus', ''); $('ideaName').removeAttribute('aria-invalid'); scheduleSave(); updateUI();
    });
    listen('submitIdea', 'click', event => { void beginSubmit(event); });
    listen('ideaForm', 'submit', event => { if (state.step === 'review') void confirmSubmit(event); else void beginSubmit(event); });
    listen('signAnonymous', 'change', () => { if ($('signAnonymous').checked) chooseSignature(false); });
    listen('signNamed', 'change', () => { if ($('signNamed').checked) chooseSignature(true); });
    listen('cancelSubmit', 'click', () => { if (!locked()) returnToDraft(); });
    listen('addImages', 'click', () => { if (!locked()) $('imageInput').click(); });
    listen('imageInput', 'change', () => { const files = Array.from($('imageInput').files || []); $('imageInput').value = ''; void processImages(files); });
    listen('openCamera', 'click', () => { void startCamera(); });
    listen('cameraSelect', 'change', () => { void startCamera($('cameraSelect').value); });
    listen('cameraVideo', 'loadedmetadata', updateUI);
    listen('retryCamera', 'click', () => { void startCamera(); });
    listen('closeCamera', 'click', () => closeCamera(true));
    listen('cameraPanel', 'cancel', event => { event.preventDefault(); closeCamera(true); });
    listen('cameraPanel', 'close', () => {
      if (!$('cameraPanel').open && state.camera.visible) closeCamera(true);
    });
    listen('capturePhoto', 'click', () => { void capturePhoto(); });
    listen('recordVoice', 'click', () => {
      if (state.voice && !state.voice.target) void stopRecording();
      else void startRecording();
    });
    listen('closeImageDialog', 'click', closeImage);
    listen('imageDialog', 'close', () => $('imageDialogPhoto').removeAttribute('src'));
    listen('cancelDelete', 'click', () => closeDelete());
    listen('confirmDelete', 'click', () => { void confirmDelete(); });
    listen('deleteDialog', 'cancel', event => { event.preventDefault(); closeDelete(); });
    listen('deleteDialog', 'close', () => { if (!$('deleteDialog').open) closeDelete(false, true); });
    ['submit', 'class', 'showcase'].forEach(kind => {
      listen(`tab-${kind}`, 'click', () => setView(kind));
      listen(`tab-${kind}`, 'keydown', event => {
        const kinds = ['submit', 'class', 'showcase'];
        let index = kinds.indexOf(kind);
        if (event.key === 'ArrowRight') index = (index + 1) % kinds.length;
        else if (event.key === 'ArrowLeft') index = (index + kinds.length - 1) % kinds.length;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = kinds.length - 1;
        else return;
        event.preventDefault(); setView(kinds[index]); $(`tab-${kinds[index]}`).focus();
      });
    });
    ['class', 'showcase'].forEach(kind => {
      const refresh = kind === 'class' ? 'refreshClass' : 'refreshShowcase';
      const retry = kind === 'class' ? 'retryClass' : 'retryShowcase';
      listen(refresh, 'click', () => { void loadList(kind); });
      listen(retry, 'click', () => { void loadList(kind); });
      listen(`${kind}Previous`, 'click', () => { if (!state[kind].loading && state[kind].page > 1) void loadList(kind, state[kind].page - 1); });
      listen(`${kind}Next`, 'click', () => { const list = state[kind]; if (!list.loading && list.page * list.pageSize < list.total) void loadList(kind, list.page + 1); });
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) void prepareToLeave(); });
    window.addEventListener('pagehide', () => { void prepareToLeave(); });
    window.addEventListener('beforeunload', event => {
      ink.finish(); returnToDraft(false); cancelDictation(); cancelTranscription(); cancelImages();
      closeCamera(); void stopRecording(false);
      if (hasContent() || state.sending || state.voice) { event.preventDefault(); event.returnValue = ''; }
    });
    setView(state.view, false);
    void connectContext();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
