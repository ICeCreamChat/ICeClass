const quarter = value => Number.isInteger(value) && value % 90 === 0 ? ((value % 360) + 360) % 360 : 0;
export function screenAngle() {
  const angle = window.screen.orientation?.angle ?? window.orientation;
  return quarter(angle);
}
export function orientationState(value) {
  if (!value || typeof value.locked !== 'boolean'
    || !['rotation', 'baseAngle', 'sourceAngle'].every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] < 360 && value[key] % 90 === 0)) return null;
  return { locked: value.locked, rotation: value.rotation, baseAngle: value.baseAngle, sourceAngle: value.sourceAngle };
}
export function renderOrientationControls(state, live, locks = ['lockOrientation'], rotations = ['rotateVideo']) {
  for (const id of locks) {
    const button = document.getElementById(id); if (!button) continue;
    button.disabled = !live; button.setAttribute('aria-pressed', String(state.locked));
    button.textContent = state.locked ? '解除锁定' : '锁定方向';
    button.title = state.locked ? '解除画面方向锁定' : '保持当前画面方向';
  }
  for (const id of rotations) { const button = document.getElementById(id); if (button) button.disabled = !live; }
}

// Rotate the rendered video rather than restarting its camera or changing the phone's system settings.
export class VideoOrientation {
  constructor(video, onChange, followScreen = false) {
    this.video = video; this.onChange = onChange; this.followScreen = followScreen; this.mirror = false;
    this.state = { locked: false, rotation: 0, baseAngle: 0, sourceAngle: followScreen ? screenAngle() : 0 };
    this.resize = () => this.refresh();
    this.turn = () => {
      if (!this.followScreen) return;
      const angle = screenAngle();
      if (angle === this.state.sourceAngle) return;
      this.state.sourceAngle = angle; this.refresh(true);
    };
    video.addEventListener('resize', this.resize);
    video.addEventListener('loadedmetadata', this.resize);
    this.observer = new ResizeObserver(this.resize); this.observer.observe(video.parentElement);
    if (followScreen) {
      window.screen.orientation?.addEventListener('change', this.turn);
      window.addEventListener('orientationchange', this.turn);
      window.addEventListener('resize', this.turn);
    }
  }
  get angle() { return quarter(this.state.rotation + (this.state.locked ? this.state.sourceAngle - this.state.baseAngle : 0)); }
  dimensions() {
    const { videoWidth: width, videoHeight: height } = this.video;
    return this.angle % 180 ? { width: height, height: width } : { width, height };
  }
  set(value) {
    const state = orientationState(value); if (!state) return false;
    this.state = state; this.refresh(); return true;
  }
  toggle() {
    // Keep the current view when unlocking, and start the next lock from that view.
    this.state.rotation = this.angle;
    this.state.locked = !this.state.locked; this.state.baseAngle = this.state.sourceAngle;
    this.refresh(true);
  }
  rotate() { this.state.rotation = quarter(this.state.rotation + 90); this.refresh(true); }
  refresh(changed = false) {
    const width = this.video.videoWidth, height = this.video.videoHeight;
    const size = this.dimensions(), bounds = this.video.parentElement.getBoundingClientRect();
    if (width && height && bounds.width && bounds.height) {
      const scale = Math.min(bounds.width / size.width, bounds.height / size.height);
      Object.assign(this.video.style, { position: 'absolute', left: '50%', top: '50%', width: width * scale + 'px', height: height * scale + 'px',
        transform: `translate(-50%, -50%) rotate(${this.angle}deg) scaleX(${this.mirror ? -1 : 1})` });
    }
    this.onChange?.({ ...this.state }, changed);
  }
  dispose() {
    this.observer.disconnect(); this.video.removeEventListener('resize', this.resize); this.video.removeEventListener('loadedmetadata', this.resize);
    window.screen.orientation?.removeEventListener('change', this.turn);
    window.removeEventListener('orientationchange', this.turn); window.removeEventListener('resize', this.turn);
  }
}
