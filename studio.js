'use strict';
const Studio = JournalStudio;
let libraryFilter = 'all', studioInstalled = false, multiple = false, selectedObjects = new Set(), alignTarget = 'page';
let operationBusy = false;
let librarySelecting = false, librarySelected = new Set(), libraryVisible = [];
function updateLibrarySelection() {
  $('#librarySelect').textContent=librarySelecting?'Done':'Select';
  $('#libraryBatch').hidden=!librarySelecting;
  $('#libraryCount').textContent=`${librarySelected.size} selected`;
  $('#batchRestore').hidden=libraryFilter!=='trash';
  $('#batchDelete').textContent=libraryFilter==='trash'?'Delete permanently':'Move to trash';
  for(const id of ['batchRestore','batchDelete','batchExport'])$('#'+id).disabled=!librarySelected.size;
  for(const card of $('#libraryGrid').children) {
    const selected=librarySelected.has(card.dataset.bookId);card.classList.toggle('is-selected',selected);
    const open=$('.library-open',card);if(open&&librarySelecting)open.setAttribute('aria-pressed',String(selected));
  }
}
async function changeLibrarySelection(restore=false) {
  await persistBook();
  const selected=(await allBooks()).filter(b=>librarySelected.has(b.id)&&Boolean(b.deletedAt)===restore);
  const now=Date.now();for(const b of selected){if(restore)delete b.deletedAt;else b.deletedAt=now;}
  await writeBooks(selected);
  const current=selected.find(b=>b.id===book.id);if(current){if(restore)delete book.deletedAt;else book.deletedAt=current.deletedAt;}
  resetHistory();librarySelected.clear();await openLibrary();
}
function confirmSelectedDeletion() {
  const ids=[...librarySelected];if(!ids.length)return;
  dangerDialog('Delete permanently',`Remove ${ids.length} notebooks and their unused images? This cannot be undone.`,()=>removeLocalData(ids));
}
async function persistBook() {
  await saveTask;
  if (savedRevision < saveRevision) { saveTask = flushSave(); await saveTask; }
  if (savedRevision < saveRevision) throw new Error('Please export a backup. Local storage could not be saved.');
}
async function studioAction(action) {
  if (operationBusy || busy) return;
  operationBusy = true; const previousBusy = busy; busy = true; lockUI();
  $('#libraryDialog').inert = true;
  try { await action(); } catch (error) { console.error(error); toast(error.message || 'Could not complete this action.'); }
  finally { operationBusy = false; busy = previousBusy; $('#libraryDialog').inert = false; lockUI(); render(); }
}
async function allBooks() { return request(db.transaction('books','readonly').objectStore('books').getAll()); }
async function writeBooks(books) {
  const tx = db.transaction('books','readwrite'), done = txDone(tx); for (const b of books) tx.objectStore('books').put(b); await done;
}
async function loadNotebook(value, edit = false) {
  await persistBook();
  const migrated = M.migrate(value);
  if (migrated.changed) {
    const tx=db.transaction(['backups','books'],'readwrite'), done=txDone(tx);
    tx.objectStore('backups').put({id:`before-v2-${value.id}`,book:value,createdAt:Date.now()}); tx.objectStore('books').put(migrated.book); await done;
  }
  releaseShapeCache(); book = migrated.book; bookUnstored=false; saveRevision=0; savedRevision=0; position=-1; selectedStickerId=null; selectedObjects.clear(); multiple=false; editing=edit;
  for (const sheet of book.sheets) if (sheet.shape && assetURL(sheet.shape.resource)) await prepareShape(sheet.shape.resource);
  defaultSelection();resetHistory(); $('#libraryDialog').close(); render();
}
function labeledInput(parent, label, value, update, type='text') {
  const wrap=node('label','studio-field',label), input=node('input'); input.type=type; input.value=value; wrap.append(input); parent.append(wrap); input.addEventListener('change',()=>update(input.value)); return input;
}
let activeSelect = null;
function closeSelect(restoreFocus=false) {
  if(!activeSelect)return;const {trigger,list}=activeSelect;list.hidden=true;trigger.setAttribute('aria-expanded','false');activeSelect=null;
  if(restoreFocus&&trigger.isConnected)trigger.focus();
}
function selectControl(parent,label,choices,value,update) {
  const wrap=node('div','studio-field'), caption=node('span','',label), control=node('div','custom-select');
  const trigger=button(choices.find(c=>c[0]===value)?.[1]||'Select',()=>toggle(),'select-trigger'),list=node('div','select-list');
  const id=`select-${M.id()}`;caption.id=`${id}-label`;trigger.id=`${id}-button`;list.id=id;trigger.value=value;
  trigger.setAttribute('aria-labelledby',`${caption.id} ${trigger.id}`);trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',id);
  list.setAttribute('role','listbox');list.setAttribute('aria-label',label);list.hidden=true;
  let current=Math.max(0,choices.findIndex(c=>c[0]===value));const options=[];
  function choose(index){current=index;trigger.value=choices[index][0];trigger.textContent=choices[index][1];options.forEach((o,i)=>o.setAttribute('aria-selected',String(i===index)));closeSelect(true);update(trigger.value);}
  function toggle(){if(activeSelect?.trigger===trigger){closeSelect();return;}closeSelect();list.hidden=false;trigger.setAttribute('aria-expanded','true');activeSelect={trigger,list,control};options[current]?.focus();}
  choices.forEach(([key,title],index)=>{const option=button(title,()=>choose(index),'select-option');option.setAttribute('role','option');option.setAttribute('aria-selected',String(key===value));option.tabIndex=-1;options.push(option);list.append(option);});
  trigger.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();if(list.hidden)toggle();const target=e.key==='End'?options.length-1:e.key==='Home'?0:current;options[target]?.focus();}});
  list.addEventListener('keydown',e=>{
    const index=options.indexOf(document.activeElement);
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeSelect(true);return;}
    if(e.key==='Tab'){closeSelect(true);return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const next=e.key==='Home'?0:e.key==='End'?options.length-1:(index+(e.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next]?.focus();}
  });
  control.append(trigger,list);wrap.append(caption,control);parent.append(wrap);return trigger;
}
async function openLibrary() {
  if (busy && !operationBusy) return;
  closeSelect();
  await persistBook(); const books=await allBooks(), root=$('#libraryGrid'); root.replaceChildren();
  const categories=[...new Set(books.filter(b=>!b.deletedAt).map(b=>b.category).filter(Boolean))].sort();
  if(libraryFilter.startsWith('category:')&&!categories.includes(libraryFilter.slice(9)))libraryFilter='all';
  const filters=$('#libraryFilters'); filters.replaceChildren();
  selectControl(filters,'Collection',[['all','All'],...categories.map(c=>['category:'+c,c]),['trash','Recently deleted']],libraryFilter,value=>{libraryFilter=value; librarySelected.clear();void studioAction(openLibrary);});
  const list=books.filter(b=>libraryFilter==='trash'?b.deletedAt:!b.deletedAt&&(libraryFilter==='all'||b.category===libraryFilter.slice(9))).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  libraryVisible=list.map(b=>b.id);librarySelected=new Set([...librarySelected].filter(id=>libraryVisible.includes(id)));
  for(const b of list) {
    const card=node('article','library-card'), open=button('',()=>{if(librarySelecting){librarySelected.has(b.id)?librarySelected.delete(b.id):librarySelected.add(b.id);updateLibrarySelection();}else void studioAction(()=>loadNotebook(b));},'library-open');
    card.dataset.bookId=b.id;
    const cover=node('div','library-cover'),ratio=Studio.sizes[b.sizePreset]||Studio.sizes.A5;cover.style.aspectRatio=ratio;cover.style.width=`min(calc(100% - 10px), ${205*ratio}px)`;
    const previewBook=M.migrate(b).book, previewFace=node('div','paper-face cover-face');previewFace.style.background=color(previewBook.covers.front.background||previewBook.paperColor);cover.classList.add(`preview-${previewBook.binding}`);
    appendImage(previewFace,previewBook.covers.front.image,'right',null,'front');
    [...previewBook.covers.front.stickers].sort((a,b)=>a.zIndex-b.zIndex).forEach(s=>appendSticker(previewFace,s));
    if(previewBook.binding!=='bound')applyHoles(previewFace,'right',previewBook.binding,previewBook.sizePreset);cover.append(previewFace);
    if(previewBook.binding!=='bound')addBinding(cover,-1,previewBook.binding,previewBook.sizePreset,true);
    open.append(cover,node('h3','',b.title||'Untitled')); open.disabled=Boolean(b.deletedAt)&&!librarySelecting; card.append(open);
    if(b.category) card.append(node('small','',b.category));
    const menu=node('details','book-menu'), summary=node('summary','','•••'); summary.setAttribute('aria-label','Manage notebook'); menu.append(summary);
    if(b.deletedAt) menu.append(button('Restore',()=>void studioAction(async()=>{delete b.deletedAt;if(book.id===b.id)delete book.deletedAt;await writeBooks([b]);await openLibrary();})),button('Delete permanently',()=>confirmDeletion(b)));
    else {
      menu.append(button('Rename',()=>editLibraryDetails(b)),button('Collection',()=>editLibraryDetails(b)),button('Duplicate',()=>void studioAction(async()=>{const copy=M.clone(b);copy.id=M.id();copy.title=`${b.title} — Copy`;copy.updatedAt=Date.now();await writeBooks([copy]);await openLibrary();})),button('Export',()=>void studioAction(()=>exportNotebooks([b]))),button('Move to trash',()=>void studioAction(async()=>{
        b.deletedAt=Date.now(); await writeBooks([b]);
        if(book.id===b.id) { book.deletedAt=b.deletedAt; }
        await openLibrary();
      })));
    }
    menu.hidden=librarySelecting;card.append(menu); root.append(card);
  }
  if(!list.length) root.append(node('p','empty-library',libraryFilter==='trash'?'No deleted notebooks.':'Your next notebook starts here.'));
  if(!$('#libraryDialog').open) $('#libraryDialog').showModal();
  $('#libraryClose').hidden=bookUnstored||Boolean(book.deletedAt);
  updateLibrarySelection();
  const bytes=[...assets.values()].reduce((sum,a)=>sum+(a.blob?.size||0),0);$('#storageUsage').textContent=`Images: ${(bytes/1024/1024).toFixed(1)} MB · Includes recently deleted notebooks.`;
}
function releaseShapeCache(resource) {
  for(const [id,data] of shapeAssets) if(!resource||resource===id) {
    for(const value of Object.values(data))if(typeof value==='string'&&value.startsWith('blob:'))URL.revokeObjectURL(value);
    shapeAssets.delete(id);
  }
}
function blankCurrentNotebook() {
  releaseShapeCache();book=M.createBook();bookUnstored=true;saveRevision=0;savedRevision=0;position=-1;editing=false;selectedStickerId=null;selectedObjects.clear();multiple=false;defaultSelection();resetHistory();
}
function referencedAssets(books,backups=[]) {
  const keep=new Set();for(const raw of [...books,...backups.map(b=>b.book).filter(Boolean)])Studio.resources(M.migrate(raw).book,keep);return keep;
}
// Read and remove in one transaction so shared images cannot be collected
// between a concurrent notebook write and a separate deletion transaction.
async function removeLocalData(notebookId=null) {
  const ids=notebookId===null?null:new Set(Array.isArray(notebookId)?notebookId:[notebookId]);
  if(ids?.size===0)return;
  // Clearing data must remain possible even when the device is too full to save.
  if(ids===null||ids.has(book.id))await saveTask;else await persistBook();
  const tx=db.transaction(['books','assets','backups'],'readwrite'), done=txDone(tx);
  let snapshot, failure;
  const requests=['books','assets','backups'].map(name=>({name,req:tx.objectStore(name).getAll()}));let ready=0;
  for(const {name,req} of requests)req.onsuccess=()=>{
    snapshot ||= {};snapshot[name]=req.result;if(++ready!==requests.length)return;
    try {
      if(ids!==null&&[...ids].some(id=>!snapshot.books.some(b=>b.id===id&&b.deletedAt)))throw new Error('Move the notebook to Recently deleted first.');
      const remainingBooks=ids===null?[]:snapshot.books.filter(b=>!ids.has(b.id));
      const remainingBackups=ids===null?[]:snapshot.backups.filter(b=>!ids.has(b.book?.id)&&![...ids].some(id=>b.id===`before-v2-${id}`));
      const keep=referencedAssets(remainingBooks,remainingBackups), retainedBackups=new Set(remainingBackups.map(b=>b.id));
      snapshot.removedAssets=snapshot.assets.filter(a=>!keep.has(a.id)).map(a=>a.id);
      for(const b of snapshot.books)if(ids===null||ids.has(b.id))tx.objectStore('books').delete(b.id);
      for(const b of snapshot.backups)if(!retainedBackups.has(b.id))tx.objectStore('backups').delete(b.id);
      for(const id of snapshot.removedAssets)tx.objectStore('assets').delete(id);
    }catch(error){failure=error;tx.abort();}
  };
  try{await done;}catch(error){throw failure||error;}
  for(const id of notebookId===null?[...assets.keys()]:snapshot.removedAssets){const a=assets.get(id);if(a)URL.revokeObjectURL(a.url);assets.delete(id);releaseShapeCache(id);}
  if(ids===null||ids.has(book.id))blankCurrentNotebook();
  resetHistory();
  if(notebookId===null&&downloadURL){URL.revokeObjectURL(downloadURL);downloadURL=null;$('#backupDownload').removeAttribute('href');}
}
function dangerDialog(title,message,action,clear=false) {
  $('#dangerTitle').textContent=title;$('#dangerMessage').textContent=message;$('#dangerWord').value='';$('#dangerConfirm').disabled=true;
  $('#dangerConfirm').onclick=()=>{
    if($('#dangerWord').value!=='DELETE')return;
    void studioAction(async()=>{await action();$('#dangerDialog').close();librarySelected.clear();await openLibrary();toast(clear?'Local notebook data cleared.':'Permanently deleted.');});
  };$('#dangerDialog').showModal();
}
function confirmDeletion(b) {
  dangerDialog('Delete permanently',`“${b.title}” and its unused images will be removed from this browser. This cannot be undone.`,()=>removeLocalData(b.id));
}
function confirmClearData() {
  dangerDialog('Clear local data','Remove every notebook, image and history backup at this address in this browser. Downloaded backup files and other devices are not affected.',async()=>{
    await removeLocalData();
  },true);
}
function editLibraryDetails(b) {
  const modal=$('#detailsDialog'), content=$('#detailsFields'); content.replaceChildren();
  const title=labeledInput(content,'Title',b.title,()=>{}), category=labeledInput(content,'Collection',b.category||'',()=>{}); title.maxLength=80; category.maxLength=80;
  $('#detailsSave').onclick=()=>void studioAction(async()=>{b.title=title.value.trim()||'Untitled';b.category=category.value.trim();b.updatedAt=Date.now();await writeBooks([b]);if(book.id===b.id) {book.title=b.title;book.category=b.category;resetHistory();render();} modal.close();await openLibrary();}); modal.showModal();
}
function blobData(blob) { return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);}); }
let downloadURL=null;
function download(blob,name) {
  if(downloadURL)URL.revokeObjectURL(downloadURL);downloadURL=URL.createObjectURL(blob);
  const a=$('#backupDownload');a.href=downloadURL;a.download=name;$('#backupName').textContent=name;$('#exportDialog').showModal();
}
async function exportNotebooks(notebooks) {
  if(!notebooks.length)throw new Error('There are no notebooks to export.');
  await persistBook(); const ids=new Set(); notebooks.forEach(b=>Studio.resources(b,ids)); const packed=[];
  for(const id of ids) {const asset=assets.get(id);if(!asset) throw new Error('An image is missing. Export stopped to avoid an incomplete backup.');packed.push({id,name:asset.name,width:asset.width,height:asset.height,data:await blobData(asset.blob)});}
  const payload={format:'flip-journal',version:1,createdAt:new Date().toISOString(),books:notebooks,assets:packed};
  download(new Blob([JSON.stringify(payload)],{type:'application/json'}),`${notebooks.length===1?notebooks[0].title.replace(/[\\/:*?"<>|]/g,'_'):'My library'}.flipbook`);
}
async function importNotebooks(file) {
  if(file.size>250*1024*1024) throw new Error('Please import a backup smaller than 250 MB.');
  const data=JSON.parse(await file.text());
  if(data.format!=='flip-journal'||data.version!==1||!Array.isArray(data.books)||!data.books.length||data.books.length>200||!Array.isArray(data.assets)) throw new Error('Choose a .flipbook backup.');
  data.books.forEach(b=>{Studio.validateBook(b);if(!M.linksValid(b)) throw new Error('This notebook has invalid spread links.');});
  const remap=new Map(), incoming=[];
  for(const a of data.assets) {
    if(typeof a.id!=='string'||remap.has(a.id)||typeof a.data!=='string'||!/^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,/.test(a.data)) throw new Error('Invalid image in backup.');
    const bytes=Uint8Array.from(atob(a.data.slice(a.data.indexOf(',')+1)),c=>c.charCodeAt(0)), blob=new Blob([bytes],{type:a.data.slice(5,a.data.indexOf(';'))});
    const url=URL.createObjectURL(blob);
    try {const image=await decode(url); const id=M.id();remap.set(a.id,id);incoming.push({id,blob,name:typeof a.name==='string'?a.name:'Image',width:image.naturalWidth,height:image.naturalHeight});} finally {URL.revokeObjectURL(url);}
  }
  for(const b of data.books) {
    for(const id of Studio.resources(b)) if(!remap.has(id)) throw new Error('Backup is missing an image. Nothing was imported.');
    Studio.remap(b,remap);b.id=M.id();delete b.deletedAt;b.updatedAt=Date.now();
  }
  const tx=db.transaction(['books','assets'],'readwrite'), done=txDone(tx);
  for(const asset of incoming) tx.objectStore('assets').put(asset); for(const b of data.books) tx.objectStore('books').put(b); await done;
  for(const asset of incoming) assets.set(asset.id,{...asset,url:URL.createObjectURL(asset.blob)});
  libraryFilter='all';await openLibrary();toast('Imported as new notebooks.');
}
function addText() {
  const loc=selected();if(!loc||isReadOnlySurface(loc.surface))return;
  const s={id:M.id(),kind:'text',text:'A little note…',font:'futura',fontSize:5,height:30,width:65,x:50,y:50,rotation:0,zIndex:Math.max(0,...stickerRefs().map(r=>r.sticker.zIndex))+1,color:'#262625',weight:400,lineHeight:1.5,letterSpacing:0,align:'left'};
  if(loc.sheet?.shape){const layout=shapeLayout(loc.sheet.shape,loc.side);s.x=layout.left+layout.width/2;s.y=layout.top+layout.height/2;s.width=Math.min(s.width,layout.width*.8);s.height=Math.min(s.height,layout.height*.8);}
  loc.surface.stickers.push(s);selectedStickerId=s.id;selectedObjects.clear();save();render();
}
function objectBounds(ref) { const a=assets.get(ref.sticker.resource);return Studio.bounds(ref.sticker,ref.offset,SIZES[book.sizePreset],a?a.width/a.height:1); }
function alignObjects(action) {
  const refs=activeObjectRefs();if(!refs.length || refs.some(objectLocked))return;
  const units=[];for(const ref of refs){if(ref.sticker.groupId && units.some(u=>u[0].sticker.groupId===ref.sticker.groupId))continue;units.push(ref.sticker.groupId?refs.filter(r=>r.sticker.groupId===ref.sticker.groupId):[ref]);}
  const boxes=units.map(unit=>{const b=unit.map(objectBounds),left=Math.min(...b.map(v=>v.x-v.halfX)),right=Math.max(...b.map(v=>v.x+v.halfX)),top=Math.min(...b.map(v=>v.y-v.halfY)),bottom=Math.max(...b.map(v=>v.y+v.halfY));return {x:(left+right)/2,y:(top+bottom)/2,halfX:(right-left)/2,halfY:(bottom-top)/2};});
  let area;
  if(alignTarget==='spread'&&!currentView().closed) area={left:0,right:200,top:0,bottom:100};
  else if(alignTarget==='page'||refs.length===1||currentView().closed) { const where=M.locate(book,selectedId), offset=where?.cover==='back'||where?.side==='back'||where?.inside==='front'?0:100;area={left:offset,right:offset+100,top:0,bottom:100}; }
  const output=Studio.align(boxes,action,area);
  units.forEach((unit,i)=>{unit.forEach(ref=>{ref.sticker.x+=output[i].x-boxes[i].x;ref.sticker.y+=output[i].y-boxes[i].y;});if(unit[0].sticker.groupId)normalizeGroup(unit);else normalizeSticker(unit[0]);});save();render();
}
function renderStudioTools() {
  const root=$('#toolBody'), loc=selected();if(!loc||isReadOnlySurface(loc.surface))return;
  const visible=new Set(stickerRefs().map(r=>r.sticker.id));for(const id of selectedObjects)if(!visible.has(id))selectedObjects.delete(id);
  const add=section('Objects'); add.append(button('+ Text',addText));
  add.append(button(multiple?'Done selecting':'Select multiple',()=>{multiple=!multiple;selectedObjects.clear();if(multiple&&selectedStickerId)selectedObjects.add(selectedStickerId);render();})); root.append(add);
  const ref=selectedSticker(), s=ref?.sticker;
  const refs=activeObjectRefs(), locked=refs.some(objectLocked);
  if(refs.length){
    const panel=section(s?.groupId?'Group':'Selection');
    panel.append(button(refs.every(r=>r.sticker.locked)?'Unlock':'Lock',toggleObjectLock));
    if(!locked){
      if(multiple && refs.length>1)panel.append(button('Group',groupObjects));
      if(refs.some(r=>r.sticker.groupId))panel.append(button('Ungroup',ungroupObjects));
      if(multiple || s?.groupId)buttons(panel,button('Duplicate',duplicateObjects),button('Delete',deleteObjects,'danger'));
    }
    root.append(panel);
  }
  if(s?.kind==='text' && !objectLocked(ref) && !s.groupId) {
    const panel=section('Text'), field=node('textarea');field.value=s.text;field.maxLength=20000;field.rows=4;field.setAttribute('aria-label','Text');
    field.addEventListener('input',()=>{s.text=field.value;save(field);renderBook();});field.addEventListener('blur',()=>historyKey=null);panel.append(field);
    const pair=Studio.fontPair(s);
    selectControl(panel,'Western font',Object.entries(Studio.latinLabels),pair.latin,value=>{s.fontLatin=value;save();renderBook();});
    selectControl(panel,'Chinese font',Object.entries(Studio.chineseLabels),pair.chinese,value=>{s.fontChinese=value;save();renderBook();});
    palette(panel,s.color,v=>{s.color=color(v);save();renderBook();});panel.append(button('Pick from image',()=>openColorPicker(v=>{s.color=v;save();render();})));
    range(panel,'Type size',s.fontSize*10,10,160,v=>s.fontSize=v/10);
    range(panel,'Box height',s.height,5,100,v=>{s.height=v;normalizeSticker(ref);},'%');
    range(panel,'Line spacing',s.lineHeight*100,80,250,v=>s.lineHeight=v/100,'%');
    range(panel,'Letter spacing',s.letterSpacing*100,-10,40,v=>s.letterSpacing=v/100,'%');
    selectControl(panel,'Weight',[['400','Regular'],['700','Bold']],String(s.weight),v=>{s.weight=Number(v);save();renderBook();});
    selectControl(panel,'Text align',[['left','Left'],['center','Center'],['right','Right']],s.align,v=>{s.align=v;save();renderBook();});root.append(panel);
  }
  const image=M.getSpread(book,position)?.image||loc.surface.image;
  const imageTools=section('Image & colour');
  imageTools.append(button('Pick paper colour',()=>openColorPicker(v=>{loc.surface.background=v;save();render();})));
  if(s && s.kind!=='text' && !objectLocked(ref) && !s.groupId) imageTools.append(button('Crop selected image',()=>openCrop(s,null)));
  if(image) imageTools.append(button('Crop page image',()=>openCrop(image,loc.sheet?.shape?.resource===image.resource?loc.sheet:null)));
  root.append(imageTools);
  if((s||multiple) && !locked) {
    const panel=section(multiple?`Align · ${selectedObjects.size} selected`:'Align');
    selectControl(panel,'Relative to',[['page','Page'],['spread','Spread'],['selection','Selection']],alignTarget,v=>alignTarget=v);
    const grid=node('div','alignment-grid');for(const [action,label] of [['left','Left'],['centerX','Centre ↔'],['right','Right'],['top','Top'],['centerY','Centre ↕'],['bottom','Bottom'],['spaceX','Space ↔'],['spaceY','Space ↕']]) {
      const b=button(label,()=>alignObjects(action));b.disabled=action.startsWith('space')&&(!multiple||selectedObjects.size<3);grid.append(b);
    }panel.append(grid);
    root.append(panel);
  }
}
let cropState=null, pickerState=null;
async function openCrop(target, sheet, pending=false) {
  const notebookId=book.id;
  try {
    const original=target.originalResource||target.resource;
    const url=pending?URL.createObjectURL(pendingImport.originalFile||pendingImport.file):assetURL(original), image=await decode(url);
    if(pending) URL.revokeObjectURL(url);
    if(book.id!==notebookId)return;
    cropState={target,sheet,pending,image,original,rect:{...(pending?pendingImport.crop:target.crop)||{x:0,y:0,w:1,h:1}}};
    const canvas=$('#cropCanvas'), scale=Math.min(1,1200/image.naturalWidth,1200/image.naturalHeight);canvas.width=Math.round(image.naturalWidth*scale);canvas.height=Math.round(image.naturalHeight*scale);
    $('#cropRatio').value='free';$('#cropMove').checked=false;paintCrop();$('#cropDialog').showModal();
  } catch(error) {toast('This image could not be opened.');}
}
function paintCrop() {
  const {image,rect:r}=cropState, canvas=$('#cropCanvas'), ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  ctx.fillStyle='#19191999';ctx.beginPath();ctx.rect(0,0,canvas.width,canvas.height);ctx.rect(r.x*canvas.width,r.y*canvas.height,r.w*canvas.width,r.h*canvas.height);ctx.fill('evenodd');ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.strokeRect(r.x*canvas.width,r.y*canvas.height,r.w*canvas.width,r.h*canvas.height);
  $('#cropZoom').value=Math.round(r.w*100); $('#cropSize').textContent=`${Math.round(r.w*image.naturalWidth)} × ${Math.round(r.h*image.naturalHeight)}`;
}
function cropRatioRect() {
  const value=$('#cropRatio').value;if(value==='free')return;
  const desired=value==='page'?SIZES[book.sizePreset]:Number(value), natural=cropState.image.naturalWidth/cropState.image.naturalHeight;
  const r=cropState.rect;r.w=Math.min(r.w,desired/natural);r.h=r.w*natural/desired;r.x=clamp(r.x,0,1-r.w);r.y=clamp(r.y,0,1-r.h);
}
async function applyCrop() {
  if(!cropState)return;$('#cropApply').disabled=true;
  const previousBusy=busy;busy=true;lockUI();
  try {
    const c=cropState,r=c.rect,img=c.image,canvas=node('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*r.w));canvas.height=Math.max(1,Math.round(img.naturalHeight*r.h));
    canvas.getContext('2d').drawImage(img,r.x*img.naturalWidth,r.y*img.naturalHeight,r.w*img.naturalWidth,r.h*img.naturalHeight,0,0,canvas.width,canvas.height);
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Crop failed.')),'image/png'));
    if(c.pending) {pendingImport.originalFile ||= pendingImport.file;pendingImport.crop={...r};pendingImport.file=new File([blob],'Cropped image.png',{type:'image/png'});$('#importFileName').textContent='Cropped image';}
    else {
      const resource=await storeAsset(new File([blob],'Cropped image.png',{type:'image/png'}));
      if(c.sheet) await prepareShape(resource);
      c.target.originalResource=c.original;c.target.resource=resource;c.target.crop={...r};
      if(c.sheet)c.sheet.shape.resource=resource;
      const ref=selectedSticker();if(ref?.sticker===c.target)normalizeSticker(ref);save();render();
    }
    $('#cropDialog').close();cropState=null;
  } catch(error) {toast(error.message||'Could not crop this image.');} finally {$('#cropApply').disabled=false;busy=previousBusy;lockUI();render();}
}
async function openColorPicker(apply) {
  const ids=[...Studio.resources(book)].filter(id=>assets.has(id));if(!ids.length){toast('Add an image first.');return;}
  const list=$('#pickerImages');list.replaceChildren();pickerState={apply,color:null};$('#pickerApply').disabled=true;
  for(const id of ids) {const b=button('',()=>void showPickerImage(id));const img=node('img');img.src=assetURL(id);img.alt=assets.get(id).name||'Image';b.append(img);list.append(b);}
  $('#pickerDialog').showModal();await showPickerImage(ids[0]);
}
let pickerRequest=0;
async function showPickerImage(id) {
  const current=++pickerRequest;try {const image=await decode(assetURL(id));if(current!==pickerRequest)return;const canvas=$('#pickerCanvas'),scale=Math.min(1,1200/image.naturalWidth,1200/image.naturalHeight);canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));const ctx=canvas.getContext('2d');ctx.fillStyle=color(selected()?.surface.background||book.paperColor);ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);}catch{toast('Image unavailable.');}
}
function setEditorPanel(panel) {
  for(const name of ['pages','tools']){const open=panel===name;document.body.classList.toggle(`show-${name}`,open);$('#'+name+'Toggle').setAttribute('aria-expanded',String(open));}
  $('#panelBackdrop').hidden=!panel;closeSelect();
}
function installStudio() {
  if(studioInstalled)return;studioInstalled=true;
  document.addEventListener('pointerdown',e=>{if(activeSelect&&!activeSelect.control.contains(e.target))closeSelect();});
  document.addEventListener('keydown',e=>{if(activeSelect&&e.key==='Escape'){e.preventDefault();e.stopPropagation();closeSelect(true);}},true);
  const oldTools=renderTools;renderTools=()=>{oldTools();renderStudioTools();};
  const oldHits=addStickerHits;addStickerHits=(root,at)=>{oldHits(root,at);if(multiple)root.querySelectorAll('.sticker-hit').forEach(el=>el.classList.toggle('selected',selectedObjects.has(el.dataset.stickerId)));};
  const oldDrag=startStickerDrag;startStickerDrag=(e,ref)=>{if(busy)return;if(multiple){e.preventDefault();e.stopPropagation();const id=ref.sticker.id,remove=selectedObjects.has(id);for(const member of groupMembers(ref)){if(remove)selectedObjects.delete(member.sticker.id);else selectedObjects.add(member.sticker.id);}selectedStickerId=id;if(ref.surface)selectedId=ref.surface.id;render();}else{selectedObjects.clear();oldDrag(e,ref);}};
  const oldSettings=openSettings;openSettings=()=>{oldSettings();const portrait=!['square','landscape'].includes(book.sizePreset)?book.sizePreset:'A5';options('#sizeOptions',[[portrait,'Portrait'],['square','Square'],['landscape','Landscape']],book.sizePreset);options('#bindingOptions',[['bound','Bound'],['coil','Coil'],['binder','Ring binder']],book.binding);$('#categoryInput').value=book.category||'';};
  $('#libraryBtn').onclick=()=>void studioAction(openLibrary);
  $('#librarySelect').onclick=()=>void studioAction(async()=>{librarySelecting=!librarySelecting;librarySelected.clear();await openLibrary();});
  $('#batchAll').onclick=()=>{librarySelected=new Set(librarySelected.size===libraryVisible.length?[]:libraryVisible);updateLibrarySelection();};
  $('#batchRestore').onclick=()=>void studioAction(()=>changeLibrarySelection(true));
  $('#batchDelete').onclick=()=>{if(libraryFilter==='trash')confirmSelectedDeletion();else void studioAction(()=>changeLibrarySelection());};
  $('#batchExport').onclick=()=>void studioAction(async()=>{await persistBook();await exportNotebooks((await allBooks()).filter(b=>librarySelected.has(b.id)));});
  $('#libraryClose').onclick=()=>{if(book.deletedAt)blankCurrentNotebook();$('#libraryDialog').close();render();};
  $('#libraryDialog').addEventListener('cancel',()=>{if(book.deletedAt){blankCurrentNotebook();render();}});
  $('#newBook').onclick=()=>void studioAction(async()=>{const fresh=M.createBook();fresh.title='Untitled';fresh.uiTheme=book.uiTheme;await writeBooks([fresh]);await loadNotebook(fresh,true);});
  $('#exportLibrary').onclick=()=>void studioAction(async()=>{await persistBook();await exportNotebooks((await allBooks()).filter(b=>!b.deletedAt));});
  $('#importBackup').onclick=()=>{$('#backupInput').value='';$('#backupInput').click();};
  $('#backupInput').onchange=e=>{if(e.target.files[0])void studioAction(()=>importNotebooks(e.target.files[0]));};
  $('#detailsClose').onclick=()=>$('#detailsDialog').close();
  $('#exportClose').onclick=()=>$('#exportDialog').close();
  $('#clearLocalData').onclick=confirmClearData;$('#dangerCancel').onclick=()=>$('#dangerDialog').close();
  $('#dangerWord').oninput=e=>$('#dangerConfirm').disabled=e.target.value!=='DELETE';
  $('#cropDialog').addEventListener('close',()=>{cropState=null;$('#cropCanvas').width=1;$('#cropCanvas').height=1;$('#cropCanvas').onpointermove=null;});
  $('#pickerDialog').addEventListener('close',()=>{pickerRequest++;pickerState=null;$('#pickerCanvas').width=1;$('#pickerCanvas').height=1;});
  for(const name of ['pages','tools'])$('#'+name+'Toggle').onclick=()=>setEditorPanel(document.body.classList.contains('show-'+name)?null:name);
  $('#pagesClose').onclick=$('#toolsClose').onclick=$('#panelBackdrop').onclick=()=>setEditorPanel(null);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('dialog[open]'))setEditorPanel(null);});
  const oldSelectSurface=selectSurface;selectSurface=id=>{oldSelectSurface(id);if(!busy)setEditorPanel(null);};
  const updateViewport=()=>{const v=globalThis.visualViewport;document.documentElement.style.setProperty?.('--visible-height',`${v?.height||globalThis.innerHeight||800}px`);document.documentElement.style.setProperty?.('--visible-top',`${v?.offsetTop||0}px`);};
  globalThis.visualViewport?.addEventListener('resize',updateViewport);globalThis.visualViewport?.addEventListener('scroll',updateViewport);globalThis.addEventListener?.('resize',updateViewport);updateViewport();
  $('#cropUpload').onclick=()=>{if(pendingImport)void openCrop({},null,true);};
  $('#cropClose').onclick=()=>$('#cropDialog').close();$('#cropApply').onclick=()=>void applyCrop();
  $('#cropReset').onclick=()=>{cropState.rect={x:0,y:0,w:1,h:1};$('#cropRatio').value='free';paintCrop();};
  $('#cropRatio').onchange=()=>{cropRatioRect();paintCrop();};
  $('#cropZoom').oninput=e=>{const r=cropState.rect,ratio=r.h/r.w,w=Number(e.target.value)/100;r.w=Math.min(w,1/ratio);r.h=r.w*ratio;r.x=clamp(r.x,0,1-r.w);r.y=clamp(r.y,0,1-r.h);paintCrop();};
  $('#cropCanvas').onpointerdown=e=>{
    if(!cropState)return;e.preventDefault();const canvas=e.currentTarget,b=canvas.getBoundingClientRect(),start={x:clamp((e.clientX-b.left)/b.width,0,1),y:clamp((e.clientY-b.top)/b.height,0,1)},old={...cropState.rect};
    const moving=$('#cropMove').checked;canvas.setPointerCapture(e.pointerId);
    canvas.onpointermove=ev=>{const x=clamp((ev.clientX-b.left)/b.width,0,1),y=clamp((ev.clientY-b.top)/b.height,0,1);cropState.rect=moving?{...old,x:clamp(old.x+x-start.x,0,1-old.w),y:clamp(old.y+y-start.y,0,1-old.h)}:{x:Math.min(x,start.x),y:Math.min(y,start.y),w:Math.max(.01,Math.abs(x-start.x)),h:Math.max(.01,Math.abs(y-start.y))};cropRatioRect();const r=cropState.rect;r.x=clamp(r.x,0,1-r.w);r.y=clamp(r.y,0,1-r.h);paintCrop();};
    canvas.onpointerup=canvas.onpointercancel=()=>{canvas.onpointermove=null;};
  };
  $('#pickerClose').onclick=()=>$('#pickerDialog').close();
  $('#pickerCanvas').onclick=e=>{const canvas=e.currentTarget,r=canvas.getBoundingClientRect(),x=clamp(Math.floor((e.clientX-r.left)/r.width*canvas.width),0,canvas.width-1),y=clamp(Math.floor((e.clientY-r.top)/r.height*canvas.height),0,canvas.height-1);const px=canvas.getContext('2d').getImageData(x,y,1,1).data;pickerState.color='#'+[...px].slice(0,3).map(n=>n.toString(16).padStart(2,'0')).join('');$('#pickedColor').style.background=pickerState.color;$('#pickedHex').textContent=pickerState.color;$('#pickerApply').disabled=false;};
  $('#pickerApply').onclick=()=>{if(pickerState.color){pickerState.apply(pickerState.color);$('#pickerDialog').close();}};
}
