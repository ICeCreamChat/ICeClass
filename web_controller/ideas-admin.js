(() => {
  'use strict';

  const statuses = {
    pending: '待评审', adopted: '已采纳', implementing: '实现中',
    launched: '已上线', declined: '暂不采纳'
  };
  const publishable = new Set(['adopted', 'implementing', 'launched']);
  const pageSize = 20;
  let config = {}, root, refs = {}, owner = '';
  let items = [], total = 0, page = 1, status = '', classId = '';
  let selected = null, draft = null, latestReview = null;
  let busy = false, saving = false, reloading = false, conflict = false;
  let listError = '', listRequest = 0, summaryRequest = 0, detailRequest = 0, editRevision = 0;

  function context() {
    const app = window.ICeClass || {};
    return {
      api: config.api || app.api,
      user: config.user === undefined ? app.state?.user : config.user,
      classes: config.classes || app.state?.classes || []
    };
  }

  function allowed(user = context().user) {
    return user?.role === 'superadmin' && !user.classroom
      && window.ICeClassVoiceHost?.classroomAccount !== true;
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function button(text, handler, primary = false) {
    const element = node('button', text, primary ? 'btn primary' : 'btn');
    element.type = 'button';
    element.addEventListener('click', handler);
    return element;
  }

  function selectControl(id, label, entries) {
    const wrap = node('div', undefined, 'ideas-field');
    const caption = node('label', label);
    caption.htmlFor = id;
    const control = node('select');
    control.id = id;
    control.name = id;
    control.autocomplete = 'off';
    entries.forEach(([value, text]) => {
      const option = node('option', text);
      option.value = value;
      control.append(option);
    });
    wrap.append(caption, control);
    return { wrap, control };
  }

  function editable(item) {
    return {
      status: item.status, reply: item.reply || '', published: Boolean(item.published),
      publishedTitle: item.publishedTitle || '', publishedText: item.publishedText || ''
    };
  }

  function dirty() {
    return Boolean(selected && draft && JSON.stringify(draft) !== JSON.stringify(editable(selected)));
  }

  function notify(text, error = false) {
    if (!refs.feedback) return;
    refs.feedback.textContent = text;
    refs.feedback.classList.toggle('ideas-error', error);
    refs.feedback.setAttribute('role', error ? 'alert' : 'status');
  }

  function canLeave() {
    if (saving || reloading) {
      notify(saving ? '正在保存评审，请稍候。' : '正在载入最新版本，请稍候。');
      return false;
    }
    if (!dirty()) return true;
    return window.confirm('当前评审尚未保存，离开后草稿仍会保留在本页。继续吗？');
  }

  function canLogout() {
    if (saving || reloading) return canLeave();
    return !dirty() || window.confirm('退出登录将丢弃当前未保存的评审草稿，退出后无法恢复。确定退出登录吗？');
  }

  function discardChanges() {
    if (saving || reloading) return canLeave();
    if (!dirty()) return true;
    if (!window.confirm('当前评审尚未保存，离开将丢弃这些修改。继续吗？')) return false;
    draft = editable(selected);
    conflict = false;
    latestReview = null;
    editRevision++;
    renderDetail();
    return true;
  }

  function formatTime(value) {
    if (value === null || value === undefined || value === '') return '未记录';
    const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
    if (!Number.isFinite(date.getTime())) return '未记录';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function timestamp(value) {
    const element = node('time', formatTime(value));
    const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
    if (value && Number.isFinite(date.getTime())) {
      element.dateTime = date.toISOString();
      element.title = date.toLocaleString('zh-CN', { hour12: false });
    }
    return element;
  }

  function badge(value) {
    return node('span', statuses[value] || '待评审', `ideas-status ideas-status-${statuses[value] ? value : 'pending'}`);
  }

  function titleOf(item) {
    return item.title || item.text?.trim().split('\n')[0].slice(0, 80)
      || ((item.media || []).some(media => media.kind === 'image') ? '照片创意' : '语音创意');
  }

  function mount() {
    root.classList.add('ideas-admin');
    root.setAttribute('aria-label', '创意计划');
    const heading = node('header', undefined, 'ideas-heading');
    heading.append(node('h1', '创意计划'));
    refs.counts = node('p', '正在加载统计…', 'ideas-counts');
    refs.counts.setAttribute('role', 'status');
    heading.append(refs.counts);

    const filters = node('div', undefined, 'ideas-filters');
    const statusField = selectControl('ideasStatusFilter', '状态', [['', '全部状态'], ...Object.entries(statuses)]);
    const classField = selectControl('ideasClassFilter', '班级', [['', '全部班级']]);
    refs.statusFilter = statusField.control;
    refs.classFilter = classField.control;
    refs.refresh = button('刷新', () => { void load(); });
    filters.append(statusField.wrap, classField.wrap, refs.refresh);
    refs.statusFilter.addEventListener('change', () => changeFilter('status'));
    refs.classFilter.addEventListener('change', () => changeFilter('class'));

    refs.digest = node('p', '正在加载每日汇总状态…', 'ideas-digest');
    refs.digest.setAttribute('role', 'status');
    const workspace = node('div', undefined, 'ideas-workspace');
    const listPanel = node('section', undefined, 'ideas-list-panel');
    const listHeading = node('div', undefined, 'ideas-list-heading');
    const listTitle = node('h2', '学生创意');
    listTitle.id = 'ideasListTitle';
    listTitle.tabIndex = -1;
    refs.listTitle = listTitle;
    listPanel.setAttribute('aria-labelledby', listTitle.id);
    refs.filteredCount = node('span', '', 'ideas-subtle');
    listHeading.append(listTitle, refs.filteredCount);
    refs.list = node('div', undefined, 'ideas-list-body');
    refs.list.setAttribute('aria-live', 'polite');
    refs.pagination = node('nav', undefined, 'ideas-pagination');
    refs.pagination.setAttribute('aria-label', '创意列表分页');
    refs.previous = button('上一页', () => changePage(page - 1));
    refs.next = button('下一页', () => changePage(page + 1));
    refs.pageInfo = node('span', '', 'ideas-page-info');
    refs.pagination.append(refs.previous, refs.pageInfo, refs.next);
    listPanel.append(listHeading, refs.list, refs.pagination);
    refs.detail = node('section', undefined, 'ideas-detail');
    refs.detail.setAttribute('aria-label', '创意详情与评审');
    workspace.append(listPanel, refs.detail);

    refs.lightbox = node('dialog', undefined, 'ideas-lightbox');
    refs.lightbox.setAttribute('aria-labelledby', 'ideasPhotoTitle');
    const photoBar = node('div', undefined, 'ideas-photo-bar');
    const photoTitle = node('h2', '创意照片');
    photoTitle.id = 'ideasPhotoTitle';
    photoBar.append(photoTitle, button('关闭', () => refs.lightbox.close()));
    refs.photo = node('img');
    refs.photo.alt = '创意照片预览';
    refs.photo.width = 960;
    refs.photo.height = 640;
    refs.photo.addEventListener('load', () => {
      refs.photo.width = refs.photo.naturalWidth;
      refs.photo.height = refs.photo.naturalHeight;
    });
    refs.photoError = node('p', '', 'ideas-error');
    refs.photoError.setAttribute('role', 'alert');
    refs.photo.addEventListener('error', () => {
      refs.photo.hidden = true;
      refs.photoError.textContent = '照片暂时无法显示，请关闭后重试。';
    });
    refs.lightbox.addEventListener('click', event => {
      if (event.target === refs.lightbox) {
        const bounds = refs.lightbox.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom) refs.lightbox.close();
      }
    });
    refs.lightbox.append(photoBar, refs.photo, refs.photoError);
    root.replaceChildren(heading, filters, refs.digest, workspace, refs.lightbox);
    fillClasses();
    renderList();
    renderDetail();
  }

  function fillClasses() {
    if (!refs.classFilter) return;
    const all = node('option', '全部班级');
    all.value = '';
    refs.classFilter.replaceChildren(all);
    context().classes.forEach(item => {
      const option = node('option', item.name);
      option.value = String(item.id);
      refs.classFilter.append(option);
    });
    // Retain a selected retired class until the reviewer changes the filter.
    if (classId && !context().classes.some(item => String(item.id) === classId)) {
      const option = node('option', selected?.className || '原班级');
      option.value = classId;
      refs.classFilter.append(option);
    }
    refs.classFilter.value = classId;
  }

  function renderList() {
    if (!refs.list) return;
    refs.list.setAttribute('aria-busy', String(busy));
    refs.filteredCount.textContent = `共 ${total} 条`;
    refs.statusFilter.value = status;
    refs.classFilter.value = classId;
    refs.refresh.disabled = busy || saving || reloading;
    refs.statusFilter.disabled = saving || reloading;
    refs.classFilter.disabled = saving || reloading;
    refs.previous.disabled = busy || saving || reloading || page <= 1;
    refs.next.disabled = busy || saving || reloading || page * pageSize >= total;
    refs.pageInfo.textContent = `第 ${page} / ${Math.max(1, Math.ceil(total / pageSize))} 页`;
    refs.list.replaceChildren();
    if (listError) {
      const error = node('div', undefined, 'ideas-state');
      const message = node('p', listError, 'ideas-error');
      message.setAttribute('role', 'alert');
      error.append(message, button('重试', () => { void fetchList(true); void fetchSummary(); }));
      refs.list.append(error);
      return;
    }
    if (!items.length) {
      refs.list.append(node('p', busy ? '正在加载创意…' : '没有符合条件的创意，可调整状态或班级筛选。', 'ideas-state'));
      return;
    }
    const list = node('ul', undefined, 'ideas-list');
    items.forEach(item => {
      const row = node('li');
      const entry = button('', () => selectItem(item));
      entry.className = 'ideas-entry';
      entry.disabled = busy || saving || reloading;
      if (selected?.id === item.id) entry.setAttribute('aria-current', 'true');
      const top = node('span', undefined, 'ideas-entry-top');
      top.append(node('strong', titleOf(item)), badge(item.status));
      const meta = node('span', undefined, 'ideas-entry-meta');
      meta.append(node('span', `${item.className || '未命名班级'} · ${item.name || '未署名'}`), timestamp(item.createdAt));
      const preview = node('span', item.text || '查看照片或语音，了解这条创意。', 'ideas-entry-preview');
      entry.append(top, meta, preview);
      const media = item.media || [];
      const images = media.filter(value => value.kind === 'image').length;
      const audio = media.filter(value => value.kind === 'audio').length;
      if (images || audio || item.published) {
        entry.append(node('span', [images && `${images} 张照片`, audio && `${audio} 段语音`, item.published && '已公开'].filter(Boolean).join(' · '), 'ideas-entry-media'));
      }
      row.append(entry);
      list.append(row);
    });
    refs.list.append(list);
  }

  function selectItem(item) {
    if (selected?.id === item.id || !discardChanges()) return;
    detailRequest++;
    editRevision++;
    selected = item;
    draft = editable(item);
    conflict = false;
    latestReview = null;
    renderList();
    renderDetail();
    refs.detailTitle?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 760px)').matches) refs.detail.scrollIntoView({ block: 'start' });
  }

  function mediaUrl(media) {
    try {
      const url = new URL(media.url, window.location.href);
      return url.origin === window.location.origin && !url.search && !url.hash
        && /^\/api\/ideas\/media\/[a-zA-Z0-9_-]+$/.test(url.pathname) ? url.pathname : '';
    } catch { return ''; }
  }

  function renderMedia(container, item) {
    const media = item.media || [];
    const photos = node('div', undefined, 'ideas-photos');
    let photoIndex = 0;
    media.forEach(value => {
      const url = mediaUrl(value);
      if (!url || !['image', 'audio'].includes(value.kind)) return;
      if (value.kind === 'image') {
        const index = ++photoIndex;
        const preview = button('', () => {
          refs.photo.hidden = false;
          refs.photoError.textContent = '';
          refs.photo.alt = `学生提交的第 ${index} 张照片`;
          refs.photo.src = url;
          refs.lightbox.showModal();
        });
        preview.className = 'ideas-photo';
        preview.setAttribute('aria-label', `查看照片 ${index}`);
        const image = node('img');
        image.alt = '';
        image.loading = 'lazy';
        image.width = 106;
        image.height = 86;
        image.src = url;
        image.addEventListener('error', () => preview.replaceChildren(node('span', '照片加载失败，点击重试')));
        preview.append(image);
        photos.append(preview);
      } else {
        const wrap = node('div', undefined, 'ideas-audio');
        const seconds = Number(value.durationMs) / 1000;
        wrap.append(node('span', `学生语音${Number.isFinite(seconds) && seconds > 0 ? ` · ${Math.ceil(seconds)} 秒` : ''}`, 'ideas-subtle'));
        const audio = node('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = url;
        audio.setAttribute('aria-label', '学生提交的创意语音');
        const failure = node('p', '', 'ideas-error');
        failure.setAttribute('role', 'alert');
        audio.addEventListener('error', () => { failure.textContent = '语音暂时无法播放，请刷新后重试。'; });
        wrap.append(audio, failure);
        container.append(wrap);
      }
    });
    if (photos.childElementCount) container.prepend(photos);
  }

  function textField(form, id, label, value, multiline = false) {
    const wrap = node('div', undefined, 'ideas-field');
    const caption = node('label', label);
    caption.htmlFor = id;
    const input = node(multiline ? 'textarea' : 'input');
    input.id = id;
    if (multiline) input.rows = 3;
    else input.type = 'text';
    input.name = id;
    input.autocomplete = 'off';
    input.value = value;
    wrap.append(caption, input);
    form.append(wrap);
    return input;
  }

  function renderDetail() {
    if (!refs.detail) return;
    refs.detail.querySelectorAll('audio').forEach(audio => audio.pause());
    refs.detail.replaceChildren();
    refs.feedback = null;
    if (!selected) {
      refs.detail.append(node('p', '选择一条学生创意，查看内容并回复评审。', 'ideas-state ideas-detail-empty'));
      return;
    }
    const back = button('返回列表', () => {
      refs.listTitle.focus({ preventScroll: true });
      refs.listTitle.scrollIntoView({ block: 'start' });
    });
    back.classList.add('ideas-back');
    const header = node('header', undefined, 'ideas-detail-header');
    header.append(back);
    const detailHeading = node('div', undefined, 'ideas-detail-heading');
    refs.detailTitle = node('h2', titleOf(selected));
    refs.detailTitle.tabIndex = -1;
    detailHeading.append(refs.detailTitle, badge(selected.status));
    const identity = node('p', `${selected.className || '未命名班级'} · ${selected.name || '未署名'}`, 'ideas-identity');
    const dates = node('p', undefined, 'ideas-dates');
    dates.append(node('span', '提交 '), timestamp(selected.createdAt), node('span', ' · 更新 '), timestamp(selected.updatedAt));
    header.append(detailHeading, identity, dates);
    refs.detail.append(header);
    const submission = node('div', undefined, 'ideas-submission');
    if (selected.text) submission.append(node('p', selected.text, 'ideas-original-text'));
    const attachments = node('div', undefined, 'ideas-attachments');
    renderMedia(attachments, selected);
    if (attachments.childElementCount) submission.append(attachments);
    if (submission.childElementCount) refs.detail.append(submission);

    const form = node('form', undefined, 'ideas-review');
    form.noValidate = true;
    form.append(node('h3', '评审回复'));
    const statusField = selectControl('ideasReviewStatus', '处理状态', Object.entries(statuses));
    refs.reviewStatus = statusField.control;
    refs.reviewStatus.value = draft.status;
    form.append(statusField.wrap);
    refs.reply = textField(form, 'ideasReply', '给学生的回复', draft.reply, true);
    refs.reply.placeholder = '例如：已采纳，预计下周开始实现…';
    const publishLabel = node('label', undefined, 'ideas-publish-toggle');
    refs.publish = node('input');
    refs.publish.type = 'checkbox';
    refs.publish.checked = draft.published;
    refs.publish.id = 'ideasPublished';
    refs.publish.name = 'published';
    publishLabel.append(refs.publish, node('span', '全校展示'));
    const publication = node('div', undefined, 'ideas-publication');
    refs.publishHint = node('p', '', 'ideas-subtle ideas-publish-hint');
    refs.publishHint.id = 'ideasPublishHint';
    refs.publish.setAttribute('aria-describedby', refs.publishHint.id);
    publication.append(publishLabel, refs.publishHint);
    form.append(publication);
    refs.publicFields = node('div', undefined, 'ideas-public-fields');
    refs.publicTitle = textField(refs.publicFields, 'ideasPublicTitle', '公开标题', draft.publishedTitle);
    refs.publicText = textField(refs.publicFields, 'ideasPublicText', '公开摘要', draft.publishedText, true);
    form.append(refs.publicFields);
    if (latestReview) {
      const comparison = node('details', undefined, 'ideas-latest-review');
      comparison.open = true;
      comparison.append(node('summary', '最新评审内容（当前草稿已保留）'));
      comparison.append(node('p', `处理状态：${statuses[latestReview.status] || latestReview.status}`));
      comparison.append(node('p', `给学生的回复：${latestReview.reply || '未填写'}`));
      comparison.append(node('p', `全校展示：${latestReview.published ? '是' : '否'}`));
      if (latestReview.published) {
        comparison.append(node('p', `公开标题：${latestReview.publishedTitle || '未填写'}`));
        comparison.append(node('p', `公开摘要：${latestReview.publishedText || '未填写'}`));
      }
      form.append(comparison);
    }
    refs.feedback = node('p', '', 'ideas-feedback');
    refs.feedback.id = 'ideasReviewFeedback';
    refs.feedback.tabIndex = -1;
    refs.feedback.setAttribute('role', 'status');
    refs.feedback.setAttribute('aria-live', 'polite');
    const actions = node('div', undefined, 'ideas-review-actions');
    refs.save = button('保存评审', () => {}, true);
    refs.save.type = 'submit';
    refs.draftNote = node('span', '', 'ideas-subtle');
    refs.reload = button('载入最新版本', () => { void reloadLatest(); });
    const saveStatus = node('div', undefined, 'ideas-save-status');
    saveStatus.append(refs.feedback, refs.draftNote);
    const saveButtons = node('div', undefined, 'ideas-save-buttons');
    saveButtons.append(refs.reload, refs.save);
    actions.append(saveStatus, saveButtons);
    form.append(actions);
    refs.detail.append(form);
    [[refs.reply, 'reply'], [refs.publicTitle, 'publishedTitle'], [refs.publicText, 'publishedText']].forEach(([input, key]) => {
      input.addEventListener('input', () => {
        draft[key] = input.value;
        editRevision++;
        input.removeAttribute('aria-invalid');
        if (!conflict) notify('');
        updateEditor();
      });
    });
    refs.reviewStatus.addEventListener('change', () => {
      draft.status = refs.reviewStatus.value;
      if (!publishable.has(draft.status)) draft.published = false;
      editRevision++;
      if (!conflict) notify('');
      updateEditor();
    });
    refs.publish.addEventListener('change', () => {
      draft.published = refs.publish.checked && publishable.has(draft.status);
      editRevision++;
      if (!conflict) notify('');
      updateEditor();
    });
    form.addEventListener('submit', event => { event.preventDefault(); void save(); });
    updateEditor();
  }

  function updateEditor() {
    if (!selected || !refs.save) return;
    const locked = saving || reloading;
    [refs.reviewStatus, refs.reply, refs.publicTitle, refs.publicText].forEach(input => { input.disabled = locked; });
    refs.publish.disabled = locked || !publishable.has(draft.status);
    refs.publish.checked = draft.published;
    refs.publicFields.hidden = !draft.published;
    refs.publicTitle.required = draft.published;
    refs.publicText.required = draft.published;
    refs.publishHint.textContent = publishable.has(draft.status)
      ? '公开仅展示班级、状态、公开标题和摘要。' : '已采纳、实现中、已上线的创意可公开。';
    refs.save.disabled = locked || conflict || !dirty();
    refs.save.textContent = saving ? '正在保存…' : '保存评审';
    refs.reload.hidden = !conflict;
    refs.reload.disabled = locked;
    refs.reload.textContent = reloading ? '正在载入…' : '载入最新版本';
    refs.draftNote.textContent = dirty() ? '有未保存的修改' : '已保存';
  }

  function changeFilter(kind) {
    const nextStatus = refs.statusFilter.value, nextClass = refs.classFilter.value;
    if (!discardChanges()) {
      refs.statusFilter.value = status;
      refs.classFilter.value = classId;
      return;
    }
    if (kind === 'status') status = nextStatus;
    else classId = nextClass;
    page = 1;
    void fetchList();
  }

  function changePage(next) {
    if (next < 1 || next > Math.max(1, Math.ceil(total / pageSize)) || !discardChanges()) return;
    page = next;
    void fetchList();
  }

  async function fetchList(keepSelection = false) {
    if (!allowed()) return;
    const request = ++listRequest, selection = detailRequest, edits = editRevision, user = context().user;
    busy = true;
    listError = '';
    renderList();
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) query.set('status', status);
      if (classId) query.set('classId', classId);
      const data = await context().api(`/api/ideas/admin?${query}`);
      if (request !== listRequest || !allowed() || context().user !== user) return;
      const lastPage = Math.max(1, Math.ceil(data.total / pageSize));
      if (page > lastPage) { page = lastPage; return await fetchList(keepSelection); }
      items = data.items;
      total = data.total;
      if ((!keepSelection || !selected) && selection === detailRequest && edits === editRevision) {
        selected = items.find(item => item.id === selected?.id) || items[0] || null;
        draft = selected ? editable(selected) : null;
        conflict = false;
        latestReview = null;
        detailRequest++;
        renderDetail();
      }
    } catch (error) {
      if (request !== listRequest || !allowed()) return;
      listError = error.message || '创意加载失败，请重试。';
    } finally {
      if (request === listRequest) { busy = false; renderList(); }
    }
  }

  async function fetchSummary() {
    if (!allowed()) return;
    const request = ++summaryRequest;
    try {
      const data = await context().api('/api/ideas/admin/summary');
      if (request !== summaryRequest || !allowed()) return;
      refs.counts.textContent = `待评审 ${data.pending} · 共 ${data.total} 条 · 已公开 ${data.published} 条`;
      const digest = data.digest || {};
      let schedule = !digest.enabled ? '每日 18:00 汇总 · 未启用'
        : !digest.configured ? '每日 18:00 汇总 · 待配置邮件服务'
          : `每日 18:00 汇总${digest.nextAt ? ` · 下次 ${formatTime(digest.nextAt)}` : ' · 已启用'}`;
      if (digest.lastSentAt) schedule += ` · 最近发送 ${formatTime(digest.lastSentAt)}`;
      if (digest.lastError) schedule += ' · 最近发送失败，请检查服务端邮件配置';
      refs.digest.textContent = schedule;
      refs.digest.classList.toggle('ideas-error', Boolean(digest.lastError));
    } catch {
      if (request !== summaryRequest || !allowed()) return;
      refs.counts.textContent = '统计暂时无法加载';
      refs.digest.textContent = '每日 18:00 汇总 · 状态暂不可用，可点击刷新重试';
    }
  }

  async function save() {
    if (!allowed() || !selected || !dirty() || saving || reloading || conflict) return;
    if (draft.published && (!publishable.has(draft.status) || !draft.publishedTitle.trim() || !draft.publishedText.trim())) {
      notify('请填写公开标题和摘要后再保存。', true);
      const input = !draft.publishedTitle.trim() ? refs.publicTitle : refs.publicText;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', refs.feedback.id);
      input.focus();
      return;
    }
    const id = selected.id, request = detailRequest;
    saving = true;
    notify('');
    updateEditor();
    renderList();
    try {
      const result = await context().api(`/api/ideas/admin/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ ...draft, version: selected.version })
      });
      if (request !== detailRequest || !allowed()) return;
      selected = result.item;
      draft = editable(selected);
      latestReview = null;
      items = items.map(item => item.id === id ? selected : item);
      saving = false;
      renderDetail();
      notify('评审已保存。');
      refs.feedback.focus({ preventScroll: true });
      void fetchList(true);
      void fetchSummary();
    } catch (error) {
      if (request !== detailRequest || !allowed()) return;
      conflict = error.status === 409;
      notify(conflict
        ? '这条创意已被其他管理员更新。当前草稿已保留，请载入最新版本，核对后再保存。'
        : error.message || '保存失败，草稿已保留，请重试。', true);
    } finally {
      if (request === detailRequest) {
        saving = false;
        updateEditor();
        renderList();
        if (conflict) refs.reload.focus({ preventScroll: true });
      }
    }
  }

  async function reloadLatest() {
    if (!allowed() || !selected || reloading || saving) return;
    const id = selected.id, selectedClass = selected.classId, request = detailRequest;
    reloading = true;
    updateEditor();
    renderList();
    try {
      let found;
      // The agreed API has no per-item GET. Search this class without the status filter.
      for (let current = 1, pages = 1; current <= pages; current++) {
        const query = new URLSearchParams({ page: String(current), pageSize: String(pageSize), classId: selectedClass });
        const data = await context().api(`/api/ideas/admin?${query}`);
        if (request !== detailRequest || !allowed()) return;
        found = data.items.find(item => item.id === id);
        if (found) break;
        pages = Math.ceil(data.total / pageSize);
      }
      if (!found) throw new Error('这条创意已不可读取，草稿仍保留。请刷新列表确认。');
      selected = found;
      latestReview = found;
      conflict = false;
      items = items.map(item => item.id === id ? found : item);
      renderDetail();
      notify('已载入最新评审，草稿已保留。请核对最新评审内容后再保存。');
      refs.feedback.focus({ preventScroll: true });
    } catch (error) {
      if (request === detailRequest && allowed()) notify(error.message || '载入失败，草稿已保留，请重试。', true);
    } finally {
      if (request === detailRequest) { reloading = false; updateEditor(); renderList(); }
    }
  }

  function init(options = {}) {
    const nextRoot = typeof options.root === 'string' ? document.querySelector(options.root)
      : options.root || document.getElementById('ideasAdminRoot') || document.getElementById('ideasView');
    const nextUser = options.user === undefined ? window.ICeClass?.state?.user : options.user;
    const nextOwner = nextUser?.id || '';
    if (root === nextRoot && owner === nextOwner && refs.list && allowed(nextUser)) {
      config = options;
      fillClasses();
      return true;
    }
    if (root && owner === nextOwner && allowed(nextUser) && !discardChanges()) return false;
    suspend();
    config = options;
    listRequest++;
    summaryRequest++;
    detailRequest++;
    root = nextRoot;
    refs = {};
    items = [];
    total = 0;
    page = 1;
    status = classId = '';
    selected = draft = latestReview = null;
    busy = saving = reloading = conflict = false;
    listError = '';
    owner = context().user?.id || '';
    if (root && allowed()) mount();
    else if (root) root.replaceChildren(node('p', '仅超级管理员可评审学生创意。', 'ideas-state'));
    return Boolean(root);
  }

  async function load() {
    if (!root) init(config);
    if (!root) return false;
    if (!allowed()) {
      suspend();
      listRequest++;
      summaryRequest++;
      detailRequest++;
      selected = draft = null;
      root.replaceChildren(node('p', '仅超级管理员可评审学生创意。', 'ideas-state'));
      refs = {};
      return false;
    }
    if (!refs.list || owner !== (context().user?.id || '')) init(config);
    if (typeof context().api !== 'function') {
      refs.counts.textContent = '评审暂不可用，请刷新页面重试。';
      return false;
    }
    fillClasses();
    await Promise.all([fetchList(dirty() || saving || reloading), fetchSummary()]);
    return true;
  }

  function suspend() {
    root?.querySelectorAll('audio').forEach(audio => audio.pause());
    if (refs.lightbox?.open) refs.lightbox.close();
  }

  function destroy() {
    suspend();
    listRequest++;
    summaryRequest++;
    detailRequest++;
    root?.replaceChildren();
    root = null;
    refs = {};
    config = {};
    items = [];
    selected = draft = latestReview = null;
    busy = saving = reloading = conflict = false;
    total = 0;
    page = 1;
    status = classId = owner = listError = '';
  }

  function tryInit() {
    if (!allowed() || typeof context().api !== 'function') return;
    if (!refs.list) init(config);
    else fillClasses();
  }

  window.addEventListener('beforeunload', event => {
    if (!dirty() && !saving && !reloading) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('iceclass-classes-changed', fillClasses);
  window.ICeClassIdeasAdmin = { init, load, canLeave, canLogout, suspend, destroy };
  window.addEventListener('iceclass-ready', tryInit);
  document.addEventListener('DOMContentLoaded', tryInit, { once: true });
  tryInit();
})();
