(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./vendor/aruco.js'));else root.CardQuizCards=factory(root.ICeCardAR);})(globalThis,function(AR){
  'use strict';
  const codes=AR.DICTIONARIES.QCMCAM_4X4_157h3.codeList;
  function matrix(number){
    if(!Number.isInteger(number)||number<1||number>codes.length)throw new Error('纸卡编号应为 1-157。');
    const bits=codes[number-1].toString(2).padStart(16,'0');
    return Array.from({length:8},(_,y)=>Array.from({length:8},(_,x)=>x===0||y===0||x===7||y===7?1:x===1||y===1||x===6||y===6?0:Number(bits[(y-2)*4+x-2])));
  }
  function svg(number){
    const cells=matrix(number),rects=[];
    // The six-cell detection square spans 384/480 of the SVG: 144 mm at 180 mm.
    // Keep the dictionary cells unchanged; the 48-unit margin separates labels from the marker.
    for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(!cells[y][x])rects.push(`<rect x="${48+(x-1)*64}" y="${48+(y-1)*64}" width="64" height="64"/>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480" role="img" aria-label="ICeClass 纸卡 ${number}"><rect width="480" height="480" fill="white"/><g fill="black" shape-rendering="crispEdges">${rects.join('')}</g><g fill="black" font-family="var(--font-ui, system-ui, sans-serif)" font-size="26" font-weight="bold" text-anchor="middle"><text x="240" y="30">A</text><text x="240" y="30" transform="rotate(90 240 240)">B</text><text x="240" y="30" transform="rotate(180 240 240)">C</text><text x="240" y="30" transform="rotate(270 240 240)">D</text></g></svg>`;
  }
  return{capacity:codes.length,version:'ice-v1',matrix,svg};
});
