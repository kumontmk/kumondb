import { auth, db, logout } from './auth.js';
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'parentOrientation';

// 🔐 PERMISSION CHECK
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    try {
        const userSnap = await get(ref(db, `users/${user.uid}`));
        if (!userSnap.exists()) {
            window.location.href = 'index.html';
            return;
        }

        const userData = userSnap.val();
        const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
        const dashPerms = userData.permissions?.dashboardCards || {};

        const hasAccess = isAdmin || dashPerms[REQUIRED_PERMISSION] === true;

        if (hasAccess) {
            // ✅ ALLOWED: Show content, hide error
            document.getElementById('accessDenied')?.classList.add('hidden');
            document.getElementById('mainContent')?.classList.remove('hidden');
            initializePO();
        } else {
            // 🚫 BLOCKED: Hide content, show error
            document.getElementById('accessDenied')?.classList.remove('hidden');
            document.getElementById('mainContent')?.classList.add('hidden');
            document.getElementById('page-loader')?.classList.add('hidden');

            document.getElementById('backToDashboardBtn')?.addEventListener('click', () => {
                window.location.href = 'dashboard.html'; 
            });
        }
    } catch (err) {
        console.error("Permission check error:", err);
        window.location.href = 'index.html';
    }
});

// ==========================================
//  MAIN APP LOGIC (Only runs if authorized)
// ==========================================
function initializePO() {
    const centerId = sessionStorage.getItem('selectedCenter');
    const tbody = document.getElementById('poTableBody');
    const searchInput = document.getElementById('searchInput');
    const refreshBtn = document.getElementById('refreshBtn');
    const noResults = document.getElementById('noResults');
    const poLoader = document.getElementById('poLoader');
    let allPendingStudents = [];

    function safeArray(val) {
        if (Array.isArray(val)) return val;
        if (val && typeof val === 'object') return Object.values(val);
        return [];
    }

    function formatSubjectLevel(sub) {
        if (!sub.name || sub.status === 'drop') return null;
        const level = sub.currentLevel || sub.startLevel || '-';
        const cleanName = sub.name
            .replace('English ', '')
            .replace('Chinese (Trad)', 'Chinese')
            .replace('Chinese  (Simp)', 'Chinese');
        return `${cleanName} ${level}`;
    }

    function getSubjectClass(subStr) {
        if (subStr.includes('Math')) return 'pill-Math';
        if (subStr.includes('Chinese')) return 'pill-Chinese';
        if (subStr.includes('ERP')) return 'pill-ERP';
        if (subStr.includes('EFL')) return 'pill-EFL';
        return 'pill-Math';
    }

    async function fetchPendingStudents() {
        if (!centerId) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state">⚠️ No center selected. Please log in via Dashboard.</td></tr>';
            return;
        }
        
        poLoader.classList.remove('hidden');
        tbody.innerHTML = '';

        try {
            const snap = await get(ref(db, `centers/${centerId}/students`));
            if (!snap.exists()) {
                allPendingStudents = [];
                renderTable();
                return;
            }

            allPendingStudents = [];
            const students = snap.val();

            for (const [id, s] of Object.entries(students)) {
                if (s.parentOrientation !== 'No') continue;

                const subjectsList = safeArray(s.subjects);
                const activeSubjects = [];
                let earliestEnrol = null;

                subjectsList.forEach(sub => {
                    if (sub.status !== 'drop') {
                        const formatted = formatSubjectLevel(sub);
                        if (formatted) activeSubjects.push(formatted);
                        if (!earliestEnrol || (sub.enrolDate && sub.enrolDate < earliestEnrol)) {
                            earliestEnrol = sub.enrolDate;
                        }
                    }
                });

                allPendingStudents.push({
                    id,
                    // ✅ FIX: Prioritize namePinyin so the "Student Name" column doesn't duplicate the "Nickname" column
                    name: s.namePinyin || s.nameCn || s.name || 'Unknown Student',
                    nameCn: s.nameCn || '-',
                    nickname: s.nickname || '-',
                    grade: s.grade || '-',
                    subjects: activeSubjects.length > 0 ? activeSubjects : ['No active subjects'],
                    enrolDate: earliestEnrol || '-',
                    poReason: s.poReason?.trim() || 'No reason provided.',
                    rawData: s
                });
            }

            renderTable();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="8" class="empty-state">❌ Error loading data: ${err.message}</td></tr>`;
            console.error(err);
        } finally {
            poLoader.classList.add('hidden');
        }
    }

    function renderTable(filter = '') {
        tbody.innerHTML = '';
        const lowerFilter = filter.toLowerCase().trim();
        
        const filtered = allPendingStudents.filter(s =>
            s.name.toLowerCase().includes(lowerFilter) ||
            s.nameCn.toLowerCase().includes(lowerFilter) ||
            s.nickname.toLowerCase().includes(lowerFilter) ||
            s.grade.toLowerCase().includes(lowerFilter) ||
            s.poReason.toLowerCase().includes(lowerFilter) ||
            s.subjects.some(sub => sub.toLowerCase().includes(lowerFilter))
        );

        const poTable = document.getElementById('poTable');

        if (filtered.length === 0) {
            noResults.classList.add('visible');
            poTable.style.display = 'none';
        } else {
            noResults.classList.remove('visible');
            poTable.style.display = 'table';

            filtered.forEach(s => {
                const tr = document.createElement('tr');
                const subjectPills = s.subjects.map(sub => 
                    `<span class="subj-pill ${getSubjectClass(sub)}">${sub}</span>`
                ).join(' ');

                tr.innerHTML = `
                    <td><strong>${s.name}</strong></td>
                    <td>${s.nameCn}</td>
                    <td>${s.nickname}</td>
                    <td>${s.grade}</td>
                    <td>${subjectPills}</td>
                    <td>${s.enrolDate}</td>
                    <td>${s.poReason}</td>
                    <td>
                        <a href="student-form.html?id=${s.id}" class="action-btn" title="Edit PO Status & Details">
                            ✏️ Edit
                        </a>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    searchInput.addEventListener('input', (e) => renderTable(e.target.value));
    refreshBtn.addEventListener('click', fetchPendingStudents);
    fetchPendingStudents();
}