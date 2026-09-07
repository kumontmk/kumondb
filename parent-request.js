// ============================================================
// 📱 PARENT CHANGE-CLASS REQUEST PAGE — standalone, public
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, get, push, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyB1VhQwGotEI8BHt8wp8FvtPpUY5FsI0qA",
  authDomain: "kumondb-f4377.firebaseapp.com",
  databaseURL: "https://kumondb-f4377-default-rtdb.firebaseio.com",
  projectId: "kumondb-f4377",
  storageBucket: "kumondb-f4377.firebasestorage.app",
  messagingSenderId: "838725994916",
  appId: "1:838725994916:web:87326ba7bec87a0e6b5931"
};
// ✅ SECONDARY app instance: the parent's anonymous session is stored
//    separately from the staff login, so both can coexist in one browser.
const parentApp = initializeApp(firebaseConfig, 'parent');
const db = getDatabase(parentApp);
const auth = getAuth(parentApp);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;

// ---------- i18n ----------
const I18N = {
  en: {
    loading: 'Loading...',
    invalidTitle: 'Invalid Link',
    invalidMsg: 'This link is invalid or has been disabled by the center. Please contact your Kumon center.',
    codeTitle: 'Enter your code',
    codeHint: 'Enter the 4-character code the center gave you.',
    codeError: 'Incorrect code. Please try again.',
    codeSubmit: 'Unlock',
    title: 'Class Change Request',
    family: 'Your Family',
    newRequest: 'New Request',
    subject: 'Subject',
    absenceDate: 'Absence Date (the class you will miss)',
    originalTime: 'Original Class Time',
    noSlotHint: 'No scheduled class found on this day — please enter the time manually.',
    manualTime: 'Other / manual time',
    preferredDate: 'Preferred Replacement Date',
    preferredTime: 'Preferred Time',
    reason: 'Reason (optional)',
    reasonPh: 'e.g. school event, travel, sick...',
    submit: 'Submit Request',
    myRequests: 'My Requests',
    noRequests: 'No requests yet. Submit your first request above.',
    installTitle: 'Install as App',
    installHint: 'Install this page on your phone to request change classes anytime.',
    installBtn: '📲 Install App',
    iosHint: 'iPhone: tap Share ⬆️ then "Add to Home Screen".',
    footerNote: 'Requests are usually processed within 1–2 working days.',
    submitSuccess: '✅ Request submitted!',
    duplicateWarn: 'You already have a request for this date. Submit anyway?',
    missingFields: '⚠️ Please fill in subject, absence date, and preferred date & time.',
    statusPending: 'Pending',
    statusApproved: 'Approved',
    statusRejected: 'Rejected',
    statusExpired: 'Expired',
    approvedNote: '✅ Approved! Please arrive on time for the replacement class.',
    absence: 'Absence', preferred: 'Replacement',
    rejSlotFull: 'The requested slot is full.',
    rejAnotherDay: 'Please choose another day.',
    rejCenterClosed: 'The center is closed on that day.',
    rejOther: 'Rejected by the center.'
  },
  'zh-TW': {
    loading: '載入中...',
    invalidTitle: '連結無效',
    invalidMsg: '此連結無效或已被中心停用。請聯絡您的公文中心。',
    codeTitle: '請輸入密碼',
    codeHint: '請輸入中心提供給您的4位密碼。',
    codeError: '密碼不正確，請再試一次。',
    codeSubmit: '解鎖',
    title: '調堂申請',
    family: '您的家庭',
    newRequest: '新申請',
    subject: '科目',
    absenceDate: '缺席日期（您將缺席的課堂）',
    originalTime: '原課堂時間',
    noSlotHint: '當日沒有編排的課堂 — 請手動輸入時間。',
    manualTime: '其他／手動輸入',
    preferredDate: '心儀補堂日期',
    preferredTime: '心儀時間',
    reason: '原因（選填）',
    reasonPh: '例如：學校活動、外遊、生病...',
    submit: '提交申請',
    myRequests: '我的申請',
    noRequests: '暫無申請。請在上方提交第一個申請。',
    installTitle: '安裝為應用程式',
    installHint: '將此頁面安裝到手機，隨時申請調堂。',
    installBtn: '📲 安裝應用程式',
    iosHint: 'iPhone：點按分享 ⬆️ 然後選擇「加入主畫面」。',
    footerNote: '申請通常於1–2個工作天內處理。',
    submitSuccess: '✅ 申請已提交！',
    duplicateWarn: '此日期已有申請。仍要提交嗎？',
    missingFields: '⚠️ 請填寫科目、缺席日期及心儀補堂日期和時間。',
    statusPending: '待處理',
    statusApproved: '已批准',
    statusRejected: '已拒絕',
    statusExpired: '已過期',
    approvedNote: '✅ 已批准！請準時出席補堂。',
    absence: '缺席', preferred: '補堂',
    rejSlotFull: '該時段已滿。',
    rejAnotherDay: '請選擇其他日子。',
    rejCenterClosed: '中心該日暫停開放。',
    rejOther: '中心已拒絕此申請。'
  }
};
let lang = localStorage.getItem('pfl_lang') || ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-TW' : 'en');
const tr = (k) => (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;

// ---------- state ----------
let CENTER = null, TOKEN = null;
let portal = null;
let children = [];
let selectedChildId = null;
let selectedSubject = null;
let deferredPrompt = null;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

init();

async function init() {
  applyLang();

  // Resolve family: URL first, then saved (installed PWA)
  const stored = safeParse(localStorage.getItem('pfl_family'));
  CENTER = params.get('c') || stored?.c || null;
  TOKEN = params.get('t') || stored?.t || null;
  if (params.get('c') && params.get('t')) {
    localStorage.setItem('pfl_family', JSON.stringify({ c: CENTER, t: TOKEN }));
  }

  $('langToggle').addEventListener('click', () => {
    lang = lang === 'en' ? 'zh-TW' : 'en';
    localStorage.setItem('pfl_lang', lang);
    applyLang();
    if (portal) { renderChildren(); renderRequests(portal.requests || {}); populateSubjects(); }
  });

  // Install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('installBtn').classList.remove('hidden');
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('installBtn').classList.add('hidden');
  });
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS) $('iosHint').classList.remove('hidden');

  if (!CENTER || !TOKEN) return showScreen('invalid');

  try {
    await signInAnonymously(auth);
  } catch (err) {
    console.error('Anonymous sign-in failed:', err);
    return showScreen('invalid');
  }

  try {
    const snap = await get(ref(db, `publicFamilyLinks/${CENTER}/${TOKEN}`));
    if (!snap.exists() || !snap.val()?.meta) return showScreen('invalid');
    portal = snap.val();
    if (portal.meta.active === false) return showScreen('invalid');
  } catch (err) {
    console.error(err);
    return showScreen('invalid');
  }

  // Code gate
  if (localStorage.getItem('pfl_ok_' + TOKEN) === '1') {
    enterMain();
  } else {
    showScreen('code');
    $('codeSubmitBtn').addEventListener('click', tryCode);
    $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryCode(); });
  }
}

function tryCode() {
  const val = $('codeInput').value.trim().toUpperCase();
  if (val === (portal.meta.code || '').toUpperCase()) {
    localStorage.setItem('pfl_ok_' + TOKEN, '1');
    enterMain();
  } else {
    $('codeError').classList.remove('hidden');
    $('codeInput').value = '';
  }
}

function enterMain() {
  showScreen('main');
  $('centerLabel').textContent = portal.meta.centerName || '';
  children = Object.entries(portal.students || {})
    .map(([id, s]) => ({ id, ...s }))
    .filter(s => (s.subjects || []).length > 0)
    .sort((a, b) => (a.namePinyin || '').localeCompare(b.namePinyin || ''));

  if (!children.length) {
    $('childrenChips').innerHTML = '<span class="muted">—</span>';
  } else {
    selectedChildId = children[0].id;
  }
  renderChildren();
  populateSubjects();
  buildPreferredTimes();

  const today = new Date().toISOString().slice(0, 10);
  const min = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const max = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  $('prAbsenceDate').min = min; $('prAbsenceDate').max = max;
  $('prPreferredDate').min = today; $('prPreferredDate').max = max;

  $('prAbsenceDate').addEventListener('change', fillOriginalTime);
  $('prSubject').addEventListener('change', fillOriginalTime);
  $('prSubmitBtn').addEventListener('click', submitRequest);

  // Live updates
  onValue(ref(db, `publicFamilyLinks/${CENTER}/${TOKEN}`), (snap) => {
    if (!snap.exists()) return showScreen('invalid');
    portal = snap.val();
    if (portal.meta.active === false) return showScreen('invalid');
    renderRequests(portal.requests || {});
    sweepExpired(portal.requests || {});
  });
}

// ---------- rendering ----------
function renderChildren() {
  const wrap = $('childrenChips');
  wrap.innerHTML = '';
  children.forEach(c => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (c.id === selectedChildId ? ' active' : '');
    const centerTag = c.centerId && c.centerId !== CENTER ? `<small>🏫 ${escapeHtml(c.centerName || '')}</small>` : `<small>${escapeHtml(c.grade ? 'G' + c.grade : '')}</small>`;
    chip.innerHTML = `<span>${escapeHtml(c.nameCn || c.namePinyin || '')}</span>${centerTag}`;
    chip.addEventListener('click', () => {
      selectedChildId = c.id;
      renderChildren();
      populateSubjects();
      fillOriginalTime();
    });
    wrap.appendChild(chip);
  });
}

function populateSubjects() {
  const sel = $('prSubject');
  sel.innerHTML = '';
  const child = children.find(c => c.id === selectedChildId);
  if (!child) return;
  (child.subjects || []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `${s.name}${s.level ? ` (${s.level})` : ''}`;
    sel.appendChild(opt);
  });
  selectedSubject = sel.value || null;
}

function fillOriginalTime() {
  const child = children.find(c => c.id === selectedChildId);
  const subjectName = $('prSubject').value;
  selectedSubject = subjectName;
  const sel = $('prOriginalTime');
  const hint = $('originalHint');
  sel.innerHTML = '';
  hint.classList.add('hidden');
  if (!child || !subjectName || !$('prAbsenceDate').value) {
    sel.innerHTML = '<option value="">—</option>';
    return;
  }
  const subject = (child.subjects || []).find(s => s.name === subjectName);
  const date = new Date($('prAbsenceDate').value + 'T00:00:00');
  const dayName = DAYS[date.getDay()];
  const slots = ((subject?.timeslots) || []).filter(ts => ts.day === dayName);
  if (slots.length === 0) {
    sel.innerHTML = '<option value="">—</option>';
    hint.textContent = tr('noSlotHint');
    hint.classList.remove('hidden');
    return;
  }
  slots.forEach(ts => {
    const opt = document.createElement('option');
    opt.value = ts.time;
    opt.textContent = `${ts.time} (${dayName})`;
    sel.appendChild(opt);
  });
}

function buildPreferredTimes() {
  const sel = $('prPreferredTime');
  sel.innerHTML = '<option value="">—</option>';
  for (let h = 9; h <= 20; h++) {
    for (const m of ['00', '30']) {
      if (h === 20 && m === '30') continue;
      const val = `${String(h).padStart(2, '0')}:${m}`;
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = val;
      sel.appendChild(opt);
    }
  }
}

function renderRequests(requests) {
  const list = $('requestsList');
  const arr = Object.entries(requests || {}).map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (arr.length === 0) {
    list.innerHTML = `<div class="req-empty">${tr('noRequests')}</div>`;
    return;
  }
  list.innerHTML = '';
  arr.forEach(r => {
    const item = document.createElement('div');
    item.className = `req-item st-${r.status || 'pending'}`;
    const pillTxt = { pending: tr('statusPending'), approved: tr('statusApproved'), rejected: tr('statusRejected'), expired: tr('statusExpired') }[r.status] || r.status;
    let decision = '';
    if (r.status === 'approved') decision = `<div class="req-decision decision-approved">${tr('approvedNote')}</div>`;
    if (r.status === 'rejected') decision = `<div class="req-decision decision-rejected">↩️ ${escapeHtml(localizedRejectReason(r))}</div>`;
    item.innerHTML = `
      <div class="req-top">
        <span class="req-subject">${escapeHtml(r.subject || '')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</span>
        <span class="req-pill pill-${r.status || 'pending'}">${pillTxt}</span>
      </div>
      <div class="req-dates">
        <div style="display:flex;gap:1.5rem;flex-wrap:wrap;">
          <span><strong>${tr('absence')}</strong>${escapeHtml(r.absenceDate || '')} ${escapeHtml(r.originalTime || '')}</span>
          <span><strong>${tr('preferred')}</strong>${escapeHtml(r.preferredDate || '')} ${escapeHtml(r.preferredTime || '')}</span>
        </div>
      </div>
      ${r.reason ? `<div class="req-reason">💬 ${escapeHtml(r.reason)}</div>` : ''}
      ${decision}`;
    list.appendChild(item);
  });
}

function localizedRejectReason(r) {
  const map = { slotFull: 'rejSlotFull', anotherDay: 'rejAnotherDay', centerClosed: 'rejCenterClosed' };
  if (r.rejectReasonKey && map[r.rejectReasonKey]) return tr(map[r.rejectReasonKey]);
  return r.rejectReason || tr('rejOther');
}

// ---------- submit ----------
async function submitRequest() {
  const child = children.find(c => c.id === selectedChildId);
  if (!child) return showToast(tr('missingFields'), 'error');
  const subject = $('prSubject').value;
  const absenceDate = $('prAbsenceDate').value;
  const preferredDate = $('prPreferredDate').value;
  const preferredTime = $('prPreferredTime').value;
  if (!subject || !absenceDate || !preferredDate || !preferredTime) {
    return showToast(tr('missingFields'), 'error');
  }
  // Duplicate detection
  const dup = Object.values(portal.requests || {}).some(r =>
    r.studentId === child.id && r.absenceDate === absenceDate && ['pending', 'approved'].includes(r.status));
  if (dup && !confirm(tr('duplicateWarn'))) return;

  const btn = $('prSubmitBtn');
  btn.disabled = true;
  try {
    const date = new Date(absenceDate + 'T00:00:00');
    const subjectObj = (child.subjects || []).find(s => s.name === subject);
    await push(ref(db, `publicFamilyLinks/${CENTER}/${TOKEN}/requests`), {
      studentId: child.id,
      studentCenterId: child.centerId || CENTER,
      studentCenterName: child.centerName || '',
      studentName: child.nameCn || child.namePinyin || '',
      studentNameEn: child.namePinyin || '',
      subject,
      subjectLevel: subjectObj?.level || '',
      absenceDate,
      originalDay: DAYS[date.getDay()],
      originalTime: $('prOriginalTime').value || '',
      preferredDate,
      preferredTime,
      reason: $('prReason').value.trim(),
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    $('prAbsenceDate').value = '';
    $('prPreferredDate').value = '';
    $('prPreferredTime').value = '';
    $('prOriginalTime').innerHTML = '<option value="">—</option>';
    $('prReason').value = '';
    showToast(tr('submitSuccess'), 'success');
  } catch (err) {
    console.error(err);
    showToast('❌ ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function sweepExpired(requests) {
  const cutoff = Date.now() - EXPIRE_MS;
  const updates = {};
  Object.entries(requests).forEach(([id, r]) => {
    if (r.status === 'pending' && r.createdAt && new Date(r.createdAt).getTime() < cutoff) {
      updates[`${id}/status`] = 'expired';
      updates[`${id}/expiredAt`] = new Date().toISOString();
    }
  });
  if (Object.keys(updates).length) {
    try { await update(ref(db, `publicFamilyLinks/${CENTER}/${TOKEN}/requests`), updates); } catch {}
  }
}

// ---------- utils ----------
function showScreen(name) {
  ['screenLoading', 'screenInvalid', 'screenCode', 'screenMain'].forEach(id => $(id).classList.add('hidden'));
  $({ loading: 'screenLoading', invalid: 'screenInvalid', code: 'screenCode', main: 'screenMain' }[name]).classList.remove('hidden');
}
function applyLang() {
  document.documentElement.lang = lang === 'zh-TW' ? 'zh-TW' : 'en';
  $('langToggle').textContent = lang === 'en' ? '中文' : 'EN';
  document.querySelectorAll('[data-tr]').forEach(el => { el.textContent = tr(el.dataset.tr); });
  document.querySelectorAll('[data-tr-placeholder]').forEach(el => { el.placeholder = tr(el.dataset.trPlaceholder); });
  document.title = tr('title') + ' - Kumon';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeParse(str) { try { return JSON.parse(str); } catch { return null; } }
let toastTimer = null;
function showToast(msg, type = 'success') {
  const t2 = $('prToast');
  t2.textContent = msg;
  t2.className = `pr-toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t2.classList.add('hidden'), 3200);
}