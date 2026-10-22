(() => {
  'use strict';
  const make = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const time = m => `${Math.floor(m / 60)}`.padStart(2, '0') + ':' + `${m % 60}`.padStart(2, '0');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const segmenter = Intl.Segmenter ? new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }) : null;
  const shortSubject = value => segmenter ? segmenter.segment(value)[Symbol.iterator]().next().value?.segment || '' : Array.from(value)[0] || '';

  class IslandRibbon {
    constructor(root, stage) {
      this.root = root; this.stage = stage; this.data = null; this.key = ''; this.playing = false; this.elapsed = null;
      this.animations = []; this.frameRequest = 0;
      this.measure = document.createElement('canvas').getContext('2d');
      this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(root);
      this.onMotionChange = () => { this.cancelAnimations(); this.draw(); }; reduced.addEventListener('change', this.onMotionChange);
      this.onVisibility = () => { if (document.hidden || this.stage.closest('.view')?.classList.contains('hidden')) this.pause(); };
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    update(data) {
      const changedClass = this.data && this.data.className !== data.className;
      this.data = data;
      if (changedClass) this.stop();
      this.root.dataset.theme = data.appearance.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : data.appearance.theme;
      this.root.style.width = `${data.appearance.width || 560}px`;
      this.root.style.opacity = Math.max(.3, (Number(data.appearance.opacity) || 100) / 100);
      this.draw();
    }
    state() {
      const d = this.data;
      if (!d) return { key: 'empty', text: '选择班级后预览', items: [] };
      const date = new Date(d.date + 'T12:00:00Z');
      const dateText = Number.isNaN(+date) ? '预览日期' : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getUTCDay()] + ' ' + d.date.slice(5).replace('-', '/');
      const selected = d.lessons.find(l => l.start > d.minute) || d.lessons.find(l => l.start <= d.minute && d.minute < l.end) || d.lessons[0];
      let m = d.minute;
      if (this.elapsed !== null && selected) m = this.elapsed < 17 ? selected.start - 1 : selected.start;
      const items = d.lessons.map((l,index) => ({ id: l.id, subject: l.subject, time: `${time(l.start)}-${time(l.end)}`, current: l.start <= m && m < l.end, past: l.end <= m, separatorBefore:index>0 && l.start-d.lessons[index-1].end>=40, progress: Math.max(0, Math.min(1, (m-l.start)/(l.end-l.start))) }));
      const next = d.lessons.find(l => l.start > m);
      if (!items.some(i => i.current) && next) {
        const previous = [...d.lessons].reverse().find(l => l.end <= m);
        const start = previous?.end ?? Math.max(0, next.start - (d.reminders.prepareMinutes || 2));
        if(previous || m>=start) items.splice(items.findIndex(i => i.id === next.id), 0, { id: 'break', subject: previous ? '课间休息' : '课前准备', time: `${time(start)}-${time(next.start)}`, current: true, progress: Math.max(0, Math.min(1, (m-start)/(next.start-start))) });
      }
      const base = { date: dateText, items, progress: 0, accent: false, detail: '' };
      const seconds = next ? (next.start-m)*60 : 0;
      if (this.elapsed !== null && selected) {
        const t = this.elapsed;
        if (t >= 2 && t < 5) return { ...base, key: 'demo:prepare', accent: true, text: '即将上课' };
        if (t >= 5 && t < 17) {
          const left = Math.max(1, Math.ceil((17-t)*5));
          return t >= 10 && t < 14
            ? { ...base, key: 'demo:message', text: '准备上课，请回到座位并保持安静，做好上课准备。', progress: left/60 }
            : { ...base, key: 'demo:countdown', text: `距上课还有 ${left} 秒`, detail: `下节课是：${selected.subject} ${time(selected.start)}-${time(selected.end)}`, progress: left/60 };
        }
        if (t >= 17 && t < 20) return { ...base, key: 'demo:start', accent: true, text: '上课' };
      } else if (next && d.reminders.enabled && d.reminders.prepare && seconds <= d.reminders.prepareMinutes * 60) {
        return { ...base, key: 'prepare:countdown', text: `距上课还有 ${Math.ceil(seconds)} 秒`, detail: `下节课是：${next.subject} ${time(next.start)}-${time(next.end)}`, progress: seconds/(d.reminders.prepareMinutes*60) };
      }
      return { ...base, key: 'timetable', text: items.length ? '' : d.message || '这一天没有课程' };
    }
    fillMessage(layer, state) {
      const primary=layer.querySelector('.ir-primary'), secondary=layer.querySelector('.ir-secondary');
      const count=state.text?.match(/^(.*?)(\d+)( 秒)$/);
      if(primary) {
        primary.replaceChildren(...(count ? [make('span','ir-countdown-label',count[1]),make('b','',count[2]),make('span','ir-countdown-label',count[3])] : [document.createTextNode(state.text)]));
      }
      const detail=state.detail?.match(/^(下节课是：)(.+) (\d{2}:\d{2}-\d{2}:\d{2})$/);
      if(secondary) {
        secondary.replaceChildren(...(detail ? [make('span','ir-detail-label',detail[1]),make('strong','',detail[2]),make('span','ir-detail-time',detail[3])] : [document.createTextNode(state.detail)]));
      }
    }
    layer(state) {
      const layer = make('div', 'ir-layer');
      const outerWidth=this.root.clientWidth, compact=outerWidth<480, current=state.items.find(i=>i.current);
      const measure=this.measure;
      let dateWidth=compact?98:116, gap=compact?10:12, cell=compact?26:30;
      let itemGap=compact?4:6, padding=compact?20:24, separator=compact?10:12, subjectSize=compact?16:18;
      let available=Math.max(1,outerWidth-dateWidth-gap-padding), stacked=false;
      const font=getComputedStyle(this.root).fontFamily;
      let activeWidth=cell;
      if(current) {
        measure.font=`700 ${compact?18:20}px ${font}`; const subjectWidth=measure.measureText(current.subject).width;
        measure.font=`700 ${compact?13:14}px ${font}`;
        activeWidth=Math.min(available,280,Math.max(compact?148:164,subjectWidth+measure.measureText(current.time).width+(compact?32:46)));
      }
      const visible=state.items, inactive=visible.filter(i=>!i.current).length;
      const gaps=Math.max(0,visible.length-1), dividers=visible.slice(1).filter(i=>i.separatorBefore).length;
      const freeCells=()=>available-(current?activeWidth:0)-gaps*itemGap-dividers*(separator+itemGap);
      const used=()=>(current?activeWidth:0)+inactive*cell+gaps*itemGap+dividers*(separator+itemGap);
      const fitCells=()=>{ if(inactive) cell=Math.max(subjectSize+2,Math.min(compact?26:30,freeCells()/inactive)); };
      if(used()>available) { itemGap=2; separator=8; fitCells(); }
      if(used()>available && current) {
        stacked=true;
        measure.font=`700 18px ${font}`; const subjectWidth=measure.measureText(current.subject).width;
        measure.font=`700 12px ${font}`;
        activeWidth=Math.min(available,Math.max(subjectWidth+16,measure.measureText(current.time).width+16));
        fitCells();
      }
      if(used()>available) {
        dateWidth=88; gap=6; padding=12; itemGap=1; separator=6; subjectSize=14;
        available=Math.max(1,outerWidth-dateWidth-gap-padding); fitCells();
        if(used()>available && inactive) {
          cell=Math.max(1,freeCells()/inactive); subjectSize=Math.min(subjectSize,Math.max(1,cell-2));
        }
      }
      const width=state.text?outerWidth:Math.min(outerWidth,dateWidth+gap+padding+used());
      layer.style.width=`${width}px`; layer.style.left=`${(outerWidth-width)/2}px`;
      layer.style.gap=`${gap}px`;
      if (state.text) {
        const message = make('div', 'ir-message' + (state.accent ? ' ir-accent' : ''));
        if(state.accent) { const icon=make('img','ir-icon'); icon.src='/assets/island-info.svg'; icon.alt=''; message.append(icon); }
        message.append(make('span', 'ir-primary', state.text));
        if(state.accent && ['即将上课','上课','下课'].includes(state.text)) { const icon=make('img','ir-icon'); icon.src='/assets/island-book-open.svg'; icon.alt=''; message.append(icon); }
        if (state.detail) message.append(make('span', 'ir-secondary', state.detail));
        if (!state.accent) { const progress = make('span', 'ir-progress'); progress.style.transform = `scaleX(${Math.min(1, Math.max(0, state.progress))})`; message.append(progress); }
        layer.append(message);
        this.fillMessage(layer,state);
      } else {
        const date=make('span','ir-date'); date.style.flexBasis=`${dateWidth}px`;
        const split=state.date?.lastIndexOf(' ');
        if(split>0) date.append(make('span','ir-weekday',state.date.slice(0,split)),make('strong','ir-calendar',state.date.slice(split+1)));
        else date.textContent=state.date;
        layer.append(date);
        const courses = make('div', 'ir-courses');
        courses.style.gap=`${itemGap}px`; courses.style.paddingInline=`${padding/2}px`;
        courses.style.setProperty('--ir-divider-size',`${separator}px`);
        visible.forEach((item,index) => {
          if(index>0 && item.separatorBefore) courses.append(make('span','ir-divider'));
          const node = make('span', 'ir-course' + (item.current ? ' is-current' + (stacked ? ' is-stacked' : '') : '') + (item.past ? ' is-past' : ''));
          node.title = `${item.subject} ${item.time}`;
          node.style.flexBasis=`${item.current?activeWidth:cell}px`;
          if (item.current) {
            node.style.flexBasis=`${activeWidth}px`;
            node.append(make('strong', '', item.subject), make('span', 'ir-time', item.time));
            const track=make('span','ir-course-progress');
            const progress = make('span', 'ir-progress'); progress.style.transform = `scaleX(${item.progress})`; track.append(progress); node.append(track);
          } else {
            node.style.fontSize=`${subjectSize}px`;
            node.append(make('span','ir-subject',shortSubject(item.subject)));
          }
          courses.append(node);
        });
        layer.append(courses);
      }
      return layer;
    }
    draw() {
      const state = this.state();
      const signature = JSON.stringify([state, this.root.clientWidth]);
      if (signature === this.signature) return;
      this.signature = signature;
      const next = this.layer(state), previous = this.current;
      const transition = previous && state.key !== this.key && !reduced.matches && !this.reduceMotion;
      this.root.setAttribute('aria-label', [this.data?.className, state.date, state.text, state.detail, ...state.items.map(i => `${i.subject} ${i.time}`)].filter(Boolean).join('，'));
      this.root.title = state.text ? `${state.text}${state.detail ? ' · '+state.detail : ''}` : this.root.getAttribute('aria-label');
      if(state.key===this.key && state.text && this.current?.querySelector('.ir-primary') && this.current.style.width===next.style.width) {
        this.fillMessage(this.current,state);
        const progress=this.current.querySelector('.ir-progress'); if(progress) progress.style.transform=`scaleX(${Math.min(1,Math.max(0,state.progress))})`;
        return;
      }
      if (state.key === this.key && this.animations.length) {
        // Keep an in-flight mask intact while the clock or countdown updates.
        if (this.current) this.current.replaceChildren(...next.childNodes);
        return;
      }
      this.cancelAnimations();
      this.root.replaceChildren();
      if (transition) this.root.append(previous);
      this.root.append(next); this.current = next;
      if (transition) {
        previous.setAttribute('aria-hidden', 'true');
        const animations = [];
        if(previous.style.width!==next.style.width) {
          const sizes=[{width:previous.style.width,left:previous.style.left},{width:next.style.width,left:next.style.left}];
          for(const node of [previous,next]) animations.push(node.animate(sizes,{duration:550,easing:'cubic-bezier(.16,1,.3,1)',fill:'both'}));
        }
        if (state.accent || this.accent) {
          const width = this.root.clientWidth, height = 48, spacing = width/5;
          const bands = (progress, inverse) => {
            let path = inverse ? `M0 0H${width}V${height}H0Z` : '';
            for (let x=-spacing; x<width+spacing; x+=spacing) {
              const edge = spacing*progress;
              path += `M${x} ${height}L${x+height*.58} 0H${x+height*.58+edge}L${x+edge} ${height}Z`;
            }
            return `path(evenodd, '${path}')`;
          };
          const timing = { duration:550, easing:'cubic-bezier(.16,1,.3,1)', fill:'both' };
          animations.push(next.animate([{clipPath:bands(0,false)},{clipPath:bands(1,false)}],timing));
          animations.push(previous.animate([{clipPath:bands(0,true)},{clipPath:bands(1,true)}],timing));
          if (state.accent) this.pulse();
        } else {
          animations.push(previous.animate([{ transform:'translateY(0)', opacity:1 }, { transform:'translateY(16px)', opacity:0 }], {duration:200,easing:'cubic-bezier(.16,1,.3,1)',fill:'both'}));
          animations.push(next.animate([{ transform:'translateY(-16px)', opacity:0 }, { transform:'translateY(0)', opacity:1 }], {duration:200,easing:'cubic-bezier(.16,1,.3,1)',fill:'both'}));
        }
        this.animations = animations;
        const current = this.current;
        Promise.allSettled(animations.map(a => a.finished)).then(() => {
          if (this.current !== current) return;
          this.animations = []; this.root.replaceChildren(current);
        });
      }
      this.key = state.key; this.accent = state.accent;
    }
    pulse() {
      if (reduced.matches || this.reduceMotion) return;
      this.stage.querySelectorAll('.ir-pulse').forEach(n => { n.getAnimations().forEach(a => a.cancel()); n.remove(); });
      const wave = make('span', 'ir-pulse'); wave.setAttribute('aria-hidden', 'true');
      wave.style.background=getComputedStyle(this.root).getPropertyValue('--ir-accent');
      const diameter = Math.hypot(this.stage.clientWidth, this.stage.clientHeight)*2;
      wave.style.width = wave.style.height = `${diameter}px`; this.stage.prepend(wave);
      const animation = wave.animate([{transform:'translate(-50%,-50%) scale(0)',opacity:.23},{transform:'translate(-50%,-50%) scale(1)',opacity:0}], {duration:700,easing:'cubic-bezier(.45,0,.8,.5)'});
      animation.finished.catch(() => {}).finally(() => wave.remove());
    }
    cancelAnimations() { this.animations.forEach(a => a.cancel()); this.animations = []; }
    play() {
      if (!this.data?.lessons.length) return;
      if (this.playing) { this.pause(); return; }
      if (this.elapsed === null || this.elapsed >= 22) this.elapsed = 0;
      this.playing = true; this.anchor = performance.now()-this.elapsed*1000;
      const tick = now => {
        if (!this.playing) return;
        this.elapsed = Math.min(22, (now-this.anchor)/1000);
        // The browser composites the masks. Only update text/progress at 10 Hz.
        if (now-(this.lastTick || 0) >= 100) { this.lastTick = now; this.draw(); this.onChange?.(); }
        if (this.elapsed >= 22) { this.holdDemoEnd ? this.pause() : this.stop(); return; }
        this.frameRequest = requestAnimationFrame(tick);
      };
      this.frameRequest = requestAnimationFrame(tick); this.onChange?.();
    }
    pause() { this.playing = false; cancelAnimationFrame(this.frameRequest); this.onChange?.(); }
    seek(seconds) { this.elapsed = Math.min(22, Math.max(0, seconds)); this.anchor = performance.now()-this.elapsed*1000; this.draw(); this.onChange?.(); }
    stop() { this.pause(); this.elapsed = null; this.draw(); this.onChange?.(); }
    reset() { this.pause(); this.elapsed = 0; this.play(); }
    clear() { this.data = null; this.stop(); }
  }
  window.ICeClassIslandRibbon = IslandRibbon;
})();
