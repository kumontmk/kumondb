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
            document.getElementById('accessDenied')?.classList.add('hidden');
            document.getElementById('mainContent')?.classList.remove('hidden');
            initializeFollowUps();
        } else {
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
//  MAIN APP LOGIC
// ==========================================
function initializeFollowUps() {
    const centerId = sessionStorage.getItem('selectedCenter');
    const searchInput = document.getElementById('searchInput');
    const refreshBtn = document.getElementById('refreshBtn');

    // Tab switching
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        });
    });

    // Shared data cache
    let allStudents = [];
    let pendingPOList = [];
    let inquiryList = [];

    // ==========================================
    // 🔧 HELPERS
    // ==========================================
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
            .replace('Chinese   (Simp)', 'Chinese');
        return `${cleanName} ${level}`;
    }

    function getSubjectClass(subStr) {
        if (subStr.includes('Math')) return 'pill-Math';
        if (subStr.includes('Chinese')) return 'pill-Chinese';
        if (subStr.includes('ERP')) return 'pill-ERP';
        if (subStr.includes('EFL')) return 'pill-EFL';
        return 'pill-Math';
    }

    // ✅ Check DT status for a student's subjects
    function checkDTStatus(student) {
        const subjects = safeArray(student.subjects).filter(s => s.status !== 'drop');
        if (subjects.length === 0) {
            return { status: 'no', done: 0, total: 0, details: 'No active subjects' };
        }

        const dts = safeArray(student.diagnosticTests);
        let doneCount = 0;
        const doneSubjects = [];
        const missingSubjects = [];

        subjects.forEach(sub => {
            const subName = (sub.name || '').toLowerCase();
            const hasDT = dts.some(dt => {
                const dtSubject = (dt.subject || '').toLowerCase();
                return dtSubject && (
                    subName.includes(dtSubject) ||
                    dtSubject.includes(subName) ||
                    (subName.includes('math') && dtSubject.includes('math')) ||
                    (subName.includes('chinese') && dtSubject.includes('chinese')) ||
                    (subName.includes('erp') && dtSubject.includes('erp')) ||
                    (subName.includes('efl') && dtSubject.includes('efl'))
                );
            });

            if (hasDT) {
                doneCount++;
                doneSubjects.push(sub.name);
            } else {
                missingSubjects.push(sub.name);
            }
        });

        let status;
        if (doneCount === subjects.length) status = 'yes';
        else if (doneCount === 0) status = 'no';
        else status = 'partial';

        const details = `✅ Done: ${doneSubjects.join(', ') || 'none'}\n⏳ Missing: ${missingSubjects.join(', ') || 'none'}`;
        return { status, done: doneCount, total: subjects.length, details };
    }

    function renderDTBadge(dtInfo) {
        if (dtInfo.total === 0) {
            return `<span class="dt-badge dt-no" title="No active subjects">—</span>`;
        }
        const cls = dtInfo.status === 'yes' ? 'dt-yes'
                  : dtInfo.status === 'partial' ? 'dt-partial' : 'dt-no';
        const icon = dtInfo.status === 'yes' ? '✅'
                   : dtInfo.status === 'partial' ? '⚠️' : '❌';
        const label = `${dtInfo.done}/${dtInfo.total}`;
        return `<span class="dt-badge ${cls}" title="${dtInfo.details}">${icon} ${label}</span>`;
    }

    // ==========================================
    // 📥 FETCH ALL STUDENTS
    // ==========================================
    async function fetchAllStudents() {
        if (!centerId) { 
            document.getElementById('poTableBody').innerHTML =
                `<tr><td colspan="8" class="empty-state">⚠️ No center selected. Please log in via Dashboard.</td></tr>`;
            return;
        }

        document.getElementById('poLoader').classList.remove('hidden');
        document.getElementById('inquiryLoader').classList.remove('hidden');

        try {
            const snap = await get(ref(db, `centers/${centerId}/students`));
            if (!snap.exists()) {
                allStudents = [];
                buildLists();
                return;
            }

            const students = snap.val();
            allStudents = Object.entries(students).map(([id, s]) => {
                const subjectsList = safeArray(s.subjects);
                const activeSubjects = [];
                const inquirySubjects = [];   // ✅ NEW: track inquiry-status subjects
                let earliestEnrol = null;
                let earliestInquiry = null;   // ✅ NEW: find earliest inquiryDate

                subjectsList.forEach(sub => {
                    if (sub.status === 'drop') return;

                    const formatted = formatSubjectLevel(sub);
                    if (formatted) activeSubjects.push(formatted);

                    // Track enrolDate for non-inquiry subjects
                    if (sub.status !== 'inquiry' && sub.enrolDate) {
                        if (!earliestEnrol || sub.enrolDate < earliestEnrol) {
                            earliestEnrol = sub.enrolDate;
                        }
                    }

                    // ✅ Track inquiryDate for inquiry-status subjects
                    if (sub.status === 'inquiry' && sub.inquiryDate) {
                        inquirySubjects.push(sub);
                        if (!earliestInquiry || sub.inquiryDate < earliestInquiry) {
                            earliestInquiry = sub.inquiryDate;
                        }
                    }
                });

                return {
                    id,
                    name: s.namePinyin || s.nameCn || s.name || 'Unknown Student',
                    nameCn: s.nameCn || '-',
                    nickname: s.nickname || '-',
                    grade: s.grade || '-',
                    subjects: activeSubjects.length > 0 ? activeSubjects : ['No active subjects'],
                    enrolDate: earliestEnrol || '-',
                    inquiryDate: earliestInquiry || '-',        // ✅ Now pulled from subjects
                    hasInquiry: inquirySubjects.length > 0,     // ✅ NEW flag
                    inquirySubjects,                            // ✅ NEW: for display
                    poReason: s.poReason?.trim() || 'No reason provided.',
                    parentOrientation: s.parentOrientation,
                    rawData: s
                };
            });

            buildLists();
        } catch (err) {
            document.getElementById('poTableBody').innerHTML =
                `<tr><td colspan="8" class="empty-state">❌ Error: ${err.message}</td></tr>`;
            console.error(err);
        } finally {
            document.getElementById('poLoader').classList.add('hidden');
            document.getElementById('inquiryLoader').classList.add('hidden');
        }
    }

    // ==========================================
    // 🔀 SPLIT INTO TWO LISTS
    // ==========================================
    function buildLists() {
        // Tab 1: Pending PO → parentOrientation === 'No'
        pendingPOList = allStudents.filter(s => s.parentOrientation === 'No');

        // Tab 2: Inquiries → students with at least one subject in 'inquiry' status
        inquiryList = allStudents
            .filter(s => s.hasInquiry)   // ✅ Use the new flag
            .sort((a, b) => {
                const da = a.inquiryDate || '';
                const db2 = b.inquiryDate || '';
                return db2.localeCompare(da);
            });

        renderPOTable();
        renderInquiryTable();
    }

    // ==========================================
    // 📋 RENDER TAB 1: PENDING PO
    // ==========================================
    function renderPOTable(filter = '') {
        const tbody = document.getElementById('poTableBody');
        const noResults = document.getElementById('noResults');
        const poTable = document.getElementById('poTable');
        tbody.innerHTML = '';
        const lf = filter.toLowerCase().trim();

        const filtered = pendingPOList.filter(s =>
            s.name.toLowerCase().includes(lf) ||
            s.nameCn.toLowerCase().includes(lf) ||
            s.nickname.toLowerCase().includes(lf) ||
            s.grade.toLowerCase().includes(lf) ||
            s.poReason.toLowerCase().includes(lf) ||
            s.subjects.some(sub => sub.toLowerCase().includes(lf))
        );

        if (filtered.length === 0) {
            noResults.classList.add('visible');
            poTable.style.display = 'none';
        } else {
            noResults.classList.remove('visible');
            poTable.style.display = 'table';
            filtered.forEach(s => {
                const pills = s.subjects.map(sub =>
                    `<span class="subj-pill ${getSubjectClass(sub)}">${sub}</span>`
                ).join(' ');
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${s.name}</strong></td>
                    <td>${s.nameCn}</td>
                    <td>${s.nickname}</td>
                    <td>${s.grade}</td>
                    <td>${pills}</td>
                    <td>${s.enrolDate}</td>
                    <td>${s.poReason}</td>
                    <td>
                        <a href="student-form.html?id=${s.id}" class="action-btn" title="Edit">
                            ✏️ Edit
                        </a>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    // ==========================================
    // 📋 RENDER TAB 2: INQUIRIES
    // ==========================================
    function renderInquiryTable(filter = '') {
        const tbody = document.getElementById('inquiryTableBody');
        const noResults = document.getElementById('noInquiryResults');
        const table = document.getElementById('inquiryTable');
        tbody.innerHTML = '';
        const lf = filter.toLowerCase().trim();

        const filtered = inquiryList.filter(s =>
            s.name.toLowerCase().includes(lf) ||
            s.nameCn.toLowerCase().includes(lf) ||
            s.nickname.toLowerCase().includes(lf) ||
            s.grade.toLowerCase().includes(lf) ||
            s.subjects.some(sub => sub.toLowerCase().includes(lf))
        );

        if (filtered.length === 0) {
            noResults.classList.add('visible');
            table.style.display = 'none';
        } else {
            noResults.classList.remove('visible');
            table.style.display = 'table';
            filtered.forEach(s => {
                const pills = s.subjects.map(sub =>
                    `<span class="subj-pill ${getSubjectClass(sub)}">${sub}</span>`
                ).join(' ');
                const dtInfo = checkDTStatus(s.rawData);
                const dtBadge = renderDTBadge(dtInfo);

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${s.name}</strong></td>
                    <td>${s.nameCn}</td>
                    <td>${s.nickname}</td>
                    <td>${s.grade}</td>
                    <td>${pills}</td>
                    <td>${s.inquiryDate}</td>
                    <td>${dtBadge}</td>
                    <td>
                        <a href="student-form.html?id=${s.id}" class="action-btn" title="Edit">
                            ✏️ Edit
                        </a>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    // ==========================================
    // 🔗 EVENT LISTENERS
    // ==========================================
    searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        renderPOTable(val);
        renderInquiryTable(val);
    });
    refreshBtn.addEventListener('click', fetchAllStudents);

    fetchAllStudents();
}