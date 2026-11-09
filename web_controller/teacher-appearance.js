'use strict';
(() => {
  const key = 'iceclass.teacher.appearance';
  const root = document.documentElement;
  const defaults = {version:1,material:'glass',reduceTransparency:false};
  const normalize = value => value?.version === 1 ? {
    version:1,material:value.material === 'white' ? 'white' : 'glass',
    reduceTransparency:value.reduceTransparency === true
  } : {...defaults};
  let preference = {...defaults};
  try { preference = normalize(JSON.parse(localStorage.getItem(key))); } catch {}

  // Apply before styles and body are parsed: a saved white workspace never
  // paints the blue wallpaper while waiting for the rest of the application.
  function apply() {
    root.dataset.teacherMaterial = preference.material;
    root.dataset.teacherTransparency = preference.reduceTransparency ? 'reduced' : 'full';
    document.querySelectorAll('input[name="teacherMaterial"]').forEach(input => {
      input.checked = input.value === preference.material;
    });
    const reduce = document.getElementById('teacherReduceTransparency');
    if (reduce) {
      reduce.checked = preference.reduceTransparency;
      reduce.disabled = preference.material === 'white';
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', preference.material === 'white' ? '#f5f6f8' : '#e5f0f8');
  }
  apply();

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    const section = document.getElementById('teacherAppearance');
    section?.addEventListener('change', event => {
      if (event.target.name === 'teacherMaterial') preference.material = event.target.value === 'white' ? 'white' : 'glass';
      else if (event.target.id === 'teacherReduceTransparency') preference.reduceTransparency = event.target.checked;
      else return;
      apply();
      window.dispatchEvent(new Event('iceclass-appearance-change'));
      const feedback = document.getElementById('teacherAppearanceStatus');
      try {
        localStorage.setItem(key, JSON.stringify(preference));
        feedback.textContent = '外观已保存到此设备。';
      } catch { feedback.textContent = '外观已应用，暂时无法保存；下次打开需重新选择。'; }
    });
  }, {once:true});
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    try { preference = normalize(JSON.parse(event.newValue)); } catch { preference = {...defaults}; }
    apply();
    window.dispatchEvent(new Event('iceclass-appearance-change'));
  });
})();
