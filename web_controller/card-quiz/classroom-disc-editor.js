/* The native disc navigates the existing question form. The form owns the draft and submission. */
(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const letters = 'ABCD';
  const typeNames = {single: '单选', boolean: '判断', multiple: '多选'};
  const disabled = control => control.matches(':disabled');

  function choose(select, value) {
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('input', {bubbles: true}));
    select.dispatchEvent(new Event('change', {bubbles: true}));
  }

  class CardQuizDiscEditor {
    constructor(repaint) {
      this.repaint = repaint;
      this.dialog = byId('editor');
      this.form = byId('question-form');
      this.submit = this.form.querySelector('button[type="submit"]');
      this.error = byId('editor-error');
      this.path = [];
      this.openNumber = 0;
      this.viewport = document.createElement('div');
      this.viewport.className = 'disc-viewport';
      this.viewport.tabIndex = -1;
      this.preview = document.createElement('p');
      this.resize = new ResizeObserver(() => {
        if (this.readerTitle && this.isOpen() &&
            (this.width !== this.viewport.clientWidth || this.height !== this.viewport.clientHeight)) this.repaint();
      });

      this.dialog.addEventListener('cancel', event => {
        if (!event.defaultPrevented && this.back()) event.preventDefault();
      });
      this.dialog.addEventListener('close', () => {
        if (!this.dialog.open) this.reset();
      });
      this.form.addEventListener('input', event => {
        if (event.target !== this.field || this.field.tagName !== 'INPUT') return;
        const hasText = Boolean(this.field.value);
        if (this.hasText !== hasText) { this.hasText = hasText; this.repaint(); }
      });
      this.viewport.addEventListener('keydown', event => {
        if (event.target !== this.viewport || !this.readerTitle || !this.isOpen() || event.isComposing ||
            event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const target = {ArrowLeft: this.part - 1, PageUp: this.part - 1, ArrowRight: this.part + 1,
          PageDown: this.part + 1, Home: 0, End: this.parts - 1}[event.key];
        if (typeof target !== 'number') return;
        event.preventDefault();
        if (!disabled(this.submit) && target >= 0 && target < this.parts && target !== this.part) this.turn(target);
      });
      this.form.addEventListener('invalid', event => {
        if (!this.isOpen()) return;
        // A control on another ring cannot display the browser's validation bubble.
        event.preventDefault();
        const fieldName = event.target.labels?.[0]?.textContent.trim() || '';
        this.error.textContent = [fieldName, event.target.validationMessage].filter(Boolean).join(' · ');
      }, true);
      this.observer = new MutationObserver(records => {
        const open = this.isOpen();
        if (this.preview.isConnected) this.preview.hidden = !open;
        if (!open) return;
        if (this.error.textContent && records.some(record => this.error.contains(record.target))) {
          this.enter('error');
        } else {
          this.repaint();
        }
      });
    }

    get step() { return this.path.at(-1); }

    isOpen() {
      return this.path.length > 0 && this.dialog.matches('.banban.in-disc #editor[open]');
    }

    open(adding) {
      this.reset();
      if (!this.dialog.closest('.banban.in-disc')) return;
      this.adding = adding;
      this.openNumber++;
      // Keep the number that the form opened on, even if another device advances the lesson.
      this.questionNumber = adding && document.body.dataset.pane !== 'next' ? '' :
        byId(adding ? 'next-preview' : 'question-number').textContent.split(' · ', 1)[0];
      // Wrap before showModal. The same form, including its live alert and constraint notes,
      // is the column container when reading and keeps all original controls when editing.
      this.form.before(this.viewport);
      this.viewport.append(this.form);
      this.path.push('answers');
      this.showStep();
      this.resize.observe(this.viewport);
      this.observer.observe(this.error, {childList: true, characterData: true, subtree: true});
      this.observer.observe(this.submit, {attributes: true, attributeFilter: ['disabled']});
      this.observer.observe(document.body, {attributes: true, attributeFilter: ['class']});
    }

    reset() {
      this.observer.disconnect();
      this.resize.disconnect();
      this.path.length = 0;
      this.field = null;
      this.carets = new WeakMap();
      this.readerTitle = '';
      delete this.dialog.dataset.editorStep;
      this.form.classList.remove('disc-columns');
      this.form.querySelectorAll('[data-editor-visible]').forEach(node => node.removeAttribute('data-editor-visible'));
      this.preview.remove();
      this.preview.textContent = '';
      if (this.form.parentElement === this.viewport) this.viewport.replaceWith(this.form);
    }

    enter(step) {
      if (this.step !== step) this.path.push(step);
      this.showStep();
      this.repaint();
    }

    back() {
      if (!this.isOpen()) return false;
      if (disabled(this.form.querySelector('footer [data-dismiss]'))) return true;
      if (this.path.length === 1) return false;
      // A long error uses both footer slots for pages. Back reaches retry and cancel.
      const errorActions = this.step === 'error' && this.parts > 1 && this.path.at(-2) !== 'error-actions';
      this.path.pop();
      if (errorActions) this.path.push('error-actions');
      this.showStep();
      this.repaint();
      return true;
    }

    optionFields() { return [...byId('edit-options').querySelectorAll('input')]; }

    notes() {
      return [byId('editor-snapshot-note'), byId('editor-round-note')].filter(note => !note.hidden);
    }

    sourceField(step) {
      if (step === 'stem') return byId('edit-text');
      if (step === 'tags') return byId('edit-tags');
      if (step.startsWith('option-')) return this.optionFields()[letters.indexOf(step.slice(7).toUpperCase())];
      return null;
    }

    showStep() {
      if (this.field) {
        const {selectionStart, selectionEnd, selectionDirection, scrollTop, scrollLeft} = this.field;
        this.carets.set(this.field, {selectionStart, selectionEnd, selectionDirection, scrollTop, scrollLeft});
      }
      this.dialog.dataset.editorStep = this.step;
      const visible = node => node.setAttribute('data-editor-visible', '');
      this.form.querySelectorAll('[data-editor-visible]').forEach(node => node.removeAttribute('data-editor-visible'));
      this.preview.remove();
      this.preview.textContent = '';
      this.field = null;
      this.readerTitle = '';
      const full = this.step.startsWith('read-'), source = full ? this.step.slice(5) : this.step;
      const field = this.sourceField(source);
      if (field && (full || field.readOnly)) {
        this.readerTitle = source === 'tags' ? '知识点全文' : '选项 ' + source.slice(-1).toUpperCase() + ' 全文';
        this.preview.textContent = (field.readOnly ? field.defaultValue : field.value) || '见课件';
        this.preview.hidden = false;
        this.form.append(this.preview);
        visible(this.preview);
      } else if (field) {
        this.field = field;
        this.hasText = Boolean(field.value);
        if (source.startsWith('option-')) visible(byId('edit-options'));
        visible(field.closest('label'));
      } else if (this.step === 'limits') {
        this.readerTitle = '编辑限制';
        this.notes().forEach(visible);
      } else if (this.step === 'error') {
        this.readerTitle = '保存失败';
        visible(this.error);
      }
      this.form.classList.toggle('disc-columns', Boolean(this.readerTitle));
      this.viewport.scrollLeft = this.viewport.scrollTop = 0;
      this.part = 0;
      this.parts = 1;
      this.width = this.height = 0;
      if (this.readerTitle) {
        this.viewport.setAttribute('role', 'region');
        this.viewport.setAttribute('aria-label', this.readerTitle);
        this.viewport.focus({preventScroll: true});
      } else {
        this.viewport.removeAttribute('role');
        this.viewport.removeAttribute('aria-label');
        if (this.field) {
          field.focus({preventScroll: true});
          const caret = this.carets.get(field);
          if (caret) {
            field.setSelectionRange(caret.selectionStart, caret.selectionEnd, caret.selectionDirection);
            field.scrollTop = caret.scrollTop;
            field.scrollLeft = caret.scrollLeft;
          }
        }
      }
    }

    measurePages() {
      const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
      if (this.width === width && this.height === height) return;
      this.width = width;
      this.height = height;
      // The native host parks the WebView at 1 × 1 between ring and reader.
      if (!width || !height) return;
      this.parts = Math.max(1, Math.ceil(this.form.scrollWidth / width));
      this.part = Math.min(this.part, this.parts - 1);
      this.viewport.scrollLeft = this.part * width;
    }

    turn(part) {
      this.part = part;
      this.viewport.scrollLeft = part * this.width;
      this.repaint();
    }

    page() {
      if (!this.isOpen()) return null;
      const busy = disabled(this.submit);
      const action = (id, label, name, icon, run, state = {}) => ({
        id, label, name, icon, run, ...state, enabled: !busy && state.enabled !== false
      });
      const link = (id, label, name, icon, state) => action(id, label, name, icon, () => this.enter(id), state);
      const page = (layout, title, items, value = '', hint = '') => ({
        key: [this.adding ? 'add' : 'edit', this.openNumber, this.step].join('/') + (this.readerTitle ? '/' + this.part : ''),
        layout, title, value, hint, items
      });
      const save = (retry = false) => action('save', busy ? '保存中' : retry ? '重试' : '保存',
        busy ? '正在保存题目设置' : retry ? '重新保存当前表单' : this.adding ? '保存临时题' : '保存题目设置',
        busy ? 'loader-circle' : 'check', () => this.form.requestSubmit(this.submit));
      const errorActions = () => {
        const cancel = this.form.querySelector('footer [data-dismiss]');
        return [save(true), action('cancel', '取消', '取消编辑并关闭题目设置',
          'rotate-ccw', () => cancel.click(), {enabled: !disabled(cancel)})];
      };
      if (this.readerTitle) {
        this.measurePages();
        if (this.parts === 1) return page('reader', this.readerTitle, this.step === 'error' ? errorActions() : []);
        const {part, parts} = this;
        return page('reader', this.readerTitle + ' ' + (part + 1) + '/' + parts, [
          action('previous', '上页', '阅读上一页', 'arrow-left', () => this.turn(part - 1), {enabled: part > 0}),
          action('next', '下页', '阅读下一页', 'arrow-right', () => this.turn(part + 1), {enabled: part + 1 < parts})
        ]);
      }
      const type = byId('edit-type'), count = byId('edit-count');
      const kind = typeNames[type.value];

      switch (this.step) {
        case 'answers': {
          const select = byId('edit-answer');
          const multiple = !byId('edit-answer-multiple').hidden;
          const choices = multiple ? [...byId('edit-answer-choices').querySelectorAll('input')] :
            [...select.options].filter(option => option.value);
          const chosen = choices.filter(choice => multiple ? choice.checked : choice.selected);
          const answer = chosen.map(choice => choice.value).join('');
          const available = choice => !disabled(choice) && (multiple || !disabled(select));
          const empty = [...select.options].find(option => !option.value);
          const items = choices.map(choice => {
            const letter = choice.value, selected = multiple ? choice.checked : choice.selected;
            const label = type.value === 'boolean' ? letter + (letter === 'A' ? ' 对' : ' 错') : letter;
            const clear = selected && (multiple || (empty && available(empty)));
            return action('answer-' + letter.toLowerCase(), label,
              (clear ? '取消标准答案 ' : '选择标准答案 ') + label, selected ? 'check' : multiple ? 'square' : 'circle-dot',
              () => {
                if (multiple) choice.click(); else choose(select, clear ? '' : letter);
                this.repaint();
              }, {selected, enabled: available(choice)});
          });
          items.push(save(), link('fields', '题目', '编辑题干、选项、项数和知识点', 'file-pen-line'),
            link('type', kind, '题型，当前为' + kind, 'list-checks', {enabled: !disabled(type)}),
            action('unset', '暂不设', '暂不设置标准答案', 'rotate-ccw', () => {
              if (multiple) chosen.forEach(choice => choice.click()); else choose(select, '');
              this.repaint();
            }, {selected: !answer, enabled: multiple ? choices.some(available) && chosen.every(available) : !!empty && available(empty)}));
          return page('ring', this.adding ? '临时题' : '设答案', items,
            this.questionNumber || kind, answer ? '答案 ' + answer : '未设答案');
        }
        case 'fields': {
          const size = this.optionFields().length;
          const items = [
            link('stem', '题干', '编辑题干', 'file-pen-line', {enabled: !disabled(byId('edit-text'))}),
            link('options', '选项', '查看或编辑各选项文字', 'layout-grid'),
            link('count', '项数', '选项数量，当前 ' + size + ' 项', 'list-checks', {mark: String(size), enabled: !disabled(count)}),
            link('tags', '知识点', '编辑知识点，多个知识点用逗号分隔', 'book-open', {enabled: !disabled(byId('edit-tags'))})
          ];
          if (this.notes().length) items.push(link('limits', '限制', '查看本题的编辑限制', 'info'));
          if (this.error.textContent) items.push(link('error', '错误', '查看上次保存的错误', 'info'));
          return page('ring', '题目设置', items, kind, 'A-' + letters[size - 1]);
        }
        case 'type':
        case 'count': {
          const types = this.step === 'type', control = types ? type : count;
          const items = [...control.options].map(option => {
            const label = types ? typeNames[option.value] : option.value + ' 项';
            return action(this.step + '-' + option.value, label, types ? option.text : '使用 ' + label + '选项',
              types ? 'list-checks' : 'layout-grid', () => { choose(control, option.value); this.back(); },
              {selected: option.selected, enabled: !disabled(control) && !disabled(option),
                mark: types ? {single: 'A', boolean: 'AB', multiple: 'AC'}[option.value] : 'A-' + letters[Number(option.value) - 1]});
          });
          return page('ring', types ? '题型' : '选项数量', items, types ? kind : control.value + ' 项');
        }
        case 'options': {
          const items = this.optionFields().map((field, index) => {
            const letter = letters[index], verb = field.readOnly ? '查看' : field.value ? '编辑' : '填写';
            return link('option-' + letter.toLowerCase(), verb, verb + '选项 ' + letter + ' 的文字', 'file-pen-line',
              {mark: letter, enabled: !disabled(field)});
          });
          return page('ring', '选项文字', items, 'A-' + letters[items.length - 1]);
        }
        case 'error-actions':
          return page('ring', '保存失败', [link('error', '原因', '阅读完整保存错误', 'info'), ...errorActions()]);
        default: {
          const stem = this.step === 'stem', tags = this.step === 'tags';
          const title = stem ? '题干 · 可留空' : tags ? '知识点 · 逗号分隔' : '选项 ' + this.step.slice(-1).toUpperCase();
          const items = [save()];
          if (!stem) items.unshift(link('read-' + this.step, '全文', '阅读' + (tags ? '知识点' : title) + '全文',
            'book-open', {enabled: Boolean(this.field?.value)}));
          return page('reader', title, items);
        }
      }
    }

    describe() {
      const page = this.page();
      if (!page) return null;
      return {...page, items: page.items.map(({run, ...item}) => item)};
    }

    activate(id) {
      const item = this.page()?.items.find(item => item.id === id && item.enabled);
      if (!item) return false;
      item.run();
      return true;
    }
  }

  window.CardQuizDiscEditor = CardQuizDiscEditor;
})();
