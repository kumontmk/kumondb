import { requireAuth, db } from './auth.js';
import { ref, get } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) {}

const centerId = sessionStorage.getItem('selectedCenter');
const studentsRef = ref(db, `centers/${centerId}/students`);
const loader = document.getElementById('loadingOverlay');

let allStudents = [];

// ✅ Load Data & Render Charts
async function initGraphs() {
  loader.classList.remove('hidden');
  try {
    const snapshot = await get(studentsRef);
    allStudents = [];
    snapshot.forEach(child => allStudents.push(child.val()));

    populateDropdowns();
    renderAggregateChart();
    
    // Initial progress chart render
    renderProgressChart(); 
  } catch (err) { console.error(err); }
  finally { loader.classList.add('hidden'); }
}

// Dropdowns for Individual Chart
function populateDropdowns() {
  const stuSelect = document.getElementById('progressStudent');
  const subSelect = document.getElementById('progressSubject');
  
  allStudents.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.studentNumber; // Use studentNumber as ID
    opt.textContent = `${s.nameEn} (${s.studentNumber})`;
    stuSelect.appendChild(opt);
  });

  // Static subjects list
  ['Math', 'Chinese', 'English ERP', 'English EFL'].forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub;
    opt.textContent = sub;
    subSelect.appendChild(opt);
  });

  stuSelect.addEventListener('change', renderProgressChart);
  subSelect.addEventListener('change', renderProgressChart);
}

// Chart 1: Aggregate Students per Month
let studentsChartInstance = null;
function renderAggregateChart() {
  const ctx = document.getElementById('studentsChart').getContext('2d');
  const dataByMonth = {}; // { "2026-05": { Math: 10, Chinese: 5 } }
  const months = [];
  
  // Gather months
  allStudents.forEach(s => {
    s.subjects.forEach(sub => {
      if (sub.progress) {
        sub.progress.forEach(p => {
          if (!dataByMonth[p.month]) dataByMonth[p.month] = {};
          const count = dataByMonth[p.month][sub.name] || 0;
          dataByMonth[p.month][sub.name] = count + 1;
        });
      }
    });
  });

  const sortedMonths = Object.keys(dataByMonth).sort();
  const subjects = ['Math', 'Chinese', 'English ERP', 'English EFL'];
  
  const datasets = subjects.map(sub => ({
    label: sub,
    data: sortedMonths.map(m => dataByMonth[m]?.[sub] || 0),
    backgroundColor: `rgba(${Math.random()*255},${Math.random()*255},${Math.random()*255}, 0.5)`
  }));

  if (studentsChartInstance) studentsChartInstance.destroy();
  studentsChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels: sortedMonths, datasets },
    options: { responsive: true, scales: { y: { beginAtZero: true } } }
  });
}

// Chart 2: Individual Progress
let progressChartInstance = null;
function renderProgressChart() {
  const stuNum = document.getElementById('progressStudent').value;
  const subName = document.getElementById('progressSubject').value;
  const ctx = document.getElementById('progressChart').getContext('2d');
  
  if (!stuNum || !subName) return;

  const student = allStudents.find(s => s.studentNumber === stuNum);
  const subject = student?.subjects?.find(s => s.name === subName);
  
  if (!subject || !subject.progress?.length) {
    if (progressChartInstance) progressChartInstance.destroy();
    return; // No data
  }

  const data = subject.progress.sort((a,b) => a.month.localeCompare(b.month));
  
  if (progressChartInstance) progressChartInstance.destroy();
  progressChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => d.month),
      datasets: [{
        label: `${subName} Level`,
        data: data.map(d => d.currLevel),
        borderColor: '#87CEEB',
        tension: 0.3,
        fill: false
      }]
    },
    options: { responsive: true }
  });
}

initGraphs();