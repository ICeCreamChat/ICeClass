/* Project the real classroom controls onto the existing native Banban pet. */
(() => {
  'use strict';
  const definitions = [
    ['collect','play','开始收答'], ['camera','camera','本机相机'],
    ['pause','circle-pause','暂停收答'], ['seal','square','封存本轮'], ['options','settings-2','调整收答项'],
    ['source','scan-line','手机扫码'], ['next','skip-forward','下一题'],
    ['end-session','square','结束课堂'], ['exempt','user-round-minus','核对卡号'],
    ['edit','file-pen-line','题目答案'], ['distribution','chart-no-axes-column','作答分布']
  ];
  class CardQuizWheel {
    constructor() { this.targets = {}; }
    update({targets,labels,enabled,inDisc,...state}) {
      this.targets = targets;
      this.lesson = state.lesson;
      this.actions = definitions.filter(([id]) => inDisc ? id !== 'camera' : !['pause','seal','options'].includes(id)).map(([id,icon,label]) => ({
        id, label:labels[id] || label, icon:id === 'collect' && targets[id]?.id === 'stop' ? 'square' : icon,
        enabled:enabled[id] ?? Boolean(targets[id] && !targets[id].disabled && !targets[id].hidden)
      }));
      window.chrome?.webview?.postMessage({type:'companion-state',state:{...state,actions:this.actions}});
    }
  }
  window.CardQuizWheel = CardQuizWheel;
})();
