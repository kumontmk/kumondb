import { requireAuth, db } from './auth.js';
import { ref, get, update } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) {}

const centerId = sessionStorage.getItem('selectedCenter');
const studentsRef = ref(db, `centers/${centerId}/students`);
const loader = document.getElementById('loadingOverlay');

let studentsList = [];
let selectedStudent = null;
let selectedSubjectIndex = null;

// ✅ Load Students
async function loadStudents() {
  loader.classList.remove('hidden');
  try {
    const snap = await get(studentsRef);
    studentsList = [];
    const select = document.getElementById('studentSelect');
    
    snap.forEach(child => {
      const s = child.val();
      s.id = child.key;
      studentsList.push(s);
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.nameEn} (#${s.studentNumber})`;
      select.appendChild(opt);
    });
  } catch (err) { console.error(err); }
  finally { loader.classList.add('hidden'); }
}

document.getElementById('studentSelect').addEventListener('change', (e) => {
  const sid = e.target.value;
  selectedStudent = studentsList.find(s => s.id === sid);
  const subSelect = document.getElementById('subjectSelect');
  subSelect.innerHTML = '<option value="">Select Subject</option>';
  
  if (selectedStudent) {
    document.getElementById('progressForm').classList.remove('hidden');
    selectedStudent.subjects.forEach((sub, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = sub.name;
      subSelect.appendChild(opt);
    });
  } else {
    document.getElementById('progressForm').classList.add('hidden');
  }
});

// ✅ Load Subject Data & Fill Previous Fields
document.getElementById('subjectSelect').addEventListener('change', (e) => {
  selectedSubjectIndex = e.target.value;
  const testSection = document.getElementById('testSection');
  testSection.classList.add('hidden');
  
  if (selectedSubjectIndex !== "") {
    const sub = selectedStudent.subjects[selectedSubjectIndex];
    const lastProg = sub.progress?.length ? sub.progress[sub.progress.length - 1] : null;
    
    // Logic: If no progress history, previous is the Start Level
    document.getElementById('prevLevel').value = lastProg ? lastProg.currLevel : sub.startLevel;
    document.getElementById('prevWS').value = lastProg ? lastProg.currWS : 0;
    
    // Clear inputs
    document.getElementById('currLevel').value = '';
    document.getElementById('currWS').value = '';
    document.getElementById('testLevel').value = '';
    document.getElementById('testScore').value = '';
    document.getElementById('testTime').value = '';
    document.getElementById('testGroup').value = '';
    
    // Default Month to current
    const today = new Date();
    document.getElementById('inputMonth').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  }
});

// ✅ Toggle Test Section if Level Changes
document.getElementById('currLevel').addEventListener('input', (e) => {
  const prev = document.getElementById('prevLevel').value;
  const curr = e.target.value;
  const testSection = document.getElementById('testSection');
  
  if (curr && prev && curr !== prev) {
    testSection.classList.remove('hidden');
  } else {
    testSection.classList.add('hidden');
  }
});

// ✅ Save Progress
document.getElementById('updateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (selectedSubjectIndex === "") return;
  
  const loader = document.getElementById('loadingOverlay');
  loader.classList.remove('hidden');
  
  const testSection = document.getElementById('testSection');
  const showTest = !testSection.classList.contains('hidden');
  
  const newProgress = {
    month: document.getElementById('inputMonth').value,
    prevLevel: document.getElementById('prevLevel').value,
    prevWS: parseInt(document.getElementById('prevWS').value) || 0,
    currLevel: document.getElementById('currLevel').value,
    currWS: parseInt(document.getElementById('currWS').value) || 0,
  };

  if (showTest) {
    newProgress.test = {
      level: document.getElementById('testLevel').value,
      score: parseInt(document.getElementById('testScore').value) || 0,
      time: document.getElementById('testTime').value,
      group: document.getElementById('testGroup').value
    };
  }

  try {
    // We need to push to the specific subject's progress array
    const path = `centers/${centerId}/students/${selectedStudent.id}/subjects/${selectedSubjectIndex}/progress`;
    
    // To append to array in RTDB, we can just push or set index. 
    // Easier: fetch, modify, set. Or just set the new index if we know it.
    // Let's use update with a new index.
    
    const subRef = ref(db, path);
    const snap = await get(subRef);
    const currentProgress = snap.val() || [];
    
    // Add to array
    currentProgress.push(newProgress);
    
    await update(ref(db, `centers/${centerId}/students/${selectedStudent.id}`), {
      [`subjects/${selectedSubjectIndex}/progress`]: currentProgress
    });

    alert('Progress saved!');
    // Reload subject selection to update Previous fields
    document.getElementById('subjectSelect').dispatchEvent(new Event('change'));
  } catch (err) {
    alert('Error saving: ' + err.message);
  } finally {
    loader.classList.add('hidden');
  }
});

loadStudents();