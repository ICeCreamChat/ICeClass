(() => {
  'use strict';

  const maxBytes = 2 * 1024 * 1024;
  const fullBounds = [0, 0, 1000, 1000];
  const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
  const requestKey = () => crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].join('-');

  function validBounds(bounds) {
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return false;
    const [x, y, w, h] = bounds;
    return x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1000 && y + h <= 1000;
  }

  function pixelRect([x, y, w, h], image) {
    const width = image.naturalWidth, height = image.naturalHeight;
    const left = Math.floor(x * width / 1000), top = Math.floor(y * height / 1000);
    return [left, top, Math.ceil((x + w) * width / 1000) - left, Math.ceil((y + h) * height / 1000) - top];
  }

  function reviewDraft(raw, subjectId, image) {
    const {type, options, text, answer, tags, bounds, reviewNote} = raw || {};
    if (!['single', 'multiple', 'boolean'].includes(type) || typeof text !== 'string' ||
        !Array.isArray(options) || options.length < 2 || options.length > (type === 'boolean' ? 2 : 4) ||
        !options.every(v => typeof v === 'string') || !Array.isArray(tags) || !tags.every(v => typeof v === 'string') ||
        !(answer === null || typeof answer === 'string' && answer.length > 0 &&
          (type === 'multiple' || answer.length === 1) && new Set(answer).size === answer.length &&
          [...answer].every(letter => 'ABCD'.slice(0, options.length).includes(letter)))) {
      throw new Error('识别返回的题目格式有误。可对照截图手动录题。');
    }
    if (!validBounds(bounds)) throw new Error('识别返回的题目范围无效。可对照截图手动录题。');
    return {
      value: {subjectId, type, text, options, answer, tags},
      rect: pixelRect(bounds, image),
      saveKey: requestKey(),
      note: typeof reviewNote === 'string' ? reviewNote.trim() : '',
      attach: true
    };
  }

  async function checkSignature(file) {
    const head = String.fromCharCode(...new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    const matches = file.type === 'image/png' ? head.startsWith('\x89PNG\r\n\x1a\n') :
      file.type === 'image/jpeg' ? head.startsWith('\xff\xd8\xff') : head.startsWith('RIFF') && head.slice(8) === 'WEBP';
    if (!matches) throw new Error('截图内容与文件格式不符，请选择 PNG、JPEG 或 WebP 图片。');
  }

  function encode(canvas, type) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) :
      reject(new Error('未能生成本题配图，可取消保留配图后保存。')), type, 0.92));
  }

  async function cropImage(image, rect) {
    const canvas = document.createElement('canvas');
    let width = rect[2], height = rect[3];
    // Keep the original pixel resolution and lossless text whenever it fits the upload API.
    try {
      let format = 'image/png';
      for (;;) {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法生成配图，可取消保留配图后保存。');
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, ...rect, 0, 0, width, height);
        let blob = await encode(canvas, format);
        if (blob.size <= maxBytes) return blob;
        if (format === 'image/png') {
          format = 'image/webp';
          blob = await encode(canvas, format);
          if (blob.size <= maxBytes) return blob;
        }
        const scale = Math.sqrt(maxBytes / blob.size) * 0.9;
        width = Math.max(1, Math.floor(width * scale));
        height = Math.max(1, Math.floor(height * scale));
      }
    } finally {
      canvas.width = canvas.height = 0;
    }
  }

  function release(source) {
    if (source?.url) {
      URL.revokeObjectURL(source.url);
      source.url = '';
    }
  }

  class QuestionImport {
    kind = 'import';
    drafts = [];
    index = 0;
    saved = 0;

    constructor(subjectId, readFile) {
      this.subjectId = subjectId;
      this.readFile = readFile;
    }

    get current() { return this.drafts[this.index]; }
    get value() { return this.current?.value; }

    cancelRequest() {
      this.request?.abort();
      this.request = null;
    }

    async selectFile(file) {
      this.cancelRequest();
      release(this.pending);
      this.pending = null;
      if (!imageTypes.includes(file.type) || !file.size || file.size > maxBytes) {
        throw new Error('截图仅支持 PNG、JPEG、WebP，单张最多 2 MiB。');
      }
      const source = {url: URL.createObjectURL(file), image: new Image()};
      this.pending = source;
      try {
        await checkSignature(file);
        if (this.pending !== source) return false;
        source.image.src = source.url;
        const [dataUrl] = await Promise.all([this.readFile(file), source.image.decode().catch(() => {
          throw new Error('截图无法读取，请换一张图片。');
        })]);
        if (this.pending !== source) return false;
        release(this.source);
        source.dataUrl = dataUrl;
        this.source = source;
        this.requestKey = null;
        return true;
      } catch (error) {
        if (this.pending !== source) return false;
        throw error;
      } finally {
        if (this.pending === source) this.pending = null;
        if (this.source !== source) release(source);
      }
    }

    async recognize(api, isCurrent) {
      if (!this.source || this.pending || this.request || this.current) return false;
      const request = this.request = new AbortController();
      try {
        this.requestKey ||= requestKey();
        const result = await api('/questions/recognize', 'POST', {
          subjectId: this.subjectId, dataUrl: this.source.dataUrl, requestKey: this.requestKey
        }, request.signal);
        if (this.request !== request || !isCurrent()) return false;
        this.requestKey = null;
        if (!Array.isArray(result?.drafts) || !result.drafts.length || result.drafts.length > 8) {
          throw new Error('未得到 1-8 道可审阅的题目。可对照截图手动录题。');
        }
        this.drafts = result.drafts.map(raw => reviewDraft(raw, this.subjectId, this.source.image));
        return true;
      } catch (error) {
        if (this.request !== request || !isCurrent()) return false;
        // A lost response reuses the receipt. A confirmed terminal result needs a new, explicit attempt.
        if ([410,422,502,504].includes(error.status) && error.data?.code?.startsWith('recognition_')) this.requestKey = null;
        if (error instanceof TypeError) throw new Error('未收到识别结果，截图已保留。可重试识别或手动录题。');
        throw error;
      } finally {
        if (this.request === request) this.request = null;
      }
    }

    manual() {
      this.cancelRequest();
      this.drafts = [reviewDraft({type: 'single', text: '', options: ['', '', '', ''], answer: null,
        tags: [], bounds: fullBounds}, this.subjectId, this.source.image)];
    }

    async imageData() {
      const draft = this.current, {image, dataUrl} = this.source;
      const [x, y, w, h] = draft.rect;
      if (x === 0 && y === 0 && w === image.naturalWidth && h === image.naturalHeight) return dataUrl;
      if (!draft.cropData) draft.cropData = await this.readFile(await cropImage(image, draft.rect));
      return draft.cropData;
    }

    dispose() {
      this.cancelRequest();
      release(this.pending);
      release(this.source);
      this.pending = this.source = null;
      this.drafts = [];
    }
  }

  window.ICeClassQuestionImport = QuestionImport;
})();
