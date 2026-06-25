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
    let pauseFollowUpList = []; 

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
        if (subjects.length === 0) return { status: 'no', done: 0, total: 0, details: 'No active subjects' };
        
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
    // ✅ PAUSE FOLLOW-UP INFO (No date filtering)
    // ==========================================
    function getPauseFollowUpInfo(sub) {
        if (sub.status !== 'pause') return null;

        const toMonth = parseInt(sub.pauseToMonth);
        const toYear = parseInt(sub.pauseToYear);
        const fromMonth = parseInt(sub.pauseFromMonth || '01');
        const fromYear = parseInt(sub.pauseFromYear || toYear);

        let pauseEnd = null;
        let isOverdue = false;

        if (toMonth && toYear) {
            pauseEnd = new Date(toYear, toMonth, 0); 
            pauseEnd.setHours(23, 59, 59, 999);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            isOverdue = today > pauseEnd;
        }

        return {
            pauseFrom: `${MONTH_SHORT[fromMonth - 1]} ${fromYear}`,
            pauseTo: toMonth ? `${MONTH_SHORT[toMonth - 1]} ${toYear}` : 'Open',
            pauseEnd,
            isOverdue,
            hasPendingReturn: !!sub.pendingReturn,
            pendingReturnMonth: sub.pendingReturn?.month,
            pendingReturnYear: sub.pendingReturn?.year
        };
    }

    // ==========================================
    // 📥 FETCH ALL STUDENTS & AUTO-EXECUTE RETURNS
    // ==========================================
    async function fetchAllStudents() {
        if (!centerId) {
            document.getElementById('poTableBody').innerHTML = `<tr><td colspan="8" class="empty-state">⚠️ No center selected.</td></tr>`;
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
            const now = new Date();
            const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
            const currentYear = String(now.getFullYear());
            const updates = [];

            allStudents = Object.entries(students).map(([id, s]) => {
                let studentChanged = false;
                
                // 🆕 Auto-execute pending returns in background
                if (s.subjects) {
                    const subjects = safeArray(s.subjects);
                    subjects.forEach(sub => {
                        if (sub.status === 'pause' && sub.pendingReturn) {
                            const pr = sub.pendingReturn;
                            if (pr.year < currentYear || (pr.year === currentYear && pr.month <= currentMonth)) {
                                sub.status = 'current';
                                delete sub.pendingReturn;
                                studentChanged = true;
                            }
                        }
                    });
                    if (studentChanged) {
                        s.subjects = subjects;
                        s.updatedAt = new Date().toISOString();
                        updates.push({ id, data: s });
                    }
                }

                const subjectsList = safeArray(s.subjects);
                const activeSubjects = [];
                const allSubjectsDisplay = []; // 🆕 Track all subjects for display
                const inquirySubjects = [];
                const pausedSubjects = [];
                let earliestEnrol = null;
                let earliestInquiry = null;
                
                // 🆕 Track paused and dropped counts
                let pausedCount = 0;
                let droppedCount = 0;

                subjectsList.forEach((sub, idx) => {
                    if (!sub.name) return; // 🆕 Safety check

                    const level = sub.currentLevel || sub.startLevel || '-';
                    const cleanName = sub.name
                        .replace('English ', '')
                        .replace('Chinese (Trad)', 'Chinese')
                        .replace('Chinese (Simp)', 'Chinese');

                    // 🆕 Build display object for all subjects
                    allSubjectsDisplay.push({
                        name: cleanName,
                        level: level,
                        status: sub.status || 'current',
                        displayText: `${cleanName} ${level}`
                    });

                    if (sub.status === 'drop') {
                        droppedCount++;
                        return;
                    }
                    if (sub.status === 'pause') {
                        pausedCount++;
                    }

                    const formatted = formatSubjectLevel(sub);
                    if (formatted) activeSubjects.push(formatted);

                    if (sub.status !== 'inquiry' && sub.enrolDate) {
                        if (!earliestEnrol || sub.enrolDate < earliestEnrol) earliestEnrol = sub.enrolDate;
                    }

                    if (sub.status === 'inquiry' && sub.inquiryDate) {
                        inquirySubjects.push(sub);
                        if (!earliestInquiry || sub.inquiryDate < earliestInquiry) earliestInquiry = sub.inquiryDate;
                    }

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
                    allSubjectsDisplay, // 🆕 Added
                    enrolDate: earliestEnrol || '-',
                    inquiryDate: earliestInquiry || '-',
                    hasInquiry: inquirySubjects.length > 0,
                    inquirySubjects,
                    pausedSubjects,
                    hasPausedSubjects: pausedSubjects.length > 0,
                    poReason: s.poReason?.trim() || 'No reason provided.',
                    parentOrientation: s.parentOrientation,
                    rawData: s,
                    pausedCount,   // 🆕 Added
                    droppedCount   // 🆕 Added
                };
            });

            // Save auto-executed returns in background
            if (updates.length > 0) {
                console.log(`⏳ Auto-executing ${updates.length} pending return(s)...`);
                updates.forEach(u => {
                    set(ref(db, `centers/${centerId}/students/${u.id}`), u.data).catch(err => {
                        console.error(`Failed to auto-execute return for ${u.id}:`, err);
                    });
                });
            }

            buildLists();
        } catch (err) {
            document.getElementById('poTableBody').innerHTML = `<tr><td colspan="8" class="empty-state">❌ Error: ${err.message}</td></tr>`;
            console.error(err);
        } finally {
            document.getElementById('poLoader').classList.add('hidden');
            document.getElementById('inquiryLoader').classList.add('hidden');
            document.getElementById('pauseLoader').classList.add('hidden');
        }
    }

    // ==========================================
    // 🔀 SPLIT INTO LISTS
    // ==========================================
    function buildLists() {
        pendingPOList = allStudents.filter(s => s.parentOrientation === 'No');

        inquiryList = allStudents.filter(s => s.hasInquiry).sort((a, b) => {
            return (b.inquiryDate || '').localeCompare(a.inquiryDate || '');
        });

        // 🆕 Flatten paused subjects into individual rows
        pauseFollowUpList = [];
        allStudents.forEach(s => {
            s.pausedSubjects.forEach(p => {
                pauseFollowUpList.push({
                    studentId: s.id,
                    studentName: s.name,
                    nameCn: s.nameCn,
                    nickname: s.nickname,
                    grade: s.grade,
                    subjectIndex: p.index,
                    subjectName: p.name,
                    subjectLevel: p.currentLevel,
                    ...p
                });
            });
        });

        // Sort: Overdue first, then no pending return, then pending return (by date)
        pauseFollowUpList.sort((a, b) => {
            if (a.isOverdue && !b.isOverdue) return -1;
            if (!a.isOverdue && b.isOverdue) return 1;
            
            if (a.hasPendingReturn && b.hasPendingReturn) {
                const dateA = new Date(a.pendingReturnYear, a.pendingReturnMonth - 1);
                const dateB = new Date(b.pendingReturnYear, b.pendingReturnMonth - 1);
                return dateA - dateB;
            }
            if (a.hasPendingReturn) return 1; 
            if (b.hasPendingReturn) return -1;
            
            return 0;
        });

        renderPOTable();
        renderInquiryTable();
        renderPauseFollowUpTable();
        updateBadges();
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
    // 📋 RENDER TAB 1 & 2
    // ==========================================
    function renderPOTable(filter = '') {
        const tbody = document.getElementById('poTableBody');
        const noResults = document.getElementById('noResults');
        const poTable = document.getElementById('poTable');
        tbody.innerHTML = '';
        const lf = filter.toLowerCase().trim();

        // 🆕 Updated filter to search through all subjects (including dropped)
        const filtered = pendingPOList.filter(s =>
            s.name.toLowerCase().includes(lf) || s.nameCn.toLowerCase().includes(lf) ||
            s.nickname.toLowerCase().includes(lf) || s.grade.toLowerCase().includes(lf) ||
            s.poReason.toLowerCase().includes(lf) || s.allSubjectsDisplay.some(sub => sub.displayText.toLowerCase().includes(lf))
        );

        if (filtered.length === 0) {
            noResults.classList.add('visible'); poTable.style.display = 'none';
        } else {
            noResults.classList.remove('visible'); poTable.style.display = 'table';
            filtered.forEach(s => {
                // 🆕 Render pills with specific status badges attached
                const pills = s.allSubjectsDisplay.map(sub => {
                    let statusBadge = '';
                    let extraClass = '';
                    if (sub.status === 'drop') {
                        statusBadge = '<span class="pill-status-badge drop">✖ Dropped</span>';
                        extraClass = 'pill-dropped';
                    } else if (sub.status === 'pause') {
                        statusBadge = '<span class="pill-status-badge pause">⏸ Paused</span>';
                        extraClass = 'pill-paused';
                    }
                    return `<span class="subj-pill ${getSubjectClass(sub.name)} ${extraClass}">${sub.displayText} ${statusBadge}</span>`;
                }).join(' ');

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${s.name}</strong></td><td>${s.nameCn}</td><td>${s.nickname}</td>
                    <td>${s.grade}</td><td>${pills}</td><td>${s.enrolDate}</td><td>${s.poReason}</td>
                    <td><a href="student-form.html?id=${s.id}" class="action-btn" title="Edit">✏️ Edit</a></td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    function renderInquiryTable(filter = '') {
        const tbody = document.getElementById('inquiryTableBody');
        const noResults = document.getElementById('noInquiryResults');
        const table = document.getElementById('inquiryTable');
        tbody.innerHTML = '';
        const lf = filter.toLowerCase().trim();

        const filtered = inquiryList.filter(s =>
            s.name.toLowerCase().includes(lf) || s.nameCn.toLowerCase().includes(lf) ||
            s.nickname.toLowerCase().includes(lf) || s.grade.toLowerCase().includes(lf) ||
            s.subjects.some(sub => sub.toLowerCase().includes(lf))
        );

        if (filtered.length === 0) {
            noResults.classList.add('visible'); table.style.display = 'none';
        } else {
            noResults.classList.remove('visible'); table.style.display = 'table';
            filtered.forEach(s => {
                const pills = s.subjects.map(sub => `<span class="subj-pill ${getSubjectClass(sub)}">${sub}</span>`).join(' ');
                const dtInfo = checkDTStatus(s.rawData);
                const dtBadge = renderDTBadge(dtInfo);
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${s.name}</strong></td><td>${s.nameCn}</td><td>${s.nickname}</td>
                    <td>${s.grade}</td><td>${pills}</td><td>${s.inquiryDate}</td><td>${dtBadge}</td>
                    <td><a href="student-form.html?id=${s.id}" class="action-btn" title="Edit">✏️ Edit</a></td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    // ==========================================
    // ✅ RENDER TAB 3: PAUSE FOLLOW-UP (Per-Subject)
    // ==========================================
    function renderPauseFollowUpTable(filter = '') {
        const tbody = document.getElementById('pauseTableBody');
        const noResults = document.getElementById('noPauseResults');
        const table = document.getElementById('pauseTable');
        tbody.innerHTML = '';
        const lf = filter.toLowerCase().trim();

        const filtered = pauseFollowUpList.filter(s =>
            s.studentName.toLowerCase().includes(lf) || s.nameCn.toLowerCase().includes(lf) ||
            s.nickname.toLowerCase().includes(lf) || s.grade.toLowerCase().includes(lf) ||
            s.subjectName.toLowerCase().includes(lf)
        );

        if (filtered.length === 0) {
            noResults.classList.add('visible'); table.style.display = 'none';
        } else {
            noResults.classList.remove('visible'); table.style.display = 'table';

            filtered.forEach(s => {
                const pill = `<span class="subj-pill ${getSubjectClass(s.subjectName)}">${s.subjectName} ${s.subjectLevel}</span>`;
                const overdueTag = s.isOverdue ? '<span class="overdue-tag">OVERDUE</span>' : '';
                const pauseDuration = `${s.pauseFrom} → ${s.pauseTo}${overdueTag}`;

                let actionHtml = '';
                if (s.hasPendingReturn) {
                    const retMonth = MONTH_SHORT[parseInt(s.pendingReturnMonth) - 1];
                    actionHtml = `
                        <span class="return-confirmed-badge">✔ Return (${retMonth} ${s.pendingReturnYear})</span>
                        <button class="pause-action-btn drop" data-student-id="${s.studentId}" data-subject-index="${s.subjectIndex}" data-action="drop">✖ Confirm Drop</button>
                    `;
                } else {
                    actionHtml = `
                        <button class="pause-action-btn drop" data-student-id="${s.studentId}" data-subject-index="${s.subjectIndex}" data-action="drop">✖ Confirm Drop</button>
                        <button class="pause-action-btn continue" data-student-id="${s.studentId}" data-subject-index="${s.subjectIndex}" data-action="return">✔ Confirm Return</button>
                    `;
                }

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${s.studentName}</strong></td>
                    <td>${s.nameCn}</td>
                    <td>${s.nickname}</td>
                    <td>${s.grade}</td>
                    <td>${pill}</td>
                    <td class="pause-duration-cell">${pauseDuration}</td>
                    <td class="pause-actions-cell">${actionHtml}</td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    // ==========================================
    // ✅ PAUSE ACTION HANDLERS
    // ==========================================
    let activeReturnStudentId = null;
    let activeReturnSubjectIndex = null;

    document.getElementById('pauseTableBody').addEventListener('click', async (e) => {
        const btn = e.target.closest('.pause-action-btn');
        if (!btn) return;

        const studentId = btn.dataset.studentId;
        const subjectIndex = parseInt(btn.dataset.subjectIndex);
        const action = btn.dataset.action; 

        const student = allStudents.find(s => s.id === studentId);
        if (!student) return;

        if (action === 'drop') {
            const subName = student.pausedSubjects.find(p => p.index === subjectIndex)?.name || 'Subject';
            if (!confirm(`⚠️ Confirm DROP for ${student.name}?\n\nSubject: ${subName}\n\nThis will change the status to "Drop".`)) return;
            
            btn.disabled = true;
            btn.textContent = '⏳ Saving...';

            try {
                const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
                const snap = await get(studentRef);
                if (!snap.exists()) throw new Error("Student not found");

                const studentData = snap.val();
                let subjects = safeArray(studentData.subjects);
                const sub = subjects[subjectIndex];
                if (!sub) throw new Error("Subject not found");

                sub.status = 'drop';
                const now = new Date();
                sub.dropMonth = String(now.getMonth() + 1).padStart(2, '0');
                sub.dropYear = String(now.getFullYear());
                sub.dropReason = sub.dropReason || 'Confirmed drop after pause follow-up';
                delete sub.pendingReturn; // Clear any pending return

                studentData.subjects = subjects;
                studentData.updatedAt = new Date().toISOString();

                await set(studentRef, studentData);
                await fetchAllStudents();
                alert(`✅ ${student.name} — Drop confirmed successfully!`);
            } catch (err) {
                console.error("Drop action error:", err);
                alert('❌ Failed to save: ' + err.message);
                btn.disabled = false;
                btn.textContent = '✖ Confirm Drop';
            }
        } else if (action === 'return') {
            activeReturnStudentId = studentId;
            activeReturnSubjectIndex = subjectIndex;
            
            // Default to next month
            const now = new Date();
            let nextM = String(now.getMonth() + 2).padStart(2, '0');
            let nextY = String(now.getFullYear());
            if (nextM === '13') { nextM = '01'; nextY = String(now.getFullYear() + 1); }
            
            document.getElementById('returnMonth').value = nextM;
            document.getElementById('returnYear').value = nextY;
            
            document.getElementById('confirmReturnModal').classList.remove('hidden');
        }
    });

    // Modal Handlers
    document.getElementById('cancelReturnBtn')?.addEventListener('click', () => {
        document.getElementById('confirmReturnModal').classList.add('hidden');
    });

    document.getElementById('saveReturnBtn')?.addEventListener('click', async () => {
        const month = document.getElementById('returnMonth').value;
        const year = document.getElementById('returnYear').value;
        
        if (!month || !year) {
            alert('Please select a month and year.');
            return;
        }

        document.getElementById('confirmReturnModal').classList.add('hidden');
        
        try {
            const studentRef = ref(db, `centers/${centerId}/students/${activeReturnStudentId}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");

            const studentData = snap.val();
            let subjects = safeArray(studentData.subjects);
            const sub = subjects[activeReturnSubjectIndex];
            if (!sub) throw new Error("Subject not found");

            sub.pendingReturn = {
                month,
                year,
                confirmedAt: new Date().toISOString()
            };

            studentData.subjects = subjects;
            studentData.updatedAt = new Date().toISOString();

            await set(studentRef, studentData);
            await fetchAllStudents();
            alert(`✅ Return confirmed for ${MONTH_SHORT[parseInt(month)-1]} ${year}. Status will auto-update to Current when that month arrives.`);
        } catch (err) {
            console.error("Return action error:", err);
            alert('❌ Failed to save: ' + err.message);
        }
    });

    // Populate Modal Dropdowns
    const returnMonthSelect = document.getElementById('returnMonth');
    const returnYearSelect = document.getElementById('returnYear');
    if (returnMonthSelect && returnYearSelect) {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        let monthOpts = '';
        months.forEach((m, i) => {
            const val = String(i + 1).padStart(2, '0');
            monthOpts += `<option value="${val}">${m}</option>`;
        });
        returnMonthSelect.innerHTML = monthOpts;

        const currentYear = new Date().getFullYear();
        let yearOpts = '';
        for (let y = currentYear; y <= currentYear + 5; y++) {
            yearOpts += `<option value="${y}">${y}</option>`;
        }
        returnYearSelect.innerHTML = yearOpts;
    }

    // ==========================================
    // 🔗 EVENT LISTENERS
    // ==========================================
    searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        renderPOTable(val);
        renderInquiryTable(val);
        renderPauseFollowUpTable(val);
    });
    refreshBtn.addEventListener('click', fetchAllStudents);

    fetchAllStudents();
}