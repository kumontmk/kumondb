import { requireAuth, db } from './auth.js';
import { ref, get, update } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) window.location.href = 'login.html';

const centerId = sessionStorage.getItem('selectedCenter');
const studentsRef = ref(db, `centers/${centerId}/students`);
const loader = document.getElementById('loadingOverlay');

let studentsList = [];
let selectedStudent = null;
let selectedSubjectIndex = null;

// ✅ Load Students with Safe Fallbacks
async function loadStudents() {
  loader.classList.remove('hidden');
  try {
    const snap = await get(studentsRef);
    studentsList = [];
    const select = document.getElementById('studentSelect');
    select.innerHTML = '<option value="">Select Student</option>'; // Clear previous

    if (!snap.exists()) {
      select.innerHTML += '<option value="" disabled>No students found</option>';
      return;
    }

    snap.forEach(child => {
      const s = child.val();
      s.id = child.key;
      studentsList.push(s);

      // 🔧 FIX: Graceful fallback for missing/undefined properties
      const name = s.nameEn || s.name || s.fullName || s.studentName || 'Unknown Student';
      const number = s.studentNumber || s.studentId || s.id?.slice(-4) || 'N/A';

      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${name} (#${number})`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to load students:', err);
    alert('Error loading student list. Check console for details.');
  } finally {
    loader.classList.add('hidden');
  }
}

// ✅ Student Selection Handler
document.getElementById('studentSelect').addEventListener('change', (e) => {
  const sid = e.target.value;
  selectedStudent = studentsList.find(s => s.id === sid);
  const subSelect = document.getElementById('subjectSelect');
  
  subSelect.innerHTML = '<option value="">Select Subject</option>';
  subSelect.disabled = true;
  document.getElementById('updateForm').classList.add('hidden');

  if (selectedStudent) {
    subSelect.disabled = false;
    if (selectedStudent.subjects && Array.isArray(selectedStudent.subjects)) {
      selectedStudent.subjects.forEach((sub, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = sub.name || `Subject ${idx + 1}`;
        subSelect.appendChild(opt);
      });
    }
  }
});

// ✅ Subject Selection & Data Load
document.getElementById('subjectSelect').addEventListener('change', (e) => {
  selectedSubjectIndex = e.target.value;
  const testSection = document.getElementById('testSection');
  testSection.classList.add('hidden');

  if (selectedSubjectIndex !== "") {
    document.getElementById('updateForm').classList.remove('hidden');
    const sub = selectedStudent.subjects[parseInt(selectedSubjectIndex)];
    const lastProg = sub.progress?.length ? sub.progress[sub.progress.length - 1] : null;

    // Safe fallbacks for previous data
    document.getElementById('prevLevel').value = lastProg ? lastProg.currLevel : (sub.startLevel || '');
    document.getElementById('prevWS').value = lastProg ? lastProg.currWS : 0;

    // Clear inputs
    ['currLevel', 'currWS', 'testLevel', 'testScore', 'testTime', 'testGroup'].forEach(id => {
      document.getElementById(id).value = '';
    });

    // Default Month to current
    const today = new Date();
    document.getElementById('inputMonth').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  } else {
    document.getElementById('updateForm').classList.add('hidden');
  }
});

// ✅ Toggle Test Section if Level Changes
document.getElementById('currLevel').addEventListener('input', (e) => {
  const prev = document.getElementById('prevLevel').value;
  const curr = e.target.value.trim();
  const testSection = document.getElementById('testSection');

  if (curr && prev && curr !== prev) {
    testSection.classList.remove('hidden');
  } else {
    testSection.classList.add('hidden');
    // Clear test fields when hidden
    ['testLevel', 'testScore', 'testTime', 'testGroup'].forEach(id => {
      document.getElementById(id).value = '';
    });
  }
});

// ✅ Save Progress
document.getElementById('updateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (selectedSubjectIndex === null || selectedSubjectIndex === "") return;

  loader.classList.remove('hidden');
  const showTest = !document.getElementById('testSection').classList.contains('hidden');

  const newProgress = {
    month: document.getElementById('inputMonth').value,
    prevLevel: document.getElementById('prevLevel').value,
    prevWS: parseInt(document.getElementById('prevWS').value) || 0,
    currLevel: document.getElementById('currLevel').value.trim(),
    currWS: parseInt(document.getElementById('currWS').value) || 0,
    timestamp: new Date().toISOString()
  };

  if (showTest) {
    newProgress.test = {
      level: document.getElementById('testLevel').value.trim(),
      score: parseInt(document.getElementById('testScore').value) || 0,
      time: document.getElementById('testTime').value.trim(),
      group: document.getElementById('testGroup').value.trim()
    };
  }

  try {
    const subjectPath = `subjects/${selectedSubjectIndex}/progress`;
    const snap = await get(ref(db, `centers/${centerId}/students/${selectedStudent.id}/${subjectPath}`));
    const currentProgress = snap.exists() ? snap.val() : [];
    currentProgress.push(newProgress);

    await update(ref(db, `centers/${centerId}/students/${selectedStudent.id}`), {
      [subjectPath]: currentProgress
    });

    alert('✅ Progress saved successfully!');
    document.getElementById('subjectSelect').dispatchEvent(new Event('change'));
  } catch (err) {
    console.error('Save error:', err);
    alert('❌ Error saving progress: ' + err.message);
  } finally {
    loader.classList.add('hidden');
  }
});

// Initial Load
loadStudents();