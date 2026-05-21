// student-form.js
import { requireAuth, db } from './auth.js';
import { ref, push, set, get, remove } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) {}

const SUBJECTS = ['Math', 'Chinese', 'English ERP', 'English EFL'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let subjectCount = 0;
const centerId = sessionStorage.getItem('selectedCenter');
const studentId = new URLSearchParams(window.location.search).get('id');
const isEdit = !!studentId;

document.getElementById('formTitle').textContent = isEdit ? 'Edit Student' : 'Add Student';

function hideLoader() {
  const loader = document.getElementById('loadingOverlay');
  if (loader) setTimeout(() => loader.classList.add('hidden'), 300);
}

// ✅ QR Scanner Logic
let html5QrCode = null;
let scannerActive = false;
const scanBtn = document.getElementById('startScannerBtn');
const qrReader = document.getElementById('qr-reader');
const qrStatus = document.getElementById('qr-status');
const qrInput = document.getElementById('qrCodeInput');

if (scanBtn) {
  scanBtn.addEventListener('click', async () => {
    if (scannerActive) {
      if (html5QrCode) await html5QrCode.stop();
      qrReader.style.display = 'none';
      scanBtn.textContent = '📷 Scan QR';
      scannerActive = false;
      return;
    }
    qrReader.style.display = 'block';
    scanBtn.textContent = '⏹ Stop';
    scannerActive = true;
    qrStatus.textContent = 'Point camera at QR code...';
    html5QrCode = new Html5Qrcode("qr-reader");
    try {
      await html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          qrInput.value = decodedText;
          qrStatus.textContent = `✅ Scanned: ${decodedText}`;
          html5QrCode.stop();
          qrReader.style.display = 'none';
          scanBtn.textContent = '📷 Scan QR';
          scannerActive = false;
        },
        () => {}
      );
    } catch (err) {
      qrStatus.textContent = '❌ Camera access denied or not available.';
      qrReader.style.display = 'none';
      scanBtn.textContent = '📷 Scan QR';
      scannerActive = false;
    }
  });
}

window.addEventListener('beforeunload', () => {
  if (html5QrCode && scannerActive) html5QrCode.stop();
});

if (isEdit) loadStudentData();
else { addSubjectField(); hideLoader(); }

// ✅ Delete Logic
const deleteBtn = document.getElementById('deleteBtn');
if (isEdit) {
  deleteBtn.style.display = 'inline-block';
  deleteBtn.onclick = async () => {
    if (confirm('Are you sure you want to permanently delete this student?')) {
      try {
        document.getElementById('loadingOverlay').classList.remove('hidden');
        await remove(ref(db, `centers/${centerId}/students/${studentId}`));
        alert('Student deleted successfully!');
        window.location.href = 'students.html';
      } catch (err) {
        alert('Error deleting student: ' + err.message);
      } finally {
        document.getElementById('loadingOverlay').classList.add('hidden');
      }
    }
  };
}

async function loadStudentData() {
  try {
    const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
    if (snap.exists()) {
      const s = snap.val();
      document.getElementById('studentNumber').value = s.studentNumber || '';
      // ✅ REMOVED nameEn - replaced by nickname in your HTML
      document.getElementById('nickname').value = s.nickname || s.nameEn || ''; // Fallback for old data
      document.getElementById('namePinyin').value = s.namePinyin || '';
      document.getElementById('nameCn').value = s.nameCn || '';
      document.getElementById('grade').value = s.grade || '';
      document.getElementById('school').value = s.school || '';
      document.getElementById('address').value = s.address || '';
      document.getElementById('nationality').value = s.nationality || '';
      document.getElementById('email').value = s.email || '';
      document.getElementById('birthday').value = s.birthday || '';
      if (s.qrCode) qrInput.value = s.qrCode;

      if (s.phone) {
        document.getElementById('phoneMom').value = s.phone.mom || '';
        document.getElementById('phoneDad').value = s.phone.dad || '';
        document.getElementById('phoneOwn').value = s.phone.own || '';
      }

      if (s.subjects) s.subjects.forEach(sub => addSubjectField(sub));
      else addSubjectField();
    }
  } catch (err) {
    alert('Error loading student: ' + err.message);
  } finally {
    hideLoader();
  }
}

function getHourOptions(selectedHour) {
  let opts = '';
  for (let i = 1; i <= 24; i++) {
    const val = String(i).padStart(2, '0');
    opts += `<option value="${val}" ${val === selectedHour ? 'selected' : ''}>${val}</option>`;
  }
  return opts;
}
function getMinuteOptions(selectedMin) {
  let opts = '';
  for (let i = 0; i < 60; i++) {
    const val = String(i).padStart(2, '0');
    opts += `<option value="${val}" ${val === selectedMin ? 'selected' : ''}>${val}</option>`;
  }
  return opts;
}

function addSubjectField(data = {}) {
  if (subjectCount >= 3) return alert('Maximum 3 subjects allowed');
  const container = document.getElementById('subjectsContainer');
  const div = document.createElement('div');
  div.className = 'subject-entry';

  // ✅ Clean template literal with Enrol Date field
  div.innerHTML = `
    <div class="form-grid">
      <div><label>Select Subject *</label><select class="subject-name" required><option value="">Select Subject *</option>${SUBJECTS.map(s => `<option value="${s}" ${data.name === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Start Level *</label><input type="text" class="start-level" placeholder="e.g. 7A" value="${data.startLevel || ''}" required></div>
      <div><label>Start WS # *</label><input type="number" class="start-ws" placeholder="e.g. 10" value="${data.startWS || 0}" required></div>
      <div><label>Enrol Date *</label><input type="date" class="enrol-date" value="${data.enrolDate || ''}" required></div>
      <div><label>Status</label><select class="status"><option value="new" ${data.status === 'new' ? 'selected' : ''}>New</option><option value="current" ${data.status === 'current' ? 'selected' : ''} selected>Current</option><option value="pause" ${data.status === 'pause' ? 'selected' : ''}>Pause</option><option value="drop" ${data.status === 'drop' ? 'selected' : ''}>Drop</option></select></div>
    </div>
    <div class="timeslots-container">
      <h4 style="font-size:0.9rem; margin:0 0 0.5rem;">Timeslots (Max 6)</h4>
      <div class="timeslots-list"></div>
      <button type="button" class="add-timeslot-btn secondary" style="margin-top:0.5rem; padding:0.4rem 0.8rem; font-size:0.9rem;">+ Add Timeslot</button>
    </div>
    <button type="button" class="remove-subject" style="background:#dc3545; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; margin-top:0.5rem;">Remove Subject</button>
  `;

  const timeslotsList = div.querySelector('.timeslots-list');
  if (data.timeslots && data.timeslots.length > 0) {
    data.timeslots.forEach(ts => addTimeslotField(timeslotsList, ts));
  } else {
    addTimeslotField(timeslotsList);
  }

  div.querySelector('.add-timeslot-btn').onclick = () => addTimeslotField(timeslotsList);
  div.querySelector('.remove-subject').onclick = () => { div.remove(); subjectCount--; };
  
  div.querySelector('.subject-name').addEventListener('change', (e) => {
    const selected = e.target.value;
    const allSelects = document.querySelectorAll('.subject-name');
    let hasConflict = false;
    if (selected === 'English ERP' || selected === 'English EFL') {
      allSelects.forEach(sel => {
        if (sel !== e.target && (sel.value === 'English ERP' || sel.value === 'English EFL')) hasConflict = true;
      });
    }
    if (hasConflict) {
      alert('English ERP and English EFL cannot be selected together.');
      e.target.value = '';
    }
  });

  container.appendChild(div);
  subjectCount++;
}

function addTimeslotField(timeslotsList, data = {}) {
  if (!timeslotsList) return;
  if (timeslotsList.children.length >= 6) return alert('Maximum 6 timeslots per subject');
  let h = '01', m = '00';
  if (data.time) {
    const parts = data.time.split(':');
    if (parts.length === 2) { h = parts[0]; m = parts[1]; }
  }
  const row = document.createElement('div');
  row.className = 'timeslot-row';
  const dayOptions = DAYS.map(d => `<option value="${d}" ${data.day === d ? 'selected' : ''}>${d}</option>`).join('');
  const hourOptions = getHourOptions(h);
  const minuteOptions = getMinuteOptions(m);
  
  row.innerHTML = `
    <div><label>Day</label><select class="ts-day" required>${dayOptions}</select></div>
    <div><label>Time (1-24h)</label><div style="display:flex; gap:0.5rem;"><select class="ts-hour" required>${hourOptions}</select><span style="align-self:center; font-weight:bold;">:</span><select class="ts-min" required>${minuteOptions}</select></div></div>
    <button type="button" class="remove-ts-btn">×</button>
  `;
  row.querySelector('.remove-ts-btn').onclick = () => row.remove();
  timeslotsList.appendChild(row);
}

document.getElementById('addSubjectBtn').onclick = () => addSubjectField();

// ✅ Form Submit Handler - Fixed validation & field mapping
document.getElementById('studentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!centerId) return alert('Error: No center selected.');
  if (html5QrCode && scannerActive) await html5QrCode.stop();

  const subjects = [];
  let validationError = false;

  for (const entry of document.querySelectorAll('.subject-entry')) {
    const timeslots = [];
    entry.querySelectorAll('.timeslots-list .timeslot-row').forEach(row => {
      timeslots.push({
        day: row.querySelector('.ts-day').value,
        time: `${row.querySelector('.ts-hour').value}:${row.querySelector('.ts-min').value}`
      });
    });

    const subjectName = entry.querySelector('.subject-name').value;
    if (!subjectName) { alert('Please select a subject.'); validationError = true; break; }
    if (timeslots.length === 0) { alert(`Please add at least one timeslot for ${subjectName}`); validationError = true; break; }

    subjects.push({
      name: subjectName,
      startLevel: entry.querySelector('.start-level').value,
      startWS: parseInt(entry.querySelector('.start-ws').value) || 0,
      enrolDate: entry.querySelector('.enrol-date').value, // ✅ Saved per subject
      status: entry.querySelector('.status').value,
      timeslots: timeslots,
      progress: [] 
    });
  }

  if (validationError || subjects.length === 0) return alert('Please fix form errors before saving.');

  const studentData = {
    studentNumber: document.getElementById('studentNumber').value || '',
    // ✅ REMOVED nameEn - using nickname instead
    nickname: document.getElementById('nickname').value || '',
    namePinyin: document.getElementById('namePinyin').value || '',
    nameCn: document.getElementById('nameCn').value,
    grade: document.getElementById('grade').value,
    school: document.getElementById('school').value,
    address: document.getElementById('address').value,
    nationality: document.getElementById('nationality').value,
    email: document.getElementById('email').value,
    birthday: document.getElementById('birthday').value,
    phone: {
      mom: document.getElementById('phoneMom').value,
      dad: document.getElementById('phoneDad').value,
      own: document.getElementById('phoneOwn').value
    },
    qrCode: qrInput.value.trim() || '',
    subjects: subjects,
    updatedAt: new Date().toISOString()
  };
  if (!isEdit) studentData.createdAt = new Date().toISOString();

  try {
    document.getElementById('loadingOverlay').classList.remove('hidden');
    if (isEdit) {
      await set(ref(db, `centers/${centerId}/students/${studentId}`), studentData);
      alert('Student updated successfully!');
    } else {
      await push(ref(db, `centers/${centerId}/students`), studentData);
      alert('Student added successfully!');
    }
    window.location.href = 'students.html';
  } catch (err) {
    alert('Error saving student: ' + err.message);
  } finally {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }
});