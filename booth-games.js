// ============================================================
// BOOTH GAMES — ADMIN
// Dashboard · Registrations · Builder · Share/QR · Check-in
// Seat-count integrity · School field · Multi-day events
// ============================================================
import { auth, db } from './auth.js';
import { ref, get, update, remove, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
GRADES, GRADE_CN, gradeIdx, gradeBand, gradeLabel, gradeInRange, rangeLabel,
INTERESTS, interestLabel, normalizeInterests, GAME_EMOJIS, PALETTE, BANNERS, bannerCss, bannerStops,
escapeHtml, randomCode, uid, localDateStr, calcAge, fmtDate, fmtDateShort, slotLabel, slotFullLabel,
validPhone, normalizePhone, slotsOverlap,
windowState, timeAgo, slugify, copyText, downloadDataUrl, loadImg,
renderQrCanvas, wrapLines, rr,
normalizeEventConfig, normalizeGames, eventRangeLabel, venueLines
} from './booth-shared.js';

const $ = id => document.getElementById(id);

// ============================================
// STATE
// ============================================
let eventsIndex = {};
let currentEventId = localStorage.getItem('booth_eventId') || '';
let creatingNew = false;
let config = {}, games = {}, counts = {}, regs = {};
let loaded = { config:false, games:false, counts:false, regs:false };
let unsubs = [];
let charts = {};
let drafts = {};
let selected = new Set();
let lastVisible = [];
let drawerRegId = null;
let staticBound = false;
let reconcileRunning = false;
let autoReconcileTimer = null;

const draftKey = () => creatingNew ? '__new' : currentEventId;

// ============================================
// INIT
// ============================================
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'index.html'; return; }
  try { await refreshEventList(); } catch (err) { console.error(err); }
  if (!staticBound) { setupStatic(); staticBound = true; }
  applyMode();
  if (currentEventId && !creatingNew) subscribeEvent(currentEventId);
  renderAll();
  $('page-loader').classList.add('hidden');
  $('mainContent').classList.remove('hidden');
});

async function refreshEventList() {
  const snap = await get(ref(db, 'boothIndex'));
  eventsIndex = snap.val() || {};
  const ids = Object.keys(eventsIndex).sort((a, b) =>
    String(eventsIndex[b].createdAt || '').localeCompare(String(eventsIndex[a].createdAt || '')));
  const sel = $('eventSelect');
  sel.innerHTML = '';
  ids.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = eventsIndex[id].title || eventsIndex[id].titleCn || id;
    sel.appendChild(opt);
  });
  if (!ids.includes(currentEventId)) currentEventId = ids[0] || '';
  if (currentEventId) { localStorage.setItem('booth_eventId', currentEventId); sel.value = currentEventId; }
}

function subscribeEvent(id) {
  unsubs.forEach(fn => fn()); unsubs = [];
  if (autoReconcileTimer) { clearTimeout(autoReconcileTimer); autoReconcileTimer = null; }
  config = {}; games = {}; counts = {}; regs = {};
  loaded = { config:false, games:false, counts:false, regs:false };
  selected.clear();
  const base = `boothEvents/${id}`;
  const sub = (path, fn) => {
    const un = onValue(ref(db, path), s => { fn(s.val() || {}); renderAll(); },
      err => console.error(`Listener error on ${path}:`, err));
    unsubs.push(un);
  };
  sub(`${base}/config`, v => {
    config = normalizeEventConfig(v);
    games = normalizeGames(games, config);
    loaded.config = true;
  });
  sub(`${base}/games`, v => { games = normalizeGames(v, config); loaded.games = true; });
  sub(`${base}/counts`, v => { counts = v; loaded.counts = true; });
  sub(`${base}/registrations`, v => { regs = v; loaded.regs = true; });

  autoReconcileTimer = setTimeout(() => {
    autoReconcileTimer = null;
    ensureSeqNumbers({ silent:true });
    reconcileCounts({ silent:true });
  }, 2500);
}

// ============================================
// MODE / TABS
// ============================================
function activeTab() {
  const b = document.querySelector('.tab-btn.active');
  return b ? b.dataset.tab : 'dashboard';
}

function applyMode() {
  const hasEvents = Object.keys(eventsIndex).length > 0;
  const sel = $('eventSelect');
  let temp = sel.querySelector('option[value="__new"]');
  if (creatingNew) {
    if (!temp) { temp = document.createElement('option'); temp.value = '__new'; temp.textContent = '✏️ New event (draft)'; sel.appendChild(temp); }
    sel.value = '__new';
  } else if (temp) temp.remove();

  $('emptyState').classList.toggle('hidden', hasEvents || creatingNew);
  $('tabsBar').classList.toggle('hidden', !hasEvents && !creatingNew);
  sel.classList.toggle('hidden', !hasEvents && !creatingNew);
  $('dupEventBtn').classList.toggle('hidden', creatingNew || !currentEventId);
  $('delEventBtn').classList.toggle('hidden', creatingNew || !currentEventId);

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('hidden', creatingNew && b.dataset.tab !== 'builder'));
  if (!hasEvents && !creatingNew) {
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  } else if (creatingNew) {
    switchTab('builder', true);
  } else if (!document.querySelector('.tab-content.active')) {
    switchTab('dashboard', true);
  }
  updateEventBar();
}

function switchTab(name, silent = false) {
  if (creatingNew && name !== 'builder') name = 'builder';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  $(`tab-${name}`).classList.add('active');
  if (!silent) renderAll();
}

function updateEventBar() {
  const badge = $('windowBadge');
  if (creatingNew) { badge.textContent = '● New draft 新草稿'; badge.className = 'event-status pending'; return; }
  if (!currentEventId || !loaded.config) { badge.textContent = ''; badge.className = 'event-status hidden'; return; }
  const ws = windowState(config);
  badge.classList.remove('hidden');
  if (ws.state === 'open') { badge.textContent = `● Open 報名中${ws.daysLeft != null ? ` · ${ws.daysLeft}d left` : ''}`; badge.className = 'event-status active'; }
  else if (ws.state === 'before') { badge.textContent = `● Opens ${fmtDate(config.regStart, false)}`; badge.className = 'event-status pending'; }
  else if (ws.state === 'paused') { badge.textContent = '● Paused 暫停'; badge.className = 'event-status pending'; }
  else { badge.textContent = '● Closed 已結束'; badge.className = 'event-status inactive'; }
}

function renderAll() {
  updateEventBar();
  refreshPickers();
  if (!currentEventId && !creatingNew) return;
  const t = activeTab();
  if (t === 'dashboard') renderDashboard();
  else if (t === 'regs') renderRegs();
  else if (t === 'builder') renderBuilder(false);
  else if (t === 'share') renderShare();
  else if (t === 'checkin') renderCheckin();
}

// ============================================
// STATIC BINDINGS
// ============================================
function setupStatic() {
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  $('eventSelect').addEventListener('change', e => {
    if (e.target.value === '__new') return;
    creatingNew = false;
    currentEventId = e.target.value;
    localStorage.setItem('booth_eventId', currentEventId);
    subscribeEvent(currentEventId);
    applyMode(); renderAll();
  });

  $('newEventBtn').addEventListener('click', startNewEvent);
  $('emptyCreateBtn').addEventListener('click', startNewEvent);
  $('demoBtn').addEventListener('click', createDemoEvent);
  $('emptyDemoBtn').addEventListener('click', createDemoEvent);
  $('dupEventBtn').addEventListener('click', duplicateEvent);
  $('delEventBtn').addEventListener('click', deleteEvent);

  const bind = (id, fn) => $(id).addEventListener('input', () => {
    const d = drafts[draftKey()]; if (!d) return;
    fn(d, $(id)); d.dirty = true; $('draftChip').classList.remove('hidden');
  });
  bind('bTitle',    (d, el) => { d.config.title = el.value; renderBannerPreview(d); });
  bind('bTitleCn',  (d, el) => { d.config.titleCn = el.value; renderBannerPreview(d); });
  bind('bDesc',     (d, el) => { d.config.description = el.value; });
  bind('bEventStart', (d, el) => {
    d.config.eventStart = el.value;
    if (!d.config.eventEnd || d.config.eventEnd < el.value) {
      d.config.eventEnd = el.value;
      $('bEventEnd').value = el.value;
    }
  });
  bind('bEventEnd', (d, el) => { d.config.eventEnd = el.value; });
  bind('bTimeText', (d, el) => { d.config.timeText = el.value; });
  bind('bVenueEn',  (d, el) => { d.config.venueEn = el.value; });
  bind('bVenueCn',  (d, el) => { d.config.venueCn = el.value; });
  bind('bRegStart', (d, el) => { d.config.regStart = el.value; });
  bind('bRegEnd',   (d, el) => { d.config.regEnd = el.value; });
  bind('bActive',   (d, el) => { d.config.isActive = el.value === 'true'; });

  $('bannerFile').addEventListener('change', handleBannerUpload);
  $('bannerRemove').addEventListener('click', () => {
    const d = drafts[draftKey()]; if (!d) return;
    d.config.bannerDataUrl = null; d.dirty = true;
    $('draftChip').classList.remove('hidden');
    $('bannerFile').value = '';
    renderPresetRow(d); renderBannerPreview(d);
  });
  $('addGameBtn').addEventListener('click', () => {
    const d = drafts[draftKey()]; if (!d) return;
    const n = Object.keys(d.games).length;
    d.games[uid('g')] = {
      name:'', nameCn:'', emoji:GAME_EMOJIS[n % GAME_EMOJIS.length],
      minGrade:'K0', maxGrade:'F6', color:PALETTE[n % PALETTE.length],
      slots:{ [uid('s')]:{ date:d.config.eventStart || localDateStr(), start:'14:00', end:'14:20', capacity:10 } }
    };
    d.dirty = true; $('draftChip').classList.remove('hidden');
    renderGamesEditor(d);
  });
  $('saveEventBtn').addEventListener('click', saveEvent);
  $('cancelDraftBtn').addEventListener('click', cancelDraft);

  ['regSearch','regGameFilter','regBandFilter','regCurrentFilter','regStatusFilter','regSort'].forEach(id => {
    $(id).addEventListener('input', () => { persistFilters(); renderRegs(); });
  });
  $('regClearFilters').addEventListener('click', () => {
    $('regSearch').value = ''; $('regGameFilter').value = ''; $('regBandFilter').value = '';
    $('regCurrentFilter').value = ''; $('regStatusFilter').value = ''; $('regSort').value = 'newest';
    persistFilters(); renderRegs();
  });
  $('exportRegsBtn').addEventListener('click', () => exportExcel());
  $('checkAll').addEventListener('change', e => {
    if (e.target.checked) lastVisible.forEach(id => selected.add(id));
    else selected.clear();
    renderRegs();
  });
  $('bulkAttendBtn').addEventListener('click', () => markAttended([...selected]));
  $('bulkDeleteBtn').addEventListener('click', () => {
    if (!selected.size) return;
    if (confirm(`Delete ${selected.size} registration(s)? You can undo right after. 刪除後可即時復原。`)) deleteRegs([...selected]);
  });
  $('bulkExportBtn').addEventListener('click', () => exportExcel([...selected]));
  $('bulkClearBtn').addEventListener('click', () => { selected.clear(); renderRegs(); });

  $('copyLinkBtn').addEventListener('click', async () => { await copyText(publicUrl()); showToast('📋 Link copied! 已複製連結', 'success'); });
  $('waShareBtn').addEventListener('click', () => window.open(`https://wa.me/?text=${encodeURIComponent(shareMessage())}`, '_blank'));
  $('openLinkBtn').addEventListener('click', () => window.open(publicUrl(), '_blank'));
  $('applyCodeBtn').addEventListener('click', () => applyCustomCode($('customCode').value));
  $('regenCodeBtn').addEventListener('click', regenerateCode);
  $('activeToggle').addEventListener('change', async e => {
    if (!currentEventId) return;
    const val = e.target.checked;
    config.isActive = val; renderAll();
    try {
      await update(ref(db), {
        [`boothEvents/${currentEventId}/config/isActive`]: val,
        [`boothIndex/${currentEventId}/isActive`]: val
      });
      showToast(val ? '▶ Registration resumed 已恢復報名' : '⏸ Registration paused 已暫停報名', 'success');
    } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
  });
  $('dlQrBtn').addEventListener('click', downloadQr);
  $('dlPosterBtn').addEventListener('click', downloadPoster);

  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerScrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (closeTopModal()) return; closeDrawer(); } });
  $('drawerAttendBtn').addEventListener('click', () => {
    if (!drawerRegId) return;
    toggleAttend(drawerRegId);
    setTimeout(() => { if (drawerRegId) fillDrawer(drawerRegId); }, 60);
  });
  $('drawerDeleteBtn').addEventListener('click', () => {
    if (!drawerRegId) return;
    if (confirm('Delete this registration? You can undo right after. 刪除後可即時復原。')) { deleteRegs([drawerRegId]); closeDrawer(); }
  });

  restoreFilters();
}

function startNewEvent() {
  creatingNew = true;
  if (!drafts.__new) drafts.__new = defaultDraft();
  applyMode();
  switchTab('builder', true);
  renderBuilder(true);
}

// ============================================
// DASHBOARD
// ============================================
function statCard(icon, value, label, color) {
  return `<div class="stat-card" style="--sc:${color}"><div class="stat-icon">${icon}</div><div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div></div>`;
}

function renderDashboard() {
  if (creatingNew) return;
  const list = Object.values(regs);
  const total = list.length;
  const attended = list.filter(r => r.status === 'attended').length;
  const current = list.filter(r => r.isCurrentStudent === 'yes').length;
  const ages = list.map(r => Number(r.ageYears)).filter(n => !isNaN(n));
  const avgAge = ages.length ? (ages.reduce((a, b) => a + b, 0) / ages.length).toFixed(1) : '—';
  let cap = 0, booked = 0;
  Object.entries(games).forEach(([gid, g]) => Object.entries(g.slots || {}).forEach(([sid, s]) => {
    cap += Number(s.capacity) || 0; booked += Number(counts[gid]?.[sid]) || 0;
  }));
  const fill = cap ? Math.round(booked / cap * 100) + '%' : '—';

  $('dashStats').innerHTML =
    statCard('📝', total, 'Registrations 報名總數', PALETTE[0]) +
    statCard('✅', attended, 'Attended 已出席', PALETTE[3]) +
    statCard('🎓', current, 'Current students 現有學生', PALETTE[5]) +
    statCard('🌱', total - current, 'Prospects 新客戶', PALETTE[4]) +
    statCard('🎂', avgAge, 'Average age 平均年齡', PALETTE[2]) +
    statCard('🎟️', fill, 'Seats filled 名額使用率', PALETTE[1]);

  renderCharts(list);
  renderOccupancy();
  renderRecent(list);
}

function makeChart(key, cfg) {
  const el = $(key);
  if (!el || typeof Chart === 'undefined') return;
  if (charts[key]) charts[key].destroy();
  charts[key] = new Chart(el.getContext('2d'), cfg);
}

function renderCharts(list) {
  const baseOpts = { responsive:true, maintainAspectRatio:false, animation:{ duration:450 }, plugins:{ legend:{ display:false } } };
  const axis = { ticks:{ color:'#5b6b84', font:{ family:'Nunito', weight:'700', size:11 } }, grid:{ color:'rgba(47,111,178,.08)' } };

  const dayCount = {};
  list.forEach(r => { const d = localDateStr(new Date(r.submittedAt || Date.now())); dayCount[d] = (dayCount[d] || 0) + 1; });
  let start = config.regStart || localDateStr();
  const subDays = Object.keys(dayCount).sort();
  if (subDays.length && subDays[0] < start) start = subDays[0];
  const days = [];
  const d0 = new Date(start + 'T00:00:00');
  const today = new Date(localDateStr() + 'T00:00:00');
  for (let d = new Date(d0); d <= today && days.length < 31; d.setDate(d.getDate() + 1)) days.push(localDateStr(d));
  if (!days.length) days.push(localDateStr());
  makeChart('chTimeline', {
    type:'bar',
    data:{ labels:days.map(d => fmtDate(d, false).replace(/ \d{4}$/, '')),
      datasets:[{ data:days.map(d => dayCount[d] || 0), backgroundColor:days.map(d => d === localDateStr() ? PALETTE[2] : PALETTE[0]), borderRadius:6, maxBarThickness:34 }] },
    options:{ ...baseOpts, scales:{ x:axis, y:{ ...axis, beginAtZero:true, ticks:{ ...axis.ticks, precision:0 } } } }
  });

  const bandColor = { K:PALETTE[2], P:PALETTE[0], F:PALETTE[4] };
  makeChart('chGrades', {
    type:'bar',
    data:{ labels:GRADES, datasets:[{ data:GRADES.map(g => list.filter(r => r.grade === g).length), backgroundColor:GRADES.map(g => bandColor[g[0]]), borderRadius:5 }] },
    options:{ ...baseOpts, scales:{ x:axis, y:{ ...axis, beginAtZero:true, ticks:{ ...axis.ticks, precision:0 } } } }
  });

  const gEntries = Object.entries(games);
  makeChart('chGames', {
    type:'doughnut',
    data:{ labels:gEntries.map(([, g]) => `${g.emoji || '🎮'} ${g.name || g.nameCn || 'Game'}`),
      datasets:[{ data:gEntries.map(([gid]) => list.filter(r => (r.selections || []).some(s => s.gameId === gid)).length),
        backgroundColor:gEntries.map(([, g], i) => g.color || PALETTE[i % PALETTE.length]), borderWidth:2, borderColor:'#fff' }] },
    options:{ ...baseOpts, cutout:'56%', plugins:{ legend:{ display:true, position:'right', labels:{ color:'#3b4a63', font:{ family:'Nunito', weight:'700', size:11 }, boxWidth:14 } } } }
  });

  makeChart('chInterests', {
    type:'bar',
    data:{ labels:INTERESTS.map(o => o.cn),
      datasets:[{ data:INTERESTS.map(o => list.filter(r => normalizeInterests(r.interests).includes(o.id)).length), backgroundColor:INTERESTS.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius:5 }] },  
    options:{ ...baseOpts, indexAxis:'y', scales:{ x:{ ...axis, beginAtZero:true, ticks:{ ...axis.ticks, precision:0 } }, y:axis } }
  });

  const wcOnly = list.filter(r => r.contactApps?.wechat && !r.contactApps?.whatsapp).length;
  const waOnly = list.filter(r => r.contactApps?.whatsapp && !r.contactApps?.wechat).length;
  const both = list.filter(r => r.contactApps?.wechat && r.contactApps?.whatsapp).length;
  makeChart('chApps', {
    type:'doughnut',
    data:{ labels:['WeChat only 微信', 'WhatsApp only', 'Both 兩者'], datasets:[{ data:[wcOnly, waOnly, both], backgroundColor:[PALETTE[3], PALETTE[0], PALETTE[2]], borderWidth:2, borderColor:'#fff' }] },
    options:{ ...baseOpts, cutout:'56%', plugins:{ legend:{ display:true, position:'right', labels:{ color:'#3b4a63', font:{ family:'Nunito', weight:'700', size:11 }, boxWidth:14 } } } }
  });
}

function renderRecent(list) {
  const wrap = $('recentList');
  const top = [...list].sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''))).slice(0, 5);
  if (!top.length) { wrap.innerHTML = '<p class="hint">Nothing yet — share the link! 分享連結後即會顯示。</p>'; return; }
  wrap.innerHTML = top.map(r => {
    const emojis = (r.selections || []).map(s => games[s.gameId]?.emoji || '🎮').join(' ');
    return `<div class="recent-row"><span class="recent-name">${escapeHtml(r.studentName || '')}</span><span class="grade-chip band-${gradeBand(r.grade)}">${escapeHtml(r.grade || '')}</span><span>${emojis}</span><span class="recent-time">${escapeHtml(timeAgo(r.submittedAt))}</span></div>`;
  }).join('');
}

// ============================================
// REGISTRATIONS TABLE
// ============================================
function persistFilters() {
  try {
    localStorage.setItem('booth_regs_filters', JSON.stringify({
      game:$('regGameFilter').value, band:$('regBandFilter').value,
      current:$('regCurrentFilter').value, status:$('regStatusFilter').value, sort:$('regSort').value
    }));
  } catch {}
}
function restoreFilters() {
  try {
    const f = JSON.parse(localStorage.getItem('booth_regs_filters') || '{}');
    if (f.band) $('regBandFilter').value = f.band;
    if (f.current) $('regCurrentFilter').value = f.current;
    if (f.status) $('regStatusFilter').value = f.status;
    if (f.sort) $('regSort').value = f.sort;
  } catch {}
}

function filteredRegs() {
  const q = ($('regSearch').value || '').trim().toLowerCase();
  const gf = $('regGameFilter').value, bf = $('regBandFilter').value;
  const cf = $('regCurrentFilter').value, sf = $('regStatusFilter').value;
  const sort = $('regSort').value;
  let entries = Object.entries(regs).filter(([, r]) => {
    if (gf && !(r.selections || []).some(s => s.gameId === gf)) return false;
    if (bf && gradeBand(r.grade) !== bf) return false;
    if (cf && (r.isCurrentStudent || 'no') !== cf) return false;
    if (sf && (r.status || 'registered') !== sf) return false;
    if (q) {
      const hay = [regIdLabel(r.seq), r.studentName, r.school, r.parentPhone, r.currentCenter, r.code, r.wechatId].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const cmp = {
    newest:(a, b) => String(b[1].submittedAt || '').localeCompare(String(a[1].submittedAt || '')),
    oldest:(a, b) => String(a[1].submittedAt || '').localeCompare(String(b[1].submittedAt || '')),
    id:(a, b) => (Number(a[1].seq) || 0) - (Number(b[1].seq) || 0),
    name:(a, b) => String(a[1].studentName || '').localeCompare(String(b[1].studentName || ''), 'zh-Hant'),
    grade:(a, b) => gradeIdx(a[1].grade) - gradeIdx(b[1].grade),
    age:(a, b) => (Number(a[1].ageYears) || 0) - (Number(b[1].ageYears) || 0)
  }[sort] || (() => 0);
  return entries.sort(cmp);
}

function renderRegs() {
  if (creatingNew) return;
  const gfSel = $('regGameFilter');
  const keep = gfSel.value;
  gfSel.innerHTML = '<option value="">All games 全部遊戲</option>' +
    Object.entries(games).map(([gid, g]) => `<option value="${escapeHtml(gid)}">${g.emoji || '🎮'} ${escapeHtml(g.name || g.nameCn || gid)}</option>`).join('');
  gfSel.value = Object.keys(games).includes(keep) ? keep : '';

  const entries = filteredRegs();
  lastVisible = entries.map(([id]) => id);
  [...selected].forEach(id => { if (!regs[id]) selected.delete(id); });

  const tbody = $('regTableBody');
  tbody.innerHTML = '';
  entries.forEach(([id, r], i) => {
    const status = r.status || 'registered';
    const apps = [
      r.contactApps?.wechat ? '<span class="app-badge app-wechat">💬 WeChat</span>' : '',
      r.contactApps?.whatsapp ? '<span class="app-badge app-whatsapp">📱 WhatsApp</span>' : ''
    ].join('');
    const kumon = r.isCurrentStudent === 'yes'
      ? `<div>${escapeHtml(r.currentCenter || '—')}</div><div class="cell-sub">${escapeHtml(r.currentSubjects || '')}</div>`
      : '<span class="prospect-chip">🌱 Prospect 新客戶</span>';
    const chips = (r.selections || []).map(s => {
      const g = games[s.gameId];
      const day = s.date ? fmtDateShort(s.date) + ' ' : '';
      return `<span class="game-chip" style="--gc:${g?.color || PALETTE[0]}">${g?.emoji || '🎮'} ${day}${escapeHtml(s.start || '')}</span>`;
    }).join('');
    const schoolLine = r.school ? `<div class="cell-sub">🏫 ${escapeHtml(r.school)}</div>` : '';
    const tr = document.createElement('tr');
    if (selected.has(id)) tr.classList.add('row-selected');
    tr.innerHTML =
      `<td class="col-check"><input type="checkbox" class="row-check" data-id="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''}></td>` +
      `<td class="row-num" style="width:56px;font-family:'Courier New',monospace;font-weight:800;color:#245a94;">${escapeHtml(regIdLabel(r.seq))}</td>` +
      `<td><div class="cell-name">${escapeHtml(r.studentName || '')}</div><span class="grade-chip band-${gradeBand(r.grade)}">${escapeHtml(r.grade || '')}</span> <span class="cell-sub">${r.ageYears != null ? r.ageYears + 'y' : ''}</span>${schoolLine}</td>` +
      `<td><div>${escapeHtml(r.parentPhone || '')}</div>${apps}</td>` +
      `<td>${kumon}</td>` +
      `<td>${chips || '—'}</td>` +
      `<td class="cell-sub">${r.submittedAt ? new Date(r.submittedAt).toLocaleDateString('en-GB') : '—'}</td>` +
      `<td><span class="status-badge st-${status}">${status === 'attended' ? '✅ Attended' : '📝 Registered'}</span></td>` +
      `<td><div class="row-actions"><button class="btn-small primary" data-act="view" data-id="${escapeHtml(id)}">👁</button><button class="btn-small secondary" data-act="attend" data-id="${escapeHtml(id)}">${status === 'attended' ? '↩' : '✓'}</button><button class="btn-small danger" data-act="del" data-id="${escapeHtml(id)}">🗑</button></div></td>`;
    tr.addEventListener('click', e => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      openDrawer(id);
    });
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.row-check').forEach(ch => ch.addEventListener('change', () => {
    if (ch.checked) selected.add(ch.dataset.id); else selected.delete(ch.dataset.id);
    renderRegs();
  }));
  tbody.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.id;
    if (btn.dataset.act === 'view') openDrawer(id);
    else if (btn.dataset.act === 'attend') toggleAttend(id);
    else if (btn.dataset.act === 'del') {
      if (confirm('Delete this registration? You can undo right after. 刪除後可即時復原。')) deleteRegs([id]);
    }
  }));

  $('regsEmpty').classList.toggle('hidden', entries.length > 0);
  $('regCount').textContent = `${entries.length} of ${Object.keys(regs).length} registrations 筆報名`;
  $('bulkBar').classList.toggle('hidden', selected.size === 0);
  $('bulkCount').textContent = `${selected.size} selected 已選`;
  const all = $('checkAll');
  all.checked = lastVisible.length > 0 && lastVisible.every(id => selected.has(id));
  all.indeterminate = selected.size > 0 && !all.checked;
}

async function toggleAttend(id) {
  const r = regs[id]; if (!r) return;
  const to = r.status === 'attended' ? 'registered' : 'attended';
  const attendedAt = to === 'attended' ? new Date().toISOString() : null;
  r.status = to; r.attendedAt = attendedAt;
  renderAll();
  try {
    await update(ref(db, `boothEvents/${currentEventId}/registrations/${id}`), { status:to, attendedAt });
    showToast(to === 'attended' ? '✅ Checked in! 已報到' : '↩ Check-in undone 已取消報到', 'success');
  } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

async function markAttended(ids) {
  if (!ids.length) return;
  const now = new Date().toISOString();
  const updates = {};
  ids.forEach(id => {
    if (!regs[id]) return;
    regs[id].status = 'attended'; regs[id].attendedAt = now;
    updates[`boothEvents/${currentEventId}/registrations/${id}/status`] = 'attended';
    updates[`boothEvents/${currentEventId}/registrations/${id}/attendedAt`] = now;
  });
  selected.clear(); renderAll();
  try { await update(ref(db), updates); showToast(`✅ ${ids.length} marked attended 已標記出席`, 'success'); }
  catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

// ============================================
// REGISTRATION ID NUMBERS (001–999, never reused)
// ============================================
function regIdLabel(seq) {
  const n = Number(seq);
  return (n >= 1 && n <= 999) ? String(n).padStart(3, '0') : '—';
}

let seqRunning = false;

async function ensureSeqNumbers({ silent = true } = {}) {
  if (!currentEventId || creatingNew || seqRunning) return;
  seqRunning = true;
  const eid = currentEventId;
  try {
    const [regsSnap, seqSnap] = await Promise.all([
      get(ref(db, `boothEvents/${eid}/registrations`)),
      get(ref(db, `boothEvents/${eid}/seq`))
    ]);
    const all = regsSnap.val() || {};
    let highest = Number(seqSnap.val()) || 0;
    Object.values(all).forEach(r => { highest = Math.max(highest, Number(r.seq) || 0); });

    const missing = Object.entries(all)
      .filter(([, r]) => !Number(r.seq))
      .sort((a, b) => String(a[1].submittedAt || '').localeCompare(String(b[1].submittedAt || '')));

    let n = highest;
    const updates = {};
    for (const [rid] of missing) {
      if (n >= 999) break;
      n += 1;
      updates[`boothEvents/${eid}/registrations/${rid}/seq`] = n;
    }
    if (Object.keys(updates).length) await update(ref(db), updates);

    if (n > (Number(seqSnap.val()) || 0)) {
      await runTransaction(ref(db, `boothEvents/${eid}/seq`),
        cur => Math.max(Number(cur) || 0, n), { applyLocally:false });
    }

    if (eid === currentEventId && Object.keys(updates).length) {
      Object.entries(updates).forEach(([path, val]) => {
        const m = path.match(/registrations\/([^/]+)\/seq$/);
        if (m && regs[m[1]]) regs[m[1]].seq = val;
      });
      renderAll();
    }
    if (!silent) showToast(`🔢 ID numbers up to date 編號已更新`, 'success');
  } catch (err) {
    if (!silent) showToast(`Error: ${err.message}`, 'error');
    else console.error('ID backfill failed:', err);
  } finally { seqRunning = false; }
}

// ============================================
// SEAT COUNT INTEGRITY
// ============================================
function selectionsOf(list) {
  const out = [];
  (list || []).forEach(r => (r?.selections || []).forEach(s => {
    if (s && s.gameId && s.slotId) out.push({ gid:s.gameId, sid:s.slotId });
  }));
  return out;
}

function expectedCountsFrom(sourceRegs, sourceGames) {
  const exp = {};
  Object.entries(sourceGames || {}).forEach(([gid, g]) => {
    exp[gid] = {};
    Object.keys((g && g.slots) || {}).forEach(sid => { exp[gid][sid] = 0; });
  });
  Object.values(sourceRegs || {}).forEach(r => {
    ((r && r.selections) || []).forEach(s => {
      if (s && exp[s.gameId] && exp[s.gameId][s.slotId] !== undefined) exp[s.gameId][s.slotId] += 1;
    });
  });
  return exp;
}

function countsDrift() {
  const exp = expectedCountsFrom(regs, games);
  const diffs = [];
  Object.entries(exp).forEach(([gid, slots]) => {
    Object.entries(slots).forEach(([sid, n]) => {
      const actual = Number(counts[gid]?.[sid]) || 0;
      if (actual !== n) diffs.push({ gid, sid, actual, expected:n });
    });
  });
  Object.keys(counts).forEach(gid => {
    Object.keys(counts[gid] || {}).forEach(sid => {
      if (!exp[gid] || exp[gid][sid] === undefined) {
        const actual = Number(counts[gid][sid]) || 0;
        if (actual !== 0) diffs.push({ gid, sid, actual, expected:0 });
      }
    });
  });
  return diffs;
}

function applyLocalCount(gid, sid, delta) {
  counts[gid] = counts[gid] || {};
  const next = Math.max(0, (Number(counts[gid][sid]) || 0) + delta);
  if (next === 0) delete counts[gid][sid]; else counts[gid][sid] = next;
  if (!Object.keys(counts[gid]).length) delete counts[gid];
}

async function bumpSlotCount(eid, gid, sid, delta) {
  await runTransaction(
    ref(db, `boothEvents/${eid}/counts/${gid}/${sid}`),
    cur => Math.max(0, (Number(cur) || 0) + delta),
    { applyLocally:false }
  );
}

async function reconcileCounts({ silent = true } = {}) {
  if (!currentEventId || creatingNew || reconcileRunning) return;
  reconcileRunning = true;
  const eid = currentEventId;
  const btn = $('rebuildCountsBtn');
  if (btn && !silent) { btn.disabled = true; btn.textContent = '⏳ Rebuilding…'; }
  try {
    const [regsSnap, gamesSnap, countsSnap] = await Promise.all([
      get(ref(db, `boothEvents/${eid}/registrations`)),
      get(ref(db, `boothEvents/${eid}/games`)),
      get(ref(db, `boothEvents/${eid}/counts`))
    ]);
    const freshGames = normalizeGames(gamesSnap.val() || {}, config);
    const exp = expectedCountsFrom(regsSnap.val() || {}, freshGames);
    const actual = countsSnap.val() || {};
    const updates = {};
    Object.entries(exp).forEach(([gid, slots]) => {
      Object.entries(slots).forEach(([sid, n]) => {
        if ((Number(actual[gid]?.[sid]) || 0) !== n) updates[`boothEvents/${eid}/counts/${gid}/${sid}`] = n;
      });
    });
    Object.keys(actual).forEach(gid => {
      if (!exp[gid]) { updates[`boothEvents/${eid}/counts/${gid}`] = null; return; }
      Object.keys(actual[gid] || {}).forEach(sid => {
        if (exp[gid][sid] === undefined) updates[`boothEvents/${eid}/counts/${gid}/${sid}`] = null;
      });
    });
    const changed = Object.keys(updates).length;
    if (changed) {
      await update(ref(db), updates);
      if (eid === currentEventId) {
        const local = {};
        Object.entries(exp).forEach(([gid, slots]) => {
          Object.entries(slots).forEach(([sid, v]) => {
            if (v > 0) { local[gid] = local[gid] || {}; local[gid][sid] = v; }
          });
        });
        counts = local;
        renderAll();
      }
    }
    if (!silent) showToast(changed ? `🔧 Seat counts rebuilt — ${changed} slot(s) corrected 已重算名額` : '✅ Seat counts already correct 名額正確', 'success');
  } catch (err) {
    if (!silent) showToast(`Error: ${err.message}`, 'error');
    else console.error('Seat count reconcile failed:', err);
  } finally {
    reconcileRunning = false;
    if (btn && !silent) { btn.disabled = false; btn.textContent = '🔧 Rebuild seat counts 重算名額'; }
  }
}

function renderOccupancy() {
  const wrap = $('slotOccupancy');
  const warn = $('countsSyncWarn');
  const entries = Object.entries(games);
  if (!entries.length) {
    wrap.innerHTML = '<p class="hint">No games yet — add them in Form & Games. 請先新增遊戲。</p>';
    if (warn) warn.classList.add('hidden');
    return;
  }
  const exp = expectedCountsFrom(regs, games);
  const drift = countsDrift();
  if (warn) {
    warn.classList.toggle('hidden', drift.length === 0);
    if (drift.length) warn.textContent = `⚠️ ${drift.length} slot count(s) do not match the registration records. Press “Rebuild seat counts”. 名額與報名紀錄不一致，請按「重算名額」。`;
  }
  wrap.innerHTML = entries.map(([gid, g]) => {
    const slots = Object.entries(g.slots || {}).sort((a, b) =>
      String(a[1].date || '').localeCompare(String(b[1].date || '')) || String(a[1].start).localeCompare(String(b[1].start)));
    const rows = slots.map(([sid, s]) => {
      const b = Number(counts[gid]?.[sid]) || 0;
      const truth = (exp[gid] && exp[gid][sid] !== undefined) ? exp[gid][sid] : 0;
      const cap = Number(s.capacity) || 0;
      const pct = cap ? Math.min(100, Math.round(b / cap * 100)) : 0;
      const full = cap > 0 && b >= cap;
      const fix = b !== truth ? `<span class="occ-fix" title="Should be ${truth} 應為 ${truth}">→ ${truth}</span>` : '';
      return `<div class="occ-row"><span class="occ-time">${escapeHtml(fmtDateShort(s.date))} · ${escapeHtml(slotLabel(s))}</span><div class="occ-bar"><div class="occ-fill" style="--oc:${g.color || PALETTE[0]};width:${pct}%"></div></div><span class="occ-num">${b} / ${cap}${fix}</span><span class="status-badge ${full ? 'st-full' : 'st-open'}">${full ? 'FULL 額滿' : 'OPEN'}</span></div>`;
    }).join('');
    return `<div class="occ-game"><div class="occ-game-head"><span>${g.emoji || '🎮'}</span><span>${escapeHtml(g.name || '')} ${escapeHtml(g.nameCn || '')}</span><span class="range-chip">${escapeHtml(rangeLabel(g.minGrade, g.maxGrade))}</span></div>${rows || '<p class="hint">No slots.</p>'}</div>`;
  }).join('');
}

async function deleteRegs(ids) {
  const stash = ids.filter(id => regs[id]).map(id => ({ id, data:JSON.parse(JSON.stringify(regs[id])) }));
  if (!stash.length) return;
  const eid = currentEventId;
  const affected = selectionsOf(stash.map(s => s.data));
  const updates = {};
  stash.forEach(({ id }) => {
    delete regs[id]; selected.delete(id);
    updates[`boothEvents/${eid}/registrations/${id}`] = null;
  });
  affected.forEach(({ gid, sid }) => applyLocalCount(gid, sid, -1));
  renderAll();
  try {
    await update(ref(db), updates);
    for (const { gid, sid } of affected) {
      try { await bumpSlotCount(eid, gid, sid, -1); }
      catch (e) { console.error('Seat release failed:', e); }
    }
    showToast(`🗑 Deleted ${stash.length} registration(s) — seats released 已刪除並釋放名額`, 'info', {
      label:'Undo 復原',
      fn: async () => {
        const back = {};
        stash.forEach(({ id, data }) => {
          back[`boothEvents/${eid}/registrations/${id}`] = data;
          if (eid === currentEventId) regs[id] = data;
        });
        try {
          await update(ref(db), back);
          for (const { gid, sid } of affected) {
            if (eid === currentEventId && !games[gid]?.slots?.[sid]) continue;
            try { await bumpSlotCount(eid, gid, sid, +1); }
            catch (e) { console.error('Seat re-book failed:', e); }
            if (eid === currentEventId) applyLocalCount(gid, sid, +1);
          }
          renderAll();
          showToast('↩ Restored — seats re-booked 已復原並重新佔位', 'success');
        } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
      }
    });
  } catch (err) {
    stash.forEach(({ id, data }) => { regs[id] = data; });
    affected.forEach(({ gid, sid }) => applyLocalCount(gid, sid, +1));
    renderAll();
    showToast(`Error: ${err.message}`, 'error');
  }
}

(function bindRebuildCounts() {
  const btn = document.getElementById('rebuildCountsBtn');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => reconcileCounts({ silent:false }));
  }
})();

// ============================================
// DETAIL DRAWER
// ============================================
function openDrawer(id) {
  drawerRegId = id;
  fillDrawer(id);
  $('drawerScrim').classList.remove('hidden');
  $('regDrawer').classList.remove('hidden');
}
function closeDrawer() {
  const rid = drawerRegId;
  if (rid && regs[rid] && (resDirty.has(rid) || dtDirty.has(rid) || recDirty.has(rid))) {
    if (!confirm('Discard unsaved game results / DTs / record notes? 放棄未儲存的成績／診斷測試／備註？')) return;
    resDrop(rid); dtDrop(rid); recDrop(rid);
  }
  if (rid && !regs[rid]) { resDrop(rid); dtDrop(rid); recDrop(rid); }
  drawerRegId = null;
  $('drawerScrim').classList.add('hidden');
  $('regDrawer').classList.add('hidden');
}
function dwRow(label, value) {
  return `<div class="dw-row"><span class="dw-label">${label}</span><span class="dw-value">${value || '—'}</span></div>`;
}
function fillDrawer(id) {
  const r = regs[id]; if (!r) { closeDrawer(); return; }
  const status = r.status || 'registered';
  $('drawerTitle').innerHTML = `${escapeHtml(r.studentName || '')} <span class="status-badge st-${status}" style="margin-left:.4rem">${status === 'attended' ? '✅ Attended' : '📝 Registered'}</span>`;
  const apps = [r.contactApps?.wechat ? '💬 WeChat' : '', r.contactApps?.whatsapp ? '📱 WhatsApp' : ''].filter(Boolean).join(' · ');
  const interests = normalizeInterests(r.interests).map(i => `<span class="interest-chip">${escapeHtml(interestLabel(i))}</span>`).join('');
  const selHtml = (r.selections || []).map((s, i) => {
    const g = games[s.gameId];
    return `<span class="game-chip" style="--gc:${g?.color || PALETTE[0]}">${g?.emoji || '🎮'} ${escapeHtml(s.gameName || g?.name || '')} · ${escapeHtml(slotFullLabel(s))}<button type="button" class="chip-x" data-rm-game="${i}" title="Remove game 移除遊戲">✕</button></span>`;
  }).join('');
  $('drawerBody').innerHTML =
    `<div class="dw-section"><h4>🧒 Child 小朋友</h4>` +
    dwRow('Grade 年級', `<span class="grade-chip band-${gradeBand(r.grade)}">${escapeHtml(gradeLabel(r.grade))}</span>`) +
    dwRow('School 學校', escapeHtml(r.school || '')) +
    dwRow('Birthday 生日', escapeHtml(r.birthday ? fmtDate(r.birthday, false) : '')) +
    dwRow('Age 年齡', r.ageYears != null ? `${r.ageYears}y ${r.ageMonths ?? 0}m · ${r.ageYears}歲` : '') +
    `</div>` +
    `<div class="dw-section"><h4>📞 Contact 聯絡</h4>` +
    dwRow('Phone 電話', r.parentPhone ? `<a href="tel:${escapeHtml(r.parentPhone)}">${escapeHtml(r.parentPhone)}</a>` : '') +
    dwRow('Apps 聯絡方式', escapeHtml(apps)) +
    dwRow('WeChat ID', escapeHtml(r.wechatId || '')) +
    `</div>` +
    `<div class="dw-section"><h4>📚 Kumon 公文式</h4>` +
    dwRow('Current student', r.isCurrentStudent === 'yes' ? '✅ Yes 是' : '🌱 No 否') +
    (r.isCurrentStudent === 'yes' ? dwRow('Center 教室', escapeHtml(r.currentCenter)) + dwRow('Subjects 科目', escapeHtml(r.currentSubjects)) : '') +
    dwRow('Interested 興趣', `<div class="dw-chips">${interests || '—'}</div>`) +
    `</div>` +
    `<div class="dw-section"><h4>🎪 Games 遊戲</h4><div class="dw-chips">${selHtml || '—'}</div><button type="button" class="btn ghost small dw-add-game" id="dwAddGameBtn">＋ Add game 新增遊戲</button></div>` +
    resultsSectionHtml(r, id) +
    dtSectionHtml(r, id) +
    `<div class="dw-section"><h4>🗂 Record 紀錄</h4>` +
    dwRow('ID 編號', '<strong>' + escapeHtml(regIdLabel(r.seq)) + '</strong>') +
    dwRow('Submitted 提交', r.submittedAt ? new Date(r.submittedAt).toLocaleString('en-GB') : '') +
    recSectionHtml(r, id) +
    `</div>`;
  $('drawerAttendBtn').textContent = status === 'attended' ? '↩ Undo check-in 取消報到' : '✓ Check in 報到';
  bindDrawerGames(id);
  bindResults(id);
  bindDt(id);
  bindRec(id);
}

// ============================================
// GAME RESULTS 遊戲成績 (per registration, per game)
// Stored at registrations/{rid}/results/{gid}
// { set, time, timeSec, remarks, updatedAt, updatedBy }
// ============================================
const resEdits = {};          // rid -> { gid -> {set,time,remarks} } unsaved edits
const resDirty = new Set();   // rids with unsaved edits
const resTimers = {};         // 'rid|gid' -> { running, start, base }
let resTickTimer = null;

const resKey = (rid, gid) => rid + '|' + gid;

function resDrop(rid) {
  delete resEdits[rid];
  resDirty.delete(rid);
  Object.keys(resTimers).forEach(k => { if (k.startsWith(rid + '|')) delete resTimers[k]; });
  resEnsureTick();
}
function resVals(rid, gid) {
  const saved = (regs[rid]?.results || {})[gid] || {};
  const ed = (resEdits[rid] || {})[gid] || {};
  return {
    set: ed.set ?? saved.set ?? '',
    time: ed.time ?? saved.time ?? '',
    remarks: ed.remarks ?? saved.remarks ?? ''
  };
}
function resSetEdit(rid, gid, field, value) {
  resEdits[rid] = resEdits[rid] || {};
  resEdits[rid][gid] = resEdits[rid][gid] || { ...resVals(rid, gid) };
  resEdits[rid][gid][field] = value;
  resDirty.add(rid);
  if (drawerRegId === rid) {
    const chip = $('drawerBody').querySelector('[data-res-dirty]');
    if (chip) chip.classList.remove('hidden');
  }
}
// "83", "83.4" = seconds · "1:23", "1:23.4" = minutes:seconds
function parseTimeSec(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{1,4}(\.\d{1,3})?$/.test(s)) return parseFloat(s);
  const m = s.match(/^(\d{1,3}):([0-5]?\d(?:\.\d{1,3})?)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  return NaN;
}
function fmtTimeSec(sec) {
  if (sec == null || isNaN(sec)) return '';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return m + ':' + s.toFixed(1).padStart(4, '0');
}
function resultsSectionHtml(r, rid) {
  const seen = new Set();
  const sels = [];
  (r.selections || []).forEach(s => {
    if (s && s.gameId && !seen.has(s.gameId)) { seen.add(s.gameId); sels.push(s); }
  });
  let html = `<div class="dw-section"><h4>🏁 Game results 遊戲成績</h4>`;
  if (!sels.length) return html + `<p class="hint">No games selected 未選擇遊戲</p></div>`;
  html += `<p class="hint res-hint">Record set, time & remarks per challenge — fastest time wins. 記錄每項挑戰的組別、時間及備註 — 最快時間勝出。</p>`;
  sels.forEach(s => {
    const gid = s.gameId, g = games[gid] || {};
    const v = resVals(rid, gid);
    const t = resTimers[resKey(rid, gid)];
    const running = !!(t && t.running);
    const saved = (r.results || {})[gid];
    const meta = saved && saved.updatedAt
      ? `✓ Recorded 已記錄 · ${escapeHtml(new Date(saved.updatedAt).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }))}${saved.timeSec != null ? ` · ${saved.timeSec}s` : ''}`
      : '';
    html +=
      `<div class="res-game" style="--gc:${g.color || PALETTE[0]}">` +
      `<div class="res-game-head"><span class="res-emoji">${g.emoji || '🎮'}</span>` +
      `<div class="res-names"><div class="res-name">${escapeHtml(s.gameName || g.name || g.nameCn || '')}</div>` +
      `<div class="res-slot">${escapeHtml(slotFullLabel(s))}</div></div>` +
      `<button type="button" class="res-clear" data-res-clear="${escapeHtml(gid)}" title="Clear this game 清除此項">✕</button></div>` +
      `<div class="res-grid">` +
      `<label class="res-field"><span>Set 組</span>` +
      `<input type="text" data-res="set" data-gid="${escapeHtml(gid)}" maxlength="20" placeholder="e.g. 1" value="${escapeHtml(v.set)}"></label>` +
      `<div class="res-field"><span>Time 時間 <em class="res-sec" data-sec="${escapeHtml(gid)}"></em></span>` +
      `<div class="res-time-row">` +
      `<input type="text" data-res="time" data-gid="${escapeHtml(gid)}" inputmode="decimal" placeholder="1:23.4" class="${running ? 'timing' : ''}" ${running ? 'readonly' : ''} value="${escapeHtml(v.time)}">` +
      `<button type="button" class="res-timer-btn${running ? ' stop' : ''}" data-timer="${escapeHtml(gid)}" title="${running ? 'Stop 停止' : 'Start stopwatch 開始計時'}">${running ? '⏹' : '▶'}</button>` +
      `<button type="button" class="res-timer-btn ghost" data-timer-reset="${escapeHtml(gid)}" title="Reset 重設">↺</button>` +
      `</div></div>` +
      `<label class="res-field wide"><span>Remarks 備註</span>` +
      `<input type="text" data-res="remarks" data-gid="${escapeHtml(gid)}" maxlength="200" placeholder="Optional 選填" value="${escapeHtml(v.remarks)}"></label>` +
      `</div>` +
      (meta ? `<div class="res-meta">${meta}</div>` : '') +
      `</div>`;
  });
  const stamps = Object.values(r.results || {}).map(x => x && x.updatedAt).filter(Boolean).sort();
  const statusTxt = stamps.length
    ? `✓ ${escapeHtml(new Date(stamps[stamps.length - 1]).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }))}`
    : 'Not recorded yet 尚未記錄';
  html +=
    `<div class="res-save-bar">` +
    `<span class="res-status">${statusTxt}</span>` +
    `<span class="draft-chip${resDirty.has(rid) ? '' : ' hidden'}" data-res-dirty>● Unsaved 未儲存</span>` +
    `<button type="button" class="btn primary small" data-res-save>💾 Save results 儲存成績</button>` +
    `</div></div>`;
  return html;
}
function bindResults(rid) {
  const body = $('drawerBody');
  body.querySelectorAll('[data-res]').forEach(inp => {
    inp.addEventListener('input', () => {
      resSetEdit(rid, inp.dataset.gid, inp.dataset.res, inp.value);
      inp.classList.remove('invalid');
      if (inp.dataset.res === 'time') resUpdateSecHint(inp.dataset.gid);
    });
  });
  body.querySelectorAll('[data-timer]').forEach(btn =>
    btn.addEventListener('click', () => resTimerToggle(rid, btn.dataset.timer)));
  body.querySelectorAll('[data-timer-reset]').forEach(btn =>
    btn.addEventListener('click', () => resTimerReset(rid, btn.dataset.timerReset)));
  body.querySelectorAll('[data-res-clear]').forEach(btn =>
    btn.addEventListener('click', () => {
      const gid = btn.dataset.resClear;
      resTimers[resKey(rid, gid)] = { running:false, start:0, base:0 };
      resEdits[rid] = resEdits[rid] || {};
      resEdits[rid][gid] = { set:'', time:'', remarks:'' };
      resDirty.add(rid);
      resEnsureTick();
      fillDrawer(rid);
    }));
  const save = body.querySelector('[data-res-save]');
  if (save) save.addEventListener('click', saveResults);
  body.querySelectorAll('[data-res="time"]').forEach(inp => resUpdateSecHint(inp.dataset.gid));
}
function resUpdateSecHint(gid) {
  const body = $('drawerBody');
  const inp = body.querySelector(`[data-res="time"][data-gid="${gid}"]`);
  const hint = body.querySelector(`[data-sec="${gid}"]`);
  if (!inp || !hint) return;
  const v = parseTimeSec(inp.value);
  hint.textContent = v == null ? '' : (isNaN(v) ? '⚠ format' : (Math.round(v * 10) / 10) + 's');
  hint.classList.toggle('bad', isNaN(v));
}
function resTimerToggle(rid, gid) {
  const k = resKey(rid, gid);
  const t = resTimers[k] = resTimers[k] || { running:false, start:0, base:0 };
  if (t.running) {
    t.base += Date.now() - t.start;
    t.running = false;
    resSetEdit(rid, gid, 'time', fmtTimeSec(t.base / 1000));
  } else {
    t.running = true;
    t.start = Date.now();
  }
  resEnsureTick();
  if (drawerRegId === rid) fillDrawer(rid);
}
function resTimerReset(rid, gid) {
  resTimers[resKey(rid, gid)] = { running:false, start:0, base:0 };
  resSetEdit(rid, gid, 'time', '');
  resEnsureTick();
  if (drawerRegId === rid) fillDrawer(rid);
}
function resEnsureTick() {
  const anyRunning = Object.values(resTimers).some(t => t.running);
  if (anyRunning && !resTickTimer) resTickTimer = setInterval(resTick, 100);
  if (!anyRunning && resTickTimer) { clearInterval(resTickTimer); resTickTimer = null; }
}
function resTick() {
  Object.keys(resTimers).forEach(k => {
    const [rid, gid] = k.split('|');
    if (!regs[rid]) { delete resTimers[k]; delete resEdits[rid]; resDirty.delete(rid); return; }
    const t = resTimers[k];
    if (!t.running || drawerRegId !== rid) return;
    const inp = $('drawerBody').querySelector(`[data-res="time"][data-gid="${gid}"]`);
    if (inp) { inp.value = fmtTimeSec((t.base + Date.now() - t.start) / 1000); resUpdateSecHint(gid); }
  });
  resEnsureTick();
}
async function saveResults() {
  const rid = drawerRegId;
  if (!rid || !regs[rid]) return;
  const r = regs[rid];
  // Auto-stop any running stopwatch so its time is captured.
  let stopped = false;
  (r.selections || []).forEach(s => {
    const t = resTimers[resKey(rid, s.gameId)];
    if (t && t.running) {
      t.base += Date.now() - t.start; t.running = false;
      resSetEdit(rid, s.gameId, 'time', fmtTimeSec(t.base / 1000));
      stopped = true;
    }
  });
  resEnsureTick();
  const seen = new Set(), updates = {}, nextLocal = { ...(r.results || {}) };
  const now = new Date().toISOString();
  const by = auth.currentUser?.email || '';
  let badGid = null;
  (r.selections || []).forEach(s => {
    const gid = s.gameId;
    if (!gid || seen.has(gid)) return;
    seen.add(gid);
    const v = resVals(rid, gid);
    const set = String(v.set || '').trim();
    const time = String(v.time || '').trim();
    const remarks = String(v.remarks || '').trim();
    const sec = time ? parseTimeSec(time) : null;
    if (time && isNaN(sec)) { badGid = gid; return; }
    const path = `boothEvents/${currentEventId}/registrations/${rid}/results/${gid}`;
    if (!set && !time && !remarks) {
      updates[path] = null;
      delete nextLocal[gid];
    } else {
      const obj = { set, time, remarks, updatedAt:now, updatedBy:by };
      if (sec != null && !isNaN(sec)) obj.timeSec = Math.round(sec * 1000) / 1000;
      updates[path] = obj;
      nextLocal[gid] = obj;
    }
  });
  if (badGid) {
    if (stopped) fillDrawer(rid);
    const inp = $('drawerBody').querySelector(`[data-res="time"][data-gid="${badGid}"]`);
    if (inp) { inp.classList.add('invalid'); inp.focus(); }
    showToast('⚠ Invalid time — use seconds (83.4) or m:ss (1:23.4) 時間格式無效', 'error');
    return;
  }
  if (!Object.keys(updates).length) { showToast('Nothing to save 沒有可儲存的成績', 'info'); return; }
  const prev = r.results;
  const prevEdits = resEdits[rid];
  r.results = nextLocal;
  delete resEdits[rid];
  resDirty.delete(rid);
  const btn = $('drawerBody').querySelector('[data-res-save]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
  try {
    await update(ref(db), updates);
    showToast('🏁 Results saved 成績已儲存', 'success');
    if (drawerRegId === rid) fillDrawer(rid);
  } catch (err) {
    r.results = prev;
    if (prevEdits) resEdits[rid] = prevEdits;
    resDirty.add(rid);
    showToast(`Error: ${err.message}`, 'error');
    if (drawerRegId === rid) fillDrawer(rid);
  }
}
// ============================================
// DIAGNOSTIC TESTS (DT) + TRANSFER TO STUDENT RECORD
// ============================================
const DT_SUBJECTS = ['Math', 'Chinese (Trad)', 'Chinese (Simp)', 'English ERP', 'English EFL'];
const dtEdits = {};
const dtDirty = new Set();
const kcEdits = {};
function dtDrop(rid) { delete dtEdits[rid]; delete kcEdits[rid]; dtDirty.delete(rid); }
function kcVal(rid) { return kcEdits[rid] ?? regs[rid]?.kcNo ?? ''; }
function kcSetEdit(rid, value) {
  kcEdits[rid] = value;
  dtDirty.add(rid);
  if (drawerRegId === rid) $('drawerBody').querySelector('[data-dt-dirty]')?.classList.remove('hidden');
}
let bdt = { rid:null, centerId:'', match:null, students:[], busy:false };
let bdtCentersCache = null;
const bdtStudentsCache = {};

function dtSectionHtml(r, rid) {
  const ids = dtIds(rid);
  let html = `<div class="dw-section"><h4>📝 Diagnostic tests 診斷測試 DT</h4>`;
  html += `<p class="hint res-hint">Record booth DT results, then send them to the student record. 記錄攤位診斷測試成績，再傳送至學生紀錄。</p>`;
  html += `<label class="res-field dt-kc-field"><span>KC No. 平板編號 <em class="rec-tag send">→ student form 傳送</em></span>` +
    `<input type="text" data-dt-kc maxlength="30" placeholder="e.g. KC123456" value="${escapeHtml(kcVal(rid))}"></label>`;
  ids.forEach(id => {
    const saved = dtSaved(rid)[id];
    if (saved && saved.transferredAt) {
      html += `<div class="dt-sent"><span>✅ ${escapeHtml(saved.subject || '')} · ${escapeHtml(saved.date || '')} · ${escapeHtml(saved.test || '')} · ${escapeHtml(saved.score || '')} · ${escapeHtml(saved.time || '')}</span><em>Sent 已傳送${saved.transferredStudentName ? ' → ' + escapeHtml(saved.transferredStudentName) : ''}</em></div>`;
      return;
    }
    const v = dtVals(rid, id);
    const opts = '<option value="">Subject 科目…</option>' + DT_SUBJECTS.map(s => `<option value="${escapeHtml(s)}" ${s === v.subject ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
    const f = (label, key, type, val, ph = '') =>
      `<label class="res-field"><span>${label}</span><input type="${type}" data-dt="${key}" data-dtid="${escapeHtml(id)}" value="${escapeHtml(val)}" placeholder="${escapeHtml(ph)}"></label>`;
    html += `<div class="dt-card">` +
      `<div class="dt-card-head"><select data-dt="subject" data-dtid="${escapeHtml(id)}">${opts}</select><button type="button" class="res-clear" data-dt-del="${escapeHtml(id)}" title="Remove 移除">✕</button></div>` +
      `<div class="dt-grid">` +
      f('Date 日期', 'date', 'date', v.date) +
      f('Timeslot 時段', 'DTtimeslot', 'time', v.DTtimeslot) +
      f('Test / Level 測試', 'test', 'text', v.test, 'e.g. DT 3A') +
      f('Score 分數', 'score', 'text', v.score, 'e.g. 85/100') +
      f('Time 時間', 'time', 'text', v.time, '20/30') +
      f('Suggested 建議', 'suggestedStart', 'text', v.suggestedStart, 'e.g. 3A') +
      f('Actual 實際', 'actualStart', 'text', v.actualStart, 'e.g. 3A') +
      `</div></div>`;
  });
  if (!ids.length) html += '<p class="hint">No DTs yet. 尚未記錄。</p>';
  const pend = dtPending(rid).length;
  html += `<div class="res-save-bar"><span class="res-status">${pend ? pend + ' ready to send 可傳送' : '—'}</span>` +
    `<span class="draft-chip${dtDirty.has(rid) ? '' : ' hidden'}" data-dt-dirty>● Unsaved 未儲存</span>` +
    `<button type="button" class="btn ghost small" data-dt-add>＋ Add DT 新增</button>` +
    `<button type="button" class="btn primary small" data-dt-save>💾 Save DTs & KC 儲存</button></div>`;
  html += `<button type="button" class="btn secondary small dt-send-btn" data-dt-send ${pend ? '' : 'disabled'}>📤 Send to student form 傳送至學生表單${pend ? ` (${pend})` : ''}</button>`;
  html += '</div>';
  return html;
}
function dtSaved(rid) { return regs[rid]?.diagnosticTests || {}; }
function dtIds(rid) {
  const ids = new Set(Object.keys(dtSaved(rid)));
  const ed = dtEdits[rid] || {};
  Object.keys(ed).forEach(id => { if (ed[id] === null) ids.delete(id); else ids.add(id); });
  return [...ids];
}
function dtVals(rid, id) {
  const s = dtSaved(rid)[id] || {};
  const e = (dtEdits[rid] || {})[id] || {};
  const pick = k => e[k] ?? s[k] ?? '';
  return {
    subject:pick('subject'), date:pick('date'), DTtimeslot:pick('DTtimeslot'),
    test:pick('test'), score:pick('score'), time:pick('time'),
    suggestedStart:pick('suggestedStart'), actualStart:pick('actualStart')
  };
}
function dtSetEdit(rid, id, field, value) {
  dtEdits[rid] = dtEdits[rid] || {};
  dtEdits[rid][id] = dtEdits[rid][id] || { ...dtVals(rid, id) };
  dtEdits[rid][id][field] = value;
  dtDirty.add(rid);
  if (drawerRegId === rid) $('drawerBody').querySelector('[data-dt-dirty]')?.classList.remove('hidden');
}
function dtPending(rid) {
  return Object.entries(dtSaved(rid)).filter(([, d]) => d && !d.transferredAt).map(([id, d]) => ({ id, ...d }));
}
function boothGradeToForm(g) {
  const s = String(g || '').toUpperCase();
  if (/^K[0-3]$/.test(s)) return s;
  const m = s.match(/^([PF])([1-6])$/);
  if (m) return String((m[1] === 'P' ? 0 : 6) + Number(m[2]));
  return s;
}
function splitBoothName(full) {
  const s = String(full || '').trim();
  const cn = (s.match(/[\u3400-\u9FFF\uF900-\uFAFF]+/g) || []).join('');
  const py = s.replace(/[\u3400-\u9FFF\uF900-\uFAFF]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { nameCn:cn, namePinyin:py };
}
function dtPhoneKey(p) { return String(p || '').replace(/\D/g, ''); }
function dtPhoneMatch(a, b) {
  const x = dtPhoneKey(a), y = dtPhoneKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 8 && y.length >= 8 && x.slice(-8) === y.slice(-8);
}
function bindDt(rid) {
  const body = $('drawerBody');
  const kc = body.querySelector('[data-dt-kc]');
  if (kc) kc.addEventListener('input', () => kcSetEdit(rid, kc.value));
  body.querySelectorAll('[data-dt]').forEach(inp => inp.addEventListener('input', () => {
    dtSetEdit(rid, inp.dataset.dtid, inp.dataset.dt, inp.value);
    inp.classList.remove('invalid');
  }));
  body.querySelectorAll('[data-dt-del]').forEach(b => b.addEventListener('click', () => {
    dtEdits[rid] = dtEdits[rid] || {};
    dtEdits[rid][b.dataset.dtDel] = null;
    dtDirty.add(rid);
    fillDrawer(rid);
  }));
  body.querySelector('[data-dt-add]')?.addEventListener('click', () => {
    const id = uid('dt');
    dtEdits[rid] = dtEdits[rid] || {};
    dtEdits[rid][id] = { subject:'', date:localDateStr(), DTtimeslot:'', test:'', score:'', time:'', suggestedStart:'', actualStart:'' };
    dtDirty.add(rid);
    fillDrawer(rid);
  });
  body.querySelector('[data-dt-save]')?.addEventListener('click', () => saveDts(rid));
  body.querySelector('[data-dt-send]')?.addEventListener('click', () => openBdtModal(rid));
}
async function saveDts(rid) {
  const r = regs[rid]; if (!r) return;
  const eid = currentEventId;
  const saved = dtSaved(rid);
  const ed = dtEdits[rid] || {};
  const ids = new Set([...Object.keys(saved), ...Object.keys(ed)]);
  const updates = {};
  const next = { ...saved };
  const now = new Date().toISOString();
  const by = auth.currentUser?.email || '';
  ids.forEach(id => {
    const path = `boothEvents/${eid}/registrations/${rid}/diagnosticTests/${id}`;
    if (ed[id] === null) { updates[path] = null; delete next[id]; return; }
    const v = dtVals(rid, id);
    const empty = !v.subject && !v.date && !v.test && !v.score && !v.time && !v.DTtimeslot && !v.suggestedStart && !v.actualStart;
    if (empty) { updates[path] = null; delete next[id]; return; }
    next[id] = { ...(saved[id] || {}), ...v, updatedAt:now, updatedBy:by };
    updates[path] = next[id];
  });
  const kcNo = String(kcVal(rid)).trim();
  const kcChanged = kcNo !== String(r.kcNo || '');
  if (kcChanged) updates[`boothEvents/${eid}/registrations/${rid}/kcNo`] = kcNo;
  if (!Object.keys(updates).length) return showToast('Nothing to save 沒有可儲存的變更', 'info');
  const prevAll = r.diagnosticTests;
  const prevEdits = dtEdits[rid];
  const prevKc = r.kcNo;
  const prevKcEdit = kcEdits[rid];
  r.diagnosticTests = next;
  if (kcChanged) r.kcNo = kcNo;
  delete dtEdits[rid];
  delete kcEdits[rid];
  dtDirty.delete(rid);
  const btn = $('drawerBody').querySelector('[data-dt-save]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    await update(ref(db), updates);
    showToast(kcChanged ? '📝 DTs & KC No. saved 已儲存' : '📝 DTs saved 已儲存', 'success');
    if (drawerRegId === rid) fillDrawer(rid);
  } catch (err) {
    r.diagnosticTests = prevAll;
    r.kcNo = prevKc;
    if (prevEdits) dtEdits[rid] = prevEdits;
    if (prevKcEdit !== undefined) kcEdits[rid] = prevKcEdit;
    dtDirty.add(rid);
    showToast(`Error: ${err.message}`, 'error');
    if (drawerRegId === rid) fillDrawer(rid);
  }
}
function closeBdtModal() { $('bdtModal')?.classList.add('hidden'); bdt.rid = null; bdt.match = null; }
async function openBdtModal(rid) {
  const r = regs[rid]; if (!r) return;
  if (dtDirty.has(rid) || recDirty.has(rid)) return showToast('Save your changes first 請先儲存變更', 'error');
  const pend = dtPending(rid);
  if (!pend.length) return showToast('No saved DTs to send 沒有可傳送的 DT', 'error');
  if (pend.some(d => !d.subject || !d.date || !d.test || !d.score || !d.time)) {
    return showToast('Each DT needs subject, date, test, score & time before sending 每項 DT 需填寫科目、日期、測試、分數及時間', 'error');
  }
  bdt = { rid, centerId:'', match:null, students:[], busy:false };
  $('bdtSummary').innerHTML =
    `<div class="bdt-stu"><strong>${escapeHtml(r.studentName || '')}</strong><span class="grade-chip band-${gradeBand(r.grade)}">${escapeHtml(r.grade || '')}</span><span>📞 ${escapeHtml(r.parentPhone || '—')}</span><span>${pend.length} DT(s)</span></div>` +
    `<div class="bdt-kc-line"><span>KC No. 平板編號 → ${r.kcNo ? `<code>${escapeHtml(r.kcNo)}</code>` : '—'}</span><span>📝 Remarks stay in booth 備註只留攤位</span></div>`;
  $('bdtList').innerHTML = pend.map(d =>
    `<div class="bdt-dt-row">${escapeHtml(d.subject)} · ${escapeHtml(d.date)}${d.DTtimeslot ? ' ' + escapeHtml(d.DTtimeslot) : ''} · ${escapeHtml(d.test)} · ${escapeHtml(d.score)} · ${escapeHtml(d.time)}${d.suggestedStart ? ' → ' + escapeHtml(d.suggestedStart) : ''}</div>`).join('');
  $('bdtModal').classList.remove('hidden');
  const sel = $('bdtCenter');
  sel.innerHTML = '<option value="">Loading centers 載入中…</option>';
  try {
    if (!bdtCentersCache) {
      const snap = await get(ref(db, 'centers'));
      bdtCentersCache = Object.entries(snap.val() || {}).map(([id, c]) => ({ id, name:c?.name || id })).sort((a, b) => a.name.localeCompare(b.name));
    }
    sel.innerHTML = bdtCentersCache.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
    const pref = sessionStorage.getItem('selectedCenter') || '';
    bdt.centerId = bdtCentersCache.some(c => c.id === pref) ? pref : (bdtCentersCache[0]?.id || '');
    sel.value = bdt.centerId;
    await bdtLoadStudents();
  } catch (err) {
    sel.innerHTML = '<option value="">Error loading centers</option>';
    showToast(`Error: ${err.message}`, 'error');
  }
}
async function bdtLoadStudents() {
  const cid = bdt.centerId;
  const r = regs[bdt.rid];
  const box = $('bdtMatch');
  if (!cid || !r) { box.innerHTML = ''; return; }
  box.innerHTML = '<p class="hint">Checking phone match 正在比對電話…</p>';
  try {
    if (!bdtStudentsCache[cid]) {
      const snap = await get(ref(db, `centers/${cid}/students`));
      const list = [];
      snap.forEach(ch => list.push({ id:ch.key, ...ch.val() }));
      bdtStudentsCache[cid] = list;
    }
    bdt.students = bdtStudentsCache[cid];
    bdt.match = bdt.students.find(s =>
      dtPhoneMatch(s.phone?.mom, r.parentPhone) ||
      dtPhoneMatch(s.phone?.dad, r.parentPhone) ||
      dtPhoneMatch(s.phone?.own, r.parentPhone)) || null;
    renderBdtMatch();
  } catch (err) {
    box.innerHTML = `<p class="hint">Error: ${escapeHtml(err.message)}</p>`;
  }
}
function renderBdtMatch() {
  const box = $('bdtMatch');
  const add = $('bdtAddBtn');
  const nw = $('bdtNewBtn');
  if (bdt.match) {
    const s = bdt.match;
    box.innerHTML = `<div class="bdt-match">✅ Existing student found 找到現有學生<div class="bdt-match-name">${escapeHtml(s.nameCn || '')} ${escapeHtml(s.namePinyin || '')}</div><div class="bdt-match-meta">${escapeHtml(s.studentNumber || '—')} · ${escapeHtml(s.grade || '—')} · ${escapeHtml(s.overallStatus || '')}</div></div>`;
    add.classList.remove('hidden');
    add.disabled = false;
    add.textContent = '＋ Add DTs to this student 加入此學生';
    nw.className = 'btn ghost';
    nw.textContent = '🆕 Open as new instead 仍作為新學生';
  } else {
    box.innerHTML = `<div class="bdt-none">🆕 No student with this phone in this center — the student form will open as a new inquiry. 此教室沒有此電話的學生 — 將以新查詢開啟學生表單。</div>`;
    add.classList.add('hidden');
    nw.className = 'btn primary';
    nw.textContent = '📤 Open student form (new inquiry) 開啟學生表單';
  }
}
async function bdtAddToExisting() {
  const rid = bdt.rid, r = regs[rid], s = bdt.match, cid = bdt.centerId;
  if (!r || !s || !cid || bdt.busy) return;
  const eid = currentEventId;
  bdt.busy = true;
  const btn = $('bdtAddBtn');
  btn.disabled = true; btn.textContent = '⏳ Adding…';
  try {
    const snap = await get(ref(db, `centers/${cid}/students/${s.id}`));
    if (!snap.exists()) throw new Error('Student no longer exists 學生已不存在');
    const cur = snap.val();
    const arr = Array.isArray(cur.diagnosticTests) ? cur.diagnosticTests : Object.values(cur.diagnosticTests || {});
    const pend = dtPending(rid);
    const clean = pend.map(d => ({
      subject:d.subject || '', date:d.date || '', DTtimeslot:d.DTtimeslot || '',
      test:d.test || '', score:d.score || '', time:d.time || '',
      suggestedStart:d.suggestedStart || '', actualStart:d.actualStart || '',
      dtNote:'Booth DT 攤位診斷測試'
    }));
    const additions = clean.filter(d => !arr.some(x =>
      x && x.subject === d.subject && x.date === d.date && x.test === d.test && x.score === d.score && x.time === d.time));
    const boothKc = String(r.kcNo || '').trim();
    const passKc = boothKc && !String(cur.kcNo || '').trim();
    if (!additions.length && !passKc) {
      showToast('These DTs are already on the student record 這些 DT 已在學生紀錄中', 'info');
      closeBdtModal();
      return;
    }
    const now = new Date().toISOString();
    const updates = {};
    if (additions.length) updates[`centers/${cid}/students/${s.id}/diagnosticTests`] = [...arr, ...additions];
    if (passKc) updates[`centers/${cid}/students/${s.id}/kcNo`] = boothKc;
    updates[`centers/${cid}/students/${s.id}/updatedAt`] = now;
    const nextLocal = { ...(r.diagnosticTests || {}) };
    const stampName = s.nameCn || s.namePinyin || '';
    pend.forEach(d => {
      const base = `boothEvents/${eid}/registrations/${rid}/diagnosticTests/${d.id}`;
      updates[`${base}/transferredAt`] = now;
      updates[`${base}/transferredStudentId`] = s.id;
      updates[`${base}/transferredCenterId`] = cid;
      updates[`${base}/transferredStudentName`] = stampName;
      nextLocal[d.id] = { ...(nextLocal[d.id] || {}), transferredAt:now, transferredStudentId:s.id, transferredCenterId:cid, transferredStudentName:stampName };
    });
    await update(ref(db), updates);
    r.diagnosticTests = nextLocal;
    delete bdtStudentsCache[cid];
    closeBdtModal();
    if (drawerRegId === rid) fillDrawer(rid);
    showToast(`✅ ${additions.length} DT(s) added to ${stampName || 'student'}${passKc ? ' · KC No. saved 已儲存平板編號' : ''} 已加入學生紀錄`, 'success', {
      label:'Open 開啟',
      fn: () => {
        sessionStorage.setItem('selectedCenter', cid);
        window.location.href = `student-form.html?id=${encodeURIComponent(s.id)}&returnUrl=booth-games.html`;
      }
    });
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    bdt.busy = false;
    btn.disabled = false;
    btn.textContent = '＋ Add DTs to this student 加入此學生';
  }
}
function bdtOpenNew() {
  const rid = bdt.rid, r = regs[rid], cid = bdt.centerId;
  if (!r || !cid) return;
  const pend = dtPending(rid);
  const { nameCn, namePinyin } = splitBoothName(r.studentName);
  const kcNo = String(kcEdits[rid] ?? r.kcNo ?? '').trim();
  const payload = {
    ts:Date.now(),
    centerId:cid,
    date:localDateStr(),
    kcNo,
    student:{
      nameCn:nameCn || r.studentName || '', namePinyin,
      grade:boothGradeToForm(r.grade), school:r.school || '',
      birthday:r.birthday || '', phone:r.parentPhone || '',
      kcNo
    },
    diagnosticTests:pend.map(d => ({
      subject:d.subject, date:d.date, DTtimeslot:d.DTtimeslot || '',
      test:d.test, score:d.score, time:d.time,
      suggestedStart:d.suggestedStart || '', actualStart:d.actualStart || ''
    }))
  };
  try {
    sessionStorage.setItem('boothDtHandoff', JSON.stringify(payload));
    sessionStorage.setItem('boothKcHandoff', JSON.stringify({ kcNo, ts:Date.now() }));
    sessionStorage.setItem('selectedCenter', cid);
  } catch {}
  window.location.href = 'student-form.html?returnUrl=booth-games.html';
}
(function buildBdtModal() {
  if (document.getElementById('bdtModal')) return;
  const m = document.createElement('div');
  m.id = 'bdtModal'; m.className = 'modal hidden';
  m.innerHTML =
    `<div class="modal-box mr-box">` +
    `<div class="mr-head"><h3>📤 Send DTs to student record 傳送診斷測試</h3><button type="button" class="close-btn" id="bdtClose">✕</button></div>` +
    `<div class="mr-body">` +
    `<div id="bdtSummary"></div>` +
    `<div class="mr-field"><label>Center 教室</label><select id="bdtCenter"></select></div>` +
    `<div id="bdtMatch"></div>` +
    `<div class="mr-sec">DTs to send 將傳送的診斷測試</div>` +
    `<div id="bdtList"></div>` +
    `</div>` +
    `<div class="mr-foot"><button type="button" class="btn ghost" id="bdtCancel">✖ Cancel 取消</button><button type="button" class="btn ghost hidden" id="bdtAddBtn">＋ Add DTs to this student 加入此學生</button><button type="button" class="btn primary" id="bdtNewBtn">📤 Open student form 開啟學生表單</button></div>` +
    `</div>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m) closeBdtModal(); });
  document.getElementById('bdtClose').addEventListener('click', closeBdtModal);
  document.getElementById('bdtCancel').addEventListener('click', closeBdtModal);
  document.getElementById('bdtCenter').addEventListener('change', e => { bdt.centerId = e.target.value; bdtLoadStudents(); });
  document.getElementById('bdtAddBtn').addEventListener('click', bdtAddToExisting);
  document.getElementById('bdtNewBtn').addEventListener('click', bdtOpenNew);
})();

// ============================================
// RECORD INPUTS — booth-only Remarks
// (KC No. lives at the top of the DT section)
// ============================================
const recEdits = {};
const recDirty = new Set();

function recDrop(rid) { delete recEdits[rid]; recDirty.delete(rid); }
function recVals(rid) {
  const r = regs[rid] || {};
  const e = recEdits[rid] || {};
  return { remarks: e.remarks ?? r.remarks ?? '' };
}
function recSetEdit(rid, field, value) {
  recEdits[rid] = recEdits[rid] || { ...recVals(rid) };
  recEdits[rid][field] = value;
  recDirty.add(rid);
  if (drawerRegId === rid) $('drawerBody').querySelector('[data-rec-dirty]')?.classList.remove('hidden');
}
function recSectionHtml(r, rid) {
  const v = recVals(rid);
  const status = r.recordUpdatedAt
    ? '✓ ' + escapeHtml(new Date(r.recordUpdatedAt).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }))
    : '—';
  return `<div class="rec-grid">` +
    `<label class="res-field"><span>Remarks 備註 <em class="rec-tag booth">booth only 只留攤位</em></span>` +
    `<textarea data-rec="remarks" rows="2" maxlength="300" placeholder="Internal notes — not sent to the student form 內部備註 — 不會傳送至學生表單">${escapeHtml(v.remarks)}</textarea></label>` +
    `</div>` +
    `<div class="res-save-bar"><span class="res-status">${status}</span>` +
    `<span class="draft-chip${recDirty.has(rid) ? '' : ' hidden'}" data-rec-dirty>● Unsaved 未儲存</span>` +
    `<button type="button" class="btn primary small" data-rec-save>💾 Save 儲存</button></div>`;
}
function bindRec(rid) {
  const body = $('drawerBody');
  body.querySelectorAll('[data-rec]').forEach(inp =>
    inp.addEventListener('input', () => recSetEdit(rid, inp.dataset.rec, inp.value)));
  body.querySelector('[data-rec-save]')?.addEventListener('click', () => saveRec(rid));
}
async function saveRec(rid) {
  const r = regs[rid]; if (!r) return;
  const remarks = String(recVals(rid).remarks || '').trim();
  if (remarks === String(r.remarks || '')) {
    return showToast('Nothing to save 沒有可儲存的變更', 'info');
  }
  const eid = currentEventId;
  const now = new Date().toISOString();
  const by = auth.currentUser?.email || '';
  const prev = { remarks:r.remarks, recordUpdatedAt:r.recordUpdatedAt, recordUpdatedBy:r.recordUpdatedBy };
  const prevEdits = recEdits[rid];
  r.remarks = remarks; r.recordUpdatedAt = now; r.recordUpdatedBy = by;
  delete recEdits[rid]; recDirty.delete(rid);
  const btn = $('drawerBody').querySelector('[data-rec-save]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    await update(ref(db, `boothEvents/${eid}/registrations/${rid}`), { remarks, recordUpdatedAt:now, recordUpdatedBy:by });
    showToast('💾 Record saved 已儲存', 'success');
    if (drawerRegId === rid) fillDrawer(rid);
  } catch (err) {
    Object.assign(r, prev);
    if (prevEdits) recEdits[rid] = prevEdits;
    recDirty.add(rid);
    showToast(`Error: ${err.message}`, 'error');
    if (drawerRegId === rid) fillDrawer(rid);
  }
}
// ============================================
// MANUAL REGISTRATION + ADD GAMES AFTER REGISTRATION
// ============================================
let agPick = { rid:null, sel:{}, override:false };
let mrPick = { sel:{}, override:false };
let mrState = { apps:{ wechat:false, whatsapp:false }, current:'no', interests:new Set() };

async function claimSlotCount(eid, gid, sid, cap) {
  const res = await runTransaction(
    ref(db, `boothEvents/${eid}/counts/${gid}/${sid}`),
    cur => {
      const n = Number(cur) || 0;
      if (cap && n >= cap) return;
      return n + 1;
    },
    { applyLocally:false }
  );
  return res.committed;
}
async function releaseClaims(eid, done) {
  for (const { gid, sid } of done) {
    try { await bumpSlotCount(eid, gid, sid, -1); }
    catch (e) { console.error('Seat release failed:', e); }
  }
}
async function claimSeq(eid) {
  const res = await runTransaction(
    ref(db, `boothEvents/${eid}/seq`),
    cur => { const n = Number(cur) || 0; if (n >= 999) return; return n + 1; },
    { applyLocally:false }
  );
  return res.committed ? Number(res.snapshot.val()) : null;
}
function pickerConflicts(pick, existing) {
  const items = [];
  (existing || []).forEach(s => {
    if (s && s.start) items.push({ label:(games[s.gameId]?.emoji || '🎮') + ' ' + (s.gameName || games[s.gameId]?.name || ''), s });
  });
  Object.entries(pick.sel).forEach(([gid, sid]) => {
    const s = games[gid]?.slots?.[sid];
    if (s) items.push({ label:(games[gid]?.emoji || '🎮') + ' ' + (games[gid]?.name || games[gid]?.nameCn || ''), s });
  });
  const out = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (slotsOverlap(items[i].s, items[j].s)) out.push(items[i].label + ' ↔ ' + items[j].label);
  return out;
}
function renderPicker(wrap, pick, grade, existing, mode) {
  if (!wrap) return;
  const bookedByGid = {};
  (existing || []).forEach(s => { if (s) bookedByGid[s.gameId] = s; });
  const entries = Object.entries(games);
  let html = `<label class="pick-override"><input type="checkbox" data-pick-override ${pick.override ? 'checked' : ''}> ⚠️ Allow games outside the grade range 忽略年級限制</label>`;
  if (!entries.length) html += '<p class="hint">No games in this event yet. 此活動尚未新增遊戲。</p>';
  entries.forEach(([gid, g]) => {
    const c = g.color || PALETTE[0];
    const eligible = !grade || gradeInRange(grade, g.minGrade, g.maxGrade);
    const booked = bookedByGid[gid];
    const locked = (!eligible && !pick.override) || !!booked;
    const slots = Object.entries(g.slots || {}).sort((a, b) =>
      String(a[1].date || '').localeCompare(String(b[1].date || '')) || String(a[1].start).localeCompare(String(b[1].start)));
    let note = '';
    if (booked) note = `<span class="pick-booked">✅ Booked 已報名 · ${escapeHtml(slotFullLabel(booked))}</span>`;
    else if (!eligible) note = `<span class="pick-lock">🔒 Only 只限 ${escapeHtml(rangeLabel(g.minGrade, g.maxGrade))} — tick override above to add 勾選上方忽略限制</span>`;
    const rows = slots.map(([sid, s]) => {
      const cap = Number(s.capacity) || 0;
      const used = Number(counts[gid]?.[sid]) || 0;
      const left = Math.max(0, cap - used);
      const selected = pick.sel[gid] === sid;
      const full = left <= 0 && !selected;
      const dis = locked || full;
      const seats = full ? '<span class="full-badge">FULL 額滿</span>'
        : left <= 3 ? `<span class="ps-low">${left} left 尚餘 ${left}</span>`
        : `<span>${left} left 尚餘 ${left}</span>`;
      return `<button type="button" class="pick-slot${selected ? ' selected' : ''}" data-pick-slot="${escapeHtml(gid)}|${escapeHtml(sid)}" ${dis ? 'disabled' : ''}>` +
        `<span class="ps-time">🎟 ${escapeHtml(fmtDateShort(s.date))} · ${escapeHtml(slotLabel(s))}</span>` +
        `<span class="ps-seats">${seats}</span><span class="ps-radio">${selected ? '✓' : ''}</span></button>`;
    }).join('');
    html += `<div class="pick-game${locked ? ' locked' : ''}" style="--gc:${c}">` +
      `<div class="pick-head"><span class="pick-emoji">${g.emoji || '🎮'}</span>` +
      `<div class="pick-names"><div class="pick-en">${escapeHtml(g.name || '')}</div><div class="pick-cn">${escapeHtml(g.nameCn || '')}</div></div>` +
      `<span class="range-chip">${escapeHtml(rangeLabel(g.minGrade, g.maxGrade))}</span></div>` +
      (note ? `<div class="pick-note">${note}</div>` : '') +
      `<div class="pick-slots">${rows || '<p class="hint">No slots. 尚未新增時段。</p>'}</div></div>`;
  });
  const conflicts = pickerConflicts(pick, mode === 'add' ? existing : []);
  if (conflicts.length) html += `<div class="pick-warn">⚠️ Time conflict 時間衝突:<br>${conflicts.map(c => escapeHtml(c)).join('<br>')}<br>Adjust the picks before saving. 請調整所選時段。</div>`;
  wrap.innerHTML = html;
  wrap.querySelector('[data-pick-override]')?.addEventListener('change', e => {
    pick.override = e.target.checked;
    renderPicker(wrap, pick, grade, existing, mode);
  });
  wrap.querySelectorAll('[data-pick-slot]').forEach(btn => btn.addEventListener('click', () => {
    const [gid, sid] = btn.dataset.pickSlot.split('|');
    if (pick.sel[gid] === sid) delete pick.sel[gid]; else pick.sel[gid] = sid;
    renderPicker(wrap, pick, grade, existing, mode);
  }));
}
function refreshPickers() {
  const ag = $('agModal'), mr = $('mrModal');
  if (ag && !ag.classList.contains('hidden')) {
    const r = regs[agPick.rid];
    if (!r || creatingNew) { closeAgModal(); return; }
    renderPicker($('agPicker'), agPick, r.grade, r.selections || [], 'add');
  }
  if (mr && !mr.classList.contains('hidden')) {
    if (!currentEventId || creatingNew) { closeMrModal(); return; }
    renderPicker($('mrPicker'), mrPick, $('mrGrade').value, [], 'manual');
  }
}
function closeTopModal() {
  const bdt = $('bdtModal'), ag = $('agModal'), mr = $('mrModal');
  if (bdt && !bdt.classList.contains('hidden')) { closeBdtModal(); return true; }
  if (ag && !ag.classList.contains('hidden')) { closeAgModal(); return true; }
  if (mr && !mr.classList.contains('hidden')) { closeMrModal(); return true; }
  return false;
}
function closeAgModal() { $('agModal')?.classList.add('hidden'); agPick = { rid:null, sel:{}, override:false }; }
function closeMrModal() { $('mrModal')?.classList.add('hidden'); }

function bindDrawerGames(rid) {
  const body = $('drawerBody');
  body.querySelectorAll('[data-rm-game]').forEach(btn =>
    btn.addEventListener('click', () => removeStudentGame(rid, Number(btn.dataset.rmGame))));
  const add = body.querySelector('#dwAddGameBtn');
  if (add) add.addEventListener('click', () => openAddGameModal(rid));
}
function openAddGameModal(rid) {
  const r = regs[rid]; if (!r) return;
  agPick = { rid, sel:{}, override:false };
  $('agTitle').innerHTML = `🎪 Add games 新增遊戲 — ${escapeHtml(r.studentName || '')} <span class="grade-chip band-${gradeBand(r.grade)}">${escapeHtml(r.grade || '')}</span>`;
  renderPicker($('agPicker'), agPick, r.grade, r.selections || [], 'add');
  const btn = $('agSave'); btn.disabled = false; btn.textContent = '＋ Add selected 新增所選';
  $('agModal').classList.remove('hidden');
}
async function commitAddGames() {
  const rid = agPick.rid;
  const r = regs[rid];
  if (!rid || !r) { closeAgModal(); return; }
  const eid = currentEventId;
  const list = Object.entries(agPick.sel)
    .map(([gid, sid]) => ({ gid, sid, g:games[gid], s:games[gid]?.slots?.[sid] }))
    .filter(x => x.g && x.s);
  if (!list.length) return showToast('Pick at least one game & slot 請選擇遊戲及時段', 'error');
  if (!agPick.override) {
    const bad = list.find(x => !gradeInRange(r.grade, x.g.minGrade, x.g.maxGrade));
    if (bad) return showToast(`"${bad.g.name || bad.g.nameCn}" is not open to ${r.grade} — tick override to add anyway 年級不符，如仍要新增請勾選忽略限制`, 'error');
  }
  if (pickerConflicts(agPick, r.selections || []).length) return showToast('Selected slots overlap in time 所選時段時間重疊', 'error');
  const btn = $('agSave'); btn.disabled = true; btn.textContent = '⏳ Adding… 新增中';
  const done = [];
  const prevSels = JSON.parse(JSON.stringify(r.selections || []));
  try {
    for (const { gid, sid, g, s } of list) {
      const ok = await claimSlotCount(eid, gid, sid, Number(s.capacity) || 0);
      if (!ok) {
        await releaseClaims(eid, done);
        showToast(`"${g.name || g.nameCn}" ${slotFullLabel(s)} just filled up 剛已額滿 — pick another 請另選`, 'error');
        refreshPickers();
        return;
      }
      done.push({ gid, sid });
    }
    const newSels = list.map(({ gid, sid, g, s }) => ({
      gameId:gid, slotId:sid, gameName:g.name || g.nameCn || '', date:s.date || '', start:s.start, end:s.end
    }));
    r.selections = [...prevSels, ...newSels];
    done.forEach(({ gid, sid }) => applyLocalCount(gid, sid, +1));
    renderAll();
    if (drawerRegId === rid) fillDrawer(rid);
    await runTransaction(
      ref(db, `boothEvents/${eid}/registrations/${rid}/selections`),
      cur => {
        const arr = Array.isArray(cur) ? cur : [];
        const have = new Set(arr.map(s => s && s.gameId));
        newSels.forEach(s => { if (!have.has(s.gameId)) arr.push(s); });
        return arr;
      },
      { applyLocally:false }
    );
    closeAgModal();
    showToast(`🎪 Added ${done.length} game(s) to ${r.studentName || ''} 已新增遊戲`, 'success');
  } catch (err) {
    r.selections = prevSels;
    done.forEach(({ gid, sid }) => applyLocalCount(gid, sid, -1));
    await releaseClaims(eid, done);
    renderAll();
    if (drawerRegId === rid) fillDrawer(rid);
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '＋ Add selected 新增所選';
  }
}
async function removeStudentGame(rid, idx) {
  const r = regs[rid];
  const sel = r?.selections?.[idx];
  if (!r || !sel) return;
  const eid = currentEventId;
  const g = games[sel.gameId];
  const label = `${g?.emoji || '🎮'} ${sel.gameName || g?.name || ''} · ${slotFullLabel(sel)}`;
  if (!confirm(`Remove ${label} from ${r.studentName || ''}? The seat is released. 移除此遊戲並釋放名額？`)) return;
  const prevSels = JSON.parse(JSON.stringify(r.selections || []));
  const prevResult = r.results?.[sel.gameId] ? JSON.parse(JSON.stringify(r.results[sel.gameId])) : null;
  const nextSels = prevSels.filter((_, i) => i !== idx);
  r.selections = nextSels;
  if (r.results) delete r.results[sel.gameId];
  const tk = resKey(rid, sel.gameId);
  if (resTimers[tk]) { delete resTimers[tk]; resEnsureTick(); }
  if (resEdits[rid]) delete resEdits[rid][sel.gameId];
  applyLocalCount(sel.gameId, sel.slotId, -1);
  renderAll();
  if (drawerRegId === rid) fillDrawer(rid);
  const updates = {};
  updates[`boothEvents/${eid}/registrations/${rid}/selections`] = nextSels.length ? nextSels : null;
  updates[`boothEvents/${eid}/registrations/${rid}/results/${sel.gameId}`] = null;
  try {
    await update(ref(db), updates);
    try { await bumpSlotCount(eid, sel.gameId, sel.slotId, -1); } catch (e) { console.error('Seat release failed:', e); }
    showToast('🗑 Removed — seat released 已移除並釋放名額', 'info', {
      label:'Undo 復原',
      fn: async () => {
        const cap = Number(games[sel.gameId]?.slots?.[sel.slotId]?.capacity) || 0;
        let ok = false;
        try { ok = await claimSlotCount(eid, sel.gameId, sel.slotId, cap); } catch {}
        if (!ok) return showToast('That slot is full now — cannot restore 該場次已額滿，無法復原', 'error');
        const cur = regs[rid];
        if (!cur) {
          try { await bumpSlotCount(eid, sel.gameId, sel.slotId, -1); } catch {}
          return showToast('Registration no longer exists 報名已不存在', 'error');
        }
        const arr = [...(cur.selections || [])];
        if (!arr.some(s => s && s.gameId === sel.gameId)) arr.splice(Math.min(idx, arr.length), 0, sel);
        const up = {};
        up[`boothEvents/${eid}/registrations/${rid}/selections`] = arr;
        if (prevResult) up[`boothEvents/${eid}/registrations/${rid}/results/${sel.gameId}`] = prevResult;
        try {
          await update(ref(db), up);
          cur.selections = arr;
          if (prevResult) { cur.results = cur.results || {}; cur.results[sel.gameId] = prevResult; }
          applyLocalCount(sel.gameId, sel.slotId, +1);
          renderAll();
          if (drawerRegId === rid) fillDrawer(rid);
          showToast('↩ Game restored 已復原', 'success');
        } catch (err) {
          try { await bumpSlotCount(eid, sel.gameId, sel.slotId, -1); } catch {}
          showToast(`Error: ${err.message}`, 'error');
        }
      }
    });
  } catch (err) {
    r.selections = prevSels;
    if (prevResult) { r.results = r.results || {}; r.results[sel.gameId] = prevResult; }
    applyLocalCount(sel.gameId, sel.slotId, +1);
    renderAll();
    if (drawerRegId === rid) fillDrawer(rid);
    showToast(`Error: ${err.message}`, 'error');
  }
}
function openManualModal() {
  if (!currentEventId || creatingNew) return showToast('Select an event first 請先選擇活動', 'error');
  mrState = { apps:{ wechat:false, whatsapp:false }, current:'no', interests:new Set() };
  mrPick = { sel:{}, override:false };
  ['mrName','mrSchool','mrBirth','mrPhone','mrWeChatId','mrCenter','mrSubjects','mrRemarks'].forEach(id => { $(id).value = ''; $(id).classList.remove('invalid'); });
  $('mrGrade').value = '';
  $('mrGrade').classList.remove('invalid');
  $('mrBirth').max = localDateStr();
  $('mrAgeHint').textContent = 'Optional — age is calculated automatically 選填 — 自動計算年齡';
  $('mrAgeHint').classList.remove('has-age');
  syncMrToggles();
  renderMrInterests();
  renderPicker($('mrPicker'), mrPick, '', [], 'manual');
  const btn = $('mrSave'); btn.disabled = false; btn.textContent = '💾 Register student 登記學生';
  $('mrModal').classList.remove('hidden');
  setTimeout(() => $('mrName').focus(), 60);
}
function syncMrToggles() {
  $('mrAppWeChat').classList.toggle('selected', mrState.apps.wechat);
  $('mrAppWhatsApp').classList.toggle('selected', mrState.apps.whatsapp);
  $('mrWeChatWrap').classList.toggle('hidden', !mrState.apps.wechat);
  $('mrCurYes').classList.toggle('selected', mrState.current === 'yes');
  $('mrCurNo').classList.toggle('selected', mrState.current === 'no');
  $('mrCurDetails').classList.toggle('hidden', mrState.current !== 'yes');
}
function renderMrInterests() {
  const wrap = $('mrInterests');
  wrap.innerHTML = INTERESTS.map(o =>
    `<button type="button" class="mr-chip${mrState.interests.has(o.id) ? ' selected' : ''}" data-mr-int="${o.id}" title="${escapeHtml(o.en)}">${escapeHtml(o.cn)}</button>`).join('');
  wrap.querySelectorAll('[data-mr-int]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.mrInt;
    const o = INTERESTS.find(x => x.id === id);
    if (o?.exclusive) {
      if (mrState.interests.has(id)) mrState.interests.delete(id);
      else { mrState.interests.clear(); mrState.interests.add(id); }
    } else {
      INTERESTS.filter(x => x.exclusive).forEach(x => mrState.interests.delete(x.id));
      if (mrState.interests.has(id)) mrState.interests.delete(id); else mrState.interests.add(id);
    }
    renderMrInterests();
  }));
}
async function commitManualReg() {
  if (!currentEventId || creatingNew) return;
  const eid = currentEventId;
  const name = $('mrName').value.trim();
  const grade = $('mrGrade').value;
  const birth = $('mrBirth').value;
  const phone = $('mrPhone').value.trim();
  if (!name) { $('mrName').classList.add('invalid'); $('mrName').focus(); return showToast('Enter the student name 請填寫學生姓名', 'error'); }
  if (!grade) { $('mrGrade').classList.add('invalid'); return showToast('Choose the grade 請選擇年級', 'error'); }
  if (birth && !calcAge(birth)) { $('mrBirth').classList.add('invalid'); return showToast('Birthday is not valid 出生日期無效', 'error'); }
  if (phone && !validPhone(phone)) { $('mrPhone').classList.add('invalid'); return showToast('Phone number is not valid 電話號碼無效', 'error'); }
  if (mrState.current === 'yes') {
    if (!$('mrCenter').value.trim()) { $('mrCenter').classList.add('invalid'); return showToast('Enter the current center 請填寫教室', 'error'); }
    if (!$('mrSubjects').value.trim()) { $('mrSubjects').classList.add('invalid'); return showToast('Enter the current subject(s) 請填寫科目', 'error'); }
  }
  const list = Object.entries(mrPick.sel)
    .map(([gid, sid]) => ({ gid, sid, g:games[gid], s:games[gid]?.slots?.[sid] }))
    .filter(x => x.g && x.s);
  if (!mrPick.override) {
    const bad = list.find(x => !gradeInRange(grade, x.g.minGrade, x.g.maxGrade));
    if (bad) return showToast(`"${bad.g.name || bad.g.nameCn}" is not open to ${grade} — tick override to add anyway 年級不符，如仍要新增請勾選忽略限制`, 'error');
  }
  if (pickerConflicts(mrPick, []).length) return showToast('Selected slots overlap in time 所選時段時間重疊', 'error');
  const btn = $('mrSave'); btn.disabled = true; btn.textContent = '⏳ Registering… 登記中';
  const done = [];
  let newId = null;
  try {
    for (const { gid, sid, g, s } of list) {
      const ok = await claimSlotCount(eid, gid, sid, Number(s.capacity) || 0);
      if (!ok) {
        await releaseClaims(eid, done);
        showToast(`"${g.name || g.nameCn}" ${slotFullLabel(s)} just filled up 剛已額滿 — pick another 請另選`, 'error');
        refreshPickers();
        return;
      }
      done.push({ gid, sid });
    }
    const seq = await claimSeq(eid);
    if (!seq) {
      await releaseClaims(eid, done);
      showToast('This event has reached its 999-registration limit 已達 999 個報名上限', 'error');
      return;
    }
    const a = birth ? calcAge(birth) : null;
    const reg = {
      seq, code:'BG-' + randomCode(6),
      studentName:name, grade,
      school:$('mrSchool').value.trim(),
      birthday:birth || '',
      ageYears:a ? a.years : null, ageMonths:a ? a.months : null,
      parentPhone:normalizePhone(phone),
      contactApps:{ wechat:!!mrState.apps.wechat, whatsapp:!!mrState.apps.whatsapp },
      wechatId:mrState.apps.wechat ? $('mrWeChatId').value.trim() : '',
      isCurrentStudent:mrState.current,
      currentCenter:mrState.current === 'yes' ? $('mrCenter').value.trim() : '',
      currentSubjects:mrState.current === 'yes' ? $('mrSubjects').value.trim() : '',
      interests:[...mrState.interests],
      selections:list.map(({ gid, sid, g, s }) => ({
        gameId:gid, slotId:sid, gameName:g.name || g.nameCn || '', date:s.date || '', start:s.start, end:s.end
      })),
      remarks:$('mrRemarks').value.trim(),
      status:'registered', submittedAt:new Date().toISOString(),
      source:'manual', createdBy:auth.currentUser?.email || ''
    };
    newId = uid('r');
    regs[newId] = reg;
    done.forEach(({ gid, sid }) => applyLocalCount(gid, sid, +1));
    renderAll();
    await update(ref(db), { [`boothEvents/${eid}/registrations/${newId}`]: reg });
    closeMrModal();
    showToast(`✅ ${name} registered · ID ${regIdLabel(seq)} 已手動登記`, 'success');
    switchTab('regs');
    openDrawer(newId);
  } catch (err) {
    if (newId) delete regs[newId];
    done.forEach(({ gid, sid }) => applyLocalCount(gid, sid, -1));
    await releaseClaims(eid, done);
    renderAll();
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '💾 Register student 登記學生';
  }
}
(function buildManualModals() {
  if (document.getElementById('mrModal')) return;
  const gradeOpts = '<option value="">Grade 年級…</option>' + GRADES.map(g => `<option value="${g}">${escapeHtml(gradeLabel(g))}</option>`).join('');
  const mr = document.createElement('div');
  mr.id = 'mrModal'; mr.className = 'modal hidden';
  mr.innerHTML =
    `<div class="modal-box mr-box">` +
    `<div class="mr-head"><h3>＋ Register student 手動登記</h3><button type="button" class="close-btn" id="mrClose">✕</button></div>` +
    `<div class="mr-body">` +
    `<p class="hint">Walk-in or phone sign-up — bypasses the public form. Games are optional and can be added later. 現場或電話登記 — 無需公開表單；遊戲可稍後新增。</p>` +
    `<div class="mr-grid">` +
    `<div class="mr-field span2"><label>Student name 學生姓名 *</label><input id="mrName" type="text" maxlength="60" placeholder="Chan Tai Man 陳大文"></div>` +
    `<div class="mr-field"><label>Grade 年級 *</label><select id="mrGrade">${gradeOpts}</select></div>` +
    `<div class="mr-field"><label>Birthday 生日 <span class="mr-opt">(optional 選填)</span></label><input id="mrBirth" type="date"><span class="mr-sub" id="mrAgeHint">Optional — age is calculated automatically 選填 — 自動計算年齡</span></div>` +
    `<div class="mr-field"><label>School 學校 <span class="mr-opt">(optional 選填)</span></label><input id="mrSchool" type="text" maxlength="80"></div>` +
    `<div class="mr-field"><label>Parent phone 家長電話 <span class="mr-opt">(optional 選填)</span></label><input id="mrPhone" type="tel" maxlength="20" placeholder="6612 3456"></div>` +
    `<div class="mr-field span2"><label>Contact apps 聯絡方式</label><div class="mr-chips"><button type="button" class="mr-chip" id="mrAppWeChat">💬 WeChat 微信</button><button type="button" class="mr-chip" id="mrAppWhatsApp">📱 WhatsApp</button></div></div>` +
    `<div class="mr-field span2 hidden" id="mrWeChatWrap"><label>WeChat ID 微信號</label><input id="mrWeChatId" type="text" maxlength="60"></div>` +
    `<div class="mr-field span2"><label>Current Kumon student? 目前在讀公文式？</label><div class="mr-chips"><button type="button" class="mr-chip" id="mrCurYes">✅ Yes 是</button><button type="button" class="mr-chip" id="mrCurNo">🌱 No 否</button></div></div>` +
    `<div class="mr-field span2 hidden" id="mrCurDetails"><div class="mr-grid inner"><div class="mr-field"><label>Center 教室 *</label><input id="mrCenter" type="text" maxlength="60"></div><div class="mr-field"><label>Subject(s) 科目 *</label><input id="mrSubjects" type="text" maxlength="60"></div></div></div>` +
    `<div class="mr-field span2"><label>Subjects of interest 想了解科目 <span class="mr-opt">(optional 選填)</span></label><div class="mr-chips" id="mrInterests"></div></div>` +
    `<div class="mr-field span2"><label>Remarks 備註 <span class="mr-opt">(optional 選填)</span></label><textarea id="mrRemarks" rows="2" maxlength="300"></textarea></div>` +
    `</div>` +
    `<div class="mr-sec">🎪 Games & time slots 遊戲與時段 <span class="mr-opt">(optional — can be added later 可稍後新增)</span></div>` +
    `<div id="mrPicker"></div>` +
    `</div>` +
    `<div class="mr-foot"><button type="button" class="btn ghost" id="mrCancel">✖ Cancel 取消</button><button type="button" class="btn primary" id="mrSave">💾 Register student 登記學生</button></div>` +
    `</div>`;
  document.body.appendChild(mr);
  const ag = document.createElement('div');
  ag.id = 'agModal'; ag.className = 'modal hidden';
  ag.innerHTML =
    `<div class="modal-box mr-box">` +
    `<div class="mr-head"><h3 id="agTitle">🎪 Add games 新增遊戲</h3><button type="button" class="close-btn" id="agClose">✕</button></div>` +
    `<div class="mr-body"><p class="hint">Pick one slot per game. Full slots are locked; seats update live. 每項遊戲選一個時段；額滿場次已鎖定，名額即時更新。</p><div id="agPicker"></div></div>` +
    `<div class="mr-foot"><button type="button" class="btn ghost" id="agCancel">✖ Cancel 取消</button><button type="button" class="btn primary" id="agSave">＋ Add selected 新增所選</button></div>` +
    `</div>`;
  document.body.appendChild(ag);
  mr.addEventListener('click', e => { if (e.target === mr) closeMrModal(); });
  ag.addEventListener('click', e => { if (e.target === ag) closeAgModal(); });
  $('mrClose').addEventListener('click', closeMrModal);
  $('mrCancel').addEventListener('click', closeMrModal);
  $('agClose').addEventListener('click', closeAgModal);
  $('agCancel').addEventListener('click', closeAgModal);
  $('mrSave').addEventListener('click', commitManualReg);
  $('agSave').addEventListener('click', commitAddGames);
  $('mrAppWeChat').addEventListener('click', () => { mrState.apps.wechat = !mrState.apps.wechat; syncMrToggles(); });
  $('mrAppWhatsApp').addEventListener('click', () => { mrState.apps.whatsapp = !mrState.apps.whatsapp; syncMrToggles(); });
  $('mrCurYes').addEventListener('click', () => { mrState.current = 'yes'; syncMrToggles(); });
  $('mrCurNo').addEventListener('click', () => { mrState.current = 'no'; syncMrToggles(); });
  $('mrGrade').addEventListener('change', () => {
    $('mrGrade').classList.remove('invalid');
    renderPicker($('mrPicker'), mrPick, $('mrGrade').value, [], 'manual');
  });
  $('mrBirth').addEventListener('input', () => {
    $('mrBirth').classList.remove('invalid');
    const a = calcAge($('mrBirth').value);
    $('mrAgeHint').textContent = a ? `🎂 ${a.years}y ${a.months}m · ${a.years}歲${a.months}個月` : 'Optional — age is calculated automatically 選填 — 自動計算年齡';
    $('mrAgeHint').classList.toggle('has-age', !!a);
  });
  ['mrName','mrPhone','mrCenter','mrSubjects'].forEach(id => $(id).addEventListener('input', () => $(id).classList.remove('invalid')));
  const exportBtn = document.getElementById('exportRegsBtn');
  if (exportBtn && !document.getElementById('addStudentBtn')) {
    const b = document.createElement('button');
    b.id = 'addStudentBtn'; b.type = 'button'; b.className = 'btn primary';
    b.textContent = '＋ Add student 手動登記';
    b.addEventListener('click', openManualModal);
    exportBtn.insertAdjacentElement('beforebegin', b);
  }
})();

// ============================================
// EXCEL EXPORT
// ============================================
function exportExcel(ids) {
  if (typeof XLSX === 'undefined') return showToast('SheetJS (XLSX) not loaded', 'error');
  const list = (ids || Object.keys(regs)).map(id => regs[id]).filter(Boolean)
    .sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')));
  if (!list.length) return showToast('No registrations to export 沒有可匯出的報名', 'error');
  const wb = XLSX.utils.book_new();
  const rows = list.map(r => ({
    'ID 編號': regIdLabel(r.seq),
    'Code 編號': r.code || '',
    'Student 學生': r.studentName || '',
    'Grade 年級': r.grade || '',
    'School 學校': r.school || '',
    'Birthday 生日': r.birthday || '',
    'Age 年齡': r.ageYears ?? '',
    'Phone 電話': r.parentPhone || '',
    'WeChat': r.contactApps?.wechat ? 'Y' : '',
    'WhatsApp': r.contactApps?.whatsapp ? 'Y' : '',
    'WeChat ID': r.wechatId || '',
    'Current Student 現讀': r.isCurrentStudent === 'yes' ? 'Yes' : 'No',
    'Center 教室': r.currentCenter || '',
    'Current Subjects 科目': r.currentSubjects || '',
    'Interested 興趣': normalizeInterests(r.interests).map(interestLabel).join('; '),
    'Games & Slots 遊戲場次': (r.selections || []).map(s => `${s.gameName || games[s.gameId]?.name || ''} ${slotFullLabel(s)}`).join('; '),
    'Status 狀態': r.status || 'registered',
    'Submitted 提交': r.submittedAt || '',
    'Remarks 備註': r.remarks || ''
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch:8 },{ wch:12 },{ wch:20 },{ wch:8 },{ wch:26 },{ wch:12 },{ wch:6 },{ wch:15 },{ wch:8 },{ wch:10 },{ wch:16 },{ wch:12 },{ wch:22 },{ wch:20 },{ wch:50 },{ wch:60 },{ wch:11 },{ wch:22 },{ wch:30 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Registrations');

  Object.entries(games).forEach(([gid, g]) => {
    const roster = [];
    list.forEach(r => (r.selections || []).filter(s => s.gameId === gid).forEach(s => roster.push({
      'Date 日期': s.date || '',
      'Slot 場次': slotLabel(s),
      'ID 編號': regIdLabel(r.seq), 'Code 編號': r.code || '', 'Student 學生': r.studentName || '', 'Grade 年級': r.grade || '',
      'School 學校': r.school || '', 'Age 年齡': r.ageYears ?? '', 'Phone 電話': r.parentPhone || '',
      'Current 現讀': r.isCurrentStudent === 'yes' ? 'Yes' : 'No', 'Status 狀態': r.status || 'registered'
    })));
    if (!roster.length) return;
    roster.sort((a, b) => String(a['Date 日期']).localeCompare(String(b['Date 日期'])) || String(a['Slot 場次']).localeCompare(String(b['Slot 場次'])) || String(a['Student 學生']).localeCompare(String(b['Student 學生']), 'zh-Hant'));
    const ws2 = XLSX.utils.json_to_sheet(roster);
    ws2['!cols'] = [{ wch:12 },{ wch:14 },{ wch:8 },{ wch:12 },{ wch:20 },{ wch:8 },{ wch:26 },{ wch:6 },{ wch:15 },{ wch:10 },{ wch:11 }];
    const name = `${g.name || g.nameCn || 'Game'}`.replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws2, name);
  });

  XLSX.writeFile(wb, `BoothGames_${slugify(config.title || config.titleCn)}_${localDateStr()}.xlsx`);
  showToast(`📊 Exported ${list.length} registration(s) 已匯出`, 'success');
}

// ============================================
// BUILDER
// ============================================
function defaultDraft() {
  const today = localDateStr();
  const regEnd = localDateStr(new Date(Date.now() + 14 * 86400000));
  const eventDay = localDateStr(new Date(Date.now() + 21 * 86400000));
  return {
    dirty:false,
    config:{
      title:'', titleCn:'', description:'',
      eventStart:eventDay, eventEnd:eventDay, timeText:'',
      venueEn:'', venueCn:'',
      regStart:today, regEnd:regEnd, isActive:true,
      bannerPreset:'fiesta', bannerDataUrl:null
    },
    games:{ [uid('g')]:{ name:'', nameCn:'', emoji:'🎯', minGrade:'K0', maxGrade:'F6', color:PALETTE[0],
      slots:{ [uid('s')]:{ date:eventDay, start:'14:00', end:'14:20', capacity:10 } } } }
  };
}

function snapshotDraft() {
  return { dirty:false, config:JSON.parse(JSON.stringify(config || {})), games:JSON.parse(JSON.stringify(games || {})) };
}

function renderBuilder(force = false) {
  if (!creatingNew && !loaded.config) return;
  const key = draftKey();
  let d = drafts[key];
  if (!d) { d = drafts[key] = creatingNew ? defaultDraft() : snapshotDraft(); force = true; }
  $('builderNewHint').classList.toggle('hidden', !creatingNew);
  $('draftChip').classList.toggle('hidden', !d.dirty);
  if (!force) return;
  $('bTitle').value = d.config.title || '';  $('bTitleCn').value = d.config.titleCn || '';
  $('bDesc').value = d.config.description || '';
  $('bEventStart').value = d.config.eventStart || '';
  $('bEventEnd').value = d.config.eventEnd || '';
  $('bTimeText').value = d.config.timeText || '';
  $('bVenueEn').value = d.config.venueEn || '';
  $('bVenueCn').value = d.config.venueCn || '';
  $('bRegStart').value = d.config.regStart || '';
  $('bRegEnd').value = d.config.regEnd || '';
  $('bActive').value = String(d.config.isActive !== false);
  renderPresetRow(d);
  renderBannerPreview(d);
  renderGamesEditor(d);
}

function renderPresetRow(d) {
  const row = $('presetRow');
  row.innerHTML = '';
  BANNERS.forEach(b => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'preset-swatch' + (d.config.bannerPreset === b.id && !d.config.bannerDataUrl ? ' selected' : '');
    sw.style.background = bannerCss(b.id);
    sw.title = b.label;
    sw.addEventListener('click', () => {
      d.config.bannerPreset = b.id; d.config.bannerDataUrl = null; d.dirty = true;
      $('draftChip').classList.remove('hidden');
      renderPresetRow(d); renderBannerPreview(d);
    });
    row.appendChild(sw);
  });
}

function renderBannerPreview(d) {
  const p = $('bannerPreview');
  p.style.background = d.config.bannerDataUrl ? `url(${d.config.bannerDataUrl}) center/cover` : bannerCss(d.config.bannerPreset);
  p.innerHTML = `<div><div class="bp-title">${escapeHtml(d.config.title || 'Your event title 活動名稱')}</div><div class="bp-cn">${escapeHtml(d.config.titleCn || '')}</div></div>`;
}

async function handleBannerUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const d = drafts[draftKey()]; if (!d) return;
  try {
    const dataUrl = await compressBanner(file);
    d.config.bannerDataUrl = dataUrl; d.dirty = true;
    $('draftChip').classList.remove('hidden');
    renderPresetRow(d); renderBannerPreview(d);
    showToast('🖼️ Banner ready — press Save to apply 按儲存以套用', 'success');
  } catch (err) { showToast(`Image error: ${err.message}`, 'error'); }
  e.target.value = '';
}

function compressBanner(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const W = 1600, H = 520;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        const sw = W / scale, sh = H / scale;
        const sx = (img.naturalWidth - sw) / 2, sy = (img.naturalHeight - sh) / 2;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch (err) { reject(err); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

function renderGamesEditor(d) {
  const wrap = $('gamesList');
  wrap.innerHTML = '';
  const gradeOpts = sel => GRADES.map(g => `<option value="${g}" ${g === sel ? 'selected' : ''}>${gradeLabel(g)}</option>`).join('');
  const minD = d.config.eventStart || '';
  const maxD = d.config.eventEnd || d.config.eventStart || '';
  Object.entries(d.games).forEach(([gid, g]) => {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.style.setProperty('--gc', g.color || PALETTE[0]);
    card.innerHTML =
      `<div class="game-head">` +
        `<select class="emoji-pick">${GAME_EMOJIS.map(e => `<option value="${e}" ${e === g.emoji ? 'selected' : ''}>${e}</option>`).join('')}</select>` +
        `<input type="color" class="g-color" value="${escapeHtml(g.color || PALETTE[0])}" title="Game colour">` +
        `<input class="g-name" type="text" placeholder="Game name (English)" value="${escapeHtml(g.name || '')}">` +
        `<input class="g-name-cn" type="text" placeholder="遊戲名稱（中文）" value="${escapeHtml(g.nameCn || '')}">` +
        `<button type="button" class="btn-small secondary g-dup">⧉</button>` +
        `<button type="button" class="btn-small danger g-del">🗑</button>` +
      `</div>` +
      `<div class="game-range">Allowed grades 限年級 <select class="g-min">${gradeOpts(g.minGrade)}</select> → <select class="g-max">${gradeOpts(g.maxGrade)}</select> <span class="range-chip g-range-preview">${escapeHtml(rangeLabel(g.minGrade, g.maxGrade))}</span></div>` +
      `<div class="g-slots"></div>` +
      `<button type="button" class="btn-small primary g-add-slot">＋ Add time slot 新增時段</button>`;
    const dirty = () => { d.dirty = true; $('draftChip').classList.remove('hidden'); };

    card.querySelector('.emoji-pick').addEventListener('input', e => { g.emoji = e.target.value; dirty(); });
    card.querySelector('.g-color').addEventListener('input', e => { g.color = e.target.value; card.style.setProperty('--gc', g.color); dirty(); });
    card.querySelector('.g-name').addEventListener('input', e => { g.name = e.target.value; dirty(); });
    card.querySelector('.g-name-cn').addEventListener('input', e => { g.nameCn = e.target.value; dirty(); });
    card.querySelector('.g-min').addEventListener('input', e => { g.minGrade = e.target.value; card.querySelector('.g-range-preview').textContent = rangeLabel(g.minGrade, g.maxGrade); dirty(); });
    card.querySelector('.g-max').addEventListener('input', e => { g.maxGrade = e.target.value; card.querySelector('.g-range-preview').textContent = rangeLabel(g.minGrade, g.maxGrade); dirty(); });
    card.querySelector('.g-dup').addEventListener('click', () => {
      const copy = JSON.parse(JSON.stringify(g));
      copy.name = (copy.name || '') + ' (Copy)';
      const newSlots = {};
      Object.values(copy.slots || {}).forEach(s => { newSlots[uid('s')] = s; });
      copy.slots = newSlots;
      d.games[uid('g')] = copy; dirty(); renderGamesEditor(d);
    });
    card.querySelector('.g-del').addEventListener('click', () => {
      const used = Object.values(regs).filter(r => (r.selections || []).some(s => s.gameId === gid)).length;
      const msg = used
        ? `⚠️ ${used} registration(s) already picked this game. Delete it anyway? 已有報名選擇此遊戲，仍要刪除？`
        : 'Delete this game? 刪除此遊戲？';
      if (!confirm(msg)) return;
      delete d.games[gid]; dirty(); renderGamesEditor(d);
    });
    card.querySelector('.g-add-slot').addEventListener('click', () => {
      const sorted = Object.values(g.slots || {}).sort((a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) || String(a.start).localeCompare(String(b.start)));
      const last = sorted[sorted.length - 1];
      const date = (last && last.date) || d.config.eventStart || localDateStr();
      const start = (last && last.date === date && last.end) ? last.end : '14:00';
      g.slots = g.slots || {};
      g.slots[uid('s')] = { date, start, end:addMinutes(start, 60), capacity:(last && last.capacity) || 10 };
      dirty(); renderGamesEditor(d);
    });

    const slotsWrap = card.querySelector('.g-slots');
    Object.entries(g.slots || {})
      .sort((a, b) => String(a[1].date || '').localeCompare(String(b[1].date || '')) || String(a[1].start).localeCompare(String(b[1].start)))
      .forEach(([sid, s]) => {
        const booked = Number(counts[gid]?.[sid]) || 0;
        const row = document.createElement('div');
        row.className = 'slot-row';
        row.innerHTML =
          `<input type="date" class="s-date" value="${escapeHtml(s.date || '')}" min="${escapeHtml(minD)}" max="${escapeHtml(maxD)}" title="Slot date 場次日期">` +
          `<input type="time" class="s-start" value="${escapeHtml(s.start || '')}"> – ` +
          `<input type="time" class="s-end" value="${escapeHtml(s.end || '')}">` +
          `<label style="font-size:.8rem;font-weight:700;color:var(--muted)">Cap 名額</label>` +
          `<input type="number" class="s-cap" min="1" max="500" value="${Number(s.capacity) || 10}">` +
          `<button type="button" class="btn-small danger s-del">🗑</button>` +
          (booked ? `<span class="slot-booked">🎟️ ${booked} booked 已報名</span>` : '');
        row.querySelector('.s-date').addEventListener('input', e => { s.date = e.target.value; dirty(); });
        row.querySelector('.s-start').addEventListener('input', e => { s.start = e.target.value; dirty(); });
        row.querySelector('.s-end').addEventListener('input', e => { s.end = e.target.value; dirty(); });
        row.querySelector('.s-cap').addEventListener('input', e => { s.capacity = parseInt(e.target.value) || 1; dirty(); });
        row.querySelector('.s-del').addEventListener('click', () => {
          if (booked && !confirm(`⚠️ ${booked} student(s) booked this slot. Delete anyway? 此場次已有報名，仍要刪除？`)) return;
          delete g.slots[sid]; dirty(); renderGamesEditor(d);
        });
        slotsWrap.appendChild(row);
      });
    wrap.appendChild(card);
  });
  if (!Object.keys(d.games).length) wrap.innerHTML = '<p class="hint">No games yet — press “Add game”. 請按「Add game」新增遊戲。</p>';
}

function addMinutes(hhmm, mins) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + mins);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function validateDraft(d) {
  const errs = [];
  if (!String(d.config.title || '').trim() && !String(d.config.titleCn || '').trim()) errs.push('Event title is required 請填寫活動名稱');
  if (!d.config.eventStart || !d.config.eventEnd) errs.push('Set the event start and end dates 請設定活動開始及結束日期');
  else if (d.config.eventStart > d.config.eventEnd) errs.push('Event end date must be on/after the start date 結束日不可早於開始日');
  if (!d.config.regStart || !d.config.regEnd) errs.push('Set the registration window (from / to dates) 請設定報名日期');
  else if (d.config.regStart > d.config.regEnd) errs.push('Registration end date must be on/after the start date 截止日不可早於開始日');
  const gEntries = Object.entries(d.games);
  if (!gEntries.length) errs.push('Add at least one game 請新增至少一項遊戲');
  gEntries.forEach(([, g]) => {
    const label = g.name || g.nameCn || 'Untitled game';
    if (!String(g.name || '').trim() && !String(g.nameCn || '').trim()) errs.push('Every game needs a name 每項遊戲需要名稱');
    if (gradeIdx(g.minGrade) > gradeIdx(g.maxGrade)) errs.push(`"${label}": min grade is above max grade 年級範圍無效`);
    const slots = Object.values(g.slots || {});
    if (!slots.length) errs.push(`"${label}": add at least one time slot 請新增時段`);
    slots.forEach(s => {
      if (!s.date) errs.push(`"${label}": every time slot needs a date 每個時段需設定日期`);
      else if (d.config.eventStart && d.config.eventEnd && (s.date < d.config.eventStart || s.date > d.config.eventEnd))
        errs.push(`"${label}": slot on ${s.date} is outside the event dates 時段日期超出活動日期`);
      if (!s.start || !s.end || s.start >= s.end) errs.push(`"${label}": slot times must be valid (end after start) 時段時間無效`);
      if (!(Number(s.capacity) >= 1)) errs.push(`"${label}": capacity must be at least 1 名額至少為 1`);
    });
  });
  return errs;
}

async function saveEvent() {
  const d = drafts[draftKey()];
  if (!d) return;
  const errs = validateDraft(d);
  if (errs.length) return showToast(`⚠️ ${errs[0]}${errs.length > 1 ? ` (+${errs.length - 1} more)` : ''}`, 'error');

  if (!creatingNew) {
    const warns = [];
    Object.entries(d.games).forEach(([gid, g]) => Object.entries(g.slots || {}).forEach(([sid, s]) => {
      const booked = Number(counts[gid]?.[sid]) || 0;
      if (booked > Number(s.capacity)) warns.push(`${g.name || g.nameCn}: ${slotFullLabel(s)} has ${booked} booked but capacity ${s.capacity}`);
    }));
    if (warns.length && !confirm(`⚠️ Capacity below existing bookings:\n${warns.join('\n')}\n\nSave anyway? 仍要儲存？`)) return;
  }

  const btn = $('saveEventBtn');
  btn.disabled = true;
  const now = new Date().toISOString();
  try {
    if (creatingNew) {
      const id = uid('bg');
      const code = await uniqueCode();
      const cfg = { ...d.config, shortCode:code, createdAt:now, updatedAt:now, createdBy:auth.currentUser?.email || '' };
      delete cfg.eventDate; delete cfg.venue;
      const updates = {};
      updates[`boothEvents/${id}/config`] = cfg;
      updates[`boothEvents/${id}/games`] = d.games;
      updates[`boothCodes/${code}`] = { eventId:id, createdAt:now };
      updates[`boothIndex/${id}`] = indexEntry(cfg);
      await update(ref(db), updates);
      delete drafts.__new;
      creatingNew = false;
      currentEventId = id;
      localStorage.setItem('booth_eventId', id);
      await refreshEventList();
      subscribeEvent(id);
      applyMode();
      switchTab('share');
      showToast('🎉 Event created! Share the link or QR 活動已建立，請分享連結', 'success');
    } else {
      const cfg = { ...d.config, shortCode:config.shortCode, createdAt:config.createdAt, createdBy:config.createdBy, updatedAt:now };
      delete cfg.eventDate; delete cfg.venue;
      const updates = {};
      updates[`boothEvents/${currentEventId}/config`] = cfg;
      updates[`boothEvents/${currentEventId}/games`] = d.games;
      updates[`boothIndex/${currentEventId}`] = indexEntry(cfg);
      Object.keys(counts).forEach(gid => {
        if (!d.games[gid]) updates[`boothEvents/${currentEventId}/counts/${gid}`] = null;
        else Object.keys(counts[gid] || {}).forEach(sid => {
          if (!d.games[gid].slots?.[sid]) updates[`boothEvents/${currentEventId}/counts/${gid}/${sid}`] = null;
        });
      });
      await update(ref(db), updates);
      config = normalizeEventConfig(cfg);
      games = normalizeGames(d.games, config);
      delete drafts[currentEventId];
      await refreshEventList();
      renderBuilder(true);
      renderAll();
      showToast('💾 Event saved 已儲存', 'success');
    }
  } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
  finally { btn.disabled = false; }
}

function cancelDraft() {
  const key = draftKey();
  const had = drafts[key]?.dirty;
  delete drafts[key];
  if (creatingNew) {
    creatingNew = false;
    applyMode();
    if (currentEventId) switchTab('dashboard'); else renderAll();
  } else {
    renderBuilder(true);
  }
  showToast(had ? '✖ Draft discarded — nothing was saved 已放棄草稿' : '✖ Editor reset 已重設', 'info');
}

function indexEntry(cfg) {
  return { title:cfg.title || '', titleCn:cfg.titleCn || '', shortCode:cfg.shortCode || '',
    isActive:cfg.isActive !== false, regStart:cfg.regStart || '', regEnd:cfg.regEnd || '',
    createdAt:cfg.createdAt || '', updatedAt:cfg.updatedAt || '' };
}

async function uniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = randomCode(6);
    const snap = await get(ref(db, `boothCodes/${code}`));
    if (!snap.exists()) return code;
  }
  return randomCode(9);
}

async function duplicateEvent() {
  if (!currentEventId || !loaded.config) return;
  if (!confirm('Duplicate this event (settings + games, without registrations)? 複製活動（不含報名紀錄）？')) return;
  try {
    const id = uid('bg');
    const code = await uniqueCode();
    const now = new Date().toISOString();
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.title = (cfg.title || cfg.titleCn || 'Event') + ' (Copy)';
    cfg.shortCode = code; cfg.createdAt = now; cfg.updatedAt = now;
    const gCopy = JSON.parse(JSON.stringify(games));
    const newGames = {};
    Object.values(gCopy).forEach(g => {
      const ns = {};
      Object.values(g.slots || {}).forEach(s => { ns[uid('s')] = s; });
      g.slots = ns;
      newGames[uid('g')] = g;
    });
    const updates = {};
    updates[`boothEvents/${id}/config`] = cfg;
    updates[`boothEvents/${id}/games`] = newGames;
    updates[`boothCodes/${code}`] = { eventId:id, createdAt:now };
    updates[`boothIndex/${id}`] = indexEntry(cfg);
    await update(ref(db), updates);
    currentEventId = id;
    localStorage.setItem('booth_eventId', id);
    await refreshEventList();
    subscribeEvent(id);
    applyMode(); switchTab('share');
    showToast('⧉ Event duplicated 已複製活動', 'success');
  } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

async function deleteEvent() {
  if (!currentEventId) return;
  const n = Object.keys(regs).length;
  if (!confirm(`⚠️ Delete "${config.title || currentEventId}" with ${n} registration(s), its public link and QR? 刪除此活動及所有報名？`)) return;
  if (!confirm('FINAL CONFIRM — this permanently erases the event. Continue? 最終確認：永久刪除？')) return;
  try {
    const updates = {};
    updates[`boothEvents/${currentEventId}`] = null;
    updates[`boothIndex/${currentEventId}`] = null;
    if (config.shortCode) updates[`boothCodes/${config.shortCode}`] = null;
    await update(ref(db), updates);
    delete drafts[currentEventId];
    unsubs.forEach(fn => fn()); unsubs = [];
    currentEventId = '';
    await refreshEventList();
    if (currentEventId) subscribeEvent(currentEventId);
    applyMode(); renderAll();
    showToast('🗑 Event deleted 已刪除活動', 'success');
  } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

// ============================================
// SHARE & QR
// ============================================
function publicUrl() {
  if (!config.shortCode) return '';
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}booth-register.html?f=${encodeURIComponent(config.shortCode)}`;
}

function shareMessage() {
  const title = [config.title, config.titleCn].filter(Boolean).join(' · ');
  const venues = venueLines(config).map(v => '📍 ' + v).join('\n');
  return `🎪 ${title}\n📅 ${eventRangeLabel(config)}${config.timeText ? ' · ' + config.timeText : ''}\n${venues}\n\n報名 Register here 請按連結報名:\n${publicUrl()}\n\n⏰ 截止 Deadline: ${fmtDate(config.regEnd, false)}`;
}

function renderShare() {
  const ready = !creatingNew && !!config.shortCode;
  const url = publicUrl();
  $('publicUrl').textContent = ready ? url : 'Save the event first to get a public link 請先儲存活動以取得連結';
  ['copyLinkBtn','waShareBtn','openLinkBtn','applyCodeBtn','regenCodeBtn','dlQrBtn','dlPosterBtn'].forEach(id => { $(id).disabled = !ready; });
  $('activeToggle').disabled = !ready;
  if (document.activeElement !== $('customCode')) $('customCode').value = config.shortCode || '';
  $('activeToggle').checked = config.isActive !== false;

  const wsEl = $('shareWindowState');
  if (ready) {
    const ws = windowState(config);
    const map = {
      open:['ws-open', `✅ Registration open 報名中 · ${fmtDate(config.regStart, false)} → ${fmtDate(config.regEnd, false)}${ws.daysLeft != null ? ` (${ws.daysLeft} days left 餘 ${ws.daysLeft} 日)` : ''}`],
      before:['ws-before', `⏳ Opens 開始於 ${fmtDate(config.regStart, false)} (${ws.days} days 倒數 ${ws.days} 日)`],
      after:['ws-after', `🌙 Registration closed 報名已結束 (${fmtDate(config.regEnd, false)})`],
      paused:['ws-paused', '⏸ Paused — the public form is not accepting registrations 已暫停報名'],
      invalid:['ws-paused', 'Set the registration dates in Form & Games 請設定報名日期']
    }[ws.state];
    wsEl.className = `window-state ${map[0]}`;
    wsEl.textContent = map[1];
  } else { wsEl.className = 'window-state ws-paused'; wsEl.textContent = '—'; }

  const qp = $('qrPreview');
  qp.innerHTML = '';
  if (ready) {
    const c = renderQrCanvas(url, 220);
    if (c) qp.appendChild(c);
    else qp.innerHTML = '<p class="hint">QR library failed to load — check the qrcode-generator script tag.</p>';
  } else qp.innerHTML = '<p class="hint">QR appears after the event is saved. 儲存後顯示二維碼。</p>';
}

async function applyCustomCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,14}$/.test(code)) return showToast('Code must be 4–14 letters/numbers 代碼須為 4–14 個字母或數字', 'error');
  if (code === config.shortCode) return showToast('That is already the current code 已是目前代碼', 'info');
  try {
    const snap = await get(ref(db, `boothCodes/${code}`));
    if (snap.exists() && snap.val().eventId !== currentEventId) return showToast('Code already in use — pick another 代碼已被使用', 'error');
    const updates = {};
    updates[`boothCodes/${code}`] = { eventId:currentEventId, createdAt:new Date().toISOString() };
    if (config.shortCode) updates[`boothCodes/${config.shortCode}`] = null;
    updates[`boothEvents/${currentEventId}/config/shortCode`] = code;
    updates[`boothIndex/${currentEventId}/shortCode`] = code;
    await update(ref(db), updates);
    config.shortCode = code;
    renderShare();
    showToast(`🔗 Short link updated 短連結已更新: ${code}`, 'success');
  } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

async function regenerateCode() {
  if (!confirm('Generate a new random code? The OLD link and printed QR will stop working. 舊連結及二維碼將會失效。')) return;
  try { await applyCustomCode(await uniqueCode()); }
  catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

function downloadQr() {
  const url = publicUrl(); if (!url) return;
  const size = parseInt($('qrSize').value) || 768;
  const c = renderQrCanvas(url, size);
  if (!c) return showToast('QR library not loaded', 'error');
  downloadDataUrl(c.toDataURL('image/png'), `BoothGames_QR_${config.shortCode}.png`);
  showToast('⬇ QR downloaded 已下載二維碼', 'success');
}

async function downloadPoster() {
  const url = publicUrl(); if (!url) return;
  const qr = renderQrCanvas(url, 440);
  if (!qr) return showToast('QR library not loaded', 'error');
  try {
    const W = 900, S = 2, M = 56, CW = W - M * 2;
    const FONT = "'Nunito','Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif";
    const cap = (lines, n) => lines.length > n ? lines.slice(0, n).map((l, i) => i === n - 1 ? l + '…' : l) : lines;

    const m = document.createElement('canvas').getContext('2d');
    m.font = '900 40px ' + FONT;
    const titleLines = cap(wrapLines(m, config.title || config.titleCn || 'Booth Games', CW), 2);
    m.font = '700 26px ' + FONT;
    const cnLines = (config.title && config.titleCn) ? cap(wrapLines(m, config.titleCn, CW), 2) : [];
    m.font = '600 20px ' + FONT;
    const dateText = '📅 ' + eventRangeLabel(config) + (config.timeText ? '   ·   ⏰ ' + config.timeText : '');
    const dateLines = cap(wrapLines(m, dateText, CW), 2);
    m.font = '600 18px ' + FONT;
    const venEnLines = config.venueEn ? cap(wrapLines(m, '📍 ' + config.venueEn, CW), 2) : [];
    const venCnLines = config.venueCn ? cap(wrapLines(m, config.venueCn, CW), 2) : [];

    const blocks = [{ lines:['🎪'], font:'56px ' + FONT, lh:64, gap:0, color:'#ffffff' }];
    blocks.push({ lines:titleLines, font:'900 40px ' + FONT, lh:48, gap:16, color:'#ffffff' });
    if (cnLines.length) blocks.push({ lines:cnLines, font:'700 26px ' + FONT, lh:34, gap:6, color:'rgba(255,255,255,.96)' });
    blocks.push({ lines:dateLines, font:'600 20px ' + FONT, lh:28, gap:16, color:'rgba(255,255,255,.96)' });
    if (venEnLines.length) blocks.push({ lines:venEnLines, font:'600 18px ' + FONT, lh:26, gap:12, color:'rgba(255,255,255,.93)' });
    if (venCnLines.length) blocks.push({ lines:venCnLines, font:'600 18px ' + FONT, lh:26, gap:4, color:'rgba(255,255,255,.93)' });

    let naturalH = 76;
    blocks.forEach(b => { naturalH += b.gap + b.lines.length * b.lh; });
    const headerH = Math.max(280, naturalH);
    const topPad = 40 + (headerH - naturalH) / 2;

    const cardY = headerH + 52, cardH = 520;
    const urlY = cardY + cardH + 46;
    const hintY = urlY + 48;
    const winY = hintY + 42;
    const footerY = winY + 56;
    const H = footerY + 72;

    const canvas = document.createElement('canvas');
    canvas.width = W * S; canvas.height = H * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);

    if (config.bannerDataUrl) {
      try {
        const img = await loadImg(config.bannerDataUrl);
        const sc = Math.max(W / img.naturalWidth, headerH / img.naturalHeight);
        const sw = W / sc, sh = headerH / sc;
        ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, W, headerH);
        ctx.fillStyle = 'rgba(12,20,38,.45)'; ctx.fillRect(0, 0, W, headerH);
      } catch { drawGradientHeader(ctx, W, headerH); }
    } else drawGradientHeader(ctx, W, headerH);

    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(10,18,36,.35)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    let y = topPad;
    blocks.forEach(b => {
      ctx.font = b.font;
      ctx.fillStyle = b.color;
      y += b.gap;
      b.lines.forEach(ln => { y += b.lh; ctx.fillText(ln, W / 2, y); });
    });
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    ctx.fillStyle = '#f2b100'; ctx.fillRect(0, headerH, W, 10);

    const cardX = 190, cardW = 520;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#dbe5f2'; ctx.lineWidth = 3;
    rr(ctx, cardX, cardY, cardW, cardH, 26); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#16233b';
    ctx.font = '900 26px ' + FONT;
    ctx.fillText('SCAN ME · 掃描報名', W / 2, cardY + 48);
    ctx.drawImage(qr, W / 2 - 200, cardY + 76, 400, 400);

    const u = url.replace(/^https?:\/\//, '');
    let uSize = 17;
    ctx.font = '600 ' + uSize + 'px "Courier New",monospace';
    while (ctx.measureText(u).width > CW && uSize > 11) {
      uSize--;
      ctx.font = '600 ' + uSize + 'px "Courier New",monospace';
    }
    ctx.fillStyle = '#5b6b84';
    ctx.fillText(u, W / 2, urlY);

    ctx.fillStyle = '#16233b';
    ctx.font = '900 28px ' + FONT;
    ctx.fillText('Scan to register · 掃描即時報名', W / 2, hintY);
    ctx.fillStyle = '#5b6b84';
    ctx.font = '700 19px ' + FONT;
    ctx.fillText('Registration 報名期: ' + fmtDate(config.regStart, false) + ' → ' + fmtDate(config.regEnd, false), W / 2, winY);

    ctx.fillStyle = '#16233b'; ctx.fillRect(0, footerY, W, 72);
    ctx.fillStyle = '#fff';
    ctx.font = '800 21px ' + FONT;
    ctx.fillText('Kumon Booth Games · 公文式攤位遊戲', W / 2, footerY + 44);
    ctx.textAlign = 'left';

    downloadDataUrl(canvas.toDataURL('image/png'), `BoothGames_Poster_${slugify(config.title || config.shortCode)}.png`);
    showToast('⬇ Poster downloaded 已下載海報', 'success');
  } catch (err) { showToast(`Poster error: ${err.message}`, 'error'); }
}

function drawGradientHeader(ctx, W, H) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  bannerStops(config.bannerPreset).forEach(([p, c]) => g.addColorStop(p, c));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

// ============================================
// DEMO EVENT
// ============================================
async function createDemoEvent() {
  if (!confirm('Create a sample event with demo registrations? It is a separate event you can delete anytime. 建立示範活動（可隨時刪除）？')) return;
  try {
    const id = uid('bg');
    const code = await uniqueCode();
    const now = new Date().toISOString();
    const day = n => localDateStr(new Date(Date.now() + n * 86400000));
    const gid = { toss:uid('g'), math:uid('g'), sci:uid('g'), art:uid('g') };
    const sid = {};
    const mkSlots = (key, arr) => { sid[key] = arr.map(() => uid('s')); const o = {}; arr.forEach((s, i) => { o[sid[key][i]] = s; }); return o; };
    const gamesSeed = {
      [gid.toss]:{ name:'Target Toss', nameCn:'拋彩虹', emoji:'🎯', minGrade:'K0', maxGrade:'P6', color:PALETTE[0],
        slots:mkSlots('toss', [
          { date:day(16), start:'14:00', end:'14:20', capacity:12 },
          { date:day(16), start:'14:20', end:'14:40', capacity:12 },
          { date:day(17), start:'14:00', end:'14:20', capacity:12 }]) },
      [gid.math]:{ name:'Math Sprint', nameCn:'數學快跑', emoji:'🧮', minGrade:'P1', maxGrade:'P6', color:PALETTE[1],
        slots:mkSlots('math', [
          { date:day(16), start:'15:00', end:'15:20', capacity:10 },
          { date:day(17), start:'15:00', end:'15:20', capacity:10 }]) },
      [gid.sci]:{ name:'Science Lab', nameCn:'科學實驗室', emoji:'🔬', minGrade:'P3', maxGrade:'F6', color:PALETTE[3],
        slots:mkSlots('sci', [
          { date:day(17), start:'16:00', end:'16:30', capacity:8 },
          { date:day(18), start:'16:00', end:'16:30', capacity:8 }]) },
      [gid.art]:{ name:'Mini Artists', nameCn:'小小藝術家', emoji:'🎨', minGrade:'K0', maxGrade:'K3', color:PALETTE[4],
        slots:mkSlots('art', [
          { date:day(16), start:'14:00', end:'14:30', capacity:8 },
          { date:day(18), start:'14:00', end:'14:30', capacity:8 }]) }
    };
    const cfg = {
      title:'Kumon Open Day — Booth Games', titleCn:'公文式開放日 · 攤位遊戲',
      description:'Three days of games, prizes and fun for the whole family! 一連三日攤位遊戲，一家大細齊齊玩！',
      eventStart:day(16), eventEnd:day(18), timeText:'14:00 – 18:00',
      venueEn:'The Venetian Macao, Cotai Exhibition Hall A, Booth E03 & F04',
      venueCn:'威尼斯人金光會展展館A 展位E03、F04',
      regStart:day(-6), regEnd:day(10), isActive:true, bannerPreset:'fiesta', bannerDataUrl:null,
      shortCode:code, createdAt:now, updatedAt:now, createdBy:auth.currentUser?.email || ''
    };
    const S = (game, slotKey, i) => {
      const g = gamesSeed[game]; const s = g.slots[sid[slotKey][i]];
      return { gameId:game, slotId:sid[slotKey][i], gameName:g.name, date:s.date, start:s.start, end:s.end };
    };
    const birth = (age, m, d) => `${new Date().getFullYear() - age}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const seed = [
      ['陳大文 Chan Tai Man','P2',7,1,14,'66123401',{wechat:true,whatsapp:true},'wx_taiman','yes','Kumon Champs 卓思','Math 數學',['none'],[S(gid.toss,'toss',0),S(gid.math,'math',0)],0,'attended','Pui Ching Middle School 培正中學'],
      ['黃美琪 Wong Mei Kei','K2',4,3,2,'66123402',{wechat:true,whatsapp:false},'wx_meikei','yes','Kumon Mei Keng 美景','Chinese 中文',['none'],[S(gid.toss,'toss',0),S(gid.art,'art',0)],0,'registered','Kwong Tai Kindergarten 廣大幼稚園'],
      ['李卓恆 Lei Cheok Hang','F1',12,5,21,'66123403',{wechat:false,whatsapp:true},'','no','','',['math','english'],[S(gid.sci,'sci',0)],1,'registered','Salesian School 慈幼中學'],
      ['張嘉偉 Cheong Ka Wai','P5',10,2,8,'66123404',{wechat:true,whatsapp:true},'','yes','Kumon Tap Siac 塔石','Math, English',['none'],[S(gid.math,'math',0),S(gid.sci,'sci',0)],1,'registered','St. Joseph Diocesan College 聖若瑟教區中學'],
      ['林月美 Lam Ut Mei','K1',3,6,11,'66123405',{wechat:true,whatsapp:false},'wx_utmei','no','','',['kindies','connect'],[S(gid.art,'art',0)],2,'registered','Holy Rosary Kindergarten 聖玫瑰幼稚園'],
      ['何承南 Ho Seng Nam','P3',8,4,19,'66123406',{wechat:false,whatsapp:true},'','yes','Kumon Pac Tat 北立','Math 數學',['none'],[S(gid.toss,'toss',1),S(gid.math,'math',1),S(gid.sci,'sci',1)],2,'attended','Chan Sui Ki Perpetual Help College 陳瑞祺永援中學'],
      ['梁慧珊 Leong Wai San','P6',11,1,25,'66123407',{wechat:true,whatsapp:true},'wx_waisan','no','','',['math','english'],[S(gid.math,'math',1),S(gid.sci,'sci',0)],3,'registered','Sacred Heart Canossian School 嘉諾撒聖心中學'],
      ['吳子豪 Ng Chi Hou','P1',6,3,30,'66123408',{wechat:true,whatsapp:false},'','yes','Kumon Champs 卓思','English 英文',['none'],[S(gid.toss,'toss',1),S(gid.math,'math',0)],3,'registered','Pui Ching Middle School 培正中學'],
      ['陳浩韻 Chan Hou Wan','K3',5,5,6,'66123409',{wechat:false,whatsapp:true},'','yes','Kumon Mei Keng 美景','Math 數學',['none'],[S(gid.toss,'toss',2),S(gid.art,'art',1)],4,'attended','Kwong Tai Kindergarten 廣大幼稚園'],
      ['楊美燕 Iong Mei Ieng','F3',14,2,17,'66123410',{wechat:true,whatsapp:true},'wx_meiien','no','','',['math','chinese'],[S(gid.sci,'sci',1)],4,'registered','Our Lady of Fatima Girls School 化地瑪聖母女子學校'],
      ['方家樂 Fong Ka Lok','P4',9,6,3,'66123411',{wechat:true,whatsapp:false},'wx_kalok','no','','',['connect'],[S(gid.toss,'toss',2),S(gid.math,'math',1),S(gid.sci,'sci',0)],5,'registered','Hou Kong Middle School 濠江中學'],
      ['蘇凱晴 Sou Hoi Ching','K0',2,4,22,'66123412',{wechat:false,whatsapp:true},'','no','','',['kindies'],[S(gid.art,'art',1)],5,'registered',''],
      ['麥志朗 Mak Chi Long','P2',7,1,9,'66123413',{wechat:true,whatsapp:true},'','yes','Kumon Champs 卓思','Math, Chinese',['none'],[S(gid.toss,'toss',0),S(gid.math,'math',0)],6,'registered','Pui Ching Middle School 培正中學'],
      ['鄺泳欣 Kuong Weng Ian','P6',12,5,14,'66123414',{wechat:true,whatsapp:false},'wx_wengian','no','','',['erp','chinese'],[S(gid.math,'math',1),S(gid.sci,'sci',1)],6,'registered','Sacred Heart Canossian School 嘉諾撒聖心中學']
    ];
    const registrations = {};
    const countsSeed = {};
    seed.forEach((row, i) => {
      const [name, grade, age, bm, bd, phone, apps, wx, cur, center, subs, interests, selections, off, status, school] = row;
      const rid = uid('r');
      const submittedAt = new Date(Date.now() - off * 86400000 - (i % 9) * 3600000).toISOString();
      registrations[rid] = {
        code:'BG-' + randomCode(6), studentName:name, grade, school, birthday:birth(age, bm, bd),
        ageYears:age, ageMonths:(i * 2) % 12, parentPhone:phone, contactApps:apps, wechatId:wx,
        isCurrentStudent:cur, currentCenter:center, currentSubjects:subs, interests, selections,
        remarks:i === 5 ? 'Sibling may join next year 弟弟明年或會入學' : '',
        status, submittedAt, attendedAt:status === 'attended' ? submittedAt : null
      };
      selections.forEach(s => {
        countsSeed[s.gameId] = countsSeed[s.gameId] || {};
        countsSeed[s.gameId][s.slotId] = (countsSeed[s.gameId][s.slotId] || 0) + 1;
      });
    });
    const updates = {};
    updates[`boothEvents/${id}/config`] = cfg;
    updates[`boothEvents/${id}/games`] = gamesSeed;
    updates[`boothEvents/${id}/counts`] = countsSeed;
    updates[`boothEvents/${id}/registrations`] = registrations;
    updates[`boothCodes/${code}`] = { eventId:id, createdAt:now };
    updates[`boothIndex/${id}`] = indexEntry(cfg);
    await update(ref(db), updates);
    creatingNew = false;
    currentEventId = id;
    localStorage.setItem('booth_eventId', id);
    await refreshEventList();
    subscribeEvent(id);
    applyMode(); switchTab('dashboard');
    showToast('✨ Sample event created — explore freely, delete anytime 示範活動已建立', 'success');
  } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

// ============================================
// CHECK-IN CONSOLE
// ============================================
let ciLastId = null;
let ciLog = [];
let ciScanner = null;
let ciCamActive = false;

function ciPushLog(icon, text) {
  ciLog.unshift({ icon, text, time:new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) });
  ciLog = ciLog.slice(0, 30);
}
function ciNorm(s) { return String(s || '').toUpperCase().replace(/\s+/g, ''); }

let ciLastDecode = { text:'', at:0 };

function ciLookup(raw, opts = {}) {
  const q = ciNorm(raw);
  if (!q) return false;
  const bare = q.replace(/^BG-?/, '');
  let entry = Object.entries(regs).find(([, r]) => ciNorm(r.code) === q);
  if (!entry) entry = Object.entries(regs).find(([, r]) => ciNorm(r.code) === 'BG-' + bare);
  if (!entry) entry = Object.entries(regs).find(([, r]) => ciNorm(r.code).replace(/^BG-?/, '') === bare);
  const inp = $('checkinInput');
  if (!entry) {
    if (!opts.fromCamera) {
      ciLastId = null;
      ciPushLog('❌', `QR not recognised 無法識別: ${q}`);
      renderCheckin();
      showToast('❌ This QR is not a registration for this event 此 QR 不屬於本活動', 'error');
    }
    return false;
  }
  ciLastId = entry[0];
  ciPushLog('🔎', `${entry[1].studentName || ''} · ${entry[1].grade || ''}`);
  renderCheckin();
  if (inp) { inp.value = ''; inp.focus(); }
  return true;
}

async function ciToggle(id) {
  const r = regs[id]; if (!r) return;
  const to = r.status === 'attended' ? 'registered' : 'attended';
  const attendedAt = to === 'attended' ? new Date().toISOString() : null;
  r.status = to; r.attendedAt = attendedAt;
  ciPushLog(to === 'attended' ? '✅' : '↩', `${r.studentName || ''} · ${r.grade || ''}`);
  renderAll();
  try { await update(ref(db, `boothEvents/${currentEventId}/registrations/${id}`), { status:to, attendedAt }); }
  catch (err) { showToast(`Error: ${err.message}`, 'error'); }
}

function renderCheckin() {
  if (creatingNew) return;
  renderCheckinResult();
  renderCheckinSlots();
  renderCheckinLog();
}

function renderCheckinResult() {
  const wrap = $('checkinResult'); if (!wrap) return;
  if (!ciLastId || !regs[ciLastId]) {
    wrap.innerHTML = '<div class="ci-empty">🎟️ Ready — scan a QR to check in. 準備就緒 — 掃描 QR 即可報到。</div>';
    return;
  }
  const r = regs[ciLastId];
  const attended = r.status === 'attended';
  const today = localDateStr();

  const gameRows = (r.selections || []).map(s => {
    const g = games[s.gameId];
    const c = (g && g.color) || PALETTE[0];
    const isToday = (s.date || '') === today;
    const bg = isToday ? '#fff8e6' : '#f4f8fd';
    const bd = isToday ? '#fde68a' : '#dbe5f2';
    return '<div class="ci-game-row' + (isToday ? ' today' : '') + '" style="display:flex;align-items:flex-start;gap:.55rem;min-width:0;max-width:100%;box-sizing:border-box;padding:.5rem .65rem;border-radius:10px;background:' + bg + ';border:1px solid ' + bd + ';border-left:4px solid ' + c + ';">'
      + '<span style="flex:0 0 auto;font-size:1.05rem;line-height:1.35;">' + ((g && g.emoji) || '🎮') + '</span>'
      + '<span style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:.1rem;">'
      + '<span style="font-weight:800;color:#16233b;font-size:.9rem;line-height:1.35;white-space:normal;overflow-wrap:anywhere;word-break:break-word;">' + escapeHtml(s.gameName || (g && (g.name || g.nameCn)) || '') + '</span>'
      + '<span style="font-weight:700;color:#5b6b84;font-size:.78rem;line-height:1.35;white-space:normal;overflow-wrap:anywhere;word-break:break-word;">' + escapeHtml(slotFullLabel(s)) + (isToday ? ' · Today 今天' : '') + '</span>'
      + '</span></div>';
  }).join('');

  const metaBits = [];
  metaBits.push('<span style="white-space:nowrap;font-weight:900;color:#245a94;">ID ' + escapeHtml(regIdLabel(r.seq)) + '</span>');
  if (r.parentPhone) metaBits.push('<span style="min-width:0;overflow-wrap:anywhere;">📞 ' + escapeHtml(r.parentPhone) + '</span>');
  const apps = [r.contactApps?.wechat ? '💬 WeChat' : '', r.contactApps?.whatsapp ? '📱 WhatsApp' : ''].filter(Boolean).join(' · ');
  if (apps) metaBits.push('<span style="min-width:0;overflow-wrap:anywhere;">' + escapeHtml(apps) + '</span>');
  if (r.school) metaBits.push('<span style="min-width:0;overflow-wrap:anywhere;">🏫 ' + escapeHtml(r.school) + '</span>');
  if (r.ageYears != null) metaBits.push('<span style="white-space:nowrap;">🎂 ' + r.ageYears + 'y</span>');

  wrap.innerHTML =
    '<div class="ci-card ' + (attended ? 'attended' : '') + '" style="min-width:0;max-width:100%;overflow:hidden;box-sizing:border-box;">'
    + '<div class="ci-head" style="min-width:0;max-width:100%;">'
    + '<div class="ci-name" style="min-width:0;overflow-wrap:anywhere;word-break:break-word;">' + escapeHtml(r.studentName || '')
    + ' <span class="grade-chip band-' + gradeBand(r.grade) + '">' + escapeHtml(r.grade || '') + '</span></div>'
    + '<span class="status-badge st-' + (attended ? 'attended' : 'registered') + '">' + (attended ? '✅ Attended 已報到' : '📝 Registered 已報名') + '</span>'
    + '</div>'
    + '<div class="ci-meta" style="display:flex;flex-wrap:wrap;gap:.35rem .8rem;min-width:0;max-width:100%;">' + metaBits.join('') + '</div>'
    + '<div class="ci-games" style="display:flex;flex-direction:column;gap:.4rem;min-width:0;max-width:100%;margin:.6rem 0 .8rem;">' + (gameRows || '<span class="hint">—</span>') + '</div>'
    + '<div class="ci-actions"><button class="btn ' + (attended ? 'secondary' : 'primary') + ' big" data-ci-toggle="' + escapeHtml(ciLastId) + '">' + (attended ? '↩ Undo check-in 取消報到' : '✓ Check in 報到') + '</button></div>'
    + '</div>';
}

function renderCheckinSlots() {
  const wrap = $('checkinSlots'); const totals = $('checkinTotals');
  const all = Object.values(regs);
  const arrivedTotal = all.filter(r => r.status === 'attended').length;
  if (totals) totals.textContent = arrivedTotal + ' arrived 已報到 · ' + all.length + ' registered 已報名 · ' + (all.length - arrivedTotal) + ' remaining 未到';
  const entries = Object.entries(games);
  if (!entries.length) { wrap.innerHTML = '<p class="hint">No games yet. 尚未新增遊戲。</p>'; return; }
  const today = localDateStr();
  wrap.innerHTML = entries.map(([gid, g]) => {
    const c = g.color || PALETTE[0];
    const slots = Object.entries(g.slots || {}).sort((a, b) =>
      String(a[1].date || '').localeCompare(String(b[1].date || '')) || String(a[1].start).localeCompare(String(b[1].start)));
    const rows = slots.map(([sid, s]) => {
      const sel = all.filter(r => (r.selections || []).some(x => x.gameId === gid && x.slotId === sid));
      const booked = sel.length;
      const arrived = sel.filter(r => r.status === 'attended').length;
      const pct = booked ? Math.round(arrived / booked * 100) : 0;
      const isToday = (s.date || '') === today;
      return '<div class="ci-slot-row' + (isToday ? ' today' : '') + '" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.3rem .6rem;align-items:center;min-width:0;max-width:100%;box-sizing:border-box;padding:.5rem .6rem;border-radius:9px;margin-bottom:.35rem;background:' + (isToday ? '#fff8e6' : '#f6f9fd') + ';border:1px solid ' + (isToday ? '#fde68a' : '#e8eff8') + ';">'
        + '<span style="min-width:0;font-weight:800;color:#245a94;font-size:.82rem;overflow-wrap:anywhere;">' + escapeHtml(fmtDateShort(s.date)) + ' · ' + escapeHtml(slotLabel(s)) + '</span>'
        + '<span style="white-space:nowrap;font-weight:800;color:#5b6b84;font-size:.82rem;">' + arrived + ' / ' + booked + '</span>'
        + '<div style="grid-column:1/-1;height:8px;background:#e6edf6;border-radius:999px;overflow:hidden;">'
        + '<div style="height:100%;width:' + pct + '%;background:' + c + ';border-radius:999px;transition:width .4s ease;"></div>'
        + '</div></div>';
    }).join('');
    return '<div class="occ-game" style="min-width:0;max-width:100%;margin-bottom:1rem;">'
      + '<div style="display:flex;align-items:center;gap:.5rem;min-width:0;max-width:100%;margin-bottom:.4rem;">'
      + '<span style="flex:0 0 auto;font-size:1.15rem;">' + (g.emoji || '🎮') + '</span>'
      + '<span style="min-width:0;font-weight:800;color:#16233b;overflow-wrap:anywhere;word-break:break-word;">' + escapeHtml(g.name || '') + ' ' + escapeHtml(g.nameCn || '') + '</span>'
      + '</div>' + (rows || '<p class="hint">No slots.</p>') + '</div>';
  }).join('');
}

function renderCheckinLog() {
  const wrap = $('checkinLog'); if (!wrap) return;
  if (!ciLog.length) { wrap.innerHTML = '<p class="hint">No activity yet this session. 本次尚未有紀錄。</p>'; return; }
  wrap.innerHTML = ciLog.slice(0, 8).map(e =>
    `<div class="ci-log-row"><span>${e.icon}</span><span>${escapeHtml(e.text)}</span><span class="t">${escapeHtml(e.time)}</span></div>`).join('');
}

async function ciStartCamera() {
  if (typeof Html5Qrcode === 'undefined') return showToast('Scanner library missing — check the html5-qrcode script tag', 'error');
  $('ciCameraModal').classList.remove('hidden');
  ciLastDecode = { text:'', at:0 };
  try {
    if (!ciScanner) {
      const opts = { verbose:false };
      if (typeof Html5QrcodeSupportedFormats !== 'undefined') {
        opts.formatsToSupport = [Html5QrcodeSupportedFormats.QR_CODE];
      }
      opts.experimentalFeatures = { useBarCodeDetectorIfSupported:true };
      ciScanner = new Html5Qrcode('ciCameraReader', opts);
    }
    await ciScanner.start(
      { facingMode:'environment' },
      {
        fps:15,
        aspectRatio:1.0,
        qrbox:(vw, vh) => { const s = Math.floor(Math.min(vw, vh) * 0.75); return { width:s, height:s }; }
      },
      (decodedText) => {
        const now = Date.now();
        if (decodedText === ciLastDecode.text && now - ciLastDecode.at < 1000) return;
        ciLastDecode = { text:decodedText, at:now };
        if (ciLookup(decodedText, { fromCamera:true })) {
          ciStopCamera();
          showToast('✅ Participant found 已找到參加者', 'success');
        }
      },
      () => {}
    );
    ciCamActive = true;
  } catch (err) {
    showToast(`Camera error: ${err.message || err}`, 'error');
    $('ciCameraModal').classList.add('hidden');
  }
}

async function ciStopCamera() {
  $('ciCameraModal').classList.add('hidden');
  if (ciScanner && ciCamActive) { try { await ciScanner.stop(); } catch {} ciCamActive = false; }
}

(function bindCheckin() {
  const sec = document.getElementById('tab-checkin');
  if (!sec || sec.dataset.bound) return;
  sec.dataset.bound = '1';
  const inp = document.getElementById('checkinInput');
  inp?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ciLookup(inp.value); } });
  document.getElementById('checkinLookupBtn')?.addEventListener('click', () => ciLookup(inp?.value));
  document.getElementById('checkinCameraBtn')?.addEventListener('click', ciStartCamera);
  document.getElementById('ciCameraClose')?.addEventListener('click', ciStopCamera);
  document.querySelector('[data-tab="checkin"]')?.addEventListener('click', () => setTimeout(() => inp?.focus(), 60));
  sec.addEventListener('click', e => {
    const btn = e.target.closest('[data-ci-toggle]');
    if (btn) ciToggle(btn.dataset.ciToggle);
  });
})();

// ============================================
// TOAST
// ============================================
let toastTimer = null;
function showToast(msg, type = 'success', action = null) {
  const toast = $('toast');
  $('toastMsg').textContent = msg;
  toast.className = `toast ${type}`;
  const btn = $('toastAction');
  if (action) {
    btn.textContent = action.label;
    btn.classList.remove('hidden');
    btn.onclick = () => { toast.classList.add('hidden'); action.fn(); };
  } else { btn.classList.add('hidden'); btn.onclick = null; }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), action ? 6500 : 3200);
}

window.addEventListener('beforeunload', () => {
  unsubs.forEach(fn => fn());
  if (autoReconcileTimer) clearTimeout(autoReconcileTimer);
  if (ciScanner && ciCamActive) ciScanner.stop().catch(() => {});
  
});