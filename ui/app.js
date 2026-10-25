'use strict';

const $ = (sel) => document.querySelector(sel);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = {
  turntable: $('#turntable'), disc: $('#disc'), tonearm: $('#tonearm'), ringFill: $('#ringFill'),
  labelArt: $('#labelArt'), statusMain: $('#statusMain'), statusSub: $('#statusSub'),
  saveCard: $('#saveCard'), saveIcon: $('#saveIcon'), saveWhere: $('#saveWhere'), saveHow: $('#saveHow'),
  form: $('#searchForm'), input: $('#urlInput'), btnFetch: $('#btnFetch'),
  empty: $('#empty'), result: $('#result'), resultTitle: $('#resultTitle'), resultMeta: $('#resultMeta'),
  destText: $('#destText'), bucketWrap: $('#bucketWrap'), bucketBtn: $('#bucketBtn'), bucketIcon: $('#bucketIcon'),
  bucketLabel: $('#bucketLabel'), bucketMenu: $('#bucketMenu'),
  btnDownload: $('#btnDownload'), downloadLabel: $('#downloadLabel'), tracks: $('#tracks'), listNote: $('#listNote'),
  chip: $('#accountChip'), chipLabel: $('#accountLabel'), pop: $('#accountPop'),
  popOut: $('#popSignedOut'), popIn: $('#popSignedIn'), since: $('#accountSince'),
  btnSignIn: $('#btnSignIn'), browserPick: $('#browserPick'), toasts: $('#toasts'),
  scrim: $('#scrim'), sheet: $('#sheet'), destList: $('#destList'), sortGrid: $('#sortGrid'),
  sortNote: $('#sortNote'), buckets: $('#buckets'), carExtras: $('#carExtras'),
  fmtSeg: $('#fmtSeg'), qSeg: $('#qSeg'), fmtField: $('#fmtSeg').closest('.field'), fmtHint: $('#fmtHint'),
  optCar: $('#optCar'), optNumbers: $('#optNumbers'), optLevel: $('#optLevel'), optTidy: $('#optTidy'), optSkip: $('#optSkip'), optSync: $('#optSync'),
};

const HINTS = {
  mp3: 'Plays everywhere. Converted from YouTube audio.',
  m4a: 'Original AAC audio, no conversion. Most phones and newer cars play it.',
  opus: 'Original Opus audio, smallest files. Not for car stereos.',
};
const SORT_NOTES = {
  playlist: 'Each playlist gets its own folder. Single songs go straight into the main folder.',
  artist: 'One folder per artist, worked out from each song. Great for browsing in the car.',
  genre: 'Pick the genre before you download. YouTube doesn’t say, so you decide.',
  language: 'Sonora detects the language from each song, or you can pick one for the whole batch.',
  custom: 'Your own folders, like Road trip or Workout. Pick one before you download.',
  none: 'Every song goes into the main folder.',
};
const BUCKET_KEYS = { genre: 'genres', language: 'languages', custom: 'customs' };
const BUCKET_ICONS = { genre: '#i-tag', language: '#i-globe', custom: '#i-star' };
const RING = 2 * Math.PI * 144;

let api = null;
const state = {
  s: {}, account: null, drives: [],
  list: null, rows: new Map(), job: null,
  phase: 'idle', // idle | fetching | ready | downloading | done
  lastFetch: '',
  sync: null, // { drive, queue: [playlist links], added } while topping up a USB drive
};

/* ---------------- helpers ---------------- */

function fmtTime(s) {
  s = Math.round(s || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtLength(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(m, 1)} min`;
}
function fmtSpeed(b) {
  if (!b) return '';
  return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB/s` : `${Math.round(b / 1024)} KB/s`;
}
function fmtSize(b) {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
}
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setStatus(main, sub) {
  if (el.statusMain.textContent !== main) {
    el.statusMain.textContent = main;
    if (!reduceMotion) {
      el.statusMain.classList.remove('swap');
      void el.statusMain.offsetWidth;
      el.statusMain.classList.add('swap');
    }
  }
  // The sub line changes every tick while downloading, so it never animates
  if (el.statusSub.textContent !== (sub || '')) el.statusSub.textContent = sub || '';
}

function toast(msg, kind = 'info', ms = 4200) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  el.toasts.appendChild(t);
  while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
  setTimeout(() => {
    t.classList.add('leaving');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, ms);
}

function busy(btn, on) {
  btn.classList.toggle('busy', on);
  btn.disabled = on;
}

function closeAnimated(node, extra) {
  if (node.hidden || node.classList.contains('closing')) return;
  node.classList.add('closing');
  node.addEventListener('animationend', () => {
    node.hidden = true;
    node.classList.remove('closing');
    extra && extra();
  }, { once: true });
}

/* ---------------- turntable ---------------- */

const deck = { angle: 0, vel: 0, target: 0, progress: 0, running: false, last: 0 };
const SPEEDS = { idle: 0, ready: 0, fetching: 0.22, downloading: 0.56, done: 0 }; // turns per second

function setPhase(phase) {
  state.phase = phase;
  el.turntable.dataset.state = phase;
  deck.target = SPEEDS[phase] ?? 0;
  el.result.classList.toggle('running', phase === 'downloading');
  updateArm();
  if (deck.target && !deck.running && !reduceMotion) {
    deck.running = true;
    deck.last = performance.now();
    requestAnimationFrame(spin);
  }
}

function updateArm() {
  // Rest off the record; on it while downloading, creeping inward as the job advances
  const arm = state.phase === 'downloading' ? 9 + deck.progress * 18 : -10;
  el.tonearm.style.setProperty('--arm', `${arm}deg`);
}

function setProgress(p) {
  deck.progress = Math.max(0, Math.min(1, p));
  el.ringFill.style.strokeDashoffset = RING * (1 - deck.progress);
  el.ringFill.style.opacity = deck.progress > 0 ? 1 : 0;
  updateArm();
}

function spin(now) {
  const dt = Math.min(0.05, (now - deck.last) / 1000);
  deck.last = now;
  // Spin up eagerly, coast down slowly, like a platter with some mass
  const k = deck.target > deck.vel ? 2.2 : 0.9;
  deck.vel += (deck.target - deck.vel) * Math.min(1, k * dt);
  if (deck.target === 0 && deck.vel < 0.004) deck.vel = 0;
  deck.angle = (deck.angle + deck.vel * 360 * dt) % 360;
  el.disc.style.transform = `rotate(${deck.angle.toFixed(2)}deg)`;
  // Stop the loop entirely when the record is still, so an idle app uses no CPU
  if (deck.vel === 0) { deck.running = false; return; }
  requestAnimationFrame(spin);
}

function setLabelArt(url) {
  if (!url) {
    el.labelArt.hidden = true;
    el.labelArt.removeAttribute('src');
    return;
  }
  if (el.labelArt.getAttribute('src') === url) return;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => { el.labelArt.src = url; el.labelArt.hidden = false; };
  img.src = url;
}
const coverOf = (item) => `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;

/* ---------------- where files go ---------------- */

function currentDrive() {
  const f = (state.s.folder || '').toUpperCase();
  return state.drives.find((d) => f.startsWith(d.root.toUpperCase()));
}
function isUsbFolder() {
  // A drive-root folder like "E:\" that is not plugged in still counts as USB
  return /^[A-Z]:\\?$/i.test(state.s.folder || '') && !/^C:/i.test(state.s.folder);
}

function sortSummary() {
  const s = state.s;
  switch (s.sort) {
    case 'playlist': return 'Folder per playlist';
    case 'artist': return 'Folder per artist';
    case 'genre': return `Genre: ${s.genre || 'none picked'}`;
    case 'language': return s.language === 'auto' ? 'Folder per language' : `Language: ${s.language}`;
    case 'custom': return s.custom ? `Folder: ${s.custom}` : 'My folders';
    default: return 'No sorting';
  }
}

function renderSaveCard() {
  const s = state.s;
  const drive = currentDrive();
  if (drive) {
    el.saveIcon.setAttribute('href', '#i-usb');
    el.saveWhere.textContent = `${drive.label} (${drive.letter})`;
  } else if (isUsbFolder()) {
    el.saveIcon.setAttribute('href', '#i-usb');
    el.saveWhere.textContent = `USB drive ${s.folder.slice(0, 2)} is not plugged in`;
  } else {
    el.saveIcon.setAttribute('href', '#i-folder');
    el.saveWhere.textContent = s.folder.split(/[\\/]/).filter(Boolean).slice(-2).join('\\');
  }
  el.saveCard.title = s.folder;
  const sound = s.car ? `Car stereo, MP3 ${s.quality}` : s.format === 'mp3' ? `MP3 ${s.quality}` : s.format.toUpperCase();
  el.saveHow.textContent = `${sortSummary()}, ${sound}`;
}

function destPreview() {
  const s = state.s, list = state.list;
  let sub = '';
  if (s.sort === 'playlist' && list?.kind === 'playlist') sub = list.title;
  else if (s.sort === 'artist') sub = '<b>each artist</b>';
  else if (s.sort === 'language') sub = s.language === 'auto' ? '<b>each language</b>' : esc(s.language);
  else if (s.sort === 'genre') sub = esc(s.genre || 'Unsorted');
  else if (s.sort === 'custom') sub = esc(s.custom || 'Unsorted');
  const base = esc(s.folder.replace(/[\\/]$/, ''));
  return `Saves to ${base}${sub ? ` \\ ${sub === list?.title ? esc(sub) : sub}` : ''}${s.car ? ', car stereo ready' : ''}`;
}

function renderDest() {
  if (!state.list) return;
  el.destText.innerHTML = destPreview();
  const kind = state.s.sort;
  const picker = kind in BUCKET_KEYS;
  el.bucketWrap.hidden = !picker;
  if (picker) {
    el.bucketIcon.setAttribute('href', BUCKET_ICONS[kind]);
    const v = state.s[kind];
    el.bucketLabel.textContent = kind === 'language' && v === 'auto' ? 'Detect language' : v || 'Pick a folder';
  }
}

/* ---------------- folder buckets (genre / language / custom) ---------------- */

function bucketOptions(kind) {
  const list = state.s[BUCKET_KEYS[kind]] || [];
  return kind === 'language' ? [{ value: 'auto', label: 'Detect per song' }, ...list.map((x) => ({ value: x, label: x }))]
    : list.map((x) => ({ value: x, label: x }));
}

async function pickBucket(kind, value) {
  state.s[kind] = value;
  await api.set_setting(kind, value);
  afterSaveChange();
}

async function addBucket(kind, name) {
  const res = await api.add_bucket(kind, name);
  if (res.error) { toast(res.error, 'error'); return false; }
  state.s[BUCKET_KEYS[kind]] = res.list;
  state.s[kind] = res.selected;
  afterSaveChange();
  return true;
}

async function removeBucket(kind, name) {
  const res = await api.remove_bucket(kind, name);
  state.s[BUCKET_KEYS[kind]] = res.list;
  state.s[kind] = res.selected;
  afterSaveChange();
}

function newBucketInput(kind, onDone, cls) {
  const wrap = document.createElement('form');
  wrap.className = cls;
  wrap.innerHTML = `<input maxlength="60" placeholder="${kind === 'genre' ? 'Genre name' : kind === 'language' ? 'Language' : 'Folder name'}">`;
  const input = wrap.querySelector('input');
  wrap.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.trim() && await addBucket(kind, input.value)) onDone();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(); } });
  input.addEventListener('blur', () => setTimeout(onDone, 150));
  setTimeout(() => input.focus(), 0);
  return wrap;
}

function renderBuckets() {
  const kind = state.s.sort;
  el.buckets.textContent = '';
  if (!(kind in BUCKET_KEYS)) return;
  const current = state.s[kind];
  for (const opt of bucketOptions(kind)) {
    const b = document.createElement('button');
    b.className = 'bucket-chip';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(opt.value === current));
    b.innerHTML = `<span>${esc(opt.label)}</span>${opt.value === 'auto' ? '' : '<span class="rm" title="Remove"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></span>'}`;
    b.addEventListener('click', (e) => {
      if (e.target.closest('.rm')) removeBucket(kind, opt.value);
      else pickBucket(kind, opt.value);
    });
    el.buckets.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'bucket-chip add';
  add.innerHTML = `<svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>${kind === 'custom' ? 'New folder' : kind === 'genre' ? 'New genre' : 'New language'}`;
  add.addEventListener('click', () => add.replaceWith(newBucketInput(kind, renderBuckets, 'bucket-new')));
  el.buckets.appendChild(add);
}

function renderBucketMenu() {
  const kind = state.s.sort;
  const menu = el.bucketMenu;
  menu.textContent = '';
  for (const opt of bucketOptions(kind)) {
    const b = document.createElement('button');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(opt.value === state.s[kind]));
    b.innerHTML = `<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>${esc(opt.label)}`;
    b.addEventListener('click', () => { pickBucket(kind, opt.value); closeMenu(); });
    menu.appendChild(b);
  }
  menu.appendChild(document.createElement('hr'));
  const add = document.createElement('button');
  add.innerHTML = `<svg viewBox="0 0 24 24" style="opacity:1"><use href="#i-plus"/></svg>${kind === 'custom' ? 'New folder' : kind === 'genre' ? 'New genre' : 'New language'}`;
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    add.replaceWith(newBucketInput(kind, () => { if (!menu.hidden) closeMenu(); }, 'menu-new'));
  });
  menu.appendChild(add);
}

function openMenu() {
  if (state.phase === 'downloading') return;
  renderBucketMenu();
  el.bucketMenu.hidden = false;
  el.bucketBtn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  el.bucketMenu.hidden = true;
  el.bucketBtn.setAttribute('aria-expanded', 'false');
}
el.bucketBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  el.bucketMenu.hidden ? openMenu() : closeMenu();
});
el.bucketMenu.addEventListener('click', (e) => e.stopPropagation());

/* ---------------- save settings sheet ---------------- */

function renderDestList() {
  const s = state.s;
  const list = el.destList;
  list.textContent = '';
  const usb = currentDrive();

  const pc = document.createElement('div');
  pc.className = 'dest-opt';
  pc.setAttribute('role', 'radio');
  pc.setAttribute('aria-checked', String(!usb && !isUsbFolder()));
  pc.tabIndex = 0;
  pc.innerHTML = `<span class="tile"><svg viewBox="0 0 24 24"><use href="#i-folder"/></svg></span>
    <span class="row-text"><span class="row-title">Folder on this PC</span><span class="row-sub">${esc(s.pc_folder)}</span></span>
    <span class="side"><button class="link" data-act="change">Change</button><button class="link" data-act="open">Open</button></span>`;
  pc.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') { api.open_folder(s.pc_folder); return; }
    if (act === 'change') {
      const res = await api.choose_folder();
      Object.assign(state.s, res);
    } else {
      const res = await api.use_drive('');
      state.s.folder = res.folder;
    }
    afterSaveChange(true);
  });
  list.appendChild(pc);

  for (const d of state.drives) {
    const opt = document.createElement('div');
    opt.className = 'dest-opt';
    opt.setAttribute('role', 'radio');
    opt.setAttribute('aria-checked', String(usb?.root === d.root));
    opt.tabIndex = 0;
    const fat = /^FAT32$/i.test(d.fs);
    opt.innerHTML = `<span class="tile"><svg viewBox="0 0 24 24"><use href="#i-usb"/></svg></span>
      <span class="row-text"><span class="row-title">${esc(d.label)} (${d.letter})</span>
      <span class="row-sub">${fmtSize(d.free)} free of ${fmtSize(d.total)}, ${esc(d.fs)}${fat ? '' : ' <span class="warn">· older car stereos need FAT32</span>'}</span></span>
      <span class="side"><button class="link" data-act="open">Open</button><button class="link" data-act="eject">Eject</button></span>`;
    opt.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'open') { api.open_folder(d.root); return; }
      if (act === 'eject') { eject(d); return; }
      const res = await api.use_drive(d.root);
      if (res.error) { toast(res.error, 'error'); refreshDrives(); return; }
      state.s.folder = res.folder;
      if (!state.s.car) {
        setToggle('car', true);
        toast('Car stereo mode is on for this USB drive. You can turn it off below.');
      }
      afterSaveChange(true);
    });
    list.appendChild(opt);
  }

  if (!state.drives.length) {
    const empty = document.createElement('p');
    empty.className = 'dest-empty';
    empty.textContent = isUsbFolder()
      ? `The USB drive ${s.folder.slice(0, 2)} isn't plugged in. Plug it back in or pick the folder on this PC.`
      : 'Plug in a USB drive and it shows up here.';
    list.appendChild(empty);
  }
}

async function eject(d) {
  if (state.phase === 'downloading' && currentDrive()?.root === d.root) {
    toast('Wait for the download to finish first.', 'error');
    return;
  }
  toast(`Ejecting ${d.letter}…`);
  const res = await api.eject(d.letter);
  if (res.error) { toast(res.error, 'error', 6000); return; }
  toast(`${d.label} (${d.letter}) is safe to remove.`);
  await refreshDrives();
}

function renderSort() {
  el.sortGrid.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sort === state.s.sort)));
  el.sortNote.textContent = SORT_NOTES[state.s.sort];
  renderBuckets();
}

function renderSound() {
  const s = state.s;
  el.fmtField.classList.toggle('disabled', s.car);
  selectSeg(el.fmtSeg, s.car ? 'mp3' : s.format);
  selectSeg(el.qSeg, s.quality);
  $('#qualityField').classList.toggle('disabled', !s.car && s.format !== 'mp3');
  el.fmtHint.textContent = s.car ? 'Car stereo mode always saves MP3, the format every stereo plays.' : HINTS[s.format];
}

function renderToggles() {
  const s = state.s;
  el.optCar.checked = s.car;
  el.optNumbers.checked = s.car_numbers;
  el.optLevel.checked = s.car_level;
  el.optTidy.checked = s.tidy;
  el.optSkip.checked = s.skip_saved;
  el.optSync.checked = s.auto_sync;
  el.carExtras.classList.toggle('collapsed', !s.car);
}

function renderSheet() {
  renderDestList();
  renderSort();
  renderToggles();
  renderSound();
}

function openSheet() {
  if (state.phase === 'downloading') {
    toast('Settings unlock when the download finishes.');
    return;
  }
  renderSheet();
  el.scrim.hidden = false;
  el.sheet.hidden = false;
  el.scrim.classList.remove('closing');
  el.sheet.classList.remove('closing');
  refreshDrives();
  requestAnimationFrame(() => { placeThumb(el.fmtSeg); placeThumb(el.qSeg); });
}
function closeSheet() {
  closeAnimated(el.scrim);
  closeAnimated(el.sheet);
}

async function setToggle(key, value) {
  state.s[key] = value;
  await api.set_setting(key, value);
}

// Something about where or how songs are saved changed
async function afterSaveChange(folderChanged) {
  renderSaveCard();
  if (!el.sheet.hidden) renderSheet();
  if (!el.bucketMenu.hidden) renderBucketMenu();
  if (state.phase === 'done') resetRowsForRerun();
  if (folderChanged && state.list) {
    const saved = new Set(await api.saved_ids([...state.rows.values()].map((r) => r.item)));
    state.rows.forEach((r) => { r.item.saved = saved.has(r.item.id); paintRow(r); });
    updateNote();
  }
  renderDest();
  updateDownloadButton();
}

el.saveCard.addEventListener('click', openSheet);
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheetDone').addEventListener('click', closeSheet);
el.scrim.addEventListener('click', () => { closeSheet(); closeThemes(); });

el.sortGrid.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  await setToggle('sort', b.dataset.sort);
  if (b.dataset.sort === 'custom' && !state.s.custom && state.s.customs.length) await setToggle('custom', state.s.customs[0]);
  afterSaveChange();
});

for (const [input, key] of [[el.optCar, 'car'], [el.optNumbers, 'car_numbers'], [el.optLevel, 'car_level'],
  [el.optTidy, 'tidy'], [el.optSkip, 'skip_saved'], [el.optSync, 'auto_sync']]) {
  input.addEventListener('change', async () => {
    await setToggle(key, input.checked);
    afterSaveChange();
  });
}

/* ---------------- segmented controls ---------------- */

function placeThumb(seg) {
  const on = seg.querySelector('[aria-checked="true"]');
  const thumb = seg.querySelector('.seg-thumb');
  if (!on || !on.offsetWidth) return;
  thumb.style.width = `${on.offsetWidth}px`;
  thumb.style.transform = `translateX(${on.offsetLeft}px)`;
}
function selectSeg(seg, value) {
  seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === value)));
  placeThumb(seg);
}
function bindSeg(seg, key) {
  seg.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    selectSeg(seg, b.dataset.value);
    await setToggle(key, b.dataset.value);
    afterSaveChange();
  });
  seg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const btns = [...seg.querySelectorAll('button')];
    const i = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    next.click();
    next.focus();
  });
}

/* ---------------- drives ---------------- */

async function refreshDrives() {
  const drives = await api.drives();
  const before = new Set(state.drives.map((d) => d.root));
  const after = new Set(drives.map((d) => d.root));
  const changed = JSON.stringify(drives.map((d) => [d.root, d.label, d.free])) !==
    JSON.stringify(state.drives.map((d) => [d.root, d.label, d.free]));
  const wasCurrent = currentDrive();
  state.drives = drives;
  if (!changed) return;
  const plugged = booted ? drives.filter((d) => !before.has(d.root)) : [];
  if (wasCurrent && !after.has(wasCurrent.root)) {
    toast(`${wasCurrent.label} (${wasCurrent.letter}) was removed.`, 'error');
  }
  if (state.sync && !after.has(state.sync.drive.root)) state.sync = null;
  renderSaveCard();
  if (!el.sheet.hidden) renderDestList();
  for (const d of plugged) {
    if (!state.s.auto_sync || state.sync || state.phase === 'downloading' || state.phase === 'fetching') {
      toast(`${d.label} (${d.letter}) plugged in. Pick it under Save to.`);
    } else {
      await syncDrive(d, false);
    }
  }
}

/* ---------------- topping up a USB drive ---------------- */

// Cross-reference the drive with its songs, then download only what's missing: from the
// playlist on screen, and from every playlist saved to this drive before
async function syncDrive(d, isCurrent) {
  const before = state.phase;
  setPhase('fetching');
  setStatus(`Checking ${d.label}`, 'Looking at the songs already on it');
  const scan = await api.scan(d.root);
  setPhase(before);
  if (scan.error) { restoreStatus(); toast(scan.error, 'error'); return; }

  // A stick with no music on it isn't one to sync to; leave Save to alone
  if (!isCurrent && !scan.songs && !scan.known) {
    restoreStatus();
    toast(`${d.label} (${d.letter}) plugged in. Pick it under Save to.`);
    return;
  }
  if (!isCurrent) {
    const res = await api.use_drive(d.root);
    if (res.error) { restoreStatus(); toast(res.error, 'error'); return; }
    state.s.folder = res.folder;
  }

  const open = state.list?.items.length ? state.lastFetch : null;
  const queue = scan.sources.map((s) => s.url).filter((u) => u !== open);
  renderSaveCard();
  if (!open && !queue.length) {
    restoreStatus();
    if (!isCurrent) {
      toast(`Saving to ${d.label} (${d.letter}), which has ${plural(scan.songs, 'song')}. ` +
        'Open a playlist and Sonora adds only the ones it doesn’t have yet.', 'info', 7000);
    }
    return;
  }
  state.sync = { drive: d, queue, added: 0 };
  toast(`${d.label} (${d.letter}) has ${plural(scan.songs, 'song')}. Adding only the new ones.`);
  if (open) {
    await afterSaveChange(true);
    syncOpenList();
  } else {
    syncNext();
  }
}

function syncOpenList() {
  const sync = state.sync;
  const fresh = [...state.rows.values()].filter((r) => !r.item.saved);
  state.rows.forEach((r) => { r.on = !r.item.saved; paintRow(r); });
  updateNote();
  updateDownloadButton();
  if (fresh.length) {
    startDownload();
  } else {
    setStatus(`${state.list.title} is up to date`, `Every song is already on ${sync.drive.label}`);
    setTimeout(syncNext, 1200);
  }
}

async function syncNext() {
  const sync = state.sync;
  if (!sync) return;
  if (!sync.queue.length || currentDrive()?.root !== sync.drive.root) { finishSync(); return; }
  const url = sync.queue.shift();
  if (await fetchUrl(url) && state.sync === sync) syncOpenList();
  else if (state.sync === sync) syncNext();
}

function finishSync() {
  const sync = state.sync;
  state.sync = null;
  if (!sync) return;
  const where = `${sync.drive.label} (${sync.drive.letter})`;
  toast(sync.added
    ? `Added ${plural(sync.added, 'new song')} to ${where}. Eject it under Save to before unplugging.`
    : `${where} already has every song. Nothing new to add.`, 'info', 7000);
}

/* ---------------- account ---------------- */

function renderAccount() {
  const acc = state.account;
  el.chip.classList.toggle('on', !!acc);
  el.chipLabel.textContent = acc ? 'Signed in' : 'Sign in';
  el.popOut.hidden = !!acc;
  el.popIn.hidden = !acc;
  if (acc) {
    const via = { signin: 'Signed in with Google', file: 'Using an imported cookies.txt' }[acc.source]
      || `Using cookies from ${acc.source[0].toUpperCase()}${acc.source.slice(1)}`;
    const when = new Date(acc.since * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    el.since.textContent = `${via} on ${when}. Your liked songs and private playlists will work.`;
  }
}
function openPop() {
  el.pop.hidden = false;
  el.pop.classList.remove('closing');
  el.chip.setAttribute('aria-expanded', 'true');
}
function closePop() {
  el.chip.setAttribute('aria-expanded', 'false');
  closeAnimated(el.pop);
}
function signedIn(acc) {
  state.account = acc;
  busy(el.btnSignIn, false);
  renderAccount();
  toast("You're signed in. Your liked songs are ready.");
  setTimeout(closePop, 900);
}

/* ---------------- fetching ---------------- */

function shake() {
  el.form.classList.add('shake');
  setTimeout(() => el.form.classList.remove('shake'), 400);
}

async function fetchUrl(url, chip) {
  if (state.phase === 'downloading' || state.phase === 'fetching') return false;
  url = (url || '').trim();
  if (!url) { shake(); el.input.focus(); return false; }

  const before = state.phase;
  setPhase('fetching');
  busy(el.btnFetch, true);
  chip && chip.classList.add('busy');
  setStatus(chip ? 'Opening your likes' : 'Reading the link', 'Big playlists take a moment');

  const res = await api.fetch(url);

  busy(el.btnFetch, false);
  chip && chip.classList.remove('busy');
  if (res.error) {
    setPhase(before);
    restoreStatus();
    toast(res.error, 'error', 6000);
    if (res.needs_login) openPop();
    shake();
    return false;
  }
  state.lastFetch = url;
  renderList(res);
  return true;
}

function restoreStatus() {
  if (state.list) setStatus(`${plural(state.list.items.length, 'song')} found`, 'Untick anything you want to leave out');
  else setStatus('Ready when you are', 'Paste a link to start');
}

function renderList(data) {
  state.list = data;
  state.rows.clear();
  el.tracks.textContent = '';
  setProgress(0);

  const tpl = $('#trackTpl').content.firstElementChild;
  const frag = document.createDocumentFragment();
  const stagger = !reduceMotion && !document.body.classList.contains('lite');
  data.items.forEach((item, i) => {
    const li = tpl.cloneNode(true);
    li.dataset.id = item.id;
    li.querySelector('img').src = item.thumb;
    const title = li.querySelector('.track-title');
    title.textContent = item.title;
    title.title = item.title;
    li.querySelector('.track-channel').textContent = item.channel;
    li.querySelector('.track-time').textContent = fmtTime(item.duration);
    if (stagger && i < 14) { li.classList.add('enter'); li.style.setProperty('--i', i); }
    const row = { item, li, on: true, status: 'queued', pct: 0, speed: 0 };
    state.rows.set(item.id, row);
    paintRow(row);
    frag.appendChild(li);
  });
  el.tracks.appendChild(frag);
  el.tracks.scrollTop = 0;

  el.resultTitle.textContent = data.title;
  el.resultTitle.title = data.title;
  const total = data.items.reduce((s, x) => s + (x.duration || 0), 0);
  const parts = [];
  if (data.owner) parts.push(data.kind === 'playlist' ? `by ${data.owner}` : data.owner);
  parts.push(plural(data.items.length, 'song'));
  if (total) parts.push(fmtLength(total));
  el.resultMeta.textContent = parts.join(', ');

  el.empty.hidden = true;
  el.result.hidden = false;
  el.result.style.animation = 'none';
  void el.result.offsetWidth;
  el.result.style.animation = '';

  setPhase('ready');
  renderDest();
  updateNote();
  updateDownloadButton();
  setLabelArt(data.items[0] ? coverOf(data.items[0]) : null);
  if (data.items.length) restoreStatus();
  else setStatus('Nothing to download', 'This playlist has no playable songs');
}

function updateNote() {
  if (!state.list) return;
  const notes = [];
  const saved = [...state.rows.values()].filter((r) => r.item.saved).length;
  if (saved && state.s.skip_saved) notes.push(`${saved} already saved`);
  if (state.list.hidden) notes.push(`${plural(state.list.hidden, 'private or deleted video')} hidden`);
  el.listNote.textContent = notes.join(', ');
}

/* ---------------- rows ---------------- */

const CHECK = '<span class="done-mark"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></span>';
const isSkippable = (row) => row.item.saved && state.s.skip_saved;

function paintRow(row) {
  const { li } = row;
  if (li.dataset.status !== row.status) li.dataset.status = row.status;
  li.classList.toggle('off', !row.on);
  li.querySelector('.pick').setAttribute('aria-pressed', String(row.on));
  li.querySelector('.track-bar span').style.setProperty('--p', (row.pct || 0) / 100);
  const st = li.querySelector('.track-state');
  let text = '';
  switch (row.status) {
    case 'queued':
      text = isSkippable(row) ? 'Saved before' : state.phase === 'downloading' && row.on ? 'Waiting' : '';
      break;
    case 'downloading': text = `${Math.round(row.pct)}%`; break;
    case 'converting': text = 'Saving'; break;
    case 'done':
      if (!st.querySelector('.done-mark')) st.innerHTML = `Saved ${CHECK}`;
      return;
    case 'skipped': text = 'Saved before'; break;
    case 'failed': text = 'Failed'; li.title = row.error || ''; break;
    case 'cancelled': text = 'Stopped'; break;
  }
  if (st.textContent !== text) st.textContent = text;
}

el.tracks.addEventListener('click', (e) => {
  const li = e.target.closest('.track');
  if (!li) return;
  const row = state.rows.get(li.dataset.id);
  if (row.status === 'done' && row.file) { api.reveal(row.file); return; }
  if (state.phase === 'downloading') return;
  if (state.phase === 'done') resetRowsForRerun();
  row.on = !row.on;
  paintRow(row);
  updateDownloadButton();
});

function setAll(on) {
  if (state.phase === 'downloading') return;
  if (state.phase === 'done') resetRowsForRerun();
  state.rows.forEach((r) => { r.on = on; paintRow(r); });
  updateDownloadButton();
}

function resetRowsForRerun() {
  setPhase('ready');
  setProgress(0);
  state.rows.forEach((r) => {
    if (r.status === 'done' || r.status === 'skipped') r.item.saved = true;
    if (r.status !== 'done') { r.status = 'queued'; r.pct = 0; }
    paintRow(r);
  });
  updateNote();
  restoreStatus();
}

/* ---------------- downloading ---------------- */

const selectedRows = () => [...state.rows.values()].filter((r) => r.on);

function updateDownloadButton() {
  const b = el.btnDownload;
  b.classList.remove('stop');
  b.disabled = false;
  if (!state.list) return;
  if (state.phase === 'downloading') {
    b.classList.add('stop');
    el.downloadLabel.textContent = 'Stop';
    return;
  }
  if (state.phase === 'done') {
    el.downloadLabel.textContent = 'Open folder';
    return;
  }
  const rows = selectedRows();
  const fresh = rows.filter((r) => !isSkippable(r)).length;
  const needsBucket = state.s.sort in BUCKET_KEYS && !state.s[state.s.sort];
  b.disabled = !fresh || needsBucket;
  el.downloadLabel.textContent = !rows.length ? 'Pick some songs'
    : !fresh ? 'All saved already'
    : needsBucket ? 'Pick a folder first'
    : fresh === 1 ? 'Download 1 song' : `Download ${fresh} songs`;
}

async function startDownload() {
  const rows = selectedRows();
  if (!rows.length) return;
  if (isUsbFolder() && !currentDrive()) {
    toast(`Plug in the USB drive ${state.s.folder.slice(0, 2)} first, or pick another place under Save to.`, 'error', 6000);
    return;
  }
  rows.forEach((r) => { r.status = 'queued'; r.pct = 0; });
  state.job = { ids: rows.map((r) => r.item.id) };
  setPhase('downloading');
  state.rows.forEach(paintRow);
  updateDownloadButton();
  refreshJobStatus();

  const res = await api.start(rows.map((r) => r.item), state.list.title, state.list.kind, state.lastFetch);
  if (res.error) {
    state.sync = null;
    toast(res.error, 'error', 6000);
    setPhase('ready');
    state.rows.forEach((r) => { r.status = 'queued'; paintRow(r); });
    updateDownloadButton();
    restoreStatus();
    return;
  }
  state.job.target = res.target;
}

const jobRows = () => (state.job ? state.job.ids.map((id) => state.rows.get(id)).filter(Boolean) : []);
const FINAL = new Set(['done', 'skipped', 'failed', 'cancelled']);

function refreshJobStatus() {
  const rows = jobRows();
  if (!rows.length) return;
  let finished = 0, p = 0, speed = 0, active = 0, converting = 0;
  for (const r of rows) {
    if (FINAL.has(r.status)) { finished++; p += 1; }
    else if (r.status === 'converting') { converting++; p += 0.95; }
    else if (r.status === 'downloading') { active++; speed += r.speed || 0; p += (r.pct / 100) * 0.9; }
  }
  setProgress(p / rows.length);
  if (state.phase !== 'downloading') return;
  const verb = !active && converting ? 'Saving' : 'Downloading';
  const left = rows.length - finished;
  const now = Math.min(rows.length, finished + 1);
  setStatus(rows.length === 1 ? verb : `${verb} ${now} of ${rows.length}`,
    [fmtSpeed(speed), left > 1 ? `${left} to go` : ''].filter(Boolean).join(', ') || 'Starting…');
}

function onItem(ev) {
  const row = state.rows.get(ev.id);
  if (!row) return;
  const was = row.status;
  row.status = ev.status;
  if (ev.pct != null) row.pct = ev.pct;
  row.speed = ev.speed || 0;
  if (ev.file) row.file = ev.file;
  if (ev.error) row.error = ev.error;
  paintRow(row);
  if (ev.status === 'downloading' && was !== 'downloading') {
    setLabelArt(coverOf(row.item));
    if (state.rows.size > 8) row.li.scrollIntoView({ block: 'nearest' });
  }
}

function onJobDone(ev) {
  const { done, skipped, failed } = ev.counts;
  if (state.job) state.job.target = ev.target;
  setPhase('done');
  setProgress(1);
  if (!reduceMotion) {
    el.turntable.classList.remove('complete');
    void el.turntable.offsetWidth;
    el.turntable.classList.add('complete');
  }
  const bits = [];
  if (done) bits.push(`${done} saved`);
  if (skipped) bits.push(`${skipped} saved before`);
  if (failed) bits.push(`${failed} failed`);
  if (ev.cancelled) {
    setStatus('Stopped', bits.join(', ') || 'Nothing was saved');
    jobRows().forEach((r) => { if (r.status === 'cancelled') { r.status = 'queued'; paintRow(r); } });
    setPhase('ready');
    setProgress(0);
  } else {
    setStatus(failed && !done ? 'That didn’t work' : 'All done', bits.join(', '));
    if (state.sync) {
      // One summary at the end of the top-up instead of a toast per playlist
      state.sync.added += done;
    } else if (done) {
      const where = currentDrive() ? `${currentDrive().label} (${currentDrive().letter})` : ev.target.split(/[\\/]/).filter(Boolean).pop();
      toast(`Saved ${plural(done, 'song')} to ${where}.${currentDrive() ? ' Eject it under Save to before unplugging.' : ''}`, 'info', 6000);
    }
    if (failed) {
      const firstErr = jobRows().find((r) => r.status === 'failed')?.error;
      toast(`${plural(failed, 'song')} couldn't be downloaded. ${firstErr || ''}`, 'error', 7000);
    }
  }
  updateDownloadButton();
  refreshDrives();
  if (state.sync) {
    if (ev.cancelled) state.sync = null;
    else setTimeout(syncNext, 1500);
  }
}

el.btnDownload.addEventListener('click', () => {
  if (state.phase === 'downloading') {
    el.btnDownload.disabled = true;
    el.downloadLabel.textContent = 'Stopping…';
    api.cancel();
  } else if (state.phase === 'done') {
    api.open_folder(state.job?.target || state.s.folder);
  } else {
    startDownload();
  }
});

/* ---------------- themes ---------------- */

const COLOR_FIELDS = [
  ['bg', 'Background', 'Behind everything'],
  ['surface', 'Panels', 'Cards, menus and sheets like this one'],
  ['text', 'Text', 'Titles, song names and the record label'],
  ['accent', 'Accent', 'Buttons, progress ring and highlights'],
];
const th = {
  sheet: $('#themeSheet'), list: $('#themeList'), editor: $('#themeEditor'),
  presets: $('#presetGrid'), customs: $('#customGrid'), title: $('#themeTitle'), back: $('#themeBack'),
  footList: $('#themeFootList'), footEdit: $('#themeFootEdit'), name: $('#themeName'),
  rows: $('#colorRows'), note: $('#contrastNote'), startFrom: $('#startFrom'),
};
let draft = null; // the theme being edited; null while browsing

const allThemes = () => [...PRESET_THEMES, ...(state.s.themes || [])];
const findTheme = (id) => allThemes().find((t) => t.id === id) || PRESET_THEMES[0];
const activeTheme = () => findTheme(state.s.theme);
const previewVars = (t) => `--p-bg:${t.bg};--p-surface:${t.surface};--p-text:${t.text};--p-accent:${t.accent}`;

function normalHex(v) {
  v = v.trim().replace(/^#?/, '#').toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) v = '#' + [...v.slice(1)].map((c) => c + c).join('');
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

function fadeTheme(theme) {
  const root = document.documentElement;
  if (!reduceMotion) root.classList.add('theming');
  applyTheme(theme);
  clearTimeout(fadeTheme.timer);
  fadeTheme.timer = setTimeout(() => root.classList.remove('theming'), 420);
}

async function useTheme(id) {
  const theme = findTheme(id);
  if (theme.id === state.s.theme) return;
  state.s.theme = theme.id;
  fadeTheme(theme);
  renderThemeGrids();
  await api.use_theme(theme.id, theme.bg);
}

function themeCard(t, custom) {
  const card = document.createElement('div');
  card.className = 'theme-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'radio');
  card.setAttribute('aria-checked', String(t.id === state.s.theme));
  card.setAttribute('aria-label', t.name);
  card.innerHTML = `<span class="theme-preview" style="${previewVars(t)}"><span class="tp-disc"></span><span class="tp-panel"><i></i><i></i><b></b></span></span>
    <span class="theme-name"><span>${esc(t.name)}</span></span>` + (custom ? `<span class="theme-tools">
      <button type="button" data-act="edit" aria-label="Edit ${esc(t.name)}" title="Edit"><span><svg viewBox="0 0 24 24"><use href="#i-pencil"/></svg></span></button>
      <button type="button" data-act="delete" aria-label="Delete ${esc(t.name)}" title="Delete"><span><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></span></button>
    </span>` : '');
  card.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit') openEditor(t, false);
    else if (act === 'delete') deleteTheme(t);
    else useTheme(t.id);
  });
  card.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); useTheme(t.id); }
  });
  return card;
}

function renderThemeGrids() {
  th.presets.replaceChildren(...PRESET_THEMES.map((t) => themeCard(t, false)));
  const mine = (state.s.themes || []).map((t) => themeCard(t, true));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'theme-card theme-new';
  add.innerHTML = '<span class="theme-preview"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg></span><span class="theme-name"><span>New theme</span></span>';
  add.addEventListener('click', () => openEditor(activeTheme(), true));
  th.customs.replaceChildren(...mine, add);
  if (!mine.length) {
    const p = document.createElement('p');
    p.className = 'themes-empty';
    p.textContent = 'Pick your own background, panel, text and accent colours.';
    th.customs.prepend(p);
  }
}

function showThemeMode(editing) {
  th.list.hidden = editing;
  th.editor.hidden = !editing;
  th.footList.hidden = editing;
  th.footEdit.hidden = !editing;
  th.back.hidden = !editing;
  th.title.textContent = !editing ? 'Themes' : draft.id ? 'Edit theme' : 'New theme';
}

function openEditor(base, isNew) {
  draft = { id: isNew ? '' : base.id, name: isNew ? '' : base.name };
  for (const [key] of COLOR_FIELDS) draft[key] = base[key];
  th.name.value = draft.name;
  th.name.placeholder = isNew ? `${base.name} copy` : 'My theme';
  renderColorRows();
  th.startFrom.replaceChildren(...PRESET_THEMES.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = t.name;
    b.setAttribute('aria-label', `Start from ${t.name}`);
    b.style.cssText = previewVars(t);
    b.addEventListener('click', () => {
      for (const [key] of COLOR_FIELDS) draft[key] = t[key];
      renderColorRows();
      previewDraft();
    });
    return b;
  }));
  showThemeMode(true);
  previewDraft();
  th.editor.scrollTop = 0;
  if (isNew) setTimeout(() => th.name.focus(), 50);
}

function renderColorRows() {
  th.rows.replaceChildren(...COLOR_FIELDS.map(([key, title, sub]) => {
    const row = document.createElement('div');
    row.className = 'color-row';
    row.innerHTML = `<span class="row-text"><span class="row-title">${title}</span><span class="row-sub">${sub}</span></span>
      <span class="swatch-input"><input type="color" aria-label="${title} colour"><input class="hex" maxlength="7" spellcheck="false" aria-label="${title} hex code"></span>`;
    const [picker, hex] = row.querySelectorAll('input');
    picker.value = hex.value = draft[key];
    picker.addEventListener('input', () => {
      draft[key] = hex.value = picker.value;
      hex.classList.remove('invalid');
      previewDraft();
    });
    hex.addEventListener('input', () => {
      const v = normalHex(hex.value);
      hex.classList.toggle('invalid', !v);
      if (!v) return;
      draft[key] = picker.value = v;
      previewDraft();
    });
    hex.addEventListener('blur', () => { hex.value = draft[key]; hex.classList.remove('invalid'); });
    return row;
  }));
}

function previewDraft() {
  // Live preview on the whole app, but not remembered until it's saved
  applyTheme(draft, false);
  const warn = [];
  if (contrast(draft.text, draft.bg) < 4.5) warn.push('the background');
  if (contrast(draft.text, draft.surface) < 4.5) warn.push('panels');
  th.note.textContent = warn.length ? `Text may be hard to read on ${warn.join(' and ')}.` : '';
}

function closeEditor() {
  if (!draft) return;
  draft = null;
  fadeTheme(activeTheme());
  renderThemeGrids();
  showThemeMode(false);
}

async function saveDraft() {
  const theme = { ...draft, name: th.name.value.trim() || th.name.placeholder };
  const res = await api.save_theme(theme);
  if (res.error) { toast(res.error, 'error'); return; }
  state.s.themes = res.themes;
  state.s.theme = res.theme;
  draft = null;
  applyTheme(activeTheme());
  renderThemeGrids();
  showThemeMode(false);
  toast(`${activeTheme().name} saved and switched on.`);
}

async function deleteTheme(t) {
  const res = await api.delete_theme(t.id);
  state.s.themes = res.themes;
  if (state.s.theme !== res.theme) {
    state.s.theme = res.theme;
    fadeTheme(activeTheme());
  }
  renderThemeGrids();
  toast(`Deleted ${t.name}.`);
}

function openThemes() {
  if (!el.sheet.hidden) closeSheet();
  draft = null;
  renderThemeGrids();
  showThemeMode(false);
  el.scrim.hidden = false;
  th.sheet.hidden = false;
  el.scrim.classList.remove('closing');
  th.sheet.classList.remove('closing');
}
function closeThemes() {
  if (th.sheet.hidden) return;
  closeEditor();
  closeAnimated(el.scrim);
  closeAnimated(th.sheet);
}

$('#themeBtn').addEventListener('click', openThemes);
$('#themeClose').addEventListener('click', closeThemes);
$('#themeDone').addEventListener('click', closeThemes);
th.back.addEventListener('click', closeEditor);
$('#themeCancel').addEventListener('click', closeEditor);
$('#themeSave').addEventListener('click', saveDraft);
th.editor.addEventListener('submit', (e) => { e.preventDefault(); saveDraft(); });

/* ---------------- events from Python ---------------- */

window.sonora = {
  receive(batch) {
    // Skip progress ticks that a later tick in the same batch supersedes
    const last = new Map();
    batch.forEach((ev, i) => { if (ev.type === 'item') last.set(ev.id, i); });
    let items = false;
    batch.forEach((ev, i) => {
      if (ev.type === 'item') {
        const j = last.get(ev.id);
        if (ev.status === 'downloading' && j !== i && batch[j].status === 'downloading') return;
        onItem(ev);
        items = true;
      } else if (ev.type === 'job_done') onJobDone(ev);
      else if (ev.type === 'account') signedIn(ev.account);
      else if (ev.type === 'login_closed') busy(el.btnSignIn, false);
      else if (ev.type === 'scan' && state.phase === 'fetching') {
        el.statusSub.textContent = `${plural(ev.count, 'song')} checked`;
      }
    });
    if (items) refreshJobStatus();
  },
};

/* ---------------- wiring ---------------- */

const looksLikeLink = (text) => /(youtube\.com|youtu\.be)\//i.test(text || '');

el.form.addEventListener('submit', (e) => { e.preventDefault(); fetchUrl(el.input.value); });
el.input.addEventListener('paste', () => {
  setTimeout(() => { if (looksLikeLink(el.input.value)) fetchUrl(el.input.value); }, 0);
});
document.addEventListener('paste', (e) => {
  if (e.target === el.input || e.target.tagName === 'INPUT') return;
  const text = e.clipboardData.getData('text');
  if (!looksLikeLink(text)) return;
  el.input.value = text.trim();
  fetchUrl(el.input.value);
});

document.querySelectorAll('[data-liked]').forEach((chip) => {
  chip.addEventListener('click', () => {
    if (!state.account) {
      toast('Sign in first so Sonora can see your liked songs.');
      openPop();
      return;
    }
    el.input.value = '';
    fetchUrl(chip.dataset.liked, chip);
  });
});

$('#btnSelectAll').addEventListener('click', () => setAll(true));
$('#btnSelectNone').addEventListener('click', () => setAll(false));

el.chip.addEventListener('click', (e) => {
  e.stopPropagation();
  el.pop.hidden ? openPop() : closePop();
});
document.addEventListener('click', (e) => {
  if (!el.pop.hidden && !el.pop.contains(e.target)) closePop();
  if (!el.bucketMenu.hidden) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closePop();
  closeMenu();
  if (!el.sheet.hidden) closeSheet();
  closeThemes();
});

el.btnSignIn.addEventListener('click', () => {
  busy(el.btnSignIn, true);
  el.btnSignIn.classList.remove('busy');
  el.btnSignIn.querySelector('.btn-label').textContent = 'Finish signing in in the new window';
  api.sign_in();
});
new MutationObserver(() => {
  if (!el.btnSignIn.disabled) el.btnSignIn.querySelector('.btn-label').textContent = 'Sign in to YouTube';
}).observe(el.btnSignIn, { attributes: true, attributeFilter: ['disabled'] });

$('#btnImport').addEventListener('click', async () => {
  const res = await api.import_cookies();
  if (res.account) signedIn(res.account);
  else if (res.error) toast(res.error, 'error', 6000);
});
el.browserPick.addEventListener('change', async () => {
  const browser = el.browserPick.value;
  if (!browser) return;
  el.browserPick.disabled = true;
  const res = await api.use_browser(browser);
  el.browserPick.disabled = false;
  el.browserPick.value = '';
  if (res.account) signedIn(res.account);
  else toast(res.error, 'error', 7000);
});
$('#btnSignOut').addEventListener('click', async () => {
  await api.sign_out();
  state.account = null;
  renderAccount();
  closePop();
  toast('Signed out. Sonora no longer has your YouTube cookies.');
});

$('#wcMin').addEventListener('click', () => api.minimize());
$('#wcMax').addEventListener('click', () => api.toggle_maximize());
$('#wcClose').addEventListener('click', () => api.close());

let booted = false;
async function boot() {
  api = window.pywebview.api;
  const init = await api.init();
  state.s = init;
  state.account = init.account;
  state.drives = init.drives;
  applyTheme(activeTheme());
  if (init.low_end || (navigator.hardwareConcurrency || 8) <= 4) document.body.classList.add('lite');
  bindSeg(el.fmtSeg, 'format');
  bindSeg(el.qSeg, 'quality');
  renderAccount();
  renderSaveCard();
  setPhase('idle');
  if (init.missing.length) toast(`Missing ${init.missing.join(' and ')}. Downloads may fail.`, 'error', 8000);
  el.input.focus();
  booted = true;
  // Started with the USB drive already in: top it up straight away
  if (state.s.auto_sync && currentDrive()) syncDrive(currentDrive(), true);
  // Notice USB drives coming and going; skipped while the window is minimised
  setInterval(() => { if (!document.hidden) refreshDrives(); }, 4000);
}

if (window.pywebview && window.pywebview.api && window.pywebview.api.init) boot();
else window.addEventListener('pywebviewready', boot, { once: true });
