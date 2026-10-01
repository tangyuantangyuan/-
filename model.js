/* Pure data model. No DOM or storage: usable directly in the browser and Node tests. */
(function (root) {
  'use strict';
  const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const clone = value => structuredClone(value);
  const surface = (background = null) => ({ id: id(), background, image: null, stickers: [] });
  const sheet = () => ({ id: id(), shape: null, front: surface(), back: surface() });
  function createBook() {
    return { schemaVersion: 2, id: id(), title: 'My journal', sizePreset: 'A5', paperColor: 'cream', binding: 'bound', uiTheme: 'light',
      covers: { front: surface('silver'), back: surface('silver') }, insides: { front: surface(), back: surface() },
      sheets: [sheet(), sheet()], spreads: [], updatedAt: Date.now() };
  }
  function view(book, position) {
    if (position < 0) return { closed: 'front', left: null, right: book.covers.front };
    if (position > book.sheets.length) return { closed: 'back', left: book.covers.back, right: null };
    return { closed: null, left: position ? book.sheets[position - 1].back : book.insides.front,
      right: position < book.sheets.length ? book.sheets[position].front : book.insides.back };
  }
  function locate(book, surfaceId) {
    for (const side of ['front', 'back']) {
      if (book.covers[side].id === surfaceId) return { surface: book.covers[side], cover: side, position: side === 'front' ? -1 : book.sheets.length + 1 };
      if (book.insides[side].id === surfaceId) return { surface: book.insides[side], inside: side, position: side === 'front' ? 0 : book.sheets.length };
    }
    for (let i = 0; i < book.sheets.length; i++) for (const side of ['front', 'back']) {
      if (book.sheets[i][side].id === surfaceId) return { surface: book.sheets[i][side], sheet: book.sheets[i], index: i, side, position: i + (side === 'back' ? 1 : 0) };
    }
    return null;
  }
  function getSpread(book, position, create = false) {
    const v = view(book, position); if (v.closed) return null;
    let data = book.spreads.find(s => s.leftId === v.left.id && s.rightId === v.right.id);
    if (!data && create) { data = { id: id(), leftId: v.left.id, rightId: v.right.id, image: null, stickers: [] }; book.spreads.push(data); }
    return data || null;
  }
  const hasContent = s => Boolean(s.image || s.stickers.length);
  function linksValid(book) {
    return book.spreads.every(s => !hasContent(s) || Array.from({ length: book.sheets.length + 1 }, (_, p) => view(book, p))
      .some(v => v.left.id === s.leftId && v.right.id === s.rightId));
  }
  function blocks(book) {
    const result = [];
    for (let i = 0; i < book.sheets.length; i++) {
      const prev = i && getSpread(book, i);
      if (prev && hasContent(prev)) result[result.length - 1].push(book.sheets[i]);
      else result.push([book.sheets[i]]);
    }
    return result;
  }
  function blockFor(book, sheetId) { return blocks(book).find(b => b.some(s => s.id === sheetId)) || []; }
  function move(book, sheetId, direction) {
    const groups = blocks(book), index = groups.findIndex(b => b.some(s => s.id === sheetId)), target = index + direction;
    if (index < 0 || target < 0 || target >= groups.length) return false;
    [groups[index], groups[target]] = [groups[target], groups[index]];
    const candidate = { ...book, sheets: groups.flat() };
    if (!linksValid(candidate)) return false;
    book.sheets = candidate.sheets; return true;
  }
  function add(book) {
    const fresh = sheet();
    // The back inside cover can have spread artwork. Keep its existing neighbour.
    const end = getSpread(book, book.sheets.length);
    const insertAt = end && hasContent(end) ? Math.max(0, book.sheets.length - blockFor(book, book.sheets.at(-1)?.id).length) : book.sheets.length;
    const candidate = { ...book, sheets: [...book.sheets] }; candidate.sheets.splice(insertAt, 0, fresh);
    if (!linksValid(candidate)) return null;
    book.sheets = candidate.sheets; return fresh;
  }
  function remove(book, sheetId) {
    const group = blockFor(book, sheetId), removed = new Set(group.flatMap(s => [s.front.id, s.back.id]));
    book.sheets = book.sheets.filter(s => !group.includes(s));
    book.spreads = book.spreads.filter(s => !removed.has(s.leftId) && !removed.has(s.rightId));
    return group.length;
  }
  function duplicate(book, sheetId) {
    const group = blockFor(book, sheetId); if (!group.length) return null;
    const map = new Map(), groups = new Map();
    const freshObject = s => {s.id=id();if(s.groupId){if(!groups.has(s.groupId))groups.set(s.groupId,id());s.groupId=groups.get(s.groupId);}return s;};
    const copies = group.map(original => {
      const copy = clone(original); copy.id = id();
      for (const side of ['front', 'back']) { copy[side].id = id(); map.set(original[side].id, copy[side].id); copy[side].stickers.forEach(freshObject); }
      return copy;
    });
    const copiedSpreads = [];
    for (const spread of book.spreads) {
      if (map.has(spread.leftId) && map.has(spread.rightId)) {
        const copy = clone(spread); copy.id = id(); copy.leftId = map.get(spread.leftId); copy.rightId = map.get(spread.rightId); copy.stickers.forEach(freshObject); copiedSpreads.push(copy);
      } else {
        // A boundary spread touching an inside cover is copied as a page-local
        // crop of the same original, so no visible content is lost on duplication.
        for (const [key, offset] of [['leftId', 0], ['rightId', 100]]) if (map.has(spread[key])) {
          const target = copies.flatMap(s => [s.front, s.back]).find(p => p.id === map.get(spread[key]));
          target.stickers.push(...spread.stickers.map(s => freshObject({ ...clone(s), x: s.x - offset })));
          if (spread.image) target.image = { ...clone(spread.image), sourceHalf: offset / 100 };
        }
      }
    }
    const at = book.sheets.indexOf(group.at(-1)) + 1;
    const candidate = { ...book, sheets: [...book.sheets] }; candidate.sheets.splice(at, 0, ...copies);
    if (!linksValid(candidate)) return null;
    book.sheets = candidate.sheets; book.spreads.push(...copiedSpreads); return copies[0];
  }
  function migrate(old) {
    if (old.schemaVersion === 2) return { book: old, changed: false };
    const book = createBook(); Object.assign(book, { id: old.id || book.id, title: old.title || book.title, sizePreset: old.sizePreset || 'A5', paperColor: old.paperColor || 'cream' });
    book.covers.front.image = old.cover ? { resource: old.cover, mode: 'single-cover', positionX: 50, positionY: 50 } : null;
    book.covers.back.background = old.backCover || 'cream';
    const pages = [], groups = new Map();
    for (const raw of old.pages || []) {
      const shaped = !raw.spreadGroupId && raw.pageImage?.mode === 'alpha-shaped';
      // A legacy shaped face must not cut the unrelated next/previous image
      // into its silhouette. Give it a blank physical reverse during migration.
      if (shaped && pages.length % 2) pages.push(surface());
      // A facing spread must begin on a verso (odd surface index).
      if (raw.spreadGroupId && !groups.has(raw.spreadGroupId) && pages.length % 2 === 0) pages.push(surface());
      const p = { ...surface(), id: raw.id || id(), background: raw.background || null, image: raw.spreadGroupId ? null : clone(raw.pageImage || null), stickers: clone(raw.stickers || []) };
      pages.push(p);
      if (shaped) pages.push(surface());
      if (raw.spreadGroupId) {
        const group = groups.get(raw.spreadGroupId);
        if (group) group.rightId = p.id;
        else groups.set(raw.spreadGroupId, { id: id(), leftId: p.id, rightId: null, image: clone(raw.pageImage), stickers: [] });
      }
    }
    if (pages.length % 2) pages.push(surface());
    book.sheets = [];
    for (let i = 0; i < pages.length; i += 2) {
      const s = { id: id(), shape: null, front: pages[i], back: pages[i + 1] };
      for (const side of ['front', 'back']) if (s[side].image?.mode === 'alpha-shaped' && !s.shape) s.shape = { resource: s[side].image.resource, scale: 100, sourceSide: side };
      book.sheets.push(s);
    }
    book.spreads = [...groups.values()].filter(s => s.rightId);
    return { book, changed: true };
  }
  const api = { id, clone, surface, sheet, createBook, view, locate, getSpread, linksValid, blocks, blockFor, add, remove, duplicate, move, migrate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JournalModel = api;
})(globalThis);
