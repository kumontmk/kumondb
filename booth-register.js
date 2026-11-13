// ============================================================
// BOOTH GAMES — PUBLIC REGISTRATION FORM
// Anonymous access via short code: booth-register.html?f=CODE
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, get, push, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  GRADES, GRADE_CN, gradeLabel, gradeInRange, rangeLabel,
  INTERESTS, interestLabel, PALETTE, bannerCss, FIREBASE_CONFIG,
  escapeHtml, randomCode, localDateStr, calcAge, ageText, fmtDate, fmtDateShort, slotLabel, slotFullLabel,
  slotsOverlap, windowState, validPhone, normalizePhone, copyText, renderQrCanvas,
  normalizeEventConfig, normalizeGames, eventRangeLabel
} from './booth-shared.js';

const app = initializeApp(FIREBASE_CONFIG, 'booth-register');
const db = getDatabase(app);
const auth = getAuth(app);
const $ = id => document.getElementById(id);

const params = new URLSearchParams(location.search);
const shortCode = (params.get('f') || '').trim().toUpperCase();
const directEvent = (params.get('e') || '').trim();

let eventId = null;
let config = {}, games = {}, counts = {};
let step = 1;
let submitting = false;
let confettiRaf = null;
let toastTimer = null;

const answers = {
  studentName:'', grade:'', school:'', birthday:'', parentPhone:'',
  apps:{ wechat:false, whatsapp:false }, wechatId:'',
  current:null, currentCenter:'', currentSubjects:'',
  interests:new Set(), selections:{}, remarks:''
};

// ---------- startup diagnostics ----------
const REQUIRED_IDS = [
  'screenLoading','screenInvalid','invalidReason','screenBefore','beforeInfo',
  'screenClosed','closedTitle','closedInfo','pubHeader','hdrTitle','screenMain',
  'hero','heroImg','evTitle','evTitleCn','evDesc','evMeta','evDeadline',
  'fName','gradeGrid','fSchool','fBirth','agePill','fPhone','appWeChat','appWhatsApp',
  'wechatIdWrap','fWeChatId','curYes','curNo','currentDetails','fCenter',
  'fCurSubjects','interestList','gradeReminder','gamesWrap','overlapWarn',
  'selSummary','reviewWrap','fRemarks','submitNote','backBtn','nextBtn',
  'submitBtn','wizForm','screenSuccess','confettiCanvas','successQr',
      'successSummary','againBtn','toast','toastMsg'
];
function fatal(msg) {
  const reason = $('invalidReason');
  if (reason) reason.textContent = msg;
  $('pubHeader')?.classList.add('hidden');
  ['screenLoading','screenBefore','screenClosed','screenMain','screenSuccess']
    .forEach(id => $(id)?.classList.add('hidden'));
  $('screenInvalid')?.classList.remove('hidden');
}
window.addEventListener('error', e => {
  const l = $('screenLoading');
  if (l && !l.classList.contains('hidden')) fatal(`Page error 頁面錯誤: ${e.message || 'unknown'}`);
});
window.addEventListener('unhandledrejection', e => {
  const l = $('screenLoading');
  if (l && !l.classList.contains('hidden')) fatal(`Page error 頁面錯誤: ${e.reason?.message || e.reason || 'unknown'}`);
});
const missingIds = REQUIRED_IDS.filter(id => !$(id));
if (missingIds.length) {
  fatal(`This page's HTML is out of date. Missing element(s): ${missingIds.join(', ')}. 請更新 booth-register.html。`);
  throw new Error('booth-register.html missing IDs: ' + missingIds.join(', '));
}

// ============================================
// INIT
// ============================================
init().catch(err => fatal(`Init failed 初始化失敗: ${err.message || err}`));

async function init() {
  if (!shortCode && !directEvent) return showInvalid('Missing ?f= code in the link. 連結缺少報名代碼。');
  try { await signInAnonymously(auth); }
  catch (err) { return showInvalid(`Sign-in failed 登入失敗: ${err.code || err.message}`); }

  try {
    if (shortCode) {
      const snap = await get(ref(db, `boothCodes/${shortCode}`));
      if (!snap.exists()) return showInvalid('This registration link does not exist (any more). 此報名連結不存在或已失效。');
      eventId = snap.val().eventId;
    } else eventId = directEvent;

    const [cfgSnap, gSnap, cSnap] = await Promise.all([
      get(ref(db, `boothEvents/${eventId}/config`)),
      get(ref(db, `boothEvents/${eventId}/games`)),
      get(ref(db, `boothEvents/${eventId}/counts`))
    ]);
    if (!cfgSnap.exists()) return showInvalid('Event not found. 找不到此活動。');
    config = normalizeEventConfig(cfgSnap.val() || {});
    games = normalizeGames(gSnap.val() || {}, config);
    counts = cSnap.val() || {};
  } catch (err) { return showInvalid(`Database error 資料庫錯誤: ${err.code || err.message}`); }

  const ws = windowState(config);
  if (ws.state === 'before') {
    $('beforeInfo').textContent = `Opens 開始日期: ${fmtDate(config.regStart)} — ${ws.days} day(s) to go 尚餘 ${ws.days} 日`;
    return showScreen('screenBefore');
  }
  if (ws.state === 'after') {
    $('closedInfo').textContent = `Registration ended on 報名已於 ${fmtDate(config.regEnd)} 結束。`;
    return showScreen('screenClosed');
  }
  if (ws.state === 'paused' || ws.state === 'invalid') {
    $('closedTitle').textContent = 'Registration paused 報名暫停';
    $('closedInfo').textContent = 'This form is temporarily not accepting registrations. 此表單暫時停止接受報名。';
    return showScreen('screenClosed');
  }

  buildStaticUI();
  renderHero();
  $('pubHeader').classList.remove('hidden');
  showScreen('screenMain');
  showStep(1, false);

  onValue(ref(db, `boothEvents/${eventId}/counts`), snap => {
    counts = snap.val() || {};
    if (!submitting) {
      let dropped = false;
      Object.entries(answers.selections).forEach(([gid, sid]) => {
        const cap = Number(games[gid]?.slots?.[sid]?.capacity) || 0;
        if (cap && (Number(counts[gid]?.[sid]) || 0) >= cap) { delete answers.selections[gid]; dropped = true; }
      });
      if (dropped) showToast('A selected slot just filled up — please pick another. 所選場次剛已額滿，請另選。', 'error');
    }
    if (step === 3 && !$('screenMain').classList.contains('hidden')) renderGames();
    if (step === 4 && !$('screenMain').classList.contains('hidden')) renderReview();
  });

  onValue(ref(db, `boothEvents/${eventId}/games`), snap => {
    games = normalizeGames(snap.val() || {}, config);
    Object.keys(answers.selections).forEach(gid => {
      if (!games[gid] || !games[gid].slots?.[answers.selections[gid]]) delete answers.selections[gid];
    });
    if (step === 3 && !$('screenMain').classList.contains('hidden')) renderGames();
    if (step === 4 && !$('screenMain').classList.contains('hidden')) renderReview();
  });

  onValue(ref(db, `boothEvents/${eventId}/config`), snap => {
    config = normalizeEventConfig(snap.val() || {});
    games = normalizeGames(games, config);
    const s = windowState(config).state;
    if (s !== 'open' && !submitting && !$('screenMain').classList.contains('hidden')) {
      $('closedTitle').textContent = s === 'after' ? 'Registration closed 報名已結束' : 'Registration paused 報名暫停';
      $('closedInfo').textContent = 'This form is no longer accepting registrations. 此表單已停止接受報名。';
      $('pubHeader').classList.add('hidden');
      showScreen('screenClosed');
      return;
    }
    if (!$('screenMain').classList.contains('hidden')) renderHero();
  });
}

// ============================================
// SCREENS / HERO
// ============================================
function showScreen(id) {
  ['screenLoading','screenInvalid','screenBefore','screenClosed','screenMain','screenSuccess'].forEach(s => $(s).classList.add('hidden'));
  $(id).classList.remove('hidden');
  window.scrollTo({ top:0 });
}
function showInvalid(reason) {
  $('invalidReason').textContent = reason;
  $('pubHeader').classList.add('hidden');
  showScreen('screenInvalid');
}

function renderHero() {
  const hero = $('hero');
  if (config.bannerDataUrl) {
    $('heroImg').src = config.bannerDataUrl;
    $('heroImg').classList.remove('hidden');
    hero.style.background = '#16233b';
  } else {
    $('heroImg').classList.add('hidden');
    hero.style.background = bannerCss(config.bannerPreset);
  }
  $('evTitle').textContent = config.title || config.titleCn || 'Booth Games 攤位遊戲';
  $('evTitleCn').textContent = config.title && config.titleCn ? config.titleCn : '';
  $('evDesc').textContent = config.description || '';
  $('hdrTitle').textContent = config.title || config.titleCn || '';

  const chips = [];
  const range = eventRangeLabel(config);
  if (range) chips.push('📅 ' + range);
  if (config.timeText) chips.push('⏰ ' + config.timeText);
  let meta = chips.map(c => '<span class="meta-chip">' + escapeHtml(c) + '</span>').join('');
  if (config.venueEn || config.venueCn) {
    meta += '<div class="hero-venue">' +
      (config.venueEn ? '<span>📍 ' + escapeHtml(config.venueEn) + '</span>' : '') +
      (config.venueCn ? '<span>' + escapeHtml(config.venueCn) + '</span>' : '') +
      '</div>';
  }
  $('evMeta').innerHTML = meta;
  $('evDeadline').textContent = config.regEnd ? `⏰ Register by 報名截止: ${fmtDate(config.regEnd, false)}` : '';
  document.title = `${config.title || 'Booth Games'} · 攤位遊戲報名`;
}

// ============================================
// STATIC UI
// ============================================
function buildStaticUI() {
  const grid = $('gradeGrid');
  grid.innerHTML = '';
  [['K','Kindergarten 幼兒'], ['P','Primary 小學'], ['F','Secondary 中學']].forEach(([band, label]) => {
    const row = document.createElement('div');
    row.className = 'band-row';
    row.innerHTML = '<span class="band-label">' + label + '</span>';
    GRADES.filter(g => g[0] === band).forEach(g => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'grade-chip-btn';
      b.dataset.grade = g;
      b.innerHTML = '<span class="g">' + g + '</span><span class="gc">' + GRADE_CN[g] + '</span>';
      b.addEventListener('click', () => {
        answers.grade = g;
        grid.querySelectorAll('.grade-chip-btn').forEach(x => x.classList.toggle('selected', x.dataset.grade === g));
        Object.keys(answers.selections).forEach(gid => {
          const gm = games[gid];
          if (gm && !gradeInRange(g, gm.minGrade, gm.maxGrade)) delete answers.selections[gid];
        });
      });
      row.appendChild(b);
    });
    grid.appendChild(row);
  });

  $('fBirth').max = localDateStr();
  $('fName').addEventListener('input', e => { answers.studentName = e.target.value; clearInvalid(e.target); });
  $('fSchool').addEventListener('input', e => { answers.school = e.target.value; clearInvalid(e.target); });
  $('fBirth').addEventListener('input', e => {
    answers.birthday = e.target.value;
    clearInvalid(e.target);
    const pill = $('agePill');
    const a = calcAge(answers.birthday);
    if (a) { pill.textContent = '🎂 ' + ageText(answers.birthday); pill.classList.add('has-age'); }
    else { pill.textContent = 'Age will be calculated automatically 年齡將自動計算'; pill.classList.remove('has-age'); }
  });
  $('fPhone').addEventListener('input', e => { answers.parentPhone = e.target.value; clearInvalid(e.target); });
  $('fWeChatId').addEventListener('input', e => { answers.wechatId = e.target.value; });
  $('fCenter').addEventListener('input', e => { answers.currentCenter = e.target.value; clearInvalid(e.target); });
  $('fCurSubjects').addEventListener('input', e => { answers.currentSubjects = e.target.value; clearInvalid(e.target); });
  $('fRemarks').addEventListener('input', e => { answers.remarks = e.target.value; });

  const toggleApp = key => {
    answers.apps[key] = !answers.apps[key];
    $('appWeChat').classList.toggle('selected', answers.apps.wechat);
    $('appWhatsApp').classList.toggle('selected', answers.apps.whatsapp);
    $('wechatIdWrap').classList.toggle('hidden', !answers.apps.wechat);
  };
  $('appWeChat').addEventListener('click', () => toggleApp('wechat'));
  $('appWhatsApp').addEventListener('click', () => toggleApp('whatsapp'));

  const setCurrent = val => {
    answers.current = val;
    $('curYes').classList.toggle('selected', val === 'yes');
    $('curNo').classList.toggle('selected', val === 'no');
    $('currentDetails').classList.toggle('hidden', val !== 'yes');
  };
  $('curYes').addEventListener('click', () => setCurrent('yes'));
  $('curNo').addEventListener('click', () => setCurrent('no'));

  // Interest cards — both "None" options are exclusive.
  const list = $('interestList');
  const exclusiveIds = INTERESTS.filter(o => o.exclusive).map(o => o.id);
  list.innerHTML = '';
  INTERESTS.forEach(o => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'interest-card' + (o.exclusive ? ' exclusive' : '');
    card.dataset.id = o.id;
    card.innerHTML = '<span class="box">✓</span><span><span class="i-cn">' + escapeHtml(o.cn) + '</span><span class="i-en">' + escapeHtml(o.en) + '</span></span>';
    card.addEventListener('click', () => {
      if (o.exclusive) {
        if (answers.interests.has(o.id)) answers.interests.delete(o.id);
        else { answers.interests.clear(); answers.interests.add(o.id); }
      } else {
        exclusiveIds.forEach(id => answers.interests.delete(id));
        if (answers.interests.has(o.id)) answers.interests.delete(o.id);
        else answers.interests.add(o.id);
      }
      list.querySelectorAll('.interest-card').forEach(c => c.classList.toggle('selected', answers.interests.has(c.dataset.id)));
    });
    list.appendChild(card);
  });

  $('backBtn').addEventListener('click', () => showStep(step - 1));
  $('nextBtn').addEventListener('click', () => { if (validateStep(step)) showStep(step + 1); });
  $('submitBtn').addEventListener('click', submitRegistration);
  $('wizForm').addEventListener('submit', e => e.preventDefault());
  document.querySelectorAll('#gradeReminder [data-goto]').forEach(b =>
    b.addEventListener('click', () => showStep(Number(b.dataset.goto))));

  $('againBtn').addEventListener('click', registerAnother);
}

function clearInvalid(el) { el.classList.remove('invalid'); }
function markInvalid(el, msg) {
  el.classList.add('invalid');
  showToast(msg, 'error');
  el.scrollIntoView({ behavior:'smooth', block:'center' });
  setTimeout(() => el.focus({ preventScroll:true }), 300);
}

// ============================================
// STEP NAVIGATION
// ============================================
function showStep(n, scroll = true) {
  step = Math.min(4, Math.max(1, n));
  document.querySelectorAll('.step-panel').forEach(p => p.classList.toggle('active', Number(p.dataset.step) === step));
  document.querySelectorAll('.step-dot').forEach(d => {
    const s = Number(d.dataset.s);
    d.classList.toggle('active', s === step);
    d.classList.toggle('done', s < step);
    d.querySelector('.dot').textContent = s < step ? '✓' : s;
  });
  $('backBtn').classList.toggle('hidden', step === 1);
  $('nextBtn').classList.toggle('hidden', step === 4);
  $('submitBtn').classList.toggle('hidden', step !== 4);
  $('nextBtn').textContent = step === 3 ? 'Review 確認 →' : 'Next 下一步 →';
  if (step === 3) renderGames();
  if (step === 4) renderReview();
  const h = document.querySelector(`.step-panel[data-step="${step}"] h2`);
  if (h) h.focus({ preventScroll:true });
  if (scroll) document.querySelector('.wizard').scrollIntoView({ behavior:'smooth', block:'start' });
}

function validateStep(n) {
  if (n === 1) {
    if (!answers.studentName.trim()) { markInvalid($('fName'), 'Please enter the student name 請填寫學生姓名'); return false; }
    if (!answers.grade) { showToast('Please choose the grade 請選擇年級', 'error'); $('gradeGrid').scrollIntoView({ behavior:'smooth', block:'center' }); return false; }
    const a = calcAge(answers.birthday);
    if (!a || a.years > 25) { markInvalid($('fBirth'), 'Please enter a valid birthday 請填寫有效出生日期'); return false; }
    if (!validPhone(answers.parentPhone)) { markInvalid($('fPhone'), 'Please enter a valid phone number 請填寫有效電話號碼'); return false; }
    if (!answers.apps.wechat && !answers.apps.whatsapp) { showToast('Choose at least one contact app 請選擇至少一種聯絡方式', 'error'); return false; }
    return true;
  }
  if (n === 2) {
    if (!answers.current) { showToast('Please tell us if you are a current Kumon student 請選擇是否現讀公文式', 'error'); return false; }
    if (answers.current === 'yes') {
      if (!answers.currentCenter.trim()) { markInvalid($('fCenter'), 'Please enter the center 請填寫教室'); return false; }
      if (!answers.currentSubjects.trim()) { markInvalid($('fCurSubjects'), 'Please enter the subject(s) 請填寫科目'); return false; }
    }
    if (!answers.interests.size) { showToast('Pick at least one subject of interest 請選擇至少一項想了解的科目', 'error'); return false; }
    return true;
  }
  if (n === 3) {
    const list = selectedSlotsList();
    if (!list.length) { showToast('Pick at least one game & time slot 請選擇至少一項遊戲及時段', 'error'); return false; }
    for (const { gid, sid, g, s } of list) {
      if (!gradeInRange(answers.grade, g.minGrade, g.maxGrade)) {
        showToast(`"${g.name || g.nameCn}" is not open to grade ${answers.grade}. 此遊戲不接受目前年級。`, 'error');
        return false;
      }
      const cap = Number(s.capacity) || 0;
      if (cap && (Number(counts[gid]?.[sid]) || 0) >= cap) {
        showToast('A selected slot is full — please choose another. 所選場次已額滿，請另選。', 'error');
        renderGames();
        return false;
      }
    }
    if (findOverlaps().length) { showToast('Two selected slots overlap in time. 所選時段時間重疊。', 'error'); return false; }
    return true;
  }
  return true;
}

// ============================================
// GAMES & SLOTS
// ============================================
function selectedSlotsList() {
  return Object.entries(answers.selections).map(([gid, sid]) => {
    const g = games[gid]; const s = g?.slots?.[sid];
    return s ? { gid, sid, g, s } : null;
  }).filter(Boolean);
}

function findOverlaps() {
  const list = selectedSlotsList();
  const out = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (slotsOverlap(list[i].s, list[j].s)) out.push([list[i], list[j]]);
  return out;
}

function renderGames() {
  const wrap = $('gamesWrap');
  wrap.innerHTML = '';
  const hasGrade = !!answers.grade;
  $('gradeReminder').classList.toggle('hidden', hasGrade);

  Object.entries(games).forEach(function (entry) {
    const gid = entry[0];
    const g = entry[1];
    const eligible = hasGrade && gradeInRange(answers.grade, g.minGrade, g.maxGrade);
    const card = document.createElement('div');
    card.className = 'game-card' + (eligible ? '' : ' locked') + (answers.selections[gid] ? ' has-selection' : '');
    card.style.setProperty('--gc', g.color || PALETTE[0]);

    let body = '';
    if (!eligible) {
      const msg = !hasGrade
        ? '🔒 Choose the grade in step 1 first 請先於第一步選擇年級'
        : '🔒 Only 只限 ' + rangeLabel(g.minGrade, g.maxGrade);
      body = '<div class="lock-reason">' + escapeHtml(msg) + '</div>';
    } else {
      const slots = Object.entries(g.slots || {}).sort(function (a, b) {
        return String(a[1].date || '').localeCompare(String(b[1].date || '')) ||
               String(a[1].start).localeCompare(String(b[1].start));
      });
      let inner = '';
      if (!slots.length) {
        inner = '<p class="f-hint">No time slots yet. 尚未新增時段。</p>';
      } else {
        const byDate = {};
        slots.forEach(function (se) {
          const d = se[1].date || '';
          (byDate[d] = byDate[d] || []).push(se);
        });
        Object.keys(byDate).sort().forEach(function (date) {
          inner += '<div class="slot-date-head">📅 ' + escapeHtml(date ? fmtDate(date) : 'Date TBD 日期待定') + '</div>';
          byDate[date].forEach(function (se) {
            const sid = se[0];
            const s = se[1];
            const cap = Number(s.capacity) || 0;
            const booked = Number((counts[gid] || {})[sid]) || 0;
            const left = Math.max(0, cap - booked);
            const selected = answers.selections[gid] === sid;
            const full = left <= 0 && !selected;

            let seats;
            if (full) seats = '<span class="full-badge">FULL 額滿</span>';
            else if (left <= 3) seats = '<span style="color:#b45309">' + left + ' left 尚餘 ' + left + ' 位</span>';
            else seats = '<span>' + left + ' left 尚餘 ' + left + ' 位</span>';

            let cls = 'slot-ticket';
            if (selected) cls += ' selected';
            const dis = full ? ' disabled' : '';
            const tick = selected ? '✓' : '';

            inner += '<button type="button" class="' + cls + '" data-gid="' + escapeHtml(gid) + '" data-sid="' + escapeHtml(sid) + '"' + dis + '>'
              + '<span class="s-time">🎟 ' + escapeHtml(slotLabel(s)) + '</span>'
              + '<span class="s-seats">' + seats + '</span>'
              + '<span class="s-radio">' + tick + '</span>'
              + '</button>';
          });
        });
      }
      body = '<div class="game-slots">' + inner + '</div>';
    }

    card.innerHTML =
      '<div class="game-head"><div class="game-emoji">' + (g.emoji || '🎮') + '</div>'
      + '<div class="game-names"><div class="g-en">' + escapeHtml(g.name || '') + '</div><div class="g-cn">' + escapeHtml(g.nameCn || '') + '</div></div>'
      + '<span class="game-range">' + escapeHtml(rangeLabel(g.minGrade, g.maxGrade)) + '</span></div>'
      + body;
    wrap.appendChild(card);
  });

  if (!Object.keys(games).length) {
    wrap.innerHTML = '<p class="f-hint">No games have been added yet. 尚未新增遊戲。</p>';
  }

  wrap.querySelectorAll('.slot-ticket').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const gid = btn.dataset.gid;
      const sid = btn.dataset.sid;
      if (answers.selections[gid] === sid) delete answers.selections[gid];
      else answers.selections[gid] = sid;
      renderGames();
    });
  });

  renderSelectionSummary();
  renderOverlapWarn();
}

function renderSelectionSummary() {
  const wrap = $('selSummary');
  let html = '';
  selectedSlotsList().forEach(function (item) {
    const gid = item.gid, g = item.g, s = item.s;
    html += '<span class="sel-chip" style="--gc:' + (g.color || PALETTE[0]) + '">'
      + (g.emoji || '🎮') + ' ' + escapeHtml(g.name || g.nameCn || '') + ' · '
      + escapeHtml(fmtDateShort(s.date)) + ' ' + escapeHtml(s.start) + '–' + escapeHtml(s.end)
      + '<button type="button" data-clear="' + escapeHtml(gid) + '" aria-label="Remove">×</button></span>';
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll('[data-clear]').forEach(function (b) {
    b.addEventListener('click', function () {
      delete answers.selections[b.dataset.clear];
      renderGames();
    });
  });
}

function renderOverlapWarn() {
  const overlaps = findOverlaps();
  const el = $('overlapWarn');
  el.classList.toggle('hidden', !overlaps.length);
  if (!overlaps.length) { el.innerHTML = ''; return; }
  let html = '⚠️ Time conflict 時間衝突：<br>';
  html += overlaps.map(function (pair) {
    const a = pair[0], b = pair[1];
    return (a.g.emoji || '🎮') + ' ' + escapeHtml(a.g.name || '') + ' ' + escapeHtml(fmtDateShort(a.s.date)) + ' ' + escapeHtml(a.s.start) + '–' + escapeHtml(a.s.end)
      + ' ↔ ' + (b.g.emoji || '🎮') + ' ' + escapeHtml(b.g.name || '') + ' ' + escapeHtml(fmtDateShort(b.s.date)) + ' ' + escapeHtml(b.s.start) + '–' + escapeHtml(b.s.end);
  }).join('<br>');
  html += '<br>Please adjust your choices. 請調整所選時段。';
  el.innerHTML = html;
}

// ============================================
// REVIEW
// ============================================
function renderReview() {
  const a = calcAge(answers.birthday);
  const apps = [answers.apps.wechat ? '💬 WeChat' : '', answers.apps.whatsapp ? '📱 WhatsApp' : ''].filter(Boolean).join(' · ');
  function rv(label, value) {
    return '<div class="rv-row"><span class="rv-l">' + label + '</span><span class="rv-v">' + (value || '—') + '</span></div>';
  }
  let gamesHtml = '';
  selectedSlotsList()
    .sort(function (x, y) {
      return String(x.s.date || '').localeCompare(String(y.s.date || '')) || String(x.s.start).localeCompare(String(y.s.start));
    })
    .forEach(function (item) {
      const g = item.g, s = item.s;
      gamesHtml += rv((g.emoji || '🎮') + ' ' + escapeHtml(g.name || g.nameCn || ''), escapeHtml(slotFullLabel(s)));
    });

  let html = '';
  html += '<div class="rv-section"><div class="rv-head"><h4>🧒 Child 小朋友</h4><button type="button" class="rv-edit" data-goto="1">Edit 修改</button></div>';
  html += rv('Name 姓名', escapeHtml(answers.studentName));
  html += rv('Grade 年級', escapeHtml(gradeLabel(answers.grade)));
  html += rv('School 學校', escapeHtml(answers.school));
  html += rv('Birthday 生日', answers.birthday ? escapeHtml(fmtDate(answers.birthday, false)) : '');
  html += rv('Age 年齡', a ? (a.years + 'y ' + a.months + 'm · ' + a.years + '歲' + a.months + '個月') : '');
  html += rv('Phone 電話', escapeHtml(answers.parentPhone));
  html += rv('Contact 聯絡', escapeHtml(apps) + (answers.apps.wechat && answers.wechatId ? ' · ID: ' + escapeHtml(answers.wechatId) : ''));
  html += '</div>';

  html += '<div class="rv-section"><div class="rv-head"><h4>📚 Kumon 公文式</h4><button type="button" class="rv-edit" data-goto="2">Edit 修改</button></div>';
  html += rv('Current student 現讀', answers.current === 'yes' ? '✅ Yes 是' : '🆕 No 否');
  if (answers.current === 'yes') {
    html += rv('Center 教室', escapeHtml(answers.currentCenter));
    html += rv('Subjects 科目', escapeHtml(answers.currentSubjects));
  }
  html += rv('Interested 興趣', Array.from(answers.interests).map(function (i) { return escapeHtml(interestLabel(i)); }).join('<br>'));
  html += '</div>';

  html += '<div class="rv-section"><div class="rv-head"><h4>🎪 Games 遊戲</h4><button type="button" class="rv-edit" data-goto="3">Edit 修改</button></div>';
  html += gamesHtml || rv('Games 遊戲', '—');
  html += '</div>';

  $('reviewWrap').innerHTML = html;
  $('reviewWrap').querySelectorAll('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () { showStep(Number(b.dataset.goto)); });
  });

  let note = '📅 ' + eventRangeLabel(config);
  if (config.timeText) note += ' · ⏰ ' + config.timeText;
  if (config.venueEn) note += ' · 📍 ' + config.venueEn;
  note += ' · ' + selectedSlotsList().length + ' game(s) 項遊戲';
  if (config.regEnd) note += ' · ⏰ Deadline 截止: ' + fmtDate(config.regEnd, false);
  $('submitNote').textContent = note;
}

// ============================================
// SUBMIT — capacity-safe transactions + rollback
// ============================================
async function bumpCount(gid, sid, delta, cap) {
  const res = await runTransaction(
    ref(db, `boothEvents/${eventId}/counts/${gid}/${sid}`),
    cur => {
      const n = Number(cur) || 0;
      if (delta > 0 && cap && n >= cap) return;
      return Math.max(0, n + delta);
    },
    { applyLocally:false }
  );
  return res.committed;
}

async function rollback(done) {
  for (const { gid, sid } of done) {
    try { await bumpCount(gid, sid, -1, 0); }
    catch (err) { console.error('Count rollback failed:', err); }
  }
}

async function submitRegistration() {
  if (submitting) return;
  if (!validateStep(1)) { showStep(1); return; }
  if (!validateStep(2)) { showStep(2); return; }
  if (!validateStep(3)) { showStep(3); return; }

  const ws = windowState(config);
  if (ws.state !== 'open') {
    $('closedTitle').textContent = ws.state === 'after' ? 'Registration closed 報名已結束' : 'Registration paused 報名暫停';
    $('closedInfo').textContent = 'This form is no longer accepting registrations. 此表單已停止接受報名。';
    $('pubHeader').classList.add('hidden');
    showScreen('screenClosed');
    return;
  }

  submitting = true;
  const btn = $('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting… 提交中…';
  const done = [];

  try {
    for (const { gid, sid, g, s } of selectedSlotsList()) {
      const ok = await bumpCount(gid, sid, +1, Number(s.capacity) || 0);
      if (!ok) {
        await rollback(done);
        showToast(`"${g.name || g.nameCn}" ${slotFullLabel(s)} just filled up — please pick another slot. 場次剛已額滿，請另選。`, 'error');
        showStep(3);
        return;
      }
      done.push({ gid, sid });
    }

    const a = calcAge(answers.birthday) || { years:0, months:0 };
    const reg = {
      code:'BG-' + randomCode(6),
      studentName:answers.studentName.trim(),
      grade:answers.grade,
      school:answers.school.trim(),
      birthday:answers.birthday,
      ageYears:a.years,
      ageMonths:a.months,
      parentPhone:normalizePhone(answers.parentPhone),
      contactApps:{ wechat:!!answers.apps.wechat, whatsapp:!!answers.apps.whatsapp },
      wechatId:answers.wechatId.trim(),
      isCurrentStudent:answers.current,
      currentCenter:answers.current === 'yes' ? answers.currentCenter.trim() : '',
      currentSubjects:answers.current === 'yes' ? answers.currentSubjects.trim() : '',
      interests:[...answers.interests],
      selections:selectedSlotsList().map(({ gid, sid, g, s }) => ({
        gameId:gid, slotId:sid, gameName:g.name || g.nameCn || '',
        date:s.date || '', start:s.start, end:s.end
      })),
      remarks:answers.remarks.trim(),
      status:'registered',
      submittedAt:new Date().toISOString()
    };

    try { await push(ref(db, `boothEvents/${eventId}/registrations`), reg); }
    catch (err) { await rollback(done); throw err; }

    showSuccess(reg);
  } catch (err) {
    console.error('Submit failed:', err);
    showToast(`Submit failed 提交失敗: ${err.code || err.message}`, 'error');
  } finally {
    submitting = false;
    btn.disabled = false;
    btn.textContent = '🎉 Submit registration 提交報名';
  }
}

// ============================================
// SUCCESS
// ============================================
function showSuccess(reg) {
  $('pubHeader').classList.add('hidden');
  const qrWrap = $('successQr');
  qrWrap.innerHTML = '';
  const c = renderQrCanvas(reg.code, 160);
  if (c) qrWrap.appendChild(c);

  let html = '';
  html += '<div class="ss-row">🧒 ' + escapeHtml(reg.studentName) + ' · ' + escapeHtml(gradeLabel(reg.grade)) + '</div>';
  if (reg.school) html += '<div class="ss-row">🏫 ' + escapeHtml(reg.school) + '</div>';
  reg.selections.forEach(function (s) {
    const emoji = (games[s.gameId] || {}).emoji || '🎟';
    html += '<div class="ss-row">' + emoji + ' ' + escapeHtml(s.gameName) + ' · ' + escapeHtml(slotFullLabel(s)) + '</div>';
  });
  html += '<div class="ss-row">📅 ' + escapeHtml(eventRangeLabel(config)) + (config.timeText ? ' · ' + escapeHtml(config.timeText) : '') + '</div>';
  if (config.venueEn) html += '<div class="ss-row">📍 ' + escapeHtml(config.venueEn) + '</div>';
  if (config.venueCn) html += '<div class="ss-row">📍 ' + escapeHtml(config.venueCn) + '</div>';
  $('successSummary').innerHTML = html;

  showScreen('screenSuccess');
  burstConfetti();
  showToast('🎉 Registration submitted! 報名成功！', 'success');
}

function registerAnother() {
  answers.studentName = ''; answers.grade = ''; answers.school = ''; answers.birthday = '';
  answers.interests = new Set(); answers.selections = {}; answers.remarks = '';
  $('fName').value = ''; $('fSchool').value = ''; $('fBirth').value = ''; $('fRemarks').value = '';
  $('agePill').textContent = 'Age will be calculated automatically 年齡將自動計算';
  $('agePill').classList.remove('has-age');
  document.querySelectorAll('.grade-chip-btn').forEach(x => x.classList.remove('selected'));
  document.querySelectorAll('.interest-card').forEach(x => x.classList.remove('selected'));
  $('pubHeader').classList.remove('hidden');
  showScreen('screenMain');
  showStep(1, false);
  showToast('Parent details kept — add the next child. 已保留家長資料，請填寫下一位小朋友。', 'success');
}

function burstConfetti() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = $('confettiCanvas');
  const card = canvas.parentElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = card.clientWidth, H = card.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  if (confettiRaf) cancelAnimationFrame(confettiRaf);

  const parts = Array.from({ length:140 }, (_, i) => ({
    x:W / 2 + (Math.random() - 0.5) * 60, y:H * 0.3,
    vx:(Math.random() - 0.5) * 10, vy:-Math.random() * 9 - 3,
    size:5 + Math.random() * 6, color:PALETTE[i % PALETTE.length],
    rot:Math.random() * Math.PI, vr:(Math.random() - 0.5) * 0.3,
    circle:Math.random() < 0.3
  }));
  const t0 = performance.now();
  const tick = now => {
    const t = now - t0;
    ctx.clearRect(0, 0, W, H);
    parts.forEach(p => {
      p.vy += 0.22; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - t / 2600);
      if (p.circle) { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      ctx.restore();
    });
    if (t < 2600) confettiRaf = requestAnimationFrame(tick);
    else { ctx.clearRect(0, 0, W, H); confettiRaf = null; }
  };
  confettiRaf = requestAnimationFrame(tick);
}

// ============================================
// TOAST
// ============================================
function showToast(msg, type = 'success') {
  const toast = $('toast');
  $('toastMsg').textContent = msg;
  toast.className = `invite-toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3600);
}

window.addEventListener('beforeunload', () => { if (confettiRaf) cancelAnimationFrame(confettiRaf); });