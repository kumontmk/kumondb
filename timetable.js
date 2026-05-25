// timetable.js
import { requireAuth, db } from './auth.js';
import { ref, get, onValue, off } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) {}
const centerId = sessionStorage.getItem('selectedCenter');
if (!centerId) { window.location.href = 'centers.html'; }
const studentsRef = ref(db, `centers/${centerId}/students`);

const daySelect = document.getElementById('timetableDay');
const timetableBody = document.getElementById('timetableBody');
let timetableUnsub = null;

function showLoader() { document.getElementById('page-loader')?.classList.remove('hidden'); }
function hideLoader() { document.getElementById('page-loader')?.classList.add('hidden'); }

const DAY_MAP = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

// 🕒 15-min intervals: M-F 14:00-19:15, S-S 10:00-16:15
function getTimeSlots(day) {
  const isWeekend = ['Saturday', 'Sunday'].includes(day);
  const slots = [];
  const startH = isWeekend ? 10 : 14;
  const endH = isWeekend ? 16 : 19;
  for (let h = startH; h <= endH; h++) {
    const minutes = (h === endH) ? ['00', '15'] : ['00', '15', '30', '45'];
    minutes.forEach(m => {
      if (h === endH && (m === '30' || m === '45')) return;
      slots.push(`${String(h).padStart(2, '0')}:${m}`);
    });
  }
  return slots;
}

function getSubjectGroup(name) {
  if (!name) return null;
  if (name === 'Math') return 'Math';
  if (name.includes('English')) return 'English';
  if (name === 'Chinese') return 'Chinese';
  return null;
}

// 🔍 Check if Math level is F or above
function isMathHighLevel(level) {
  if (!level) return false;
  // Matches F, G, H, I, J, K, L, M, N, O (and potential suffixes like F10)
  return /^[F-O]/i.test(level);
}

function loadTimetable() {
  if (!daySelect || !timetableBody) return;
  showLoader();
  if (timetableUnsub) { timetableUnsub(); timetableUnsub = null; }

  const cb = (snap) => {
    timetableBody.innerHTML = '';
    const day = daySelect.value;
    const timeSlots = getTimeSlots(day);
    
    // 5 groups: mathLow, mathHigh, english, chinese
    const schedule = {};
    timeSlots.forEach(t => schedule[t] = { mathLow: [], mathHigh: [], english: [], chinese: [] });

    snap.forEach(ch => {
      const s = ch.val();
      if (!s?.subjects) return;
      const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
      
      subjects.forEach(sub => {
        if (sub.status === 'drop' || !sub.timeslots) return;
        const group = getSubjectGroup(sub.name);
        if (!group) return;
        
        const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
        tsList.forEach(ts => {
          const tsDay = DAY_MAP[ts.day] || ts.day;
          if (tsDay === day && schedule[ts.time]) {
            const level = sub.currentLevel || sub.startLevel || '-';
            const ws = sub.currentWS ?? sub.startWS ?? 0;
            
            // ✅ EXACT LEVEL FORMAT (No zero padding)
            const levelWS = `${level}${ws}`;
            
            const studentObj = {
              grade: s.grade || '-',
              name: `${s.nameCn || '-'}${s.nickname ? ` (${s.nickname})` : ''}`,
              level: levelWS
            };

            if (group === 'Math') {
              if (isMathHighLevel(level)) schedule[ts.time].mathHigh.push(studentObj);
              else schedule[ts.time].mathLow.push(studentObj);
            } else if (group === 'English') {
              schedule[ts.time].english.push(studentObj);
            } else if (group === 'Chinese') {
              schedule[ts.time].chinese.push(studentObj);
            }
          }
        });
      });
    });

    // Sort by grade within each group
    Object.values(schedule).forEach(slot => {
      Object.values(slot).forEach(arr => arr.sort((a, b) => a.grade.localeCompare(b.grade)));
    });

    // Build rows
    timeSlots.forEach(time => {
      const s = schedule[time];
      // Max students across all 4 groups
      const maxRows = Math.max(s.mathLow.length, s.mathHigh.length, s.english.length, s.chinese.length);
      // ✅ FORCE 2 EMPTY ROWS IF NO STUDENTS
      const rowCount = maxRows === 0 ? 2 : maxRows;

      for (let i = 0; i < rowCount; i++) {
        const row = document.createElement('tr');
        
        if (i === 0) {
          const timeCell = document.createElement('td');
          timeCell.textContent = time;
          timeCell.className = 'time-cell';
          timeCell.rowSpan = rowCount;
          row.appendChild(timeCell);
        }

        const addSubjectCells = (arr) => {
          if (arr[i]) {
            row.appendChild(createCell(arr[i].grade));
            row.appendChild(createCell(arr[i].name));
            row.appendChild(createCell(arr[i].level));
          } else {
            row.appendChild(createCell('', true));
            row.appendChild(createCell('', true));
            row.appendChild(createCell('', true));
          }
        };

        addSubjectCells(s.mathLow);
        addSubjectCells(s.mathHigh);
        addSubjectCells(s.english);
        addSubjectCells(s.chinese);
        timetableBody.appendChild(row);
      }
    });

    hideLoader();
  };

function createCell(content, isEmpty = false) {
  const td = document.createElement('td');
  td.textContent = content;
  if (isEmpty) td.className = 'empty-cell';
  // ✅ REMOVED: td.style.verticalAlign & td.style.padding
  return td;
}

  onValue(studentsRef, cb);
  timetableUnsub = () => off(studentsRef, 'value', cb);
}

if (daySelect) {
  daySelect.addEventListener('change', loadTimetable);
  loadTimetable();
}

document.getElementById('printTimetable')?.addEventListener('click', () => window.print());
window.addEventListener('beforeunload', () => { if (timetableUnsub) timetableUnsub(); });