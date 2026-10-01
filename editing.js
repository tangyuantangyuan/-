'use strict';
// Session-only history stores metadata, never copies image Blobs.
let undoStack = [], redoStack = [], historyCurrent = null, historyKey = null;
function historySnapshot() {
  const value = M.clone(book); delete value.updatedAt;
  return {data:JSON.stringify(value),position,selectedId};
}
function updateHistoryButtons() {
  $('#undoBtn').disabled = busy || !undoStack.length;
  $('#redoBtn').disabled = busy || !redoStack.length;
}
function resetHistory() {
  undoStack=[];redoStack=[];historyKey=null;historyCurrent=historySnapshot();updateHistoryButtons();
}
function recordHistory(key=null) {
  const next=historySnapshot();
  if(!historyCurrent || JSON.parse(historyCurrent.data).id!==book.id){resetHistory();return;}
  if(next.data!==historyCurrent.data){
    if(!key || key!==historyKey)undoStack.push({...historyCurrent,position,selectedId});
    redoStack=[];historyCurrent=next;historyKey=key;
    let bytes=undoStack.reduce((n,s)=>n+s.data.length*2,0);
    while(undoStack.length>50 || (bytes>8*1024*1024 && undoStack.length))bytes-=undoStack.shift().data.length*2;
  }
  updateHistoryButtons();
}
async function restoreHistory(direction) {
  if(busy || !editing || $('dialog[open]'))return;
  const from=direction==='undo'?undoStack:redoStack, to=direction==='undo'?redoStack:undoStack;
  if(!from.length)return;
  busy=true;lockUI();closeSelect();
  try {
    await persistBook();
    const entry=from.at(-1), restored=JSON.parse(entry.data);
    for(const sheet of restored.sheets)if(sheet.shape && assetURL(sheet.shape.resource))await prepareShape(sheet.shape.resource);
    to.push(historySnapshot());from.pop();book=restored;
    position=clamp(entry.position,-1,book.sheets.length+1);selectedId=entry.selectedId;
    if(!M.locate(book,selectedId))defaultSelection();
    selectedStickerId=null;selectedObjects.clear();multiple=false;
    historyCurrent=historySnapshot();historyKey=null;save();
  } catch(error){toast(error.message || 'Could not restore this edit.');}
  finally {busy=false;lockUI();render();}
}
function groupMembers(ref, refs=stickerRefs()) {
  return ref?.sticker.groupId ? refs.filter(r=>r.sticker.groupId===ref.sticker.groupId) : ref?[ref]:[];
}
function activeObjectRefs() {
  const refs=stickerRefs(), picked=multiple?refs.filter(r=>selectedObjects.has(r.sticker.id)):refs.filter(r=>r.sticker.id===selectedStickerId);
  const ids=new Set(picked.flatMap(r=>groupMembers(r,refs).map(x=>x.sticker.id)));
  return refs.filter(r=>ids.has(r.sticker.id));
}
function objectLocked(ref) { return groupMembers(ref).some(r=>r.sticker.locked); }
// Keep group members on the same surface/spread so page turns cannot split a group.
function normalizeGroup(refs) {
  if(!refs.length || currentView().closed)return;
  const boxes=refs.map(objectBounds);
  const side=boxes.every(b=>b.x+b.halfX<=100)?'left':boxes.every(b=>b.x-b.halfX>=100)?'right':null;
  const surface=side?currentView()[side]:null, spread=surface?null:M.getSpread(book,position,true);
  const collection=surface?surface.stickers:spread.stickers, offset=side==='right'?100:0;
  for(const ref of refs){const x=ref.sticker.x+ref.offset;if(ref.collection!==collection){ref.collection.splice(ref.collection.indexOf(ref.sticker),1);collection.push(ref.sticker);}ref.sticker.x=x-offset;Object.assign(ref,{collection,surface,spread,offset,side});}
  if(surface)selectedId=surface.id;
}
function groupObjects() {
  const refs=activeObjectRefs();if(refs.length<2 || refs.some(objectLocked))return;
  const id=M.id();refs.forEach(r=>r.sticker.groupId=id);normalizeGroup(refs);
  multiple=false;selectedObjects.clear();selectedStickerId=refs[0].sticker.id;save();render();
}
function ungroupObjects() {
  const refs=activeObjectRefs();if(refs.some(objectLocked))return;
  refs.forEach(r=>delete r.sticker.groupId);refs.forEach(normalizeSticker);save();render();
}
function toggleObjectLock() {
  const refs=activeObjectRefs();if(!refs.length)return;
  const locked=!refs.every(r=>r.sticker.locked);refs.forEach(r=>r.sticker.locked=locked);save();render();
}
function deleteObjects() {
  const refs=activeObjectRefs();if(!refs.length || refs.some(objectLocked))return;
  refs.forEach(r=>r.collection.splice(r.collection.indexOf(r.sticker),1));
  selectedObjects.clear();selectedStickerId=null;save();render();
}
function duplicateObjects() {
  const refs=activeObjectRefs();if(!refs.length || refs.some(objectLocked))return;
  const groups=new Map(), copies=[], top=Math.max(0,...stickerRefs().map(r=>r.sticker.zIndex));
  refs.forEach((ref,i)=>{
    const s={...M.clone(ref.sticker),id:M.id(),x:ref.sticker.x+3,y:ref.sticker.y+3,zIndex:top+i+1};
    if(s.groupId){if(!groups.has(s.groupId))groups.set(s.groupId,M.id());s.groupId=groups.get(s.groupId);}
    ref.collection.push(s);copies.push({...ref,sticker:s});
  });
  for(const ref of copies)if(!ref.sticker.groupId)normalizeSticker(ref);
  for(const id of groups.values())normalizeGroup(copies.filter(r=>r.sticker.groupId===id));
  selectedStickerId=copies[0].sticker.id;selectedObjects=new Set(copies.map(r=>r.sticker.id));save();render();
}
function installEditing() {
  $('#undoBtn').onclick=()=>void restoreHistory('undo');$('#redoBtn').onclick=()=>void restoreHistory('redo');
  document.addEventListener('keydown',e=>{
    if(busy || !editing || $('dialog[open]') || e.target?.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(e.target?.tagName))return;
    if((e.ctrlKey || e.metaKey) && !e.altKey){
      const key=e.key.toLowerCase();
      if(key==='z' || key==='y'){e.preventDefault();void restoreHistory(key==='y'||e.shiftKey?'redo':'undo');}
    }
  });
}
