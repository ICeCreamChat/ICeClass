'use strict';

const labels = {
  text: '正文', alertLevel: '通知级别', displayDurationSec: '显示时长（秒）', ttsSpeed: '语速',
  ttsVolume: '播放音量', quietAcknowledged: '确认禁言时间发送', targetClassName: '目标班级',
  name: '名称', displayName: '显示名称', enabled: '启用', start: '开始日期', end: '结束日期',
  startTime: '开始时间', endTime: '结束时间', revision: '配置版本', version: '记录版本',
  classNames: '班级', headClassNames: '班主任范围', teachingClassNames: '任课范围',
  status: '状态', message: '消息', reply: '回复', published: '公开', publishedTitle: '公开标题',
  publishedText: '公开摘要', role: '身份', subject: '学科', format: '文件格式', volume: '音量'
};
const statusLabels = {
  awaiting_confirmation: '待确认', awaiting_input: '等待补充资料', awaiting_client: '等待教师工作台',
  prepared: '等待执行', running: '正在执行', stopping: '正在停止', succeeded: '已完成',
  cancelled: '已取消', expired: '已过期', failed: '执行失败', unconfirmed: '结果未确认'
};
const opId = /^[A-Za-z0-9_-]{1,80}$/;

function showValue(value) {
  if (value === null) return '未设置';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value || '空';
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join('、') || '无';
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function operationView(value, formatTime) {
  if (!value || !opId.test(value.id || '')) return null;
  const parameters = value.parameters && typeof value.parameters === 'object' && !Array.isArray(value.parameters) ? value.parameters : null;
  const confirmable = value.kind === 'platform' && value.status === 'awaiting_confirmation' && Boolean(parameters)
    && !value.needsPassword && !value.input && typeof value.impact === 'string' && Boolean(value.title && value.target);
  const detail = value.result && (value.result.detail || value.result.error || value.result.message);
  return {
    id: value.id, status: value.status, statusText: statusLabels[value.status] || '状态未明',
    title: value.title || '班班操作', target: value.target || '目标未返回',
    created: value.createdAt ? formatTime(value.createdAt) : '',
    impact: value.impact || '', confirmable,
    cancellable: ['awaiting_confirmation', 'awaiting_input'].includes(value.status),
    unavailable: value.status === 'awaiting_confirmation' && !confirmable || value.status === 'awaiting_input',
    fields: Object.keys(parameters || {}).map(key => ({ key, label: labels[key] || key, value: showValue(parameters[key]) })),
    signature: JSON.stringify([value.kind, value.action, value.title, value.target, value.impact, parameters, value.status]),
    detail: typeof detail === 'string' ? detail : ''
  };
}

function messageView(item, key) {
  const content = String(item.content || '').split('\n当时的数据来源（追问时须重新查询）：', 1)[0];
  const cards = Array.isArray(item.cards) ? item.cards.filter(card => card && typeof card.title === 'string' && Array.isArray(card.metrics)).map((card, index) => ({
    key: index, title: card.title,
    scope: card.scope && card.scope.start && card.scope.end ? card.scope.start + ' 至 ' + card.scope.end : '',
    metrics: card.metrics.filter(metric => metric && typeof metric.label === 'string').map((metric, index) => ({
      key: index, label: metric.label, value: showValue(metric.value) +
        ({ seconds: ' 秒', times: ' 次', items: ' 条', classes: ' 个班', devices: ' 台', accounts: ' 个' }[metric.unit] || '')
    }))
  })) : [];
  return { key, role: item.role === 'user' ? 'user' : 'assistant', content, cards };
}

module.exports = { opId, operationView, messageView };
