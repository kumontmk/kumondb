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
  INTERESTS, interestLabel, GAME_EMOJIS, PALETTE, BANNERS, bannerCss, bannerStops,
  escapeHtml, randomCode, uid, localDateStr, calcAge, fmtDate, fmtDateShort, slotLabel, slotFullLabel,
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
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
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
      datasets:[{ data:INTERESTS.map(o => list.filter(r => (r.interests || []).includes(o.id)).length), backgroundColor:INTERESTS.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius:5 }] },
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
      const hay = [r.studentName, r.school, r.parentPhone, r.currentCenter, r.code, r.wechatId].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const cmp = {
    newest:(a, b) => String(b[1].submittedAt || '').localeCompare(String(a[1].submittedAt || '')),
    oldest:(a, b) => String(a[1].submittedAt || '').localeCompare(String(b[1].submittedAt || '')),
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
      `<td class="row-num">${i + 1}</td>` +
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
  const interests = (r.interests || []).map(i => `<span class="interest-chip">${escapeHtml(interestLabel(i))}</span>`).join('');
  const selHtml = (r.selections || []).map(s => {
    const g = games[s.gameId];
    return `<span class="game-chip" style="--gc:${g?.color || PALETTE[0]}">${g?.emoji || '🎮'} ${escapeHtml(s.gameName || g?.name || '')} · ${escapeHtml(slotFullLabel(s))}</span>`;
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
    `<div class="dw-section"><h4>🎪 Games 遊戲</h4><div class="dw-chips">${selHtml || '—'}</div></div>` +
    `<div class="dw-section"><h4>🗂 Record 紀錄</h4>` +
      dwRow('Submitted 提交', r.submittedAt ? new Date(r.submittedAt).toLocaleString('en-GB') : '') +
      dwRow('Remarks 備註', escapeHtml(r.remarks || '')) +
    `</div>`;
  $('drawerAttendBtn').textContent = status === 'attended' ? '↩ Undo check-in 取消報到' : '✓ Check in 報到';
}

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
    'Interested 興趣': (r.interests || []).map(interestLabel).join('; '),
    'Games & Slots 遊戲場次': (r.selections || []).map(s => `${s.gameName || games[s.gameId]?.name || ''} ${slotFullLabel(s)}`).join('; '),
    'Status 狀態': r.status || 'registered',
    'Submitted 提交': r.submittedAt || '',
    'Remarks 備註': r.remarks || ''
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch:12 },{ wch:20 },{ wch:8 },{ wch:26 },{ wch:12 },{ wch:6 },{ wch:15 },{ wch:8 },{ wch:10 },{ wch:16 },{ wch:12 },{ wch:22 },{ wch:20 },{ wch:50 },{ wch:60 },{ wch:11 },{ wch:22 },{ wch:30 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Registrations');

  Object.entries(games).forEach(([gid, g]) => {
    const roster = [];
    list.forEach(r => (r.selections || []).filter(s => s.gameId === gid).forEach(s => roster.push({
      'Date 日期': s.date || '',
      'Slot 場次': slotLabel(s),
      'Code 編號': r.code || '', 'Student 學生': r.studentName || '', 'Grade 年級': r.grade || '',
      'School 學校': r.school || '', 'Age 年齡': r.ageYears ?? '', 'Phone 電話': r.parentPhone || '',
      'Current 現讀': r.isCurrentStudent === 'yes' ? 'Yes' : 'No', 'Status 狀態': r.status || 'registered'
    })));
    if (!roster.length) return;
    roster.sort((a, b) => String(a['Date 日期']).localeCompare(String(b['Date 日期'])) || String(a['Slot 場次']).localeCompare(String(b['Slot 場次'])) || String(a['Student 學生']).localeCompare(String(b['Student 學生']), 'zh-Hant'));
    const ws2 = XLSX.utils.json_to_sheet(roster);
    ws2['!cols'] = [{ wch:12 },{ wch:14 },{ wch:12 },{ wch:20 },{ wch:8 },{ wch:26 },{ wch:6 },{ wch:15 },{ wch:10 },{ wch:11 }];
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
  const end = localDateStr(new Date(Date.now() + 14 * 86400000));
  return {
    dirty:false,
    config:{
      title:'', titleCn:'', description:'',
      eventStart:today, eventEnd:today, timeText:'',
      venueEn:'', venueCn:'',
      regStart:today, regEnd:end, isActive:true,
      bannerPreset:'fiesta', bannerDataUrl:null
    },
    games:{ [uid('g')]:{ name:'', nameCn:'', emoji:'🎯', minGrade:'K0', maxGrade:'F6', color:PALETTE[0],
      slots:{ [uid('s')]:{ date:today, start:'14:00', end:'14:20', capacity:10 } } } }
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
      g.slots[uid('s')] = { date, start, end:addMinutes(start, 20), capacity:(last && last.capacity) || 10 };
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

    const cardY = headerH + 52, cardH = 560;
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
    ctx.font = '800 30px "Courier New",monospace';
    ctx.fillStyle = '#2f6fb2';
    ctx.fillText(config.shortCode, W / 2, cardY + 532);

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
      ['李卓恆 Lei Cheok Hang','F1',12,5,21,'66123403',{wechat:false,whatsapp:true},'','no','','',['math','erp'],[S(gid.sci,'sci',0)],1,'registered','Salesian School 慈幼中學'],
      ['張嘉偉 Cheong Ka Wai','P5',10,2,8,'66123404',{wechat:true,whatsapp:true},'','yes','Kumon Tap Siac 塔石','Math, English',['none'],[S(gid.math,'math',0),S(gid.sci,'sci',0)],1,'registered','St. Joseph Diocesan College 聖若瑟教區中學'],
      ['林月美 Lam Ut Mei','K1',3,6,11,'66123405',{wechat:true,whatsapp:false},'wx_utmei','no','','',['kindies','connect'],[S(gid.art,'art',0)],2,'registered','Holy Rosary Kindergarten 聖玫瑰幼稚園'],
      ['何承南 Ho Seng Nam','P3',8,4,19,'66123406',{wechat:false,whatsapp:true},'','yes','Kumon Pac Tat 北立','Math 數學',['none'],[S(gid.toss,'toss',1),S(gid.math,'math',1),S(gid.sci,'sci',1)],2,'attended','Chan Sui Ki Perpetual Help College 陳瑞祺永援中學'],
      ['梁慧珊 Leong Wai San','P6',11,1,25,'66123407',{wechat:true,whatsapp:true},'wx_waisan','no','','',['math','efl'],[S(gid.math,'math',1),S(gid.sci,'sci',0)],3,'registered','Sacred Heart Canossian School 嘉諾撒聖心中學'],
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