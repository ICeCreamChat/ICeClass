/* Project the real classroom controls onto the existing native Banban pet. */
(() => {
  'use strict';
  const definitions = [
    ['collect','play','开始收答'], ['camera','camera','本机相机'],
    ['source','scan-line','手机扫码'], ['next','skip-forward','下一题'],
    ['end-session','square','结束课堂'], ['exempt','user-round-minus','缺席免答'],
    ['edit','file-pen-line','题目答案'], ['distribution','chart-no-axes-column','作答分布']
  ];
  class CardQuizWheel {
    constructor() { this.targets = {}; }
    update({hasSession,targets,labels,progress,state,multiple,feedback,error,cameraRunning}) {
      this.targets = targets;
      window.chrome?.webview?.postMessage({type:'companion-state',state:{
        hasSession,progress,status:state,feedback,error,multiple:Boolean(multiple),cameraRunning,
        multiEnabled:Boolean(targets.multi && !targets.multi.disabled && !targets.multi.hidden),
        actions:definitions.map(([id,icon,label])=>({id,label:labels[id] || label,
          icon:id==='collect' && targets[id]?.id==='stop'?'square':icon,
          enabled:Boolean(targets[id] && !targets[id].disabled && !targets[id].hidden)}))
      }});
    }
  }
  window.CardQuizWheel = CardQuizWheel;
})();
