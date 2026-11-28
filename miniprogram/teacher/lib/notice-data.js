'use strict';

const LEVELS = [
  { value: 'info', label: '普通', duration: 8 },
  { value: 'warning', label: '重要', duration: 12 },
  { value: 'urgent', label: '紧急', duration: 20 }
];
const DURATIONS = [5, 8, 10, 12, 15, 20, 30, 45, 60];
const STATUS_LABELS = {
  offline: '教室离线', sent: '已发往教室', received: '教室已收到',
  displayed: '已展示，待知晓', acknowledged: '教室已知晓', failed: '处理失败'
};
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

function validateWav(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  if (!bytes || typeof bytes.byteLength !== 'number' || bytes.byteLength < 44 || bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('请选择不超过 4 MB 的有效 WAV 文件。');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
  const tag = offset => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('文件内容不是 WAV，修改 MP3 或 M4A 的扩展名不能转换格式。');
  const end = view.getUint32(4, true) + 8;
  if (end > bytes.byteLength || end < 44) throw new Error('WAV 文件不完整，请重新选择。');
  let format = null;
  for (let offset = 12; offset + 8 <= end;) {
    const name = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > end) throw new Error('WAV 文件不完整，请重新选择。');
    if (name === 'fmt ') {
      if (size < 16) throw new Error('WAV 格式信息不完整。');
      format = {
        encoding: view.getUint16(start, true), channels: view.getUint16(start + 2, true),
        rate: view.getUint32(start + 4, true), byteRate: view.getUint32(start + 8, true),
        align: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true)
      };
    } else if (name === 'data') {
      if (!format || format.encoding !== 1 || format.channels !== 1 || format.bits !== 16 ||
          ![8000, 16000, 22050, 44100, 48000].includes(format.rate) ||
          format.align !== 2 || format.byteRate !== format.rate * 2 || size % 2 !== 0) {
        throw new Error('请使用 16 位 PCM 单声道 WAV，采样率为 8000、16000、22050、44100 或 48000 Hz。');
      }
      const durationMs = Math.round(size / 2 * 1000 / format.rate);
      if (durationMs < 500 || durationMs > 30000) throw new Error('教师原声时长应为 0.5-30 秒。');
      return { durationMs, size: bytes.byteLength };
    }
    offset = start + size + size % 2;
  }
  throw new Error('WAV 文件缺少音频数据。');
}

function buildNotice(data, selectedClass) {
  if (!selectedClass || !selectedClass.id || selectedClass.id !== data.classId) throw new Error('请选择有权限的目标班级。');
  const audio = data.modeIndex === 1;
  // The receiver skips speech generation for info notices, independently of volume.
  const level = audio ? LEVELS[data.levelIndex] : LEVELS[0];
  const duration = DURATIONS[data.durationIndex];
  if (!level || duration === undefined) throw new Error('通知参数不正确，请重新选择。');
  if (audio && level.value === 'info') throw new Error('教师原声请选择“重要”或“紧急”。');
  if (audio && (!data.audioFile || !data.audioFile.path)) throw new Error('请先录音或选择符合要求的 WAV 文件。');
  const originalText = String(data.text || ''), text = originalText.trim();
  if (!audio && (!text || Array.from(text).length > 500)) throw new Error('通知内容应为 1-500 个字符。');
  const values = {
    classId: selectedClass.id, alertLevel: level.value,
    ttsVolume: audio ? 1 : 0, ttsSpeed: 0,
    displayDurationSec: duration
  };
  if (!audio) values.text = text;
  return { values, className: selectedClass.name, originalText, audioFile: audio ? { ...data.audioFile } : null };
}

function confirmationText(notice, quietPeriod) {
  const values = notice.values, level = LEVELS.find(item => item.value === values.alertLevel);
  let mode = notice.audioFile ? '播放教师原声' : '静音展示';
  if (notice.audioFile && values.alertLevel === 'urgent') mode += '并突出显示';
  const lines = [`目标：${notice.className}`, `级别：${level.label}`, `${mode}，展示 ${values.displayDurationSec} 秒`];
  lines.push(notice.audioFile ? `原声：${notice.audioFile.name}（${(notice.audioFile.durationMs / 1000).toFixed(1)} 秒）` : `正文：${values.text}`);
  if (quietPeriod) {
    lines.push(`禁言时间：${quietPeriod.name || '上课时间'} ${quietPeriod.startTime || ''}-${quietPeriod.endTime || ''}（北京时间）`);
    lines.push(notice.audioFile ? '确认后将在禁言时间内播放声音。' : '确认后将在禁言时间内静音展示。');
  }
  lines.push(values.alertLevel === 'info' ? '通知将排队静音展示。' : '可能暂停正在展示的低等级通知。');
  lines.push('教室离线时不会补播。');
  return lines.join('\n');
}

function mapHistoryItem(item, formatTime) {
  // The server stores acknowledgement as displayed + acknowledged_at.
  const status = item.acknowledged_at ? 'acknowledged' : item.status;
  const level = LEVELS.find(value => value.value === item.alert_level);
  const timeline = [
    ['发出', item.created_at], ['收到', item.received_at],
    ['展示', item.displayed_at], ['知晓', item.acknowledged_at]
  ].filter(entry => entry[1] !== null && entry[1] !== undefined && entry[1] !== '')
    .map(entry => ({ label: entry[0], time: formatTime(entry[1]) }));
  return {
    id: item.id, classId: item.class_id, className: item.class_name, senderName: item.sender_name,
    text: item.content_type === 'audio' ? '教师原声' : item.text,
    typeLabel: item.content_type === 'audio' ? '教师原声' : '文字通知',
    audioDuration: item.content_type === 'audio' && item.audio_duration_ms != null ? `${(Number(item.audio_duration_ms) / 1000).toFixed(1)} 秒` : '',
    levelLabel: level ? level.label : '未知级别', status, statusLabel: STATUS_LABELS[status] || '未知状态',
    statusTone: ['displayed', 'acknowledged'].includes(status) ? 'good' : status === 'offline' ? 'warn' : status === 'failed' ? 'bad' : '',
    rawStatus: item.status || '', detail: item.status_detail || '',
    createdTime: item.created_at != null ? formatTime(item.created_at) : '',
    quietOverride: Number(item.quiet_override) === 1, timeline
  };
}

module.exports = { LEVELS, DURATIONS, STATUS_LABELS, MAX_AUDIO_BYTES, validateWav, buildNotice, confirmationText, mapHistoryItem };
