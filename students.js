import { requireAuth, db } from './auth.js';
import { ref, get, remove } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) {}

const centerId = sessionStorage.getItem('selectedCenter');
const studentsRef = ref(db, `centers/${centerId}/students`);

async function loadStudents(searchTerm = '') {
  const loader = document.getElementById('loadingOverlay');
  const tbody = document.getElementById('studentList');
  loader?.classList.remove('hidden');

  try {
    // ✅ Updated colspan to 9 columns
    tbody.innerHTML = '<tr><td colspan="9" class="hint" style="text-align:center;">Loading...</td></tr>';
    const snapshot = await get(studentsRef);

    if (!snapshot.exists()) {
      tbody.innerHTML = '<tr><td colspan="9" class="hint" style="text-align:center; padding:1rem;">No students found. Click "+ Add Student" to begin.</td></tr>';
      return;
    }

    const rows = [];
    snapshot.forEach(child => {
      const student = child.val();
      const id = child.key;
      
      // ✅ Flatten subjects: 1 student with 2 subjects = 2 rows
      if (student.subjects && Array.isArray(student.subjects)) {
        student.subjects.forEach(sub => {
          if (searchTerm && !matchesSearch(student, sub.name, searchTerm)) return;
          rows.push({ 
            ...student, id, 
            subjectName: sub.name || '-',
            level: sub.startLevel || '-',
            enrolDate: sub.enrolDate || '-'
          });
        });
      } else {
        if (searchTerm && !matchesSearch(student, '-', searchTerm)) return;
        rows.push({ ...student, id, subjectName: '-', level: '-', enrolDate: '-' });
      }
    });

    tbody.innerHTML = '';
    rows.forEach(row => {
      // ✅ Format dates safely
      const dob = row.birthday ? new Date(row.birthday).toLocaleDateString('en-CA') : '-';
      const enrolDate = row.enrolDate && row.enrolDate !== '-' 
        ? new Date(row.enrolDate).toLocaleDateString('en-CA') 
        : '-';

      const tr = document.createElement('tr');
      tr.className = 'student-row';
      
      // ✅ 9 COLUMNS ONLY - Removed redundant "Name" column
      tr.innerHTML = `
        <td>${row.subjectName}</td>
        <td>${row.studentNumber || '-'}</td>
        <td>${row.nameCn || '-'}</td>
        <td>${row.nickname || '-'}</td>
        <td>${row.namePinyin || '-'}</td>
        <td>${dob}</td>
        <td>${row.grade || '-'}</td>
        <td>${row.level}</td>
        <td>${enrolDate}</td>
      `;
      
      tr.style.cursor = 'pointer';
      tr.onclick = (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        window.location.href = `student-form.html?id=${row.id}`;
      };
      
      tbody.appendChild(tr);
    });

  } catch (error) {
    console.error('Error loading students:', error);
    tbody.innerHTML = `<tr><td colspan="9" class="error">Error loading students: ${error.message}</td></tr>`;
  } finally {
    if (loader) setTimeout(() => loader.classList.add('hidden'), 300);
  }
}

function matchesSearch(student, subjectName, term) {
  if (!term) return true;
  term = term.toLowerCase();
  return (
    student.nameCn?.toLowerCase().includes(term) ||
    student.nickname?.toLowerCase().includes(term) ||
    student.namePinyin?.toLowerCase().includes(term) ||
    student.studentNumber?.toLowerCase().includes(term) ||
    student.grade?.toLowerCase().includes(term) ||
    student.school?.toLowerCase().includes(term) ||
    subjectName?.toLowerCase().includes(term)
  );
}

document.getElementById('searchInput')?.addEventListener('input', (e) => loadStudents(e.target.value));
document.getElementById('addStudentBtn')?.addEventListener('click', () => window.location.href = 'student-form.html');
document.getElementById('logoutBtn')?.addEventListener('click', () => { sessionStorage.removeItem('kumonAuth'); window.location.href = 'index.html'; });

loadStudents();