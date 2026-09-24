import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, get, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { t, applyI18n, getLang, setLang, i18nReady } from './ashr-i18n.js';

const firebaseConfig = {
  apiKey: "AIzaSyB1VhQwGotEI8BHt8wp8FvtPpUY5FsI0qA",
  authDomain: "kumondb-f4377.firebaseapp.com",
  databaseURL: "https://kumondb-f4377-default-rtdb.firebaseio.com",
  projectId: "kumondb-f4377",
  storageBucket: "kumondb-f4377.firebasestorage.app",
  messagingSenderId: "838725994916",
  appId: "1:838725994916:web:87326ba7bec87a0e6b5931"
};

// 1️⃣ INITIALIZE FIREBASE FIRST
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

// 2️⃣ WAIT FOR TRANSLATIONS, THEN BOOT
await i18nReady.catch(() => {});
init();

// 3️⃣ INIT FUNCTION
async function init() {
  applyI18n();
  $('langToggle').textContent = getLang() === 'en' ? '中文' : 'EN';
    $('langToggle').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'zh-TW' : 'en');
    location.reload(); // cleanest: core re-boots in the new language
    });
  $('retryBtn').addEventListener('click', () => location.reload());

  if (!eventId || !token) return showInvalid('Missing ?e= or ?t= parameter in URL.');

  try {
    await signInAnonymously(auth);
  } catch (err) {
    console.error('Sign-in failed:', err);
    return showInvalid(`Sign-in failed: ${err.code || err.message}`);
  }

  try {
    const linkSnap = await get(ref(db, `publicAshrLinks/${eventId}/${token}`));
    if (!linkSnap.exists()) return showInvalid(`No link found at publicAshrLinks/${eventId}/${token}`);
    portal = linkSnap.val();
    if (portal.active === false) return showInvalid(t('inv.reasonDisabled'));
    if (!portal.members || !portal.members.length) return showInvalid(t('inv.reasonNoMembers'));
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

  if (eventSettings.rsvpDeadline) {
    deadlinePassed = new Date() > new Date(eventSettings.rsvpDeadline + 'T23:59:59');
  }

  showScreen('main');
  wireEvents();
  renderAll();

  onValue(ref(db, `ashrEvents/${eventId}/timeslots`), (snap) => { timeslots = snap.val() || {}; renderTimeslots(); });
  onValue(ref(db, `ashrEvents/${eventId}/settings`), (snap) => { eventSettings = snap.val() || {}; renderEventDetails(); });
  onValue(ref(db, `ashrEvents/${eventId}/families/${familyId}`), (snap) => {
    familyData = snap.val() || null;
    if (familyData?.rsvp?.status && !isEditing) renderConfirmation();
  });
}

function wireEvents() {
  $('btnAttending').addEventListener('click', () => selectStatus('attending'));
  $('btnDeclined').addEventListener('click', () => selectStatus('declined'));
  $('submitRsvpBtn').addEventListener('click', submitRSVP);
  $('editRsvpBtn').addEventListener('click', startEditing);
  document.querySelectorAll('input[name="slotMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => { slotMode = e.target.value; renderTimeslots(); });
  });
}

function renderAll() {
  renderHeader();
  renderAwards();
  renderEventDetails();
  if (deadlinePassed) {
    if (familyData?.rsvp?.status) { renderConfirmation(); }
    else { showScreen('expired'); }
    return;
  }
  if (familyData?.rsvp?.status) renderConfirmation();
  else {
    $('rsvpCard').classList.remove('hidden');
    $('confirmationCard').classList.add('hidden');
  }
}

function showScreen(name) {
  ['screenLoading', 'screenInvalid', 'screenExpired', 'screenMain'].forEach(id => $(id).classList.add('hidden'));
  $(`screen${name.charAt(0).toUpperCase() + name.slice(1)}`).classList.remove('hidden');
}

function showInvalid(reason) {
  const el = $('invalidReason');
  if (el && reason) { el.textContent = reason; el.classList.remove('hidden'); }
  showScreen('invalid');
}

function renderHeader() {
  $('eventNameLabel').textContent = eventSettings.eventName || `ASHR ${eventId}`;
}

function renderAwards() {
  const memberKeys = portal.members || [];
  const memberHonorees = memberKeys.map(key => honorees[key]).filter(Boolean);
  const names = memberHonorees.map(h => h.nameCn || h.nameEn).join(', ');
  
  // 🌐 Translated congrats message ({{names}} placeholder), with safe fallback
  let congrats = '';
  try { 
    const raw = t('inv.congratsText'); 
    congrats = (typeof raw === 'string') ? raw : '';
  } catch (e) { 
    congrats = ''; 
  }
  
  if (!congrats || congrats === 'inv.congratsText') {
    congrats = 'Congratulations to {{names}}! Your hard work and dedication have earned you a place on the Advanced Student Honour Roll.';
  }
  
  congrats = congrats.replace('{{names}}', names);
  $('congratsText').textContent = congrats;
  $('studentAwardsList').innerHTML = memberHonorees.map(h => {
    const awards = (h.awards || []).map(a => {
      // 🥇 Only Gold awards carry a medal
    const medal = a.tier === 'Gold' ? '🥇 ' : a.tier === 'Silver' ? '🥈 ' : a.tier === 'Bronze' ? '🥉 ' : '';
      return `<span class="award-tier tier-${(a.tier || 'bronze').toLowerCase()}">${medal}${a.subject} ${'★'.repeat(a.stars || 0)}</span>`;
    }).join(' ');
    return `
      <div class="award-item">
        <div class="award-medal">🏅</div>
        <div class="award-info">
          <div class="student-name">${h.nameCn || h.nameEn}</div>
          <div class="award-detail">${awards}</div>
        </div>
      </div>`;
  }).join('');
}

function renderEventDetails() {
  $('eventNameLabel').textContent = eventSettings.eventName || `ASHR ${eventId}`;
  $('eventDetails').innerHTML = `
    <p><strong>${t('inv.date', '📅 Date:')}</strong> ${eventSettings.eventDate || 'TBD'}</p>
    <p><strong>${t('inv.venue', '📍 Venue:')}</strong> ${eventSettings.venue || 'TBD'}</p>
    <p><strong>${t('inv.deadline', '⏰ RSVP Deadline:')}</strong> ${eventSettings.rsvpDeadline || 'TBD'}</p>`;
}

function selectStatus(status) {
  selectedStatus = status;
  $('btnAttending').classList.toggle('selected', status === 'attending');
  $('btnDeclined').classList.toggle('selected', status === 'declined');
  const attending = status === 'attending';
  $('timeslotCard').classList.toggle('hidden', !attending);
  $('guestCard').classList.toggle('hidden', !attending);
  $('submitCard').classList.remove('hidden');
  if (attending) renderTimeslots();
}

// Slot counts EXCLUDING this family (so editing never blocks your own seat)
function computeSlotCountsExclude(excludeFamId) {
  const counts = {};
  Object.keys(timeslots).forEach(sid => { counts[sid] = { students: 0 }; });
  Object.entries(families).forEach(([fid, fam]) => {
    if (fid === excludeFamId) return;
    const rsvp = fam.rsvp;
    if (!rsvp || rsvp.status !== 'attending') return;
    const memberIds = fam.memberHonoreeIds || [];
    if (rsvp.sameTimeslot && rsvp.sharedSlotId) {
      if (counts[rsvp.sharedSlotId]) counts[rsvp.sharedSlotId].students += memberIds.length;
    } else if (rsvp.perStudentSlots) {
      memberIds.forEach(mid => {
        const sid = rsvp.perStudentSlots[mid];
        if (sid && counts[sid]) counts[sid].students += 1;
      });
    }
  });
  return counts;
}

function renderTimeslots() {
  const container = $('timeslotList');
  container.innerHTML = '';
  const memberKeys = portal.members || [];
  const slotCounts = computeSlotCountsExclude(familyId);
  const sorted = Object.entries(timeslots)
    .filter(([_, s]) => s.isEnabled !== false)
    .sort((a, b) => (a[1].start || '').localeCompare(b[1].start || ''));

  const buildOption = (slotId, slot, onSelect, isSelected) => {
    const count = slotCounts[slotId]?.students || 0;
    const isFull = count >= (slot.capacity || 30);
    const div = document.createElement('div');
    div.className = `timeslot-option ${isFull ? 'disabled' : ''} ${isSelected ? 'selected' : ''}`;
    div.innerHTML = `
      <span class="slot-time">${slot.start} – ${slot.end}</span>
      <span class="slot-count">${count}/${slot.capacity || 30}</span>
      ${isFull ? `<span class="full-badge">${t('inv.full', 'FULL')}</span>` : ''}`;
    if (!isFull) div.addEventListener('click', onSelect);
    return div;
  };

  if (slotMode === 'same') {
    sorted.forEach(([slotId, slot]) => {
      container.appendChild(buildOption(slotId, slot, () => {
        selectedSlots = { shared: slotId };
        renderTimeslots();
      }, selectedSlots.shared === slotId));
    });
  } else {
    memberKeys.forEach(key => {
      const h = honorees[key];
      if (!h) return;
      const label = document.createElement('div');
      label.innerHTML = `<p class="slot-student-label">${h.nameCn || h.nameEn}</p>`;
      sorted.forEach(([slotId, slot]) => {
        label.appendChild(buildOption(slotId, slot, () => {
          selectedSlots[key] = slotId;
          renderTimeslots();
        }, selectedSlots[key] === slotId));
      });
      container.appendChild(label);
    });
  }
}

async function submitRSVP() {
  if (!selectedStatus) return showToast(t('toast.chooseStatus', 'Please choose whether you will attend'), 'error');
  const memberKeys = portal.members || [];
  const rsvp = { status: selectedStatus, submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

  if (selectedStatus === 'attending') {
    const counts = computeSlotCountsExclude(familyId);
    if (slotMode === 'same') {
      if (!selectedSlots.shared) return showToast(t('toast.chooseSlot', 'Please select a timeslot'), 'error');
      const slot = timeslots[selectedSlots.shared];
      if ((counts[selectedSlots.shared]?.students || 0) + memberKeys.length > (slot?.capacity || 30)) {
        return showToast(`${slot.start}–${slot.end} ${t('toast.slotFullNow', 'is now full. Please choose another.')}`, 'error');
      }
      rsvp.sameTimeslot = true;
      rsvp.sharedSlotId = selectedSlots.shared;
    } else {
      const missing = memberKeys.filter(key => !selectedSlots[key]);
      if (missing.length) return showToast(t('toast.eachSlot', 'Please select a timeslot for each student'), 'error');
      const perSlot = {};
      memberKeys.forEach(key => { perSlot[selectedSlots[key]] = (perSlot[selectedSlots[key]] || 0) + 1; });
      for (const [sid, add] of Object.entries(perSlot)) {
        const slot = timeslots[sid];
        if ((counts[sid]?.students || 0) + add > (slot?.capacity || 30)) {
          return showToast(`${slot.start}–${slot.end} ${t('toast.slotFullNow', 'is now full. Please choose another.')}`, 'error');
        }
      }
      rsvp.sameTimeslot = false;
      rsvp.perStudentSlots = { ...selectedSlots };
    }
    rsvp.guests = {
      mom: $('guestMom').checked, dad: $('guestDad').checked,
      grandma: $('guestGrandma').checked, grandpa: $('guestGrandpa').checked,
      siblings: parseInt($('guestSiblings').value) || 0,
      others: parseInt($('guestOthers').value) || 0
    };
  }

  const btn = $('submitRsvpBtn');
  btn.disabled = true;
  try {
    await update(ref(db, `ashrEvents/${eventId}/families/${familyId}`), {
      memberHonoreeIds: memberKeys,
      rsvp
    });
    showToast(t('toast.rsvpOk', 'RSVP submitted successfully!'), 'success');
    isEditing = false;
    renderConfirmation();
  } catch (err) {
    console.error(err);
    showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error');
  } finally { btn.disabled = false; }
}

function renderConfirmation() {
  $('rsvpCard').classList.add('hidden');
  $('timeslotCard').classList.add('hidden');
  $('guestCard').classList.add('hidden');
  $('submitCard').classList.add('hidden');
  $('confirmationCard').classList.remove('hidden');

  const rsvp = familyData?.rsvp;
  if (!rsvp) return;
  let details = `<p><strong>${t('inv.statusWord', 'Status')}:</strong> ${rsvp.status === 'attending' ? '✅ ' + t('st.attending', 'Attending') : '❌ ' + t('st.declined', 'Declined')}</p>`;
  if (rsvp.status === 'attending') {
    if (rsvp.sameTimeslot && rsvp.sharedSlotId) {
      const slot = timeslots[rsvp.sharedSlotId];
      details += `<p><strong>${t('inv.timeslotsWord', 'Timeslot(s)')}:</strong> ${slot ? `${slot.start} – ${slot.end}` : rsvp.sharedSlotId}</p>`;
    } else if (rsvp.perStudentSlots) {
      details += `<p><strong>${t('inv.timeslotsWord', 'Timeslot(s)')}:</strong></p><ul>`;
      Object.entries(rsvp.perStudentSlots).forEach(([key, slotId]) => {
        const h = honorees[key];
        const slot = timeslots[slotId];
        details += `<li>${h?.nameCn || h?.nameEn || key}: ${slot ? `${slot.start} – ${slot.end}` : slotId}</li>`;
      });
      details += '</ul>';
    }
    const g = rsvp.guests || {};
    const guestCount = (g.mom ? 1 : 0) + (g.dad ? 1 : 0) + (g.grandma ? 1 : 0) + (g.grandpa ? 1 : 0) + (g.siblings || 0) + (g.others || 0);
    details += `<p><strong>${t('inv.guestsWord', 'Guests')}:</strong> ${guestCount}</p>`;
  }
  details += `<p><strong>${t('inv.submittedWord', 'Submitted')}:</strong> ${new Date(rsvp.submittedAt).toLocaleString()}</p>`;
  $('confirmationDetails').innerHTML = details;
  $('editRsvpBtn').classList.toggle('hidden', deadlinePassed);
}

function startEditing() {
  const rsvp = familyData?.rsvp;
  if (!rsvp) return;
  isEditing = true;
  selectedStatus = rsvp.status;
  $('confirmationCard').classList.add('hidden');
  $('rsvpCard').classList.remove('hidden');
  $('btnAttending').classList.toggle('selected', rsvp.status === 'attending');
  $('btnDeclined').classList.toggle('selected', rsvp.status === 'declined');
  if (rsvp.status === 'attending') {
    $('timeslotCard').classList.remove('hidden');
    $('guestCard').classList.remove('hidden');
    $('submitCard').classList.remove('hidden');
    slotMode = rsvp.sameTimeslot ? 'same' : 'separate';
    const radio = document.querySelector(`input[name="slotMode"][value="${slotMode}"]`);
    if (radio) radio.checked = true;
    selectedSlots = rsvp.sameTimeslot ? { shared: rsvp.sharedSlotId } : { ...(rsvp.perStudentSlots || {}) };
    if (rsvp.guests) {
      $('guestMom').checked = !!rsvp.guests.mom;
      $('guestDad').checked = !!rsvp.guests.dad;
      $('guestGrandma').checked = !!rsvp.guests.grandma;
      $('guestGrandpa').checked = !!rsvp.guests.grandpa;
      $('guestSiblings').value = rsvp.guests.siblings || 0;
      $('guestOthers').value = rsvp.guests.others || 0;
    }
    renderTimeslots();
  } else {
    $('submitCard').classList.remove('hidden');
  }
}

let toastTimer = null;
function showToast(msg, type = 'success') {
  const toast = $('toast');
  toast.textContent = msg;
  toast.className = `invite-toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}