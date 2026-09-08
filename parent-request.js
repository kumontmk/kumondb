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
const parentApp = initializeApp(firebaseConfig, 'parent');
const db = getDatabase(parentApp);
const auth = getAuth(parentApp);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;
const PAST_DAYS = 30;
const FUTURE_DAYS = 60;

// ============================================================
// 🏫 CENTER OPERATING HOURS (single source of truth)
//    open  = first class start, latest = latest student arrival
// ============================================================
const R = (open, latest) => ({ open, latest });
const MK_DAYS = { Monday: R('14:30','19:15'), Tuesday: R('14:30','19:15'), Wednesday: R('14:30','19:15'), Thursday: R('14:30','19:15'), Friday: R('14:30','19:15'), Saturday: R('10:00','16:15'), Sunday: null };
const PT_DAYS = { Monday: R('14:30','18:45'), Tuesday: R('14:30','18:45'), Wednesday: R('14:30','18:45'), Thursday: R('14:30','18:45'), Friday: R('14:30','18:45'), Saturday: null, Sunday: null };
const TS_DAYS = { Monday: null, Tuesday: null, Wednesday: R('14:30','19:15'), Thursday: R('14:30','19:15'), Friday: R('14:30','19:15'), Saturday: R('10:00','16:15'), Sunday: null };

const CENTER_HOURS = [
  { key: 'mei keng', abbr: 'MK', nameEn: 'Kumon Mei Keng', nameCn: '氹仔美景', days: MK_DAYS,
    hoursEn: 'Mon–Fri 2:30–8:00pm (last arrival 7:15pm) • Sat 10:00am–5:00pm (last arrival 4:15pm) • Sun closed',
    hoursZh: '週一至五 2:30–8:00pm（最遲到達 7:15pm）• 週六 10:00am–5:00pm（最遲到達 4:15pm）• 週日休息' },
  { key: 'pac tat', abbr: 'PT', nameEn: 'Kumon Pac Tat', nameCn: '氹仔百達', days: PT_DAYS,
    hoursEn: 'Mon–Fri 2:30–7:30pm (last arrival 6:45pm) • Sat & Sun closed',
    hoursZh: '週一至五 2:30–7:30pm（最遲到達 6:45pm）• 週六及週日休息' },
  { key: 'champs', abbr: 'C', nameEn: 'Kumon Champs', nameCn: '卓思', days: MK_DAYS,
    hoursEn: 'Mon–Fri 2:30–8:00pm (last arrival 7:15pm) • Sat 10:00am–5:00pm (last arrival 4:15pm) • Sun closed',
    hoursZh: '週一至五 2:30–8:00pm（最遲到達 7:15pm）• 週六 10:00am–5:00pm（最遲到達 4:15pm）• 週日休息' },
  { key: 'tap siac', abbr: 'TS', nameEn: 'Kumon Tap Siac', nameCn: '塔石', days: TS_DAYS,
    hoursEn: 'Wed–Fri 2:30–8:00pm (last arrival 7:15pm) • Sat 10:00am–5:00pm (last arrival 4:15pm) • Mon & Tue closed',
    hoursZh: '週三至五 2:30–8:00pm（最遲到達 7:15pm）• 週六 10:00am–5:00pm（最遲到達 4:15pm）• 週一及週二休息' }
];
function getCenterCfg(keyOrId) {
  // ✅ Normalize hyphens/underscores to spaces so center IDs like
  //    'kumon-taipa-mei-keng' correctly match the key 'mei keng'
  const s = String(keyOrId || '').toLowerCase().replace(/[-_.]/g, ' ');
  return CENTER_HOURS.find(c => s.includes(c.key)) || null;
}
function abbrForCenter(keyOrId) {
  return getCenterCfg(keyOrId)?.abbr || String(keyOrId || '').replace(/^kumon[\s.-]*/i, '').substring(0, 2).toUpperCase();
}
// ✅ FULL center name for display (no more cryptic abbreviations)
function centerDisplayName(ts, child) {
  const idOrKey = ts?.center || ts?.centerName || child?.centerId || '';
  const cfg = getCenterCfg(idOrKey);
  const en = ts?.centerName || cfg?.nameEn || '';   // official DB name first
  const cn = cfg?.nameCn || '';                     // + Chinese from config
  if (en && cn) return `${en} ${cn}`;
  if (en) return en;
  if (cfg) return `${cfg.nameEn} ${cfg.nameCn}`;
  if (idOrKey) return String(idOrKey).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return '';
}
function timeToMin(t) { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; }
function minToTime(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

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
    classTimes: 'Weekly class times',
    absenceDate: 'Absence Date (the class you will miss)',
    absenceHint: 'Only your class days are shown.',
    noTimeslots: 'No weekly class time found for this subject — pick any date and time below.',
    originalTime: 'Original Class Time',
    noSlotHint: 'No scheduled class found on this day — enter the time manually.',
    preferredCenter: 'Preferred Center (you may choose any center)',
    preferredDate: 'Preferred Replacement Date',
    preferredTime: 'Preferred Time',
    closedHint: '{{center}} is closed on {{day}}.',
    outsideHours: '⚠️ The chosen time is outside the center\'s operating hours.',
    reason: 'Reason (optional)',
    reasonPh: 'e.g. school event, travel, sick...',
    submit: 'Submit Request',
    submitUpdate: 'Update Request',
    edit: 'Edit', cancel: 'Cancel',
    cancelConfirm: 'Cancel this request? The center will be notified.',
    updateSuccess: '✅ Request updated!',
    cancelSuccess: '✅ Request cancelled.',
    statusCancelled: 'Cancelled',
    editingBanner: 'Editing your request — tap Update to send the changes.',
    approvedContact: 'To change an approved request, please contact the center.',
    myRequests: 'My Requests',
    noRequests: 'No requests yet. Submit your first request above.',
    installTitle: 'Install as App',
    installHint: 'Install this page on your phone to request change classes anytime.',
    installBtn: '📲 Install App',
    iosHint: 'iPhone: tap Share ⬆️ then "Add to Home Screen".',
    footerNote: 'Requests are usually processed within 1–2 working days.',
    submitSuccess: '✅ Request submitted!',
    duplicateWarn: 'You already have a request for this date. Submit anyway?',
    missingFields: '⚠️ Please fill in subject, absence date, and preferred center, date & time.',
    statusPending: 'Pending', statusApproved: 'Approved', statusRejected: 'Rejected', statusExpired: 'Expired',
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
    classTimes: '每週上課時間',
    absenceDate: '缺席日期（您將缺席的課堂）',
    absenceHint: '只顯示您的上課日期。',
    noTimeslots: '此科目沒有每週上課時間 — 請在下方自行選擇日期及時間。',
    originalTime: '原課堂時間',
    noSlotHint: '當日沒有編排的課堂 — 請手動輸入時間。',
    preferredCenter: '心儀中心（可選擇任何中心）',
    preferredDate: '心儀補堂日期',
    preferredTime: '心儀時間',
    closedHint: '{{center}} 於{{day}}休息。',
    outsideHours: '⚠️ 所選時間超出中心開放時間。',
    reason: '原因（選填）',
    reasonPh: '例如：學校活動、外遊、生病...',
    submit: '提交申請',
    submitUpdate: '更新申請',
    edit: '編輯', cancel: '取消',
    cancelConfirm: '取消此申請？中心將會收到通知。',
    updateSuccess: '✅ 申請已更新！',
    cancelSuccess: '✅ 申請已取消。',
    statusCancelled: '已取消',
    editingBanner: '正在編輯申請 — 按更新以傳送變更。',
    approvedContact: '如需更改已批准的申請，請聯絡中心。',
    myRequests: '我的申請',
    noRequests: '暫無申請。請在上方提交第一個申請。',
    installTitle: '安裝為應用程式',
    installHint: '將此頁面安裝到手機，隨時申請調堂。',
    installBtn: '📲 安裝應用程式',
    iosHint: 'iPhone：點按分享 ⬆️ 然後選擇「加入主畫面」。',
    footerNote: '申請通常於1–2個工作天內處理。',
    submitSuccess: '✅ 申請已提交！',
    duplicateWarn: '此日期已有申請。仍要提交嗎？',
    missingFields: '⚠️ 請填寫科目、缺席日期及心儀中心、日期和時間。',
    statusPending: '待處理', statusApproved: '已批准', statusRejected: '已拒絕', statusExpired: '已過期',
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
let deferredPrompt = null;
let editingRequestId = null;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

init();

async function init() {
  applyLang();
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
    if (portal) {
      renderChildren(); renderTimeslots(); buildAbsenceDates(); fillOriginalTime();
      populatePreferredCenters(true); updateCenterHint(); rebuildPreferredTimes();
      renderRequests(portal.requests || {});
    }
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e;
    $('installBtn').classList.remove('hidden');
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null; $('installBtn').classList.add('hidden');
  });
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) $('iosHint').classList.remove('hidden');

  if (!CENTER || !TOKEN) return showScreen('invalid');
  try { await signInAnonymously(auth); }
  catch (err) { console.error('Anonymous sign-in failed:', err); return showScreen('invalid'); }

  try {
    const snap = await get(ref(db, `publicFamilyLinks/${CENTER}/${TOKEN}`));
    if (!snap.exists() || !snap.val()?.meta) return showScreen('invalid');
    portal = snap.val();
    if (portal.meta.active === false) return showScreen('invalid');
  } catch (err) { console.error(err); return showScreen('invalid'); }

  if (localStorage.getItem('pfl_ok_' + TOKEN) === '1') enterMain();
  else {
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
  } else { $('codeError').classList.remove('hidden'); $('codeInput').value = ''; }
}

function enterMain() {
  showScreen('main');
  $('centerLabel').textContent = portal.meta.centerName || '';
  children = Object.entries(portal.students || {})
    .map(([id, s]) => ({ id, ...s }))
    .filter(s => (s.subjects || []).length > 0)
    .sort((a, b) => (a.namePinyin || '').localeCompare(b.namePinyin || ''));
  if (children.length) selectedChildId = children[0].id;

  renderChildren();
  populateSubjects();
  renderTimeslots();
  buildAbsenceDates();
  fillOriginalTime();
  populatePreferredCenters(false);
  updateCenterHint();
  rebuildPreferredTimes();

  const today = toISO(new Date());
  $('prPreferredDate').min = today;
  $('prPreferredDate').max = toISO(new Date(Date.now() + 90 * 864e5));

  $('prSubject').addEventListener('change', () => { renderTimeslots(); buildAbsenceDates(); fillOriginalTime(); });
  $('prAbsenceDate').addEventListener('change', fillOriginalTime);
  $('prAbsenceDateFree').addEventListener('change', fillOriginalTime);
  $('prPreferredCenter').addEventListener('change', () => { updateCenterHint(); rebuildPreferredTimes(); });
  $('prPreferredDate').addEventListener('change', rebuildPreferredTimes);
  $('prSubmitBtn').addEventListener('click', submitRequest);
  $('cancelEditBtn').addEventListener('click', cancelEdit);

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
    const centerTag = c.centerId && c.centerId !== CENTER
      ? `<small>🏫 ${escapeHtml(c.centerName || '')}</small>`
      : `<small>${escapeHtml(c.grade ? 'G' + c.grade : '')}</small>`;
    const displayName = (c.nameCn && c.nameCn !== '-') ? c.nameCn
      : (c.namePinyin && c.namePinyin !== '-') ? c.namePinyin
      : (c.nickname || '');
    chip.innerHTML = `<span>${escapeHtml(displayName)}</span>${centerTag}`;    
    chip.addEventListener('click', () => {
      selectedChildId = c.id;
      renderChildren(); populateSubjects(); renderTimeslots(); buildAbsenceDates(); fillOriginalTime();
      populatePreferredCenters(false); updateCenterHint(); rebuildPreferredTimes();
    });
    wrap.appendChild(chip);
  });
}

function populateSubjects() {
  const sel = $('prSubject');
  sel.innerHTML = '';
  const child = getSelectedChild();
  if (!child) return;
  (child.subjects || []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `${s.name}${s.level ? ` (${s.level})` : ''}`;
    sel.appendChild(opt);
  });
}

// 🕐 Weekly chips WITH center abbreviation
function renderTimeslots() {
  const wrap = $('prTimeslots');
  const child = getSelectedChild();
  const slots = normalizeTimeslots(getSelectedSubjectObj()?.timeslots);
  if (!slots.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = `<span class="ts-chips-label">${tr('classTimes')}</span>` +
      slots.map(ts => {
      const cname = centerDisplayName(ts, child);
      return `<span class="ts-chip">${escapeHtml((ts.day || '').substring(0, 3))} ${escapeHtml(ts.time || '')}${cname ? ` • ${escapeHtml(cname)}` : ''}</span>`;
    }).join('');
}

function buildAbsenceDates() {
  const sel = $('prAbsenceDate');
  const free = $('prAbsenceDateFree');
  const hint = $('absenceHint');
  const slots = normalizeTimeslots(getSelectedSubjectObj()?.timeslots);
  const classDays = new Set(slots.map(ts => ts.day));
  sel.innerHTML = '';
  if (!classDays.size) {
    sel.classList.add('hidden'); free.classList.remove('hidden');
    free.min = toISO(new Date(Date.now() - PAST_DAYS * 864e5));
    free.max = toISO(new Date(Date.now() + FUTURE_DAYS * 864e5));
    hint.textContent = tr('noTimeslots'); hint.classList.remove('hidden');
    return;
  }
  free.classList.add('hidden'); sel.classList.remove('hidden');
  hint.textContent = tr('absenceHint'); hint.classList.remove('hidden');
  const opts = [];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  for (let i = -PAST_DAYS; i <= FUTURE_DAYS; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (!classDays.has(DAYS[d.getDay()])) continue;
    opts.push({ val: toISO(d), label: d.toLocaleDateString(lang === 'zh-TW' ? 'zh-Hant-HK' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) });
  }
  opts.forEach(o => { const op = document.createElement('option'); op.value = o.val; op.textContent = o.label; sel.appendChild(op); });
  const today = toISO(new Date());
  const past = opts.filter(o => o.val <= today);
  sel.value = past.length ? past[past.length - 1].val : (opts[0]?.val || '');
}

// 🕐 Original time = scheduled slot(s), labeled with center
function fillOriginalTime() {
  const sel = $('prOriginalTime');
  const free = $('prOriginalTimeFree');
  const hint = $('originalHint');
  const child = getSelectedChild();
  const dateVal = $('prAbsenceDate').classList.contains('hidden') ? $('prAbsenceDateFree').value : $('prAbsenceDate').value;
  sel.innerHTML = ''; hint.classList.add('hidden');
  if (!dateVal) { sel.innerHTML = '<option value="">—</option>'; return; }
  const dayName = DAYS[new Date(dateVal + 'T00:00:00').getDay()];
  const slots = normalizeTimeslots(getSelectedSubjectObj()?.timeslots).filter(ts => ts.day === dayName);
  if (slots.length) {
    sel.classList.remove('hidden'); free.classList.add('hidden');
    slots.forEach(ts => {
      const cname = centerDisplayName(ts, child);
      const op = document.createElement('option');
      op.value = ts.time;
      op.textContent = `${ts.time} (${dayName}${cname ? ' • ' + cname : ''})`;
      sel.appendChild(op);
    });
  } else {
    sel.classList.add('hidden'); free.classList.remove('hidden'); free.value = '';
    hint.textContent = tr('noSlotHint'); hint.classList.remove('hidden');
  }
}

// 🏫 Preferred center select (any center allowed)
function populatePreferredCenters(keepCurrent) {
  const sel = $('prPreferredCenter');
  const prev = sel.value;
  sel.innerHTML = '';
  CENTER_HOURS.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.key;
    opt.textContent = `${c.nameEn} ${c.nameCn} (${c.abbr})`;
    sel.appendChild(opt);
  });
  if (keepCurrent && prev) { sel.value = prev; return; }
  const child = getSelectedChild();
  const firstSlotCenter = normalizeTimeslots(child?.subjects?.[0]?.timeslots)[0]?.center || '';
  const guess = getCenterCfg(child?.centerId || '') || getCenterCfg(firstSlotCenter) || CENTER_HOURS[0];
  sel.value = guess.key;
}
function updateCenterHint() {
  const cfg = getCenterCfg($('prPreferredCenter').value);
  $('prCenterHint').textContent = cfg ? (lang === 'zh-TW' ? cfg.hoursZh : cfg.hoursEn) : '';
}

// ⏰ Preferred time = ONLY within chosen center's hours for the chosen weekday
function rebuildPreferredTimes() {
  const sel = $('prPreferredTime');
  const hint = $('preferredHint');
  const dateVal = $('prPreferredDate').value;
  const cfg = getCenterCfg($('prPreferredCenter').value);
  sel.innerHTML = '';
  hint.classList.add('hidden');
  if (!dateVal) { sel.innerHTML = '<option value="">—</option>'; return; }
  const dayName = DAYS[new Date(dateVal + 'T00:00:00').getDay()];
  const rule = cfg?.days?.[dayName];
  if (!rule) {
    sel.innerHTML = '<option value="">—</option>';
    hint.textContent = tr('closedHint')
      .replace('{{center}}', cfg ? `${cfg.nameEn} ${cfg.nameCn}` : '')
      .replace('{{day}}', dayName);
    hint.classList.remove('hidden');
    return;
  }
  for (let m = timeToMin(rule.open); m <= timeToMin(rule.latest); m += 15) {
    const val = minToTime(m);
    const op = document.createElement('option');
    op.value = val; op.textContent = val;
    sel.appendChild(op);
  }
}

function renderRequests(requests) {
const list = $('requestsList');
if (!list) return; // 🛡️ Guard: exit safely if the list container isn't in the DOM yet
const arr = Object.entries(requests || {}).map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (!arr.length) { list.innerHTML = `<div class="req-empty">${tr('noRequests')}</div>`; return; }
  list.innerHTML = '';
  arr.forEach(r => {
    const item = document.createElement('div');
    item.className = `req-item st-${r.status || 'pending'}`;
        const pillTxt = { pending: tr('statusPending'), approved: tr('statusApproved'), rejected: tr('statusRejected'), expired: tr('statusExpired'), cancelled: tr('statusCancelled') }[r.status] || r.status;
    let decision = '';
    if (r.status === 'approved') decision = `<div class="req-decision decision-approved">${tr('approvedNote')}</div>`;
    if (r.status === 'rejected') decision = `<div class="req-decision decision-rejected">↩️ ${escapeHtml(localizedRejectReason(r))}</div>`;
    const prefCenter = r.preferredCenterName ? ` @ ${escapeHtml(r.preferredCenterName)}` : '';
    item.innerHTML = `
      <div class="req-top">
        <span class="req-subject">${escapeHtml(r.subject || '')} ${r.subjectLevel ? `(${escapeHtml(r.subjectLevel)})` : ''}</span>
        <span class="req-pill pill-${r.status || 'pending'}">${pillTxt}</span>
      </div>
      <div class="req-dates">
        <div style="display:flex;gap:1.5rem;flex-wrap:wrap;">
          <span><strong>${tr('absence')}</strong>${escapeHtml(r.absenceDate || '')} ${escapeHtml(r.originalTime || '')}</span>
          <span><strong>${tr('preferred')}</strong>${escapeHtml(r.preferredDate || '')} ${escapeHtml(r.preferredTime || '')}${prefCenter}</span>
        </div>
      </div>
            ${r.reason ? `<div class="req-reason">💬 ${escapeHtml(r.reason)}</div>` : ''}
      ${decision}
      ${r.status === 'approved' ? `<div class="req-reason">${tr('approvedContact')}</div>` : ''}
      ${r.status === 'pending' ? `<div class="req-actions">
          <button type="button" class="req-edit" data-ra="edit" data-rid="${r.id}">✏️ ${tr('edit')}</button>
          <button type="button" class="req-cancel" data-ra="cancel" data-rid="${r.id}">🚫 ${tr('cancel')}</button>
        </div>` : ''}`;
    list.appendChild(item);
  });
  list.querySelectorAll('[data-ra]').forEach(btn => {
    btn.addEventListener('click', () => {
      const req = (portal.requests || {})[btn.dataset.rid];
      if (!req) return;
      if (btn.dataset.ra === 'edit') startEdit(btn.dataset.rid, req);
      else cancelRequest(btn.dataset.rid);
    });
  });
}

// ✏️ Load a pending request into the form for editing
function startEdit(id, r) {
  editingRequestId = id;
  $('prSubject').value = r.subject || '';
  $('prSubject').dispatchEvent(new Event('change')); // rebuilds chips + absence options
  const absSel = $('prAbsenceDate');
  if (!absSel.classList.contains('hidden')) {
    if (!Array.from(absSel.options).some(o => o.value === r.absenceDate)) {
      const op = document.createElement('option');
      op.value = r.absenceDate; op.textContent = r.absenceDate;
      absSel.appendChild(op);
    }
    absSel.value = r.absenceDate || '';
  } else {
    $('prAbsenceDateFree').value = r.absenceDate || '';
  }
  fillOriginalTime();
  if (r.originalTime) {
    if (!$('prOriginalTime').classList.contains('hidden')) $('prOriginalTime').value = r.originalTime;
    else $('prOriginalTimeFree').value = r.originalTime;
  }
  if (r.preferredCenterKey) $('prPreferredCenter').value = r.preferredCenterKey;
  updateCenterHint();
  $('prPreferredDate').value = r.preferredDate || '';
  rebuildPreferredTimes();
  if (r.preferredTime) $('prPreferredTime').value = r.preferredTime;
  $('prReason').value = r.reason || '';
  $('editBannerText').textContent = tr('editingBanner');
  $('editBanner').classList.remove('hidden');
  $('prSubmitBtn').textContent = '💾 ' + tr('submitUpdate');
  $('editBanner').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelEdit() {
  editingRequestId = null;
  $('editBanner').classList.add('hidden');
  $('prSubmitBtn').textContent = tr('submit');
  buildAbsenceDates(); fillOriginalTime(); rebuildPreferredTimes();
  $('prPreferredDate').value = '';
  $('prReason').value = '';
}

// 🚫 Parent cancels a pending request
async function cancelRequest(id) {
  if (!confirm(tr('cancelConfirm'))) return;
  try {
    await update(ref(db, `publicFamilyLinks/${CENTER}/${TOKEN}/requests/${id}`), {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledBy: 'parent'
    });
    if (editingRequestId === id) cancelEdit();
    showToast(tr('cancelSuccess'), 'success');
  } catch (err) { console.error(err); showToast('❌ ' + err.message, 'error'); }
}

function localizedRejectReason(r) {
  const map = { slotFull: 'rejSlotFull', anotherDay: 'rejAnotherDay', centerClosed: 'rejCenterClosed' };
  if (r.rejectReasonKey && map[r.rejectReasonKey]) return tr(map[r.rejectReasonKey]);
  return r.rejectReason || tr('rejOther');
}

// ---------- submit ----------
async function submitRequest() {
  const child = getSelectedChild();
  if (!child) return showToast(tr('missingFields'), 'error');
  const subject = $('prSubject').value;
  const absenceDate = $('prAbsenceDate').classList.contains('hidden') ? $('prAbsenceDateFree').value : $('prAbsenceDate').value;
  const originalTime = $('prOriginalTime').classList.contains('hidden') ? $('prOriginalTimeFree').value : $('prOriginalTime').value;
  const cfg = getCenterCfg($('prPreferredCenter').value);
  const preferredDate = $('prPreferredDate').value;
  const preferredTime = $('prPreferredTime').value;
  if (!subject || !absenceDate || !preferredDate || !preferredTime || !cfg) {
    return showToast(tr('missingFields'), 'error');
  }
  //  Hard-check against center hours
  const dayName = DAYS[new Date(preferredDate + 'T00:00:00').getDay()];
  const rule = cfg.days[dayName];
  if (!rule) {
    return showToast(tr('closedHint').replace('{{center}}', `${cfg.nameEn} ${cfg.nameCn}`).replace('{{day}}', dayName), 'error');
  }
  const pm = timeToMin(preferredTime);
  if (pm < timeToMin(rule.open) || pm > timeToMin(rule.latest)) {
    return showToast(tr('outsideHours'), 'error');
  }
  const dup = Object.entries(portal.requests || {}).some(([rid, x]) =>
    rid !== editingRequestId && x.studentId === child.id && x.absenceDate === absenceDate && ['pending', 'approved'].includes(x.status));
  if (dup && !confirm(tr('duplicateWarn'))) return;

  const btn = $('prSubmitBtn');
  btn.disabled = true;
  try {
        const subjectObj = (child.subjects || []).find(s => s.name === subject);
    const payload = {
      studentId: child.id,
      studentCenterId: child.centerId || CENTER,
      studentCenterName: child.centerName || '',
      studentName: (child.nameCn && child.nameCn !== '-') ? child.nameCn : (child.namePinyin || ''),
      studentNameEn: child.namePinyin || '',
      subject,
      subjectLevel: subjectObj?.level || '',
      absenceDate,
      originalDay: DAYS[new Date(absenceDate + 'T00:00:00').getDay()],
      originalTime: originalTime || '',
      preferredCenterKey: cfg.key,
      preferredCenterName: `${cfg.nameEn} ${cfg.nameCn}`,
      preferredDate,
      preferredTime,
      reason: $('prReason').value.trim(),
      status: 'pending'
    };
    if (editingRequestId) {
      await update(ref(db, `publicFamilyLinks/${CENTER}/${TOKEN}/requests/${editingRequestId}`), {
        ...payload,
        parentEditedAt: new Date().toISOString()
      });
      showToast(tr('updateSuccess'), 'success');
    } else {
      await push(ref(db, `publicFamilyLinks/${CENTER}/${TOKEN}/requests`), {
        ...payload,
        createdAt: new Date().toISOString()
      });
      showToast(tr('submitSuccess'), 'success');
    }
    $('prPreferredDate').value = '';
    $('prReason').value = '';
    cancelEdit();
    buildAbsenceDates(); fillOriginalTime(); rebuildPreferredTimes();
  } catch (err) {
    console.error(err);
    showToast('❌ ' + err.message, 'error');
  } finally { btn.disabled = false; }
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
function getSelectedChild() { return children.find(c => c.id === selectedChildId); }
function getSelectedSubjectObj() {
  return (getSelectedChild()?.subjects || []).find(s => s.name === $('prSubject').value);
}
function normalizeTimeslots(raw) {
  if (Array.isArray(raw)) return raw.filter(ts => ts && ts.day);
  if (raw && typeof raw === 'object') return Object.values(raw).filter(ts => ts && ts.day);
  return [];
}
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function showScreen(name) {
  ['screenLoading', 'screenInvalid', 'screenCode', 'screenMain'].forEach(id => $(id).classList.add('hidden'));
  $({ loading: 'screenLoading', invalid: 'screenInvalid', code: 'screenCode', main: 'screenMain' }[name]).classList.remove('hidden');
}
function applyLang() {
  document.documentElement.lang = lang === 'zh-TW' ? 'zh-TW' : 'en';
  $('langToggle').textContent = lang === 'en' ? '中文' : 'EN';
  document.querySelectorAll('[data-tr]').forEach(el => { el.textContent = tr(el.dataset.tr); });
  document.querySelectorAll('[data-tr-placeholder]').forEach(el => { el.placeholder = tr(el.dataset.trPlaceholder); });
  if (editingRequestId) $('prSubmitBtn').textContent = '💾 ' + tr('submitUpdate');
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