// ============================================================
// timecard-offsite.js — 📍 OFF-SITE CLOCK IN/OUT ADDON (v1)
// ------------------------------------------------------------
// Purely additive. timecard.js / timecard.css / employees.js
// are NOT modified. All new UI is injected by this module.
//
// Features:
//  • Off-site Clock-In / Clock-Out requests (GPS capture)
//  • Google Maps embed shown to employee AND master admin
//  • Master-admin approval workflow (pending → approved/rejected)
//  • Pending Approvals panel + count badge + document.title badge
//  • Table badges, map-pin icons, relative-time tooltips,
//    off-site filter chip, smart "outside range" suggestion,
//    toast notifications. EN + 繁中, self-contained.
// ============================================================
import { db } from './auth.js';
import { ref, get, set, update, onValue, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const MASTER_ADMIN_EMAIL = 'kumonchamps@gmail.com';
const OS_LOCATION_MARKER = 'Off-site';      // stored in log.location (stable DB marker)
const OS_MIN_REASON_LEN  = 5;
const OS_ACC_WARN_M      = 100;             // flag weak GPS above this
const auth = getAuth();


// ============================================================
// 💉 SELF-INJECTED STYLES (v1.1) — no external CSS file needed
// ============================================================
const OS_CSS = `
:root{
  --os-pending:#f59e0b; --os-pending-bg:#fef3c7; --os-pending-text:#92400e;
  --os-approved:#059669; --os-approved-bg:#d1fae5;
  --os-rejected:#dc2626; --os-rejected-bg:#fee2e2;
  --os-blue:#4682B4; --os-radius:10px; --os-shadow:0 2px 10px rgba(0,0,0,0.1);
}
.os-zone{display:flex;flex-direction:column;align-items:center;gap:.5rem;margin:0 auto 1.2rem;}
.os-clock-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:48px;padding:.8rem 1.6rem;background:#fff;color:var(--os-pending-text);border:2px dashed var(--os-pending);border-radius:999px;font-size:.95rem;font-weight:700;cursor:pointer;transition:all .2s ease;box-shadow:0 2px 6px rgba(245,158,11,.15);}
.os-clock-btn:hover:not(:disabled){background:var(--os-pending-bg);transform:translateY(-1px);}
.os-clock-btn:active:not(:disabled){transform:translateY(0) scale(.98);}
.os-clock-btn:disabled{opacity:.55;cursor:not-allowed;filter:grayscale(.5);}
.os-clock-btn.is-busy{color:transparent;position:relative;}
.os-clock-btn.is-busy::after{content:'';position:absolute;width:20px;height:20px;border-radius:50%;border:3px solid rgba(146,64,14,.25);border-top-color:var(--os-pending-text);animation:osSpin .8s linear infinite;}
@keyframes osSpin{to{transform:rotate(360deg);}}
.os-pending-chip{font-size:.78rem;font-weight:700;color:var(--os-pending-text);background:var(--os-pending-bg);border:1px solid var(--os-pending);padding:.3rem .8rem;border-radius:999px;animation:osChipPulse 2.2s ease-in-out infinite;}
@keyframes osChipPulse{0%,100%{opacity:1;}50%{opacity:.6;}}
.os-filter-chip{flex:0 0 auto;align-self:flex-end;min-height:44px;padding:.6rem 1rem;margin-bottom:1px;background:#fff;color:var(--os-blue);border:1px solid #cbd5e1;border-radius:var(--os-radius);font-size:.88rem;font-weight:700;cursor:pointer;white-space:nowrap;transition:all .2s ease;}
.os-filter-chip:hover{border-color:var(--os-blue);background:#f0f8ff;}
.os-filter-chip.active{background:var(--os-blue);border-color:var(--os-blue);color:#fff;}
.os-panel{background:#fff;border-radius:12px;box-shadow:var(--os-shadow);border:2px solid var(--os-pending);padding:1rem 1.25rem;margin-bottom:1.25rem;}
.os-panel-head{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.25rem;}
.os-panel-head h2{font-size:1.05rem;color:var(--os-pending-text);margin:0;}
.os-panel-sub{font-size:.82rem;color:#666;margin-bottom:.9rem;}
.os-badge{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 .45rem;border-radius:999px;background:var(--os-pending);color:#fff;font-size:.8rem;font-weight:800;}
.os-empty{text-align:center;padding:1.4rem;color:#94a3b8;background:#f8fafc;border-radius:var(--os-radius);font-size:.92rem;}
.os-card{border:1px solid #e2e8f0;border-left:5px solid var(--os-pending);border-radius:var(--os-radius);padding:.9rem 1rem;margin-bottom:.8rem;background:#fffdf7;}
.os-card.resolved{background:#f8fafc;border-left-color:#94a3b8;}
.os-card.resolved.approved{border-left-color:var(--os-approved);}
.os-card.resolved.rejected{border-left-color:var(--os-rejected);}
.os-card-head{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;font-weight:700;color:#1e293b;}
.os-card-head .os-type{font-size:.75rem;font-weight:800;padding:.15rem .5rem;border-radius:6px;}
.os-type.in{background:#dbeafe;color:#1e40af;}
.os-type.out{background:#dcfce7;color:#166534;}
.os-card-meta{font-size:.82rem;color:#64748b;margin-top:.35rem;display:flex;flex-wrap:wrap;gap:.35rem .9rem;}
.os-card-meta .os-acc-warn{color:var(--os-rejected);font-weight:700;}
.os-reason{margin-top:.5rem;font-size:.9rem;background:#fff;border:1px dashed #e2e8f0;border-radius:8px;padding:.5rem .7rem;color:#334155;}
.os-address{font-size:.8rem;color:#64748b;margin-top:.4rem;}
.os-map-wrap{margin-top:.6rem;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;}
.os-map-wrap iframe{display:block;width:100%;height:220px;border:0;}
.os-card-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem;}
.os-btn{padding:.55rem 1rem;border:none;border-radius:8px;font-weight:700;font-size:.88rem;cursor:pointer;min-height:42px;display:inline-flex;align-items:center;gap:.4rem;text-decoration:none;color:#fff;transition:all .15s ease;}
.os-btn:disabled{opacity:.5;cursor:wait;}
.os-btn.approve{background:var(--os-approved);}
.os-btn.approve:hover:not(:disabled){background:#047857;}
.os-btn.reject{background:var(--os-rejected);}
.os-btn.reject:hover:not(:disabled){background:#b91c1c;}
.os-btn.ghost{background:#f1f5f9;color:#475569;}
.os-btn.ghost:hover{background:#e2e8f0;}
.os-history-toggle{background:none;border:none;color:var(--os-blue);font-weight:700;cursor:pointer;font-size:.85rem;padding:.4rem 0;text-decoration:underline;}
.os-status-badge{display:inline-block;margin-left:.4rem;padding:.15rem .5rem;border-radius:999px;font-size:.7rem;font-weight:800;letter-spacing:.04em;vertical-align:middle;}
.os-status-badge.pending{background:var(--os-pending-bg);color:var(--os-pending-text);animation:osChipPulse 2.2s ease-in-out infinite;}
.os-status-badge.approved{background:var(--os-approved-bg);color:var(--os-approved);}
.os-status-badge.rejected{background:var(--os-rejected-bg);color:var(--os-rejected);}
.os-pin-btn{background:none;border:none;cursor:pointer;font-size:1rem;padding:0 .15rem 0 0;vertical-align:middle;transition:transform .15s ease;min-height:auto;}
.os-pin-btn:hover{transform:scale(1.25);}
tr.os-row-rejected td{text-decoration:line-through;color:#94a3b8;}
tr.os-row-rejected td .os-status-badge{text-decoration:none;}
.os-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2500;display:flex;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:osFadeIn .2s ease;}
.os-modal-content{background:#fff;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.25);width:100%;max-width:460px;max-height:92vh;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:1.5rem;position:relative;animation:osSlideUp .25s ease;}
.os-modal-content h3{color:var(--os-blue);margin-bottom:.9rem;font-size:1.1rem;}
.os-modal-close{position:absolute;top:10px;right:14px;font-size:1.7rem;background:none;border:none;color:#666;cursor:pointer;padding:0;min-height:auto;line-height:1;}
.os-coords{font-size:.85rem;background:#f1f5f9;border-radius:8px;padding:.55rem .75rem;color:#475569;margin-bottom:.6rem;word-break:break-all;}
.os-acc-line{font-size:.85rem;color:#475569;margin-bottom:.6rem;}
.os-acc-line.warn{color:var(--os-rejected);font-weight:700;}
.os-modal .os-map-wrap{margin-top:0;margin-bottom:.8rem;}
.os-field{margin-top:.8rem;}
.os-field label{display:block;font-size:.85rem;font-weight:700;color:#555;margin-bottom:.35rem;}
.os-field textarea{width:100%;min-height:74px;resize:vertical;font-family:inherit;font-size:16px;}
.os-char-count{font-size:.75rem;color:#94a3b8;text-align:right;margin-top:.2rem;}
.os-char-count.ok{color:var(--os-approved);}
.os-modal-actions{display:flex;gap:.75rem;margin-top:1.1rem;}
.os-modal-actions .os-btn{flex:1;justify-content:center;min-height:48px;font-size:.95rem;}
@keyframes osFadeIn{from{opacity:0;}to{opacity:1;}}
@keyframes osSlideUp{from{transform:translateY(18px);opacity:0;}to{transform:translateY(0);opacity:1;}}
.os-suggest-btn{margin-top:1rem;width:100%;min-height:48px;background:var(--os-pending-bg);color:var(--os-pending-text);border:2px dashed var(--os-pending);border-radius:var(--os-radius);font-weight:800;font-size:.95rem;cursor:pointer;}
.os-suggest-btn:hover{background:#fde68a;}
.os-toasts{position:fixed;bottom:calc(1.2rem + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);z-index:3000;display:flex;flex-direction:column;gap:.5rem;width:min(92vw,420px);}
.os-toast{padding:.8rem 1.1rem;border-radius:10px;color:#fff;font-size:.9rem;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,.22);animation:osSlideUp .25s ease;text-align:center;}
.os-toast.success{background:var(--os-approved);}
.os-toast.info{background:var(--os-blue);}
.os-toast.warn{background:#d97706;}
.os-toast.error{background:var(--os-rejected);}
.os-toast.out{opacity:0;transform:translateY(8px);transition:all .3s ease;}
@media (max-width:480px){
  .os-modal{padding:0;align-items:flex-end;}
  .os-modal-content{max-width:100%;width:100%;border-radius:18px 18px 0 0;max-height:92vh;padding:1.25rem 1rem calc(1rem + env(safe-area-inset-bottom));}
  .os-map-wrap iframe{height:180px;}
  .os-card-actions .os-btn{flex:1 1 45%;justify-content:center;}
}
@media (max-width:768px){ .os-panel{padding:.85rem;} }
@media (prefers-reduced-motion:reduce){
  .os-pending-chip,.os-status-badge.pending,.os-clock-btn.is-busy::after{animation:none;}
}
@media print{
  .os-zone,.os-panel,.os-filter-chip,.os-toasts,.os-modal,.os-pin-btn{display:none !important;}
}
`;
(function injectOsStyles() {
  if (document.getElementById('os-addon-styles')) return;
  const el = document.createElement('style');
  el.id = 'os-addon-styles';
  el.textContent = OS_CSS;
  document.head.appendChild(el);
})();
// 🔒 Lock page scroll behind open addon modals
new MutationObserver(() => {
  document.body.style.overflow = document.querySelector('.os-modal') ? 'hidden' : '';
}).observe(document.body, { childList: true });

// ============================================================
// 🌐 SELF-CONTAINED i18n (EN + 繁中)
// ============================================================
const OS_I18N = {
  en: {
    btnIn: '📍 Request Off-site Clock-In', btnOut: '📍 Request Off-site Clock-Out',
    btnLocked: '📍 Off-site — return to today to request',
    acquiringGps: 'Acquiring GPS…',
    modalTitleIn: '📍 Off-site Clock-In Request', modalTitleOut: '📍 Off-site Clock-Out Request',
    detected: 'Your detected location:', coords: 'Coordinates',
    accuracy: '📡 GPS accuracy', accWarn: '⚠️ Low accuracy — location is approximate',
    address: '📮 Address', addressLoading: 'Looking up address…', addressNone: 'Address unavailable',
    reasonLabel: 'Reason (required)', reasonPlaceholder: 'e.g. Buying supplies for the center, bank errand…',
    reasonTooShort: 'Please enter a reason (minimum 5 characters).',
    submit: 'Submit for Approval', cancel: 'Cancel',
    pendingToast: '⏳ Request sent — waiting for master admin approval.',
    submitFail: '❌ Failed to submit request:',
    gpsFail: '❌ Could not get your location. Please allow location access and try again.',
    notToday: '📅 Off-site requests can only be made for the current day.',
    panelTitle: '📍 Off-site Approvals', panelSub: 'Off-site clock requests awaiting your verification',
    panelEmpty: '✅ No pending off-site requests.',
    approve: '✅ Approve', reject: '❌ Reject', showMap: '🗺️ Show map', hideMap: '🗺️ Hide map',
    openMaps: 'Open in Google Maps ↗', approvedToast: '✅ Approved off-site request from {name}.',
    rejectedToast: '🚫 Rejected off-site request from {name}.',
    reviewFail: '❌ Review failed:', rejectConfirm: 'Reject this off-site request from',
    pendingBadge: '⏳ PENDING', approvedBadge: '✅', rejectedBadge: 'REJECTED',
    filterChip: '📍 Off-site only', suggestion: '📍 Request off-site clock-in instead?',
    pendingChip: '⏳ {n} request awaiting approval', historyShow: 'Show recent decisions',
    historyHide: 'Hide recent decisions', decided: 'Decided', mapTitle: '🗺️ Off-site Location',
    relJustNow: 'just now', relMin: '{n}m ago', relHour: '{n}h ago', relDay: '{n}d ago'
  },
  zhTW: {
    btnIn: '📍 申請外勤上班打卡', btnOut: '📍 申請外勤下班打卡',
    btnLocked: '📍 外勤 — 請返回今天才可申請',
    acquiringGps: '正在取得 GPS…',
    modalTitleIn: '📍 外勤上班打卡申請', modalTitleOut: '📍 外勤下班打卡申請',
    detected: '偵測到的位置：', coords: '座標',
    accuracy: '📡 GPS 精確度', accWarn: '⚠️ 精確度偏低 — 位置僅供參考',
    address: '📮 地址', addressLoading: '正在查詢地址…', addressNone: '無法取得地址',
    reasonLabel: '原因（必填）', reasonPlaceholder: '例如：為中心購買物資、銀行事項…',
    reasonTooShort: '請填寫原因（最少 5 個字元）。',
    submit: '提交待審批', cancel: '取消',
    pendingToast: '⏳ 已提交申請 — 等待總管理員審批。',
    submitFail: '❌ 提交申請失敗：',
    gpsFail: '❌ 無法取得您的位置。請允許定位權限後再試。',
    notToday: '📅 外勤申請只限當天。',
    panelTitle: '📍 外勤審批', panelSub: '等待您驗證的外勤打卡申請',
    panelEmpty: '✅ 目前沒有待審批的外勤申請。',
    approve: '✅ 批准', reject: '❌ 拒絕', showMap: '🗺️ 顯示地圖', hideMap: '🗺️ 隱藏地圖',
    openMaps: '在 Google 地圖開啟 ↗', approvedToast: '✅ 已批准 {name} 的外勤申請。',
    rejectedToast: '🚫 已拒絕 {name} 的外勤申請。',
    reviewFail: '❌ 審批失敗：', rejectConfirm: '確定拒絕此外勤申請？員工：',
    pendingBadge: '⏳ 待審批', approvedBadge: '✅', rejectedBadge: '已拒絕',
    filterChip: '📍 只顯示外勤', suggestion: '📍 改為申請外勤打卡？',
    pendingChip: '⏳ {n} 項申請待審批', historyShow: '顯示最近決定',
    historyHide: '隱藏最近決定', decided: '已決定', mapTitle: '🗺️ 外勤位置',
    relJustNow: '剛剛', relMin: '{n} 分鐘前', relHour: '{n} 小時前', relDay: '{n} 天前'
  }
};
function osLang() { return String(document.documentElement.lang || 'en').toLowerCase().startsWith('zh') ? 'zhTW' : 'en'; }
function osT(key, vars) {
  let s = (OS_I18N[osLang()] && OS_I18N[osLang()][key]) || OS_I18N.en[key] || key;
  if (vars) Object.entries(vars).forEach(([k, v]) => { s = s.replace('{' + k + '}', v); });
  return s;
}
function osEscape(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// 🧠 STATE
// ============================================================
let osUser = null;
let osEmployees = {};
let osCurrentEmpId = null;
let osCurrentEmpData = null;
let osHasFullAccess = false;
let osIsMasterAdmin = false;
let osDayLogs = {};          // timecards for the selected date (mirrors timecard.js listener)
let osOffsiteByKey = {};     // "englishName|time" → off-site log info (for table decoration)
let osRequests = {};         // offsiteRequests node (master admin)
let osLogsUnsub = null;
let osReqsUnsub = null;
let osFilterActive = false;
let osAddressCache = {};
let lastSelfTapAt = 0;
const baseTitle = document.title;

// ---- DOM handles (created by this addon) ----
let osZone, osClockBtn, osClockLabel, osPendingChip, osFilterChip, osPanel, osToastZone;

// ============================================================
// 🔧 HELPERS
// ============================================================
function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isTodaySelected() {
  const dp = document.getElementById('datePicker');
  return !!dp && dp.value === getTodayStr();
}
function getSelectedDate() {
  const dp = document.getElementById('datePicker');
  return (dp && dp.value) ? dp.value : getTodayStr();
}
function googleEmbed(lat, lng, z = 17) { return `https://maps.google.com/maps?q=${lat},${lng}&z=${z}&output=embed`; }
function gmapsLink(lat, lng) { return `https://www.google.com/maps?q=${lat},${lng}`; }

function osGetPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no_geo'));
    navigator.geolocation.getCurrentPosition(resolve,
      (err1) => { // retry once with relaxed settings
        navigator.geolocation.getCurrentPosition(resolve, reject,
          { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 });
      },
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 30000 });
  });
}

async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (osAddressCache[key] !== undefined) return osAddressCache[key];
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=0`,
      { signal: ctrl.signal, headers: { 'Accept-Language': 'en,zh' } }
    );
    clearTimeout(to);
    const j = await r.json();
    osAddressCache[key] = j.display_name || '';
  } catch (e) { osAddressCache[key] = ''; }
  return osAddressCache[key];
}

function relTime(dateStr, timeStr) {
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  if (isNaN(dt)) return '';
  const mins = Math.round((Date.now() - dt.getTime()) / 60000);
  if (mins < 1) return osT('relJustNow');
  if (mins < 60) return osT('relMin', { n: mins });
  if (mins < 1440) return osT('relHour', { n: Math.round(mins / 60) });
  return osT('relDay', { n: Math.round(mins / 1440) });
}

function normalizeLogs(raw) {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : Object.values(raw);
}

// ============================================================
// 🔔 TOASTS (new actions only — existing result modal untouched)
// ============================================================
function osToast(msg, kind = 'info') {
  if (!osToastZone) return;
  const el = document.createElement('div');
  el.className = `os-toast ${kind}`;
  el.textContent = msg;
  osToastZone.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 3500);
}

// ============================================================
// 🔐 AUTH / ROLE MIRROR (same logic as timecard.js, read-only)
// ============================================================
function computeAccess(emp, user) {
  let full = false;
  if (emp) {
    const positions = (Array.isArray(emp.positions) ? emp.positions : (emp.position ? [emp.position] : []))
      .map(p => p.trim().toLowerCase());
    const isMgr = positions.includes('manager') || positions.includes('master admin');
    const centerStr = (emp.center || emp.branch || emp.location || emp.centerName || '').toLowerCase();
    full = isMgr || centerStr.includes('champs');
  }
  if (!full && user && user.email) {
    const e = user.email.toLowerCase();
    if (e.includes('champs')) full = true;
  }
  return full;
}

function identifyOsUser() {
  if (!osUser) return;
  osCurrentEmpId = null; osCurrentEmpData = null; osHasFullAccess = false;
  if (osEmployees[osUser.uid]) {
    osCurrentEmpId = osUser.uid; osCurrentEmpData = osEmployees[osUser.uid];
  } else {
    for (const [id, emp] of Object.entries(osEmployees)) {
      if (emp.uid === osUser.uid || (osUser.email && emp.email === osUser.email)) {
        osCurrentEmpId = id; osCurrentEmpData = emp; break;
      }
    }
  }
  osHasFullAccess = computeAccess(osCurrentEmpData, osUser);
  osIsMasterAdmin = (osUser.email || '').toLowerCase() === MASTER_ADMIN_EMAIL;
  placeActionButton(); placeFilterChip(); setupRequestsListener();
  setupDaySubscription(getSelectedDate());
}

onAuthStateChanged(auth, (user) => { osUser = user; if (user) identifyOsUser(); });

// ============================================================
// 📅 DAY LOGS SUBSCRIPTION (mirrors timecard.js — needed for
//    badges, pending state and the button label)
// ============================================================
function setupDaySubscription(date) {
  if (osLogsUnsub) { try { osLogsUnsub(); } catch (e) {} osLogsUnsub = null; }
  osDayLogs = {}; rebuildOffsiteIndex(); scheduleDecorate();
  const path = osHasFullAccess
    ? `timecards/${date}`
    : (osCurrentEmpId ? `timecards/${date}/${osCurrentEmpId}` : null);
  if (!path) return;
  osLogsUnsub = onValue(ref(db, path), (snap) => {
    if (osHasFullAccess) {
      osDayLogs = snap.val() || {};
    } else {
      osDayLogs = {}; osDayLogs[osCurrentEmpId] = snap.val() || { logs: [] };
    }
    rebuildOffsiteIndex(); scheduleDecorate(); updateOffsiteButtonState();
  }, (err) => console.warn('⚠️ [Offsite] day listener error:', err));
}

function rebuildOffsiteIndex() {
  osOffsiteByKey = {};
  Object.entries(osDayLogs).forEach(([empId, day]) => {
    const emp = osEmployees[empId]; if (!emp) return;
    normalizeLogs(day.logs).forEach(l => {
      if (l && l.offsite) osOffsiteByKey[`${emp.englishName || empId}|${l.time}`] = { ...l, empId };
    });
  });
}

function computeNextType() {
  if (!osCurrentEmpId) return 'in';
  const logs = normalizeLogs(osDayLogs[osCurrentEmpId]?.logs);
  if (!logs.length) return 'in';
  const sorted = [...logs].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  return sorted[sorted.length - 1].type === 'in' ? 'out' : 'in';
}

// ============================================================
// 🏗️ UI CONSTRUCTION (all injected — no HTML edits needed)
// ============================================================
function buildBaseUI() {
  // Toast zone
  osToastZone = document.createElement('div');
  osToastZone.className = 'os-toasts';
  document.body.appendChild(osToastZone);

  // Action zone + button
  osZone = document.createElement('div');
  osZone.className = 'os-zone';
  osZone.innerHTML = `
    <button type="button" id="osClockBtn" class="os-clock-btn" style="display:none;">
      <span id="osClockLabel"></span>
    </button>
    <span id="osPendingChip" class="os-pending-chip" style="display:none;"></span>`;
  document.querySelector('.container')?.appendChild(osZone);
  osClockBtn = osZone.querySelector('#osClockBtn');
  osClockLabel = osZone.querySelector('#osClockLabel');
  osPendingChip = osZone.querySelector('#osPendingChip');
  osClockBtn.addEventListener('click', startOffsiteFlow);

  // Approval panel (master admin only)
  osPanel = document.createElement('section');
  osPanel.id = 'osPanel';
  osPanel.className = 'os-panel';
  osPanel.style.display = 'none';
  osPanel.innerHTML = `
    <div class="os-panel-head"><h2 id="osPanelTitle"></h2><span id="osPanelBadge" class="os-badge">0</span></div>
    <div class="os-panel-sub" id="osPanelSub"></div>
    <div id="osPendingList"></div>
    <button type="button" id="osHistoryToggle" class="os-history-toggle" style="display:none;"></button>
    <div id="osHistoryList" style="display:none;"></div>`;
  const tableWrapper = document.querySelector('.table-wrapper');
  if (tableWrapper) tableWrapper.insertAdjacentElement('beforebegin', osPanel);
  else document.querySelector('.container')?.appendChild(osPanel);
  osPanel.querySelector('#osHistoryToggle').addEventListener('click', () => {
    const list = osPanel.querySelector('#osHistoryList');
    const open = list.style.display !== 'none';
    list.style.display = open ? 'none' : 'block';
    osPanel.querySelector('#osHistoryToggle').textContent = open ? osT('historyShow') : osT('historyHide');
  });
  osPanel.querySelector('#osPendingList').addEventListener('click', onPanelAction);

  placeActionButton();
}

function placeActionButton() {
  if (!osZone) return;
  if (osIsMasterAdmin) {
    const adminPanel = document.getElementById('adminClockPanel');
    if (adminPanel) { adminPanel.insertAdjacentElement('afterend', osZone); return; }
  }
  const wrap = document.querySelector('.tap-button-wrapper');
  if (wrap) wrap.insertAdjacentElement('afterend', osZone);
}

function placeFilterChip() {
  if (osFilterChip) { osFilterChip.style.display = osHasFullAccess ? '' : 'none'; return; }
  if (!osHasFullAccess) return;
  const posFilter = document.getElementById('positionFilter');
  const group = posFilter ? posFilter.closest('.control-group') : null;
  if (!group) return;
  osFilterChip = document.createElement('button');
  osFilterChip.type = 'button';
  osFilterChip.className = 'os-filter-chip';
  osFilterChip.textContent = osT('filterChip');
  osFilterChip.addEventListener('click', () => {
    osFilterActive = !osFilterActive;
    osFilterChip.classList.toggle('active', osFilterActive);
    scheduleDecorate();
  });
  group.insertAdjacentElement('afterend', osFilterChip);
}

// ============================================================
// 📍 OFF-SITE FLOW (employee side)
// ============================================================
function updateOffsiteButtonState() {
  if (!osClockBtn) return;
  // 🚫 kumonchamps@gmail.com = approval-only, never requests off-site.
  // Other Master Admins who are employees keep the button (osIsMasterAdmin
  // is email-based, so position-based Master Admins are unaffected).
  if (osIsMasterAdmin) {
    osZone.style.display = 'none';
    return;
  }
  const canUse = !!osCurrentEmpId;
  osClockBtn.style.display = canUse ? '' : 'none';
  osZone.style.display = canUse ? '' : 'none';
  if (!canUse) return;

  const locked = !isTodaySelected();
  const nextType = computeNextType();
  osClockLabel.textContent = locked ? osT('btnLocked') : (nextType === 'in' ? osT('btnIn') : osT('btnOut'));
  osClockBtn.disabled = locked;

  // pending chip (own pending requests today)
  const pending = normalizeLogs(osDayLogs[osCurrentEmpId]?.logs)
    .filter(l => l && l.offsite && l.status === 'pending').length;
  osPendingChip.style.display = pending > 0 ? '' : 'none';
  osPendingChip.textContent = osT('pendingChip', { n: pending });
}

async function startOffsiteFlow() {
  if (!osCurrentEmpId) return;
  if (!isTodaySelected()) { osToast(osT('notToday'), 'warn'); return; }
  const type = computeNextType();
  osClockBtn.classList.add('is-busy'); osClockBtn.disabled = true;
  try {
    const pos = await osGetPosition();
    openRequestModal(type, {
      lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy
    });
  } catch (err) {
    console.error('[Offsite] GPS error:', err);
    osToast(osT('gpsFail'), 'error');
  } finally {
    osClockBtn.classList.remove('is-busy');
    updateOffsiteButtonState();
  }
}

function openRequestModal(type, coords) {
  closeModalById('osRequestModal');
  const { lat, lng, accuracy } = coords;
  const accWarn = accuracy > OS_ACC_WARN_M;
  const modal = document.createElement('div');
  modal.id = 'osRequestModal';
  modal.className = 'os-modal';
  modal.innerHTML = `
    <div class="os-modal-content">
      <button type="button" class="os-modal-close" aria-label="close">&times;</button>
      <h3>${type === 'in' ? osT('modalTitleIn') : osT('modalTitleOut')}</h3>
      <div class="os-coords"><strong>${osT('detected')}</strong><br>
        ${osT('coords')}: ${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
      <div class="os-acc-line ${accWarn ? 'warn' : ''}">${osT('accuracy')}: ±${Math.round(accuracy)}m ${accWarn ? ' — ' + osT('accWarn') : ''}</div>
      <div class="os-map-wrap"><iframe title="map" loading="lazy" referrerpolicy="no-location"
        src="${googleEmbed(lat.toFixed(6), lng.toFixed(6))}"></iframe></div>
      <div class="os-address" id="osReqAddress">${osT('address')}: ${osT('addressLoading')}</div>
      <div class="os-field">
        <label for="osReqReason">${osT('reasonLabel')}</label>
        <textarea id="osReqReason" maxlength="300" placeholder="${osEscape(osT('reasonPlaceholder'))}"></textarea>
        <div class="os-char-count" id="osReqCount">0 / ${OS_MIN_REASON_LEN}+</div>
      </div>
      <div class="os-modal-actions">
        <button type="button" class="os-btn ghost" id="osReqCancel">${osT('cancel')}</button>
        <button type="button" class="os-btn approve" id="osReqSubmit">${osT('submit')}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  reverseGeocode(lat, lng).then(addr => {
    const line = document.getElementById('osReqAddress');
    if (line) line.textContent = `${osT('address')}: ${addr || osT('addressNone')}`;
  });

  const ta = modal.querySelector('#osReqReason');
  const count = modal.querySelector('#osReqCount');
  ta.addEventListener('input', () => {
    const n = ta.value.trim().length;
    count.textContent = `${n} / ${OS_MIN_REASON_LEN}+`;
    count.classList.toggle('ok', n >= OS_MIN_REASON_LEN);
  });
  modal.querySelector('.os-modal-close').addEventListener('click', () => closeModalById('osRequestModal'));
  modal.querySelector('#osReqCancel').addEventListener('click', () => closeModalById('osRequestModal'));
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModalById('osRequestModal'); });
  modal.querySelector('#osReqSubmit').addEventListener('click', async () => {
    const reason = ta.value.trim();
    if (reason.length < OS_MIN_REASON_LEN) { osToast(osT('reasonTooShort'), 'warn'); ta.focus(); return; }
    const btn = modal.querySelector('#osReqSubmit');
    btn.disabled = true;
    try {
      const addrLine = document.getElementById('osReqAddress')?.textContent || '';
      await submitOffsiteRequest(type, coords, reason, addrLine.replace(/^.*?:\s*/, ''));
      closeModalById('osRequestModal');
      osToast(osT('pendingToast'), 'success');
    } catch (err) {
      console.error('[Offsite] submit error:', err);
      osToast(`${osT('submitFail')} ${err.message}`, 'error');
      btn.disabled = false;
    }
  });
  ta.focus();
}

async function submitOffsiteRequest(type, coords, reason, address) {
  const date = getTodayStr();
  const empId = osCurrentEmpId;
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const requestedAt = new Date().toISOString();
  const reqRef = push(ref(db, 'offsiteRequests'));
  const reqId = reqRef.key;
  const entry = {
    type, time, location: OS_LOCATION_MARKER,
    offsite: true, status: 'pending',
    lat: +coords.lat.toFixed(6), lng: +coords.lng.toFixed(6),
    accuracy: Math.round(coords.accuracy || 0),
    reason, address: address || '', osReqId: reqId, requestedAt
  };
  const tcRef = ref(db, `timecards/${date}/${empId}`);
  const snap = await get(tcRef);
  const logs = normalizeLogs(snap.val()?.logs);
  logs.push(entry);
  const emp = osEmployees[empId] || {};
  await Promise.all([
    update(tcRef, { logs }),
    set(reqRef, {
      id: reqId, empId, date, type, time,
      empName: emp.englishName || empId, empNameCn: emp.chineseName || '',
      lat: entry.lat, lng: entry.lng, accuracy: entry.accuracy,
      reason, address: address || '', status: 'pending', requestedAt
    })
  ]);
}

function closeModalById(id) { document.getElementById(id)?.remove(); }

// ============================================================
// 🗺️ MAP VIEWER MODAL (table pin icon)
// ============================================================
function openMapModal(info) {
  closeModalById('osMapModal');
  const badgeKey = info.status === 'approved' ? 'approvedBadge' : info.status === 'rejected' ? 'rejectedBadge' : 'pendingBadge';
  const modal = document.createElement('div');
  modal.id = 'osMapModal';
  modal.className = 'os-modal';
  modal.innerHTML = `
    <div class="os-modal-content">
      <button type="button" class="os-modal-close" aria-label="close">&times;</button>
      <h3>${osT('mapTitle')} <span class="os-status-badge ${info.status}">${osT(badgeKey)}</span></h3>
      <div class="os-coords">${osT('coords')}: ${info.lat}, ${info.lng} · ${osT('accuracy')}: ±${info.accuracy ?? '?'}m</div>
      ${info.reason ? `<div class="os-reason">💬 ${osEscape(info.reason)}</div>` : ''}
      <div class="os-map-wrap" style="margin-top:.8rem;"><iframe title="map" loading="lazy"
        src="${googleEmbed(info.lat, info.lng)}"></iframe></div>
      <div class="os-modal-actions">
        <a class="os-btn ghost" style="flex:1;justify-content:center;" target="_blank" rel="noopener"
           href="${gmapsLink(info.lat, info.lng)}">${osT('openMaps')}</a>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.os-modal-close').addEventListener('click', () => closeModalById('osMapModal'));
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModalById('osMapModal'); });
}

// ============================================================
// 🎨 TABLE DECORATION (badges, pins, tooltips, filter)
//    Runs after every render via MutationObserver — additive.
// ============================================================
let decorateScheduled = false;
function scheduleDecorate() {
  if (decorateScheduled) return;
  decorateScheduled = true;
  requestAnimationFrame(() => { decorateScheduled = false; decorateAll(); });
}

function decorateAll() {
  decorateTableRows();
  decorateCards();
  updateOffsiteButtonState();
}

function decorateTableRows() {
  const tbody = document.getElementById('timecardBody');
  if (!tbody) return;
  const date = getSelectedDate();
  tbody.querySelectorAll('tr.student-row').forEach(tr => {
    const cells = tr.children;
    if (cells.length < 6) return;

    // ⏱ Relative-time tooltip on every row (modernization)
    const timeText = cells[3].textContent.trim();
    const rel = relTime(date, timeText);
    if (rel) cells[3].title = `${date} ${timeText} · ${rel}`;

    // 📍 Off-site detection
    const locCell = cells[4];
    const isOffsite = locCell.textContent.trim() === OS_LOCATION_MARKER;
    if (osFilterActive && !isOffsite) { tr.style.display = 'none'; return; }
    tr.style.display = '';
    if (!isOffsite || tr.dataset.osDone === '1') return;

    const info = osOffsiteByKey[`${cells[1].textContent.trim()}|${timeText}`];
    if (!info) return;
    tr.dataset.osDone = '1';

    // Pin button in location cell
    locCell.innerHTML = '';
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'os-pin-btn';
    pin.title = osT('mapTitle');
    pin.textContent = '📍';
    pin.addEventListener('click', () => openMapModal(info));
    locCell.appendChild(pin);
    locCell.appendChild(document.createTextNode(OS_LOCATION_MARKER));

    // Status badge in status cell
    const badgeKey = info.status === 'approved' ? 'approvedBadge' : info.status === 'rejected' ? 'rejectedBadge' : 'pendingBadge';
    const badge = document.createElement('span');
    badge.className = `os-status-badge ${info.status}`;
    badge.textContent = osT(badgeKey);
    badge.title = info.reason ? `💬 ${info.reason}` : '';
    cells[5].appendChild(badge);

    if (info.status === 'rejected') tr.classList.add('os-row-rejected');
  });
}

function decorateCards() {
  const wrap = document.getElementById('mobileTimecardCards');
  if (!wrap) return;
  wrap.querySelectorAll('.tc-card').forEach(card => {
    const locEl = card.querySelector('.tc-location');
    if (!locEl || card.dataset.osDone === '1') return;
    if (!locEl.textContent.includes(OS_LOCATION_MARKER)) return;
    const date = getSelectedDate();
    const timeEl = card.querySelector('.tc-time-box.in .time');
    const info = timeEl ? osOffsiteByKey[`${card.querySelector('.tc-name-en')?.textContent.trim()}|${timeEl.textContent.trim()}`] : null;
    card.dataset.osDone = '1';
    if (!info) return;
    const badge = document.createElement('span');
    badge.className = `os-status-badge ${info.status}`;
    badge.textContent = osT(info.status === 'approved' ? 'approvedBadge' : info.status === 'rejected' ? 'rejectedBadge' : 'pendingBadge');
    locEl.appendChild(badge);
  });
}

// ============================================================
// 🛠️ MASTER ADMIN — APPROVALS PANEL
// ============================================================
function setupRequestsListener() {
  if (!osIsMasterAdmin) { if (osPanel) osPanel.style.display = 'none'; return; }
  if (osReqsUnsub) return; // already listening
  osReqsUnsub = onValue(ref(db, 'offsiteRequests'), (snap) => {
    osRequests = snap.val() || {};
    renderPanel();
  }, (err) => console.warn('⚠️ [Offsite] requests listener error:', err));
}

function renderPanel() {
  if (!osIsMasterAdmin || !osPanel) return;
  osPanel.style.display = '';
  osPanel.querySelector('#osPanelTitle').textContent = osT('panelTitle');
  osPanel.querySelector('#osPanelSub').textContent = osT('panelSub');

  const all = Object.values(osRequests || {});
  const pending = all.filter(r => r.status === 'pending').sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  const resolved = all.filter(r => r.status !== 'pending').sort((a, b) => String(b.reviewedAt || '').localeCompare(String(a.reviewedAt || '') )).slice(0, 20);

  // Badge + document.title
  const badge = osPanel.querySelector('#osPanelBadge');
  badge.textContent = pending.length;
  badge.style.display = pending.length ? '' : 'none';
  document.title = pending.length ? `(${pending.length}) ${baseTitle}` : baseTitle;

  const list = osPanel.querySelector('#osPendingList');
  list.innerHTML = pending.length
    ? pending.map(r => requestCardHTML(r, false)).join('')
    : `<div class="os-empty">${osT('panelEmpty')}</div>`;

  const toggle = osPanel.querySelector('#osHistoryToggle');
  const hist = osPanel.querySelector('#osHistoryList');
  if (resolved.length) {
    toggle.style.display = '';
    if (toggle.textContent === '') toggle.textContent = osT('historyShow');
    hist.innerHTML = resolved.map(r => requestCardHTML(r, true)).join('');
  } else { toggle.style.display = 'none'; hist.style.display = 'none'; }
}

function requestCardHTML(r, isResolved) {
  const accWarn = (r.accuracy || 0) > OS_ACC_WARN_M;
  const typeCls = r.type === 'in' ? 'in' : r.type === 'out' ? 'out' : 'out';
  const typeTxt = r.type === 'in' ? 'IN' : r.type === 'out' ? 'OUT' : String(r.type || '').toUpperCase();
  const statusBadge = isResolved
    ? `<span class="os-status-badge ${r.status}">${r.status === 'approved' ? osT('approvedBadge') + ' APPROVED' : osT('rejectedBadge')}</span>`
    : `<span class="os-status-badge pending">${osT('pendingBadge')}</span>`;
  const mapBlock = isResolved
    ? `<div class="os-map-wrap" style="display:none;"><iframe title="map" loading="lazy" data-osmap="${googleEmbed(r.lat, r.lng)}"></iframe></div>`
    : `<div class="os-map-wrap" style="display:none;"><iframe title="map" loading="lazy" data-osmap="${googleEmbed(r.lat, r.lng)}"></iframe></div>`;
  return `
    <div class="os-card ${isResolved ? 'resolved ' + r.status : ''}" data-req-id="${osEscape(r.id)}">
      <div class="os-card-head">
        <span class="os-type ${typeCls}">${typeTxt}</span>
        <span>${osEscape(r.empName || r.empId)}${r.empNameCn ? ' (' + osEscape(r.empNameCn) + ')' : ''}</span>
        ${statusBadge}
      </div>
      <div class="os-card-meta">
        <span>📅 ${osEscape(r.date)}</span>
        <span>⏰ ${osEscape(r.time)}</span>
        <span class="${accWarn ? 'os-acc-warn' : ''}">📡 ±${r.accuracy ?? '?'}m${accWarn ? ' ⚠️' : ''}</span>
      </div>
      ${r.reason ? `<div class="os-reason">💬 ${osEscape(r.reason)}</div>` : ''}
      ${r.address ? `<div class="os-address">📮 ${osEscape(r.address)}</div>` : ''}
      ${mapBlock}
      <div class="os-card-actions">
        <button type="button" class="os-btn ghost" data-action="togglemap">${osT('showMap')}</button>
        <a class="os-btn ghost" target="_blank" rel="noopener" href="${gmapsLink(r.lat, r.lng)}">${osT('openMaps')}</a>
        ${isResolved
          ? `<span style="align-self:center;font-size:.78rem;color:#64748b;">${osT('decided')}: ${new Date(r.reviewedAt).toLocaleString()}</span>`
          : `<button type="button" class="os-btn approve" data-action="approve">${osT('approve')}</button>
             <button type="button" class="os-btn reject" data-action="reject">${osT('reject')}</button>`}
      </div>
    </div>`;
}

function onPanelAction(e) {
  const card = e.target.closest('.os-card');
  if (!card) return;
  const reqId = card.dataset.reqId;
  const action = e.target.dataset?.action;

  if (action === 'togglemap') {
    const wrap = card.querySelector('.os-map-wrap');
    const iframe = wrap.querySelector('iframe');
    const open = wrap.style.display !== 'none';
    if (!open && iframe.dataset.osmap && !iframe.src) iframe.src = iframe.dataset.osmap; // lazy load
    wrap.style.display = open ? 'none' : 'block';
    e.target.textContent = open ? osT('showMap') : osT('hideMap');
    return;
  }
  if (action === 'approve' || action === 'reject') {
    const approve = action === 'approve';
    if (!approve) {
      const req = osRequests[reqId];
      if (!confirm(`${osT('rejectConfirm')} ${req?.empName || ''}?`)) return;
    }
    card.querySelectorAll('button[data-action]').forEach(b => b.disabled = true);
    reviewRequest(reqId, approve);
  }
}

async function reviewRequest(reqId, approve) {
  const req = osRequests[reqId];
  if (!req || req.status !== 'pending') return;
  const stamp = new Date().toISOString();
  try {
    const tcRef = ref(db, `timecards/${req.date}/${req.empId}`);
    const snap = await get(tcRef);
    const logs = normalizeLogs(snap.val()?.logs);
    const idx = logs.findIndex(l => l && l.osReqId === reqId);
    if (idx >= 0) {
      const entry = { ...logs[idx], status: approve ? 'approved' : 'rejected', reviewedAt: stamp, reviewedBy: osUser?.email || '' };
      if (!approve) { entry.originalType = entry.type; entry.type = 'rejected'; } // excluded from hour calculations, kept for audit
      logs[idx] = entry;
      await update(tcRef, { logs });
    }
    await update(ref(db, `offsiteRequests/${reqId}`), {
      status: approve ? 'approved' : 'rejected', reviewedBy: osUser?.email || '', reviewedAt: stamp
    });
    osToast(
      (approve ? osT('approvedToast') : osT('rejectedToast')).replace('{name}', req.empName || ''),
      approve ? 'success' : 'warn'
    );
  } catch (err) {
    console.error('[Offsite] review error:', err);
    osToast(`${osT('reviewFail')} ${err.message}`, 'error');
    renderPanel();
  }
}

// ============================================================
// 🚀 SMART SUGGESTION — "outside range" → offer off-site
// ============================================================
document.getElementById('tapLogBtn')?.addEventListener('click', () => { lastSelfTapAt = Date.now(); });

function maybeInjectSuggestion() {
  const modal = document.getElementById('scanResultModal');
  if (!modal) return;
  const injected = modal.querySelector('.os-suggest-btn');
  const visible = !modal.classList.contains('hidden');
  const icon = document.getElementById('resultIcon')?.textContent || '';
  const msg = document.getElementById('resultMessage')?.textContent || '';
  const isOutsideRange = icon.includes('❌') && (msg.includes('Outside') || msg.includes('超出'));
  const recentSelfTap = (Date.now() - lastSelfTapAt) < 8000;

if (visible && isOutsideRange && recentSelfTap && osCurrentEmpId && !osIsMasterAdmin && isTodaySelected() && !injected) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'os-suggest-btn';
    btn.textContent = osT('suggestion');
    btn.addEventListener('click', () => {
      modal.classList.add('hidden');
      startOffsiteFlow();
    });
    modal.querySelector('.result-content')?.appendChild(btn);
  } else if ((!visible || !isOutsideRange) && injected) {
    injected.remove();
  }
}

const osBodyObserver = new MutationObserver(() => {
  const m = document.getElementById('scanResultModal');
  if (m && !m.__osTracked) {
    m.__osTracked = true;
    new MutationObserver(maybeInjectSuggestion).observe(m, { attributes: true, attributeFilter: ['class'] });
    maybeInjectSuggestion();
  }
});

// ============================================================
// 🚀 BOOT
// ============================================================
function bootOffsiteAddon() {
  buildBaseUI();

  // Employees mirror (names for panel + index keys)
  onValue(ref(db, 'employees'), (snap) => {
    osEmployees = snap.val() || {};
    if (osUser) identifyOsUser();
    rebuildOffsiteIndex(); scheduleDecorate(); renderPanel();
  }, (err) => console.warn('⚠️ [Offsite] employees listener error:', err));

  // Date changes → resubscribe
  document.getElementById('datePicker')?.addEventListener('change', (e) => {
    setupDaySubscription(e.target.value);
  });

  // Decoration observers
  const tbody = document.getElementById('timecardBody');
  if (tbody) new MutationObserver(scheduleDecorate).observe(tbody, { childList: true, subtree: true });
  const cards = document.getElementById('mobileTimecardCards');
  if (cards) new MutationObserver(scheduleDecorate).observe(cards, { childList: true, subtree: true });

  // Smart-suggestion observer
  osBodyObserver.observe(document.body, { childList: true, subtree: true });

  // Language switching — re-render addon labels
  new MutationObserver(() => {
    updateOffsiteButtonState(); renderPanel(); scheduleDecorate();
    if (osFilterChip) osFilterChip.textContent = osT('filterChip');
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  console.log('✅ [Offsite] addon ready');
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootOffsiteAddon, { once: true });
} else {
  bootOffsiteAddon();
}