(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./vendor/aruco.js'));else root.CardQuizCards=factory(root.ICeCardAR);})(globalThis,function(AR){
  'use strict';
  const codes=AR.DICTIONARIES.QCMCAM_4X4_157h3.codeList;
  function matrix(number){
    if(!Number.isInteger(number)||number<1||number>codes.length)throw new Error('纸卡编号应为 1-157。');
    const bits=codes[number-1].toString(2).padStart(16,'0');
    return Array.from({length:8},(_,y)=>Array.from({length:8},(_,x)=>x===0||y===0||x===7||y===7?1:x===1||y===1||x===6||y===6?0:Number(bits[(y-2)*4+x-2])));
  }
  function svg(number){
    const cells = matrix(number), white = [];
    // On the 200 mm print graphic, 408 units span the 170 mm detection square.
    // Paint one solid border to avoid seams between adjacent black cells in print.
    for (let row = 2; row < 6; row++) {
      for (let col = 2; col < 6; col++) {
        if (cells[row][col]) white.push(`M${36+(col-1)*68} ${36+(row-1)*68}h68v68h-68z`);
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480" role="img" aria-label="ICeClass 纸卡 ${number}">
      <rect width="480" height="480" fill="white"/>
      <g shape-rendering="crispEdges"><rect x="36" y="36" width="408" height="408" fill="black"/><path fill="white" d="${white.join('')}"/></g>
      <g fill="black" font-family="var(--font-ui, system-ui, sans-serif)" font-size="19.9" font-weight="bold" text-anchor="middle">
        <text x="240" y="24.2">A</text>
        <text y="7.4" transform="translate(467.3 240) rotate(90)">B</text>
        <text y="7.4" transform="translate(240 463.2) rotate(180)">C</text>
        <text y="7.4" transform="translate(12.7 240) rotate(270)">D</text>
      </g></svg>`;
  }
  return{capacity:codes.length,version:'ice-v1',matrix,svg};
});
