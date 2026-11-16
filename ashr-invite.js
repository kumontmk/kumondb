// ashr-invite.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, get, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { t as tCore, applyI18n, getLang, setLang, i18nReady } from './ashr-i18n.js';

const t = (key, fallback) => {
  const v = tCore(key);
  return (v && v !== key) ? v : fallback;
};

const tt = (key, en, zh) => { const v = tCore(key); if (v && v !== key) return v; return getLang() === 'en' ? en : zh; };

// 👧👦 Per-student attendance state (one shared reason for the whole family)
let studentStatuses = {}; // uid -> 'attending' | 'declined' | null (unanswered)

const REASON_PRESETS = [
  { icon: '🧳', en: 'Family trip', zh: '家庭旅遊' },
  { icon: '🗓️', en: 'Schedule conflict', zh: '時間衝突' },
  { icon: '📚', en: 'School exam', zh: '學校考試' },
  { icon: '🤒', en: 'Not feeling well', zh: '身體不適' },
  { icon: '✈️', en: 'Out of town', zh: '已離澳' },
  { icon: '👨‍👩‍👧', en: 'Family event', zh: '家庭活動' }
];

function familyGroupsAll() {
  return uniqueStudentGroups((portal && portal.members) || []);
}
function isMultiFamily() {
  return familyGroupsAll().length > 1;
}
function initStudentStatuses() {
  const multi = isMultiFamily();
  familyGroupsAll().forEach(g => {
    if (studentStatuses[g.uid] === undefined) studentStatuses[g.uid] = multi ? null : 'attending';
  });
}
function statusOfUid(uid) {
  const s = studentStatuses[uid];
  return s === 'attending' || s === 'declined' ? s : null;
}
function attendingGroups() {
  return familyGroupsAll().filter(g => statusOfUid(g.uid) === 'attending');
}
function declinedGroups() {
  return familyGroupsAll().filter(g => statusOfUid(g.uid) === 'declined');
}
function joinNames(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  const en = getLang() === 'en';
  return list.slice(0, -1).join(en ? ', ' : '、') + (en ? ' and ' : '、') + list[list.length - 1];
}

const firebaseConfig = {
  apiKey: "AIzaSyB1VhQwGotEI8BHt8wp8FvtPpUY5FsI0qA",
  authDomain: "kumondb-f4377.firebaseapp.com",
  databaseURL: "https://kumondb-f4377-default-rtdb.firebaseio.com",
  projectId: "kumondb-f4377",
  storageBucket: "kumondb-f4377.firebasestorage.app",
  messagingSenderId: "838725994916",
  appId: "1:838725994916:web:87326ba7bec87a0e6b5931"
};

const app = initializeApp(firebaseConfig, 'ashr-invite');
const db = getDatabase(app);
const auth = getAuth(app);

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const eventId = params.get('e');
const token = params.get('t');

let eventSettings = {};
let timeslots = {};
let honorees = {};
let families = {};
let portal = null;
let familyId = null;
let familyData = null;
let selectedStatus = null;
let slotMode = 'same';
let selectedSlots = {};
let isEditing = false;
let deadlinePassed = false;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============================================
// 🧬 SAME-STUDENT MERGE / UNIQUE-STUDENT HELPERS
// ============================================
function studentUid(h) { return String(h?.studentNumber || h?.studentId || '').trim(); }

function groupMembersForDisplay(members) {
  const order = [];
  const byId = new Map();
  (members || []).forEach(m => {
    const id = studentUid(m) || m.honoreeKey || '';
    if (!byId.has(id)) {
      const g = {
        ...m,
        awards: [...(m.awards || [])],
        completions: [...(m.completions || [])],
        _hasAwards: (m.awards || []).length > 0
      };
      byId.set(id, g);
      order.push(g);
    } else {
      const g = byId.get(id);
      g.awards.push(...(m.awards || []));
      g.completions.push(...(m.completions || []));
      if ((m.awards || []).length && !g._hasAwards) {
        g.centerId = m.centerId;
        g.centerName = m.centerName || g.centerName;
        g._hasAwards = true;
      }
      if (!g.nameCn && (m.nameCn || m.nameEn)) g.nameCn = m.nameCn || m.nameEn;
      if (!g.nameEn && m.nameEn) g.nameEn = m.nameEn;
    }
  });
  order.forEach(g => {
    const sa = new Set();
    g.awards = g.awards.filter(a => {
      const k = `${a.subject}|${a.stars}|${a.reportingMonth || ''}`;
      if (sa.has(k)) return false;
      sa.add(k); return true;
    });
    const sc = new Set();
    g.completions = g.completions.filter(c => {
      const k = c.subjectCanon || c.subject;
      if (sc.has(k)) return false;
      sc.add(k); return true;
    });
    delete g._hasAwards;
  });
  return order;
}

function uniqueStudentGroups(memberKeys) {
  const groups = [];
  const byUid = new Map();
  (memberKeys || []).forEach(k => {
    const h = honorees[k];
    if (!h) return;
    const uid = studentUid(h) || k;
    if (!byUid.has(uid)) {
      const g = { uid, keys: [k], name: h.nameCn || h.nameEn || '' };
      byUid.set(uid, g);
      groups.push(g);
    } else {
      byUid.get(uid).keys.push(k);
    }
  });
  return groups;
}

function countUniqueFromIds(ids) {
  const s = new Set();
  (ids || []).forEach(mid => {
    const h = honorees[mid];
    s.add(studentUid(h) || mid);
  });
  return s.size;
}

// ============================================
// 🔐 SELF-HEALING ANONYMOUS SESSION
//   Fixes intermittent PERMISSION_DENIED caused by
//   expired ID tokens in suspended in-app browsers.
// ============================================
let authBootstrapped = false;

// Resolves once Firebase has restored (or not) any persisted session.
const authReady = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, (user) => { unsub(); resolve(user); });
});

async function ensureAuth({ force = false } = {}) {
  await authReady;
  let user = auth.currentUser;
  if (!user) user = (await signInAnonymously(auth)).user;

  let refreshed = force;
  try {
    if (force) {
      await user.getIdToken(true);
    } else {
      const tr = await user.getIdTokenResult();
      const msLeft = new Date(tr.expirationTime).getTime() - Date.now();
      if (msLeft < 5 * 60 * 1000) {
        await user.getIdToken(true);
        refreshed = true;
      }
    }
  } catch (err) {
    // Stored anonymous session is no longer usable — create a fresh one.
    console.warn('[invite] token refresh failed, re-signing anonymously:', err?.code || err);
    user = (await signInAnonymously(auth)).user;
    await user.getIdToken(true);
    refreshed = true;
  }

  // Give the Realtime Database connection a moment to attach the new token.
  if (refreshed) await new Promise(r => setTimeout(r, 200));
  authBootstrapped = true;
  return user;
}

// Watchdog: if the session is ever dropped (tab suspended, storage cleared,
// anonymous account purged), sign straight back in.
onAuthStateChanged(auth, (user) => {
  if (!user && authBootstrapped) {
    signInAnonymously(auth).catch(err => console.error('[invite] re-auth failed:', err));
  }
});

// Parents open this page from WhatsApp, leave, and come back later.
// Refresh the session the moment the page becomes visible / back online.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && authBootstrapped) {
    ensureAuth({ force: true }).catch(() => {});
  }
});
window.addEventListener('online', () => {
  if (authBootstrapped) ensureAuth({ force: true }).catch(() => {});
});

function isRetryableWriteError(err) {
  const s = String(err?.code || err?.message || '').toLowerCase();
  return s.includes('permission_denied') || s.includes('permission denied')
    || s.includes('auth/') || s.includes('network') || s.includes('unavailable')
    || s.includes('disconnected') || s.includes('expired');
}

// Write with automatic re-auth + retry, so a stale session never blocks RSVP.
async function updateWithAuthRetry(path, payload, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await ensureAuth({ force: attempt > 1 });
      await update(ref(db, path), payload);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableWriteError(err)) throw err;
      console.warn(`[invite] write failed (attempt ${attempt}/${maxAttempts}):`, err?.code || err?.message);
      try {
        await signInAnonymously(auth);
        await auth.currentUser?.getIdToken(true);
      } catch (reauthErr) {
        console.error('[invite] re-auth during retry failed:', reauthErr);
      }
      await new Promise(r => setTimeout(r, 350 * attempt));
    }
  }
  throw lastErr;
}

await i18nReady.catch(() => {});
init();

async function init() {
  applyI18n();
  $('langToggle').textContent = getLang() === 'en' ? '中文' : 'EN';
  $('langToggle').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'zh-TW' : 'en');
    location.reload();
  });
  $('retryBtn').addEventListener('click', () => location.reload());

  if (!eventId || !token) return showInvalid('Missing ?e= or ?t= parameter in URL.');

  try {
    await ensureAuth({ force: true });
  } catch (err) {
    console.error('Sign-in failed:', err);
    return showInvalid(`Sign-in failed: ${err.code || err.message}`);
  }

  try {
    const linkSnap = await get(ref(db, `publicAshrLinks/${eventId}/${token}`));
    if (!linkSnap.exists()) return showInvalid(`No link found at publicAshrLinks/${eventId}/${token}`);
    portal = linkSnap.val();
    if (portal.active === false) return showInvalid(t('inv.reasonDisabled', 'This invitation link has been disabled.'));
    if (!portal.members || !portal.members.length) return showInvalid(t('inv.reasonNoMembers', 'No honorees found for this invitation.'));
    familyId = portal.familyId;
  } catch (err) {
    console.error('Link load failed:', err);
    return showInvalid(`Database error: ${err.code || err.message}`);
  }

  try {
    const [settingsSnap, slotsSnap, honoreesSnap, familiesSnap] = await Promise.all([
      get(ref(db, `ashrEvents/${eventId}/settings`)),
      get(ref(db, `ashrEvents/${eventId}/timeslots`)),
      get(ref(db, `ashrEvents/${eventId}/honorees`)),
      get(ref(db, `ashrEvents/${eventId}/families`))
    ]);
    eventSettings = settingsSnap.val() || {};
    timeslots = slotsSnap.val() || {};
    honorees = honoreesSnap.val() || {};
    families = familiesSnap.val() || {};
    familyData = families[familyId] || null;
  } catch (err) {
    console.error('Event load failed:', err);
    return showInvalid(`Database error: ${err.code || err.message}`);
  }

  // 🧟 Zombie-link guard: ignore members whose honoree record was deleted
  const validMembers = (portal.members || []).filter(k => honorees[k]);
  if (!validMembers.length) {
    return showInvalid(t('inv.reasonNoMembers',
      'This invitation is no longer valid — the honoured student record was removed. Please contact your Kumon center.'));
  }
  if (validMembers.length !== (portal.members || []).length) portal.members = validMembers;

  if (eventSettings.rsvpDeadline) {
    deadlinePassed = new Date() > new Date(eventSettings.rsvpDeadline + 'T23:59:59');
  }

  showScreen('main');
  wireEvents();
  renderAll();

  onValue(ref(db, `ashrEvents/${eventId}/timeslots`), (snap) => {
    timeslots = snap.val() || {};
    safeRender('timeslots', renderTimeslots);
  }, (err) => console.error('[invite] timeslots listener:', err));

  onValue(ref(db, `ashrEvents/${eventId}/settings`), (snap) => {
    eventSettings = snap.val() || {};
    safeRender('details', renderEventDetails);
  }, (err) => console.error('[invite] settings listener:', err));

  onValue(ref(db, `ashrEvents/${eventId}/families/${familyId}`), (snap) => {
    familyData = snap.val() || null;
    if (familyData?.rsvp?.status && !isEditing) safeRender('confirm', renderConfirmation);
  }, (err) => console.error('[invite] family listener:', err));
}

function wireEvents() {
  initStudentStatuses();

  // 💬 One shared reason card, placed just above Submit so timeslots come first
  const reasonCard = $('reasonCard');
  const submitCard = $('submitCard');
  if (reasonCard && submitCard && reasonCard.parentNode === submitCard.parentNode) {
    submitCard.parentNode.insertBefore(reasonCard, submitCard);
  }
  const ta = $('declineReason');
  if (ta) {
    ta.maxLength = 200;
    ta.placeholder = t('inv.reasonPh', 'e.g. family trip, schedule conflict...');
    ta.addEventListener('input', () => { syncReasonChips(); updateReasonCount(); });
  }

  $('btnAttending').addEventListener('click', () => selectStatus('attending'));
  $('btnDeclined').addEventListener('click', () => selectStatus('declined'));
  $('submitRsvpBtn').addEventListener('click', submitRSVP);
  $('editRsvpBtn').addEventListener('click', startEditing);
  document.querySelectorAll('input[name="slotMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      slotMode = e.target.value;
      safeRender('timeslots', renderTimeslots);
    });
  });
}

function safeRender(name, fn) {
  try { fn(); }
  catch (err) { console.error(`[invite:${name}] render failed:`, err); }
}

function renderAll() {
  safeRender('header', renderHeader);
  safeRender('awards', renderAwards);
  safeRender('details', renderEventDetails);
  if (deadlinePassed) {
    if (familyData?.rsvp?.status) { safeRender('confirm', renderConfirmation); }
    else { showScreen('expired'); }
    return;
  }
  if (familyData?.rsvp?.status) {
    safeRender('confirm', renderConfirmation);
    return;
  }
  if (isMultiFamily()) {
    $('rsvpCard')?.classList.add('hidden');
    $('confirmationCard')?.classList.add('hidden');
    initStudentStatuses();
    safeRender('studentAttendance', renderStudentAttendance);
  } else {
    $('studentAttendanceCard')?.classList.add('hidden');
    $('rsvpCard')?.classList.remove('hidden');
    $('confirmationCard')?.classList.add('hidden');
  }
}

function showScreen(name) {
  ['screenLoading', 'screenInvalid', 'screenExpired', 'screenMain'].forEach(id => $(id)?.classList.add('hidden'));
  $(`screen${name.charAt(0).toUpperCase() + name.slice(1)}`)?.classList.remove('hidden');
}

function showInvalid(reason) {
  const el = $('invalidReason');
  if (el && reason) { el.textContent = reason; el.classList.remove('hidden'); }
  showScreen('invalid');
}

function renderHeader() {
  const el = $('eventNameLabel');
  if (el) el.textContent = eventSettings.eventName || `ASHR ${eventId}`;
}

function renderAwards() {
  const memberKeys = (portal && portal.members) || [];
  const memberHonorees = groupMembersForDisplay(memberKeys.map(key => honorees[key]).filter(Boolean));
  const names = memberHonorees.map(h => h.nameCn || h.nameEn).filter(Boolean).join(', ');
  const hasAnyAward = memberHonorees.some(h => (h.awards || []).length > 0);
  const hasAnyCompleter = memberHonorees.some(h => (h.completions || []).length > 0);

  let congrats;
  if (hasAnyCompleter && !hasAnyAward) {
    congrats = t('inv.completerCongratsText',
      'Congratulations to {{names}}! Your hard work and dedication have earned you recognition as a Final Material Completer.');
  } else if (hasAnyCompleter && hasAnyAward) {
    congrats = t('inv.mixedCongratsText',
      'Congratulations to {{names}}! Your hard work and dedication have earned you recognition as a Final Material Completer and a place on the Advanced Student Honour Roll.');
  } else {
    congrats = t('inv.congratsText',
      'Congratulations to {{names}}! Your hard work and dedication have earned you a place on the Advanced Student Honour Roll.');
  }
  if (typeof congrats !== 'string' || congrats.startsWith('inv.')) {
    congrats = 'Congratulations to {{names}}!';
  }
  congrats = congrats.replace('{{names}}', names || '');
  const congratsEl = $('congratsText');
  if (congratsEl) congratsEl.textContent = congrats;

  const listEl = $('studentAwardsList');
  if (!listEl) return;
  const wordCompleter = t('inv.completer', 'Completer');
  const wordHonoured = t('inv.honoured', 'Honoured Student');

  listEl.innerHTML = memberHonorees.map(h => {
    const awards = h.awards || [];
    const completions = h.completions || [];
    const hasComp = completions.length > 0;

    const completerBadges = completions.map(c => {
      const subj = c.subject || c.subjectCanon || c.subjectOriginal || '';
      return `<span class="award-tier tier-completer">🎓 ${escapeHtml(subj)} ${escapeHtml(wordCompleter)}</span>`;
    }).join(' ');

    const awardBadges = awards.map(a => {
      const medal =
        a.tier === 'Gold' ? '🥇' :
        a.tier === 'Silver' ? '🥈' :
        a.tier === 'Bronze' ? '🥉' : '';
      return `<span class="award-tier tier-${String(a.tier || 'bronze').toLowerCase()}">${medal}${escapeHtml(a.subject || '')} ${'★'.repeat(Number(a.stars) || 0)}</span>`;
    }).join(' ');

    const detailHtml = [completerBadges, awardBadges].filter(Boolean).join(' ') || escapeHtml(wordHonoured);
    const icon = hasComp ? '🎓' : '🏅';
    return `<div class="award-item ${hasComp ? 'has-completer' : ''}">
      <div class="award-medal">${icon}</div>
      <div class="award-info">
        <div class="student-name">${escapeHtml(h.nameCn || h.nameEn || '')}</div>
        <div class="award-detail">${detailHtml}</div>
      </div>
    </div>`;
  }).join('');
}

function renderEventDetails() {
  const nl = $('eventNameLabel');
  if (nl) nl.textContent = eventSettings.eventName || `ASHR ${eventId}`;
  const de = $('eventDetails');
  if (!de) return;
  de.innerHTML = `<p><strong>${escapeHtml(t('inv.date', '📅 Date:'))}</strong> ${escapeHtml(eventSettings.eventDate || 'TBD')}</p>
    <p><strong>${escapeHtml(t('inv.venue', '📍 Venue:'))}</strong> ${escapeHtml(eventSettings.venue || 'TBD')}</p>
    <p><strong>${escapeHtml(t('inv.deadline', '⏰ RSVP Deadline:'))}</strong> ${escapeHtml(eventSettings.rsvpDeadline || 'TBD')}</p>`;
}

// ============================================
// ✋ SINGLE-STUDENT FAMILY: family Yes / No
// ============================================
function selectStatus(status) {
  selectedStatus = status;
  $('btnAttending').classList.toggle('selected', status === 'attending');
  $('btnDeclined').classList.toggle('selected', status === 'declined');
  familyGroupsAll().forEach(g => { studentStatuses[g.uid] = status; });
  const attending = status === 'attending';
  $('timeslotCard').classList.toggle('hidden', !attending);
  $('guestCard').classList.toggle('hidden', !attending);
  $('reasonCard').classList.toggle('hidden', attending);
  $('submitCard').classList.remove('hidden');
  $('studentAttendanceCard')?.classList.add('hidden');
  if (attending) safeRender('timeslots', renderTimeslots);
  else syncReasonCard();
}

// ============================================
// 💬 ONE SHARED REASON — named after who can't come
// ============================================
function reasonSegments() {
  const ta = $('declineReason');
  if (!ta) return [];
  return ta.value.split(/[;；、,]/).map(s => s.trim()).filter(Boolean);
}

function syncReasonChips() {
  const card = $('reasonCard');
  if (!card) return;
  const parts = reasonSegments();
  card.querySelectorAll('.sa-chip').forEach(chip => {
    chip.classList.toggle('on', parts.includes(chip.dataset.reason));
  });
}

function updateReasonCount() {
  const ta = $('declineReason');
  const count = $('reasonCard')?.querySelector('.sa-count');
  if (!ta || !count) return;
  count.textContent = `${ta.value.length}/200`;
}

function toggleReasonPreset(text) {
  const ta = $('declineReason');
  if (!ta) return;
  const parts = reasonSegments();
  const i = parts.indexOf(text);
  if (i >= 0) parts.splice(i, 1);
  else parts.push(text);
  ta.value = parts.join(getLang() === 'en' ? '; ' : '、');
  syncReasonChips();
  updateReasonCount();
}

function buildReasonChips(card, ta) {
  if (!card.querySelector('.sa-chips')) {
    const wrap = document.createElement('div');
    wrap.className = 'sa-chips';
    REASON_PRESETS.forEach(p => {
      const label = getLang() === 'en' ? p.en : p.zh;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sa-chip';
      btn.dataset.reason = label;
      btn.textContent = `${p.icon} ${label}`;
      btn.addEventListener('click', () => toggleReasonPreset(label));
      wrap.appendChild(btn);
    });
    ta.parentNode.insertBefore(wrap, ta);
  }
  if (!card.querySelector('.sa-count')) {
    const count = document.createElement('div');
    count.className = 'sa-count';
    ta.parentNode.insertBefore(count, ta.nextSibling);
  }
}

function syncReasonCard() {
  const card = $('reasonCard');
  const ta = $('declineReason');
  if (!card || !ta) return;
  const names = declinedGroups().map(g => g.name || honorees[g.keys[0]]?.nameEn || '');
  const who = joinNames(names);
  const title = card.querySelector('h2') || card.querySelector('h3');
  if (title) {
    title.textContent = who
      ? tt('inv.whyNamed', `💬 Why can't ${who} attend? (optional)`, `💬 為什麼${who}未能出席？（可選）`)
      : tt('inv.whyGeneric', '💬 May we ask why? (optional)', '💬 可以告訴我們原因嗎？（可選）');
  }
  const hint = card.querySelector('p');
  if (hint) {
    hint.textContent = names.length > 1
      ? tt('inv.whyHintMulti',
          "One note covers everyone who can't make it — completely optional, and it helps your center plan future events.",
          '一個原因已涵蓋所有未能出席的學生 — 完全可選，有助中心籌辦日後活動。')
      : tt('inv.whyHintOne',
          'Completely optional — it just helps your center plan future events.',
          '完全可選 — 只是有助中心籌辦日後活動。');
  }
  ta.maxLength = 200;
  ta.placeholder = who
    ? tt('inv.whyPhNamed', `e.g. ${names[0]} has a family trip that day…`, `例如：${names[0]}當天家庭旅遊…`)
    : t('inv.reasonPh', 'e.g. family trip, schedule conflict...');
  buildReasonChips(card, ta);
  syncReasonChips();
  updateReasonCount();
}

// ============================================
// 👧👦 MULTI-STUDENT FAMILY: who's attending?
// ============================================
function renderStudentAttendance() {
  const card = $('studentAttendanceCard');
  const list = $('studentAttendanceList');
  if (!card || !list) return;
  const groups = familyGroupsAll();
  if (groups.length < 2) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const title = $('studentAttendanceTitle');
  if (title) title.textContent = tt('inv.whoAttends', "👧👦 Who's attending?", '👧👦 哪位學生出席？');
  const hint = $('studentAttendanceHint');
  if (hint) hint.textContent = tt('inv.perStudentHint',
    'Choose for each student. Timeslots are only needed for students who attend.',
    '請為每位學生選擇。只需為出席的學生選擇場次。');
  list.innerHTML = '';
  groups.forEach(g => {
    const h = honorees[g.keys[0]] || {};
    const st = statusOfUid(g.uid);
    const row = document.createElement('div');
    row.className = `sa-row ${st || 'unanswered'}`;
    row.innerHTML = `
      <div class="sa-main">
        <div class="sa-id">
          <div class="sa-name">${escapeHtml(g.name || h.nameEn || '')}</div>
          <div class="sa-sub">${escapeHtml(h.centerName || '')}${h.studentNumber ? ' · #' + escapeHtml(h.studentNumber) : ''}</div>
        </div>
        <div class="sa-seg" role="group" aria-label="${escapeHtml(g.name || '')}">
          <button type="button" class="sa-opt ${st === 'attending' ? 'on-yes' : ''}" data-sa="attending">✅ ${escapeHtml(tt('inv.studentAttending', 'Attending', '出席'))}</button>
          <button type="button" class="sa-opt ${st === 'declined' ? 'on-no' : ''}" data-sa="declined">❌ ${escapeHtml(tt('inv.studentDeclined', "Can't make it", '未能出席'))}</button>
        </div>
      </div>`;
    row.querySelectorAll('.sa-opt').forEach(btn => btn.addEventListener('click', () => {
      studentStatuses[g.uid] = btn.dataset.sa;
      if (btn.dataset.sa === 'declined') delete selectedSlots[g.uid];
      safeRender('studentAttendance', renderStudentAttendance);
    }));
    list.appendChild(row);
  });
  syncStudentFlow();
}

function syncStudentFlow() {
  const groups = familyGroupsAll();
  if (groups.length < 2) return;
  const answered = groups.filter(g => statusOfUid(g.uid)).length;
  const att = attendingGroups().length;
  const dec = declinedGroups().length;
  const allAnswered = answered === groups.length;
  selectedStatus = att > 0 ? 'attending' : (allAnswered ? 'declined' : null);
  $('timeslotCard')?.classList.toggle('hidden', att === 0);
  $('guestCard')?.classList.toggle('hidden', att === 0);
  $('reasonCard')?.classList.toggle('hidden', dec === 0);
  $('submitCard')?.classList.toggle('hidden', !allAnswered);
  const sum = $('studentAttendanceSummary');
  if (sum) {
    if (!allAnswered) {
      sum.className = 'sa-summary pending';
      sum.textContent = tt('inv.chooseEach',
        `Choose an option for each student to continue (${answered}/${groups.length}).`,
        `請為每位學生選擇一個選項以繼續（${answered}/${groups.length}）。`);
    } else if (att > 0 && dec > 0) {
      sum.className = 'sa-summary ok';
      sum.textContent = tt('inv.mixSummary',
        `✅ ${att} attending · ❌ ${dec} can't make it`,
        `✅ ${att} 位出席 · ❌ ${dec} 位未能出席`);
    } else if (att > 0) {
      sum.className = 'sa-summary ok';
      sum.textContent = tt('inv.allAttending',
        `✅ All ${att} students attending`,
        `✅ ${att} 位學生全部出席`);
    } else {
      sum.className = 'sa-summary sad';
      sum.textContent = tt('inv.allDeclined',
        "We're sorry to hear that.",
        '很遺憾未能出席。');
    }
  }
  if (dec > 0) syncReasonCard();
  if (att > 0) safeRender('timeslots', renderTimeslots);
}

// ============================================
// 🕐 TIMESLOTS
// ============================================
function computeSlotCountsExclude(excludeFamId) {
  const counts = {};
  Object.keys(timeslots).forEach(sid => { counts[sid] = { students: 0 }; });
  Object.entries(families).forEach(([fid, fam]) => {
    if (fid === excludeFamId) return;
    const rsvp = fam.rsvp;
    if (!rsvp || rsvp.status !== 'attending') return;
    const ps = rsvp.perStudentStatus || {};
    const memberIds = (fam.memberHonoreeIds || []).filter(mid => (ps[mid] || 'attending') === 'attending');
    if (rsvp.sameTimeslot && rsvp.sharedSlotId) {
      if (counts[rsvp.sharedSlotId]) counts[rsvp.sharedSlotId].students += countUniqueFromIds(memberIds);
    } else if (rsvp.perStudentSlots) {
      const seen = new Set();
      memberIds.forEach(mid => {
        const uid = studentUid(honorees[mid]) || mid;
        if (seen.has(uid)) return;
        seen.add(uid);
        const sid = rsvp.perStudentSlots[mid];
        if (sid && counts[sid]) counts[sid].students += 1;
      });
    }
  });
  return counts;
}

function isSingleStudent() {
  return attendingGroups().length <= 1;
}

function syncSlotModeToggle() {
  const toggleEl = document.querySelector('.slot-mode-toggle');
  if (!toggleEl) return;
  toggleEl.classList.toggle('hidden', isSingleStudent());
  if (isSingleStudent() && slotMode !== 'same') {
    slotMode = 'same';
    const radio = document.querySelector('input[name="slotMode"][value="same"]');
    if (radio) radio.checked = true;
  }
}

function renderTimeslots() {
  const container = $('timeslotList');
  if (!container) return;
  container.innerHTML = '';
  syncSlotModeToggle();
  const slotCounts = computeSlotCountsExclude(familyId);
  const sorted = Object.entries(timeslots)
    .filter(([_, s]) => s.isEnabled !== false)
    .sort((a, b) => (a[1].start || '').localeCompare(b[1].start || ''));
  const buildOption = (slotId, slot, onSelect, isSelected) => {
    const count = slotCounts[slotId]?.students || 0;
    const isFull = count >= (slot.capacity || 30);
    const div = document.createElement('div');
    div.className = `timeslot-option ${isFull ? 'disabled' : ''} ${isSelected ? 'selected' : ''}`;
    div.innerHTML = `<span class="slot-time">${escapeHtml(slot.start)} – ${escapeHtml(slot.end)}</span> <span class="slot-count">${count}/${slot.capacity || 30}</span> ${isFull ? `<span class="full-badge">${escapeHtml(t('inv.full', 'FULL'))}</span>` : ''}`;
    if (!isFull) div.addEventListener('click', onSelect);
    return div;
  };
  if (slotMode === 'same') {
    sorted.forEach(([slotId, slot]) => {
      container.appendChild(buildOption(slotId, slot, () => {
        selectedSlots = { shared: slotId };
        safeRender('timeslots', renderTimeslots);
      }, selectedSlots.shared === slotId));
    });
  } else {
    attendingGroups().forEach(g => {
      const label = document.createElement('div');
      label.innerHTML = `<p class="slot-student-label">${escapeHtml(g.name)}</p>`;
      sorted.forEach(([slotId, slot]) => {
        label.appendChild(buildOption(slotId, slot, () => {
          selectedSlots[g.uid] = slotId;
          safeRender('timeslots', renderTimeslots);
        }, selectedSlots[g.uid] === slotId));
      });
      container.appendChild(label);
    });
  }
}

// ============================================
// 📤 SUBMIT
// ============================================
async function submitRSVP() {
  const memberKeys = (portal && portal.members) || [];
  if (!memberKeys.length) return showToast(t('inv.reasonNoMembers', 'This invitation is no longer valid.'), 'error');
  const allGroups = familyGroupsAll();
  const multi = allGroups.length > 1;
  if (multi) {
    if (allGroups.some(g => !statusOfUid(g.uid))) {
      return showToast(tt('toast.answerEach',
        "Please choose Attending or Can't make it for every student.",
        '請為每位學生選擇「出席」或「未能出席」。'), 'error');
    }
  } else if (!selectedStatus) {
    return showToast(t('toast.chooseStatus', 'Please choose whether you will attend'), 'error');
  }
  const groups = attendingGroups();
  const declined = multi ? declinedGroups() : (selectedStatus === 'declined' ? allGroups : []);
  const effectiveStatus = multi ? (groups.length ? 'attending' : 'declined') : selectedStatus;
  const rsvp = { status: effectiveStatus, submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (multi) {
    const perStudentStatus = {};
    allGroups.forEach(g => {
      const st = statusOfUid(g.uid) || 'declined';
      g.keys.forEach(k => { perStudentStatus[k] = st; });
    });
    rsvp.perStudentStatus = perStudentStatus;
  }
  // 💬 One shared reason, recorded against every student who can't come
  if (declined.length) {
    const reason = ($('declineReason')?.value || '').trim();
    if (reason) {
      rsvp.reason = reason;
      if (multi) {
        const perStudentReasons = {};
        declined.forEach(g => g.keys.forEach(k => { perStudentReasons[k] = reason; }));
        rsvp.perStudentReasons = perStudentReasons;
      }
    }
  }
  if (effectiveStatus === 'attending') {
    if (isSingleStudent()) slotMode = 'same';
    const counts = computeSlotCountsExclude(familyId);
    if (slotMode === 'same') {
      if (!selectedSlots.shared) return showToast(t('toast.chooseSlot', 'Please select a timeslot'), 'error');
      const slot = timeslots[selectedSlots.shared];
      if ((counts[selectedSlots.shared]?.students || 0) + groups.length > (slot?.capacity || 30)) {
        return showToast(`${slot.start}–${slot.end} ${t('toast.slotFullNow', 'is now full. Please choose another.')}`, 'error');
      }
      rsvp.sameTimeslot = true;
      rsvp.sharedSlotId = selectedSlots.shared;
    } else {
      const missing = groups.filter(g => !selectedSlots[g.uid]);
      if (missing.length) return showToast(t('toast.eachSlot', 'Please select a timeslot for each student'), 'error');
      const perSlot = {};
      groups.forEach(g => { perSlot[selectedSlots[g.uid]] = (perSlot[selectedSlots[g.uid]] || 0) + 1; });
      for (const [sid, add] of Object.entries(perSlot)) {
        const slot = timeslots[sid];
        if ((counts[sid]?.students || 0) + add > (slot?.capacity || 30)) {
          return showToast(`${slot.start}–${slot.end} ${t('toast.slotFullNow', 'is now full. Please choose another.')}`, 'error');
        }
      }
      rsvp.sameTimeslot = false;
      const perStudent = {};
      groups.forEach(g => g.keys.forEach(k => { perStudent[k] = selectedSlots[g.uid]; }));
      rsvp.perStudentSlots = perStudent;
    }
    rsvp.guests = {
      mom: !!$('guestMom')?.checked,
      dad: !!$('guestDad')?.checked,
      grandma: !!$('guestGrandma')?.checked,
      grandpa: !!$('guestGrandpa')?.checked,
      siblings: parseInt($('guestSiblings')?.value) || 0,
      others: parseInt($('guestOthers')?.value) || 0
    };
  }
  const btn = $('submitRsvpBtn');
  btn.disabled = true;
  try {
    await updateWithAuthRetry(`ashrEvents/${eventId}/families/${familyId}`, {
      memberHonoreeIds: memberKeys,
      rsvp
    });
    familyData = { ...(familyData || {}), memberHonoreeIds: memberKeys, rsvp };
    showToast(t('toast.rsvpOk', 'RSVP submitted successfully!'), 'success');
    isEditing = false;
    safeRender('confirm', renderConfirmation);
  } catch (err) {
    console.error(err);
    if (isRetryableWriteError(err)) {
      showToast(t('toast.sessionRetry', 'Your session could not be refreshed. Please check your connection and tap Submit again.'), 'error');
    } else {
      showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

// ============================================
// ✅ CONFIRMATION
// ============================================
function renderConfirmation() {
  ['rsvpCard', 'timeslotCard', 'guestCard', 'submitCard', 'reasonCard', 'studentAttendanceCard']
    .forEach(id => $(id)?.classList.add('hidden'));
  $('confirmationCard')?.classList.remove('hidden');
  const rsvp = familyData?.rsvp;
  if (!rsvp) return;
  const ps = rsvp.perStudentStatus || null;
  const groups = familyGroupsAll();
  const reason = (rsvp.reason || Object.values(rsvp.perStudentReasons || {})[0] || '').trim();
  const guestTotal = () => {
    const g = rsvp.guests || {};
    return (g.mom ? 1 : 0) + (g.dad ? 1 : 0) + (g.grandma ? 1 : 0) + (g.grandpa ? 1 : 0) + (parseInt(g.siblings) || 0) + (parseInt(g.others) || 0);
  };
  const slotTextFor = (g) => {
    let sid = null;
    if (rsvp.sameTimeslot && rsvp.sharedSlotId) sid = rsvp.sharedSlotId;
    else {
      const map = rsvp.perStudentSlots || {};
      const k = g.keys.find(k => map[k]);
      sid = k ? map[k] : null;
    }
    const slot = sid ? timeslots[sid] : null;
    return slot ? `${slot.start} – ${slot.end}` : (sid || '');
  };
  let details = '';
  if (ps && groups.length > 1) {
    const att = groups.filter(g => (ps[g.keys[0]] || rsvp.status) === 'attending');
    const headline = rsvp.status === 'attending'
      ? `✅ ${t('st.attending', 'Attending')} (${att.length}/${groups.length})`
      : `❌ ${t('st.declined', 'Declined')}`;
    details += `<p><strong>${escapeHtml(t('inv.statusWord', 'Status'))}:</strong> ${escapeHtml(headline)}</p>`;
    details += '<ul class="sa-conf-list">';
    groups.forEach(g => {
      const st = ps[g.keys[0]] || rsvp.status;
      const h = honorees[g.keys[0]] || {};
      const right = st === 'attending' ? slotTextFor(g) : tt('inv.notAttending', 'Not attending', '不出席');
      details += `<li class="${st}">${st === 'attending' ? '✅' : '❌'} ${escapeHtml(g.name || h.nameEn || '')} — ${escapeHtml(right)}</li>`;
    });
    details += '</ul>';
  } else {
    details += `<p><strong>${escapeHtml(t('inv.statusWord', 'Status'))}:</strong> ${rsvp.status === 'attending' ? '✅ ' + escapeHtml(t('st.attending', 'Attending')) : '❌ ' + escapeHtml(t('st.declined', 'Declined'))}</p>`;
    if (rsvp.status === 'attending') {
      if (rsvp.sameTimeslot && rsvp.sharedSlotId) {
        const slot = timeslots[rsvp.sharedSlotId];
        details += `<p><strong>${escapeHtml(t('inv.timeslotsWord', 'Timeslot(s)'))}:</strong> ${slot ? `${escapeHtml(slot.start)} – ${escapeHtml(slot.end)}` : escapeHtml(rsvp.sharedSlotId)}</p>`;
      } else if (rsvp.perStudentSlots) {
        details += `<p><strong>${escapeHtml(t('inv.timeslotsWord', 'Timeslot(s)'))}:</strong></p><ul>`;
        const seen = new Set();
        Object.entries(rsvp.perStudentSlots).forEach(([key, slotId]) => {
          if (!honorees[key]) return;
          const uid = studentUid(honorees[key]) || key;
          if (seen.has(uid)) return;
          seen.add(uid);
          const h = honorees[key];
          const slot = timeslots[slotId];
          details += `<li>${escapeHtml(h?.nameCn || h?.nameEn || key)}: ${slot ? `${escapeHtml(slot.start)} – ${escapeHtml(slot.end)}` : escapeHtml(slotId)}</li>`;
        });
        details += '</ul>';
      }
    }
  }
  if (reason) {
    details += `<p><strong>${escapeHtml(t('inv.reasonWord', 'Reason'))}:</strong> ${escapeHtml(reason)}</p>`;
  }
  if (rsvp.status === 'attending') {
    details += `<p><strong>${escapeHtml(t('inv.guestsWord', 'Guests'))}:</strong> ${guestTotal()}</p>`;
  }
  details += `<p><strong>${escapeHtml(t('inv.submittedWord', 'Submitted'))}:</strong> ${new Date(rsvp.submittedAt).toLocaleString()}</p>`;
  const cd = $('confirmationDetails');
  if (cd) cd.innerHTML = details;
  $('editRsvpBtn')?.classList.toggle('hidden', deadlinePassed);
}

// ============================================
// ✏️ EDIT RESPONSE
// ============================================
function startEditing() {
  const rsvp = familyData?.rsvp;
  if (!rsvp) return;
  isEditing = true;
  $('confirmationCard').classList.add('hidden');
  const groups = familyGroupsAll();
  const multi = groups.length > 1;
  const ps = rsvp.perStudentStatus || {};
  studentStatuses = {};
  selectedStatus = rsvp.status;
  const savedReason = rsvp.reason || Object.values(rsvp.perStudentReasons || {})[0] || '';
  if ($('declineReason')) $('declineReason').value = savedReason;
  if (multi) {
    groups.forEach(g => { studentStatuses[g.uid] = ps[g.keys[0]] || rsvp.status || 'attending'; });
    $('rsvpCard')?.classList.add('hidden');
    restoreSlotsAndGuests(rsvp);
    safeRender('studentAttendance', renderStudentAttendance);
    return;
  }
  groups.forEach(g => { studentStatuses[g.uid] = rsvp.status; });
  $('rsvpCard')?.classList.remove('hidden');
  $('studentAttendanceCard')?.classList.add('hidden');
  $('btnAttending').classList.toggle('selected', rsvp.status === 'attending');
  $('btnDeclined').classList.toggle('selected', rsvp.status === 'declined');
  if (rsvp.status === 'attending') {
    $('timeslotCard').classList.remove('hidden');
    $('guestCard').classList.remove('hidden');
    $('submitCard').classList.remove('hidden');
    $('reasonCard')?.classList.add('hidden');
    restoreSlotsAndGuests(rsvp);
    safeRender('timeslots', renderTimeslots);
  } else {
    $('timeslotCard')?.classList.add('hidden');
    $('guestCard')?.classList.add('hidden');
    $('reasonCard').classList.remove('hidden');
    $('submitCard').classList.remove('hidden');
    syncReasonCard();
  }
}

function restoreSlotsAndGuests(rsvp) {
  if (isSingleStudent()) {
    slotMode = 'same';
    selectedSlots = rsvp.sameTimeslot
      ? { shared: rsvp.sharedSlotId }
      : { shared: Object.values(rsvp.perStudentSlots || {})[0] || null };
  } else {
    slotMode = rsvp.sameTimeslot ? 'same' : 'separate';
    if (rsvp.sameTimeslot) {
      selectedSlots = { shared: rsvp.sharedSlotId };
    } else {
      selectedSlots = {};
      Object.entries(rsvp.perStudentSlots || {}).forEach(([k, sid]) => {
        const uid = studentUid(honorees[k]) || k;
        if (!(uid in selectedSlots)) selectedSlots[uid] = sid;
      });
    }
  }
  const radio = document.querySelector(`input[name="slotMode"][value="${slotMode}"]`);
  if (radio) radio.checked = true;
  if (rsvp.guests) {
    $('guestMom').checked = !!rsvp.guests.mom;
    $('guestDad').checked = !!rsvp.guests.dad;
    $('guestGrandma').checked = !!rsvp.guests.grandma;
    $('guestGrandpa').checked = !!rsvp.guests.grandpa;
    $('guestSiblings').value = rsvp.guests.siblings || 0;
    $('guestOthers').value = rsvp.guests.others || 0;
  }
}

let toastTimer = null;
function showToast(msg, type = 'success') {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `invite-toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}