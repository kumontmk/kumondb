import { auth, db, logout, syncPendingRequests } from './auth.js';
import { ref, get, set } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'dropBook';
const centerId = sessionStorage.getItem('selectedCenter');
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SUBJECT_FILTERS = ['All Subjects', 'Math', 'English EFL', 'English ERP', 'Chinese'];

let allStudentsData = [];
let currentEditContext = null;
let viewMode = 'year'; // Default to 'year'
let activeTabMonth = null;
let activeTabYear = null;
let activeSubjectFilter = 'All Subjects';
let selectedStudent = null;

// 1. Auth & Permission Check
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
            initApp();
        } else {
            document.getElementById('accessDenied')?.remove('hidden');
            document.getElementById('mainContent')?.classList.add('hidden');
            document.getElementById('page-loader')?.classList.add('hidden');
            document.getElementById('backToDashboardBtn')?.addEventListener('click', () => window.location.href = 'dashboard.html');
        }
    } catch (err) {
        console.error("Permission check error:", err);
        window.location.href = 'index.html';
    }
});

function initApp() {
    const filterMonth = document.getElementById('filterMonth');
    const filterYear = document.getElementById('filterYear');
    const filterStatus = document.getElementById('filterStatus');
    const viewModeSelect = document.getElementById('viewMode');
    const singleMonthControls = document.getElementById('singleMonthControls');
    const rangeControls = document.getElementById('rangeControls');
    const rangeStartMonthSel = document.getElementById('rangeStartMonth');
    const rangeStartYearSel = document.getElementById('rangeStartYear');
    const rangeEndLabel = document.getElementById('rangeEndLabel');
    const monthTabs = document.getElementById('monthTabs');
    const subjectTabs = document.getElementById('subjectTabs');
    const tbody = document.getElementById('dropBookBody');
    const modal = document.getElementById('detailModal');
    const callStatusBtn = document.getElementById('mCallStatusBtn');

    document.getElementById('logoutBtn')?.addEventListener('click', logout);

    // Populate Filters
    const currentYear = new Date().getFullYear();
    for (let y = currentYear - 2; y <= currentYear + 1; y++) {
        filterYear.innerHTML += `<option value="${y}">${y}</option>`;
        rangeStartYearSel.innerHTML += `<option value="${y}">${y}</option>`;
    }

    MONTH_NAMES.forEach((m, i) => {
        const monthVal = String(i + 1).padStart(2, '0');
        filterMonth.innerHTML += `<option value="${monthVal}">${m}</option>`;
        rangeStartMonthSel.innerHTML += `<option value="${monthVal}">${m}</option>`;
    });

    const now = new Date();
    filterMonth.value = String(now.getMonth() + 1).padStart(2, '0');
    filterYear.value = now.getFullYear();

    let nextMonth = now.getMonth() + 2; 
    let nextYear = now.getFullYear();
    if (nextMonth > 12) {
        nextMonth = 1;
        nextYear += 1;
    }
    const nextMonthStr = String(nextMonth).padStart(2, '0');

    rangeStartMonthSel.value = nextMonthStr;
    rangeStartYearSel.value = nextYear;
    
    viewModeSelect.value = 'year';

    function generateSubjectTabs() {
        subjectTabs.innerHTML = '';
        SUBJECT_FILTERS.forEach(subject => {
            const tab = document.createElement('button');
            tab.className = 'sub-tab-btn';
            if (subject === activeSubjectFilter) tab.classList.add('active');
            tab.textContent = subject;
            tab.dataset.subject = subject;
            
            tab.addEventListener('click', () => {
                document.querySelectorAll('.sub-tab-btn').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                activeSubjectFilter = subject;
                renderTable();
            });
            
            subjectTabs.appendChild(tab);
        });
    }

    viewModeSelect.addEventListener('change', () => {
        viewMode = viewModeSelect.value;
        
        if (viewMode === 'single') {
            singleMonthControls.classList.remove('hidden');
            rangeControls.classList.add('hidden');
            monthTabs.innerHTML = '';
            activeTabMonth = filterMonth.value;
            activeTabYear = filterYear.value;
        } else if (viewMode === 'year') {
            singleMonthControls.classList.add('hidden');
            rangeControls.classList.remove('hidden');
            updateRangeEndLabel();
            generateMonthTabs();
        } else if (viewMode === 'range') {
            singleMonthControls.classList.add('hidden');
            rangeControls.classList.remove('hidden');
            updateRangeEndLabel();
            generateMonthTabs();
        }
        
        renderTable();
    });

    rangeStartMonthSel.addEventListener('change', () => {
        updateRangeEndLabel();
        generateMonthTabs();
        renderTable();
    });

    rangeStartYearSel.addEventListener('change', () => {
        updateRangeEndLabel();
        generateMonthTabs();
        renderTable();
    });

    function updateRangeEndLabel() {
        const startMonth = parseInt(rangeStartMonthSel.value);
        const startYear = parseInt(rangeStartYearSel.value);
        const endMonth = startMonth === 12 ? 12 : startMonth + 11;
        const endYear = startMonth === 12 ? startYear + 1 : startYear;
         
        const endMonthName = MONTH_NAMES[endMonth - 1];
        rangeEndLabel.textContent = `→ ${endMonthName} ${endYear}`;
    }

    function generateMonthTabs() {
        monthTabs.innerHTML = '';
        
        let startMonth, startYear;
        startMonth = parseInt(rangeStartMonthSel.value);
        startYear = parseInt(rangeStartYearSel.value);

        for (let i = 0; i < 12; i++) {
            let month = startMonth + i;
            let year = startYear;
            
            if (month > 12) {
                month = month - 12;
                year = year + 1;
            }

            const tab = document.createElement('button');
            tab.className = 'tab-btn';
            tab.textContent = `${MONTH_NAMES[month - 1]} ${year}`;
            tab.dataset.month = String(month).padStart(2, '0');
            tab.dataset.year = year;
            
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                activeTabMonth = tab.dataset.month;
                activeTabYear = tab.dataset.year;
                renderTable();
            });
            
            monthTabs.appendChild(tab);
        }

        const firstTab = monthTabs.querySelector('.tab-btn');
        if (firstTab) firstTab.click();
    }

    [filterMonth, filterYear, filterStatus].forEach(el => 
        el.addEventListener('change', () => {
            if (viewMode === 'single') {
                activeTabMonth = filterMonth.value;
                activeTabYear = filterYear.value;
            }
            renderTable();
        })
    );

    async function loadData() {
        if (!centerId) return;
        
        await syncPendingRequests(centerId);

        try {
            const snap = await get(ref(db, `centers/${centerId}/students`));
            if (snap.exists()) {
                allStudentsData = Object.entries(snap.val()).map(([id, data]) => ({ id, ...data }));
                renderTable();
            } else {
                tbody.innerHTML = '<tr><td colspan="12" class="empty-state">No students found.</td></tr>';
            }
        } catch (err) {
            console.error("Error loading students: ", err);
        } finally {
            document.getElementById('page-loader')?.classList.add('hidden');
        }
    }

    function matchesSubjectFilter(subjectName) {
        if (activeSubjectFilter === 'All Subjects') return true;
        if (!subjectName) return false;
        const name = subjectName.toLowerCase().trim();
        const filter = activeSubjectFilter.toLowerCase();
        
        if (filter === 'math') return name.includes('math');
        if (filter === 'english efl') return name.includes('english') && name.includes('efl');
        if (filter === 'english erp') return name.includes('english') && name.includes('erp');
        if (filter === 'chinese') return name.includes('chinese');
        return false;
    }

    // 🆕 UPDATED: Robustly handles Direct Drops, Pending Requests, and Cancelled Requests
    function getFilteredEntries() {
        const mStatus = filterStatus.value;
        const entries = [];

        allStudentsData.forEach(student => {
            const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
            subjects.forEach((sub, index) => {
                let targetMonth, targetYear, reason, type, isPending = false;
                
                // Check if there is an ACTIVE (non-cancelled) pending request
                const hasActivePendingRequest = sub.pendingRequest && !sub.pendingRequest.cancelled && sub.pendingRequest.type;
                const isDirectDropPause = sub.status === 'drop' || sub.status === 'pause';

                if (hasActivePendingRequest) {
                    isPending = true;
                    type = sub.pendingRequest.type;
                    reason = sub.pendingRequest.reason;
                    if (type === 'drop') {
                        targetMonth = sub.pendingRequest.dropMonth;
                        targetYear = sub.pendingRequest.dropYear;
                    } else {
                        targetMonth = sub.pendingRequest.pauseFromMonth;
                        targetYear = sub.pendingRequest.pauseFromYear;
                    }
                } 
                else if (isDirectDropPause) {
                    // 🆕 Handles direct drops/pauses changed manually in Student Form
                    type = sub.status;
                    reason = sub.status === 'drop' ? sub.dropReason : sub.pauseReason;
                    targetMonth = sub.status === 'drop' ? sub.dropMonth : sub.pauseFromMonth;
                    targetYear = sub.status === 'drop' ? sub.dropYear : sub.pauseFromYear;
                } 
                else if (sub.pendingRequest && sub.pendingRequest.cancelled) {
                    // Handles requests that were cancelled but status hasn't changed yet
                    isPending = true;
                    type = sub.pendingRequest.type || 'drop'; 
                    reason = sub.pendingRequest.reason || 'Cancelled';
                    targetMonth = sub.pendingRequest.dropMonth || sub.pendingRequest.pauseFromMonth;
                    targetYear = sub.pendingRequest.dropYear || sub.pendingRequest.pauseFromYear;
                }
                else {
                    return; 
                }

                if (mStatus !== 'all' && type !== mStatus) return;
                if (!matchesSubjectFilter(sub.name)) return;
                if (!targetMonth || !targetYear) return;

                if (viewMode === 'single') {
                    const mMonth = filterMonth.value;
                    const mYear = filterYear.value;
                    if (mMonth && targetMonth !== mMonth) return;
                    if (mYear && targetYear !== mYear) return;
                } else if (viewMode === 'year' || viewMode === 'range') {
                    let startMonth, startYear;
                    startMonth = parseInt(rangeStartMonthSel.value);
                    startYear = parseInt(rangeStartYearSel.value);

                    const entryDate = new Date(parseInt(targetYear), parseInt(targetMonth) - 1);
                    const startDate = new Date(startYear, startMonth - 1);
                    const endDate = new Date(startDate);
                    endDate.setMonth(endDate.getMonth() + 11);

                    if (entryDate < startDate || entryDate > endDate) return;

                    if (activeTabMonth && activeTabYear) {
                        if (targetMonth !== activeTabMonth || targetYear !== activeTabYear) return;
                    }
                }

                // 🆕 Only mark as cancelled if it's NOT already a direct drop/pause
                let isCancelled = false;
                if (sub.pendingRequest && sub.pendingRequest.cancelled && !isDirectDropPause) {
                    isCancelled = true;
                }

                entries.push({ 
                    studentId: student.id, 
                    subjectIndex: index, 
                    student, 
                    subject: sub, 
                    isPending,
                    isCancelled, 
                    targetMonth,
                    targetYear,
                    type,
                    reason
                });
            });
        });
        return entries;
    }

    function formatSchedule(timeslots) {
        if (!timeslots || timeslots.length === 0) return '-';
        return timeslots.map(ts => `${ts.day.substring(0, 3)} ${ts.time}`).join(', ');
    }

    function getPhone(student) {
        const p = student.phone || {};
        return p.mom || p.dad || p.own || '-';
    }

    function renderTable() {
        const entries = getFilteredEntries();
        tbody.innerHTML = '';
        
        if (entries.length === 0) {
            tbody.innerHTML = '<tr><td colspan="12" class="empty-state">No records found for the selected filters.</td></tr>';
            return;
        }

        entries.forEach((entry, idx) => {
            const { student, subject, isPending, type, isCancelled } = entry; 
            const sub = entry.subject;
            const tMonth = entry.targetMonth;
            const tYear = entry.targetYear;
            
            const dateStr = tMonth && tYear ? `${MONTH_NAMES[parseInt(tMonth) - 1]} ${tYear}` : '-';
            const callStatus = sub.dropBook?.callStatus || false;
            const callBadge = callStatus ? '<span class="call-badge green">✔</span>' : '<span class="call-badge red">✖</span>';
            
            const statusText = type === 'drop' ? 'Drop' : 'Pause';
            const statusClass = type === 'drop' ? 'status-badge-drop' : 'status-badge-pause';
            
            const reason = entry.reason || '-';
            const isConfirmed = sub.dropBook?.confirmed;
            const pendingBadge = (isPending && !isConfirmed && !isCancelled) ? '<span class="status-badge-pending">⏳ Pending</span>' : '';
            
            // 🆕 UPDATED ACTION BUTTON LOGIC (Now handles Direct Drops/Pauses)
            let actionBtn = '';
            if (isCancelled) {
                actionBtn = `
                    <div style="display:flex; gap:4px; flex-wrap:wrap;">
                        <button class="confirm-row-btn cancelled" disabled style="padding: 0.3rem 0.6rem; font-size: 0.8rem;">❌ Cancelled</button>
                        <button class="confirm-row-btn reinstate-btn" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" data-student-id="${student.id}" data-sub-index="${entry.subjectIndex}" data-action="reinstate">🔄 Reinstate</button>
                    </div>
                `;
            } else if (isConfirmed) {
                actionBtn = `<button class="confirm-row-btn confirmed" disabled>✔️ Confirmed</button>`;
            } else {
                // 🆕 Show "Cancel" button for pending requests OR direct drops/pauses
                const isDirectDropPause = (sub.status === 'drop' || sub.status === 'pause') && !isPending;
                const showCancelBtn = isPending || isDirectDropPause;
                const cancelBtnText = isPending ? '❌ Cancel Request' : '❌ Cancel Drop/Pause';
                
                actionBtn = `
                    <div style="display:flex; gap:4px; flex-wrap:wrap;">
                        <button class="confirm-row-btn" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" data-student-id="${student.id}" data-sub-index="${entry.subjectIndex}" data-action="confirm">✔️ Confirm</button>
                        ${showCancelBtn ? `<button class="confirm-row-btn cancel-btn" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" data-student-id="${student.id}" data-sub-index="${entry.subjectIndex}" data-action="cancel">${cancelBtnText}</button>` : ''}
                    </div>
                `;
            }

            const tr = document.createElement('tr');
            if (isCancelled) tr.classList.add('cancelled-row'); 

            tr.innerHTML = `
                <td>${idx + 1}</td>
                <td>${student.nameCn || '-'}</td>
                <td>${student.nickname || '-'}</td>
                <td>${dateStr} <span class="${statusClass}">${statusText}</span>${pendingBadge}</td>
                <td>${student.grade || '-'}</td>
                <td>${sub.name || '-'}</td>
                <td>${formatSchedule(sub.timeslots)}</td>
                <td>${sub.currentLevel || sub.startLevel || '-'}</td>
                <td>${getPhone(student)}</td>
                <td>${reason}</td>
                <td>${callBadge}</td>
                <td>${actionBtn}</td>
            `;
            tr.addEventListener('click', () => openModal(entry));
            tbody.appendChild(tr);
        });
    }

    // 🆕 UPDATED EVENT DELEGATION FOR TABLE BUTTONS
    tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('.confirm-row-btn');
        if (btn && !btn.disabled) {
            e.stopPropagation(); 
            const studentId = btn.dataset.studentId;
            const subjectIndex = parseInt(btn.dataset.subIndex);
            const action = btn.dataset.action; 

            if (action === 'cancel') {
                triggerCancelAction(studentId, subjectIndex);
            } else if (action === 'reinstate') {
                triggerReinstateAction(studentId, subjectIndex);
            } else {
                triggerConfirmAction(studentId, subjectIndex);
            }
        }
    });

    // 🆕 UPDATED: Now handles both Pending Requests and Direct Drops/Pauses
    async function triggerCancelAction(studentId, subjectIndex) {
        const student = allStudentsData.find(s => s.id === studentId);
        if (!student) return;
        const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
        const sub = subjects[subjectIndex];
        if (!sub) return;

        const hasActivePending = sub.pendingRequest && !sub.pendingRequest.cancelled && sub.pendingRequest.type;
        const isDirectDropPause = sub.status === 'drop' || sub.status === 'pause';

        let confirmMsg = 'Are you sure you want to cancel this pending request? The entry will be crossed out.';
        if (isDirectDropPause && !hasActivePending) {
            confirmMsg = 'Are you sure you want to cancel this drop/pause? The subject status will be reverted to "Current".';
        }

        if (!confirm(confirmMsg)) return;

        try {
            const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");
            
            const studentData = snap.val();
            let subjectsData = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            
            if (subjectsData[subjectIndex]) {
                if (hasActivePending) {
                    subjectsData[subjectIndex].pendingRequest.cancelled = true;
                    subjectsData[subjectIndex].pendingRequest.cancelledAt = new Date().toISOString();
                } 
                else if (isDirectDropPause) {
                    // Revert direct drop/pause to 'current' and wipe data
                    subjectsData[subjectIndex].status = 'current';
                    delete subjectsData[subjectIndex].dropMonth;
                    delete subjectsData[subjectIndex].dropYear;
                    delete subjectsData[subjectIndex].dropReason;
                    delete subjectsData[subjectIndex].pauseFromMonth;
                    delete subjectsData[subjectIndex].pauseFromYear;
                    delete subjectsData[subjectIndex].pauseToMonth;
                    delete subjectsData[subjectIndex].pauseToYear;
                    delete subjectsData[subjectIndex].pauseReason;
                    
                    if (subjectsData[subjectIndex].pendingRequest) delete subjectsData[subjectIndex].pendingRequest;
                    if (subjectsData[subjectIndex].dropBook) delete subjectsData[subjectIndex].dropBook;
                }
            }
            
            studentData.subjects = subjectsData;
            await set(studentRef, studentData);
            
            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjectsData;
            
            renderTable();
            alert('✅ Drop/Pause cancelled successfully.');
        } catch (err) {
            console.error("Cancel error: ", err);
            alert('❌ Failed to cancel: ' + err.message);
        }
    }

    async function triggerReinstateAction(studentId, subjectIndex) {
        if (!confirm('Are you sure you want to reinstate this cancelled request? It will become pending again.')) return;

        try {
            const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");
            
            const studentData = snap.val();
            let subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            
            if (subjects[subjectIndex] && subjects[subjectIndex].pendingRequest) {
                delete subjects[subjectIndex].pendingRequest.cancelled;
                delete subjects[subjectIndex].pendingRequest.cancelledAt;
            }
            
            studentData.subjects = subjects;
            await set(studentRef, studentData);
            
            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjects;
            
            renderTable();
            alert('✅ Request reinstated successfully.');
        } catch (err) {
            console.error("Reinstate error: ", err);
            alert('❌ Failed to reinstate: ' + err.message);
        }
    }

    function openModal(entry) {
        const { student, subject, studentId, subjectIndex, isPending } = entry;
        currentEditContext = { studentId, subjectIndex, isPending };

        document.getElementById('mNameCn').value = student.nameCn || '-';
        document.getElementById('mNickname').value = student.nickname || '-';
        document.getElementById('mGrade').value = student.grade || '-';
        document.getElementById('mSubject').value = subject.name || '-';
        document.getElementById('mSchedule').value = formatSchedule(subject.timeslots);
        document.getElementById('mCurrentLevel').value = subject.currentLevel || subject.startLevel || '-';
        document.getElementById('mPhone').value = getPhone(student);
        document.getElementById('mEnrolDate').value = subject.enrolDate || '-';

        let reason = '';
        let expectedReturnMonth = '', expectedReturnYear = '';
        let pauseFromMonth = '', pauseFromYear = '';
        let isPause = false;
        
        if (isPending && subject.pendingRequest.type) {
            const pr = subject.pendingRequest;
            reason = pr.reason || '';
            isPause = pr.type === 'pause';
            if (isPause) {
                pauseFromMonth = pr.pauseFromMonth;
                pauseFromYear = pr.pauseFromYear;
                expectedReturnMonth = pr.pauseToMonth;
                expectedReturnYear = pr.pauseToYear;
            }
        } else {
            isPause = subject.status === 'pause';
            reason = subject.status === 'drop' ? subject.dropReason : subject.pauseReason;
            if (isPause) {
                pauseFromMonth = subject.pauseFromMonth;
                pauseFromYear = subject.pauseFromYear;
                expectedReturnMonth = subject.pauseToMonth;
                expectedReturnYear = subject.pauseToYear;
            }
        }
        
        document.getElementById('mReason').value = reason;
        
        const pauseFromGroup = document.getElementById('mPauseFromGroup');
        if (isPause && pauseFromMonth && pauseFromYear) {
            document.getElementById('mPauseFrom').value = `${MONTH_NAMES[parseInt(pauseFromMonth) - 1]} ${pauseFromYear}`;
            pauseFromGroup.style.display = 'flex';
        } else {
            pauseFromGroup.style.display = 'none';
        }

        const expectedReturnGroup = document.getElementById('mExpectedReturnGroup');
        if (isPause && expectedReturnMonth && expectedReturnYear) {
            let retMonth = parseInt(expectedReturnMonth) + 1;
            let retYear = parseInt(expectedReturnYear);
            if (retMonth > 12) { retMonth = 1; retYear++; }
            document.getElementById('mExpectedReturn').value = `${MONTH_NAMES[retMonth - 1]} ${retYear}`;
            expectedReturnGroup.style.display = 'flex';
        } else {
            expectedReturnGroup.style.display = 'none';
        }

        const dbInfo = subject.dropBook || {};
        updateCallStatusBtn(dbInfo.callStatus || false);
        document.getElementById('mCalledBy').value = dbInfo.calledBy || '';
        document.getElementById('mNotes').value = dbInfo.notes || '';
        document.getElementById('mExitAutopay').checked = dbInfo.exitFormAutopay || false;
        document.getElementById('mAccounts').value = dbInfo.accounts || '';

        const confirmDropBtn = document.getElementById('confirmDropBtn');
        if (dbInfo.confirmed) {
            confirmDropBtn.style.display = 'none';
        } else {
            confirmDropBtn.style.display = 'inline-block';
        }

        // 🆕 UPDATED: Show/Hide Cancel OR Reinstate Request Button in Modal
        const cancelRequestBtn = document.getElementById('cancelRequestBtn');
        const reinstateRequestBtn = document.getElementById('reinstateRequestBtn');
        
        const isDirectDropPause = (subject.status === 'drop' || subject.status === 'pause') && !isPending;

        if (isPending && !subject.pendingRequest.cancelled) {
            cancelRequestBtn.style.display = 'inline-block';
            cancelRequestBtn.textContent = '❌ Cancel Request';
            reinstateRequestBtn.style.display = 'none';
        } else if (isPending && subject.pendingRequest.cancelled) {
            cancelRequestBtn.style.display = 'none';
            reinstateRequestBtn.style.display = 'inline-block';
        } else if (isDirectDropPause) {
            cancelRequestBtn.style.display = 'inline-block';
            cancelRequestBtn.textContent = '❌ Cancel Drop/Pause';
            reinstateRequestBtn.style.display = 'none';
        } else {
            cancelRequestBtn.style.display = 'none';
            reinstateRequestBtn.style.display = 'none';
        }

        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }

    function updateCallStatusBtn(isCalled) {
        if (isCalled) {
            callStatusBtn.className = 'call-status-btn green';
            callStatusBtn.textContent = '✔ Called';
        } else {
            callStatusBtn.className = 'call-status-btn red';
            callStatusBtn.textContent = '✖ Not Called';
        }
    }

    callStatusBtn.addEventListener('click', () => {
        const isCurrentlyCalled = callStatusBtn.classList.contains('green');
        updateCallStatusBtn(!isCurrentlyCalled);
    });

    function closeModal() {
        modal.classList.add('hidden');
        modal.style.display = 'none';
        currentEditContext = null;
    }

    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    document.getElementById('saveModalBtn').addEventListener('click', async () => {
        if (!currentEditContext) return;
        const { studentId, subjectIndex, isPending } = currentEditContext;
        const saveBtn = document.getElementById('saveModalBtn');
        
        const isCalled = callStatusBtn.classList.contains('green');
        const calledBy = document.getElementById('mCalledBy').value.trim();
        const notes = document.getElementById('mNotes').value.trim();
        
        if (isCalled) {
            if (!calledBy) {
                alert('⚠️ "Called By" is required when Call Status is "Called".');
                return;
            }
            if (!notes) {
                alert('⚠️ "Call Notes" is required when Call Status is "Called".');
                return;
            }
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
            const studentSnap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
            if (!studentSnap.exists()) throw new Error("Student not found");
            
            const studentData = studentSnap.val();
            let subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            
            if (!subjects[subjectIndex]) throw new Error("Subject not found");

            const sub = subjects[subjectIndex];
            const newReason = document.getElementById('mReason').value.trim();
            
            if (isPending && sub.pendingRequest.type) {
                sub.pendingRequest.reason = newReason;
            } else {
                const isDrop = sub.status === 'drop';
                if (isDrop) sub.dropReason = newReason;
                else sub.pauseReason = newReason;
            }

            sub.dropBook = {
                ...sub.dropBook, 
                callStatus: callStatusBtn.classList.contains('green'),
                calledBy: calledBy,
                notes: notes,
                exitFormAutopay: document.getElementById('mExitAutopay').checked,
                accounts: document.getElementById('mAccounts').value.trim(),
                updatedAt: new Date().toISOString()
            };

            studentData.subjects = subjects;
            studentData.updatedAt = new Date().toISOString();

            await set(ref(db, `centers/${centerId}/students/${studentId}`), studentData);
            
            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjects;

            renderTable();
            closeModal();
            alert('✅ Drop Book entry updated successfully!');
        } catch (err) {
            console.error("Save error: ", err);
            alert('❌ Failed to save: ' + err.message);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 Save Changes';
        }
    });

    // 🆕 UPDATED: Now handles both Pending Requests and Direct Drops/Pauses
    document.getElementById('cancelRequestBtn').addEventListener('click', async () => {
        if (!currentEditContext) return;
        const { studentId, subjectIndex } = currentEditContext;
        
        const student = allStudentsData.find(s => s.id === studentId);
        if (!student) return;
        const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
        const sub = subjects[subjectIndex];
        if (!sub) return;

        const hasActivePending = sub.pendingRequest && !sub.pendingRequest.cancelled && sub.pendingRequest.type;
        const isDirectDropPause = sub.status === 'drop' || sub.status === 'pause';

        let confirmMsg = 'Are you sure you want to cancel this pending request? The entry will be crossed out.';
        if (isDirectDropPause && !hasActivePending) {
            confirmMsg = 'Are you sure you want to cancel this drop/pause? The subject status will be reverted to "Current".';
        }

        if (!confirm(confirmMsg)) return;

        const btn = document.getElementById('cancelRequestBtn');
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'Cancelling...';

        try {
            const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");
            
            const studentData = snap.val();
            let subjectsData = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            
            if (subjectsData[subjectIndex]) {
                if (hasActivePending) {
                    subjectsData[subjectIndex].pendingRequest.cancelled = true;
                    subjectsData[subjectIndex].pendingRequest.cancelledAt = new Date().toISOString();
                } 
                else if (isDirectDropPause) {
                    // Revert direct drop/pause to 'current' and wipe data
                    subjectsData[subjectIndex].status = 'current';
                    delete subjectsData[subjectIndex].dropMonth;
                    delete subjectsData[subjectIndex].dropYear;
                    delete subjectsData[subjectIndex].dropReason;
                    delete subjectsData[subjectIndex].pauseFromMonth;
                    delete subjectsData[subjectIndex].pauseFromYear;
                    delete subjectsData[subjectIndex].pauseToMonth;
                    delete subjectsData[subjectIndex].pauseToYear;
                    delete subjectsData[subjectIndex].pauseReason;
                    
                    if (subjectsData[subjectIndex].pendingRequest) delete subjectsData[subjectIndex].pendingRequest;
                    if (subjectsData[subjectIndex].dropBook) delete subjectsData[subjectIndex].dropBook;
                }
            }
            
            studentData.subjects = subjectsData;
            await set(studentRef, studentData);
            
            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjectsData;
            
            renderTable();
            closeModal();
            alert('✅ Drop/Pause cancelled successfully.');
        } catch (err) {
            console.error("Cancel error:", err);
            alert('❌ Failed to cancel: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });

    document.getElementById('reinstateRequestBtn').addEventListener('click', async () => {
        if (!currentEditContext) return;
        if (!confirm('Are you sure you want to reinstate this cancelled request?')) return;

        const { studentId, subjectIndex } = currentEditContext;
        const btn = document.getElementById('reinstateRequestBtn');
        btn.disabled = true;
        btn.textContent = 'Reinstating...';

        try {
            const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");
            
            const studentData = snap.val();
            let subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            
            if (subjects[subjectIndex] && subjects[subjectIndex].pendingRequest) {
                delete subjects[subjectIndex].pendingRequest.cancelled;
                delete subjects[subjectIndex].pendingRequest.cancelledAt;
            }
            
            studentData.subjects = subjects;
            await set(studentRef, studentData);
            
            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjects;
            
            renderTable();
            closeModal();
            alert('✅ Request reinstated successfully.');
        } catch (err) {
            console.error("Reinstate error:", err);
            alert('❌ Failed to reinstate: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = '🔄 Reinstate Request';
        }
    });

    const confirmActionModal = document.getElementById('confirmActionModal');
    const confirmTitle = document.getElementById('confirmTitle');
    const confirmMessage = document.getElementById('confirmMessage');
    let proceedConfirmBtn = document.getElementById('proceedConfirmBtn');

    document.getElementById('confirmDropBtn').addEventListener('click', () => {
        if (currentEditContext) {
            triggerConfirmAction(currentEditContext.studentId, currentEditContext.subjectIndex);
        }
    });

    document.getElementById('cancelConfirmBtn').addEventListener('click', () => {
        confirmActionModal.classList.add('hidden');
        confirmActionModal.style.display = 'none';
    });

    confirmActionModal.addEventListener('click', (e) => {
        if (e.target === confirmActionModal) {
            confirmActionModal.classList.add('hidden');
            confirmActionModal.style.display = 'none';
        }
    });

    function triggerConfirmAction(studentId, subjectIndex) {
        const student = allStudentsData.find(s => s.id === studentId);
        if (!student) return;
        const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
        const sub = subjects[subjectIndex];
        if (!sub || sub.dropBook?.confirmed) return;

        const isCalled = sub.dropBook?.callStatus || false;

        if (!isCalled) {
            confirmTitle.textContent = '⚠️ Parents Not Called';
            confirmMessage.textContent = 'The parents haven\'t been called yet. Are you sure you want to confirm this drop/pause?';
            proceedConfirmBtn.style.background = '#dc3545'; 
            proceedConfirmBtn.style.color = '#fff';
        } else {
            confirmTitle.textContent = '✔️ Confirm Drop/Pause';
            confirmMessage.textContent = 'Are you sure you want to confirm this drop/pause?';
            proceedConfirmBtn.style.background = ''; 
            proceedConfirmBtn.style.color = '';
        }

        confirmActionModal.classList.remove('hidden');
        confirmActionModal.style.display = 'flex';

        const newProceedBtn = proceedConfirmBtn.cloneNode(true);
        proceedConfirmBtn.parentNode.replaceChild(newProceedBtn, proceedConfirmBtn);
        proceedConfirmBtn = newProceedBtn;
        proceedConfirmBtn.id = 'proceedConfirmBtn';
        
        proceedConfirmBtn.addEventListener('click', async () => {
            confirmActionModal.classList.add('hidden');
            confirmActionModal.style.display = 'none';
            await executeConfirmDrop(studentId, subjectIndex);
        });
    }

    async function executeConfirmDrop(studentId, subjectIndex) {
        try {
            const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");
            
            const studentData = snap.val();
            let subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            const sub = subjects[subjectIndex];
            if (!sub) throw new Error("Subject not found");

            let isCalled, calledBy, notes, exitFormAutopay, accounts;
            
            if (currentEditContext && currentEditContext.studentId === studentId && currentEditContext.subjectIndex === subjectIndex) {
                isCalled = callStatusBtn.classList.contains('green');
                calledBy = document.getElementById('mCalledBy').value.trim();
                notes = document.getElementById('mNotes').value.trim();
                exitFormAutopay = document.getElementById('mExitAutopay').checked;
                accounts = document.getElementById('mAccounts').value.trim();
            } else {
                const dbInfo = sub.dropBook || {};
                isCalled = dbInfo.callStatus || false;
                calledBy = dbInfo.calledBy || '';
                notes = dbInfo.notes || '';
                exitFormAutopay = dbInfo.exitFormAutopay || false;
                accounts = dbInfo.accounts || '';
            }

            sub.dropBook = {
                ...(sub.dropBook || {}),
                callStatus: isCalled,
                calledBy: calledBy,
                notes: notes,
                exitFormAutopay: exitFormAutopay,
                accounts: accounts,
                updatedAt: new Date().toISOString()
            };

            sub.dropBook.confirmed = true;
            sub.dropBook.confirmedAt = new Date().toISOString();

            if (sub.pendingRequest) {
                const pr = sub.pendingRequest;
                let triggerMonth = '', triggerYear = '';
                if (pr.type === 'drop') { triggerMonth = pr.dropMonth; triggerYear = pr.dropYear; } 
                else if (pr.type === 'pause') { triggerMonth = pr.pauseFromMonth; triggerYear = pr.pauseFromYear; }
                
                const now = new Date();
                const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
                const currentYear = String(now.getFullYear());
                
                if (triggerYear && triggerMonth) {
                    if (triggerYear < currentYear || (triggerYear === currentYear && triggerMonth <= currentMonth)) {
                        sub.status = pr.type;
                        if (pr.type === 'drop') {
                            sub.dropMonth = pr.dropMonth;
                            sub.dropYear = pr.dropYear;
                            sub.dropReason = pr.reason;
                        } else {
                            sub.pauseFromMonth = pr.pauseFromMonth;
                            sub.pauseFromYear = pr.pauseFromYear;
                            sub.pauseToMonth = pr.pauseToMonth;
                            sub.pauseToYear = pr.pauseToYear;
                            sub.pauseReason = pr.reason;
                        }
                        delete sub.pendingRequest;
                    }
                } else if (sub.status === 'drop' || sub.status === 'pause') {
                    delete sub.pendingRequest;
                }
            }

            studentData.subjects = subjects;
            studentData.updatedAt = new Date().toISOString();

            await set(studentRef, studentData);

            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjects;

            renderTable();
            
            const detailModal = document.getElementById('detailModal');
            if (!detailModal.classList.contains('hidden')) {
                closeModal();
            }
            
            alert('✅ Drop/Pause confirmed successfully!');
        } catch (err) {
            console.error("Confirm error: ", err);
            alert('❌ Failed to confirm: ' + err.message);
        }
    }

    const searchModal = document.getElementById('searchRequestModal');
    const searchInput = document.getElementById('searchStudentInput');
    const searchResults = document.getElementById('searchResults');
    const searchStep = document.getElementById('searchStep');
    const detailsStep = document.getElementById('detailsStep');
    const reqTypeSelect = document.getElementById('reqType');

    function getReqMonthOptions() {
        let opts = '<option value="">Month</option>';
        MONTH_NAMES.forEach((m, i) => {
            opts += `<option value="${String(i + 1).padStart(2, '0')}">${m}</option>`;
        });
        return opts;
    }
    function getReqYearOptions() {
        const cy = new Date().getFullYear();
        let opts = '<option value="">Year</option>';
        for (let y = cy; y <= cy + 2; y++) {
            opts += `<option value="${y}">${y}</option>`;
        }
        return opts;
    }

    document.querySelectorAll('.req-month-select').forEach(el => el.innerHTML = getReqMonthOptions());
    document.querySelectorAll('.req-year-select').forEach(el => el.innerHTML = getReqYearOptions());

    document.getElementById('addRequestBtn').addEventListener('click', () => {
        selectedStudent = null;
        searchInput.value = '';
        searchResults.innerHTML = '<div class="search-result-item" style="color:#999; text-align:center;">Type to search...</div>';
        searchStep.classList.remove('hidden');
        detailsStep.classList.add('hidden');
        searchModal.classList.remove('hidden');
        searchModal.style.display = 'flex';
        searchInput.focus();
    });

    function closeSearchModal() {
        searchModal.classList.add('hidden');
        searchModal.style.display = 'none';
    }

    document.getElementById('closeSearchModal').addEventListener('click', closeSearchModal);
    document.getElementById('cancelReqBtn').addEventListener('click', closeSearchModal);
    searchModal.addEventListener('click', (e) => { if (e.target === searchModal) closeSearchModal(); });

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim();
        if (!query) {
            searchResults.innerHTML = '<div class="search-result-item" style="color:#999; text-align:center;">Type to search...</div>';
            return;
        }
        
        const q = query.toLowerCase();
        const matches = allStudentsData.filter(s => {
            const nameMatch = (s.nameCn && s.nameCn.toLowerCase().includes(q)) ||
                              (s.nickname && s.nickname.toLowerCase().includes(q)) ||
                              (s.namePinyin && s.namePinyin.toLowerCase().includes(q));
            if (!nameMatch) return false;

            const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {}); 
            return subjects.some(sub => sub.status === 'current');
        });
        
        if (matches.length === 0) {
            searchResults.innerHTML = '<div class="search-result-item" style="color:#999; text-align:center;">No current students found.</div>';
            return;
        }
        
        searchResults.innerHTML = matches.map(s => `
            <div class="search-result-item" data-id="${s.id}">
                <strong>${s.nameCn || '-'}</strong> (${s.nickname || '-'})
                <div style="font-size:0.8rem; color:#666;">Grade: ${s.grade || '-'}</div>
            </div>
        `).join('');
        
        searchResults.querySelectorAll('.search-result-item').forEach(item => {
            item.addEventListener('click', () => {
                const studentId = item.dataset.id;
                const student = allStudentsData.find(s => s.id === studentId);
                if (student) selectStudentForRequest(student);
            });
        });
    });

    function selectStudentForRequest(student) {
        selectedStudent = student;
        document.getElementById('selectedStudentName').textContent = `${student.nameCn || '-'} (${student.nickname || '-'})`;
        
        const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
        
        const availableSubjects = subjects.map((sub, idx) => ({ ...sub, originalIndex: idx }))
            .filter(sub => sub.status === 'current' && !sub.pendingRequest);
        
        const subjectSelect = document.getElementById('reqSubjectSelect');
        if (availableSubjects.length === 0) {
            subjectSelect.innerHTML = '<option value="">No available subjects (All dropped/paused or have pending requests)</option>';
            subjectSelect.disabled = true;
        } else {
            subjectSelect.innerHTML = availableSubjects.map(sub => 
                `<option value="${sub.originalIndex}">${sub.name || 'Unknown'}</option>`
            ).join('');
            subjectSelect.disabled = false;
        }
        
        searchStep.classList.add('hidden');
        detailsStep.classList.remove('hidden');
    }

    document.getElementById('backToSearchBtn').addEventListener('click', () => {
        searchStep.classList.remove('hidden');
        detailsStep.classList.add('hidden');
    });

    reqTypeSelect.addEventListener('change', () => {
        const isPause = reqTypeSelect.value === 'pause';
        document.getElementById('reqPauseFields').classList.toggle('hidden', !isPause);
        document.getElementById('reqDropFields').classList.toggle('hidden', isPause);
    });

    document.getElementById('saveReqBtn').addEventListener('click', async () => {
        if (!selectedStudent) return;
        const subjectIndex = parseInt(document.getElementById('reqSubjectSelect').value);
        const type = reqTypeSelect.value;
        const reason = document.getElementById('reqReason').value.trim();
        
        if (isNaN(subjectIndex)) return alert('⚠️ Please select a valid subject.');
        if (!reason) return alert('⚠️ Reason is required.');
        
        let pendingRequest = { type, reason };
        
        if (type === 'pause') {
            const fm = document.getElementById('reqPauseFromMonth').value;
            const fy = document.getElementById('reqPauseFromYear').value;
            const tm = document.getElementById('reqPauseToMonth').value;
            const ty = document.getElementById('reqPauseToYear').value;
            if (!fm || !fy || !tm || !ty) return alert('⚠️ Please select Pause From and To dates.');
            pendingRequest.pauseFromMonth = fm;
            pendingRequest.pauseFromYear = fy;
            pendingRequest.pauseToMonth = tm;
            pendingRequest.pauseToYear = ty;
        } else {
            const dm = document.getElementById('reqDropMonth').value;
            const dy = document.getElementById('reqDropYear').value;
            if (!dm || !dy) return alert('⚠️ Please select Drop Month and Year.');
            pendingRequest.dropMonth = dm;
            pendingRequest.dropYear = dy;
        }
        
        const saveBtn = document.getElementById('saveReqBtn');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        
        try {
            const studentRef = ref(db, `centers/${centerId}/students/${selectedStudent.id}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");
            
            const studentData = snap.val();
            let subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            
            if (!subjects[subjectIndex]) throw new Error("Subject not found");
            
            if (subjects[subjectIndex].pendingRequest) {
                throw new Error("This subject already has a pending request.");
            }
            
            subjects[subjectIndex].pendingRequest = pendingRequest;
            studentData.subjects = subjects;
            studentData.updatedAt = new Date().toISOString();
            
            await set(studentRef, studentData);
            
            const localStudent = allStudentsData.find(s => s.id === selectedStudent.id);
            if (localStudent) localStudent.subjects = subjects;
            
            renderTable();
            closeSearchModal();
            alert('✅ Drop/Pause Request added successfully!');
        } catch (err) {
            console.error("Save request error: ", err);
            alert('❌ Failed to save: ' + err.message);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 Save Request';
        }
    });

    // Initialize
    generateSubjectTabs();
    
    viewMode = 'year';
    singleMonthControls.classList.add('hidden');
    rangeControls.classList.remove('hidden');
    updateRangeEndLabel();
    generateMonthTabs(); 

    loadData();
}