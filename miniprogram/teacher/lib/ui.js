'use strict';
const api = require('./api');
const appearanceKey = 'iceclass.teacher.appearance';
const appearances = [
  { id: 'glass', label: '液态玻璃', bar: '#eaf4fc', background: '#e5f0f8' },
  { id: 'white', label: '原版白色', bar: '#f8fafc', background: '#f5f6f8' },
  { id: 'solid', label: '降低透明度', bar: '#edf4fa', background: '#edf4fa' }
];
let activeAppearance;

function applyAppearance(page, requested) {
  if (requested !== undefined) activeAppearance = appearances.find(item => item.id === requested);
  if (!activeAppearance) {
    try {
      const saved = wx.getStorageSync(appearanceKey);
      activeAppearance = saved && saved.version === 1 && appearances.find(item => item.id === saved.mode);
    } catch (_) { /* Use the default if local preferences cannot be read. */ }
    activeAppearance = activeAppearance || appearances[0];
  }
  if (!page || typeof page.setData !== 'function') return activeAppearance.id;
  if (page.data.appearance !== activeAppearance.id) page.setData({ appearance: activeAppearance.id });
  if (typeof wx.setNavigationBarColor === 'function') wx.setNavigationBarColor({ frontColor: '#000000', backgroundColor: activeAppearance.bar });
  if (typeof wx.setBackgroundColor === 'function') wx.setBackgroundColor({ backgroundColor: activeAppearance.background });
  return activeAppearance.id;
}

function setAppearance(page, selected) {
  const mode = applyAppearance(page, selected);
  try { wx.setStorageSync(appearanceKey, { version: 1, mode }); return true; }
  catch (_) { return false; }
}

function relogin() {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  if (pages.length && pages[pages.length - 1].route === 'pages/login/index') return;
  wx.navigateTo({ url: '/pages/login/index' });
}

function requireLogin() {
  const user = api.getUser();
  if (user) {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const page = pages[pages.length - 1];
    if (page && page._iceclassOwner && page._iceclassOwner !== user.id) {
      wx.reLaunch({ url: '/pages/workbench/index' });
      return false;
    }
    if (page) { page._iceclassOwner = user.id; applyAppearance(page); }
    return true;
  }
  relogin();
  return false;
}

async function loadClasses(page, isCurrent = () => true) {
  const generation = page._generation;
  const owner = api.getUser();
  const data = await api.request('/api/classes');
  const current = api.getUser();
  if (!isCurrent() || generation !== page._generation || !owner || !current || owner.id !== current.id) return [];
  if (!Array.isArray(data.classes)) throw new Error('班级列表格式异常，请稍后重试。');
  const classes = data.classes.filter(item => item.enabled !== 0 && item.enabled !== false);
  const saved = api.getClassId() || page.data.classId;
  const index = Math.max(0, classes.findIndex(item => item.id === saved));
  const selected = classes[index];
  if (selected) api.selectClass(selected.id);
  else api.selectClass('');
  page.setData({ classes, classNames: classes.map(item => item.name), classIndex: index, classId: selected ? selected.id : '' });
  return classes;
}

function chooseClass(page, value) {
  const index = Number(value);
  const selected = page.data.classes && page.data.classes[index];
  if (!selected) return null;
  api.selectClass(selected.id);
  page.setData({ classIndex: index, classId: selected.id });
  return selected;
}

function fail(page, error) {
  if (error && error.code === 'session_changed') return;
  page.setData({ error: error && error.message || '暂时无法完成操作，请重试。', sessionExpired: Boolean(error && error.status === 401) });
}

function query(values) {
  return Object.keys(values).filter(key => values[key] !== undefined && values[key] !== null && values[key] !== '')
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(Array.isArray(values[key]) ? values[key].join(',') : values[key])}`).join('&');
}

function confirm(title, content, confirmText = '确定') {
  return new Promise(resolve => wx.showModal({ title, content, confirmText, cancelText: '取消', success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
}

function beijingDate(timestamp) { return new Date(timestamp + 8 * 3600000); }
const pad = number => String(number).padStart(2, '0');
function dateISO(offsetDays = 0) { return beijingDate(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10); }
function formatTime(value) {
  if (value === null || value === undefined || value === '') return '-';
  const timestamp = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(timestamp)) return '-';
  const date = beijingDate(timestamp);
  return `${date.toISOString().slice(0, 10)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function toast(title) { wx.showToast({ title, icon: 'none' }); }
function setDirty(dirty) {
  if (dirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '当前内容尚未保存。' });
  else if (!dirty && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
}

module.exports = { requireLogin, relogin, loadClasses, chooseClass, fail, query, confirm, formatTime, dateISO, toast, setDirty, applyAppearance, setAppearance, appearances };
