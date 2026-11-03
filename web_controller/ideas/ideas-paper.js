/* Standalone, local-only paper cropper. Load with ideas-paper.css before ideas.js.
 * await window.ICeClassIdeasPaper.open(HTMLCanvasElement | Blob) -> JPEG Blob | null.
 * cancel() invalidates work and clears owned pixels synchronously. The caller's
 * canvas is never changed. Only the final "使用纸条" action releases a JPEG.
 * Imports: JPG, PNG, static WebP; at most 20 MiB, 32 MP, 16384 px per side.
 * Image metadata is inspected within the first MiB before native decoding.
 */
((root) => {
  'use strict';

  const MAX_PIXELS = 32000000;
  const MAX_DIMENSION = 16384;
  const MAX_INPUT_BYTES = 20 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
  const HEADER_BYTES = 1024 * 1024;
  const MIN_SPAN = .01;
  const BAD_IMAGE = '无法读取这张图片，请取消后选择完整的 JPG、PNG 或静态 WebP 图片。';
  const LARGE_IMAGE = '图片过大，请取消后选择不超过 20 MB、3200 万像素且最长边不超过 16384 像素的图片。';
  const ENCODE_ERROR = '无法生成纸条图片，请重新裁剪；仍失败时请取消后换一张图片。';

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function validateDimensions(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error(BAD_IMAGE);
    if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error(LARGE_IMAGE);
    return { width, height };
  }

  // Normalized source coordinates survive layout, orientation and DPR changes.
  function clampCrop(rect) {
    if (!rect || !['left', 'top', 'right', 'bottom'].every(edge => Number.isFinite(rect[edge]))) throw new Error(BAD_IMAGE);
    const left = clamp(rect.left, 0, 1 - MIN_SPAN), top = clamp(rect.top, 0, 1 - MIN_SPAN);
    return { left, top, right: clamp(rect.right, left + MIN_SPAN, 1), bottom: clamp(rect.bottom, top + MIN_SPAN, 1) };
  }

  function changeEdge(rect, edge, value) {
    if (!Number.isFinite(value)) throw new Error(BAD_IMAGE);
    const next = clampCrop(rect);
    if (edge === 'left') next.left = clamp(value, 0, next.right - MIN_SPAN);
    else if (edge === 'right') next.right = clamp(value, next.left + MIN_SPAN, 1);
    else if (edge === 'top') next.top = clamp(value, 0, next.bottom - MIN_SPAN);
    else if (edge === 'bottom') next.bottom = clamp(value, next.top + MIN_SPAN, 1);
    else throw new Error('Unknown crop edge.');
    return next;
  }

  function moveCrop(rect, dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error(BAD_IMAGE);
    const next = clampCrop(rect);
    dx = clamp(dx, -next.left, 1 - next.right); dy = clamp(dy, -next.top, 1 - next.bottom);
    return { left: next.left + dx, top: next.top + dy, right: next.right + dx, bottom: next.bottom + dy };
  }

  function cropPlan(width, height, rect) {
    validateDimensions(width, height);
    const crop = clampCrop(rect);
    const sx = Math.min(width - 1, Math.round(crop.left * width)), sy = Math.min(height - 1, Math.round(crop.top * height));
    const sw = Math.max(1, Math.round(crop.right * width) - sx), sh = Math.max(1, Math.round(crop.bottom * height) - sy);
    const scale = Math.min(1, 1600 / Math.max(sw, sh));
    return { sx, sy, sw, sh, width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
  }

  function fitImage(width, height, availableWidth, availableHeight) {
    validateDimensions(width, height);
    if (![availableWidth, availableHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error(BAD_IMAGE);
    const scale = Math.min(availableWidth / width, availableHeight / height);
    return { width: width * scale, height: height * scale };
  }

  // Inspect a bounded header BEFORE assigning any image src. Never decode SVG,
  // animation or unbounded raster sizes. Native decoding still validates data/CRC.
  function inspectImageHeader(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (offset, text) => [...text].every((letter, i) => bytes[offset + i] === letter.charCodeAt(0));
    if (bytes.length >= 33 && bytes[0] === 137 && ascii(1, 'PNG\r\n\x1a\n')) {
      if (view.getUint32(8) !== 13 || !ascii(12, 'IHDR')) throw new Error(BAD_IMAGE);
      const size = validateDimensions(view.getUint32(16), view.getUint32(20));
      let offset = 33;
      while (offset + 8 <= bytes.length) {
        const length = view.getUint32(offset);
        if (ascii(offset + 4, 'acTL')) throw new Error(BAD_IMAGE);
        if (ascii(offset + 4, 'IDAT')) return size;
        offset += 12 + length;
      }
      throw new Error(BAD_IMAGE);
    }
    if (bytes[0] === 255 && bytes[1] === 216) {
      let offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset++] !== 255) throw new Error(BAD_IMAGE);
        while (bytes[offset] === 255) offset += 1;
        const marker = bytes[offset++];
        if (marker === 217 || marker === 218 || offset + 2 > bytes.length) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) throw new Error(BAD_IMAGE);
        if ([192, 193, 194].includes(marker)) {
          if (length < 8 || length < 8 + bytes[offset + 7] * 3) throw new Error(BAD_IMAGE);
          return validateDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        }
        offset += length;
      }
      throw new Error(BAD_IMAGE);
    }
    if (bytes.length >= 20 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
      let offset = 12, extended = null;
      const uint24 = index => bytes[index] + bytes[index + 1] * 256 + bytes[index + 2] * 65536;
      while (offset + 8 <= bytes.length) {
        const length = view.getUint32(offset + 4, true), data = offset + 8;
        let size = null;
        if (ascii(offset, 'ANIM') || ascii(offset, 'ANMF')) throw new Error(BAD_IMAGE);
        if (ascii(offset, 'VP8X')) {
          if (length !== 10 || data + 10 > bytes.length || (bytes[data] & 2)) throw new Error(BAD_IMAGE);
          extended = validateDimensions(uint24(data + 4) + 1, uint24(data + 7) + 1);
        } else if (ascii(offset, 'VP8 ')) {
          if (length < 10 || data + 10 > bytes.length || (bytes[data] & 1) || !ascii(data + 3, '\x9d\x01\x2a')) throw new Error(BAD_IMAGE);
          size = validateDimensions(view.getUint16(data + 6, true) & 16383, view.getUint16(data + 8, true) & 16383);
        } else if (ascii(offset, 'VP8L')) {
          if (length < 5 || data + 5 > bytes.length || bytes[data] !== 47) throw new Error(BAD_IMAGE);
          const bits = view.getUint32(data + 1, true);
          if (bits >>> 29) throw new Error(BAD_IMAGE);
          size = validateDimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1);
        }
        if (size) {
          if (extended && (extended.width !== size.width || extended.height !== size.height)) throw new Error(BAD_IMAGE);
          return size;
        }
        offset = data + length + (length & 1);
      }
    }
    throw new Error(BAD_IMAGE);
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { clampCrop, changeEdge, moveCrop, cropPlan, fitImage, validateDimensions, inspectImageHeader };
  }
  if (!root.document) return;

  const document = root.document;
  let active = null, sequence = 0;
  const live = job => active === job && !job.finished;

  function node(tag, name, text) {
    const element = document.createElement(tag);
    element.className = `ideas-paper-${name}`;
    if (text) element.textContent = text;
    return element;
  }

  function button(name, text, action) {
    const element = node('button', name, text);
    element.type = 'button'; element.addEventListener('click', action);
    return element;
  }

  function ownCanvas(job) {
    const canvas = document.createElement('canvas');
    job.canvases.add(canvas);
    return canvas;
  }

  function clearCanvas(job, canvas) {
    if (!canvas) return;
    canvas.width = 0; canvas.height = 0;
    job.canvases.delete(canvas);
  }

  function revoke(job, url) {
    if (!url) return;
    root.URL.revokeObjectURL(url); job.urls.delete(url);
  }

  function objectURL(job, blob) {
    const url = root.URL.createObjectURL(blob);
    job.urls.add(url);
    return url;
  }

  function stopRead(job) {
    root.clearTimeout(job.loadTimer); job.loadTimer = null;
    if (job.reader) {
      const reader = job.reader; job.reader = null;
      reader.onload = reader.onerror = reader.onabort = null;
      if (reader.readyState === 1) reader.abort();
    }
    job.input = null;
  }

  function clearFinal(job) {
    job.revision += 1;
    if (job.ui) {
      job.ui.photo.onload = job.ui.photo.onerror = null;
      job.ui.photo.removeAttribute('src');
    }
    revoke(job, job.finalURL); job.finalURL = null; job.finalBlob = null;
    clearCanvas(job, job.output); job.output = null;
  }

  function clearOriginal(job) {
    stopRead(job);
    if (job.original && !(job.original instanceof root.HTMLCanvasElement)) {
      job.original.onload = job.original.onerror = null;
      job.original.removeAttribute('src');
    }
    if (job.original instanceof root.HTMLCanvasElement) clearCanvas(job, job.original);
    job.original = null;
    revoke(job, job.originalURL); job.originalURL = null;
  }

  function stopDrag(job) {
    const drag = job.drag; job.drag = null;
    if (drag && drag.target.hasPointerCapture(drag.id)) drag.target.releasePointerCapture(drag.id);
  }

  function finish(job, result) {
    if (!live(job)) return;
    active = null; job.finished = true;
    stopDrag(job); clearFinal(job); clearOriginal(job);
    for (const canvas of job.canvases) { canvas.width = 0; canvas.height = 0; }
    job.canvases.clear();
    for (const url of job.urls) root.URL.revokeObjectURL(url);
    job.urls.clear(); job.crop = null;
    job.observer?.disconnect(); job.observer = null;
    root.removeEventListener('resize', job.resize);
    root.visualViewport?.removeEventListener('resize', job.resize);
    const ui = job.ui; job.ui = null;
    if (ui) { if (ui.dialog.open) ui.dialog.close(); ui.dialog.remove(); }
    const resolve = job.resolve; job.resolve = null;
    const previous = job.previous; job.previous = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    resolve(result);
  }

  function cancel() { if (active) finish(active, null); }

  function error(job, message, recover = false) {
    if (!live(job)) return;
    clearFinal(job);
    if (!recover) {
      clearOriginal(job);
      clearCanvas(job, job.ui.canvas);
      job.ui.editor.hidden = true;
    }
    job.phase = recover ? 'edit' : 'error';
    job.ui.status.textContent = '';
    job.ui.error.textContent = message; job.ui.error.hidden = false;
    updateActions(job);
    if (recover) job.ui.crop.focus({ preventScroll: true });
  }

  function updateActions(job) {
    const ui = job.ui, preview = job.phase === 'preview', editing = job.phase === 'edit';
    ui.crop.hidden = preview; ui.crop.disabled = job.phase !== 'edit';
    ui.use.hidden = !preview; ui.use.disabled = !preview || !job.finalBlob;
    ui.back.hidden = !preview;
    ui.editor.hidden = !['edit', 'encoding'].includes(job.phase);
    ui.editor.inert = !editing; ui.selection.tabIndex = editing ? 0 : -1;
    for (const range of Object.values(ui.ranges)) range.disabled = !editing;
    ui.preview.hidden = !preview;
    ui.dialog.setAttribute('aria-busy', String(['loading', 'encoding'].includes(job.phase)));
  }

  function renderCrop(job) {
    if (!live(job) || !job.crop) return;
    const { left, top, right, bottom } = job.crop, ui = job.ui;
    const rect = (element, x, y, width, height) => {
      element.style.left = `${x * 100}%`; element.style.top = `${y * 100}%`;
      element.style.width = `${width * 100}%`; element.style.height = `${height * 100}%`;
    };
    rect(ui.selection, left, top, right - left, bottom - top);
    rect(ui.shades[0], 0, 0, 1, top); rect(ui.shades[1], 0, top, left, bottom - top);
    rect(ui.shades[2], right, top, 1 - right, bottom - top); rect(ui.shades[3], 0, bottom, 1, 1 - bottom);
    const limits = { left: [0, right - MIN_SPAN], top: [0, bottom - MIN_SPAN], right: [left + MIN_SPAN, 1], bottom: [top + MIN_SPAN, 1] };
    for (const [edge, range] of Object.entries(ui.ranges)) {
      range.min = String(Math.ceil(limits[edge][0] * 1000)); range.max = String(Math.floor(limits[edge][1] * 1000));
      range.value = String(Math.round(job.crop[edge] * 1000));
      const value = `${Math.round(job.crop[edge] * 100)}%`;
      range.setAttribute('aria-valuetext', value); ui.values[edge].textContent = value;
    }
    ui.selection.setAttribute('aria-label', `裁剪范围：左 ${Math.round(left * 100)}%，上 ${Math.round(top * 100)}%，右 ${Math.round(right * 100)}%，下 ${Math.round(bottom * 100)}%。方向键移动，Shift 加快。`);
  }

  function resize(job) {
    if (!live(job) || !job.crop) return;
    stopDrag(job);
    const available = job.ui.workspace.getBoundingClientRect();
    if (available.width <= 44 || available.height <= 44) return;
    const size = fitImage(job.width, job.height, available.width - 44, available.height - 44);
    job.ui.stage.style.width = `${size.width}px`; job.ui.stage.style.height = `${size.height}px`;
  }

  function changeCrop(job, rect) {
    if (!live(job) || job.phase !== 'edit') return;
    job.crop = rect; job.ui.error.hidden = true;
    renderCrop(job);
  }

  function pointerStart(job, event, mode) {
    if (!live(job) || job.phase !== 'edit' || job.drag || event.button !== 0 || event.isPrimary === false) return;
    const bounds = job.ui.stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    job.drag = { id: event.pointerId, target: event.currentTarget, mode, crop: { ...job.crop },
      x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(job, event) {
    const drag = job.drag;
    if (!live(job) || !drag || event.pointerId !== drag.id) return;
    const bounds = job.ui.stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    event.preventDefault();
    const dx = (event.clientX - bounds.left) / bounds.width - drag.x, dy = (event.clientY - bounds.top) / bounds.height - drag.y;
    let crop = drag.crop;
    if (drag.mode === 'move') crop = moveCrop(crop, dx, dy);
    else {
      const horizontal = drag.mode.includes('w') ? 'left' : 'right', vertical = drag.mode.includes('n') ? 'top' : 'bottom';
      crop = changeEdge(crop, horizontal, drag.crop[horizontal] + dx);
      crop = changeEdge(crop, vertical, drag.crop[vertical] + dy);
    }
    changeCrop(job, crop);
  }

  function arrow(job, event, corner) {
    if (!live(job) || job.phase !== 'edit' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? .025 : .005;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (!corner) changeCrop(job, moveCrop(job.crop, dx, dy));
    else {
      const edge = dx ? (corner.includes('w') ? 'left' : 'right') : (corner.includes('n') ? 'top' : 'bottom');
      changeCrop(job, changeEdge(job.crop, edge, job.crop[edge] + (dx || dy)));
    }
  }

  function buildDialog(job) {
    const id = `ideas-paper-${++sequence}`;
    const dialog = node('dialog', 'dialog'), shell = node('div', 'shell'), header = node('header', 'header');
    const title = node('h2', 'title', '裁剪纸条'); title.id = `${id}-title`;
    const cancelButton = button('button', '取消', () => finish(job, null));
    cancelButton.autofocus = true;
    header.append(title, cancelButton);
    const help = node('p', 'help', '拖动边角框住纸条，可用方向键或“精细调整”。只保留框内内容。'); help.id = `${id}-help`;
    const content = node('div', 'content'), status = node('p', 'status', '正在读取图片…'), problem = node('p', 'error');
    status.setAttribute('role', 'status'); problem.setAttribute('role', 'alert'); problem.hidden = true;
    const editor = node('div', 'editor'), workspace = node('div', 'workspace'), stage = node('div', 'stage');
    const canvas = ownCanvas(job); canvas.className = 'ideas-paper-canvas'; canvas.setAttribute('aria-hidden', 'true');
    const shades = Array.from({ length: 4 }, () => node('div', 'shade'));
    shades.forEach(shade => shade.setAttribute('aria-hidden', 'true'));
    const selection = node('div', 'selection'); selection.tabIndex = 0; selection.setAttribute('role', 'group');
    selection.addEventListener('pointerdown', event => { if (event.target === selection) pointerStart(job, event, 'move'); });
    selection.addEventListener('keydown', event => { if (event.target === selection) arrow(job, event); });
    const corners = { nw: '左上角', ne: '右上角', sw: '左下角', se: '右下角' };
    for (const [corner, label] of Object.entries(corners)) {
      const handle = button(`handle ideas-paper-${corner}`, '', () => {});
      handle.dataset.corner = corner; handle.setAttribute('aria-label', `调整${label}，使用方向键移动边界`);
      handle.addEventListener('pointerdown', event => pointerStart(job, event, corner));
      handle.addEventListener('keydown', event => arrow(job, event, corner));
      selection.append(handle);
    }
    stage.append(canvas, ...shades, selection); workspace.append(stage);
    stage.addEventListener('pointermove', event => pointerMove(job, event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      stage.addEventListener(type, event => { if (job.drag?.id === event.pointerId) stopDrag(job); });
    }
    const details = node('details', 'details'), summary = node('summary', 'summary', '精细调整'), edges = node('div', 'edges');
    const ranges = {}, values = {};
    for (const [edge, labelText] of Object.entries({ left: '左边界', top: '上边界', right: '右边界', bottom: '下边界' })) {
      const field = node('div', 'field'), label = node('label', 'label', labelText), value = node('span', 'value'), range = node('input', 'range');
      range.type = 'range'; range.id = `${id}-${edge}`; range.min = '0'; range.max = '1000'; range.step = '1';
      range.name = `ideas-paper-${edge}`; range.autocomplete = 'off';
      label.htmlFor = range.id; value.setAttribute('aria-hidden', 'true');
      range.addEventListener('input', () => { if (job.crop) changeCrop(job, changeEdge(job.crop, edge, Number(range.value) / 1000)); });
      field.append(label, value, range); edges.append(field); ranges[edge] = range; values[edge] = value;
    }
    details.append(summary, edges); editor.append(workspace, details); editor.hidden = true;
    const preview = node('div', 'preview'), photo = node('img', 'preview-image');
    photo.alt = '最终裁剪的纸条，确认字迹清楚且只保留需要的内容'; preview.append(photo); preview.hidden = true;
    content.append(status, problem, editor, preview);
    const footer = node('footer', 'footer');
    const back = button('button ideas-paper-back', '重新裁剪', () => backToCrop(job));
    const crop = button('button ideas-paper-primary', '裁剪并预览', () => exportCrop(job));
    const use = button('button ideas-paper-primary', '使用纸条', () => {
      if (live(job) && job.phase === 'preview' && job.finalBlob && !use.disabled) finish(job, job.finalBlob);
    });
    back.hidden = true; use.hidden = true; use.disabled = true; crop.disabled = true;
    footer.append(back, crop, use); shell.append(header, help, content, footer); dialog.append(shell);
    dialog.setAttribute('aria-labelledby', title.id); dialog.setAttribute('aria-describedby', help.id);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(job, null); });
    dialog.addEventListener('close', () => finish(job, null));
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(job, null); }
    });
    return { dialog, title, help, status, error: problem, editor, workspace, stage, canvas, shades, selection, ranges, values, preview, photo, crop, back, use };
  }

  function ready(job, width, height) {
    if (!live(job)) return;
    validateDimensions(width, height); stopRead(job);
    job.width = width; job.height = height;
    job.crop = { left: .1, top: .1, right: .9, bottom: .9 };
    const canvas = job.ui.canvas, plan = cropPlan(width, height, { left: 0, top: 0, right: 1, bottom: 1 });
    canvas.width = plan.width; canvas.height = plan.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error(BAD_IMAGE);
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(job.original, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
    job.phase = 'edit'; job.ui.status.textContent = ''; updateActions(job); renderCrop(job); resize(job);
    if (root.ResizeObserver) { job.observer = new root.ResizeObserver(job.resize); job.observer.observe(job.ui.workspace); }
  }

  function readBlob(job) {
    if (!job.input.size || job.input.size > MAX_INPUT_BYTES) throw new Error(job.input.size ? LARGE_IMAGE : BAD_IMAGE);
    const reader = new root.FileReader(); job.reader = reader;
    reader.onerror = () => error(job, BAD_IMAGE);
    reader.onabort = () => { if (live(job)) error(job, BAD_IMAGE); };
    reader.onload = () => {
      if (!live(job)) return;
      try {
        inspectImageHeader(reader.result);
        reader.onload = reader.onerror = reader.onabort = null; job.reader = null;
        const image = document.createElement('img'); job.original = image;
        job.originalURL = objectURL(job, job.input); job.input = null;
        image.onload = () => {
          if (!live(job)) return;
          image.onload = image.onerror = null;
          try { ready(job, image.naturalWidth, image.naturalHeight); } catch (failure) { error(job, failure.message); }
        };
        image.onerror = () => error(job, BAD_IMAGE);
        image.src = job.originalURL;
      } catch (failure) { error(job, failure.message); }
    };
    reader.readAsArrayBuffer(job.input.slice(0, HEADER_BYTES));
  }

  function backToCrop(job) {
    if (!live(job) || job.phase !== 'preview') return;
    clearFinal(job); job.phase = 'edit';
    job.ui.title.textContent = '裁剪纸条';
    job.ui.help.textContent = '拖动边角框住纸条，可用方向键或“精细调整”。只保留框内内容。';
    updateActions(job); resize(job); job.ui.crop.focus({ preventScroll: true });
  }

  function previewJPEG(job, blob, revision) {
    if (!live(job) || job.revision !== revision) return;
    const photo = job.ui.photo;
    photo.width = job.output.width; photo.height = job.output.height;
    clearCanvas(job, job.output); job.output = null;
    job.finalBlob = blob; job.finalURL = objectURL(job, blob);
    photo.onload = () => {
      if (!live(job) || job.revision !== revision) return;
      photo.onload = photo.onerror = null;
      job.phase = 'preview'; job.ui.status.textContent = '';
      job.ui.title.textContent = '确认纸条'; job.ui.help.textContent = '确认只保留了纸条，字迹清楚后再使用。';
      updateActions(job); job.ui.use.focus({ preventScroll: true });
    };
    photo.onerror = () => { if (live(job) && job.revision === revision) error(job, ENCODE_ERROR, true); };
    photo.src = job.finalURL;
  }

  function exportCrop(job) {
    if (!live(job) || job.phase !== 'edit') return;
    stopDrag(job); clearFinal(job);
    job.phase = 'encoding'; job.ui.error.hidden = true;
    job.ui.status.textContent = '正在生成裁剪预览…'; updateActions(job);
    const revision = job.revision, plan = cropPlan(job.width, job.height, job.crop);
    const canvas = ownCanvas(job); job.output = canvas;
    const qualities = [.9, .78, .64, .5];
    let qualityIndex = 0, reductions = 0;
    const draw = () => {
      const scale = .8 ** reductions;
      canvas.width = Math.max(1, Math.round(plan.width * scale)); canvas.height = Math.max(1, Math.round(plan.height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error(ENCODE_ERROR);
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      // Export from ORIGINAL pixels and this source rectangle only. Overlay,
      // full-preview pixels and dialog/backdrop are never export inputs.
      context.drawImage(job.original, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, canvas.width, canvas.height);
    };
    const encode = () => {
      if (!live(job) || job.revision !== revision) return;
      try {
        canvas.toBlob(blob => {
          if (!live(job) || job.revision !== revision) return;
          if (!(blob instanceof root.Blob) || blob.type !== 'image/jpeg' || !blob.size) { error(job, ENCODE_ERROR, true); return; }
          if (blob.size <= MAX_OUTPUT_BYTES) {
            try { previewJPEG(job, blob, revision); } catch { error(job, ENCODE_ERROR, true); }
            return;
          }
          qualityIndex += 1;
          if (qualityIndex === qualities.length) {
            if (reductions === 3) { error(job, '纸条图片仍然过大，请缩小裁剪范围后重试。', true); return; }
            reductions += 1; qualityIndex = 0;
            try { draw(); } catch { error(job, ENCODE_ERROR, true); return; }
          }
          encode();
        }, 'image/jpeg', qualities[qualityIndex]);
      } catch { error(job, ENCODE_ERROR, true); }
    };
    try { draw(); encode(); } catch { error(job, ENCODE_ERROR, true); }
  }

  function open(source) {
    cancel();
    if (!document.body || document.hidden) return Promise.resolve(null);
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const job = { resolve, input: source, original: null, originalURL: null, finalBlob: null, finalURL: null, reader: null,
      canvases: new Set(), urls: new Set(), revision: 0, phase: 'loading', finished: false, previous: document.activeElement };
    active = job; job.resize = () => resize(job);
    try {
      job.ui = buildDialog(job); document.body.append(job.ui.dialog); job.ui.dialog.showModal();
      root.addEventListener('resize', job.resize); root.visualViewport?.addEventListener('resize', job.resize);
      job.loadTimer = root.setTimeout(() => error(job, '读取图片超时，请取消后重新选择图片。'), 20000);
      if (source instanceof root.HTMLCanvasElement) {
        const { width, height } = validateDimensions(source.width, source.height);
        const snapshot = ownCanvas(job); job.original = snapshot;
        snapshot.width = width; snapshot.height = height;
        const context = snapshot.getContext('2d', { alpha: false });
        if (!context) throw new Error(BAD_IMAGE);
        context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
        context.drawImage(source, 0, 0, width, height, 0, 0, width, height);
        job.input = null; ready(job, width, height);
      } else if (source instanceof root.Blob) readBlob(job);
      else throw new Error(BAD_IMAGE);
    } catch (failure) {
      if (job.ui?.dialog.open) error(job, failure.message);
      else finish(job, null);
    }
    source = null;
    return result;
  }

  root.ICeClassIdeasPaper = Object.freeze({ open, cancel });
  root.addEventListener('pagehide', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
})(typeof window === 'undefined' ? globalThis : window);
