import { auth, db } from './auth.js';
import { ref, get, set, update, remove, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t as tCore, applyI18n } from './ashr-i18n.js';

// Fallback-safe translator (same pattern as student-form.js)
const t = (key, fallback) => { const v = tCore(key); return (v && v !== key) ? v : fallback; };
await i18nReady.catch(() => {});

// ============================================
// STATE
// ============================================
let currentEventId = localStorage.getItem('ashr_eventId') || '2026';
let eventSettings = {};
let timeslots = {};
let honorees = {};
let families = {};
let checkins = {};
let portalsCache = {};
let unmatchedDb = {};
let allCentersData = {};
let allStudentsFlat = [];
let editingSlotId = null;
let selectedManualStudent = null;
let editingHonoreeKey = null;
let unmatchedEditKey = null;
let umSelectedStudent = null;
let unsubscribers = [];
let html5QrCode = null;
let cameraActive = false;

const $ = (id) => document.getElementById(id);

// ============================================
// 🥇 MEDAL RULES
//   1★ Bronze, 2★ Silver, 3★+ Gold  (Math / Chinese / ERP)
//   EFL exists ONLY at 3★+ (no bronze/silver) → EFL <3★ rows are not awards
// ============================================
function tierFor(stars) { return stars >= 3 ? 'Gold' : stars === 2 ? 'Silver' : 'Bronze'; }
function medalFor(tier) { return tier === 'Gold' ? '🥇' : tier === 'Silver' ? '🥈' : tier === 'Bronze' ? '🥉' : ''; }

// Set to true if ONLY Gold (3★+) students should receive family invitations.
// false = every imported honoree (Bronze/Silver/Gold) gets an invitation.
const INVITE_REQUIRES_GOLD = false;
function isInvitable(h) {
  if (!INVITE_REQUIRES_GOLD) return true;
  return (h.awards || []).some(a => (a.stars || 0) >= 3);
}

function safeKey(...parts) { return parts.join(' ').replace(/[.#$\[\]]/g, ' '); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ✅ IMPORT RULES: Math 1–5 | Chinese 1–5 | ERP 1–5 | EFL 3–5 | others skipped
function subjectRule(subject) {
  const s = String(subject || '').trim().toLowerCase();
  if (s.includes('efl')) return { canon: 'EFL', minStars: 3 };
  if (s.includes('erp') || s === 'english') return { canon: 'ERP', minStars: 1 };
  if (s.includes('chinese')) return { canon: 'Chinese', minStars: 1 };
  if (s.includes('math')) return { canon: 'Math', minStars: 1 };
  return null;
}

// ============================================
// 🎟️ CARD HELPERS (bilingual card, PNG-safe images)
// ============================================
// ✅ Event display name — always prefixed with "Kumon"
function eventDisplayName() {
  const base = String(eventSettings.eventName || `ASHR ${currentEventId}`).trim();
  return /^kumon\b/i.test(base) ? base : `Kumon ${base}`;
}

// ✅ Compact CODE128 payload: 8 chars → crisp at width:3
function shortScanCode(value) {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  return 'K' + h.toString(36).toUpperCase().padStart(7, '0');
}

// ✅ Render a barcode to a PNG data-URL (export/print-safe <img>)
function barcodeDataUrl(value, opts = {}) {
  if (typeof JsBarcode === 'undefined' || !value) return '';
  const canvas = document.createElement('canvas');
  try {
    JsBarcode(canvas, value, Object.assign({
      format: 'CODE128', displayValue: true, fontSize: 14, margin: 8,
      height: 70, width: 3, background: '#ffffff', lineColor: '#000000' // width bumped to 3 for crispness
    }, opts));
    return canvas.toDataURL('image/png');
  } catch (err) { console.error('Barcode render error:', err); return ''; }
}

// ✅ QR → PNG data-URL via node-qrcode (no DOM canvas = no blank QR)
// ✅ Paint a QR matrix ourselves (qrcode-generator lib) → guaranteed pixels, no DOM quirks
function drawQrMatrixToDataUrl(text, px) {
  if (typeof qrcode !== 'function') return '';
  const qr = qrcode(0, 'M');          // 0 = auto-size version
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const margin = 4;                    // quiet zone
  const scale = Math.max(2, Math.floor(px / (n + margin * 2)));
  const size = (n + margin * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
  return canvas.toDataURL('image/png');
}

// ✅ QR → PNG data-URL. Chain: qrcode-generator → node-qrcode → davidshimjs. Never throws.
async function qrDataUrl(text, size = 280) {
  try {
    const viaMatrix = drawQrMatrixToDataUrl(text, size);
    if (viaMatrix) return viaMatrix;
    if (typeof QRCode !== 'undefined' && typeof QRCode.toDataURL === 'function') {
      const du = await QRCode.toDataURL(text, { width: size, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
      if (du && du.length > 500) return du;
    }
    if (typeof QRCode === 'function') {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(host);
      try {
        new QRCode(host, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
        const c = host.querySelector('canvas');
        if (c) { const du = c.toDataURL('image/png'); if (du && du.length > 500) return du; }
        const im = host.querySelector('img');
        if (im && im.src && im.src.startsWith('data:')) return im.src;
      } finally { host.remove(); }
    }
  } catch (err) { console.error('QR render error:', err); }
  return '';
}

function loadImg(src) {
  return new Promise((res, rej) => {
    if (!src) return rej(new Error('Empty image source'));
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Image failed to load'));
    i.src = src;
  });
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
const CARD_FONT = "'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif";

// Shared timeslot text for a family (used by card + print window)
function familyTimeText(fam) {
  const famId = Object.keys(families).find(fid =>
    (families[fid].memberHonoreeIds || []).some(mid => fam.members.some(m => m.honoreeKey === mid))
  );
  const rsvp = famId ? families[famId]?.rsvp : null;
  if (rsvp?.status === 'attending' && rsvp.sameTimeslot && rsvp.sharedSlotId) {
    const slot = timeslots[rsvp.sharedSlotId];
    return slot ? `${slot.start} – ${slot.end}` : rsvp.sharedSlotId;
  }
  return '—';
}

// ============================================
// INIT
// ============================================
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'index.html'; return; }
  applyI18n();
  applyPlaceholders();
  await loadAllCenters();
  await loadEventList();
  setupTabs();
  setupControlPanel();
  setupHonorees();
  setupLinks();
  setupRSVPs();
  setupCheckin();
  subscribeToEvent(currentEventId);
  $('page-loader').classList.add('hidden');
  $('mainContent').style.display = 'block';
});

function refreshAllDynamic() {
  renderControlPanel();
  updateEventStatus();
  renderTimeslots();
  renderHonorees();
  renderUnmatched();
  renderLinks();
  renderRSVPs();
  renderSlotCapacity();
  renderCheckinSlots();
}

// ============================================
// DATA LOADING
// ============================================
async function loadAllCenters() {
  try {
    const snap = await get(ref(db, 'centers'));
    allCentersData = {};
    allStudentsFlat = [];
    if (snap.exists()) {
      snap.forEach(c => {
        const v = c.val() || {};
        allCentersData[c.key] = {
          name: v.name || c.key,
          students: v.students || {},
          studentSiblingLinks: v.studentSiblingLinks || {}
        };
        Object.entries(v.students || {}).forEach(([sid, s]) => {
          allStudentsFlat.push({ id: sid, centerId: c.key, centerName: v.name || c.key, ...s });
        });
      });
    }
  } catch (err) { console.error('Failed to load centers:', err); }
}

async function loadEventList() {
  const snap = await get(ref(db, 'ashrEvents'));
  const select = $('eventSelect');
  select.innerHTML = '';
  if (snap.exists()) {
    Object.keys(snap.val()).sort().reverse().forEach(eid => {
      const opt = document.createElement('option');
      opt.value = eid; opt.textContent = eid;
      if (eid === currentEventId) opt.selected = true;
      select.appendChild(opt);
    });
  }
  if (!select.options.length) {
    const opt = document.createElement('option');
    opt.value = currentEventId; opt.textContent = currentEventId;
    select.appendChild(opt);
  }
  select.onchange = (e) => {
    currentEventId = e.target.value;
    localStorage.setItem('ashr_eventId', currentEventId);
    subscribeToEvent(currentEventId);
  };
  $('newEventBtn').onclick = () => {
    const year = prompt('Enter event year/ID (e.g. 2027):');
    if (year && year.trim()) {
      currentEventId = year.trim();
      localStorage.setItem('ashr_eventId', currentEventId);
      loadEventList();
      subscribeToEvent(currentEventId);
    }
  };
}

// ============================================
// REALTIME SUBSCRIPTIONS
// ============================================
function subscribeToEvent(eventId) {
  unsubscribers.forEach(fn => fn());
  unsubscribers = [];
  const base = `ashrEvents/${eventId}`;
  const subs = [
    { path: `${base}/settings`, handler: (snap) => { eventSettings = snap.val() || {}; renderControlPanel(); updateEventStatus(); } },
    { path: `${base}/timeslots`, handler: (snap) => { timeslots = snap.val() || {}; renderTimeslots(); renderSlotCapacity(); renderCheckinSlots(); } },
    { path: `${base}/honorees`, handler: (snap) => { honorees = snap.val() || {}; renderHonorees(); renderLinks(); renderCheckinSlots(); } },
    { path: `${base}/families`, handler: (snap) => { families = snap.val() || {}; renderLinks(); renderRSVPs(); renderSlotCapacity(); renderCheckinSlots(); } },
    { path: `${base}/checkins`, handler: (snap) => { checkins = snap.val() || {}; renderCheckinSlots(); } },
    { path: `${base}/unmatched`, handler: (snap) => { unmatchedDb = snap.val() || {}; renderUnmatched(); } },
    { path: `publicAshrLinks/${currentEventId}`, handler: (snap) => { portalsCache = {}; if (snap.exists()) snap.forEach(c => { portalsCache[c.key] = c.val(); }); renderLinks(); } },
  ];
  subs.forEach(({ path, handler }) => {
    const unsub = onValue(ref(db, path), handler, (err) => console.error(`Listener error on ${path}:`, err));
    unsubscribers.push(() => unsub());
  });
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'checkin') $('scanInput').focus();
    });
  });
}

// ============================================
// CONTROL PANEL
// ============================================
function setupControlPanel() {
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('addSlotBtn').addEventListener('click', addTimeslot);
}

function renderControlPanel() {
  $('setEventName').value = eventSettings.eventName || '';
  $('setEventDate').value = eventSettings.eventDate || '';
  $('setVenue').value = eventSettings.venue || '';
  $('setRsvpDeadline').value = eventSettings.rsvpDeadline || '';
  $('setDefaultCapacity').value = eventSettings.defaultCapacity || 30;
  $('setIsActive').value = String(eventSettings.isActive !== false);
}

function updateEventStatus() {
  const badge = $('eventStatusBadge');
  if (eventSettings.isActive !== false) {
    badge.textContent = `● ${t('st.active', 'Active')}`;
    badge.className = 'event-status active';
  } else {
    badge.textContent = `● ${t('st.inactive', 'Inactive')}`;
    badge.className = 'event-status inactive';
  }
}

async function saveSettings() {
  const settings = {
    eventName: $('setEventName').value.trim(),
    eventDate: $('setEventDate').value,
    venue: $('setVenue').value.trim(),
    rsvpDeadline: $('setRsvpDeadline').value,
    defaultCapacity: parseInt($('setDefaultCapacity').value) || 30,
    isActive: $('setIsActive').value === 'true',
    updatedAt: new Date().toISOString()
  };
  try {
    await update(ref(db, `ashrEvents/${currentEventId}/settings`), settings);
    showToast(t('toast.settings', 'Settings saved!'), 'success');
  } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

function renderTimeslots() {
  const list = $('timeslotList');
  list.innerHTML = '';
  const sorted = Object.entries(timeslots).sort((a, b) => (a[1].start || '').localeCompare(b[1].start || ''));
  if (!sorted.length) list.innerHTML = '<p class="hint">—</p>';
  sorted.forEach(([slotId, slot]) => {
    const div = document.createElement('div');
    if (editingSlotId === slotId) {
      div.className = 'timeslot-item editing';
      div.innerHTML = `
        <input type="time" class="edit-start" value="${escapeHtml(slot.start || '')}">
        <span>–</span>
        <input type="time" class="edit-end" value="${escapeHtml(slot.end || '')}">
        <input type="number" class="edit-cap" min="1" value="${slot.capacity || 30}" style="width:80px;">
        <div class="slot-actions">
          <button class="btn-small primary" data-slot-action="save-edit" data-slot-id="${slotId}">${t('common.save', '💾 Save')}</button>
          <button class="btn-small secondary" data-slot-action="cancel-edit" data-slot-id="${slotId}">${t('common.cancel', '✖')}</button>
        </div>`;
    } else {
      div.className = `timeslot-item ${slot.isEnabled === false ? 'disabled' : ''}`;
      div.innerHTML = `
        <span class="slot-time">${escapeHtml(slot.start || '--:--')} – ${escapeHtml(slot.end || '--:--')}</span>
        <span class="slot-cap">Cap: ${slot.capacity || 30}</span>
        <div class="slot-actions">
          <button class="btn-small primary" data-slot-action="edit" data-slot-id="${slotId}">${t('common.edit', '✏️ Edit')}</button>
          <button class="btn-small ${slot.isEnabled === false ? 'primary' : 'secondary'}" data-slot-action="toggle" data-slot-id="${slotId}">
            ${slot.isEnabled === false ? t('links.enable', '▶ Enable') : t('links.disable', '⏸ Disable')}
          </button>
          <button class="btn-small danger" data-slot-action="delete" data-slot-id="${slotId}">${t('common.delete', '🗑')}</button>
        </div>`;
    }
    list.appendChild(div);
  });
  list.querySelectorAll('[data-slot-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const slotId = btn.dataset.slotId;
      const action = btn.dataset.slotAction;
      try {
        if (action === 'edit') { editingSlotId = slotId; renderTimeslots(); }
        else if (action === 'cancel-edit') { editingSlotId = null; renderTimeslots(); }
        else if (action === 'save-edit') {
          const row = btn.closest('.timeslot-item');
          const start = row.querySelector('.edit-start').value;
          const end = row.querySelector('.edit-end').value;
          const cap = parseInt(row.querySelector('.edit-cap').value) || 30;
          if (!start || !end) return showToast(t('toast.slotTimes', 'Set start and end times'), 'error');
          if (start >= end) return showToast(t('toast.slotOrder', 'End time must be after start time'), 'error');
          const booked = (computeSlotCounts()[slotId] || {}).students || 0;
          if (cap < booked && !confirm(`⚠️ ${booked} students are already booked in this slot but the new capacity is ${cap}. Continue?`)) return;
          await update(ref(db, `ashrEvents/${currentEventId}/timeslots/${slotId}`), { start, end, capacity: cap });
          editingSlotId = null;
          renderTimeslots();
          renderSlotCapacity();
          renderCheckinSlots();
          showToast(t('toast.slotUpdated', 'Timeslot updated'), 'success');
        }
        else if (action === 'toggle') {
          const current = timeslots[slotId]?.isEnabled !== false;
          await update(ref(db, `ashrEvents/${currentEventId}/timeslots/${slotId}`), { isEnabled: !current });
        }
        else if (action === 'delete') {
          if (confirm('Delete this timeslot? Students booked in it will lose their slot.')) {
            await remove(ref(db, `ashrEvents/${currentEventId}/timeslots/${slotId}`));
          }
        }
      } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
    });
  });
}

async function addTimeslot() {
  const start = $('newSlotStart').value;
  const end = $('newSlotEnd').value;
  const cap = parseInt($('newSlotCap').value) || 30;
  if (!start || !end) return showToast(t('toast.slotTimes', 'Set start and end times'), 'error');
  if (start >= end) return showToast(t('toast.slotOrder', 'End time must be after start time'), 'error');
  const slotId = 'slot_' + Date.now();
  await set(ref(db, `ashrEvents/${currentEventId}/timeslots/${slotId}`), { start, end, capacity: cap, isEnabled: true });
  showToast(t('toast.slotAdded', 'Timeslot added'), 'success');
}

// ============================================
// HONOREES
// ============================================
const TAB_TO_CENTER = { champs: 'champs', mk: 'mei keng', ts: 'tap siac', pt: 'pac tat' };

function setupHonorees() {
  $('importExcelBtn').addEventListener('click', () => $('excelFileInput').click());
  $('excelFileInput').addEventListener('change', handleExcelImport);
  $('clearUnmatchedBtn').addEventListener('click', clearUnmatched);
  $('deleteAllHonoreesBtn').addEventListener('click', deleteAllHonorees);
  $('manualSearchInput').addEventListener('input', handleManualSearch);
  $('manualAddBtn').addEventListener('click', handleManualAdd);
  $('honoreeSearch').addEventListener('input', renderHonorees);
  $('honoreeCenterFilter').addEventListener('change', renderHonorees);
  $('closeEditHonoree').addEventListener('click', () => $('editHonoreeModal').classList.add('hidden'));
  $('cancelEditHonoree').addEventListener('click', () => $('editHonoreeModal').classList.add('hidden'));
  $('addAwardRowBtn').addEventListener('click', () => $('editAwardsList').appendChild(awardEditRow('Math', 3, '')));
  $('saveEditHonoree').addEventListener('click', saveEditHonoree);
  $('closeUnmatchedEdit').addEventListener('click', () => $('unmatchedEditModal').classList.add('hidden'));
  $('umCancelBtn').addEventListener('click', () => $('unmatchedEditModal').classList.add('hidden'));
  $('umSearch').addEventListener('input', umRunSearch);
  $('umSearch').addEventListener('focus', umRunSearch);
  $('umAddAwardBtn').addEventListener('click', () => $('umAwardsList').appendChild(awardEditRow('Math', 3, '')));
  $('umSaveBtn').addEventListener('click', umSave);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.um-search-wrap')) $('umDropdown').classList.add('hidden');
  });
  populateCenterFilter();
}

function populateCenterFilter() {
  const sel = $('honoreeCenterFilter');
  Object.entries(allCentersData).forEach(([cid, c]) => {
    const opt = document.createElement('option');
    opt.value = cid; opt.textContent = c.name;
    sel.appendChild(opt);
  });
}

// ✅ IMPORT — every valid row becomes/updates a honoree (no hiding, no purging)
async function handleExcelImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  $('importProgress').classList.remove('hidden');
  $('importSummary').classList.add('hidden');
  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    let added = 0, updated = 0, skippedLow = 0, skippedSubject = 0, unmatched = 0;
    const work = JSON.parse(JSON.stringify(honorees || {}));
    const unmatchedUpdates = {};
    const totalSheets = wb.SheetNames.length;
    let idx = 0;
    for (const sheetName of wb.SheetNames) {
      idx++;
      $('importStatusText').textContent = `Processing sheet: ${sheetName} (${idx}/${totalSheets})`;
      $('importProgressFill').style.width = `${(idx / totalSheets) * 100}%`;
      const centerKey = TAB_TO_CENTER[String(sheetName).toLowerCase().trim()];
      if (!centerKey) continue;
      const centerId = Object.keys(allCentersData).find(cid =>
        cid.toLowerCase().includes(centerKey) || (allCentersData[cid].name || '').toLowerCase().includes(centerKey)
      );
      if (!centerId) continue;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
      for (const row of rows) {
        const studentNumber = String(row['Student ID'] || '').trim();
        const rawSubject = String(row['Subject'] || '').trim();
        const starsRaw = String(row['ASHR'] || '').trim();
        const reportingMonth = String(row['Reporting Month'] || '').trim();
        const nameAlphabet = String(row['Student Name（Alphabet）'] || row['Student Name (Alphabet)'] || '').trim();
        const nameCn = String(row['Student Name'] || '').trim();
        if (!studentNumber || !rawSubject) continue;
        const rule = subjectRule(rawSubject);
        if (!rule) { skippedSubject++; continue; }
        const starCount = (starsRaw.match(/\*/g) || []).length;
        if (starCount < 1 || starCount > 5) { skippedSubject++; continue; }
        if (starCount < rule.minStars) { skippedLow++; continue; } // EFL <3★ = not an award
        const rowKey = safeKey(sheetName, studentNumber, rawSubject, reportingMonth);
        const student = allStudentsFlat.find(s =>
          s.centerId === centerId && String(s.studentNumber || '').trim() === studentNumber
        );
        if (!student) {
          unmatched++;
          unmatchedUpdates[`ashrEvents/${currentEventId}/unmatched/${rowKey}`] = {
            sheetName, studentNumber, nameAlphabet, nameCn,
            subject: rawSubject, stars: starsRaw, reportingMonth,
            centerGuess: centerId,
            createdAt: new Date().toISOString()
          };
          continue;
        }
        if (unmatchedDb[rowKey]) unmatchedUpdates[`ashrEvents/${currentEventId}/unmatched/${rowKey}`] = null;
        const key = `${centerId}_${studentNumber}`;
        const award = { subject: rule.canon, stars: starCount, tier: tierFor(starCount), reportingMonth };
        let h = work[key];
        if (!h) {
          work[key] = {
            studentId: student.id,
            centerId,
            centerName: allCentersData[centerId]?.name || '',
            nameCn: student.nameCn || nameCn,
            nameEn: student.namePinyin || nameAlphabet,
            studentNumber,
            barcodeValue: `ASHR${currentEventId}_${key}`,
            awards: [award],
            createdAt: new Date().toISOString()
          };
          added++;
        } else {
          const existingAward = (h.awards || []).find(a =>
            (subjectRule(a.subject)?.canon || a.subject) === rule.canon && (a.reportingMonth || '') === reportingMonth
          );
          if (existingAward) {
            existingAward.subject = rule.canon;
            existingAward.stars = starCount;
            existingAward.tier = tierFor(starCount);
            updated++;
          } else {
            h.awards = [...(h.awards || []), award];
            added++;
          }
        }
      }
    }
    const updates = {};
    Object.entries(work).forEach(([k, v]) => { updates[`ashrEvents/${currentEventId}/honorees/${k}`] = v; });
    Object.assign(updates, unmatchedUpdates);
    if (Object.keys(updates).length) await update(ref(db), updates);
    $('importProgress').classList.add('hidden');
    $('importSummary').classList.remove('hidden');
    $('importSummary').innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-value">${added}</div><div class="stat-label">${t('imp.added', 'Added')}</div></div>
        <div class="stat-card"><div class="stat-value">${updated}</div><div class="stat-label">${t('imp.updated', 'Updated')}</div></div>
        <div class="stat-card"><div class="stat-value">${skippedLow}</div><div class="stat-label">${t('imp.skipLow', 'Skipped (EFL <3★)')}</div></div>
        <div class="stat-card"><div class="stat-value">${skippedSubject}</div><div class="stat-label">${t('imp.skipSubject', 'Skipped (subject)')}</div></div>
        <div class="stat-card"><div class="stat-value">${unmatched}</div><div class="stat-label">${t('imp.unmatched', 'Unmatched')}</div></div>
      </div>`;
    showToast(`${t('toast.importDone', 'Import complete')}: +${added}, ↻${updated}`, 'success');
  } catch (err) {
    console.error('Import error:', err);
    showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error');
    $('importProgress').classList.add('hidden');
  }
  e.target.value = '';
}

function renderUnmatched() {
  const list = $('unmatchedList');
  const rows = Object.entries(unmatchedDb || {});
  if (!rows.length) { list.innerHTML = '<p class="hint">—</p>'; return; }
  rows.sort((a, b) =>
    String(a[1].sheetName || '').localeCompare(String(b[1].sheetName || '')) ||
    String(a[1].studentNumber || '').localeCompare(String(b[1].studentNumber || ''))
  );
  list.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr>
      <th>${t('th.sheet', 'Sheet')}</th><th>${t('th.sid', 'Student ID')}</th>
      <th>${t('th.nameEn', 'Name (EN)')}</th><th>${t('th.nameCn', 'Name (CN)')}</th>
      <th>${t('th.subject', 'Subject')}</th><th>${t('th.stars', 'Stars')}</th>
      <th>${t('th.actions', 'Actions')}</th>
    </tr></thead>
    <tbody>${rows.map(([key, r]) => `<tr>
      <td>${escapeHtml(r.sheetName || '')}</td>
      <td>${escapeHtml(r.studentNumber || '')}</td>
      <td>${escapeHtml(r.nameAlphabet || '')}</td>
      <td>${escapeHtml(r.nameCn || '')}</td>
      <td>${escapeHtml(r.subject || '')}</td>
      <td>${escapeHtml(r.stars || '')}</td>
      <td><div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
        <button class="btn-small primary" data-um-edit="${escapeHtml(key)}">${t('um.edit', '✏️ Edit')}</button>
        <button class="btn-small danger" data-um-del="${escapeHtml(key)}">${t('common.delete', '🗑')}</button>
      </div></td>
    </tr>`).join('')}</tbody></table></div>`;
  list.querySelectorAll('[data-um-edit]').forEach(btn => {
    btn.addEventListener('click', () => openUnmatchedEdit(btn.dataset.umEdit));
  });
  list.querySelectorAll('[data-um-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('um.deleteConfirm', 'Remove this unmatched record?'))) return;
      try {
        await remove(ref(db, `ashrEvents/${currentEventId}/unmatched/${btn.dataset.umDel}`));
        showToast(t('um.removed', 'Record removed'), 'success');
      } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
    });
  });
}

async function clearUnmatched() {
  const keys = Object.keys(unmatchedDb || {});
  if (!keys.length) return showToast('Nothing to clear', 'error');
  if (!confirm(t('um.clearConfirm', `Clear all ${keys.length} unmatched record(s)?`))) return;
  const updates = {};
  keys.forEach(k => { updates[`ashrEvents/${currentEventId}/unmatched/${k}`] = null; });
  try {
    await update(ref(db), updates);
    showToast(t('toast.cleared', 'List cleared'), 'success');
  } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

async function deleteAllHonorees() {
  const hCount = Object.keys(honorees).length;
  const fCount = Object.keys(families).length;
  const lCount = Object.keys(portalsCache).length;
  const uCount = Object.keys(unmatchedDb).length;
  if (!hCount && !fCount && !lCount && !uCount) return showToast('Nothing to delete', 'error');
  if (!confirm(`⚠️ Delete ALL ${hCount} honoree(s), ${fCount} family RSVP(s), ${uCount} unmatched record(s), all check-ins and ${lCount} invitation link(s) for event "${currentEventId}"?`)) return;
  if (!confirm('FINAL CONFIRM — this permanently erases all ASHR data for this event. Continue?')) return;
  try {
    const updates = {};
    updates[`ashrEvents/${currentEventId}/honorees`] = null;
    updates[`ashrEvents/${currentEventId}/families`] = null;
    updates[`ashrEvents/${currentEventId}/checkins`] = null;
    updates[`ashrEvents/${currentEventId}/unmatched`] = null;
    updates[`publicAshrLinks/${currentEventId}`] = null;
    await update(ref(db), updates);
    showToast(t('toast.allCleared', 'All ASHR data cleared'), 'success');
  } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

function handleManualSearch(e) {
  const q = e.target.value.trim().toLowerCase();
  const dropdown = $('manualSearchDropdown');
  if (!q) { dropdown.classList.add('hidden'); return; }
  const matches = allStudentsFlat.filter(s => {
    const hay = [s.nameCn, s.namePinyin, s.studentNumber, s.nickname].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }).slice(0, 20);
  dropdown.innerHTML = '';
  if (!matches.length) dropdown.innerHTML = '<div class="result-item" style="color:#999;cursor:default;">No students found</div>';
  else matches.forEach(s => {
    const div = document.createElement('div');
    div.className = 'result-item';
    div.textContent = `${s.nameCn || s.namePinyin} (${s.studentNumber || s.id}) — ${s.centerName}`;
    div.addEventListener('click', () => selectManualStudent(s));
    dropdown.appendChild(div);
  });
  dropdown.classList.remove('hidden');
}

function selectManualStudent(s) {
  selectedManualStudent = s;
  $('manualSearchInput').value = `${s.nameCn || s.namePinyin} (${s.studentNumber || s.id})`;
  $('manualSearchDropdown').classList.add('hidden');
  $('manualAwardForm').classList.remove('hidden');
}

async function handleManualAdd() {
  if (!selectedManualStudent) return showToast(t('toast.selectStudent', 'Select a student first'), 'error');
  const s = selectedManualStudent;
  const subject = $('manualSubject').value;
  const stars = parseInt($('manualStars').value);
  if (subject === 'EFL' && stars < 3) return showToast(t('hon.eflMin', 'EFL requires 3★ or more'), 'error');
  const key = `${s.centerId}_${s.studentNumber || s.id}`;
  const award = { subject, stars, tier: tierFor(stars), reportingMonth: '' };
  try {
    const existing = honorees[key];
    const newAwards = existing ? [...(existing.awards || []), award] : [award];
    if (existing) {
      await update(ref(db, `ashrEvents/${currentEventId}/honorees/${key}`), { awards: newAwards });
    } else {
      await set(ref(db, `ashrEvents/${currentEventId}/honorees/${key}`), {
        studentId: s.id, centerId: s.centerId, centerName: s.centerName,
        nameCn: s.nameCn || '', nameEn: s.namePinyin || '',
        studentNumber: s.studentNumber || '',
        barcodeValue: `ASHR${currentEventId}_${key}`,
        awards: newAwards,
        createdAt: new Date().toISOString()
      });
    }
    showToast(t('toast.awardAdded', 'Award added'), 'success');
    selectedManualStudent = null;
    $('manualSearchInput').value = '';
    $('manualAwardForm').classList.add('hidden');
  } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

// ✅ LIST = every imported honoree, with their medal(s)
function renderHonorees() {
  const search = ($('honoreeSearch').value || '').toLowerCase();
  const centerFilter = $('honoreeCenterFilter').value;
  const tbody = $('honoreeTableBody');
  tbody.innerHTML = '';
  const entries = Object.entries(honorees).filter(([key, h]) => {
    if (centerFilter && h.centerId !== centerFilter) return false;
    if (search) {
      const hay = [h.nameCn, h.nameEn, h.studentNumber].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
  $('honoreeCount').textContent = entries.length;
  entries.forEach(([key, h]) => {
    const awardsHtml = (h.awards || []).map(a =>
      `<span class="award-badge award-${(a.tier || 'bronze').toLowerCase()}">${medalFor(a.tier)} ${escapeHtml(a.subject)} ${'★'.repeat(a.stars || 0)}</span>`
    ).join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(h.nameCn || h.nameEn || '')}</strong><br><small>${escapeHtml(h.nameEn || '')}</small></td>
      <td>${escapeHtml(h.centerName || '')}</td>
      <td>${awardsHtml}</td>
      <td><div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
        <button class="btn-small primary" data-edit-honoree="${escapeHtml(key)}">${t('hon.edit', '✏️ Edit')}</button>
        <button class="btn-small danger" data-del-honoree="${escapeHtml(key)}">${t('common.delete', '🗑')}</button>
      </div></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('[data-edit-honoree]').forEach(btn => {
    btn.addEventListener('click', () => openEditHonoree(btn.dataset.editHonoree));
  });
  tbody.querySelectorAll('[data-del-honoree]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('Remove this honoree?')) {
        await remove(ref(db, `ashrEvents/${currentEventId}/honorees/${btn.dataset.delHonoree}`));
      }
    });
  });
}

// ============================================
// ✏️ EDIT HONOREE MODAL (barcode lives on the Card now)
// ============================================
function awardEditRow(subject, stars, reportingMonth) {
  const div = document.createElement('div');
  div.className = 'award-edit-row';
  div.dataset.rm = reportingMonth || '';
  div.innerHTML = `
    <select class="ae-subject">
      ${['Math', 'Chinese', 'EFL', 'ERP'].map(s => `<option value="${s}" ${s === subject ? 'selected' : ''}>${s}</option>`).join('')}
    </select>
    <select class="ae-stars">
      ${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${Number(n) === Number(stars) ? 'selected' : ''}>${'★'.repeat(n)}</option>`).join('')}
    </select>
    <button type="button" class="btn-small danger ae-del">${t('common.delete', '🗑')}</button>`;
  div.querySelector('.ae-del').addEventListener('click', () => div.remove());
  return div;
}

function openEditHonoree(key) {
  const h = honorees[key];
  if (!h) return;
  editingHonoreeKey = key;
  $('editHonoreeName').textContent = `${h.nameCn || h.nameEn || ''} (${h.studentNumber || ''}) — ${h.centerName || ''}`;
  const list = $('editAwardsList');
  list.innerHTML = '';
  (h.awards || []).forEach(a => list.appendChild(awardEditRow(a.subject, a.stars, a.reportingMonth)));
  if (!list.children.length) list.appendChild(awardEditRow('Math', 3, ''));
  $('editHonoreeModal').classList.remove('hidden');
}

async function saveEditHonoree() {
  const rows = [...$('editAwardsList').querySelectorAll('.award-edit-row')];
  const awards = [];
  for (const row of rows) {
    const subject = row.querySelector('.ae-subject').value;
    const stars = parseInt(row.querySelector('.ae-stars').value, 10);
    if (subject === 'EFL' && stars < 3) return showToast(t('hon.eflMin', 'EFL requires 3★ or more'), 'error');
    const rm = row.dataset.rm || '';
    const dup = awards.find(a => a.subject === subject && (a.reportingMonth || '') === rm);
    if (dup) { dup.stars = Math.max(dup.stars, stars); dup.tier = tierFor(dup.stars); }
    else awards.push({ subject, stars, tier: tierFor(stars), reportingMonth: rm });
  }
  if (!awards.length) return showToast(t('hon.needAward', 'Add at least one award'), 'error');
  const key = editingHonoreeKey;
  try {
    await update(ref(db, `ashrEvents/${currentEventId}/honorees/${key}`), { awards });
    showToast(t('hon.updated', 'Updated!'), 'success');
    $('editHonoreeModal').classList.add('hidden');
  } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

// ============================================
// ✅ RESOLVE UNMATCHED MODAL
// ============================================
function populateUmCenters(selectedId) {
  const sel = $('umCenter');
  sel.innerHTML = '';
  Object.entries(allCentersData).forEach(([cid, c]) => {
    const opt = document.createElement('option');
    opt.value = cid; opt.textContent = c.name;
    if (cid === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function openUnmatchedEdit(key) {
  const r = unmatchedDb[key];
  if (!r) return;
  unmatchedEditKey = key;
  umSelectedStudent = null;
  $('umSelectedInfo').classList.add('hidden');
  $('umSearch').value = '';
  $('umDropdown').classList.add('hidden');
  populateUmCenters(r.centerGuess || Object.keys(allCentersData)[0] || '');
  const list = $('umAwardsList');
  list.innerHTML = '';
  const rule = subjectRule(r.subject);
  const starCount = Math.min(5, Math.max(1, (String(r.stars || '').match(/\*/g) || []).length || 3));
  list.appendChild(awardEditRow(rule ? rule.canon : 'Math', starCount, r.reportingMonth || ''));
  $('unmatchedEditModal').classList.remove('hidden');
  setTimeout(() => $('umSearch').focus(), 100);
}

function umRunSearch() {
  const q = $('umSearch').value.trim().toLowerCase();
  const dd = $('umDropdown');
  if (!q) { dd.classList.add('hidden'); return; }
  const preferredCenter = $('umCenter').value;
  const matches = allStudentsFlat.filter(s => {
    const hay = [s.nameCn, s.namePinyin, s.studentNumber].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }).sort((a, b) => (a.centerId === preferredCenter ? 0 : 1) - (b.centerId === preferredCenter ? 0 : 1)).slice(0, 20);
  dd.innerHTML = '';
  if (!matches.length) {
    dd.innerHTML = '<div class="result-item" style="color:#999;cursor:default;">No students found</div>';
    dd.classList.remove('hidden');
    return;
  }
  matches.forEach(s => {
    const div = document.createElement('div');
    div.className = 'result-item';
    div.textContent = `${s.nameCn || s.namePinyin} (${s.studentNumber || s.id}) — ${s.centerName}`;
    div.addEventListener('click', () => umSelectStudent(s));
    dd.appendChild(div);
  });
  dd.classList.remove('hidden');
}

function umSelectStudent(s) {
  umSelectedStudent = s;
  $('umSearch').value = `${s.nameCn || s.namePinyin} (${s.studentNumber || s.id})`;
  $('umDropdown').classList.add('hidden');
  $('umCenter').value = s.centerId;
  const info = $('umSelectedInfo');
  info.classList.remove('hidden');
  info.innerHTML = `✅ <strong>${escapeHtml(s.nameCn || s.namePinyin || '')}</strong> · ${escapeHtml(s.centerName || '')} · #${escapeHtml(s.studentNumber || s.id)}`;
}

async function umSave() {
  if (!umSelectedStudent) return showToast(t('um.selectStudent', '⚠️ Please select a student from the database search.'), 'error');
  const rows = [...$('umAwardsList').querySelectorAll('.award-edit-row')];
  const awards = [];
  for (const row of rows) {
    const subject = row.querySelector('.ae-subject').value;
    const stars = parseInt(row.querySelector('.ae-stars').value, 10);
    if (subject === 'EFL' && stars < 3) return showToast(t('hon.eflMin', 'EFL requires 3★ or more'), 'error');
    const rm = row.dataset.rm || '';
    const dup = awards.find(a => a.subject === subject && (a.reportingMonth || '') === rm);
    if (dup) { dup.stars = Math.max(dup.stars, stars); dup.tier = tierFor(dup.stars); }
    else awards.push({ subject, stars, tier: tierFor(stars), reportingMonth: rm });
  }
  if (!awards.length) return showToast(t('hon.needAward', 'Add at least one award'), 'error');
  const s = umSelectedStudent;
  const centerId = $('umCenter').value || s.centerId;
  const key = `${centerId}_${s.studentNumber || s.id}`;
  try {
    const existing = honorees[key];
    if (existing) {
      const merged = [...(existing.awards || [])];
      awards.forEach(a => {
        const ex = merged.find(m => m.subject === a.subject && (m.reportingMonth || '') === (a.reportingMonth || ''));
        if (ex) { ex.stars = a.stars; ex.tier = a.tier; } else merged.push(a);
      });
      await update(ref(db, `ashrEvents/${currentEventId}/honorees/${key}`), {
        awards: merged,
        centerId,
        centerName: allCentersData[centerId]?.name || ''
      });
    } else {
      await set(ref(db, `ashrEvents/${currentEventId}/honorees/${key}`), {
        studentId: s.id, centerId, centerName: allCentersData[centerId]?.name || '',
        nameCn: s.nameCn || '', nameEn: s.namePinyin || '', studentNumber: s.studentNumber || '',
        barcodeValue: `ASHR${currentEventId}_${key}`,
        awards,
        createdAt: new Date().toISOString()
      });
    }
    await remove(ref(db, `ashrEvents/${currentEventId}/unmatched/${unmatchedEditKey}`));
    $('unmatchedEditModal').classList.add('hidden');
    showToast(t('um.saved', '✅ Added to honorees!'), 'success');
  } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

// ============================================
// LINKS — families from student-form sibling links
// ============================================
function setupLinks() {
  $('linkSearch').addEventListener('input', renderLinks);
  $('linkFilter').addEventListener('change', renderLinks);
  $('generateAllLinksBtn').addEventListener('click', generateAllMissingLinks);
  $('printAllCardsBtn').addEventListener('click', printAllCards);
  $('closeLinkCard').addEventListener('click', () => $('linkCardModal').classList.add('hidden'));
}

function buildAshrFamilies() {
  const invitableEntries = Object.entries(honorees).filter(([_, h]) => isInvitable(h));
  const adj = {};
  Object.entries(allCentersData).forEach(([cid, c]) => {
    Object.entries(c.studentSiblingLinks || {}).forEach(([sid, sibs]) => {
      Object.entries(sibs || {}).forEach(([sibId, v]) => {
        const sc = (v && v.siblingCenterId) || cid;
        const a = `${cid}/${sid}`, b = `${sc}/${sibId}`;
        (adj[a] = adj[a] || new Set()).add(b);
        (adj[b] = adj[b] || new Set()).add(a);
      });
    });
  });
  const honoreeKeys = new Set(invitableEntries.map(([_, h]) => `${h.centerId}/${h.studentId}`));
  const seen = new Set();
  const familyGroups = [];
  invitableEntries.forEach(([honoreeKey, h]) => {
    const node = `${h.centerId}/${h.studentId}`;
    if (seen.has(node)) return;
    const comp = [];
    const q = [node];
    seen.add(node);
    while (q.length) {
      const n = q.shift();
      comp.push(n);
      (adj[n] || new Set()).forEach(m => { if (!seen.has(m)) { seen.add(m); q.push(m); } });
    }
    const famKeys = comp.filter(k => honoreeKeys.has(k));
    if (!famKeys.length) return;
    const members = famKeys.map(k => {
      const [cid, sid] = k.split('/');
      const entry = invitableEntries.find(([_, hh]) => hh.centerId === cid && hh.studentId === sid);
      return entry ? { honoreeKey: entry[0], ...entry[1] } : null;
    }).filter(Boolean);
    familyGroups.push({ key: members.map(m => m.honoreeKey).sort().join('|'), members });
  });
  return familyGroups;
}

function renderLinks() {
  const familyGroups = buildAshrFamilies();
  const search = ($('linkSearch').value || '').toLowerCase();
  const filter = $('linkFilter').value;
  const tbody = $('linkTableBody');
  tbody.innerHTML = '';
  familyGroups.forEach(fam => {
    const portalEntry = Object.entries(portalsCache).find(([_, p]) => p.familyKey === fam.key);
    const portal = portalEntry ? portalEntry[1] : null;
    const hasLink = !!portal;
    const isDisabled = portal && portal.active === false;
    if (filter === 'hasLink' && !hasLink) return;
    if (filter === 'noLink' && hasLink) return;
    if (filter === 'disabled' && !isDisabled) return;
    if (search) {
      const hay = fam.members.flatMap(m => [m.nameCn, m.nameEn]).filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return;
    }
    const names = fam.members.map(m => m.nameCn || m.nameEn).join(', ');
    const statusHtml = !hasLink
      ? `<span class="status-badge st-pending">${t('st.noLink', 'No Link')}</span>`
      : isDisabled
        ? `<span class="status-badge st-declined">${t('st.disabled', 'Disabled')}</span>`
        : `<span class="status-badge st-attending">${t('st.active', 'Active')}</span>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(names)}</strong></td>
      <td>${fam.members.length}</td>
      <td>${statusHtml}</td>
      <td><div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
        ${hasLink ? `<button class="btn-small primary" data-link-action="card" data-fam-key="${escapeHtml(fam.key)}">${t('links.card', '📇 Card')}</button>` : ''}
        <button class="btn-small ${hasLink ? 'secondary' : 'primary'}" data-link-action="gen" data-fam-key="${escapeHtml(fam.key)}">
          ${hasLink ? t('links.regen', '♻️ Regen') : t('links.gen', '✨ Generate')}
        </button>
        ${hasLink ? `<button class="btn-small secondary" data-link-action="toggle" data-fam-key="${escapeHtml(fam.key)}">
          ${isDisabled ? t('links.enable', '▶ Enable') : t('links.disable', '⏸ Disable')}
        </button>` : ''}
      </div></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('[data-link-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const famKey = btn.dataset.famKey;
      const fam = buildAshrFamilies().find(f => f.key === famKey);
      if (!fam) return;
      if (btn.dataset.linkAction === 'gen') await generateFamilyLink(fam);
      else if (btn.dataset.linkAction === 'toggle') await toggleFamilyLink(fam);
      else if (btn.dataset.linkAction === 'card') openLinkCard(fam);
    });
  });
}

function randomToken(len = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map(x => chars[x % chars.length]).join('');
}

async function generateFamilyLink(fam) {
  const existing = Object.entries(portalsCache).find(([_, p]) => p.familyKey === fam.key);
  const token = randomToken();
  const now = new Date().toISOString();
  try {
    if (existing) {
      if (!confirm('Regenerate link? The old link will be invalidated.')) return;
      const [oldToken, oldPortal] = existing;
      const updates = {};
      updates[`publicAshrLinks/${currentEventId}/${token}`] = {
        familyKey: fam.key, familyId: oldPortal.familyId, active: true, createdAt: now,
        members: fam.members.map(m => m.honoreeKey)
      };
      updates[`publicAshrLinks/${currentEventId}/${oldToken}`] = null;
      await update(ref(db), updates);
    } else {
      await set(ref(db, `publicAshrLinks/${currentEventId}/${token}`), {
        familyKey: fam.key, familyId: 'fam_' + randomToken(8), active: true, createdAt: now,
        members: fam.members.map(m => m.honoreeKey)
      });
    }
    showToast(t('toast.linkGen', 'Link generated'), 'success');
  } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

async function toggleFamilyLink(fam) {
  const entry = Object.entries(portalsCache).find(([_, p]) => p.familyKey === fam.key);
  if (!entry) return;
  const [token, portal] = entry;
  await update(ref(db, `publicAshrLinks/${currentEventId}/${token}`), { active: portal.active === false });
}

async function generateAllMissingLinks() {
  const familyGroups = buildAshrFamilies();
  let count = 0;
  for (const fam of familyGroups) {
    const exists = Object.values(portalsCache).some(p => p.familyKey === fam.key);
    if (!exists) { await generateFamilyLink(fam); count++; }
  }
  showToast(`${count} ${t('toast.linksGen', 'new link(s) generated')}`, 'success');
}

// ============================================
// 📇 INVITATION CARD (bilingual, image-based barcodes/QR)
// ============================================
async function openLinkCard(fam) {
  const entry = Object.entries(portalsCache).find(([_, p]) => p.familyKey === fam.key);
  if (!entry) return;
  const [token] = entry;
  const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}ashr-invite.html?e=${encodeURIComponent(currentEventId)}&t=${encodeURIComponent(token)}`;

  // Header / details (bilingual labels live in the HTML)
  $('icEventName').textContent = eventDisplayName();
  $('icDate').textContent = eventSettings.eventDate ? new Date(eventSettings.eventDate).toLocaleDateString('en-GB') : '—';
  $('icVenue').textContent = eventSettings.venue || '—';
  $('icTime').textContent = familyTimeText(fam);
  $('icFamilyCode').textContent = `FAM-${token.slice(0, 6).toUpperCase()}`;

  // Students + awards
  const studentsDiv = $('icStudents');
  studentsDiv.innerHTML = '';
  fam.members.forEach(m => {
    const div = document.createElement('div');
    div.className = 'inv-student';
    const awardsHtml = (m.awards || []).map(a =>
      `<span class="award-badge award-${(a.tier || 'bronze').toLowerCase()}">${medalFor(a.tier)} ${escapeHtml(a.subject)} ${'★'.repeat(a.stars || 0)}</span>`
    ).join('');
    div.innerHTML = `
      <div class="inv-student-name">${escapeHtml(m.nameCn || m.nameEn || '')}</div>
      <div class="inv-student-center">${escapeHtml(m.centerName || '')} · #${escapeHtml(m.studentNumber || '')}</div>
      <div class="inv-student-awards">${awardsHtml}</div>`;
    studentsDiv.appendChild(div);
  });

  // ✅ Barcodes as PNG <img> (survives export & printing)
  const barcodesDiv = $('icBarcodes');
  barcodesDiv.innerHTML = '';
  fam.members.forEach(m => {
    const value = m.barcodeValue || `ASHR${currentEventId}_${m.honoreeKey}`;
    const dataUrl = barcodeDataUrl(shortScanCode(value)); // ✅ Short code used here
    const item = document.createElement('div');
    item.className = 'inv-barcode-item';
    item.innerHTML = (dataUrl
      ? `<img class="inv-barcode-img" src="${dataUrl}" alt="${escapeHtml(value)}" style="image-rendering: pixelated; width: auto; max-width: 100%; height: auto;">`
      : `<div class="inv-barcode-fallback">${escapeHtml(value)}</div>`) +
      `<div class="inv-barcode-student">${escapeHtml(m.nameCn || m.nameEn || m.studentNumber || '')}</div>`;
    barcodesDiv.appendChild(item);
  });

  // ✅ SHOW THE MODAL FIRST — card appears instantly, even if QR is slow/fails
  $('linkCardModal').classList.remove('hidden');

  // QR filled in asynchronously after the modal is open
  const qrDiv = $('icQr');
  const qrSection = qrDiv.closest('.inv-qr-section');
  const qrUrl = await qrDataUrl(url, 280);
  if (qrSection) qrSection.classList.remove('hidden');
  if (qrUrl) {
    qrDiv.innerHTML = `<img class="inv-qr-img" src="${qrUrl}" alt="RSVP QR">`;
  } else {
    qrDiv.innerHTML = `<div class="inv-qr-missing">⚠️ QR unavailable<br>無法產生QR碼</div>`;
    showToast('QR script failed to load — check the qrcode-generator script tag', 'error');
  }

  // Toolbar actions (no Print button)
  $('lcCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(url); showToast(t('common.copied', 'Copied!'), 'success'); } catch {}
  };
  $('lcWa').onclick = () => {
    const names = fam.members.map(m => m.nameCn || m.nameEn).join(', ');
    window.open(`https://wa.me/?text=${encodeURIComponent(`🏅 ${eventDisplayName()} Invitation for ${names}`)}`, '_blank');
  };
  $('lcDownloadPng').onclick = () => downloadCardAsPng(fam);
}
// ============================================
// 🖼️ PNG EXPORT — manual canvas composition
//     (barcodes + QR are baked in; html2canvas no longer used)
// ============================================
async function downloadCardAsPng(fam) {
  const entry = Object.entries(portalsCache).find(([_, p]) => p.familyKey === fam.key);
  if (!entry) return;
  const [token] = entry;
  const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}ashr-invite.html?e=${encodeURIComponent(currentEventId)}&t=${encodeURIComponent(token)}`;
  try {
    // 1) preload barcode + QR images
    const bcImgs = [];
    for (const m of fam.members) {
      const du = barcodeDataUrl(shortScanCode(m.barcodeValue || `ASHR${currentEventId}_${m.honoreeKey}`)); // ✅ Short code
      bcImgs.push(await loadImg(du));
    }
    let qrImg = null;
    try { qrImg = await loadImg(await qrDataUrl(url, 280)); } catch (e) { qrImg = null; }

    // 2) layout metrics
    const W = 500, pad = 24, secPad = 16;
    const headerH = 104, divH = 6, footerH = 58;
    const studentH = (m) => 74 + ((m.awards || []).length ? 30 : 0);
    const studentsH = 22 + fam.members.reduce((s, m) => s + studentH(m) + 12, 0);
    const detH = 132;
    const iw = W - 2 * pad - 2 * secPad;
    const bcItems = bcImgs.map(img => {
      const bw = Math.min(img.naturalWidth, iw - 32); // ✅ Prevent stretching beyond natural width
      const bh = Math.round(bw * (img.naturalHeight / img.naturalWidth));
      return { bw, bh, itemH: 12 + bh + 24 + 12 };
    });
    const bcH = secPad + 22 + bcItems.reduce((s, it) => s + it.itemH + 12, 0) + secPad;
    const qrH = qrImg ? (secPad * 2 + 22 + 140 + 24) : 0;
    const H = headerH + divH + 24 + studentsH + 4 + detH + 16 + bcH + 16 + qrH + (qrImg ? 24 : 8) + footerH;

    // 3) paint
    const S = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * S; canvas.height = H * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);
    ctx.imageSmoothingEnabled = false; // ✅ Crisp pixel rendering
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);

    let y = 0;
    // header
    const g = ctx.createLinearGradient(0, 0, W, headerH);
    g.addColorStop(0, '#4682B4'); g.addColorStop(1, '#87CEEB');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, headerH);
    ctx.fillStyle = '#fff'; ctx.font = `40px ${CARD_FONT}`;
    ctx.fillText('🏅', pad, 68);
    ctx.font = `800 24px ${CARD_FONT}`;
    ctx.fillText(eventDisplayName().toUpperCase(), pad + 64, 50);
    ctx.font = `500 12px ${CARD_FONT}`;
    ctx.fillText('Advanced Student Honour Roll 進階學生榮譽榜', pad + 64, 74);
    y += headerH;
    ctx.fillStyle = '#FFD700'; ctx.fillRect(0, y, W, divH); y += divH + 24;

    // students
    ctx.fillStyle = '#4682B4'; ctx.font = `700 11px ${CARD_FONT}`;
    ctx.fillText('HONOURED STUDENT(S) 獲獎學生', pad, y + 11); y += 22;
    fam.members.forEach((m) => {
      const h = studentH(m);
      ctx.fillStyle = '#f8fafc'; rr(ctx, pad, y, W - 2 * pad, h, 6); ctx.fill();
      ctx.fillStyle = '#FFD700'; ctx.fillRect(pad, y, 4, h);
      ctx.fillStyle = '#333'; ctx.font = `700 16px ${CARD_FONT}`;
      ctx.fillText(m.nameCn || m.nameEn || '', pad + 14, y + 27);
      ctx.fillStyle = '#666'; ctx.font = `12px ${CARD_FONT}`;
      ctx.fillText(`${m.centerName || ''} · #${m.studentNumber || ''}`, pad + 14, y + 47);
      if ((m.awards || []).length) {
        let x = pad + 14;
        ctx.font = `700 11px ${CARD_FONT}`;
        (m.awards || []).forEach(a => {
          const label = `${medalFor(a.tier)} ${a.subject} ${'★'.repeat(a.stars || 0)}`;
          const w = ctx.measureText(label).width + 18;
          const tier = (a.tier || 'bronze').toLowerCase();
          ctx.fillStyle = tier === 'gold' ? '#fef3c7' : tier === 'silver' ? '#f1f5f9' : '#ffedd5';
          rr(ctx, x, y + 56, w, 22, 11); ctx.fill();
          ctx.strokeStyle = tier === 'gold' ? '#fde047' : tier === 'silver' ? '#cbd5e1' : '#fdba74';
          ctx.lineWidth = 1; rr(ctx, x, y + 56, w, 22, 11); ctx.stroke();
          ctx.fillStyle = tier === 'gold' ? '#92400e' : tier === 'silver' ? '#475569' : '#c2410c';
          ctx.fillText(label, x + 9, y + 71);
          x += w + 6;
        });
      }
      y += h + 12;
    });
    y += 4;

    // details box
    ctx.fillStyle = '#f1f5f9'; rr(ctx, pad, y, W - 2 * pad, detH, 10); ctx.fill();
    const c1 = pad + 16, c2 = pad + (W - 2 * pad) / 2 + 8;
    ctx.font = `600 10px ${CARD_FONT}`; ctx.fillStyle = '#666';
    ctx.fillText('📅 DATE 日期', c1, y + 26);
    ctx.fillText('🕐 TIME 時間', c2, y + 26);
    ctx.font = `700 15px ${CARD_FONT}`; ctx.fillStyle = '#4682B4';
    ctx.fillText(eventSettings.eventDate ? new Date(eventSettings.eventDate).toLocaleDateString('en-GB') : '—', c1, y + 50);
    ctx.fillText(familyTimeText(fam), c2, y + 50);
    ctx.font = `600 10px ${CARD_FONT}`; ctx.fillStyle = '#666';
    ctx.fillText('📍 VENUE 地點', c1, y + 86);
    ctx.font = `700 15px ${CARD_FONT}`; ctx.fillStyle = '#4682B4';
    ctx.fillText(eventSettings.venue || '—', c1, y + 110);
    y += detH + 16;

    // barcode section
    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    rr(ctx, pad, y, W - 2 * pad, bcH, 10); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#4682B4'; ctx.font = `700 11px ${CARD_FONT}`;
    ctx.fillText('CHECK-IN BARCODE(S) 報到條碼', pad + secPad, y + secPad + 11);
    let yy = y + secPad + 22;
    bcImgs.forEach((img, i) => {
      const it = bcItems[i];
      ctx.fillStyle = '#fafafa'; rr(ctx, pad + secPad, yy, iw, it.itemH, 6); ctx.fill();
      ctx.drawImage(img, pad + secPad + 16, yy + 12, it.bw, it.bh);
      ctx.fillStyle = '#333'; ctx.font = `600 12px ${CARD_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(fam.members[i].nameCn || fam.members[i].nameEn || '', W / 2, yy + 12 + it.bh + 18);
      ctx.textAlign = 'left';
      yy += it.itemH + 12;
    });
    y += bcH + 16;

    // QR section
    if (qrImg) {
      ctx.fillStyle = '#f8fafc'; rr(ctx, pad, y, W - 2 * pad, qrH, 10); ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#4682B4'; ctx.font = `700 11px ${CARD_FONT}`;
      ctx.fillText('RSVP / DETAILS 回覆與詳情', W / 2, y + secPad + 11);
      ctx.drawImage(qrImg, W / 2 - 70, y + secPad + 22, 140, 140);
      ctx.fillStyle = '#666'; ctx.font = `11px ${CARD_FONT}`;
      ctx.fillText('Scan to confirm attendance 掃描以確認出席', W / 2, y + secPad + 22 + 140 + 18);
      ctx.textAlign = 'left';
      y += qrH + 24;
    } else y += 8;

    // footer
    ctx.fillStyle = '#4682B4'; ctx.fillRect(0, y, W, footerH);
    ctx.fillStyle = '#fff'; ctx.font = `500 11px ${CARD_FONT}`;
    ctx.fillText('Please present this card at check-in', pad, y + 25);
    ctx.fillText('請於報到時出示此卡', pad, y + 43);
    ctx.font = `700 12px 'Courier New',monospace`; ctx.textAlign = 'right';
    ctx.fillText(`FAM-${token.slice(0, 6).toUpperCase()}`, W - pad, y + 34);
    ctx.textAlign = 'left';

    // 4) download
    const a = document.createElement('a');
    const names = fam.members.map(m => m.nameCn || m.nameEn).join('_').replace(/\s+/g, '');
    a.download = `ASHR_Invite_${names || 'family'}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
    showToast('Card downloaded as PNG!', 'success');
  } catch (err) {
    console.error('PNG export error:', err);
    showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error');
  }
}

// ✅ Batch print: one bilingual card per page, image-based barcodes/QR
async function printAllCards() {
  const familyGroups = buildAshrFamilies();
  const withLink = familyGroups.filter(fam => Object.values(portalsCache).some(p => p.familyKey === fam.key));
  if (!withLink.length) return showToast('No families with links yet', 'error');
  if (!confirm(`Open ${withLink.length} invitation card(s) in a print window?`)) return;

  const printWin = window.open('', '_blank');
  if (!printWin) return showToast('Pop-up blocked — allow pop-ups and try again', 'error');

  const cardsHtml = (await Promise.all(withLink.map(async (fam) => {
    const entry = Object.entries(portalsCache).find(([_, p]) => p.familyKey === fam.key);
    if (!entry) return '';
    const [token] = entry;
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}ashr-invite.html?e=${encodeURIComponent(currentEventId)}&t=${encodeURIComponent(token)}`;

    const studentsHtml = fam.members.map(m => {
      const awardsHtml = (m.awards || []).map(a =>
        `<span class="award-badge award-${(a.tier || 'bronze').toLowerCase()}">${medalFor(a.tier)} ${escapeHtml(a.subject)} ${'★'.repeat(a.stars || 0)}</span>`
      ).join('');
      return `<div class="inv-student">
        <div class="inv-student-name">${escapeHtml(m.nameCn || m.nameEn || '')}</div>
        <div class="inv-student-center">${escapeHtml(m.centerName || '')} · #${escapeHtml(m.studentNumber || '')}</div>
        <div class="inv-student-awards">${awardsHtml}</div>
      </div>`;
    }).join('');

    const barcodesHtml = fam.members.map(m => {
      const value = m.barcodeValue || `ASHR${currentEventId}_${m.honoreeKey}`;
      const dataUrl = barcodeDataUrl(shortScanCode(value)); // ✅ Short code
      return `<div class="inv-barcode-item">
        ${dataUrl ? `<img class="inv-barcode-img" src="${dataUrl}" style="image-rendering: pixelated; width: auto; max-width: 100%; height: auto;">` : `<div class="inv-barcode-fallback">${escapeHtml(value)}</div>`}
        <div class="inv-barcode-student">${escapeHtml(m.nameCn || m.nameEn || '')}</div>
      </div>`;
    }).join('');

    const qrUrl = await qrDataUrl(url, 240);

    return `
      <div class="card-wrapper">
        <div class="invitation-card">
          <div class="inv-header">
            <div class="inv-logo">🏅</div>
            <div class="inv-title-block">
              <div class="inv-event-name">${escapeHtml(eventDisplayName())}</div>
              <div class="inv-subtitle"><span class="en">Advanced Student Honour Roll</span> <span class="zh">進階學生榮譽榜</span></div>
            </div>
          </div>
          <div class="inv-divider"></div>
          <div class="inv-body">
            <div class="inv-label">Honoured Student(s) <span class="zh">獲獎學生</span></div>
            ${studentsHtml}
            <div class="inv-details-grid">
              <div><div class="inv-detail-label">📅 Date <span class="zh">日期</span></div><div class="inv-detail-value">${eventSettings.eventDate ? new Date(eventSettings.eventDate).toLocaleDateString('en-GB') : '—'}</div></div>
              <div><div class="inv-detail-label">🕐 Time <span class="zh">時間</span></div><div class="inv-detail-value">${escapeHtml(familyTimeText(fam))}</div></div>
              <div style="grid-column:1/-1;"><div class="inv-detail-label">📍 Venue <span class="zh">地點</span></div><div class="inv-detail-value">${escapeHtml(eventSettings.venue || '—')}</div></div>
            </div>
            <div class="inv-barcode-section">
              <div class="inv-label">Check-in Barcode(s) <span class="zh">報到條碼</span></div>
              ${barcodesHtml}
            </div>
            ${qrUrl ? `<div class="inv-qr-section">
              <div class="inv-label">RSVP / Details <span class="zh">回覆與詳情</span></div>
              <div class="inv-qr"><img class="inv-qr-img" src="${qrUrl}"></div>
              <div class="inv-qr-hint">Scan to confirm attendance <span class="zh">掃描以確認出席</span></div>
            </div>` : ''}
          </div>
          <div class="inv-footer">
            <div class="inv-footer-text">Please present this card at check-in<span class="zh">請於報到時出示此卡</span></div>
            <div class="inv-footer-code">FAM-${token.slice(0, 6).toUpperCase()}</div>
          </div>
        </div>
      </div>`;
  }))).join('<div class="page-break"></div>');

  printWin.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(eventDisplayName())} Cards</title>
    <style>
      body { font-family:'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif; padding:24px; display:flex; flex-direction:column; gap:32px; align-items:center; background:#fff; }
      .no-print { padding:10px 24px; font-size:16px; cursor:pointer; border:none; border-radius:8px; background:#4682B4; color:#fff; font-weight:600; }
      .page-break { page-break-after: always; }
      .card-wrapper { width:500px; }
      .invitation-card { background:#fff; border:2px solid #4682B4; border-radius:16px; overflow:hidden; }
      .inv-header { background:#4682B4; color:#fff; padding:1.25rem 1.5rem; display:flex; align-items:center; gap:1rem; }
      .inv-logo { font-size:2.5rem; }
      .inv-title-block { flex:1; }
      .inv-event-name { font-size:1.4rem; font-weight:800; text-transform:uppercase; }
      .inv-subtitle { font-size:0.85rem; opacity:0.95; }
      .inv-divider { height:4px; background:#FFD700; }
      .inv-body { padding:1.5rem; }
      .inv-label { font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; color:#4682B4; margin-bottom:0.5rem; }
      .inv-label .zh { letter-spacing:0.5px; text-transform:none; }
      .inv-student { background:#f8fafc; border-left:4px solid #FFD700; padding:0.6rem 0.9rem; border-radius:6px; margin-bottom:0.5rem; }
      .inv-student-name { font-weight:700; font-size:1.05rem; }
      .inv-student-center { font-size:0.8rem; color:#666; }
      .inv-student-awards { margin-top:0.35rem; }
      .inv-details-grid { display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; background:#f1f5f9; padding:0.9rem; border-radius:10px; margin:1.25rem 0; }
      .inv-detail-label { font-size:0.7rem; color:#666; text-transform:uppercase; }
      .inv-detail-label .zh { text-transform:none; }
      .inv-detail-value { font-weight:700; color:#4682B4; font-size:0.95rem; }
      .inv-barcode-section { border:1.5px dashed #cbd5e1; border-radius:10px; padding:1rem; margin-bottom:1rem; }
      .inv-barcode-item { text-align:center; padding:0.5rem; background:#fafafa; border-radius:6px; margin-bottom:0.5rem; }
      .inv-barcode-img { max-width:100%; height:auto; display:block; margin:0 auto; }
      .inv-barcode-fallback { font-family:'Courier New',monospace; font-size:0.8rem; }
      .inv-barcode-student { font-size:0.78rem; font-weight:600; margin-top:0.3rem; }
      .inv-qr-section { text-align:center; padding:0.75rem; background:#f8fafc; border-radius:10px; }
      .inv-qr { display:inline-block; padding:0.5rem; background:#fff; border-radius:8px; margin-top:0.4rem; }
      .inv-qr-img { width:120px; height:120px; display:block; margin:0 auto; }
      .inv-qr-hint { font-size:0.72rem; color:#666; font-style:italic; margin-top:0.4rem; }
      .inv-qr-hint .zh { font-style:normal; }
      .inv-footer { background:#4682B4; color:#fff; padding:0.75rem 1.5rem; display:flex; justify-content:space-between; align-items:center; font-size:0.78rem; gap:1rem; }
      .inv-footer-text .zh { display:block; font-size:0.72rem; opacity:0.9; }
      .inv-footer-code { font-family:'Courier New',monospace; font-weight:700; }
      .award-badge { display:inline-block; padding:0.15rem 0.5rem; border-radius:999px; font-size:0.75rem; font-weight:700; margin:0.1rem; }
      .award-gold { background:#fef3c7; color:#92400e; border:1px solid #fde047; }
      .award-silver { background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; }
      .award-bronze { background:#ffedd5; color:#c2410c; border:1px solid #fdba74; }
      @media print { .no-print { display:none !important; } .card-wrapper { page-break-after: always; } body { padding:0; } }
    </style>
    </head><body>
    <button class="no-print" onclick="window.print()">🖨️ Print All Cards</button>
    ${cardsHtml}
    </body></html>`);
  printWin.document.close();
}

// ============================================
// RSVPS & REPORTS
// ============================================
function setupRSVPs() {
  $('rsvpFilter').addEventListener('change', renderRSVPs);
  $('exportRsvpBtn').addEventListener('click', exportRSVPs);
}

function countGuests(g) {
  if (!g) return 0;
  let c = 0;
  if (g.mom) c++;
  if (g.dad) c++;
  if (g.grandma) c++;
  if (g.grandpa) c++;
  c += parseInt(g.siblings) || 0;
  c += parseInt(g.others) || 0;
  return c;
}

function computeSlotCounts() {
  const counts = {};
  Object.keys(timeslots).forEach(sid => { counts[sid] = { students: 0, guests: 0 }; });
  Object.values(families).forEach(fam => {
    const rsvp = fam.rsvp;
    if (!rsvp || rsvp.status !== 'attending') return;
    const memberIds = fam.memberHonoreeIds || [];
    const guestCount = countGuests(rsvp.guests);
    if (rsvp.sameTimeslot && rsvp.sharedSlotId) {
      if (counts[rsvp.sharedSlotId]) {
        counts[rsvp.sharedSlotId].students += memberIds.length;
        counts[rsvp.sharedSlotId].guests += guestCount;
      }
    } else if (rsvp.perStudentSlots) {
      memberIds.forEach(mid => {
        const sid = rsvp.perStudentSlots[mid];
        if (sid && counts[sid]) {
          counts[sid].students += 1;
          counts[sid].guests += Math.round(guestCount / memberIds.length);
        }
      });
    }
  });
  return counts;
}

function renderRSVPs() {
  const filter = $('rsvpFilter').value;
  const tbody = $('rsvpTableBody');
  tbody.innerHTML = '';
  let attending = 0, declined = 0, pending = 0, totalGuests = 0;
  Object.values(families).forEach(fam => {
    const status = fam.rsvp?.status || 'pending';
    if (status === 'attending') { attending++; totalGuests += countGuests(fam.rsvp.guests); }
    else if (status === 'declined') declined++;
    else pending++;
  });
  $('rsvpStats').innerHTML = `
    <div class="stat-card"><div class="stat-value">${attending}</div><div class="stat-label">${t('stat.attending', 'Attending')}</div></div>
    <div class="stat-card"><div class="stat-value">${declined}</div><div class="stat-label">${t('stat.declined', 'Declined')}</div></div>
    <div class="stat-card"><div class="stat-value">${pending}</div><div class="stat-label">${t('stat.pending', 'No Response')}</div></div>
    <div class="stat-card"><div class="stat-value">${totalGuests}</div><div class="stat-label">${t('stat.guests', 'Total Guests')}</div></div>`;
  Object.entries(families).forEach(([famId, fam]) => {
    const rsvp = fam.rsvp || {};
    const status = rsvp.status || 'pending';
    if (filter !== 'all' && status !== filter) return;
    const memberIds = fam.memberHonoreeIds || [];
    const memberNames = memberIds.map(mid => honorees[mid] ? (honorees[mid].nameCn || honorees[mid].nameEn) : mid).join(', ');
    let slotDisplay = '—';
    if (status === 'attending') {
      if (rsvp.sameTimeslot && rsvp.sharedSlotId) {
        const slot = timeslots[rsvp.sharedSlotId];
        slotDisplay = slot ? `${slot.start}–${slot.end}` : rsvp.sharedSlotId;
      } else if (rsvp.perStudentSlots) {
        slotDisplay = Object.values(rsvp.perStudentSlots).map(sid => timeslots[sid] ? timeslots[sid].start : sid).join(', ');
      }
    }
    const statusClass = status === 'attending' ? 'st-attending' : status === 'declined' ? 'st-declined' : 'st-pending';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(memberNames)}</td>
      <td>${memberIds.length}</td>
      <td><span class="status-badge ${statusClass}">${t('st.' + status, status)}</span></td>
      <td>${escapeHtml(slotDisplay)}</td>
      <td>${countGuests(rsvp.guests)}</td>
      <td>${rsvp.submittedAt ? new Date(rsvp.submittedAt).toLocaleDateString() : '—'}</td>`;
    tbody.appendChild(tr);
  });
}

function renderSlotCapacity() {
  const counts = computeSlotCounts();
  const tbody = $('slotCapacityBody');
  tbody.innerHTML = '';
  Object.entries(timeslots).sort((a, b) => (a[1].start || '').localeCompare(b[1].start || '')).forEach(([slotId, slot]) => {
    const c = counts[slotId] || { students: 0, guests: 0 };
    const total = c.students + c.guests;
    const isFull = c.students >= (slot.capacity || 30);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(slot.start)} – ${escapeHtml(slot.end)}</td>
      <td><strong>${c.students}</strong></td>
      <td>${slot.capacity || 30}</td>
      <td>${c.guests}</td>
      <td>${total}</td>
      <td>${isFull ? `<span class="status-badge st-declined">${t('slot.full', 'FULL')}</span>` : slot.isEnabled === false ? `<span class="status-badge st-pending">${t('slot.disabled', 'Disabled')}</span>` : `<span class="status-badge st-attending">${t('slot.open', 'Open')}</span>`}</td>`;
    tbody.appendChild(tr);
  });
}

function exportRSVPs() {
  const rows = [];
  Object.values(families).forEach(fam => {
    const rsvp = fam.rsvp || {};
    (fam.memberHonoreeIds || []).forEach(mid => {
      const h = honorees[mid];
      if (!h) return;
      rows.push({
        'Student': h.nameCn || h.nameEn, 'Pinyin': h.nameEn || '', 'Center': h.centerName || '',
        'Awards': (h.awards || []).map(a => `${a.subject} ${a.stars}★`).join('; '),
        'RSVP Status': rsvp.status || 'pending', 'Guests': countGuests(rsvp.guests),
        'Submitted': rsvp.submittedAt || ''
      });
    });
  });
  if (!rows.length) return showToast(t('toast.noExport', 'No data to export'), 'error');
  downloadExcel(rows, `ASHR_RSVP_${currentEventId}.xls`);
  showToast(t('toast.exportOk', 'Exported!'), 'success');
}

function downloadExcel(rows, filename) {
  const headers = Object.keys(rows[0]);
  let html = '<table><thead><tr>';
  headers.forEach(h => html += `<th>${escapeHtml(h)}</th>`);
  html += '</tr></thead><tbody>';
  rows.forEach(r => {
    html += '<tr>';
    headers.forEach(h => html += `<td>${escapeHtml(r[h] || '')}</td>`);
    html += '</tr>';
  });
  html += '</tbody></table>';
  const blob = new Blob([`<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body>${html}</body></html>`], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ============================================
// CHECK-IN MODE
// ============================================
function setupCheckin() {
  // 1. Physical scanner & manual typing (acts as a keyboard)
  $('scanInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { handleScanValue(e.target.value.trim()); e.target.value = ''; }
  });
  // 2. Phone camera scan
  $('phoneScanBtn').addEventListener('click', startCameraScan);
  $('closeCameraModal').addEventListener('click', stopCameraScan);
}

async function handleScanValue(value) {
  if (!value) return;
  const result = $('scanResult');
  
  // ✅ Match against short code, long code, ID, or student number
  const entry = Object.entries(honorees).find(([key, h]) => {
    const bv = h.barcodeValue || `ASHR${currentEventId}_${key}`;
    return bv === value || key === value || h.studentId === value || 
           String(h.studentNumber || '') === value || shortScanCode(bv) === value;
  });
  
  if (!entry) {
    result.className = 'error';
    result.textContent = `${t('toast.unknownCode', '❌ Unknown barcode')}: ${escapeHtml(value)}`;
    return;
  }
  const [honoreeKey, h] = entry;
  const famId = Object.keys(families).find(fid => (families[fid].memberHonoreeIds || []).includes(honoreeKey));
  const rsvp = famId ? families[famId]?.rsvp : null;
  if (!rsvp || rsvp.status !== 'attending') {
    result.className = 'error';
    result.textContent = `⚠️ ${escapeHtml(h.nameCn || h.nameEn)} ${t('toast.notConfirmed', 'has not confirmed attendance.')}`;
    return;
  }
  try {
    if (checkins[honoreeKey]) {
      await remove(ref(db, `ashrEvents/${currentEventId}/checkins/${honoreeKey}`));
      result.className = 'success';
      result.textContent = `↩️ ${escapeHtml(h.nameCn || h.nameEn)} ${t('toast.checkedOut', 'checked OUT.')}`;
    } else {
      await set(ref(db, `ashrEvents/${currentEventId}/checkins/${honoreeKey}`), {
        checkedInAt: new Date().toISOString(),
        checkedInBy: auth.currentUser?.email || ''
      });
      result.className = 'success';
      result.textContent = `✅ ${escapeHtml(h.nameCn || h.nameEn)} ${t('toast.checkedIn', 'checked in!')}`;
    }
  } catch (err) { showToast(`${t('toast.err', 'Error')}: ${err.message}`, 'error'); }
}

function getConfirmedAttendeesBySlot() {
  const bySlot = {};
  Object.entries(timeslots).sort((a, b) => (a[1].start || '').localeCompare(b[1].start || '')).forEach(([slotId, slot]) => {
    if (slot.isEnabled === false) return;
    const attendees = [];
    Object.values(families).forEach(fam => {
      const rsvp = fam.rsvp;
      if (!rsvp || rsvp.status !== 'attending') return;
      const memberIds = fam.memberHonoreeIds || [];
      if (rsvp.sameTimeslot && rsvp.sharedSlotId === slotId) {
        memberIds.forEach(mid => { if (honorees[mid]) attendees.push({ honoreeKey: mid, ...honorees[mid] }); });
      } else if (rsvp.perStudentSlots) {
        memberIds.forEach(mid => {
          if (rsvp.perStudentSlots[mid] === slotId && honorees[mid]) attendees.push({ honoreeKey: mid, ...honorees[mid] });
        });
      }
    });
    if (attendees.length) bySlot[slotId] = { slot, attendees };
  });
  return bySlot;
}

function renderCheckinSlots() {
  const container = $('checkinSlotList');
  container.innerHTML = '';
  const bySlot = getConfirmedAttendeesBySlot();
  Object.entries(bySlot).forEach(([slotId, { slot, attendees }]) => {
    const checkedCount = attendees.filter(a => checkins[a.honoreeKey]).length;
    const section = document.createElement('div');
    section.className = 'checkin-slot-section';
    section.innerHTML = `
      <div class="checkin-slot-header">
        <h4>${escapeHtml(slot.start)} – ${escapeHtml(slot.end)}</h4>
        <span>${checkedCount}/${attendees.length} ${t('ci.arrived', 'arrived')}</span>
      </div>
      ${attendees.map(a => {
        const isChecked = !!checkins[a.honoreeKey];
        const checkTime = isChecked ? new Date(checkins[a.honoreeKey].checkedInAt).toLocaleTimeString() : '';
        return `<div class="checkin-student-row ${isChecked ? 'checked-in' : ''}">
          <span class="student-name">${escapeHtml(a.nameCn || a.nameEn)}</span>
          ${isChecked ? `<span class="check-time">✓ ${escapeHtml(checkTime)}</span>` : ''}
          <button class="checkin-toggle ${isChecked ? 'uncheck' : 'check'}" data-checkin-key="${escapeHtml(a.honoreeKey)}">
            ${isChecked ? t('ci.undo', 'Undo') : t('ci.check', 'Check In')}
          </button>
        </div>`;
      }).join('')}`;
    container.appendChild(section);
  });
  container.querySelectorAll('[data-checkin-key]').forEach(btn => {
    btn.addEventListener('click', () => handleScanValue(btn.dataset.checkinKey));
  });
}

async function startCameraScan() {
  if (typeof Html5Qrcode === 'undefined') {
    showToast('Scanner library missing — check the html5-qrcode script tag', 'error');
    return;
  }
  $('cameraModal').classList.remove('hidden');
  const reader = $('cameraReader');
  reader.style.height = '';                    // clear leftover sizing from last session

  if (html5QrCode && html5QrCode.isScanning) {
    try { await html5QrCode.stop(); } catch (e) {}
  }
  try {
    if (!html5QrCode) {
      const ctorOpts = {};
      if (typeof Html5QrcodeSupportedFormats !== 'undefined') {
        ctorOpts.formatsToSupport = [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.QR_CODE
        ];
      }
      html5QrCode = new Html5Qrcode('cameraReader', ctorOpts);
    }
    await new Promise(r => requestAnimationFrame(r));  // let modal lay out

    await html5QrCode.start(
      { facingMode: 'environment' },
      {
        fps: 15,
        // vw/vh = the rendered viewfinder size; clamp so the box can
        // never exceed the video (that's what caused the spill-over)
        qrbox: (vw, vh) => ({
          width:  Math.floor(Math.min(vw * 0.85, 420)),
          height: Math.floor(Math.min(vw * 0.85 * 0.45, vh * 0.55))
        }),
        videoConstraints: {
          facingMode: 'environment',
          width:  { ideal: 1280 },
          height: { ideal: 720 }
        }
        // ⚠️ no aspectRatio here — forcing it letterboxes the video
      },
      (decodedText) => { handleScanValue(decodedText); stopCameraScan(); },
      (errMsg) => {
        if (!startCameraScan._t || Date.now() - startCameraScan._t > 3000) {
          console.warn('[scanner]', errMsg);
          startCameraScan._t = Date.now();
        }
      }
    );
    cameraActive = true;

    // 🔧 Snap the container to the real video height so the grey overlay
    //    and brackets can never extend past the preview again
    requestAnimationFrame(() => {
      const video = reader.querySelector('video');
      if (!video) return;
      const apply = () => { reader.style.height = video.getBoundingClientRect().height + 'px'; };
      apply();
      video.addEventListener('loadedmetadata', apply, { once: true });
      video.addEventListener('resize', apply, { once: true });
    });
  } catch (err) {
    console.error('Camera start failed:', err);
    showToast(`${t('toast.cameraErr', 'Camera error')}: ${err.message || err}`, 'error');
    $('cameraModal').classList.add('hidden');
  }
}

async function stopCameraScan() {
  $('cameraModal').classList.add('hidden');
  if (html5QrCode) {
    try { if (html5QrCode.isScanning) await html5QrCode.stop(); } catch (e) {}
  }
  cameraActive = false;
  $('cameraReader').style.height = '';
}

// ============================================
// UTILITIES
// ============================================
let toastTimer = null;
function showToast(msg, type = 'success') {
  const toast = $('toast');
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function applyPlaceholders() {
  const ph = {
    manualSearchInput: 'hon.searchPh',
    honoreeSearch: 'hon.filterPh',
    linkSearch: 'links.searchPh',
    scanInput: 'ci.scanPh',
    umSearch: 'um.searchPh'
  };
  Object.entries(ph).forEach(([id, key]) => {
    const el = $(id);
    if (el) el.placeholder = t(key, el.placeholder);
  });
}

window.addEventListener('beforeunload', () => {
  unsubscribers.forEach(fn => fn());
  if (html5QrCode && cameraActive) html5QrCode.stop().catch(() => {});
});