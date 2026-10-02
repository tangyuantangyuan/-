/* Portable notebook validation and geometry; no browser dependencies. */
(function(root) {
  'use strict';
  const sizes = { A4:210/297, A5:148/210, A6:105/148, B5:176/250, B6:125/176, pocket:90/140, passport:88/125, square:1, landscape:210/148 };
  const fonts = { futura:'JournalFutura, "PingFang SC", "Microsoft YaHei", sans-serif', typewriter:'JournalTypewriter, "PingFang SC", "Microsoft YaHei", sans-serif', sans:'"PingFang SC", "Microsoft YaHei", system-ui, sans-serif' };
  Object.assign(fonts, {
    sourceSans:'Arial, JournalSourceSans, sans-serif',
    serif:'JournalBaskerville, JournalSourceSerif, serif',
    helvetica:'JournalHelveticaDisplay, JournalSourceSans, sans-serif'
  });
  const fontLabels={sourceSans:'Sans · 思源黑体',serif:'Serif · Baskerville / 思源宋体',helvetica:'Helvetica · Condensed Black'};
  const latinFonts={system:'system-ui, sans-serif',sans:'JournalHelvetica, Helvetica, Arial, sans-serif',futura:'JournalFutura, sans-serif',baskerville:'JournalBaskerville, Georgia, serif',typewriter:'JournalTypewriter, "Courier New", monospace'};
  const chineseFonts={system:'"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',typewriter:'JournalTypewriter, "PingFang SC", serif',serif:'JournalSourceSerif, "Songti SC", SimSun, serif',sans:'JournalSourceSans, "PingFang SC", sans-serif'};
  const latinLabels={system:'System',sans:'Sans · Helvetica',futura:'Futura',baskerville:'Baskerville',typewriter:'Typewriter'};
  const chineseLabels={system:'System · 系统',typewriter:'Typewriter · 打字机',serif:'Serif · 宋体',sans:'Sans · 黑体'};
  function fontPair(s) {
    const legacy={futura:['futura','system'],typewriter:['typewriter','typewriter'],sans:['system','system'],sourceSans:['sans','sans'],serif:['baskerville','serif'],helvetica:['sans','sans']}[s.font]||['futura','system'];
    return {latin:Object.hasOwn(latinFonts,s.fontLatin)?s.fontLatin:legacy[0],chinese:Object.hasOwn(chineseFonts,s.fontChinese)?s.fontChinese:legacy[1]};
  }
  function textRuns(s) {
    const pair=fontPair(s), runs=[];
    for(const char of s.text){
      const code=char.codePointAt(0), chinese=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)||(code>=0x3000&&code<=0x303f)||(code>=0xff00&&code<=0xffef);
      // A dedicated symbol fallback avoids blank punctuation in display fonts.
      const family=chinese?chineseFonts[pair.chinese]:code>=0x2000&&code<=0x2bff?'system-ui, sans-serif':latinFonts[pair.latin];
      const last=runs.at(-1);if(last?.family===family)last.text+=char;else runs.push({family,text:char});
    }
    return runs;
  }
  function resources(value, result = new Set()) {
    if (!value || typeof value !== 'object') return result;
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'resource' || key === 'originalResource') && typeof item === 'string') result.add(item);
      else if (item && typeof item === 'object') resources(item, result);
    }
    return result;
  }
  function remap(value, map) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'resource' || key === 'originalResource') value[key] = map.get(item) || item;
      else if (item && typeof item === 'object') remap(item, map);
    }
  }
  function validateBook(book) {
    const fail = () => { throw new Error('Invalid notebook file.'); };
    const str = (v,n=1000) => typeof v === 'string' && v.length <= n;
    const number = (v,min,max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    const ids = new Set();
    const identity = o => { if (!o || !str(o.id,150) || !o.id || ids.has(o.id)) fail(); ids.add(o.id); };
    const crop = i => { if (i?.originalResource !== undefined && !str(i.originalResource,150)) fail(); if(i?.crop && (!number(i.crop.x,0,1)||!number(i.crop.y,0,1)||!number(i.crop.w,.000001,1)||!number(i.crop.h,.000001,1)||i.crop.x+i.crop.w>1.000001||i.crop.y+i.crop.h>1.000001)) fail(); };
    const image = i => { if (i && (!str(i.resource,150) || !['single-cover','single-contain','spread-cover','spread-contain','alpha-shaped'].includes(i.mode))) fail(); crop(i); };
    const stickers = list => {
      if (!Array.isArray(list) || list.length > 10000) fail();
      for (const s of list) {
        identity(s);
        if(s.locked!==undefined && typeof s.locked!=='boolean')fail();
        if(s.groupId!==undefined && (!str(s.groupId,150) || !s.groupId))fail();
        crop(s);
        if (![s.x,s.y,s.rotation,s.zIndex].every(Number.isFinite) || !number(s.width,1,1000)) fail();
        if (s.kind === 'text') {
          if(s.fontLatin!==undefined && !Object.hasOwn(latinFonts,s.fontLatin))fail();
          if(s.fontChinese!==undefined && !Object.hasOwn(chineseFonts,s.fontChinese))fail();
          if (!str(s.text,20000) || !Object.hasOwn(fonts,s.font) || !number(s.height,1,500) || !number(s.fontSize,.5,40) || !number(s.lineHeight,.5,5) || !number(s.letterSpacing,-.2,1) || !/^#[\da-f]{6}$/i.test(s.color) || !['left','center','right'].includes(s.align) || ![400,700].includes(s.weight)) fail();
        } else if (s.kind || !str(s.resource,150)) fail();
      }
    };
    const surface = p => { identity(p); image(p.image); stickers(p.stickers); };
    if (!book || book.schemaVersion !== 2 || !str(book.id,150) || !str(book.title,1000) || !Object.hasOwn(sizes,book.sizePreset) || !['bound','coil','binder'].includes(book.binding) || !Array.isArray(book.sheets) || book.sheets.length > 2000 || !Array.isArray(book.spreads)) fail();
    for (const c of ['covers','insides']) for (const side of ['front','back']) surface(book[c]?.[side]);
    for (const sheet of book.sheets) {
      identity(sheet); surface(sheet.front); surface(sheet.back);
      if (sheet.shape && (!str(sheet.shape.resource,150) || !number(sheet.shape.scale,10,100) || !['front','back'].includes(sheet.shape.sourceSide) || (sheet.shape.sideMode !== undefined && !['independent','show-through'].includes(sheet.shape.sideMode)) || (sheet.shape.positionY !== undefined && !number(sheet.shape.positionY,0,100)))) fail();
    }
    for (const spread of book.spreads) { identity(spread); if (!ids.has(spread.leftId) || !ids.has(spread.rightId)) fail(); image(spread.image); stickers(spread.stickers); }
    if (book.category !== undefined && !str(book.category,100)) fail();
    return book;
  }
  function bounds(sticker, offset, pageRatio, imageRatio=1) {
    const width = sticker.width, height = sticker.kind === 'text' ? sticker.height : width * pageRatio / imageRatio;
    const angle = sticker.rotation * Math.PI/180, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
    const halfX = (width*c + height/pageRatio*s)/2, halfY = (height*c + width*pageRatio*s)/2;
    return { x:sticker.x+offset, y:sticker.y, halfX, halfY, width:halfX*2, height:halfY*2 };
  }
  function align(items, action, target) {
    if (!items.length) return [];
    const positions = items.map(i=>({x:i.x,y:i.y}));
    if (action === 'spaceX' || action === 'spaceY') {
      if (items.length < 3) return positions;
      const axis = action === 'spaceX' ? 'x' : 'y', half = axis === 'x' ? 'halfX' : 'halfY';
      const order = items.map((b,i)=>({b,i})).sort((a,b)=>a.b[axis]-b.b[axis]);
      const lo = order[0].b[axis]-order[0].b[half], hi=order.at(-1).b[axis]+order.at(-1).b[half];
      const gap=(hi-lo-items.reduce((sum,b)=>sum+2*b[half],0))/(items.length-1);
      let cursor=lo; for (const {b,i} of order) { positions[i][axis]=cursor+b[half]; cursor+=2*b[half]+gap; }
      return positions;
    }
    const area = target || {left:Math.min(...items.map(b=>b.x-b.halfX)),right:Math.max(...items.map(b=>b.x+b.halfX)),top:Math.min(...items.map(b=>b.y-b.halfY)),bottom:Math.max(...items.map(b=>b.y+b.halfY))};
    items.forEach((b,i)=>{
      if(action==='left') positions[i].x=area.left+b.halfX;
      if(action==='right') positions[i].x=area.right-b.halfX;
      if(action==='centerX') positions[i].x=(area.left+area.right)/2;
      if(action==='top') positions[i].y=area.top+b.halfY;
      if(action==='bottom') positions[i].y=area.bottom-b.halfY;
      if(action==='centerY') positions[i].y=(area.top+area.bottom)/2;
    }); return positions;
  }
  const api={sizes,fonts,fontLabels,latinFonts,chineseFonts,latinLabels,chineseLabels,fontPair,textRuns,resources,remap,validateBook,bounds,align};
  root.JournalStudio=api; if(typeof module!=='undefined') module.exports=api;
})(globalThis);
