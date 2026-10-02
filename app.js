'use strict';
const M = JournalModel;
const $ = (s, root = document) => root.querySelector(s);
const COLORS = { black: '#191919', graphite: '#262625', charcoal: '#40403E', stone: '#666663', ash: '#91918D', silver: '#BFBFBA', paper: '#E5E4DF', cream: '#F0F0EB', white: '#FAFAF7', sage: '#a8b5ab', mist: '#d5ddd6', moss: '#748778' };
const PALETTE = ['black', 'graphite', 'charcoal', 'stone', 'ash', 'silver', 'paper', 'cream', 'white'];
const COIL = { gap: .9, inset: 2.8, radiusX: 1, radiusY: .72 };
const BINDER = { gap: 3.6, inset: 5.2, radiusX: 1.35, radiusY: .95, positions: [10,22,78,90] };
function bindingGeometry(binding = book.binding, size = book.sizePreset) {
  const ratio = JournalStudio.sizes[size] || JournalStudio.sizes.A5;
  const base = binding === 'binder' ? BINDER : COIL, referenceRatio = JournalStudio.sizes.A5;
  // Express horizontal hardware dimensions in page-height units, then convert
  // them back to page/spread percentages. Wider paper must not stretch hardware.
  const gapInHeights = 2 * referenceRatio * base.gap / (100 - base.gap);
  const geometry = {...base,
    gap:100 * gapInHeights / (2 * ratio + gapInHeights),
    inset:base.inset * referenceRatio / ratio,
    radiusX:base.radiusY / ratio
  };
  if (binding === 'binder') return geometry;
  const count = ratio > 1.15 ? 10 : ratio > .85 ? 13 : 16;
  return {...geometry, positions:Array.from({length:count},(_,i)=>6+i*88/(count-1))};
}
const holePositions = config => config.positions;
const SIZES = JournalStudio.sizes;
const MODE_LABELS = { 'single-cover': 'Page · Fill', 'single-contain': 'Page · Fit', 'spread-cover': 'Spread · Fill', 'spread-contain': 'Spread · Fit', 'alpha-shaped': 'Shaped paper' };
const $book = $('#book');
let db, book, position = -1, selectedId = null, selectedStickerId = null, editing = false, busy = false;
let pendingImport = null, toastTimer, saveRevision = 0, savedRevision = 0, saving = false;
let saveTask = Promise.resolve();
let bookUnstored = false;
const assets = new Map(), shapeAssets = new Map();
const color = value => COLORS[value] || (/^#[0-9a-f]{6}$/i.test(value || '') ? value : COLORS.cream);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
const assetURL = id => assets.get(id)?.url || '';
const txDone = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Save interrupted.')); });
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

function toast(message) { const el = $('#toast'); ([...document.querySelectorAll('dialog[open]')].at(-1) || document.body).append(el); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3600); }
async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fan-fan-le', 2);
    req.onupgradeneeded = () => { for (const name of ['books', 'assets', 'backups']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' }); };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); toast('The app was updated. Please reload.'); }; resolve(req.result); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => { $('#saveStatus').textContent = 'Close other journal tabs, then reload.'; toast('Close other journal tabs and reload to finish upgrading.'); };
  });
}
// Start writes immediately and serialize snapshots. An older write must never
// overwrite a newer edit. Commit original Blobs before saving their references.
function save(key=null) { recordHistory(key); saveRevision++; $('#saveStatus').textContent = 'Saving…'; if (!saving) saveTask = flushSave(); }
async function flushSave() {
  saving = true;
  try {
    while (savedRevision < saveRevision) {
      const revision = saveRevision; book.updatedAt = Date.now();
      const tx = db.transaction('books', 'readwrite'), done = txDone(tx);
      tx.objectStore('books').put(M.clone(book)); await done; savedRevision = revision;bookUnstored=false;
    }
    $('#saveStatus').textContent = 'Saved on this device';
  } catch (error) { console.error(error); $('#saveStatus').textContent = 'Save failed'; toast('Could not save. Please check available device storage.'); }
  finally { saving = false; }
}
async function decode(url) { const image = new Image(); image.src = url; await image.decode(); return image; }
async function storeAsset(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await decode(url), id = M.id();
    const data = { id, blob: file, name: file.name, width: image.naturalWidth, height: image.naturalHeight };
    const tx = db.transaction('assets', 'readwrite'), done = txDone(tx); tx.objectStore('assets').put(data); await done;
    assets.set(id, { ...data, url }); return id;
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}
async function canvasURL(canvas) { return URL.createObjectURL(await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image processing failed.')), 'image/png'))); }
function alphaBounds(pixels, width, height) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3]) {
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return right < 0 ? { left:0, top:0, width, height } : { left, top, width:right - left + 1, height:bottom - top + 1 };
}
async function prepareShape(resource) {
  if (shapeAssets.has(resource)) return shapeAssets.get(resource);
  const image = await decode(assetURL(resource));
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
  const bounds = alphaBounds(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  // Trim only the derived artwork; keep the imported original intact.
  canvas.width = bounds.width; canvas.height = bounds.height;
  const draw = () => ctx.drawImage(image, bounds.left, bounds.top, bounds.width, bounds.height, 0, 0, canvas.width, canvas.height);
  draw(); const mask = await canvasURL(canvas);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const hitAlpha = Uint8Array.from({length:canvas.width*canvas.height},(_,i)=>pixels.data[i*4+3]);
  const silhouette=ctx.createImageData(canvas.width,canvas.height);
  for(let i=3;i<pixels.data.length;i+=4)silhouette.data[i]=pixels.data[i]?255:0;
  ctx.putImageData(silhouette,0,0);const outline=await canvasURL(canvas);
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.save();ctx.translate(canvas.width,0);ctx.scale(-1,1);const shapeCanvas=document.createElement('canvas');shapeCanvas.width=canvas.width;shapeCanvas.height=canvas.height;shapeCanvas.getContext('2d').putImageData(silhouette,0,0);ctx.drawImage(shapeCanvas,0,0);ctx.restore();const mirroredOutline=await canvasURL(canvas);
  // Paper uses the original alpha; objects use the fully opaque silhouette.
  for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
  ctx.putImageData(pixels, 0, 0); const opaque = await canvasURL(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.translate(canvas.width, 0); ctx.scale(-1, 1); draw();
  const mirroredMask = await canvasURL(canvas);
  const result = { mask, opaque, mirroredMask, outline, mirroredOutline, hitAlpha, pixelWidth:canvas.width, pixelHeight:canvas.height, ratio: bounds.width / bounds.height };
  shapeAssets.set(resource, result); return result;
}

function isReadOnlySurface(surface) {const loc=surface&&M.locate(book,surface.id),shape=loc?.sheet?.shape;return !!(shape&&loc.side!==shape.sourceSide&&shape.sideMode==='show-through');}
function canImportMode(loc,mode,at=position) {
  if(!loc||loc.inside||isReadOnlySurface(loc.surface))return false;
  if(mode==='alpha-shaped')return !!loc.sheet&&(!loc.sheet.shape||loc.sheet.shape.sourceSide===loc.side);
  if(mode.startsWith('spread')){const v=M.view(book,at);return !v.closed&&!!M.locate(book,v.left.id)?.sheet&&!!M.locate(book,v.right.id)?.sheet&&!isReadOnlySurface(v.left)&&!isReadOnlySurface(v.right);}
  return ['sticker','single-cover','single-contain'].includes(mode);
}
function currentView() { return M.view(book, position); }
function selected() { return selectedId && M.locate(book, selectedId); }
function defaultSelection() { const v = currentView(); selectedId = (v.closed === 'back' ? v.left : v.right)?.id || v.left?.id || null; }
function selectSurface(id) { const where = M.locate(book, id); if (!where || busy) return; selectedId = id; position = where.position; selectedStickerId = null; render(); }
function caption(where) { if (!where) return 'Selection'; if (where.cover) return where.cover === 'front' ? 'Front cover' : 'Back cover'; if (where.inside) return 'Inside cover'; return `Sheet ${where.index + 1} · ${where.side === 'front' ? 'Front' : 'Back'}`; }
function surfaceLabel(p) { const loc = M.locate(book, p.id); if (loc?.sheet?.shape) return 'Shaped paper'; if (p.image) return MODE_LABELS[p.image.mode] || 'Image'; if (p.stickers.length) return 'Objects'; return 'Blank'; }
function stickerRefs(at = position) {
  const v = M.view(book, at), refs = [];
  for (const [side, surface] of [['left', v.left], ['right', v.right]]) if (surface&&!isReadOnlySurface(surface)) for (const sticker of surface.stickers) refs.push({ sticker, collection: surface.stickers, surface, offset: side === 'right' ? 100 : 0, side });
  const spread = M.getSpread(book, at); if (spread) for (const sticker of spread.stickers) refs.push({ sticker, collection: spread.stickers, spread, offset: 0 });
  return refs;
}
function selectedSticker() { return stickerRefs().find(r => r.sticker.id === selectedStickerId); }
function normalizeSticker(ref) {
  if(isReadOnlySurface(ref.surface))return;
  if(ref.sticker.groupId){normalizeGroup(groupMembers(ref));return;}
  if (currentView().closed) return;
  const limits=currentView(), box=objectBounds(ref);
  if(isReadOnlySurface(limits.left))ref.sticker.x+=Math.max(0,100+box.halfX-box.x);
  if(isReadOnlySurface(limits.right))ref.sticker.x-=Math.max(0,box.x+box.halfX-100);
  const s = ref.sticker, x = s.x + ref.offset, ratio = (assets.get(s.resource)?.width || 1) / (assets.get(s.resource)?.height || 1);
  const half = JournalStudio.bounds(s, ref.offset, SIZES[book.sizePreset], ratio).halfX;
  if (x - half < 100 && x + half > 100) {
    if (!ref.spread) { ref.collection.splice(ref.collection.indexOf(s),1); const spread = M.getSpread(book,position,true); spread.stickers.push(s); Object.assign(ref,{ collection:spread.stickers, spread, surface:null, offset:0 }); s.x = x; }
  } else {
    const side = x <= 100 ? 'left' : 'right', target = currentView()[side], offset = side === 'right' ? 100 : 0;
    if (ref.surface !== target) { ref.collection.splice(ref.collection.indexOf(s),1); target.stickers.push(s); Object.assign(ref,{ collection:target.stickers, surface:target, spread:null, offset, side }); s.x = x - offset; if (s.id === selectedStickerId) selectedId = target.id; }
  }
}
function navigateToSurface(id) { const loc = M.locate(book, id); if (loc) { selectedId = id; position = loc.position; } else defaultSelection(); }

function render() {
  document.documentElement.dataset.theme = book.uiTheme === 'dark' ? 'dark' : 'light';
  const themeMeta=$('meta[name="theme-color"]');if(themeMeta)themeMeta.setAttribute('content',book.uiTheme==='dark'?'#191919':'#F0F0EB');
  if(!editing)setEditorPanel(null);
  document.body.classList.toggle('reading', !editing);
  $('#app').classList.toggle('editing', editing); $('#sidebar').hidden = !editing; $('#tools').hidden = !editing;
  $('#modeBtn').textContent = editing ? 'Done' : 'Edit';
  $('#bookTitle').textContent = book.title || 'Untitled';
  renderBook(); updateNav(); updateHistoryButtons(); if (editing) { renderList(); renderTools(); }
}
function updateNav() { $('#prevBtn').disabled = busy || position < 0; $('#nextBtn').disabled = busy || position > book.sheets.length; }
function applyBookStyle() {
  $book.style.setProperty('--page-ratio', SIZES[book.sizePreset]); $book.style.setProperty('--paper', color(book.paperColor));
  $book.style.setProperty('--gap', book.binding !== 'bound' ? `${bindingGeometry().gap}%` : '0%');
  $book.style.aspectRatio = 2 * SIZES[book.sizePreset] / (1 - (book.binding === 'bound' ? 0 : bindingGeometry().gap / 100));
  $book.className = `book ${book.binding}${position < 0 ? ' closed-front' : position > book.sheets.length ? ' closed-back' : ''}`;
}
function renderBook() { applyBookStyle(); $book.replaceChildren(buildView(position, editing)); }
function shapeLayout(shape, side) {
  const data = shapeAssets.get(shape.resource), ratio = data?.ratio || 1, pageRatio = SIZES[book.sizePreset], scale = shape.scale ?? 100;
  const width = ratio > pageRatio ? scale : scale * ratio / pageRatio, height = ratio > pageRatio ? scale * pageRatio / ratio : scale;
  const positionY = clamp(shape.positionY ?? 50, 0, 100);
  return { width, height, left: side === 'back' ? 100 - width : 0, top: (100 - height) * positionY / 100, position: `${side === 'back' ? 100 : 0}% ${positionY}%` };
}
function setShapeMask(el, sheet, side, solid=false) {
  const shape = sheet?.shape; if (!shape) return;
  const data = shapeAssets.get(shape.resource), { width, height, position } = shapeLayout(shape, side);
  const url = side === shape.sourceSide ? (solid?data?.outline:data?.mask)||assetURL(shape.resource) : (solid?data?.mirroredOutline:data?.mirroredMask)||assetURL(shape.resource);
  el.style.maskImage = `url("${url}")`; el.style.webkitMaskImage = `url("${url}")`;
  el.style.maskSize = `${width}% ${height}%`; el.style.webkitMaskSize = `${width}% ${height}%`;
  el.style.maskPosition = position; el.style.webkitMaskPosition = position; el.style.maskRepeat = 'no-repeat'; el.style.webkitMaskRepeat = 'no-repeat';
}
function appendImage(parent, image, side, shape, surfaceSide) {
  if (!image || !assetURL(image.resource)) return;
  const viewport = node('div', 'image-viewport'), img = node('img', 'page-image'); img.alt = ''; img.draggable = false;
  const isShapeSource = shape && image.resource === shape.resource && image.mode === 'alpha-shaped';
  img.src = isShapeSource ? shapeAssets.get(image.resource)?.opaque || assetURL(image.resource) : assetURL(image.resource);
  img.style.objectFit = image.mode.endsWith('cover') ? 'cover' : 'contain'; img.style.objectPosition = `${image.positionX ?? 50}% ${image.positionY ?? 50}%`;
  if (image.mode.startsWith('spread')) { img.style.width = '200%'; img.style.left = (image.sourceHalf ?? (side === 'right' ? 1 : 0)) ? '-100%' : '0'; }
  if (shape && !image.mode.startsWith('spread')) { const layout = shapeLayout(shape, surfaceSide); img.style.width = `${layout.width}%`; img.style.height = `${layout.height}%`; img.style.left = `${layout.left}%`; img.style.top = `${layout.top}%`; if (isShapeSource&&surfaceSide !== shape.sourceSide) img.style.transform = 'scaleX(-1)'; }
  viewport.append(img); parent.append(viewport);
}
function appendSticker(parent, sticker, offset = 0) {
  const el = node('div', 'sticker-art'); el.style.left = `${sticker.x - offset}%`; el.style.top = `${sticker.y}%`; el.style.width = `${sticker.width}%`; el.style.transform = `translate(-50%,-50%) rotate(${sticker.rotation}deg)`;
  if (sticker.kind === 'text') {
    el.classList.add('text-art'); el.style.height = `${sticker.height}%`;
    for(const run of JournalStudio.textRuns(sticker)){const span=node('span','',run.text);span.style.fontFamily=run.family;el.append(span);}
    el.style.fontFamily = JournalStudio.fonts[sticker.font]; el.style.fontSize = `${sticker.fontSize}cqw`;
    el.style.fontWeight = sticker.weight; el.style.color = sticker.color; el.style.textAlign = sticker.align;
    el.style.lineHeight = sticker.lineHeight; el.style.letterSpacing = `${sticker.letterSpacing}em`; parent.append(el); return;
  }
  const img = node('img'); img.src = assetURL(sticker.resource); img.alt = ''; img.draggable = false; el.append(img); parent.append(el);
}
function makeFace(surface, side) {
  const loc = M.locate(book, surface.id), face = node('div', `paper-face${loc.cover ? ' cover-face' : ''}${loc.sheet?.shape ? ' shaped-face' : ''}`);
  face.dataset.surfaceId = surface.id;
  const reverse=isReadOnlySurface(surface), source=reverse?loc.sheet[loc.sheet.shape.sourceSide]:surface, sourceLoc=M.locate(book,source.id), sourceSide=reverse?(sourceLoc.side==='front'?'right':'left'):side;
  let paper=face,art=face;
  if(loc.sheet?.shape){
    face.style.background='transparent';const content=node('div','shape-content');if(reverse){content.classList.add('show-through');content.style.transform='scaleX(-1)';}
    paper=node('div','shape-paper-layer');art=node('div','shape-art-layer');
    if(reverse)setShapeMask(content,loc.sheet,sourceLoc.side);
    else {setShapeMask(paper,loc.sheet,sourceLoc.side);setShapeMask(art,loc.sheet,sourceLoc.side,true);}
    content.append(paper,art);face.append(content);
  }
  paper.style.background = color(source.background || book.paperColor);
  const spread = M.getSpread(book, sourceLoc.position), spreadImage = !sourceLoc.cover && spread?.image;
  appendImage(paper, spreadImage || source.image, sourceSide, loc.sheet?.shape, sourceLoc.side);
  const stickers = source.stickers.map(s => ({ s, offset: 0 }));
  if (!sourceLoc.cover && spread) stickers.push(...spread.stickers.map(s => ({ s, offset: sourceSide === 'right' ? 100 : 0 })));
  stickers.sort((a, b) => a.s.zIndex - b.s.zIndex).forEach(x => appendSticker(art, x.s, x.offset));
  if (book.binding === 'bound') paper.append(node('div', `paper-shading ${sourceSide}`)); else applyHoles(face, side);
  return face;
}
function applyHoles(face, side, binding = book.binding, size = book.sizePreset) {
  // Even-odd SVG clipping cuts actual holes through both ordinary and shaped paper.
  const config = bindingGeometry(binding,size), path = ['M 0 0 H 100 V 100 H 0 Z'], x = side === 'left' ? 100 - config.inset : config.inset;
  for (const y of holePositions(config)) { path.push(`M ${x - config.radiusX} ${y} a ${config.radiusX} ${config.radiusY} 0 1 0 ${config.radiusX * 2} 0 a ${config.radiusX} ${config.radiusY} 0 1 0 ${-config.radiusX * 2} 0 Z`); }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'clip-defs');
  const defs = document.createElementNS(svg.namespaceURI, 'defs'), clip = document.createElementNS(svg.namespaceURI, 'clipPath'), outline = document.createElementNS(svg.namespaceURI, 'path');
  const clipId = `holes-${M.id()}`; clip.id = clipId; clip.setAttribute('clipPathUnits', 'objectBoundingBox'); outline.setAttribute('d', path.join(' ')); outline.setAttribute('transform', 'scale(.01)'); outline.setAttribute('clip-rule', 'evenodd'); clip.append(outline); defs.append(clip); svg.append(defs); face.append(svg); face.style.clipPath = `url(#${clipId})`;
}
function beneath(surface, side) {
  const loc = M.locate(book, surface.id), result = [surface]; if (!loc.sheet?.shape) return result;
  let i = loc.index + (side === 'right' ? 1 : -1);
  while (i >= 0 && i < book.sheets.length) { const s = book.sheets[i]; result.push(s[side === 'right' ? 'front' : 'back']); if (!s.shape) return result; i += side === 'right' ? 1 : -1; }
  result.push(book.insides[side === 'right' ? 'back' : 'front']); return result;
}
function makeStack(surface, side, interactive = false) {
  if (!surface) return null;
  const stack = node('div', `leaf-stack ${side}`); stack.dataset.surfaceId = surface.id;
  beneath(surface, side).reverse().forEach(s => stack.append(makeFace(s, side)));
  if (interactive) { stack.classList.add('selectable'); if (selectedId === surface.id && !selectedStickerId) stack.classList.add('selected'); stack.addEventListener('click', () => { if (busy) return; selectedId = surface.id; selectedStickerId = null; render(); }); }
  return stack;
}
function makeMetalRing(binding) {
  const ring=node('i',`metal-ring coil-ring${binding==='binder'?' binder-ring':''}`);
  ring.setAttribute('aria-hidden','true');return ring;
}
function addBinding(root, at, binding = book.binding, size = book.sizePreset, thumbnail = false) {
  if (binding === 'bound') { root.append(node('div', 'spine')); return; }
  const config = bindingGeometry(binding,size), coils = node('div', `coil-binding ${binding === 'binder' ? 'binder-binding' : 'single-coil-binding'}${thumbnail ? ' thumbnail-binding' : ''}`), left = (100 - config.gap) / 2 * (1 - config.inset / 100);
  coils.style.left = `${left}%`; coils.style.width = `${100 - left * 2}%`;
  if(thumbnail){const leaf=(100-config.gap)/2;coils.style.left=`${(left-(100+config.gap)/2)/leaf*100}%`;coils.style.width=`${(100-left*2)/leaf*100}%`;}
  if(binding==='binder')coils.append(node('div','binder-rail'));
  for (const y of holePositions(config)) { const ring = makeMetalRing(binding);ring.style.top = `${y}%`;coils.append(ring); }
  root.append(coils);
}
function shapeEdgePoints(shape,side) {
  const data=shapeAssets.get(shape.resource),layout=shapeLayout(shape,side),outer=[],inner=[];
  const mirrored=side!==shape.sourceSide,rows=96,band=Math.min(layout.width,12);
  for(let row=0;row<=rows;row++) {
    let edge=side==='back'?0:1;
    if(data?.hitAlpha){const y=Math.min(data.pixelHeight-1,Math.floor(row/rows*data.pixelHeight)),fromLeft=shape.sourceSide==='back';let x=fromLeft?0:data.pixelWidth-1;while(x>=0&&x<data.pixelWidth&&!data.hitAlpha[y*data.pixelWidth+x])x+=fromLeft?1:-1;edge=fromLeft?(x>=data.pixelWidth?1:x/data.pixelWidth):(x<0?0:(x+1)/data.pixelWidth);if(mirrored)edge=1-edge;}
    const x=layout.left+edge*layout.width,y=layout.top+row/rows*layout.height;
    outer.push(`${x}% ${y}%`);inner.unshift(`${side==='back'?Math.min(layout.left+layout.width,x+band):Math.max(layout.left,x-band)}% ${y}%`);
  }
  return `polygon(${outer.concat(inner).join(',')})`;
}
function shapeHit(loc,x,y) {
  const shape=loc.sheet.shape,layout=shapeLayout(shape,loc.side),data=shapeAssets.get(shape.resource);
  let u=(x-layout.left)/layout.width,v=(y-layout.top)/layout.height;
  if(u<0||u>=1||v<0||v>=1)return false;
  if(loc.side!==shape.sourceSide)u=1-u;
  return !data?.hitAlpha||!!data.hitAlpha[Math.min(data.pixelHeight-1,Math.floor(v*data.pixelHeight))*data.pixelWidth+Math.min(data.pixelWidth-1,Math.floor(u*data.pixelWidth))];
}
function buildView(at, interactive = false) {
  const root = node('div', 'spread-board'), v = M.view(book, at);
  for (const side of ['left', 'right']) if (v[side]) root.append(makeStack(v[side], side, interactive)); addBinding(root, at);
  if (interactive) addStickerHits(root, at);
  else if (!busy) for (const [side, dir] of [['left', -1], ['right', 1]]) if (v[side] && (dir > 0 ? at <= book.sheets.length : at >= 0)) {
    const edge = node('div', `page-edge ${side}`),loc=M.locate(book,v[side].id); edge.setAttribute('aria-hidden', 'true');
    if(loc.sheet?.shape){edge.classList.add('shaped-edge');edge.style.width='var(--leaf-width)';edge.style.clipPath=shapeEdgePoints(loc.sheet.shape,loc.side);setShapeMask(edge,loc.sheet,loc.side,true);const l=shapeLayout(loc.sheet.shape,loc.side);edge.style.backgroundSize=`${l.width}% ${l.height}%`;edge.style.backgroundPosition=l.position;edge.style.backgroundRepeat='no-repeat';}
    edge.addEventListener('pointerdown', e => {if(loc.sheet?.shape){const r=edge.getBoundingClientRect();if(!shapeHit(loc,(e.clientX-r.left)/r.width*100,(e.clientY-r.top)/r.height*100))return;}startGesture(e, dir);}); root.append(edge);
  }
  return root;
}
function layoutMetrics() { const rect = $book.getBoundingClientRect(), gap = book.binding !== 'bound' ? rect.width * bindingGeometry().gap / 100 : 0; return { rect, gap, leaf: (rect.width - gap) / 2 }; }
function xToPixel(x, m) { return x / 100 * m.leaf + (x > 100 ? m.gap : 0); }
function pixelToX(x, m) { return x <= m.leaf ? x / m.leaf * 100 : x >= m.leaf + m.gap ? 100 + (x - m.leaf - m.gap) / m.leaf * 100 : 100; }
function addStickerHits(root, at) {
  const layer = node('div', 'sticker-hit-layer'); root.append(layer); const gap = book.binding !== 'bound' ? bindingGeometry().gap : 0, fraction = (100 - gap) / 200;
  const view=M.view(book,at);if(isReadOnlySurface(view.left))layer.style.clipPath=`inset(0 0 0 ${(100+gap)/2}%)`;if(isReadOnlySurface(view.right))layer.style.clipPath=`inset(0 ${(100+gap)/2}% 0 0)`;if(isReadOnlySurface(view.left)&&isReadOnlySurface(view.right))return;
  for (const ref of stickerRefs(at).sort((a,b) => a.sticker.zIndex - b.sticker.zIndex)) {
    const s = ref.sticker, hit = node('div', 'sticker-hit' + (s.id === selectedStickerId ? ' selected' : '')), x = s.x + ref.offset;
    hit.dataset.stickerId = s.id; hit.style.left = `${x * fraction + (x > 100 ? gap : 0)}%`; hit.style.top = `${s.y}%`; hit.style.width = `${s.width * fraction}%`; hit.style.aspectRatio = (assets.get(s.resource)?.width || 1) / (assets.get(s.resource)?.height || 1); hit.style.transform = `translate(-50%,-50%) rotate(${s.rotation}deg)`;
    if (s.kind === 'text') hit.style.aspectRatio = s.width * SIZES[book.sizePreset] / s.height;
    hit.classList.toggle('locked',objectLocked(ref));
    if(!multiple && selectedSticker()?.sticker.groupId===s.groupId && s.groupId)hit.classList.add('selected');
    hit.setAttribute('role', 'button'); hit.setAttribute('aria-label', s.locked?'Locked object':s.groupId?'Object group':'Edit object'); hit.tabIndex = 0;
    hit.addEventListener('pointerdown', e => startStickerDrag(e, ref)); hit.addEventListener('keydown', e => { if (e.key === 'Enter') { selectedStickerId = s.id; render(); } }); layer.append(hit);
  }
}

function button(text, fn, cls = '') { const el = node('button', cls, text); el.type = 'button'; el.addEventListener('click', fn); return el; }
function section(title, description) { const el = node('section', 'tool-card'); el.append(node('h3', '', title)); if (description) el.append(node('p', 'hint', description)); return el; }
function buttons(parent, ...children) { const row = node('div', 'button-row'); row.append(...children); parent.append(row); }
function renderList() {
  const list = $('#pageList'); list.replaceChildren();
  list.append(button('Front cover', () => selectSurface(book.covers.front.id), `cover-tab${selected()?.cover === 'front' ? ' active' : ''}`));
  M.blocks(book).forEach(group => {
    const block = node('div', 'sheet-block'); if (group.length > 1) block.append(node('div', 'linked-label', 'Linked sheets'));
    group.forEach(s => {
      const index = book.sheets.indexOf(s), card = node('div', 'sheet-card' + (selected()?.sheet?.id === s.id ? ' active' : ''));
      const head = node('div', 'sheet-heading'); head.append(node('span', '', `Sheet ${index + 1}`)); const controls = node('div', 'sheet-actions');
      controls.append(button('↑', () => moveSheet(s.id, -1)), button('↓', () => moveSheet(s.id, 1))); controls.children[0].title = 'Move sheet forward'; controls.children[1].title = 'Move sheet backward'; head.append(controls); card.append(head);
      const faces = node('div', 'face-tabs');
      for (const side of ['front', 'back']) {
        const tab = button('', () => selectSurface(s[side].id), selectedId === s[side].id ? 'active' : ''), thumb = node('span', 'face-thumb'); thumb.style.background = color(s[side].background || book.paperColor);
        if (s.shape) { thumb.style.height = `${30 / SIZES[book.sizePreset]}px`; setShapeMask(thumb, s, side); thumb.classList.add('shape-thumb'); }
        const spread = M.getSpread(book, index + (side === 'back' ? 1 : 0)), image = spread?.image || s[side].image;
        if (image && s.shape) appendImage(thumb, image, side === 'front' ? 'right' : 'left', s.shape, side);
        else if (image) { const preview = node('img'); preview.src = assetURL(image.resource); preview.alt = ''; thumb.append(preview); }
        tab.append(thumb, node('strong', '', side === 'front' ? 'Front' : 'Back'), node('small', '', spread?.image ? 'Spread image' : surfaceLabel(s[side]))); faces.append(tab);
      }
      card.append(faces); block.append(card);
    }); list.append(block);
  });
  list.append(button('Back cover', () => selectSurface(book.covers.back.id), `cover-tab${selected()?.cover === 'back' ? ' active' : ''}`));
}
function palette(parent, value, onChange) {
  const row = node('div', 'palette');
  for (const key of PALETTE) { const hex = COLORS[key], b = button('', () => onChange(key), color(value) === hex ? 'active' : ''); b.style.background = hex; b.title = { black:'Ink',graphite:'Graphite',charcoal:'Charcoal',stone:'Stone',ash:'Grey',silver:'Silver',paper:'Paper',cream:'Warm white',white:'White' }[key]; b.setAttribute('aria-label',b.title); row.append(b); }
  const custom = node('input'); custom.type = 'color'; custom.value = color(value); custom.title = 'Custom colour'; custom.setAttribute('aria-label','Custom colour'); custom.addEventListener('change', () => onChange(custom.value)); row.append(custom); parent.append(row);
}
function range(parent, label, value, min, max, update, suffix = '') {
  const wrap = node('label', 'range-field'), heading = node('span', 'range-heading'), output = node('output', '', `${Math.round(value)}${suffix}`);
  heading.append(node('span','',label), output); const input = node('input'); input.type = 'range'; input.min = min; input.max = max; input.value = value;
  input.addEventListener('input', () => { output.textContent = `${input.value}${suffix}`; update(Number(input.value)); save(input); renderBook(); }); wrap.append(heading,input); parent.append(wrap);
  input.addEventListener('change', () => { historyKey=null;renderList(); renderTools(); });
}
function paperSideOptions(loc) {
  const panel=section('Paper sides'),row=node('div','segmented');
  for(const [value,label] of [['independent','Independent'],['show-through','Show-through']])row.append(button(label,()=>{loc.sheet.shape.sideMode=value;selectedStickerId=null;save();render();},(loc.sheet.shape.sideMode||'independent')===value?'active':''));
  panel.append(row);return panel;
}
function renderTools() {
  const body = $('#toolBody'); body.replaceChildren(); const loc = selected(); $('#toolTitle').textContent = caption(loc); if (!loc) return;
  if(loc.sheet?.shape)body.append(paperSideOptions(loc));
  if(isReadOnlySurface(loc.surface)){const panel=section('Reverse · read only');panel.append(button('Edit other side',()=>selectSurface(loc.sheet[loc.sheet.shape.sourceSide].id)));body.append(panel);return;}
  const p = loc.surface;
  if (loc.inside) { const intro = section('Inside cover'); intro.append(button('+ Sheet', addSheet, 'wide')); body.append(intro); }
  else {
    const base = section(loc.cover ? 'Cover' : 'Paper');
    palette(base, p.background || book.paperColor, v => { p.background = v; save(); render(); }); base.append(button('+ Image', chooseImage, 'wide primary'));
    if (loc.sheet) buttons(base, button('Duplicate sheet', duplicateSheet), button('Delete sheet', deleteSheet, 'danger')); body.append(base);
  }
  const spread = M.getSpread(book, position), image = spread?.image || p.image;
  if (image && !loc.inside) {
    const panel = section('Image layout');
    if (image.mode !== 'alpha-shaped') {
      const row = node('div', 'segmented'); for (const [label, fit] of [['Fill','cover'],['Fit','contain']]) row.append(button(label, () => { image.mode = `${image.mode.startsWith('spread') ? 'spread' : 'single'}-${fit}`; save(); render(); }, image.mode.endsWith(fit) ? 'active' : '')); panel.append(row);
      if (image.mode.endsWith('cover')) { range(panel,'Horizontal position',image.positionX ?? 50,0,100,v => image.positionX = v,'%'); range(panel,'Vertical position',image.positionY ?? 50,0,100,v => image.positionY = v,'%'); }
    }
    panel.append(button(spread?.image ? 'Remove spread image' : 'Remove image', () => { if (spread?.image) spread.image = null; else p.image = null; save(); render(); }, 'quiet danger wide')); body.append(panel);
  }
  if (loc.sheet?.shape) {
    const panel = section('Paper shape'); range(panel,'Size',loc.sheet.shape.scale,10,100,v => loc.sheet.shape.scale = v,'%');
    range(panel,'Vertical position',loc.sheet.shape.positionY ?? 50,0,100,v => loc.sheet.shape.positionY = v,'%');
    panel.append(button('Reset paper shape', () => { for (const side of ['front','back']) if (loc.sheet[side].image?.mode === 'alpha-shaped') loc.sheet[side].image.mode = 'single-contain'; loc.sheet.shape = null; save(); render(); }, 'quiet wide')); body.append(panel);
  }
  const ref = selectedSticker();
  if (ref && !objectLocked(ref) && !ref.sticker.groupId) {
    const s = ref.sticker, panel = section('Selected object'); range(panel,'Size',s.width,5,200,v => { s.width = v; normalizeSticker(ref); },'%'); range(panel,'Rotation',s.rotation,-180,180,v => { s.rotation = v; normalizeSticker(ref); },'°');
    buttons(panel,button('Send backward', () => changeLayer(-1)),button('Bring forward', () => changeLayer(1))); buttons(panel,button('Duplicate',copySticker),button('Delete',deleteSticker,'danger')); body.append(panel);
  }
}

function addSheet() {
  if (busy) return; const fresh = M.add(book); if (!fresh) { toast('Remove the inside-cover spread artwork before adding here.'); return; }
  editing = true; navigateToSurface(fresh.front.id); selectedStickerId = null; save(); render();
}
function moveSheet(id, dir) { if (busy) return; if (!M.move(book,id,dir)) { toast('Cannot move past the edge or an inside-cover link.'); return; } navigateToSurface(selectedId); save(); render(); }
function duplicateSheet() {
  const loc = selected(); if (!loc?.sheet) return; const fresh = M.duplicate(book,loc.sheet.id); if (!fresh) { toast('This sheet is linked to the back inside cover. It cannot be duplicated here.'); return; }
  navigateToSurface(fresh[loc.side].id); selectedStickerId = null; save(); render();
}
function deleteSheet() {
  const loc = selected(); if (!loc?.sheet) return; const group = M.blockFor(book,loc.sheet.id);
  if (!confirm(group.length > 1 ? `Delete all ${group.length} linked sheets, including both sides?` : 'Delete both sides of this sheet?')) return;
  M.remove(book,loc.sheet.id); position = Math.min(position,book.sheets.length); defaultSelection(); selectedStickerId = null; save(); render();
}
function changeLayer(dir) {
  const ref = selectedSticker(); if (!ref || objectLocked(ref) || ref.sticker.groupId) return; const all = stickerRefs().sort((a,b)=>a.sticker.zIndex-b.sticker.zIndex), index = all.findIndex(r=>r.sticker.id === ref.sticker.id), target = index + dir;
  if (target < 0 || target >= all.length) return; [all[index],all[target]] = [all[target],all[index]]; all.forEach((r,i)=>r.sticker.zIndex = i); save(); render();
}
function copySticker() { duplicateObjects(); }
function deleteSticker() { deleteObjects(); }
function startStickerDrag(e, ref) {
  if (busy || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); const s = ref.sticker, oldX = s.x + ref.offset, oldY = s.y, startX = e.clientX, startY = e.clientY, metrics = layoutMetrics();
  selectedStickerId = s.id; if (ref.surface) selectedId = ref.surface.id; let moved = false; $book.setPointerCapture(e.pointerId); renderTools();
  if(objectLocked(ref)){renderBook();return;}
  const moving=groupMembers(ref).map(r=>({ref:r,x:r.sticker.x+r.offset,y:r.sticker.y}));
  const lo=currentView().closed==='front'?100:0, hi=currentView().closed==='back'?100:200;
  const minX=Math.min(...moving.map(r=>r.x)),maxX=Math.max(...moving.map(r=>r.x)),minY=Math.min(...moving.map(r=>r.y)),maxY=Math.max(...moving.map(r=>r.y));
  busy=true;lockUI();
  const move = ev => {
    if (Math.hypot(ev.clientX-startX,ev.clientY-startY) < 2 && !moved) return; moved = true;
    const dx=clamp(pixelToX(xToPixel(oldX,metrics)+ev.clientX-startX,metrics)-oldX,Math.min(0,lo-minX),Math.max(0,hi-maxX));
    const dy=clamp((ev.clientY-startY)/metrics.rect.height*100,Math.min(0,-minY),Math.max(0,100-maxY));
    moving.forEach(r=>{r.ref.sticker.x=r.x+dx-r.ref.offset;r.ref.sticker.y=r.y+dy;});
    if(s.groupId)normalizeGroup(moving.map(r=>r.ref));else normalizeSticker(ref);renderBook();
  };
  const end = () => { $book.removeEventListener('pointermove',move); $book.removeEventListener('pointerup',end); $book.removeEventListener('pointercancel',end);$book.removeEventListener('lostpointercapture',end);busy=false; if (moved) save();lockUI(); render(); };
  $book.addEventListener('pointermove',move); $book.addEventListener('pointerup',end); $book.addEventListener('pointercancel',end);$book.addEventListener('lostpointercapture',end); renderBook();
}

function chooseImage() { if (busy || !selected() || selected().inside || isReadOnlySurface(selected().surface)) return; $('#imageInput').value = ''; $('#imageInput').click(); }
async function acceptFile(file) {
  if (!file?.type.startsWith('image/')) { toast('Choose a PNG, JPEG, WebP or other supported image.'); return; } const loc = selected(); if (!loc || loc.inside || isReadOnlySurface(loc.surface)) return;
  pendingImport = { file, targetId: loc.surface.id, at: position }; $('#importFileName').textContent = file.name;
  document.querySelectorAll('[data-import]').forEach(btn => {btn.disabled=!canImportMode(loc,btn.dataset.import,position);});
  $('#importNote').textContent = loc.cover ? '' : ''; $('#importDialog').showModal();
}
async function importImage(mode) {
  if (!pendingImport || busy) return; const pending = pendingImport, loc = M.locate(book,pending.targetId); if (!canImportMode(loc,mode,pending.at)) return;
  if (!mode.startsWith('spread') && mode !== 'sticker' && M.getSpread(book,pending.at)?.image && !confirm('Replace the shared spread image with this page image?')) return;
  $('#importDialog').close(); busy = true; lockUI();
  try {
    const originalResource = pending.originalFile ? await storeAsset(pending.originalFile) : null;
    const resource = await storeAsset(pending.file), p = loc.surface;
    if (mode === 'sticker') {
      const s = { id: M.id(), resource, x: 50, y: 50, width: 38, rotation: 0, zIndex: Math.max(0,...stickerRefs().map(r=>r.sticker.zIndex))+1 };
      if(loc.sheet?.shape){const layout=shapeLayout(loc.sheet.shape,loc.side);s.x=layout.left+layout.width/2;s.y=layout.top+layout.height/2;s.width=Math.min(s.width,layout.width*.6);}
      p.stickers.push(s); selectedStickerId = s.id;
    } else if (mode.startsWith('spread')) { const spread = M.getSpread(book,pending.at,true); spread.image = { resource, mode, positionX:50, positionY:50 }; selectedStickerId = null; }
    else {
      if (mode === 'alpha-shaped') { await prepareShape(resource); loc.sheet.shape = { resource, scale:100, sourceSide:loc.side, sideMode:loc.sheet.shape?.sideMode||'independent' }; }
      const spread = M.getSpread(book,pending.at); if (spread) spread.image = null; p.image = { resource, mode, positionX:50, positionY:50 }; selectedStickerId = null;
    }
    if (originalResource) {
      const target = mode === 'sticker' ? p.stickers.at(-1) : mode.startsWith('spread') ? M.getSpread(book,pending.at).image : p.image;
      target.originalResource = originalResource; target.crop = pending.crop;
    }
    save(); toast('Image added.');
  } catch (error) { console.error(error); toast('Could not import the image. Check its format and device storage.'); }
  finally { pendingImport = null; busy = false; lockUI(); render(); }
}

function lockUI() { $('#sidebar').inert = busy; $('#tools').inert = busy; $('#modeBtn').disabled = busy; $('#settingsBtn').disabled = busy; updateNav();updateHistoryButtons(); }
function beginTurn(dir) {
  const next = position + dir; if (busy || next < -1 || next > book.sheets.length + 1) return null;
  busy = true; lockUI(); const old = position, from = M.view(book,old), to = M.view(book,next), side = dir > 0 ? 'right' : 'left', stationary = dir > 0 ? 'left' : 'right';
  const base = buildView(next,false); $('.coil-binding, .spine',base)?.remove(); $(`.leaf-stack.${stationary}`,base)?.remove(); if (from[stationary]) base.append(makeStack(from[stationary],stationary));
  $book.replaceChildren(base); $book.classList.remove('closed-front','closed-back');
  const leaf = node('div',`turn-sheet ${dir > 0 ? 'forward' : 'backward'}`), source = M.locate(book,from[side].id);
  const flexible = Boolean(source.sheet) && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const count = flexible ? 6 : 1, panels = [], shades = [], faces = [];
  for (let i = 0; i < count; i++) {
    const panel = node('div','turn-panel'), front = node('div','turn-face'), back = node('div','turn-face reverse');
    front.append(makeFace(from[side],side)); back.append(makeFace(to[stationary],stationary));
    if (count > 1) {
      // Each strip sees the same original artwork. On the reverse, the crop
      // is mirrored because that entire face rotates around its centre.
      const overlap = source.sheet.shape ? 0 : .02;
      const start = Math.max(0,i / count * 100 - overlap), end = Math.min(100,(i + 1) / count * 100 + overlap);
      front.style.clipPath = `inset(0 ${100 - end}% 0 ${start}%)`;
      back.style.clipPath = `inset(0 ${start}% 0 ${100 - end}%)`;
    }
    for (const [face, surface, shadeSide] of [[front,from[side],side],[back,to[stationary],stationary]]) {
      const shade = node('div','turn-shade'), loc = M.locate(book,surface.id); setShapeMask(shade,loc.sheet,loc.side);
      if(loc.sheet?.shape){const l=shapeLayout(loc.sheet.shape,loc.side);shade.style.backgroundSize=`${l.width}% ${l.height}%`;shade.style.backgroundPosition=l.position;shade.style.backgroundRepeat='no-repeat';}
      if (book.binding !== 'bound') applyHoles(shade,shadeSide); face.append(shade); shades.push(shade);
    }
    panel.append(front,back); leaf.append(panel); panels.push(panel); faces.push(front,back);
  }
  base.append(leaf); if (book.binding !== 'bound') addBinding(base,next);
  const metrics = layoutMetrics();
  const context = { dir, old, next, progress:0, leaf, shades, faces, panels, width:metrics.leaf, dragWidth:metrics.leaf*(source.sheet?.shape?shapeLayout(source.sheet.shape,source.side).width/100:1), gap:metrics.gap }; paintTurn(context,0); return context;
}
function pageBend(width, direction, progress, count) {
  const curve = progress <= 0 || progress >= 1 ? 0 : Math.sin(Math.PI * progress);
  const bend = count > 1 ? curve * 12 : 0, step = width / count, result = [];
  let x = direction > 0 ? 0 : width, z = 0;
  for (let order = 0; order < count; order++) {
    const index = direction > 0 ? order : count - order - 1;
    const origin = (index + (direction < 0 ? 1 : 0)) * step;
    const angle = direction * bend * (order + .5) / count, radians = angle * Math.PI / 180;
    result[index] = { origin:origin / width * 100, x:x - origin, z, angle };
    // Integrating each strip's end keeps the next strip attached, in either direction.
    x += direction * step * Math.cos(radians); z -= direction * step * Math.sin(radians);
  }
  return result;
}
function paintTurn(context, progress) {
  context.progress = progress; const curve = Math.sin(Math.PI * progress);
  context.leaf.style.transform = `translateX(${-context.dir * context.gap * progress}px) rotateY(${-context.dir * 180 * progress}deg)`;
  const bends = pageBend(context.width,context.dir,progress,context.panels.length);
  context.panels.forEach((panel,index) => {
    const bend = bends[index]; panel.style.transformOrigin = `${bend.origin}% center`;
    panel.style.transform = `translateX(${bend.x}px) translateZ(${bend.z}px) rotateY(${bend.angle}deg)`;
  });
  if (context.panels.length === 1) for (const face of context.faces) face.style.filter = `drop-shadow(${context.dir * curve * -10}px ${curve * 7}px ${curve * 12}px rgba(25,25,25,${curve * .16}))`;
  for (const shade of context.shades) { shade.style.opacity = String(curve * .22); shade.style.backgroundImage = `linear-gradient(${context.dir > 0 ? 90 : 270}deg,transparent 25%,#191919 100%)`; }
}
function settleTurn(context, commit) {
  const start = performance.now(), from = context.progress, target = commit ? 1 : 0, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches, duration = reduced ? 90 : Math.max(180,560 * Math.abs(target-from));
  function tick(now) { const t = clamp((now-start)/duration,0,1), eased = 1 - Math.pow(1-t,3); paintTurn(context,from+(target-from)*eased); if (t < 1) requestAnimationFrame(tick); else { position = commit ? context.next : context.old; busy = false; defaultSelection(); selectedStickerId = null; lockUI(); render(); } }
  requestAnimationFrame(tick);
}
function turn(dir) { const context = beginTurn(dir); if (context) settleTurn(context,true); }
function startGesture(e, dir) {
  if (editing || e.button !== 0) return; e.preventDefault(); const startX = e.clientX, startY = e.clientY, context = beginTurn(dir); if (!context) return; const width=context.dragWidth;
  $book.setPointerCapture(e.pointerId); let lastX = startX, moved = false;
  const move = ev => { lastX = ev.clientX; moved ||= Math.hypot(lastX-startX,ev.clientY-startY) > 7; paintTurn(context,clamp((startX-lastX)*dir / (width*1.6),0,1)); };
  const end = ev => { $book.removeEventListener('pointermove',move); $book.removeEventListener('pointerup',end); $book.removeEventListener('pointercancel',end); settleTurn(context,ev.type !== 'pointercancel' && (!moved || context.progress > .22)); };
  $book.addEventListener('pointermove',move); $book.addEventListener('pointerup',end); $book.addEventListener('pointercancel',end);
}

function options(selector, choices, value) { const root = $(selector); root.replaceChildren(); for (const [key,label] of choices) { const b = button(label,() => { root.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x === b)); },key === value ? 'active' : ''); b.dataset.value = key; root.append(b); } }
function openSettings() {
  $('#titleInput').value = book.title; options('#sizeOptions',[['A5','A5'],['B5','B5'],['square','Square']],book.sizePreset); options('#bindingOptions',[['bound','Bound'],['coil','Coil']],book.binding); options('#paperOptions',[['black','Black'],['silver','Grey'],['cream','Warm white'],['white','White']],book.paperColor);
  options('#themeOptions',[['light','Light'],['dark','Dark']],book.uiTheme || 'light'); $('#settingsDialog').showModal();
}
function setupEvents() {
  $('#modeBtn').addEventListener('click',()=>{ editing = !editing; selectedStickerId = null; render(); }); $('#settingsBtn').addEventListener('click',()=>openSettings()); $('#addPageBtn').addEventListener('click',addSheet);
  $('#bookTitle').addEventListener('click',()=>{ if (busy) return; if (!editing) { editing = true; selectedStickerId = null; render(); } else openSettings(); });
  $('#bookTitle').addEventListener('keydown',e=>{ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#bookTitle').click(); } });
  $('#prevBtn').addEventListener('click',()=>turn(-1)); $('#nextBtn').addEventListener('click',()=>turn(1)); $('#settingsCloseBtn').addEventListener('click',()=>$('#settingsDialog').close()); $('#settingsCancelBtn').addEventListener('click',()=>$('#settingsDialog').close());
  $('#settingsForm').addEventListener('submit',e=>{ e.preventDefault(); book.title = $('#titleInput').value.trim() || 'My journal';book.category=$('#categoryInput').value.trim(); book.sizePreset = $('#sizeOptions .active').dataset.value; book.binding = $('#bindingOptions .active').dataset.value; book.paperColor = $('#paperOptions .active')?.dataset.value || book.paperColor; book.uiTheme = $('#themeOptions .active').dataset.value; $('#settingsDialog').close(); save(); render(); });
  $('#imageInput').addEventListener('change',e=>{ if (e.target.files[0]) void acceptFile(e.target.files[0]); }); $('#importCloseBtn').addEventListener('click',()=>{ pendingImport = null; $('#importDialog').close(); }); document.querySelectorAll('[data-import]').forEach(b=>b.addEventListener('click',()=>void importImage(b.dataset.import)));
  document.addEventListener('keydown',e=>{ if (busy || $('dialog[open]') || ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return; if (e.key === 'ArrowRight' && !editing) { e.preventDefault(); turn(1); } if (e.key === 'ArrowLeft' && !editing) { e.preventDefault(); turn(-1); } if (e.key === 'Escape' && editing) { selectedStickerId = null; render(); } });
}
async function init() {
  try {
    db = await openDB(); const stored = (await request(db.transaction('books','readonly').objectStore('books').getAll())).filter(b=>!b.deletedAt).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0];
    const result = stored ? M.migrate(stored) : { book:M.createBook(), changed:false }; book = result.book; bookUnstored = !stored;
    if (stored && result.changed) { const tx = db.transaction('backups','readwrite'), done = txDone(tx); tx.objectStore('backups').put({ id:`before-v2-${stored.id}`, book:stored, createdAt:Date.now() }); await done; }
    const storedAssets = await request(db.transaction('assets','readonly').objectStore('assets').getAll());
    for (const data of storedAssets) { const url = URL.createObjectURL(data.blob); assets.set(data.id,{ ...data,url }); if (!data.width) { try { const image = await decode(url); Object.assign(assets.get(data.id),{ width:image.naturalWidth,height:image.naturalHeight }); } catch { /* Keep the rest of a legacy notebook usable if one image is missing. */ } } }
    for (const s of book.sheets) if (s.shape && assetURL(s.shape.resource)) await prepareShape(s.shape.resource);
    defaultSelection();resetHistory(); setupEvents(); installStudio();installEditing(); render(); $('#saveStatus').textContent = 'Saved on this device'; if (result.changed) save(); if (stored && result.changed) toast('Notebook upgraded. The original was backed up.'); await openLibrary();
  } catch (error) { console.error(error); $('#saveStatus').textContent = 'Could not load local data.'; toast('Could not load your notebooks. Close other journal tabs and reload; keep your browser data.'); }
}
void init();
