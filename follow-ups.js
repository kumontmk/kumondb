import { auth, db, logout } from './auth.js';
import { ref, get, set } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'parentOrientation';
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// 🔐 PERMISSION CHECK
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'index.html'; return; }
    try {
        const userSnap = await get(ref(db, `users/${user.uid}`));
        if (!userSnap.exists()) { window.location.href = 'index.html'; return; }

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
    let pauseFollowUpList = [];   // ✅ NEW

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
            .replace('Chinese (Simp)', 'Chinese');
        return `${cleanName} ${level}`;
    }

    function getSubjectClass(subStr) {
        if (subStr.includes('Math')) return 'pill-Math';
        if (subStr.includes('Chinese')) return 'pill-Chinese';
        if (subStr.includes('ERP')) return 'pill-ERP';
        if (subStr.includes('EFL')) return 'pill-EFL';
        return 'pill-Math';
    }

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
                    subName.includes(dtSubject) || dtSubject.includes(subName) ||
                    (subName.includes('math') && dtSubject.includes('math')) ||
                    (subName.includes('chinese') && dtSubject.includes('chinese')) ||
                    (subName.includes('erp') && dtSubject.includes('erp')) ||
                    (subName.includes('efl') && dtSubject.includes('efl'))
                );
            });
            if (hasDT) { doneCount++; doneSubjects.push(sub.name); }
            else { missingSubjects.push(sub.name); }
        });

        let status;
        if (doneCount === subjects.length) status = 'yes';
        else if (doneCount === 0) status = 'no';
        else status = 'partial';

        const details = `✅ Done: ${doneSubjects.join(', ') || 'none'}\n⏳ Missing: ${missingSubjects.join(', ') || 'none'}`;
        return { status, done: doneCount, total: subjects.length, details };
    }

    function renderDTBadge(dtInfo) {
        if (dtInfo.total === 0) return `<span class="dt-badge dt-no" title="No active subjects">—</span>`;
        const cls = dtInfo.status === 'yes' ? 'dt-yes' : dtInfo.status === 'partial' ? 'dt-partial' : 'dt-no';
        const icon = dtInfo.status === 'yes' ? '✅' : dtInfo.status === 'partial' ? '⚠️' : '❌';
        const label = `${dtInfo.done}/${dtInfo.total}`;
        return `<span class="dt-badge ${cls}" title="${dtInfo.details}">${icon} ${label}</span>`;
    }

    // ==========================================
    // ✅ PAUSE FOLLOW-UP DATE CALCULATOR
    // ==========================================
    function getPauseFollowUpInfo(sub) {
        if (sub.status !== 'pause' || !sub.pauseToMonth || !sub.pauseToYear) return null;

        const toMonth = parseInt(sub.pauseToMonth);
        const toYear = parseInt(sub.pauseToYear);

        // Pause ends on the LAST DAY of pauseToMonth
        // new Date(year, month, 0) → last day of previous month
        // So new Date(2026, 7, 0) = July 31, 2026 (month 7 = August in 0-indexed)
        const pauseEnd = new Date(toYear, toMonth, 0);
        pauseEnd.setHours(23, 59, 59, 999);

        // Follow-up date = 10 days before pause end
        const followUpDate = new Date(pauseEnd);
        followUpDate.setDate(followUpDate.getDate() - 10);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Only include if today >= followUpDate (i.e., we're within 10 days of pause end or past it)
        if (today < followUpDate) return null;

        const fromMonth = parseInt(sub.pauseFromMonth || '01');
        const fromYear = parseInt(sub.pauseFromYear || toYear);

        return {
            pauseFrom: `${MONTH_SHORT[fromMonth - 1]} ${fromYear}`,
            pauseTo: `${MONTH_SHORT[toMonth - 1]} ${toYear}`,
            pauseEnd,
            followUpDate,
            isOverdue: today > pauseEnd
        };
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
        document.getElementById('pauseLoader').classList.remove('hidden');

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
                const inquirySubjects = [];
                const pausedSubjects = [];   // ✅ NEW
                let earliestEnrol = null;
                let earliestInquiry = null;

                subjectsList.forEach((sub, idx) => {
                    if (sub.status === 'drop') return;

                    const formatted = formatSubjectLevel(sub);
                    if (formatted) activeSubjects.push(formatted);

                    // Track enrolDate for non-inquiry subjects
                    if (sub.status !== 'inquiry' && sub.enrolDate) {
                        if (!earliestEnrol || sub.enrolDate < earliestEnrol) {
                            earliestEnrol = sub.enrolDate;
                        }
                    }

                    // Track inquiryDate
                    if (sub.status === 'inquiry' && sub.inquiryDate) {
                        inquirySubjects.push(sub);
                        if (!earliestInquiry || sub.inquiryDate < earliestInquiry) {
                            earliestInquiry = sub.inquiryDate;
                        }
                    }

                    // ✅ Check for pause follow-up eligibility
                    const pauseInfo = getPauseFollowUpInfo(sub);
                    if (pauseInfo) {
                        pausedSubjects.push({
                            index: idx,
                            name: sub.name || 'Unknown',
                            currentLevel: sub.currentLevel || sub.startLevel || '-',
                            ...pauseInfo
                        });
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
                    inquiryDate: earliestInquiry || '-',
                    hasInquiry: inquirySubjects.length > 0,
                    inquirySubjects,
                    pausedSubjects,            // ✅ NEW
                    hasPausedSubjects: pausedSubjects.length > 0,  // ✅ NEW
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
            document.getElementById('pauseLoader').classList.add('hidden');
        }
    }

    // ==========================================
    // 🔀 SPLIT INTO THREE LISTS
    // ==========================================
    function buildLists() {
        // Tab 1: Pending PO → parentOrientation === 'No'
        pendingPOList = allStudents.filter(s => s.parentOrientation === 'No');

        // Tab 2: Inquiries
        inquiryList = allStudents
            .filter(s => s.hasInquiry)
            .sort((a, b) => {
                const da = a.inquiryDate || '';
                const db2 = b.inquiryDate || '';
                return db2.localeCompare(da);
            });

        // ✅ Tab 3: Pause Follow-Up → students with paused subjects within 10 days of end
        pauseFollowUpList = allStudents
            .filter(s => s.hasPausedSubjects)
            .sort((a, b) => {
                // Sort by earliest follow-up date (most urgent first)
                const aDate = Math.min(...a.pausedSubjects.map(p => p.followUpDate.getTime()));
                const bDate = Math.min(...b.pausedSubjects.map(p => p.followUpDate.getTime()));
                return aDate - bDate;
            });

        renderPOTable();
        renderInquiryTable();
        renderPauseFollowUpTable();   // ✅ NEW
        updateBadges();               // ✅ NEW
    }

    // ==========================================
    // ✅ UPDATE TAB BADGES
    // ==========================================
    function updateBadges() {
        const poBadge = document.getElementById('poBadge');
        const inquiryBadge = document.getElementById('inquiryBadge');
        const pauseBadge = document.getElementById('pauseBadge');

        poBadge.textContent = pendingPOList.length;
        inquiryBadge.textContent = inquiryList.length;
        pauseBadge.textContent = pauseFollowUpList.length;

        poBadge.classList.toggle('zero', pendingPOList.length === 0);
        inquiryBadge.classList.toggle('zero', inquiryList.length === 0);
        pauseBadge.classList.toggle('zero', pauseFollowUpList.length === 0);
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
                        <a href="student-form.html?id=${s.id}" class="action-btn" title="Edit">✏️ Edit</a>
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
                        <a href="student-form.html?id=${s.id}" class="action-btn" title="Edit">✏️ Edit</a>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    // ==========================================
    // ✅ RENDER TAB 3: PAUSE FOLLOW-UP
    // ==========================================
    function renderPauseFollowUpTable(filter = '') {
        const tbody = document.getElementById('pauseTableBody');
        const noResults = document.getElementById('noPauseResults');
        const table = document.getElementById('pauseTable');
        tbody.innerHTML = '';
        const lf = filter.toLowerCase().trim();

        const filtered = pauseFollowUpList.filter(s =>
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

                // Format pause durations
                const pauseDurations = s.pausedSubjects.map(p => {
                    const overdueTag = p.isOverdue ? ' <span class="overdue-tag">OVERDUE</span>' : '';
                    return `${p.pauseFrom} → ${p.pauseTo}${overdueTag}`;
                }).join('<br>');

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${s.name}</strong></td>
                    <td>${s.nameCn}</td>
                    <td>${s.nickname}</td>
                    <td>${s.grade}</td>
                    <td>${pills}</td>
                    <td class="pause-duration-cell">${pauseDurations}</td>
                    <td class="pause-actions-cell">
                        <button class="pause-action-btn drop" 
                                data-student-id="${s.id}" 
                                data-action="drop"
                                title="Change paused subject(s) to Drop">
                            ✖ Dropped
                        </button>
                        <button class="pause-action-btn continue" 
                                data-student-id="${s.id}" 
                                data-action="continue"
                                title="Change paused subject(s) back to Current">
                            ✔ Continue
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    // ==========================================
    // ✅ PAUSE ACTION HANDLERS (Event Delegation)
    // ==========================================
    document.getElementById('pauseTableBody').addEventListener('click', async (e) => {
        const btn = e.target.closest('.pause-action-btn');
        if (!btn) return;

        const studentId = btn.dataset.studentId;
        const action = btn.dataset.action;   // 'drop' or 'continue'
        const student = allStudents.find(s => s.id === studentId);
        if (!student) return;

        const pausedNames = student.pausedSubjects.map(p => p.name).join(', ');
        const actionLabel = action === 'drop' ? 'DROP' : 'CONTINUE';
        const actionDesc = action === 'drop'
            ? `This will change the status of paused subject(s) to "Drop".`
            : `This will change the status of paused subject(s) back to "Current".`;

        if (!confirm(`⚠️ Confirm ${actionLabel} for ${student.name}?\n\nPaused subject(s): ${pausedNames}\n\n${actionDesc}`)) {
            return;
        }

        btn.disabled = true;
        btn.textContent = '⏳ Saving...';

        try {
            const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");

            const studentData = snap.val();
            let subjects = safeArray(studentData.subjects);

            // Update each paused subject
            student.pausedSubjects.forEach(ps => {
                const sub = subjects[ps.index];
                if (!sub) return;

                if (action === 'drop') {
                    sub.status = 'drop';
                    const now = new Date();
                    sub.dropMonth = String(now.getMonth() + 1).padStart(2, '0');
                    sub.dropYear = String(now.getFullYear());
                    sub.dropReason = sub.dropReason || 'Confirmed drop after pause follow-up';
                } else {
                    sub.status = 'current';
                }
            });

            studentData.subjects = subjects;
            studentData.updatedAt = new Date().toISOString();

            await set(studentRef, studentData);

            // Refresh data
            await fetchAllStudents();
            alert(`✅ ${student.name} — ${actionLabel} confirmed successfully!`);
        } catch (err) {
            console.error("Pause action error:", err);
            alert('❌ Failed to save: ' + err.message);
            btn.disabled = false;
            btn.textContent = action === 'drop' ? '✖ Dropped' : '✔ Continue';
        }
    });

    // ==========================================
    // 🔗 EVENT LISTENERS
    // ==========================================
    searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        renderPOTable(val);
        renderInquiryTable(val);
        renderPauseFollowUpTable(val);   // ✅ NEW
    });
    refreshBtn.addEventListener('click', fetchAllStudents);

    fetchAllStudents();
}