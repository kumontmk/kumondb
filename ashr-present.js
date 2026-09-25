// ashr-present.js — ASHR Stage Presenter (realtime controller)
import { auth, db } from './auth.js';
import { ref, get, set, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t as tCore, applyI18n } from './ashr-i18n.js';
import { mountStage, matchScan, searchHonorees, medalFor } from './ashr-stage.js';

const t = (key, fallback) => { const v = tCore(key); return (v && v !== key) ? v : fallback; };
await i18nReady.catch(() => {});

// ============================================
// STATE
// ============================================
let currentEventId = localStorage.getItem('ashr_eventId') || '2026';
let eventSettings = {}, honorees = {}, checkins = {}, presState = null;
let honoreesLoaded = false;
let queue = [], queueIndex = 0, recent = [];
let effectsOn = localStorage.getItem(`ashr_fx_${currentEventId}`) !== '0';
let soundOn = localStorage.getItem(`ashr_sound_${currentEventId}`) === '1';
let stage = null, html5QrCode = null;
let unsubs = [], syncingToggles = false;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function eventDisplayName() {
  const base = String(eventSettings.eventName || `ASHR ${currentEventId}`).trim();
  return /^kumon\b/i.test(base) ? base : `Kumon ${base}`;
}

// ============================================
// INIT
// ============================================
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'index.html'; return; }
  applyI18n();
  stage = mountStage($('previewHost'), { mini: true, silent: true });
  loadPrefs(); loadQueueStorage(); loadRecentStorage();
  $('fxToggle').checked = effectsOn;
  $('soundToggle').checked = soundOn;
  await setupEventSelect();
  setupControls(); setupCamera();
  subscribe(currentEventId);
  $('page-loader').classList.add('hidden');
  $('mainContent').style.display = 'block';
  $('presScan').focus();
});

// ============================================
// REALTIME
// ============================================
function subscribe(eventId) {
  unsubs.forEach(fn => fn()); unsubs = [];
  const on = (path, cb) => {
    const u = onValue(ref(db, path), cb, err => console.error(`Listener error on ${path}:`, err));
    unsubs.push(() => u());
  };
  on(`ashrEvents/${eventId}/settings`, s => { eventSettings = s.val() || {}; });
  on(`ashrEvents/${eventId}/honorees`, s => {
    honorees = s.val() || {}; honoreesLoaded = true;
    renderQueue(); renderRecent();
  });
  on(`ashrEvents/${eventId}/checkins`, s => { checkins = s.val() || {}; });
  on(`ashrEvents/${eventId}/presentation`, s => {
    presState = s.val() || null;
    stage.apply(presState || { mode: 'backdrop' });
    updateNowBar(); syncToggles();
  });
  on('.info/connected', s => $('connDot').classList.toggle('on', s.val() === true));
}

function presRef() { return ref(db, `ashrEvents/${currentEventId}/presentation`); }

// ============================================
// SEND ACTIONS
// ============================================
async function showStudent(key) {
  const h = honorees[key];
  if (!h) { feedback(`❌ ${t('pres.gone', 'Student no longer in honoree list')}`, 'error'); return; }
  const awards = h.awards || [];
  const tier = awards.some(a => a.tier === 'Gold') ? 'Gold'
             : awards.some(a => a.tier === 'Silver') ? 'Silver' : 'Bronze';
  try {
    await set(presRef(), {
      mode: 'student', honoreeKey: key, seq: Date.now(),
      eventName: eventDisplayName(),
      student: {
        nameCn: h.nameCn || '', nameEn: h.nameEn || '',
        centerName: h.centerName || '', studentNumber: h.studentNumber || '',
        tier, awards: awards.map(a => ({ subject: a.subject, stars: a.stars, tier: a.tier }))
      },
      effects: effectsOn, sound: soundOn,
      updatedAt: new Date().toISOString(),
      updatedBy: auth.currentUser?.email || ''
    });
    pushRecent(key);
    feedback(`✅ ${t('pres.showing', 'Now showing')}: ${h.nameCn || h.nameEn}`, 'success');
  } catch (err) { feedback(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

async function sendMode(mode) {
  try {
    await set(presRef(), {
      mode, honoreeKey: null, student: null, seq: Date.now(),
      eventName: eventDisplayName(), effects: effectsOn, sound: soundOn,
      updatedAt: new Date().toISOString(), updatedBy: auth.currentUser?.email || ''
    });
    feedback(mode === 'blank' ? '⬛ ' + t('pres.blank', 'Screen blanked')
                              : '🧹 ' + t('pres.cleared', 'Cleared to backdrop'), 'success');
  } catch (err) { feedback(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

// ============================================
// SCAN / SEARCH PIPELINE
// ============================================
function processInput(raw) {
  const v = String(raw || '').trim();
  if (!v) return;
  if (!honoreesLoaded) { feedback('⏳ ' + t('pres.loading', 'Still loading honorees…'), 'info'); return; }

  const exact = matchScan(honorees, v, currentEventId);
  if (exact) { hideDrop(); $('presScan').value = ''; showStudent(exact.key); return; }

  const results = searchHonorees(honorees, v, 10);
  if (results.length === 1) { hideDrop(); $('presScan').value = ''; showStudent(results[0].key); return; }
  if (results.length > 1) {
    renderSearchDrop(v);
    feedback(`🔎 ${results.length} ${t('pres.matches', 'matches — pick one from the list')}`, 'info');
    return;
  }
  feedback(`❌ "${esc(v)}" ${t('pres.notFound', 'not found. Check the spelling, or use 🧹 Clear to show the backdrop only.')}`, 'error');
}

function renderSearchDrop(q) {
  const drop = $('searchDrop');
  const results = searchHonorees(honorees, q, 10);
  drop.innerHTML = '';
  if (!results.length) { drop.classList.add('hidden'); return; }
  results.forEach(r => {
    const div = document.createElement('div');
    div.className = 'result-item pres-result';
    const medals = (r.awards || []).map(a =>
      `<span class="mini-award tier-${String(a.tier || 'bronze').toLowerCase()}">${medalFor(a.tier)} ${esc(a.subject)} ${'★'.repeat(a.stars || 0)}</span>`).join('');
    const arrived = checkins[r.key]
      ? `<span class="arrived">✓ ${t('pres.here', 'checked in')}</span>` : '';
    div.innerHTML = `
      <div class="ri-main">
        <strong>${esc(r.nameCn || r.nameEn || '')}</strong>
        <small>${esc(r.nameEn && r.nameCn ? r.nameEn : '')}</small> ${arrived}
        <div class="ri-meta">${esc(r.centerName || '')} · #${esc(r.studentNumber || '')}</div>
        <div class="ri-awards">${medals}</div>
      </div>
      <button class="btn-small primary ri-show">▶ ${t('pres.show', 'Show')}</button>
      <button class="btn-small secondary ri-queue">＋ ${t('pres.queue', 'Queue')}</button>`;
    div.querySelector('.ri-show').onclick = e => { e.stopPropagation(); hideDrop(); showStudent(r.key); };
    div.querySelector('.ri-queue').onclick = e => { e.stopPropagation(); addToQueue(r.key); };
    div.onclick = () => { hideDrop(); $('presScan').value = ''; showStudent(r.key); };
    drop.appendChild(div);
  });
  drop.classList.remove('hidden');
}
function hideDrop() { $('searchDrop').classList.add('hidden'); }

// ============================================
// QUEUE (localStorage per event)
// ============================================
function qKey() { return `ashr_pq_${currentEventId}`; }
function loadQueueStorage() {
  try {
    const d = JSON.parse(localStorage.getItem(qKey()) || '{}');
    queue = Array.isArray(d.items) ? d.items : [];
    queueIndex = Number.isInteger(d.index) ? d.index : 0;
  } catch { queue = []; queueIndex = 0; }
}
function saveQueue() { localStorage.setItem(qKey(), JSON.stringify({ items: queue, index: queueIndex })); }

function addToQueue(key) {
  const at = queue.indexOf(key);
  if (at >= 0) { feedback(`ℹ️ ${t('pres.alreadyQ', 'Already in queue at position')} ${at + 1}`, 'info'); return; }
  queue.push(key); saveQueue(); renderQueue();
  const h = honorees[key];
  feedback(`➕ ${t('pres.queued', 'Queued')}: ${h ? (h.nameCn || h.nameEn) : key}`, 'success');
}

function renderQueue() {
  const list = $('queueList');
  list.innerHTML = '';
  if (!queue.length) {
    list.innerHTML = `<p class="hint">${t('pres.qEmpty', 'Queue is empty — add honorees via the ＋ Queue button in search results to plan the ceremony order.')}</p>`;
  }
  queue.forEach((key, i) => {
    const h = honorees[key];
    const li = document.createElement('li');
    li.className = 'q-item' + (i < queueIndex ? ' q-done' : '') + (i === queueIndex ? ' q-next' : '');
    li.innerHTML = `
      <span class="q-num">${i + 1}</span>
      <div class="q-info">
        <strong>${esc(h ? (h.nameCn || h.nameEn) : key)}</strong>
        <small>${esc(h ? `${h.centerName || ''} · ${(h.awards || []).length} award(s)` : t('pres.removed', 'no longer in honorees'))}</small>
      </div>
      <button class="btn-small primary q-show" title="Show now">▶</button>
      <button class="btn-small secondary q-up" title="Move up">↑</button>
      <button class="btn-small secondary q-down" title="Move down">↓</button>
      <button class="btn-small danger q-del" title="Remove">✕</button>`;
    li.querySelector('.q-show').onclick = () => { queueIndex = i + 1; saveQueue(); renderQueue(); showStudent(key); };
    li.querySelector('.q-up').onclick = () => moveQueue(i, -1);
    li.querySelector('.q-down').onclick = () => moveQueue(i, 1);
    li.querySelector('.q-del').onclick = () => {
      queue.splice(i, 1); if (i < queueIndex) queueIndex--;
      saveQueue(); renderQueue();
    };
    list.appendChild(li);
  });
  $('queueProgress').textContent = queue.length
    ? `${Math.min(queueIndex, queue.length)} / ${queue.length} ${t('pres.shown', 'shown')}` : '';
}

function moveQueue(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= queue.length) return;
  const nextKey = queue[queueIndex];
  [queue[i], queue[j]] = [queue[j], queue[i]];
  queueIndex = nextKey === undefined ? queue.length : Math.max(0, queue.indexOf(nextKey));
  saveQueue(); renderQueue();
}

function showNext() {
  if (!queue.length) { feedback(`ℹ️ ${t('pres.qEmptyShort', 'Queue is empty')}`, 'info'); return; }
  if (queueIndex >= queue.length) { feedback(`🏁 ${t('pres.qDone', 'Queue finished — use ↺ Reset to replay')}`, 'info'); return; }
  const key = queue[queueIndex];
  queueIndex++; saveQueue(); renderQueue(); showStudent(key);
}
function showPrev() {
  if (queueIndex <= 0) { feedback(`ℹ️ ${t('pres.qStart', 'Already at the start')}`, 'info'); return; }
  queueIndex--; saveQueue(); renderQueue(); showStudent(queue[queueIndex]);
}

// ============================================
// RECENT (localStorage per event)
// ============================================
function rKey() { return `ashr_recent_${currentEventId}`; }
function loadRecentStorage() { try { recent = JSON.parse(localStorage.getItem(rKey()) || '[]'); } catch { recent = []; } }
function pushRecent(key) {
  recent = [key, ...recent.filter(k => k !== key)].slice(0, 10);
  localStorage.setItem(rKey(), JSON.stringify(recent));
  renderRecent();
}
function renderRecent() {
  const wrap = $('recentChips');
  wrap.innerHTML = '';
  if (!recent.length) { wrap.innerHTML = `<p class="hint">${t('pres.noRecent', 'Nothing shown yet.')}</p>`; return; }
  recent.forEach(key => {
    const h = honorees[key];
    const b = document.createElement('button');
    b.className = 'recent-chip';
    b.textContent = h ? (h.nameCn || h.nameEn) : key;
    b.onclick = () => showStudent(key);
    wrap.appendChild(b);
  });
}

// ============================================
// UI HELPERS
// ============================================
function updateNowBar() {
  const n = $('nowName');
  if (!presState || presState.mode === 'backdrop') {
    n.textContent = '🖼 ' + t('pres.backdropOnly', 'Backdrop only'); n.className = 'now-name m-backdrop';
  } else if (presState.mode === 'blank') {
    n.textContent = '⬛ ' + t('pres.blankScreen', 'Blank screen'); n.className = 'now-name m-blank';
  } else {
    const s = presState.student || {};
    n.textContent = `${s.nameCn || s.nameEn || ''} — ${s.centerName || ''}`;
    n.className = 'now-name m-student';
  }
  $('nowTime').textContent = presState?.updatedAt ? new Date(presState.updatedAt).toLocaleTimeString() : '';
}

function syncToggles() {
  if (!presState) return;
  syncingToggles = true;
  if (typeof presState.effects === 'boolean') {
    effectsOn = presState.effects; $('fxToggle').checked = effectsOn;
  }
  if (typeof presState.sound === 'boolean') {
    soundOn = presState.sound; $('soundToggle').checked = soundOn;
  }
  syncingToggles = false;
}

let fbTimer = null;
function feedback(html, type = 'info') {
  const el = $('presFeedback');
  el.innerHTML = html; el.className = `scan-feedback ${type}`;
  clearTimeout(fbTimer); fbTimer = setTimeout(() => { el.innerHTML = ''; }, 4500);
}

let toastTimer = null;
function showToast(msg, type = 'success') {
  const toast = $('toast');
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ============================================
// CONTROLS WIRING
// ============================================
function setupControls() {
  const input = $('presScan');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); processInput(input.value); }
    if (e.key === 'Escape') hideDrop();
  });
  input.addEventListener('input', () => renderSearchDrop(input.value));
  document.addEventListener('click', e => {
    if (!e.target.closest('#searchDrop') && e.target !== input) hideDrop();
  });

  $('nextBtn').onclick = showNext;
  $('prevBtn').onclick = showPrev;
  $('clearBtn').onclick = () => sendMode('backdrop');
  $('blankBtn').onclick = () => sendMode('blank');
  $('openDisplayBtn').onclick = () =>
    window.open(`ashr-display.html?e=${encodeURIComponent(currentEventId)}`, '_blank');

  $('fxToggle').addEventListener('change', async e => {
    effectsOn = e.target.checked;
    localStorage.setItem(`ashr_fx_${currentEventId}`, effectsOn ? '1' : '0');
    if (!syncingToggles) try { await update(presRef(), { effects: effectsOn }); } catch (err) { console.error(err); }
  });
  $('soundToggle').addEventListener('change', async e => {
    soundOn = e.target.checked;
    localStorage.setItem(`ashr_sound_${currentEventId}`, soundOn ? '1' : '0');
    if (soundOn) showToast(t('pres.soundHint', 'Reminder: click “🔊 Tap once to enable sound” on the display screen once.'), 'success');
    if (!syncingToggles) try { await update(presRef(), { sound: soundOn }); } catch (err) { console.error(err); }
  });

  $('qAddShownBtn').onclick = () => {
    if (presState?.mode === 'student' && presState.honoreeKey) addToQueue(presState.honoreeKey);
    else feedback(`ℹ️ ${t('pres.noOne', 'No student is on screen right now')}`, 'info');
  };
  $('qResetBtn').onclick = () => { queueIndex = 0; saveQueue(); renderQueue(); };
  $('qClearBtn').onclick = () => {
    if (!queue.length) return;
    if (confirm(t('pres.qClearConfirm', 'Clear the whole queue?'))) {
      queue = []; queueIndex = 0; saveQueue(); renderQueue();
    }
  };
  $('recentClearBtn').onclick = () => {
    recent = []; localStorage.setItem(rKey(), '[]'); renderRecent();
  };

  // Global shortcuts (when not typing in a field)
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); showNext(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); showPrev(); }
    else if (e.key === 'c' || e.key === 'C') sendMode('backdrop');
    else if (e.key === 'b' || e.key === 'B') sendMode('blank');
  });

  renderQueue(); renderRecent();
}

// ============================================
// EVENT SELECTOR (same pattern as ashr.js)
// ============================================
async function setupEventSelect() {
  const snap = await get(ref(db, 'ashrEvents'));
  const select = $('eventSelect');
  select.innerHTML = '';
  if (snap.exists()) {
    Object.keys(snap.val()).sort().reverse().forEach(eid => {
      const opt = document.createElement('option');
      opt.value = eid; opt.textContent = eid;
      if (eid === currentEventId) opt.selected = true;
      select.appendChild(opt);
    });
  }
  if (!select.options.length) {
    const opt = document.createElement('option');
    opt.value = currentEventId; opt.textContent = currentEventId;
    select.appendChild(opt);
  }
  select.onchange = e => switchEvent(e.target.value);
  $('newEventBtn').onclick = () => {
    const year = prompt('Enter event year/ID (e.g. 2027):');
    if (year && year.trim()) switchEvent(year.trim(), true);
  };
}

function switchEvent(id, isNew = false) {
  currentEventId = id;
  localStorage.setItem('ashr_eventId', id);
  if (isNew) {
    const sel = $('eventSelect');
    if (![...sel.options].some(o => o.value === id)) {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = id; sel.prepend(opt);
    }
    sel.value = id;
  }
  honoreesLoaded = false; presState = null;
  loadPrefs(); loadQueueStorage(); loadRecentStorage();
  $('fxToggle').checked = effectsOn; $('soundToggle').checked = soundOn;
  subscribe(id); renderQueue(); renderRecent(); updateNowBar();
  stage.apply({ mode: 'backdrop' });
}

function loadPrefs() {
  effectsOn = localStorage.getItem(`ashr_fx_${currentEventId}`) !== '0';
  soundOn = localStorage.getItem(`ashr_sound_${currentEventId}`) === '1';
}

// ============================================
// CAMERA SCANNER (same library/pattern as ashr.js)
// ============================================
function setupCamera() {
  $('camBtn').onclick = startCamera;
  $('closeCameraModal').onclick = stopCamera;
}

async function startCamera() {
  if (typeof Html5Qrcode === 'undefined') {
    showToast('Scanner library missing — check the html5-qrcode script tag', 'error'); return;
  }
  $('cameraModal').classList.remove('hidden');
  if (html5QrCode && html5QrCode.isScanning) { try { await html5QrCode.stop(); } catch (e) {} }
  try {
    if (!html5QrCode) {
      const opts = {};
      if (typeof Html5QrcodeSupportedFormats !== 'undefined') {
        opts.formatsToSupport = [
          Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.QR_CODE
        ];
      }
      html5QrCode = new Html5Qrcode('cameraReader', opts);
    }
    await new Promise(r => requestAnimationFrame(r));
    await html5QrCode.start(
      { facingMode: 'environment' },
      {
        fps: 15,
        qrbox: (vw, vh) => ({
          width: Math.floor(Math.min(vw * 0.85, 420)),
          height: Math.floor(Math.min(vw * 0.85 * 0.45, vh * 0.55))
        }),
        videoConstraints: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      },
      (decodedText) => { stopCamera(); $('presScan').value = decodedText; processInput(decodedText); },
      () => {}
    );
  } catch (err) {
    console.error('Camera start failed:', err);
    showToast(`${t('toast.cameraErr', 'Camera error')}: ${err.message || err}`, 'error');
    $('cameraModal').classList.add('hidden');
  }
}

async function stopCamera() {
  $('cameraModal').classList.add('hidden');
  if (html5QrCode) { try { if (html5QrCode.isScanning) await html5QrCode.stop(); } catch (e) {} }
}

window.addEventListener('beforeunload', () => {
  unsubs.forEach(fn => fn());
  if (html5QrCode && html5QrCode.isScanning) html5QrCode.stop().catch(() => {});
});