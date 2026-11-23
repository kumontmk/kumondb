// employees-approvals.js
// Adds a "Pending Timeclock Approvals" main tab to employees.html.
// Self-contained: injects its own tab button, panel and scoped styles.
// Reads timecardVerifications directly (no indexed queries) and stays live.

import { db } from './auth.js';
import {
  ref,
  get,
  update,
  onValue
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const auth = getAuth();
const MASTER_ADMIN_EMAIL = 'kumonchamps@gmail.com';
const TAB_KEY = 'approvals';
const PANEL_ID = 'main-tab-approvals';
const AGING_DAYS = 3;
const UNDO_MS = 9000;

/* =========================================
   STATE
========================================= */
const state = {
  verifications: {},
  employees: {},
  loading: true,
  error: null,
  search: '',
  center: 'all',
  from: '',
  to: '',
  sort: 'requested_desc',
  selected: new Set(),
  busy: new Set(),
  timeOverrides: {},
  mounted: false,
  subscribed: false,
  lastPendingCount: 0
};

let undoBatch = null;
let toastTimer = null;
let toastTick = null;

/* =========================================
   HELPERS
========================================= */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (s) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[s]));
}

function normText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normTime(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
}

function ms(value) {
  const d = new Date(value);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function isToday(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return false;
  return d.toDateString() === new Date().toDateString();
}

function daysWaiting(value) {
  const t = ms(value);
  if (!t) return 0;
  return Math.floor((Date.now() - t) / 86400000);
}

function timeAgo(value) {
  const t = ms(value);
  if (!t) return '—';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

function exactTime(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function getPositions(emp) {
  if (!emp) return [];
  if (Array.isArray(emp.positions)) return emp.positions.filter(Boolean);
  if (emp.position) return [emp.position];
  return [];
}

function hasManagementRole(positions) {
  const p = positions.map((x) => String(x).trim().toLowerCase());
  return p.includes('manager') || p.includes('master admin');
}

/* =========================================
   ROW NORMALISATION
   Accepts every field variant used across the
   system so no pending record is ever hidden.
========================================= */
function buildRow(id, v) {
  const rawType = String(v?.missingType || '').toLowerCase().replace(/[\s_-]/g, '');
  const fixType = rawType === 'in' ? 'in' : 'out';

  const proposed = fixType === 'in'
    ? (v?.proposedInTime || v?.proposedTime || v?.proposedClockIn || '')
    : (v?.proposedOutTime || v?.proposedTime || v?.proposedClockOut || '');

  const emp = state.employees[v?.empId] || {};
  const name = emp.englishName || v?.empName || emp.name || v?.empId || 'Unknown';
  const chinese = emp.chineseName || v?.empChineseName || '';
  const positions = getPositions(emp).join(', ') || v?.position || '';
  const requestedAt = v?.resubmittedAt || v?.requestedAt || v?.createdAt || '';

  return {
    id,
    raw: v || {},
    empId: v?.empId || '',
    name,
    chinese,
    positions,
    email: emp.email || v?.email || '',
    date: v?.date || '',
    center: v?.center || v?.centerId || '',
    fixType,
    inTime: normTime(v?.inTime || ''),
    outTime: normTime(v?.outTime || ''),
    proposed: normTime(proposed),
    requestedAt,
    waiting: daysWaiting(requestedAt),
    resubmitted: !!v?.resubmittedAt
  };
}

function allRows() {
  return Object.entries(state.verifications || {})
    .filter(([, v]) => String(v?.status || '').toLowerCase() === 'pending')
    .map(([id, v]) => buildRow(id, v));
}

function visibleRows() {
  let rows = allRows();
  const q = normText(state.search);

  if (q) {
    rows = rows.filter((r) =>
      normText([r.name, r.chinese, r.email, r.center, r.date, r.positions].join(' ')).includes(q)
    );
  }
  if (state.center !== 'all') {
    rows = rows.filter((r) => String(r.center || '') === state.center);
  }
  if (state.from) rows = rows.filter((r) => r.date && r.date >= state.from);
  if (state.to) rows = rows.filter((r) => r.date && r.date <= state.to);

  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const sorters = {
    requested_desc: (a, b) => ms(b.requestedAt) - ms(a.requestedAt) || byName(a, b),
    requested_asc: (a, b) => ms(a.requestedAt) - ms(b.requestedAt) || byName(a, b),
    date_desc: (a, b) => String(b.date).localeCompare(String(a.date)) || byName(a, b),
    date_asc: (a, b) => String(a.date).localeCompare(String(b.date)) || byName(a, b),
    name_asc: byName
  };
  return rows.sort(sorters[state.sort] || sorters.requested_desc);
}

function stats() {
  const entries = Object.values(state.verifications || {});
  const pending = allRows();
  return {
    pending: pending.length,
    aging: pending.filter((r) => r.waiting >= AGING_DAYS).length,
    approvedToday: entries.filter(
      (v) => String(v?.status || '').toLowerCase() === 'confirmed' && isToday(v?.resolvedAt)
    ).length,
    deniedToday: entries.filter(
      (v) => String(v?.status || '').toLowerCase() === 'denied' && isToday(v?.resolvedAt)
    ).length
  };
}

function centerOptions() {
  return [...new Set(allRows().map((r) => String(r.center || '')).filter(Boolean))].sort();
}

function proposedValue(row) {
  return state.timeOverrides[row.id] !== undefined
    ? state.timeOverrides[row.id]
    : row.proposed;
}

/* =========================================
   STYLES (scoped, uses your existing palette)
========================================= */
function injectStyles() {
  if (document.getElementById('pta-styles')) return;
  const style = document.createElement('style');
  style.id = 'pta-styles';
  style.textContent = `
#main-tab-approvals { --pta-amber:#b45309; --pta-amber-bg:#fef3c7; --pta-amber-line:#fde68a; }
#main-tab-approvals .pta-head { display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
#main-tab-approvals .pta-title { font-size:1.15rem; font-weight:700; color:var(--primary-dark,#4682B4); margin:0; }
#main-tab-approvals .pta-sub { font-size:.85rem; color:var(--text-light,#666); margin:.2rem 0 0; }
#main-tab-approvals .pta-live { display:inline-flex; align-items:center; gap:.4rem; font-size:.78rem; font-weight:600; color:#065f46; background:#d1fae5; border:1px solid #a7f3d0; border-radius:999px; padding:.25rem .7rem; }
#main-tab-approvals .pta-live i { width:7px; height:7px; border-radius:50%; background:#059669; animation:ptaPulse 1.6s infinite; }
@keyframes ptaPulse { 0%,100%{opacity:.35; transform:scale(.8);} 50%{opacity:1; transform:scale(1.15);} }

#main-tab-approvals .pta-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:.75rem; margin-bottom:1rem; }
#main-tab-approvals .pta-stat { background:#fff; border:1px solid #e2e8f0; border-left:4px solid var(--primary,#87CEEB); border-radius:10px; padding:.85rem 1rem; box-shadow:var(--shadow,0 2px 10px rgba(0,0,0,.08)); transition:transform .18s ease, box-shadow .18s ease; }
#main-tab-approvals .pta-stat:hover { transform:translateY(-2px); box-shadow:0 8px 20px rgba(70,130,180,.16); }
#main-tab-approvals .pta-stat.warn { border-left-color:#f59e0b; }
#main-tab-approvals .pta-stat.ok { border-left-color:#059669; }
#main-tab-approvals .pta-stat.bad { border-left-color:#dc3545; }
#main-tab-approvals .pta-stat span { display:block; font-size:.74rem; font-weight:600; letter-spacing:.4px; text-transform:uppercase; color:#64748b; }
#main-tab-approvals .pta-stat strong { display:block; font-size:1.6rem; line-height:1.2; color:#1e293b; font-weight:700; }

#main-tab-approvals .pta-toolbar { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:.75rem; margin-bottom:.75rem; }
#main-tab-approvals .pta-toolbar input[type="text"] { flex:1 1 220px; min-width:180px; width:auto; padding:.55rem .7rem; font-size:.9rem; min-height:40px; }
#main-tab-approvals .pta-toolbar select,
#main-tab-approvals .pta-toolbar input[type="date"] { width:auto; min-width:140px; padding:.55rem .6rem; font-size:.85rem; min-height:40px; }
#main-tab-approvals .pta-field { display:flex; align-items:center; gap:.35rem; font-size:.78rem; font-weight:600; color:#64748b; }
#main-tab-approvals .pta-btn { min-height:40px; padding:.5rem .9rem; font-size:.85rem; font-weight:600; border:none; border-radius:8px; cursor:pointer; transition:transform .12s ease, background .2s ease, opacity .2s; }
#main-tab-approvals .pta-btn:active { transform:scale(.97); }
#main-tab-approvals .pta-btn.ghost { background:#f1f5f9; color:#334155; border:1px solid #cbd5e1; }
#main-tab-approvals .pta-btn.ghost:hover { background:#e2e8f0; }
#main-tab-approvals .pta-btn.primary { background:var(--primary-dark,#4682B4); color:#fff; }
#main-tab-approvals .pta-btn.primary:hover { background:#3a6f94; }
#main-tab-approvals .pta-btn.danger { background:var(--danger,#dc3545); color:#fff; }
#main-tab-approvals .pta-btn.danger:hover { background:#b02a37; }
#main-tab-approvals .pta-btn:disabled { opacity:.5; cursor:not-allowed; transform:none; }

#main-tab-approvals .pta-bulk { display:flex; flex-wrap:wrap; align-items:center; gap:.6rem; background:#e8f0fe; border:1px solid #bfdbfe; border-radius:10px; padding:.6rem .85rem; margin-bottom:.75rem; }
#main-tab-approvals .pta-bulk-count { font-weight:700; color:#1e40af; font-size:.88rem; margin-right:auto; }

#main-tab-approvals .pta-table-wrap { background:#fff; border:1px solid #e2e8f0; border-radius:10px; box-shadow:var(--shadow,0 2px 10px rgba(0,0,0,.08)); overflow:auto; max-height:calc(100vh - 400px); scrollbar-width:thin; scrollbar-color:#87CEEB #eef4fa; }
#main-tab-approvals .pta-table-wrap::-webkit-scrollbar { width:10px; height:10px; }
#main-tab-approvals .pta-table-wrap::-webkit-scrollbar-track { background:#eef4fa; border-radius:8px; }
#main-tab-approvals .pta-table-wrap::-webkit-scrollbar-thumb { background:linear-gradient(180deg,#87CEEB,#4682B4); border-radius:8px; border:2px solid #eef4fa; }
#main-tab-approvals .pta-table-wrap::-webkit-scrollbar-thumb:hover { background:#3a6f94; }

#main-tab-approvals .pta-table { width:100%; border-collapse:collapse; font-size:.88rem; min-width:940px; }
#main-tab-approvals .pta-table thead th { background:var(--primary,#87CEEB); color:#fff; font-weight:600; text-align:left; padding:.7rem .6rem; position:sticky; top:0; z-index:5; white-space:nowrap; }
#main-tab-approvals .pta-table tbody td { padding:.7rem .6rem; border-bottom:1px solid #eef2f7; vertical-align:middle; }
#main-tab-approvals .pta-table tbody tr { transition:background .15s ease; }
#main-tab-approvals .pta-table tbody tr:hover { background:#f8fbff; }
#main-tab-approvals .pta-table tbody tr.is-busy { opacity:.55; }
#main-tab-approvals .pta-table tbody tr.is-picked { background:#eff6ff; }
#main-tab-approvals .pta-check { width:17px; height:17px; accent-color:var(--primary-dark,#4682B4); cursor:pointer; margin:0; }

#main-tab-approvals .pta-name { font-weight:700; color:#1e293b; }
#main-tab-approvals .pta-meta { font-size:.76rem; color:#64748b; margin-top:2px; }
#main-tab-approvals .pta-chip { display:inline-block; padding:.15rem .55rem; border-radius:999px; font-size:.72rem; font-weight:700; background:#f1f5f9; color:#475569; border:1px solid #e2e8f0; }
#main-tab-approvals .pta-chip.in { background:#dbeafe; color:#1e40af; border-color:#bfdbfe; }
#main-tab-approvals .pta-chip.out { background:#e0f2fe; color:#0369a1; border-color:#bae6fd; }
#main-tab-approvals .pta-chip.age { background:var(--pta-amber-bg); color:var(--pta-amber); border-color:var(--pta-amber-line); }
#main-tab-approvals .pta-chip.new { background:#dcfce7; color:#15803d; border-color:#bbf7d0; }
#main-tab-approvals .pta-time { font-weight:700; color:#0f172a; font-variant-numeric:tabular-nums; }
#main-tab-approvals .pta-time-input { width:130px; padding:.4rem .5rem; font-size:.85rem; min-height:36px; border:1px solid #cbd5e1; border-radius:6px; }
#main-tab-approvals .pta-row-actions { display:flex; gap:.4rem; flex-wrap:wrap; }
#main-tab-approvals .pta-row-actions .pta-btn { min-height:34px; padding:.35rem .7rem; font-size:.78rem; }
#main-tab-approvals .pta-empty { text-align:center; padding:2.5rem 1rem; color:var(--text-light,#666); }
#main-tab-approvals .pta-empty strong { display:block; font-size:1rem; color:#334155; margin-bottom:.3rem; }
#main-tab-approvals .pta-error { background:#fee2e2; border:1px solid #fecaca; color:#991b1b; border-radius:10px; padding:1rem; display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }

.pta-toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(20px); opacity:0; z-index:4000; background:#0f172a; color:#fff; border-radius:12px; padding:.85rem 1rem; box-shadow:0 16px 40px rgba(15,23,42,.35); display:flex; align-items:center; gap:.85rem; max-width:min(92vw,560px); font-size:.9rem; transition:opacity .22s ease, transform .22s ease; overflow:hidden; }
.pta-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
.pta-toast .pta-toast-msg { font-weight:600; }
.pta-toast button { background:transparent; border:1px solid rgba(255,255,255,.4); color:#fff; border-radius:8px; padding:.35rem .8rem; font-size:.82rem; font-weight:700; cursor:pointer; min-height:0; }
.pta-toast button:hover { background:rgba(255,255,255,.15); }
.pta-toast .pta-toast-bar { position:absolute; left:0; bottom:0; height:3px; background:linear-gradient(90deg,#87CEEB,#059669); width:100%; transform-origin:left; }

@media (max-width:768px) {
  #main-tab-approvals .pta-table-wrap { max-height:none; overflow:visible; background:transparent; border:none; box-shadow:none; }
  #main-tab-approvals .pta-table { min-width:0; }
  #main-tab-approvals .pta-table thead { display:none; }
  #main-tab-approvals .pta-table tbody tr { display:block; background:#fff; border:1px solid #e2e8f0; border-radius:8px; box-shadow:var(--shadow,0 2px 10px rgba(0,0,0,.08)); padding:.85rem; margin-bottom:.75rem; }
  #main-tab-approvals .pta-table tbody td { display:flex; justify-content:space-between; align-items:center; gap:.6rem; padding:.45rem 0; border:none; border-bottom:1px solid #f1f5f9; }
  #main-tab-approvals .pta-table tbody td::before { content:attr(data-label); font-weight:600; color:var(--primary-dark,#4682B4); font-size:.78rem; min-width:92px; flex-shrink:0; }
  #main-tab-approvals .pta-table tbody td[data-label=""]::before { display:none; }
  #main-tab-approvals .pta-table tbody td[data-label=""] { justify-content:flex-start; border-bottom:none; }
  #main-tab-approvals .pta-table tbody td:last-child { padding-top:.7rem; }
  #main-tab-approvals .pta-row-actions { width:100%; }
  #main-tab-approvals .pta-row-actions .pta-btn { flex:1; min-height:42px; font-size:.85rem; }
  #main-tab-approvals .pta-toolbar select,
  #main-tab-approvals .pta-toolbar input[type="date"] { flex:1 1 140px; }
}
`;
  document.head.appendChild(style);
}

/* =========================================
   MOUNT
========================================= */
function panelMarkup() {
  return `
    <div class="pta-head">
      <div>
        <h3 class="pta-title">Pending Timeclock Approvals</h3>
        <p class="pta-sub">Employee-submitted clock-out and clock-in fixes. Approving writes the time straight into the timecard.</p>
      </div>
      <span class="pta-live"><i></i> Live</span>
    </div>

    <div class="pta-stats" id="ptaStats"></div>

    <div class="pta-toolbar">
      <input type="text" id="ptaSearch" placeholder="🔎 Search employee, center or date..." aria-label="Search approvals">
      <select id="ptaCenter" aria-label="Filter by center"><option value="all">All centers</option></select>
      <span class="pta-field">From <input type="date" id="ptaFrom" aria-label="From date"></span>
      <span class="pta-field">To <input type="date" id="ptaTo" aria-label="To date"></span>
      <select id="ptaSort" aria-label="Sort">
        <option value="requested_desc">Newest request</option>
        <option value="requested_asc">Oldest request</option>
        <option value="date_desc">Shift date ↓</option>
        <option value="date_asc">Shift date ↑</option>
        <option value="name_asc">Employee A–Z</option>
      </select>
      <button type="button" class="pta-btn ghost" id="ptaSelectAll">Select all</button>
      <button type="button" class="pta-btn ghost" id="ptaReset">Reset filters</button>
      <button type="button" class="pta-btn ghost" id="ptaExport">⬇ Export CSV</button>
      <button type="button" class="pta-btn primary" id="ptaRefresh">↻ Refresh</button>
    </div>

    <div class="pta-bulk" id="ptaBulk" style="display:none;">
      <span class="pta-bulk-count" id="ptaBulkCount">0 selected</span>
      <button type="button" class="pta-btn ghost" id="ptaClearSel">Clear</button>
      <button type="button" class="pta-btn danger" id="ptaDenySel">❌ Deny selected</button>
      <button type="button" class="pta-btn primary" id="ptaApproveSel">✅ Approve selected</button>
    </div>

    <div id="ptaBody"></div>
  `;
}

function mount() {
  if (state.mounted) return true;
  if (document.getElementById(PANEL_ID)) { state.mounted = true; return true; }

  const anchorBtn =
    document.querySelector('[data-main-tab="incomplete"]') ||
    document.querySelector('[data-main-tab]');
  const anchorPanel =
    document.getElementById('main-tab-incomplete') ||
    document.querySelector('[id^="main-tab-"]');

  if (!anchorBtn || !anchorPanel || !anchorBtn.parentElement || !anchorPanel.parentElement) return false;

  injectStyles();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'approvalsTabBtn';
  btn.dataset.mainTab = TAB_KEY;
  btn.className = String(anchorBtn.className || '').replace(/\bactive\b/g, '').replace(/\s+/g, ' ').trim();
  btn.innerHTML = `⏱️ Pending Timeclock Approvals <span class="tab-badge hidden" id="approvalsBadge">0</span>`;

  const permBtn = anchorBtn.parentElement.querySelector('[data-main-tab="permissions"]');
  if (permBtn) permBtn.insertAdjacentElement('beforebegin', btn);
  else anchorBtn.parentElement.appendChild(btn);

  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.className = `${String(anchorPanel.className || '').replace(/\bactive\b/g, '').replace(/\s+/g, ' ').trim()} pta-panel`.trim();
  panel.innerHTML = panelMarkup();
  anchorPanel.insertAdjacentElement('afterend', panel);

  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-main-tab]').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('[id^="main-tab-"]').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    panel.classList.add('active');
    render();
  });

  bindPanel(panel);
  state.mounted = true;
  render();
  return true;
}

function tryMountWithRetry() {
  if (mount()) return;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (mount() || tries > 60) clearInterval(timer);
  }, 200);
}

/* =========================================
   RENDER
========================================= */
function render() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;

  const rows = visibleRows();
  const s = stats();

  const badge = document.getElementById('approvalsBadge');
  if (badge) {
    if (s.pending > 0) {
      badge.textContent = s.pending > 99 ? '99+' : String(s.pending);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  state.lastPendingCount = s.pending;

  const statsEl = panel.querySelector('#ptaStats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="pta-stat"><span>Pending</span><strong>${s.pending}</strong></div>
      <div class="pta-stat warn"><span>Waiting ${AGING_DAYS}+ days</span><strong>${s.aging}</strong></div>
      <div class="pta-stat ok"><span>Approved today</span><strong>${s.approvedToday}</strong></div>
      <div class="pta-stat bad"><span>Denied today</span><strong>${s.deniedToday}</strong></div>
    `;
  }

  const centerSel = panel.querySelector('#ptaCenter');
  if (centerSel) {
    const opts = centerOptions();
    const current = state.center;
    centerSel.innerHTML =
      `<option value="all">All centers</option>` +
      opts.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    centerSel.value = opts.includes(current) ? current : 'all';
    if (centerSel.value === 'all') state.center = 'all';
  }

  const visibleIds = new Set(rows.map((r) => r.id));
  [...state.selected].forEach((id) => { if (!visibleIds.has(id)) state.selected.delete(id); });

  const bulk = panel.querySelector('#ptaBulk');
  const bulkCount = panel.querySelector('#ptaBulkCount');
  if (bulk) bulk.style.display = state.selected.size ? 'flex' : 'none';
  if (bulkCount) bulkCount.textContent = `${state.selected.size} selected`;

  const body = panel.querySelector('#ptaBody');
  if (!body) return;

  if (state.error) {
    body.innerHTML = `
      <div class="pta-error">
        <span>⚠️ Could not load approvals: ${esc(state.error.message || state.error)}</span>
        <button type="button" class="pta-btn primary" id="ptaRetry">Try again</button>
      </div>`;
    return;
  }

  if (state.loading) {
    body.innerHTML = `<div class="pta-empty"><strong>⏳ Loading approvals…</strong>Reading submitted timeclock fixes.</div>`;
    return;
  }

  if (!rows.length) {
    const filtered = allRows().length > 0;
    body.innerHTML = `
      <div class="pta-empty">
        <strong>${filtered ? 'No approvals match your filters' : '✅ Nothing waiting for approval'}</strong>
        ${filtered ? 'Try resetting the filters above.' : 'New employee submissions will appear here automatically.'}
      </div>`;
    return;
  }

  const allPicked = rows.every((r) => state.selected.has(r.id));

  body.innerHTML = `
    <div class="pta-table-wrap">
      <table class="pta-table">
        <thead>
          <tr>
            <th style="width:38px;"><input type="checkbox" class="pta-check" id="ptaHeadCheck" ${allPicked ? 'checked' : ''} aria-label="Select all"></th>
            <th>Employee</th>
            <th>Shift Date</th>
            <th>Center</th>
            <th>Recorded</th>
            <th>Proposed Fix</th>
            <th>Requested</th>
            <th style="width:190px;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => rowMarkup(r)).join('')}
        </tbody>
      </table>
    </div>`;

  const head = body.querySelector('#ptaHeadCheck');
  if (head) {
    const picked = rows.filter((r) => state.selected.has(r.id)).length;
    head.indeterminate = picked > 0 && picked < rows.length;
  }
}

function rowMarkup(r) {
  const busy = state.busy.has(r.id);
  const picked = state.selected.has(r.id);
  const value = proposedValue(r);
  const recorded = r.fixType === 'in'
    ? (r.outTime ? `<span class="pta-chip out">OUT</span> <span class="pta-time">${esc(r.outTime)}</span>` : '—')
    : (r.inTime ? `<span class="pta-chip in">IN</span> <span class="pta-time">${esc(r.inTime)}</span>` : '—');

  const ageChip = r.waiting >= AGING_DAYS
    ? `<span class="pta-chip age">${r.waiting}d waiting</span>`
    : (r.resubmitted ? `<span class="pta-chip new">resubmitted</span>` : '');

  return `
    <tr data-id="${esc(r.id)}" class="${busy ? 'is-busy' : ''} ${picked ? 'is-picked' : ''}">
      <td data-label=""><input type="checkbox" class="pta-check pta-row-check" data-id="${esc(r.id)}" ${picked ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="Select row"></td>
      <td data-label="Employee">
        <div>
          <div class="pta-name">${esc(r.name)}${r.chinese ? ` <span class="pta-meta">(${esc(r.chinese)})</span>` : ''}</div>
          <div class="pta-meta">${esc(r.positions || r.email || '')}</div>
        </div>
      </td>
      <td data-label="Shift Date"><span class="pta-time">${esc(r.date || '—')}</span></td>
      <td data-label="Center">${esc(r.center || '—')}</td>
      <td data-label="Recorded">${recorded}</td>
      <td data-label="Proposed Fix">
        <span class="pta-chip ${r.fixType}">${r.fixType.toUpperCase()}</span>
        <input type="time" class="pta-time-input" data-id="${esc(r.id)}" value="${esc(value)}" ${busy ? 'disabled' : ''} aria-label="Proposed time">
      </td>
      <td data-label="Requested">
        <div>
          <div>${esc(timeAgo(r.requestedAt))}</div>
          <div class="pta-meta">${esc(exactTime(r.requestedAt))} ${ageChip}</div>
        </div>
      </td>
      <td data-label="">
        <div class="pta-row-actions">
          <button type="button" class="pta-btn primary" data-pta-approve="${esc(r.id)}" ${busy ? 'disabled' : ''}>✅ Approve</button>
          <button type="button" class="pta-btn danger" data-pta-deny="${esc(r.id)}" ${busy ? 'disabled' : ''}>❌ Deny</button>
        </div>
      </td>
    </tr>`;
}

/* =========================================
   EVENTS
========================================= */
function bindPanel(panel) {
  panel.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'ptaSearch') { state.search = t.value; render(); return; }
    if (t.classList.contains('pta-time-input')) {
      state.timeOverrides[t.dataset.id] = t.value;
    }
  });

  panel.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'ptaCenter') { state.center = t.value; render(); return; }
    if (t.id === 'ptaFrom') { state.from = t.value; render(); return; }
    if (t.id === 'ptaTo') { state.to = t.value; render(); return; }
    if (t.id === 'ptaSort') { state.sort = t.value; render(); return; }
    if (t.id === 'ptaHeadCheck') {
      const rows = visibleRows();
      if (t.checked) rows.forEach((r) => state.selected.add(r.id));
      else rows.forEach((r) => state.selected.delete(r.id));
      render();
      return;
    }
    if (t.classList.contains('pta-row-check')) {
      if (t.checked) state.selected.add(t.dataset.id);
      else state.selected.delete(t.dataset.id);
      render();
    }
  });

  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.id === 'ptaRefresh' || btn.id === 'ptaRetry') { await refreshNow(); return; }
    if (btn.id === 'ptaExport') { exportCsv(); return; }
    if (btn.id === 'ptaReset') {
      state.search = ''; state.center = 'all'; state.from = ''; state.to = ''; state.sort = 'requested_desc';
      const s = panel.querySelector('#ptaSearch'); if (s) s.value = '';
      const f = panel.querySelector('#ptaFrom'); if (f) f.value = '';
      const to = panel.querySelector('#ptaTo'); if (to) to.value = '';
      const so = panel.querySelector('#ptaSort'); if (so) so.value = 'requested_desc';
      render();
      return;
    }
    if (btn.id === 'ptaSelectAll') {
      const rows = visibleRows();
      const all = rows.length && rows.every((r) => state.selected.has(r.id));
      if (all) rows.forEach((r) => state.selected.delete(r.id));
      else rows.forEach((r) => state.selected.add(r.id));
      render();
      return;
    }
    if (btn.id === 'ptaClearSel') { state.selected.clear(); render(); return; }
    if (btn.id === 'ptaApproveSel') { await runBulk(true); return; }
    if (btn.id === 'ptaDenySel') { await runBulk(false); return; }

    const approveId = btn.dataset.ptaApprove;
    if (approveId) { await runSingle(approveId, true); return; }
    const denyId = btn.dataset.ptaDeny;
    if (denyId) { await runSingle(denyId, false); }
  });
}

/* =========================================
   ACTIONS
========================================= */
function rowById(id) {
  const v = state.verifications[id];
  if (!v) return null;
  return buildRow(id, v);
}

function validateTime(row, time) {
  if (!time) return 'Please enter the proposed time first.';
  if (!row.date || !row.empId) return 'This request is missing a date or employee id.';
  if (row.fixType === 'out' && row.inTime && normTime(time) <= row.inTime) {
    return 'Clock-out must be later than the recorded clock-in.';
  }
  if (row.fixType === 'in' && row.outTime && normTime(time) >= row.outTime) {
    return 'Clock-in must be earlier than the recorded clock-out.';
  }
  return null;
}

async function approveRow(row, time) {
  const uid = auth.currentUser?.uid || '';
  const now = new Date().toISOString();
  const prev = { ...(state.verifications[row.id] || {}) };
  const location = row.center || 'Manual Fix';
  const patch = { status: 'confirmed', resolvedBy: uid, resolvedAt: now };
  patch[row.fixType === 'in' ? 'actualInTime' : 'actualOutTime'] = time;

  await update(ref(db, `timecardVerifications/${row.id}`), patch);

  let added = false;
  const dayRef = ref(db, `timecards/${row.date}/${row.empId}`);
  const snap = await get(dayRef);
  let logs = snap.val()?.logs || [];
  if (!Array.isArray(logs)) logs = Object.values(logs);
  const exists = logs.some(
    (l) => l && l.type === row.fixType &&
      normTime(l.time) === normTime(time) &&
      normText(l.location) === normText(location)
  );
  if (!exists) {
    logs = [...logs, { type: row.fixType, time, location }];
    logs.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    await update(dayRef, { logs });
    added = true;
  }

  return { kind: 'approve', id: row.id, prev, added, fixType: row.fixType, time, location, date: row.date, empId: row.empId };
}

async function denyRow(row) {
  const uid = auth.currentUser?.uid || '';
  const now = new Date().toISOString();
  const prev = { ...(state.verifications[row.id] || {}) };
  await update(ref(db, `timecardVerifications/${row.id}`), {
    status: 'denied',
    resolvedBy: uid,
    resolvedAt: now
  });
  return { kind: 'deny', id: row.id, prev };
}

async function undoOne(action) {
  const restore = {
    status: action.prev.status || 'pending',
    resolvedBy: action.prev.resolvedBy ?? null,
    resolvedAt: action.prev.resolvedAt ?? null,
    actualInTime: action.prev.actualInTime ?? null,
    actualOutTime: action.prev.actualOutTime ?? null
  };
  await update(ref(db, `timecardVerifications/${action.id}`), restore);

  if (action.kind === 'approve' && action.added) {
    const dayRef = ref(db, `timecards/${action.date}/${action.empId}`);
    const snap = await get(dayRef);
    let logs = snap.val()?.logs || [];
    if (!Array.isArray(logs)) logs = Object.values(logs);
    let idx = -1;
    for (let i = logs.length - 1; i >= 0; i--) {
      const l = logs[i];
      if (l && l.type === action.fixType &&
          normTime(l.time) === normTime(action.time) &&
          normText(l.location) === normText(action.location)) { idx = i; break; }
    }
    if (idx >= 0) {
      logs = logs.slice(0, idx).concat(logs.slice(idx + 1));
      await update(dayRef, { logs });
    }
  }
}

async function runSingle(id, approve) {
  if (state.busy.has(id)) return;
  const row = rowById(id);
  if (!row) return;

  const time = normTime(proposedValue(row));
  if (approve) {
    const problem = validateTime(row, time);
    if (problem) { alert(problem); return; }
  }

  state.busy.add(id);
  render();
  try {
    const action = approve ? await approveRow(row, time) : await denyRow(row);
    state.selected.delete(id);
    delete state.timeOverrides[id];
    undoBatch = [action];
    showToast(
      approve ? `Approved ${row.name} — ${row.date}` : `Denied ${row.name} — ${row.date}`,
      true
    );
  } catch (err) {
    console.error('Approval action failed:', err);
    alert(`Failed to ${approve ? 'approve' : 'deny'} this request: ${err.message || err}`);
  } finally {
    state.busy.delete(id);
    render();
  }
}

async function runBulk(approve) {
  const ids = [...state.selected];
  if (!ids.length) return;

  const rows = ids.map(rowById).filter(Boolean);
  if (approve) {
    const bad = rows.filter((r) => validateTime(r, normTime(proposedValue(r))));
    if (bad.length) {
      alert(`${bad.length} selected request(s) have a missing or invalid time:\n\n${bad.map((r) => `• ${r.name} — ${r.date}`).join('\n')}\n\nFix the highlighted times and try again.`);
      return;
    }
  }

  const label = approve ? 'Approve' : 'Deny';
  if (!confirm(`${label} ${rows.length} selected request(s)?`)) return;

  rows.forEach((r) => state.busy.add(r.id));
  render();

  const done = [];
  const failed = [];
  for (const row of rows) {
    try {
      const action = approve
        ? await approveRow(row, normTime(proposedValue(row)))
        : await denyRow(row);
      done.push(action);
      state.selected.delete(row.id);
      delete state.timeOverrides[row.id];
    } catch (err) {
      console.error('Bulk action failed for', row.id, err);
      failed.push(row);
    } finally {
      state.busy.delete(row.id);
      render();
    }
  }

  if (done.length) {
    undoBatch = done;
    showToast(
      `${approve ? 'Approved' : 'Denied'} ${done.length} request(s)` +
      (failed.length ? ` · ${failed.length} failed` : ''),
      true
    );
  }
  if (failed.length && !done.length) {
    alert(`Failed to ${label.toLowerCase()} ${failed.length} request(s). Check the console for details.`);
  }
  render();
}

async function refreshNow() {
  const btn = document.getElementById('ptaRefresh');
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing…'; }
  try {
    const snap = await get(ref(db, 'timecardVerifications'));
    state.verifications = snap.exists() ? snap.val() : {};
    state.error = null;
    state.loading = false;
  } catch (err) {
    state.error = err;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original || '↻ Refresh'; }
    render();
  }
}

/* =========================================
   CSV EXPORT
========================================= */
function exportCsv() {
  const rows = visibleRows();
  if (!rows.length) { alert('Nothing to export with the current filters.'); return; }
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Employee', 'Chinese Name', 'Position', 'Shift Date', 'Center', 'Recorded In', 'Recorded Out', 'Fix Type', 'Proposed Time', 'Requested At', 'Days Waiting'];
  const lines = [header.map(cell).join(',')];
  rows.forEach((r) => {
    lines.push([
      r.name, r.chinese, r.positions, r.date, r.center,
      r.inTime, r.outTime, r.fixType.toUpperCase(),
      proposedValue(r), exactTime(r.requestedAt), r.waiting
    ].map(cell).join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Pending_Timeclock_Approvals_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* =========================================
   TOAST + UNDO
========================================= */
function showToast(message, canUndo) {
  hideToast();
  const toast = document.createElement('div');
  toast.className = 'pta-toast';
  toast.id = 'ptaToast';
  toast.innerHTML = `
    <span class="pta-toast-msg">${esc(message)}</span>
    ${canUndo ? '<button type="button" id="ptaUndoBtn">Undo</button>' : ''}
    <button type="button" id="ptaToastClose" aria-label="Dismiss">✕</button>
    <span class="pta-toast-bar" id="ptaToastBar"></span>
  `;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  const bar = toast.querySelector('#ptaToastBar');
  const start = Date.now();
  toastTick = setInterval(() => {
    const left = Math.max(0, 1 - (Date.now() - start) / UNDO_MS);
    if (bar) bar.style.transform = `scaleX(${left})`;
  }, 60);

  toast.querySelector('#ptaToastClose')?.addEventListener('click', hideToast);
  toast.querySelector('#ptaUndoBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Undoing…';
    const batch = undoBatch || [];
    let ok = 0;
    for (const action of batch) {
      try { await undoOne(action); ok += 1; }
      catch (err) { console.error('Undo failed:', err); }
    }
    undoBatch = null;
    hideToast();
    if (ok) showToast(`Reverted ${ok} change(s)`, false);
    else alert('Undo failed. Please check the record manually.');
    setTimeout(hideToast, 2600);
  });

  toastTimer = setTimeout(hideToast, UNDO_MS);
}

function hideToast() {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (toastTick) { clearInterval(toastTick); toastTick = null; }
  const toast = document.getElementById('ptaToast');
  if (toast) {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 240);
  }
}

/* =========================================
   ACCESS + DATA
========================================= */
async function hasAccess(user) {
  if (!user) return false;
  if (String(user.email || '').toLowerCase() === MASTER_ADMIN_EMAIL) return true;
  try {
    const snap = await get(ref(db, `users/${user.uid}`));
    if (snap.exists() && hasManagementRole(getPositions(snap.val()))) return true;
  } catch (err) { /* fall through to employee match */ }
  try {
    const snap = await get(ref(db, 'employees'));
    if (snap.exists()) {
      const email = String(user.email || '').toLowerCase();
      const match = Object.values(snap.val()).find(
        (e) => String(e?.email || '').toLowerCase() === email
      );
      if (match && hasManagementRole(getPositions(match))) return true;
    }
  } catch (err) { /* no access */ }
  return false;
}

function subscribe() {
  if (state.subscribed) return;
  state.subscribed = true;

  onValue(
    ref(db, 'employees'),
    (snap) => { state.employees = snap.val() || {}; render(); },
    (err) => console.warn('Approvals: employee lookup unavailable', err)
  );

  onValue(
    ref(db, 'timecardVerifications'),
    (snap) => {
      state.verifications = snap.val() || {};
      state.loading = false;
      state.error = null;
      render();
    },
    (err) => {
      console.error('Approvals: could not read timecardVerifications', err);
      state.error = err;
      state.loading = false;
      render();
    }
  );
}

/* =========================================
   BOOT
========================================= */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tryMountWithRetry, { once: true });
} else {
  tryMountWithRetry();
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  const allowed = await hasAccess(user);
  if (!allowed) return;
  tryMountWithRetry();
  subscribe();
});