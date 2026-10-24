// eventSchedule.js v5.1 — Gantt timetable + BOOTH assignments (booth shown on bars only, no emoji on data)
import { db } from './auth.js';
import { ref, get, set, push, update, remove, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const AUTHORIZED_EMAIL = "kumonchamps@gmail.com";
const auth = getAuth();
const $ = (id) => document.getElementById(id);
const PALETTE = ['#4682B4','#e07a5f','#3d8b63','#9b5de5','#f4a261','#e63946','#2a9d8f','#6d6875','#d81159','#0096c7','#80b918','#b5838d'];
const ZOOM_STEPS = [90, 140, 200, 260];
const LEAD_RE = /^lead\s*[:：]\s*/i;   // "Lead: X" / "lead：X" auto-detect

const state = {
  events: {}, partTimers: {}, employeesCache: {}, centersCache: {},
  currentEventId: null,
  pxPerHour: (() => { const v = Number(localStorage.getItem('ev_pxh')); return (v && v !== 90) ? v : 0; })(),
  snap: Number(localStorage.getItem('ev_snap') || 15),
  search: '', hideEmpty: false, highlight: null, boothHighlight: null,
  metrics: null, editingStaffId: null, editingTaskId: null, staffTab: 'emp', taskColor: ''
};
let drag = null, suppressClick = false, employeesLoaded = false;

/* ============ HELPERS ============ */
const t2m = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const m2t = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
const norm = (s) => String(s || '').trim().toLowerCase();
function hash(s) { let h = 0; const str = String(s || ''); for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0; return Math.abs(h); }
function groupColor(title, override) { return override || PALETTE[hash(norm(title)) % PALETTE.length]; }
function getEmpPositions(emp) {
  if (!emp) return [];
  if (Array.isArray(emp.positions)) return emp.positions.filter(Boolean);
  if (emp.position) return [emp.position];
  return [];
}
// ★ LEAD: explicit flag OR "Lead:" prefix in the title
function leadInfo(t) {
  const raw = String(t?.title || '');
  const hasPrefix = LEAD_RE.test(raw);
  return { lead: t?.lead === true || hasPrefix, title: (hasPrefix ? raw.replace(LEAD_RE, '').trim() : raw) || raw };
}
const shortCenter = (n) => String(n || '').replace(/Centro de Educa[cç][ãa]o\s*/i, '').replace(/\s+/g, ' ').trim();
function centerLabelForEmp(e) {
  const cn = e?.contract?.employerName;
  if (cn) return shortCenter(cn);
  const perms = e?.permissions?.centers || {};
  return Object.keys(perms).filter(k => perms[k] === true)
    .map(k => shortCenter(state.centersCache[k]?.name || k)).join(', ');
}
/* ★ BOOTH helpers */
const boothsOf = (ev) => Object.entries(ev?.booths || {}).map(([id, b]) => ({ id, name: b?.name || 'Untitled booth' }));
const boothName = (ev, id) => (id && ev?.booths?.[id]?.name) ? ev.booths[id].name : '';
const staffName = (ev, id) => ev?.staff?.[id]?.name || '?';

function toast(msg, type = 'ok') {
  const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = msg;
  $('toasts')?.appendChild(el); setTimeout(() => el.remove(), 3200);
}
function openModal(id) { $(id)?.classList.remove('hidden'); }
function closeModal(id) { $(id)?.classList.add('hidden'); }
document.addEventListener('click', (e) => { const c = e.target.dataset?.close; if (c) closeModal(c); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden')); });

/* ============ 🔐 ACCESS (Manager / Master Admin only) ============ */
async function checkAuthorization(user) {
  if (!user) return false;
  if (user.email?.toLowerCase() === AUTHORIZED_EMAIL) return true;
  try {
    const uSnap = await get(ref(db, `users/${user.uid}`));
    if (uSnap.exists()) {
      const pos = getEmpPositions(uSnap.val()).map(p => norm(p).trim());
      if (pos.includes('manager') || pos.includes('master admin')) return true;
    }
    const eSnap = await get(ref(db, 'employees'));
    const match = Object.values(eSnap.val() || {}).find(e => norm(e.email) === norm(user.email));
    if (match) {
      const mp = getEmpPositions(match).map(p => norm(p).trim());
      if (mp.includes('manager') || mp.includes('master admin')) return true;
    }
  } catch (err) { console.error('Auth check error:', err); }
  return false;
}
onAuthStateChanged(auth, async (user) => {
  $('backToCenters')?.addEventListener('click', () => location.href = 'centers.html');
  const ok = await checkAuthorization(user);
  if (!ok) {
    $('mainContent')?.classList.add('hidden');
    $('accessDenied')?.classList.remove('hidden');
    return;
  }
  $('accessDenied')?.classList.add('hidden');
  $('mainContent')?.classList.remove('hidden');
  if (user && $('userEmail')) { $('userEmail').textContent = user.email; $('userEmail').title = user.email; }
  initApp();
});

/* ============ INIT ============ */
function initApp() {
  onValue(ref(db, 'eventTimetables'), (snap) => {
    state.events = snap.val() || {};
    if (!state.currentEventId || !state.events[state.currentEventId]) {
      const ids = Object.keys(state.events).sort((a, b) => String(state.events[b].date || '').localeCompare(state.events[a].date || ''));
      state.currentEventId = ids[0] || null;
    }
    populateEventSelect();
    if (!state.pxPerHour) readableFitZoom();
    renderAll();
  });
  onValue(ref(db, 'eventPartTimers'), (snap) => { state.partTimers = snap.val() || {}; });
  get(ref(db, 'centers')).then(s => { state.centersCache = s.val() || {}; populateCenterSelect(); }).catch(() => {});

  $('eventSelect')?.addEventListener('change', e => { state.currentEventId = e.target.value || null; state.boothHighlight = null; renderAll(); });
  $('newEventBtn')?.addEventListener('click', () => openEventModal(null));
  $('editEventBtn')?.addEventListener('click', () => state.currentEventId && openEventModal(state.currentEventId));
  $('saveEventBtn')?.addEventListener('click', saveEvent);
  $('deleteEventBtn')?.addEventListener('click', deleteEvent);
  $('dupEventBtn')?.addEventListener('click', duplicateEvent);
  $('zoomSeg')?.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.zoom === 'fit') fitZoom(); else { state.pxPerHour = Number(b.dataset.zoom); localStorage.setItem('ev_pxh', state.pxPerHour); }
    $('zoomSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderGantt();
  });
  if ($('snapSelect')) $('snapSelect').value = String(state.snap);
  $('snapSelect')?.addEventListener('change', e => { state.snap = Number(e.target.value); localStorage.setItem('ev_snap', state.snap); });
  $('searchInput')?.addEventListener('input', e => { state.search = norm(e.target.value); renderGantt(); });
  $('hideEmptyChk')?.addEventListener('change', e => { state.hideEmpty = e.target.checked; renderGantt(); });
  $('addStaffBtn')?.addEventListener('click', () => openStaffModal(null));
  $('managePtBtn')?.addEventListener('click', openPtModal);
  /* ★ Booths */
  $('boothBtn')?.addEventListener('click', openBoothModal);
  $('boothAddBtn')?.addEventListener('click', () => { addBooth($('boothNewName').value); $('boothNewName').value = ''; });
  $('boothNewName')?.addEventListener('keydown', e => { if (e.key === 'Enter') { addBooth(e.target.value); e.target.value = ''; } });
  $('boothQuickToggle')?.addEventListener('click', () => {
    const box = $('boothQuickAdd'); box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) $('boothQuickName').focus();
  });
  $('boothQuickSave')?.addEventListener('click', quickAddBoothFromTask);

  $('exportMenuBtn') && setupExportMenu();
  $('printBtn')?.addEventListener('click', () => window.print());
  $('windowChipBtn')?.addEventListener('click', () => { const w = getWindow(currentEvent()); $('sfShiftStart').value = m2t(w.start); $('sfShiftEnd').value = m2t(w.end); });
  $('saveStaffBtn')?.addEventListener('click', saveStaff);
  $('removeStaffBtn')?.addEventListener('click', removeStaff);
  $('empSearch')?.addEventListener('input', renderStaffLists);
  $('staffTabs')?.addEventListener('click', e => {
    const b = e.target.closest('.tab-btn'); if (!b) return;
    state.staffTab = b.dataset.stab;
    $('staffTabs').querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x === b));
    $('tabEmp').classList.toggle('active', state.staffTab === 'emp');
    $('tabPt').classList.toggle('active', state.staffTab === 'pt');
  });
  $('taskLead')?.addEventListener('change', e => $('leadToggleBox')?.classList.toggle('on', e.target.checked));
  $('saveTaskBtn')?.addEventListener('click', saveTask);
  $('deleteTaskBtn')?.addEventListener('click', deleteTask);
  setInterval(() => { if (!drag) renderNowLine(); }, 30000);
  setupGanttPointer();
}

/* ============ DATA ============ */
const currentEvent = () => state.events[state.currentEventId];
function staffOf(ev) { return Object.entries(ev?.staff || {}).map(([id, s]) => ({ id, ...s })); }
function tasksOf(ev) { return Object.entries(ev?.assignments || {}).map(([id, t]) => ({ id, ...t, startMin: t2m(t.start), endMin: t2m(t.end) })); }
function getWindow(ev) {
  let s = t2m(ev?.start), e = t2m(ev?.end);
  if (s == null || e == null) {
    let mn = Infinity, mx = -Infinity;
    staffOf(ev).forEach(st => { const a = t2m(st.shiftStart), b = t2m(st.shiftEnd); if (a != null) mn = Math.min(mn, a); if (b != null) mx = Math.max(mx, b); });
    tasksOf(ev).forEach(t => { if (t.startMin != null) mn = Math.min(mn, t.startMin); if (t.endMin != null) mx = Math.max(mx, t.endMin); });
    if (!isFinite(mn)) { mn = 9 * 60; mx = 18 * 60; }
    s = Math.floor(mn / 60) * 60; e = Math.ceil(mx / 60) * 60;
    if (e <= s) e = s + 60;
  }
  return { start: s, end: e };
}
function assignLanes(tasks) {
  const sorted = [...tasks].sort((a, b) => a.startMin - b.startMin);
  const laneEnd = []; const conflicts = new Set();
  sorted.forEach(t => {
    let lane = laneEnd.findIndex(end => end <= t.startMin);
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(t.endMin); } else laneEnd[lane] = t.endMin;
    t._lane = lane;
  });
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++)
    if (sorted[i].startMin < sorted[j].endMin && sorted[j].startMin < sorted[i].endMin) { conflicts.add(sorted[i].id); conflicts.add(sorted[j].id); }
  return { lanes: Math.max(1, laneEnd.length), conflicts };
}
// ⛓️ Chain new tasks: default start = end of this staff's LAST task (always)
function defaultStartForStaff(staffId, clickMin = null) {
  const ev = currentEvent();
  const win = getWindow(ev);
  const mine = tasksOf(ev).filter(t => t.staffId === staffId);
  if (!mine.length) return clickMin ?? win.start;
  const tail = Math.max(...mine.map(t => t.endMin));
  return Math.max(win.start, tail);
}

/* ============ RENDER ============ */
function populateEventSelect() {
  const sel = $('eventSelect');
  if (!sel) return;
  sel.innerHTML = Object.entries(state.events)
    .sort((a, b) => String(a[1].date || '').localeCompare(String(b[1].date || '')))
    .map(([id, ev]) => `<option value="${id}" ${id === state.currentEventId ? 'selected' : ''}>${esc(ev.name || 'Untitled')} · ${esc(ev.date || '')}</option>`).join('');
  $('emptyState')?.classList.toggle('hidden', !!state.currentEventId);
  $('ganttScroll')?.classList.toggle('hidden', !state.currentEventId);
}
function populateCenterSelect() {
  const sel = $('evCenter');
  if (!sel) return;
  sel.innerHTML = '<option value="">—</option>' + Object.entries(state.centersCache).map(([id, c]) => `<option value="${id}">${esc(c.name || id)}</option>`).join('');
}
function renderAll() { renderStats(); renderLegend(); renderBoothBar(); renderGantt(); }

function filteredStaff(ev) {
  const tasks = tasksOf(ev);
  return staffOf(ev).filter(st => {
    const mine = tasks.filter(t => t.staffId === st.id);
    if (state.hideEmpty && mine.length === 0) return false;
    if (!state.search) return true;
    return norm(st.name).includes(state.search) || mine.some(t => norm(leadInfo(t).title).includes(state.search));
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
function renderStats() {
  const ev = currentEvent(); const box = $('statChips'); if (!ev || !box) { if (box) box.innerHTML = ''; return; }
  const staff = staffOf(ev), tasks = tasksOf(ev);
  const pts = staff.filter(s => s.type === 'parttimer').length;
  let conflicts = 0;
  staff.forEach(st => { conflicts += assignLanes(tasks.filter(t => t.staffId === st.id)).conflicts.size; });
  const w = getWindow(ev); let gaps = 0;
  const tMin = Math.min(...tasks.map(t => t.startMin), Infinity), tMax = Math.max(...tasks.map(t => t.endMin), -Infinity);
  for (let b = Math.max(w.start, tMin); b < Math.min(w.end, tMax); b += 30)
    if (!tasks.some(t => t.startMin < b + 30 && t.endMin > b)) gaps++;
  const nBooths = boothsOf(ev).length;
  const nBoothTasks = tasks.filter(t => t.boothId).length;
  box.innerHTML = `<span class="stat-chip">👥 ${staff.length} staff (${pts} PT)</span> <span class="stat-chip">🧩 ${tasks.length} tasks</span> <span class="stat-chip ${conflicts ? 'bad' : 'good'}">⚠️ ${conflicts / 2 | 0} conflict${conflicts ? 's' : ''}</span> <span class="stat-chip ${gaps ? 'warn' : 'good'}">🕳 ${gaps / 2 | 0} gap slot(s)</span>${nBooths ? ` <span class="stat-chip">🏪 ${nBooths} booth${nBooths === 1 ? '' : 's'} · ${nBoothTasks} tagged</span>` : ''} <span class="stat-chip">📅 ${esc(ev.date || 'no date')}</span>`;
}
function renderLegend() {
  const ev = currentEvent(); const box = $('legendBar'); if (!ev || !box) { if (box) box.innerHTML = ''; return; }
  const groups = {};
  tasksOf(ev).forEach(t => { const k = norm(leadInfo(t).title) || '(untitled)'; groups[k] = (groups[k] || 0) + 1; });
  box.innerHTML = Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
    `<span class="legend-item ${state.highlight === k ? 'active' : ''}" data-group="${esc(k)}"><span class="legend-dot" style="background:${groupColor(k)}"></span>${esc(k)} <b>(${n})</b></span>`).join('');
  box.onclick = (e) => {
    const item = e.target.closest('.legend-item'); if (!item) return;
    state.highlight = state.highlight === item.dataset.group ? null : item.dataset.group;
    renderLegend(); renderGantt();
  };
}
/* ★ BOOTH BAR — at-a-glance booth → staff overview; click to spotlight */
function renderBoothBar() {
  const ev = currentEvent(); const box = $('boothBar'); if (!box) return;
  const booths = boothsOf(ev);
  if (!ev || !booths.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const tasks = tasksOf(ev);
  box.innerHTML = booths.map(b => {
    const mine = tasks.filter(t => t.boothId === b.id);
    const names = [...new Set(mine.map(t => staffName(ev, t.staffId)))];
    const who = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
    return `<span class="booth-item ${state.boothHighlight === b.id ? 'active' : ''}" data-booth="${b.id}" title="${esc(b.name)}${names.length ? ' · ' + esc(names.join(', ')) : ' · unassigned'}"><span class="booth-dot" style="background:${groupColor(b.name)}"></span>🏪 ${esc(b.name)} <b>(${mine.length})</b>${who ? ` <span class="booth-who">— ${esc(who)}</span>` : ''}</span>`;
  }).join('') + `<button class="chip-btn" id="boothBarAdd" type="button">＋ booth</button>`;
  box.onclick = (e) => {
    if (e.target.closest('#boothBarAdd')) { openBoothModal(); return; }
    const item = e.target.closest('.booth-item'); if (!item) return;
    state.boothHighlight = state.boothHighlight === item.dataset.booth ? null : item.dataset.booth;
    renderBoothBar(); renderGantt();
  };
}
function renderGantt() {
  const ev = currentEvent(); const g = $('gantt'); if (!ev || !g) { if (g) g.innerHTML = ''; return; }
  const win = getWindow(ev);
  const pxm = state.pxPerHour / 60;
  const totalW = Math.ceil((win.end - win.start) * pxm);
  state.metrics = { win, pxm, totalW };
  const staff = filteredStaff(ev);
  const allTasks = tasksOf(ev);
  let ticks = '';
  for (let m = win.start; m < win.end; m += 60) ticks += `<div class="tick" style="left:${(m - win.start) * pxm}px">${m2t(m)}</div>`;
  let cov = '';
  for (let b = win.start; b < win.end; b += 30) {
    const n = allTasks.filter(t => t.startMin < b + 30 && t.endMin > b).length;
    cov += `<div class="cov cov${Math.min(3, n)}" style="flex:1" title="${m2t(b)}–${m2t(b + 30)} · ${n} task(s)"></div>`;
  }
  const nowX = nowLineX(win, pxm);
  let rows = '';
  staff.forEach(st => {
    const mine = allTasks.filter(t => t.staffId === st.id);
    const { lanes, conflicts } = assignLanes(mine);
    const rowH = lanes * 48 + 10;
    const ss = t2m(st.shiftStart), se = t2m(st.shiftEnd);
    const band = (ss != null && se != null && se > ss)
      ? `<div class="shift-band" style="left:${(ss - win.start) * pxm}px;width:${(se - ss) * pxm}px"></div>` : '';
    const leads = mine.filter(t => leadInfo(t).lead).length;
    const bars = mine.map(t => {
      const li = leadInfo(t);
      const bn = boothName(ev, t.boothId);
      const left = Math.max(0, (t.startMin - win.start) * pxm);
      const width = Math.max(26, (t.endMin - t.startMin) * pxm);
      const color = groupColor(li.title, t.color);
      const dimG = state.highlight && state.highlight !== norm(li.title);
      const dimB = state.boothHighlight && t.boothId !== state.boothHighlight;
      const dim = (dimG || dimB) ? ' dim' : '';
      const outside = (ss != null && (t.startMin < ss || t.endMin > se)) ? ' outside' : '';
      const conf = conflicts.has(t.id) ? ' conflict' : '';
      /* ★ booth shown ONLY here on the bar: plain name pill, no emoji */
      return `<div class="task-bar${li.lead ? ' lead' : ''}${width < 70 ? ' xs' : ''}${dim}${outside}${conf}" data-task="${t.id}" data-staff="${st.id}" style="left:${left}px;width:${width}px;top:${4 + t._lane * 48}px;background:${color}" title="${li.lead ? '★ LEAD: ' : ''}${esc(li.title)}${bn ? ` · Booth: ${esc(bn)}` : ''} · ${t.start}–${t.end}${t.notes ? '\n' + esc(t.notes) : ''}"><i class="hdl l"></i><span class="tb-title">${li.lead ? '★ ' : ''}${esc(li.title)}</span><span class="tb-meta"><span class="tb-time">${t.start}–${t.end}</span>${bn ? `<span class="tb-booth" title="Booth: ${esc(bn)}">${esc(bn)}</span>` : ''}</span><i class="hdl r"></i></div>`;
    }).join('');
    /* ★ staff meta = shift only (no booths) */
    rows += `<div class="g-row" style="direction:ltr;grid-template-columns:var(--staff-w) 1fr"><div class="g-staff" style="grid-column:1" data-act="edit-staff" data-staff="${st.id}" title="Click to edit shift / notes"><div class="g-staff-name">${esc(st.name)} <span class="badge ${st.type === 'parttimer' ? 'pt' : 'emp'}">${st.type === 'parttimer' ? 'PT' : 'EMP'}</span>${leads ? ` <span class="badge leadcount">★${leads}</span>` : ''}</div><div class="g-staff-meta">${ss != null ? `${st.shiftStart}–${st.shiftEnd}` : ''}</div></div><div class="g-lanes" data-staff="${st.id}" style="grid-column:2;width:${totalW}px;height:${rowH}px;--hourpx:${state.pxPerHour}px">${band}${bars}</div></div>`;
  });
  g.innerHTML = `<div class="g-head" style="direction:ltr;grid-template-columns:var(--staff-w) 1fr"><div class="g-corner" style="grid-column:1">👥 Staff (${staff.length})</div><div class="g-head-times" style="grid-column:2;width:${totalW}px">${ticks}<div class="cov-strip">${cov}</div>${nowX != null ? `<div class="now-line" style="left:${nowX}px"></div>` : ''}</div></div><div class="g-body">${rows || `<div style="padding:2rem;color:#64748b">No staff yet — click "👥 Add Staff".</div>`}</div>`;
  renderNowLine();
}
function nowLineX(win, pxm) {
  const ev = currentEvent(); if (!ev?.date) return null;
  const today = new Date().toISOString().split('T')[0];
  if (ev.date !== today) return null;
  const n = new Date(); const m = n.getHours() * 60 + n.getMinutes();
  if (m < win.start || m > win.end) return null;
  return (m - win.start) * pxm;
}
function renderNowLine() {
  if (!state.metrics) return;
  const x = nowLineX(state.metrics.win, state.metrics.pxm);
  document.querySelectorAll('.now-line').forEach(el => { if (x == null) el.remove(); else el.style.left = x + 'px'; });
}
function fitZoom() {
  if (!state.metrics) return;
  const avail = $('ganttScroll').clientWidth - 240;
  const hours = (state.metrics.win.end - state.metrics.win.start) / 60;
  state.pxPerHour = Math.max(40, Math.min(300, Math.floor(avail / hours)));
  localStorage.setItem('ev_pxh', state.pxPerHour);
  syncZoomSeg();
}
function syncZoomSeg() {
  $('zoomSeg')?.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.zoom) === state.pxPerHour));
}
function readableFitZoom() {
  const ev = currentEvent();
  const w = ev ? getWindow(ev) : { start: 540, end: 1080 };
  const hours = Math.max(1, (w.end - w.start) / 60);
  const avail = Math.max(320, ($('ganttScroll')?.clientWidth || 800) - 240);
  const target = Math.max(140, Math.min(260, avail / hours));
  state.pxPerHour = [...ZOOM_STEPS].reverse().find(s => s <= target) || 140;
  localStorage.setItem('ev_pxh', state.pxPerHour);
  syncZoomSeg();
}

/* ============ DRAG / RESIZE / CLICK ============ */
function setupGanttPointer() {
  const g = $('gantt');
  if (!g) return;
  g.addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('.task-bar'); if (!bar) return;
    e.preventDefault();
    const mode = e.target.classList.contains('hdl.l') ? 'l' : e.target.classList.contains('hdl.r') ? 'r' : 'move';
    const ev = currentEvent(); const task = (ev.assignments || {})[bar.dataset.task]; if (!task) return;
    drag = { bar, mode, startX: e.clientX, moved: false, id: bar.dataset.task, s: t2m(task.start), en: t2m(task.end), ns: t2m(task.start), ne: t2m(task.end) };
    bar.classList.add('dragging'); bar.setPointerCapture(e.pointerId);
  });
  g.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { pxm, win } = state.metrics;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 3) drag.moved = true;
    const dMin = Math.round(dx / pxm / state.snap) * state.snap;
    const dur = drag.en - drag.s;
    if (drag.mode === 'move') drag.ns = Math.max(win.start, Math.min(win.end - dur, drag.s + dMin)), drag.ne = drag.ns + dur;
    if (drag.mode === 'l') drag.ns = Math.max(win.start, Math.min(drag.en - state.snap, drag.s + dMin));
    if (drag.mode === 'r') drag.ne = Math.min(win.end, Math.max(drag.ns + state.snap, drag.en + dMin));
    drag.bar.style.left = ((drag.ns - win.start) * pxm) + 'px';
    drag.bar.style.width = Math.max(26, (drag.ne - drag.ns) * pxm) + 'px';
    drag.bar.querySelector('.tb-time').textContent = `${m2t(drag.ns)}–${m2t(drag.ne)}`;
  });
  g.addEventListener('pointerup', async (e) => {
    if (!drag) return;
    const d = drag; drag = null; d.bar.classList.remove('dragging');
    if (!d.moved) { openTaskModal(d.id); return; }
    suppressClick = true; setTimeout(() => suppressClick = false, 0);
    await update(ref(db, `eventTimetables/${state.currentEventId}/assignments/${d.id}`), { start: m2t(d.ns), end: m2t(d.ne) });
    toast(`⏱ Moved to ${m2t(d.ns)}–${m2t(d.ne)}`);
  });
  g.addEventListener('click', (e) => {
    if (suppressClick) return;
    const staffCell = e.target.closest('[data-act="edit-staff"]');
    if (staffCell) { openStaffModal(staffCell.dataset.staff); return; }
    if (e.target.closest('.task-bar')) return;
    const lanes = e.target.closest('.g-lanes'); if (!lanes || !state.metrics) return;
    const rect = lanes.getBoundingClientRect();
    const { win, pxm } = state.metrics;
    const clicked = win.start + Math.floor((e.clientX - rect.left) / pxm / state.snap) * state.snap;
    openTaskModal(null, lanes.dataset.staff, defaultStartForStaff(lanes.dataset.staff, clicked));
  });
}

/* ============ EVENT MODAL ============ */
function openEventModal(id) {
  const ev = id ? state.events[id] : null;
  $('eventModalTitle').textContent = ev ? 'Edit Event' : 'New Event';
  $('evName').value = ev?.name || ''; $('evDate').value = ev?.date || new Date().toISOString().split('T')[0];
  $('evStart').value = ev?.start || ''; $('evEnd').value = ev?.end || '';
  $('evCenter').value = ev?.centerId || '';
  $('deleteEventBtn')?.classList.toggle('hidden', !ev);
  $('dupEventBtn')?.classList.toggle('hidden', !ev);
  $('eventModal').dataset.editId = id || '';
  openModal('eventModal');
}
async function saveEvent() {
  const name = $('evName').value.trim(), date = $('evDate').value;
  if (!name || !date) return toast('⚠️ Name and date are required', 'warn');
  const data = { name, date, centerId: $('evCenter').value || '', start: $('evStart').value || '', end: $('evEnd').value || '', updatedAt: new Date().toISOString() };
  const editId = $('eventModal').dataset.editId;
  if (editId) { await update(ref(db, `eventTimetables/${editId}`), data); toast('✅ Event updated'); }
  else { const r = push(ref(db, 'eventTimetables')); await set(r, { ...data, createdBy: auth.currentUser?.uid, createdAt: new Date().toISOString() }); state.currentEventId = r.key; toast('✅ Event created'); }
  closeModal('eventModal');
}
async function deleteEvent() {
  const id = $('eventModal').dataset.editId; if (!id) return;
  if (!confirm('Delete this event and all its assignments?')) return;
  await remove(ref(db, `eventTimetables/${id}`)); state.currentEventId = null;
  closeModal('eventModal'); toast('🗑 Event deleted', 'warn');
}
async function duplicateEvent() {
  const id = $('eventModal').dataset.editId; const ev = state.events[id]; if (!ev) return;
  const r = push(ref(db, 'eventTimetables'));
  await set(r, { name: ev.name + ' (copy)', date: ev.date, centerId: ev.centerId || '', start: ev.start || '', end: ev.end || '', createdAt: new Date().toISOString() });
  const idMap = {};
  for (const [sid, s] of Object.entries(ev.staff || {})) { const nr = push(ref(db, `eventTimetables/${r.key}/staff`)); idMap[sid] = nr.key; await set(nr, s); }
  for (const t of Object.values(ev.assignments || {})) await set(push(ref(db, `eventTimetables/${r.key}/assignments`)), { ...t, staffId: idMap[t.staffId] || t.staffId });
  /* ★ copy booths with the SAME keys so task boothId links stay valid */
  for (const [bid, b] of Object.entries(ev.booths || {})) await set(ref(db, `eventTimetables/${r.key}/booths/${bid}`), b);
  state.currentEventId = r.key; closeModal('eventModal'); toast('⧉ Event duplicated');
}

/* ============ STAFF MODAL ============ */
async function openStaffModal(staffId) {
  const ev = currentEvent(); if (!ev) return toast('⚠️ Create an event first', 'warn');
  state.editingStaffId = staffId;
  const st = staffId ? ev.staff?.[staffId] : null;
  $('staffModalTitle').textContent = st ? `Edit: ${st.name}` : 'Add Staff';
  const editing = !!st;
  $('staffTabs')?.classList.toggle('hidden', editing);
  $('tabEmp')?.classList.toggle('hidden', editing);
  $('tabPt')?.classList.toggle('hidden', editing);
  $('empSearch')?.classList.toggle('hidden', editing);
  $('staffEditInfo')?.classList.toggle('hidden', !editing);
  if (st && $('staffEditInfo')) $('staffEditInfo').innerHTML = `${st.type === 'parttimer' ? '🧩 Part-timer' : '🏢 Employee'}: <b>${esc(st.name)}</b>${st.center ? ' · ' + esc(st.center) : ''}`;
  $('sfShiftStart').value = st?.shiftStart || ''; $('sfShiftEnd').value = st?.shiftEnd || ''; $('sfNotes').value = st?.notes || '';
  $('removeStaffBtn')?.classList.toggle('hidden', !editing);
  $('ptName').value = ''; $('ptContact').value = ''; $('ptRole').value = '';
  if (!employeesLoaded) { const s = await get(ref(db, 'employees')); state.employeesCache = s.val() || {}; employeesLoaded = true; }
  renderStaffLists();
  openModal('staffModal');
}
function renderStaffLists() {
  const q = norm($('empSearch')?.value || '');
  const ev = currentEvent();
  const usedRef = new Set(staffOf(ev).map(s => s.refId));
  const all = Object.entries(state.employeesCache).filter(([id, e]) => e.isDisabled !== true);
  const matchEmp = (e) => !q || [e.englishName, e.chineseName || '', getEmpPositions(e).join(' '), centerLabelForEmp(e)].join(' ').toLowerCase().includes(q);
  const ft = all.filter(([id, e]) => (e.terms || 'Full-time') !== 'Part-time').filter(([id, e]) => matchEmp(e))
    .sort((a, b) => String(a[1].englishName).localeCompare(String(b[1].englishName)));
  const ptEmps = all.filter(([id, e]) => (e.terms || 'Full-time') === 'Part-time').filter(([id, e]) => matchEmp(e))
    .sort((a, b) => String(a[1].englishName).localeCompare(String(b[1].englishName)));
  const pool = Object.entries(state.partTimers).filter(([id, p]) => !q || [p.name, p.role || '', p.contact || ''].join(' ').toLowerCase().includes(q));
  const empRow = ([id, e], isPt) => {
    const pos = getEmpPositions(e).join(', ') || e.position || '';
    const ctr = centerLabelForEmp(e);
    return `<label class="pick-row"><input type="radio" name="${isPt ? 'ptPick' : 'empPick'}" value="emp:${id}" ${usedRef.has(id) ? 'disabled title="already added"' : ''}> <span>${esc(e.englishName)}${e.chineseName ? ' ' + esc(e.chineseName) : ''}</span> <span class="sub">${isPt ? '<span class="badge pt">PT</span>' : ''}${esc(pos)}${ctr ? ' · ' + esc(ctr) : ''}</span></label>`;
  };
  const poolRow = ([id, p]) => `<label class="pick-row"><input type="radio" name="ptPick" value="pool:${id}" ${usedRef.has(id) ? 'disabled title="already added"' : ''}> <span>${esc(p.name)}</span><span class="sub"><span class="badge pt">POOL</span>${esc(p.role || '')}${p.contact ? ' · ' + esc(p.contact) : ''}</span></label>`;
  if ($('empList')) $('empList').innerHTML = ft.map(r => empRow(r, false)).join('') || '<div style="padding:1rem;color:#64748b">No matches.</div>';
  if ($('ptList')) $('ptList').innerHTML =
    (ptEmps.length ? '<div class="pick-group">From Employees page</div>' + ptEmps.map(r => empRow(r, true)).join('') : '') +
    (pool.length ? '<div class="pick-group">Part-timer pool (this page)</div>' + pool.map(poolRow).join('') : '') ||
    '<div style="padding:1rem;color:#64748b">No part-timers yet — add one below.</div>';
}
async function saveStaff() {
  const evId = state.currentEventId;
  const shiftStart = $('sfShiftStart').value || null, shiftEnd = $('sfShiftEnd').value || null, notes = $('sfNotes').value.trim();
  if (state.editingStaffId) {
    await update(ref(db, `eventTimetables/${evId}/staff/${state.editingStaffId}`), { shiftStart, shiftEnd, notes });
    toast('✅ Staff updated'); closeModal('staffModal'); return;
  }
  let entry = null;
  if (state.staffTab === 'pt') {
    const newName = $('ptName').value.trim();
    if (newName) {
      const r = push(ref(db, 'eventPartTimers'));
      await set(r, { name: newName, contact: $('ptContact').value.trim(), role: $('ptRole').value.trim(), createdAt: new Date().toISOString() });
      entry = { type: 'parttimer', refId: r.key, name: newName, position: $('ptRole').value.trim() || 'Part-timer', center: '', source: 'pool' };
      toast('🧩 New part-timer saved to pool');
    } else {
      const pick = document.querySelector('input[name="ptPick"]:checked');
      if (!pick) return toast('⚠️ Select a part-timer or fill the new name', 'warn');
      const [src, id] = [pick.value.slice(0, pick.value.indexOf(':')), pick.value.slice(pick.value.indexOf(':') + 1)];
      if (src === 'emp') {
        const e = state.employeesCache[id];
        entry = { type: 'parttimer', refId: id, name: e.englishName, position: getEmpPositions(e).join(', ') || e.position || '', center: centerLabelForEmp(e), source: 'emp' };
      } else {
        const p = state.partTimers[id];
        entry = { type: 'parttimer', refId: id, name: p.name, position: p.role || 'Part-timer', center: '', source: 'pool' };
      }
    }
  } else {
    const pick = document.querySelector('input[name="empPick"]:checked');
    if (!pick) return toast('⚠️ Select an employee', 'warn');
    const id = pick.value.slice(pick.value.indexOf(':') + 1);
    const e = state.employeesCache[id];
    const isPt = (e.terms || 'Full-time') === 'Part-time';
    entry = { type: isPt ? 'parttimer' : 'employee', refId: id, name: e.englishName, position: getEmpPositions(e).join(', ') || e.position || '', center: centerLabelForEmp(e), source: 'emp' };
  }
  await set(push(ref(db, `eventTimetables/${evId}/staff`)), { ...entry, shiftStart, shiftEnd, notes });
  toast('✅ Staff added'); closeModal('staffModal');
}
async function removeStaff() {
  const sid = state.editingStaffId; if (!sid) return;
  if (!confirm('Remove this person from the event? Their tasks will also be removed.')) return;
  const ev = currentEvent(); const updates = {};
  Object.entries(ev.assignments || {}).forEach(([tid, t]) => { if (t.staffId === sid) updates[`assignments/${tid}`] = null; });
  updates[`staff/${sid}`] = null;
  await update(ref(db, `eventTimetables/${state.currentEventId}`), updates);
  closeModal('staffModal'); toast('🗑 Staff removed', 'warn');
}

/* ============ TASK MODAL (with ★ LEAD + 🏪 BOOTH) ============ */
function populateBoothSelect(selectedId) {
  const ev = currentEvent(); const sel = $('taskBooth'); if (!sel) return;
  sel.innerHTML = '<option value="">— none —</option>' +
    boothsOf(ev).sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(b => `<option value="${b.id}" ${b.id === selectedId ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
}
function openTaskModal(taskId, staffId = null, startMin = null) {
  const ev = currentEvent(); if (!ev) return;
  state.editingTaskId = taskId;
  const t = taskId ? { ...ev.assignments[taskId], id: taskId } : null;
  const li = t ? leadInfo(t) : { lead: false, title: '' };
  $('taskModalTitle').textContent = t ? 'Edit Task' : 'New Task';
  $('taskStaff').innerHTML = staffOf(ev).sort((a, b) => String(a.name).localeCompare(String(b.name))).map(s => `<option value="${s.id}" ${(t?.staffId || staffId) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  $('taskTitle').value = li.title;
  $('titlesList').innerHTML = [...new Set(tasksOf(ev).map(x => leadInfo(x).title))].map(x => `<option value="${esc(x)}">`).join('');
  const s = t?.start ? t2m(t.start) : (startMin ?? getWindow(ev).start);
  const e2 = t?.end ? t2m(t.end) : s + 30;
  $('taskStart').value = m2t(s); $('taskEnd').value = m2t(e2);
  /* ★ booth picker */
  populateBoothSelect(t?.boothId || '');
  $('boothQuickAdd')?.classList.add('hidden');
  if ($('boothQuickName')) $('boothQuickName').value = '';
  $('taskLead').checked = li.lead; $('leadToggleBox')?.classList.toggle('on', li.lead);
  $('taskNotes').value = t?.notes || '';
  state.taskColor = t?.color || '';
  $('colorSwatches').innerHTML = `<span class="swatch auto ${!state.taskColor ? 'active' : ''}" data-color="" title="Auto by task name">A</span>` +
    PALETTE.map(c => `<span class="swatch ${state.taskColor === c ? 'active' : ''}" data-color="${c}" style="background:${c}"></span>`).join('');
  $('colorSwatches').onclick = (e) => {
    const sw = e.target.closest('.swatch'); if (!sw) return;
    state.taskColor = sw.dataset.color;
    $('colorSwatches').querySelectorAll('.swatch').forEach(x => x.classList.toggle('active', x === sw));
  };
  $('deleteTaskBtn')?.classList.toggle('hidden', !t);
  openModal('taskModal');
}
async function saveTask() {
  const raw = $('taskTitle').value.trim();
  const staffId = $('taskStaff').value;
  const start = $('taskStart').value, end = $('taskEnd').value;
  if (!raw || !staffId || !start || !end) return toast('⚠️ Fill staff, task and times', 'warn');
  if (t2m(end) <= t2m(start)) return toast('⚠️ End must be after start', 'warn');
  const hadPrefix = LEAD_RE.test(raw);
  const title = hadPrefix ? raw.replace(LEAD_RE, '').trim() : raw;
  const lead = $('taskLead').checked || hadPrefix;
  const data = { staffId, title, start, end, lead, color: state.taskColor, notes: $('taskNotes').value.trim(), boothId: $('taskBooth').value || '' };
  if (state.editingTaskId) { await update(ref(db, `eventTimetables/${state.currentEventId}/assignments/${state.editingTaskId}`), data); toast('✅ Task updated'); }
  else { await set(push(ref(db, `eventTimetables/${state.currentEventId}/assignments`)), data); toast('✅ Task added'); }
  closeModal('taskModal');
}
async function deleteTask() {
  if (!state.editingTaskId) return;
  if (!confirm('Delete this task?')) return;
  await remove(ref(db, `eventTimetables/${state.currentEventId}/assignments/${state.editingTaskId}`));
  closeModal('taskModal'); toast('🗑 Task deleted', 'warn');
}

/* ============ ★ BOOTH MODAL (per-event booth names) ============ */
function openBoothModal() {
  const ev = currentEvent(); if (!ev) return toast('⚠️ Create an event first', 'warn');
  renderBoothList();
  openModal('boothModal');
}
function renderBoothList() {
  const ev = currentEvent(); const body = $('boothListBody'); if (!body) return;
  const tasks = tasksOf(ev);
  body.innerHTML = boothsOf(ev).sort((a, b) => String(a.name).localeCompare(String(b.name))).map(b => {
    const n = tasks.filter(t => t.boothId === b.id).length;
    return `<div class="pick-row"><input style="flex:1" value="${esc(b.name)}" data-bf="name" data-id="${b.id}"><span class="sub">${n} task${n === 1 ? '' : 's'}</span><button class="ghost" data-bsave="${b.id}" title="Save name">💾</button><button class="danger" data-bdel="${b.id}" title="Delete booth">🗑</button></div>`;
  }).join('') || '<div style="padding:1rem;color:#64748b">No booths yet — add one above.</div>';
  body.onclick = async (e) => {
    const save = e.target.closest('[data-bsave]'), del = e.target.closest('[data-bdel]');
    if (save) {
      const id = save.dataset.bsave;
      const name = body.querySelector(`[data-bf="name"][data-id="${id}"]`).value.trim();
      if (!name) return toast('⚠️ Name required', 'warn');
      await update(ref(db, `eventTimetables/${state.currentEventId}/booths/${id}`), { name });
      const ev2 = currentEvent(); if (ev2?.booths?.[id]) ev2.booths[id].name = name;
      toast('✅ Booth saved'); renderBoothList(); renderBoothBar(); renderGantt();
    }
    if (del) {
      const id = del.dataset.bdel;
      if (!confirm('Delete this booth? Tasks keep their other details but lose the booth tag.')) return;
      const ev2 = currentEvent(); const updates = {}; updates[`booths/${id}`] = null;
      Object.entries(ev2.assignments || {}).forEach(([tid, t]) => { if (t.boothId === id) updates[`assignments/${tid}/boothId`] = ''; });
      await update(ref(db, `eventTimetables/${state.currentEventId}`), updates);
      if (state.boothHighlight === id) state.boothHighlight = null;
      renderBoothList(); renderBoothBar(); renderGantt(); toast('🗑 Booth deleted', 'warn');
    }
  };
}
async function addBooth(name) {
  name = (name || '').trim(); if (!name) return toast('⚠️ Booth name required', 'warn');
  const ev = currentEvent(); if (!ev) return toast('⚠️ Create an event first', 'warn');
  const r = push(ref(db, `eventTimetables/${state.currentEventId}/booths`));
  await set(r, { name, createdAt: new Date().toISOString() });
  ev.booths = ev.booths || {}; ev.booths[r.key] = { name };
  toast('✅ Booth added'); renderBoothList(); renderBoothBar();
  return r.key;
}
async function quickAddBoothFromTask() {
  const key = await addBooth($('boothQuickName').value);
  if (!key) return;
  populateBoothSelect(key);
  $('boothQuickAdd').classList.add('hidden'); $('boothQuickName').value = '';
}

/* ============ PART-TIMER POOL MODAL ============ */
function openPtModal() {
  const rows = Object.entries(state.partTimers).map(([id, p]) =>
    `<div class="pick-row"><input style="flex:1" value="${esc(p.name)}" data-ptf="name" data-id="${id}"><input style="flex:1" value="${esc(p.contact || '')}" data-ptf="contact" data-id="${id}"><button class="ghost" data-ptsave="${id}">💾</button><button class="danger" data-ptdel="${id}">🗑</button></div>`).join('');
  if ($('ptListBody')) $('ptListBody').innerHTML = rows || '<div style="padding:1rem;color:#64748b">No part-timers yet.</div>';
  $('ptListBody').onclick = async (e) => {
    const save = e.target.closest('[data-ptsave]'), del = e.target.closest('[data-ptdel]');
    if (save) {
      const id = save.dataset.ptsave;
      const name = $('ptListBody').querySelector(`[data-ptf="name"][data-id="${id}"]`).value.trim();
      const contact = $('ptListBody').querySelector(`[data-ptf="contact"][data-id="${id}"]`).value.trim();
      if (!name) return toast('⚠️ Name required', 'warn');
      await update(ref(db, `eventPartTimers/${id}`), { name, contact }); toast('✅ Saved');
    }
    if (del) {
      if (!confirm('Remove from pool? Scheduled copies stay.')) return;
      await remove(ref(db, `eventPartTimers/${del.dataset.ptdel}`)); openPtModal(); toast('🗑 Removed', 'warn');
    }
  };
  openModal('ptModal');
}

/* ============ EXCEL EXPORT (with booths) ============ */
function exportExcel() {
  if (typeof XLSX === 'undefined') return toast('❌ Excel library not loaded', 'err');
  const ev = currentEvent(); if (!ev) return;
  const win = getWindow(ev); const staff = staffOf(ev); const tasks = tasksOf(ev);
  const wb = XLSX.utils.book_new();
  /* Sheet 1: flat assignments with Booth column */
  const flat = [['#', 'Name', 'Type', 'Shift', 'Booth', 'Task', 'Start', 'End', 'Lead', 'Notes']];
  let i = 1;
  staff.forEach(s => tasks.filter(t => t.staffId === s.id).sort((a, b) => a.startMin - b.startMin).forEach(t => {
    const li = leadInfo(t);
    flat.push([i++, s.name, s.type === 'parttimer' ? 'Part-timer' : 'Employee',
      s.shiftStart ? `${s.shiftStart}-${s.shiftEnd}` : 'WD',
      boothName(ev, t.boothId), li.title, t.start, t.end, li.lead ? '★ LEAD' : '', t.notes || '']);
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(flat), 'Assignments');
  /* Sheet 2: timeline grid, booth tagged inside cells (plain text, no emoji) */
  const hours = []; for (let m = win.start; m < win.end; m += 60) hours.push(m);
  const grid = [['#', 'Name', 'Type', 'Shift', ...hours.map(m2t)]];
  staff.forEach((s, idx) => {
    const row = [idx + 1, s.name, s.type === 'parttimer' ? 'Part-timer' : 'Employee',
      s.shiftStart ? `${s.shiftStart}-${s.shiftEnd}` : 'WD'];
    hours.forEach(h => {
      row.push(tasks.filter(t => t.staffId === s.id && t.startMin >= h && t.startMin < h + 60)
        .sort((a, b) => a.startMin - b.startMin)
        .map(t => { const li = leadInfo(t); const bn = boothName(ev, t.boothId); return `${t.start}-${t.end}: ${li.lead ? 'Lead: ' : ''}${li.title}${bn ? ' @ ' + bn : ''}`; })
        .join('\n'));
    });
    grid.push(row);
  });
  const ws = XLSX.utils.aoa_to_sheet(grid);
  ws['!cols'] = [{ wch: 4 }, { wch: 24 }, { wch: 11 }, { wch: 14 }, ...hours.map(() => ({ wch: 26 }))];
  XLSX.utils.book_append_sheet(wb, ws, 'Timeline Grid');
  /* Sheet 3: booth overview */
  const booths = boothsOf(ev);
  if (booths.length) {
    const bo = [['Booth', 'Staff', 'Type', 'Task', 'Start', 'End', 'Lead']];
    booths.forEach(b => {
      tasks.filter(t => t.boothId === b.id).sort((a, b2) => a.startMin - b2.startMin).forEach(t => {
        const s = ev.staff?.[t.staffId]; const li = leadInfo(t);
        bo.push([b.name, s?.name || '?', s?.type === 'parttimer' ? 'Part-timer' : 'Employee', li.title, t.start, t.end, li.lead ? '★' : '']);
      });
    });
    const ws3 = XLSX.utils.aoa_to_sheet(bo);
    ws3['!cols'] = [{ wch: 18 }, { wch: 24 }, { wch: 11 }, { wch: 26 }, { wch: 8 }, { wch: 8 }, { wch: 6 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Booth Overview');
  }
  XLSX.writeFile(wb, `Event_Timetable_${(ev.name || 'event').replace(/\s+/g, '_')}_${ev.date || ''}.xlsx`);
  toast('✅ Excel exported');
}

/* ============ EXPORT MENU & PNG CAPTURE ============ */
const EXPORT_TABLE_SELECTOR = '#gantt';
const EXPORT_WRAP_SELECTOR = '#ganttScroll';
function setupExportMenu() {
  const btn = document.getElementById('exportMenuBtn');
  const menu = document.getElementById('exportMenu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.add('hidden'); });
  document.getElementById('exportExcelOpt')?.addEventListener('click', () => { menu.classList.add('hidden'); exportExcel(); });
  document.getElementById('exportImageOpt')?.addEventListener('click', () => { menu.classList.add('hidden'); exportTableAsPNG(); });
}
/* Pretty date for the banner: "Fri, 23 Oct 2026" (falls back to raw string) */
function fmtExportDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
async function exportTableAsPNG() {
  if (typeof html2canvas === 'undefined') return toast('❌ Image export library not loaded. Add html2canvas to HTML.', 'err');
  const source = document.querySelector(EXPORT_WRAP_SELECTOR) || document.querySelector(EXPORT_TABLE_SELECTOR);
  if (!source) return toast('⚠️ No timetable found to export.', 'warn');
  const btn = document.getElementById('exportMenuBtn');
  const oldLabel = btn?.textContent || '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Rendering…'; }
  const clone = source.cloneNode(true);
  clone.style.cssText += ';position:static;overflow:visible;width:max-content;max-height:none;height:auto;background:#fff;margin:0;box-shadow:none;border-radius:0;';
  /* ★ keep the sticky-fix: names column stays LEFT in the capture */
  clone.querySelectorAll('.g-staff, .g-corner').forEach(el => {
    el.style.position = 'static';
    el.style.left = 'auto';
    el.style.right = 'auto';
    el.style.zIndex = 'auto';
  });
  const head = clone.querySelector('.g-head');
  if (head) { head.style.position = 'relative'; head.style.top = 'auto'; }
  /* ★ title banner with event name + date (+ center) */
  const ev = currentEvent();
  const centerName = ev?.centerId ? (state.centersCache[ev.centerId]?.name || '') : '';
  const banner = document.createElement('div');
  banner.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;' +
    'background:#4682B4;color:#fff;padding:10px 16px;font-family:inherit;';
  banner.innerHTML =
    `<div style="display:flex;align-items:baseline;gap:10px;min-width:0;">` +
    `<span style="font-size:17px;font-weight:800;white-space:nowrap;">📊 ${esc(ev?.name || 'Event Timetable')}</span>` +
    `${centerName ? `<span style="font-size:12px;font-weight:600;opacity:.9;white-space:nowrap;">· ${esc(shortCenter(centerName))}</span>` : ''}` +
    `</div>` +
    `<span style="font-size:13px;font-weight:700;white-space:nowrap;">📅 ${esc(fmtExportDate(ev?.date))}</span>`;
  /* wrapper = banner + grid, parked off-screen for the capture */
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:-9999px;top:0;background:#fff;width:max-content;';
  wrap.appendChild(banner);
  wrap.appendChild(clone);
  document.body.appendChild(wrap);
  try {
    const canvas = await html2canvas(wrap, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: wrap.scrollWidth,
      windowHeight: wrap.scrollHeight
    });
    const a = document.createElement('a');
    const fname = `Timetable_${(ev?.name || 'event').replace(/\s+/g, '_')}_${ev?.date || ''}.png`;
    a.href = canvas.toDataURL('image/png');
    a.download = fname;
    a.click();
    toast('✅ Image exported');
  } catch (err) {
    console.error('Image export error:', err);
    toast('❌ Failed to export image: ' + err.message, 'err');
  } finally {
    wrap.remove();
    if (btn) { btn.disabled = false; btn.textContent = oldLabel || '⬇ Export'; }
  }
}