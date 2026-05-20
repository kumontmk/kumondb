import { requireAuth, db } from './auth.js';
import { getDatabase, ref, get, push, update, remove, query, orderByChild, equalTo } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

if (!requireAuth()) exit;

const centerId = sessionStorage.getItem('selectedCenter');
const studentsRef = ref(db, `centers/${centerId}/students`);

// Load & display students
async function loadStudents(searchTerm = '') {
  const snapshot = await get(studentsRef);
  const container = document.getElementById('studentList');
  container.innerHTML = '';
  
  snapshot.forEach(child => {
    const student = child.val();
    const id = child.key;
    
    // Filter by search
    if (searchTerm && !matchesSearch(student, searchTerm)) return;
    
    const card = document.createElement('div');
    card.className = 'student-card';
    card.innerHTML = `
      <div>
        <strong>${student.nameEn}</strong> (${student.nameCn})<br>
        <small>#${student.studentNumber} | ${student.grade} | ${student.school}</small><br>
        <small>📚 ${student.subjects.map(s => `${s.name}: ${s.status}`).join(', ')}</small>
      </div>
      <div class="student-actions">
        <button onclick="window.location.href='student-form.html?id=${id}'">✏️</button>
        <button onclick="window.location.href='progress.html?student=${id}'">📈</button>
        <button class="delete-btn" data-id="${id}">🗑️</button>
      </div>
    `;
    container.appendChild(card);
  });
  
  // Delete handlers
  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.onclick = async (e) => {
      if (confirm('Delete this student?')) {
        await remove(ref(db, `centers/${centerId}/students/${e.target.dataset.id}`));
        loadStudents(document.getElementById('searchInput').value);
      }
    };
  });
}

function matchesSearch(student, term) {
  term = term.toLowerCase();
  return student.nameEn?.toLowerCase().includes(term) ||
         student.nameCn?.toLowerCase().includes(term) ||
         student.studentNumber?.toLowerCase().includes(term) ||
         student.school?.toLowerCase().includes(term);
}

// Search functionality
document.getElementById('searchInput')?.addEventListener('input', (e) => {
  loadStudents(e.target.value);
});

// Add student button
document.getElementById('addStudentBtn')?.addEventListener('click', () => {
  window.location.href = 'student-form.html';
});

// Initial load
loadStudents();

// Export for other modules
export { loadStudents };