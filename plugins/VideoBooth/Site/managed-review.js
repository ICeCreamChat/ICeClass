const verdicts = { correct: '作答正确', incorrect: '有需修正的地方', incomplete: '还差一步', uncertain: '暂无法判断' };
const states = { preparing: '正在准备点评…', analysing: '正在点评…', awaiting_selection: '请框选本次题目', error: '点评失败，请继续展示后重试。' };

// Copy from the single existing video element. Never capture a window or acquire another stream.
export function captureFrame(video, { rotation = 0, mirrored = false, lastFrameAt, now = performance.now(), createCanvas = () => document.createElement('canvas') }) {
  if (!video.videoWidth || !video.videoHeight || !Number.isFinite(lastFrameAt) || now - lastFrameAt > 2000 || now < lastFrameAt)
    throw new Error('当前没有新鲜画面，请等待摄像头恢复后重试。');
  if (![0, 90, 180, 270].includes(rotation)) throw new Error('画面方向无效。');
  const rawWidth = video.videoWidth, rawHeight = video.videoHeight;
  const width = rotation % 180 ? rawHeight : rawWidth, height = rotation % 180 ? rawWidth : rawHeight;
  const scale = Math.min(1, 1920 / Math.max(width, height));
  const capturedAt = Date.now();
  const canvas = createCanvas();
  canvas.width = Math.max(1, Math.floor(width * scale)); canvas.height = Math.max(1, Math.floor(height * scale));
  const context = canvas.getContext('2d');
  context.translate(canvas.width / 2, canvas.height / 2);
  // Match VideoOrientation's rotate(...) scaleX(...), including the current mirror.
  context.rotate(rotation * Math.PI / 180); context.scale(mirrored ? -1 : 1, 1);
  const targetWidth = rotation % 180 ? canvas.height : canvas.width, targetHeight = rotation % 180 ? canvas.width : canvas.height;
  context.drawImage(video, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
  const bytes = base64.length * 3 / 4 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (!dataUrl.startsWith('data:image/png;base64,') || bytes > 2 * 1024 * 1024)
    throw new Error('画面超过2 MiB，请调整展示范围或镜头后重试。');
  return { dataUrl, width: canvas.width, height: canvas.height, capturedAt, rotation, mirrored };
}

export class ManagedReview {
  constructor(send, render, generation = 0) { this.send = send; this.render = render; this.generation = generation; this.clear(); }
  advance() { if (!Number.isSafeInteger(this.generation) || this.generation >= Number.MAX_SAFE_INTEGER) throw new Error('点评代次无效，请重新打开展台。'); this.generation++; }
  requireCurrent(payload, requireActive = true) {
    if (!Number.isSafeInteger(payload?.generation) || payload.generation < 0 || payload.generation !== this.generation || requireActive && !this.active)
      throw new Error('本次点评已失效，请重新点击AI 点评。');
  }
  clear() { this.active = false; this.frame = null; this.render({ frame: null, title: '', message: '', knowledgePoints: [], busy: false, active: false }); }
  request() { if (this.active) return; this.advance(); this.active = true; this.render({ frame: this.frame, title: '', message: states.preparing, knowledgePoints: [], busy: true, active: true }); this.send('review_requested', { generation: this.generation }); }
  freeze(frame, payload) { this.requireCurrent(payload); this.frame = { ...frame, generation: this.generation }; this.render({ frame: this.frame, title: '', message: states.analysing, knowledgePoints: [], busy: true, active: true }); return this.frame; }
  invalidate(reason) { this.advance(); this.clear(); this.send('review_invalidated', { reason, generation: this.generation }); }
  resume() { this.advance(); this.clear(); this.send('resume_requested', { generation: this.generation }); }
  hostResume(payload) { this.requireCurrent(payload, false); if (this.active) { this.advance(); this.clear(); } }
  question() { if (this.active && this.frame) this.send('question_requested', { generation: this.generation }); }
  update(payload) {
    if (!payload || !['preparing', 'analysing', 'awaiting_selection', 'complete', 'error'].includes(payload.state)) throw new Error('点评状态无效。');
    this.requireCurrent(payload);
    let title = '', message = payload.message || states[payload.state] || '', knowledgePoints = [];
    if (typeof message !== 'string' || [...message].length > 120) throw new Error('点评正文不能超过120字。');
    if (payload.state === 'complete') {
      if (!this.frame) throw new Error('本次作答尚未固定，不能显示点评。');
      if (!Object.hasOwn(verdicts, payload.verdict)) throw new Error('点评结论无效。');
      title = verdicts[payload.verdict];
      if (![payload.strength, payload.nextStep].every(value => value == null || typeof value === 'string')) throw new Error('点评正文无效。');
      message = [payload.strength, payload.nextStep].filter(Boolean).join('');
      if ([...message].length > 120) throw new Error('点评正文不能超过120字。');
      knowledgePoints = payload.knowledgePoints;
      if (!Array.isArray(knowledgePoints) || knowledgePoints.length > 2 || (payload.verdict !== 'uncertain' && knowledgePoints.length < 1)
          || knowledgePoints.some(point => typeof point !== 'string' || !point.trim() || [...point].length > 24)) throw new Error('点评知识点无效。');
    }
    this.render({ frame: this.frame, title, message, knowledgePoints, busy: payload.state !== 'complete' && payload.state !== 'error', active: true });
  }
}
