(() => {
  'use strict';
  // Reactions describe returned records, never a guessed emotion in model prose.
  window.ICeClassBanbanReaction = (question, data) => {
    const topic = /来音|录音|语音/.test(question) ? 'voice' : /通知|送达|喊话/.test(question) ? 'notifications' : /设备|电脑|白板|连接/.test(question) ? 'devices' : 'reading';
    const r = data?.reading, n = data?.notifications, v = data?.voice, d = data?.devices;
    const careful = caption => ({tone: 'careful', caption});
    const neutral = caption => ({tone: 'neutral', caption});
    if (!data?.scope?.classCount) return neutral('这个范围还没有可查看的班级');
    if (topic === 'voice') return neutral(v?.total ? '数量和时长整理好了，内容保持隐私' : '这个范围还没有来音记录');
    if (topic === 'notifications') {
      if (!n?.total) return neutral('这个范围还没有通知记录');
      if (n.failed) return careful('有失败或离线记录，一起核对一下');
      if (n.displayed < n.total) return careful('还有通知未确认在白板显示');
      return {tone: 'warm', caption: '这些通知都已收到白板显示回执'};
    }
    if (topic === 'devices') return d?.total && d.enabled < d.total ? careful('有设备未启用，可以再核对一下') : neutral(d?.total ? '绑定信息整理好了，在线状态请到教室控制查看' : '这个范围还没有绑定设备');
    if (!r) return neutral('资料整理好了，我们接着看');
    if (r.pendingClasses) return careful('还有班级需要确认同步，先不急着下结论');
    return neutral(r.activeSeconds ? '晨读记录整理好了，一起看看变化' : '暂未找到软件记录，不代表没有晨读');
  };

  window.ICeClassBanbanMotion = root => {
    const mascots = [...root.querySelectorAll('.bb-mascot')];
    const rig = window.ICeClassBanbanRig?.(root);
    const timers = new Map(), media = matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false, reduced = root.classList.contains('bb-reduced');
    let working = false, speaking = false, started = 0, focused = false, typing = false, failed = false, dragging = false, blinking = false;
    let pulse = null, pose = '', phase = '', frame = 0, point = null, lastMood = '', lastNotice = 0, lastDrag = 0;
    const random = (min, max) => min + Math.random() * (max - min);
    const clamp = (value, min = -1, max = 1) => Math.max(min, Math.min(max, value));
    const active = () => !disposed && !document.hidden && !reduced && !media.matches;
    function clear(name) { clearTimeout(timers.get(name)); timers.delete(name); }
    function later(name, ms, action) {
      clear(name);
      timers.set(name, setTimeout(() => { timers.delete(name); if (!disposed) action(); }, ms));
    }
    function render() {
      if (disposed) return;
      if (pulse && Date.now() >= pulse.until) pulse = null;
      const slow = working && !speaking && Date.now() - started >= 8000;
      const state = dragging ? 'dragging' : working ? speaking ? 'answering' : slow ? 'waiting' : 'thinking' : failed ? 'connection-error' : pulse?.state || (focused ? 'listening' : 'idle');
      const mood = dragging ? 'neutral' : working ? speaking || phase === 'orient' ? 'neutral' : slow ? 'waiting' : 'thinking' : failed ? 'waiting' : pulse?.mood || 'neutral';
      root.dataset.bbState = state;
      root.dataset.bbGesture = active() ? (dragging ? 'drag' : pulse?.gesture || '') : '';
      root.dataset.bbPose = pose;
      root.dataset.bbPhase = phase;
      root.dataset.bbAttention = typing ? 'typing' : focused ? 'input' : '';
      root.dataset.bbBlink = String(blinking && active());
      if (lastMood !== mood) { root.dataset.bbFace = mood; lastMood = mood; }
      rig?.update({state, mood, gesture: root.dataset.bbGesture, phase, pose,
        attention: root.dataset.bbAttention, blink: blinking && active(), reduced: reduced || media.matches, paused: document.hidden});
    }
    function pulseFor(state, mood, gesture, ms) {
      pulse = {state, mood, gesture, until: Date.now() + ms};
      render(); later('pulse', ms, () => { pulse = null; render(); });
    }
    function scheduleBlink() {
      clear('blink');
      if (!active()) return;
      later('blink', random(3100, 6900), () => {
        if (!active()) return;
        blinking = true; render();
        later('blink-end', 155, () => {
          blinking = false; render();
          if (Math.random() < .16 && !dragging) later('blink-double', 230, () => { blinking = true; render(); later('blink-end', 125, () => { blinking = false; render(); scheduleBlink(); }); });
          else scheduleBlink();
        });
      });
    }
    function scheduleIdle() {
      clear('idle');
      if (!active()) return;
      later('idle', random(9500, 16000), () => {
        if (!active()) return;
        if (!working && !dragging && !focused && !failed && !pulse) {
          const gestures = ['tilt', 'peek', 'bookmark', 'nod'];
          const gesture = gestures[Math.floor(Math.random() * gestures.length)];
          pulseFor('idle', gesture === 'nod' ? 'smile' : 'neutral', gesture, 2600);
        }
        scheduleIdle();
      });
    }
    function restGaze() {
      for (const mascot of mascots) for (const name of ['--bb-look-x', '--bb-look-y', '--bb-near-angle']) mascot.style.removeProperty(name);
      rig?.look(0, 0);
    }
    function gaze(e) {
      if (!active() || working || dragging || e.pointerType !== 'mouse') return;
      point = {x: e.clientX, y: e.clientY};
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!active() || working || dragging) return;
        let near = false;
        for (const mascot of mascots) {
          const rect = mascot.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          const dx = point.x - rect.x - rect.width / 2, dy = point.y - rect.y - rect.height / 2;
          const distance = Math.hypot(dx, dy), attention = clamp(1 - (distance - 120) / 300, 0, 1);
          mascot.style.setProperty('--bb-look-x', `${clamp(dx / 150) * 1.25 * attention}%`);
          mascot.style.setProperty('--bb-look-y', `${clamp(dy / 150) * .8 * attention}%`);
          mascot.style.setProperty('--bb-near-angle', `${clamp(dx / 200) * .8 * attention}deg`);
          rig?.look(clamp(dx / 150) * attention, clamp(dy / 150) * attention);
          near ||= distance < 140;
        }
        if (near && !focused && !failed && !pulse && Date.now() - lastNotice > 16000) {
          lastNotice = Date.now(); pulseFor('noticed', 'neutral', 'notice', 1500);
        }
      });
    }
    function refreshActivity() {
      for (const name of ['blink', 'blink-end', 'blink-double', 'idle']) clear(name);
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      blinking = false; restGaze();
      root.classList.toggle('bb-motion-paused', !active());
      render(); scheduleBlink(); scheduleIdle();
    }
    function stopWork() {
      working = false; speaking = false;
      for (const name of ['orient', 'hand', 'slow', 'return']) clear(name);
      phase = ''; pose = '';
    }
    document.addEventListener('pointermove', gaze, {passive: true});
    document.addEventListener('visibilitychange', refreshActivity);
    media.addEventListener('change', refreshActivity);
    function dispose() {
      disposed = true; timers.forEach(clearTimeout); timers.clear(); cancelAnimationFrame(frame);
      rig?.dispose();
      document.removeEventListener('pointermove', gaze);
      document.removeEventListener('visibilitychange', refreshActivity);
      media.removeEventListener('change', refreshActivity);
      window.removeEventListener('pagehide', dispose);
    }
    window.addEventListener('pagehide', dispose);
    refreshActivity();
    return {
      greet() { if (!working && !dragging) { failed = false; pulseFor('greeting', 'smile', 'wave', 2600); } },
      pet() { if (!working && !dragging) { failed = false; rig?.pet(); pulseFor('greeting', 'smile', 'pet', 2200); } },
      listen(value) { focused = value; if (!value) { typing = false; clear('typing'); } render(); },
      type() {
        focused = true; typing = true;
        if (!working) { failed = false; pulse = null; clear('pulse'); }
        render(); later('typing', 1100, () => { typing = false; render(); });
      },
      busy(value) {
        if (value) {
          stopWork(); working = true; started = Date.now(); failed = false; pulse = null; typing = false;
          clear('pulse'); clear('typing'); restGaze(); phase = 'orient';
          later('orient', 220, () => { phase = 'consider'; render(); });
          later('hand', 560, () => { pose = 'think'; phase = 'settled'; render(); });
          later('slow', 8100, render);
        } else if (working) stopWork();
        render();
      },
      speak(text) {
        if (text) rig?.text();
        if (speaking) return;
        stopWork(); working = true; speaking = true; failed = false; pulse = null;
        clear('pulse'); phase = 'speaking'; render();
      },
      reply(tone = 'neutral') {
        stopWork(); failed = false; phase = 'return';
        const careful = tone === 'careful', warm = tone === 'warm';
        // Lower the arm before answering; difficult records get no victory gesture.
        pulseFor(careful ? 'careful' : 'reply', careful ? 'thinking' : warm ? 'smile' : 'neutral', careful ? 'consider' : 'answer', 4200);
        later('return', 650, () => { phase = ''; render(); });
      },
      fail() { stopWork(); failed = true; pulse = null; clear('pulse'); render(); },
      reset() { stopWork(); failed = false; pulse = null; typing = false; clear('pulse'); clear('return'); render(); },
      drag(dx) {
        if (!dragging) lastDrag = dx;
        const delta = dx - lastDrag; lastDrag = dx;
        rig?.drag(clamp(-delta * .007, -.12, .12));
        dragging = true; blinking = false; restGaze();
        root.style.setProperty('--bb-drag-angle', `${clamp(-delta * .42, -7, 7)}deg`); render();
      },
      release() {
        if (!dragging) return;
        dragging = false;
        if (working || failed) { root.style.removeProperty('--bb-drag-angle'); render(); }
        else pulseFor('idle', 'neutral', 'settle', 1000);
      },
      reduce(value) { reduced = value; refreshActivity(); },
      dispose
    };
  };
})();
