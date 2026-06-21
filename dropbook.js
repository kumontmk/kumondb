import { auth, db, logout } from './auth.js';
import { ref, get, set } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'dropBook';
const centerId = sessionStorage.getItem('selectedCenter');
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SUBJECT_FILTERS = ['All Subjects', 'Math', 'English EFL', 'English ERP', 'Chinese'];

let allStudentsData = [];
let currentEditContext = null;
let viewMode = 'single';
let activeTabMonth = null;
let activeTabYear = null;
let activeSubjectFilter = 'All Subjects';

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
            document.getElementById('accessDenied')?.classList.remove('hidden');
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

    // Default to current month/year
    const now = new Date();
    filterMonth.value = String(now.getMonth() + 1).padStart(2, '0');
    filterYear.value = now.getFullYear();
    rangeStartMonthSel.value = filterMonth.value;
    rangeStartYearSel.value = filterYear.value;

    // Generate Subject Tabs
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

    // View Mode Change Handler
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
            rangeStartMonthSel.value = '01';
            rangeStartYearSel.value = filterYear.value;
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

    // Range Controls Change Handlers
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
        if (viewMode === 'year') {
            startMonth = 1;
            startYear = parseInt(rangeStartYearSel.value);
        } else {
            startMonth = parseInt(rangeStartMonthSel.value);
            startYear = parseInt(rangeStartYearSel.value);
        }

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

        // Auto-select first tab
        const firstTab = monthTabs.querySelector('.tab-btn');
        if (firstTab) {
            firstTab.click();
        }
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
        try {
            const snap = await get(ref(db, `centers/${centerId}/students`));
            if (snap.exists()) {
                allStudentsData = Object.entries(snap.val()).map(([id, data]) => ({ id, ...data }));
                renderTable();
            } else {
                tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No students found.</td></tr>';
            }
        } catch (err) {
            console.error("Error loading students:", err);
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

    function getFilteredEntries() {
        const mStatus = filterStatus.value;
        const entries = [];

        allStudentsData.forEach(student => {
            const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
            subjects.forEach((sub, index) => {
                if (sub.status !== 'drop' && sub.status !== 'pause') return;
                if (mStatus !== 'all' && sub.status !== mStatus) return;

                // Subject filter
                if (!matchesSubjectFilter(sub.name)) return;

                let targetMonth = sub.status === 'drop' ? sub.dropMonth : sub.pauseFromMonth;
                let targetYear = sub.status === 'drop' ? sub.dropYear : sub.pauseFromYear;

                if (!targetMonth || !targetYear) return;

                // Filter based on view mode
                if (viewMode === 'single') {
                    const mMonth = filterMonth.value;
                    const mYear = filterYear.value;
                    if (mMonth && targetMonth !== mMonth) return;
                    if (mYear && targetYear !== mYear) return;
                } else if (viewMode === 'year' || viewMode === 'range') {
                    let startMonth, startYear;
                    if (viewMode === 'year') {
                        startMonth = 1;
                        startYear = parseInt(rangeStartYearSel.value);
                    } else {
                        startMonth = parseInt(rangeStartMonthSel.value);
                        startYear = parseInt(rangeStartYearSel.value);
                    }

                    const entryDate = new Date(parseInt(targetYear), parseInt(targetMonth) - 1);
                    const startDate = new Date(startYear, startMonth - 1);
                    const endDate = new Date(startDate);
                    endDate.setMonth(endDate.getMonth() + 11);

                    if (entryDate < startDate || entryDate > endDate) return;

                    if (activeTabMonth && activeTabYear) {
                        if (targetMonth !== activeTabMonth || targetYear !== activeTabYear) return;
                    }
                }

                entries.push({ studentId: student.id, subjectIndex: index, student, subject: sub });
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
            tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No records found for the selected filters.</td></tr>';
            return;
        }

        entries.forEach((entry, idx) => {
            const { student, subject } = entry;
            const sub = entry.subject;
            const tMonth = sub.status === 'drop' ? sub.dropMonth : sub.pauseFromMonth;
            const tYear = sub.status === 'drop' ? sub.dropYear : sub.pauseFromYear;
            
            const dateStr = tMonth && tYear ? `${MONTH_NAMES[parseInt(tMonth) - 1]} ${tYear}` : '-';
            const callStatus = sub.dropBook?.callStatus || false;
            const callBadge = callStatus ? '<span class="call-badge green">✔</span>' : '<span class="call-badge red">✖</span>';
            const statusClass = sub.status === 'drop' ? 'status-badge-drop' : 'status-badge-pause';
            const statusText = sub.status === 'drop' ? 'Drop' : 'Pause';
            const reason = sub.status === 'drop' ? (sub.dropReason || '-') : (sub.pauseReason || '-');

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${idx + 1}</td>
                <td>${student.nameCn || '-'}</td>
                <td>${student.nickname || '-'}</td>
                <td>${dateStr} <span class="${statusClass}">${statusText}</span></td>
                <td>${student.grade || '-'}</td>
                <td>${sub.name || '-'}</td>
                <td>${formatSchedule(sub.timeslots)}</td>
                <td>${sub.currentLevel || sub.startLevel || '-'}</td>
                <td>${getPhone(student)}</td>
                <td>${reason}</td>
                <td>${callBadge}</td>
            `;
            tr.addEventListener('click', () => openModal(entry));
            tbody.appendChild(tr);
        });
    }

    function openModal(entry) {
        const { student, subject, studentId, subjectIndex } = entry;
        currentEditContext = { studentId, subjectIndex };

        document.getElementById('mNameCn').value = student.nameCn || '-';
        document.getElementById('mNickname').value = student.nickname || '-';
        document.getElementById('mGrade').value = student.grade || '-';
        document.getElementById('mSubject').value = subject.name || '-';
        document.getElementById('mSchedule').value = formatSchedule(subject.timeslots);
        document.getElementById('mCurrentLevel').value = subject.currentLevel || subject.startLevel || '-';
        document.getElementById('mPhone').value = getPhone(student);
        document.getElementById('mEnrolDate').value = subject.enrolDate || '-';

        const reasonField = subject.status === 'drop' ? subject.dropReason : subject.pauseReason;
        document.getElementById('mReason').value = reasonField || '';

        // Expected Return (Pause only)
        const expectedReturnGroup = document.getElementById('mExpectedReturnGroup');
        if (subject.status === 'pause' && subject.pauseToMonth && subject.pauseToYear) {
            let retMonth = parseInt(subject.pauseToMonth) + 1;
            let retYear = parseInt(subject.pauseToYear);
            if (retMonth > 12) { retMonth = 1; retYear++; }
            document.getElementById('mExpectedReturn').value = `${MONTH_NAMES[retMonth - 1]} ${retYear}`;
            expectedReturnGroup.style.display = 'flex';
        } else {
            expectedReturnGroup.style.display = 'none';
        }

        // DropBook specific fields
        const dbInfo = subject.dropBook || {};
        updateCallStatusBtn(dbInfo.callStatus || false);
        document.getElementById('mCalledBy').value = dbInfo.calledBy || '';
        document.getElementById('mNotes').value = dbInfo.notes || '';
        document.getElementById('mExitAutopay').checked = dbInfo.exitFormAutopay || false;
        document.getElementById('mAccounts').value = dbInfo.accounts || '';

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
        const { studentId, subjectIndex } = currentEditContext;
        const saveBtn = document.getElementById('saveModalBtn');
        
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
            const studentSnap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
            if (!studentSnap.exists()) throw new Error("Student not found");
            
            const studentData = studentSnap.val();
            let subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            
            if (!subjects[subjectIndex]) throw new Error("Subject not found");

            const sub = subjects[subjectIndex];
            const isDrop = sub.status === 'drop';
            
            // 1. Sync Reason back to Student Form structure
            const newReason = document.getElementById('mReason').value.trim();
            if (isDrop) sub.dropReason = newReason;
            else sub.pauseReason = newReason;

            // 2. Save Drop Book specific metadata
            sub.dropBook = {
                callStatus: callStatusBtn.classList.contains('green'),
                calledBy: document.getElementById('mCalledBy').value.trim(),
                notes: document.getElementById('mNotes').value.trim(),
                exitFormAutopay: document.getElementById('mExitAutopay').checked,
                accounts: document.getElementById('mAccounts').value.trim(),
                updatedAt: new Date().toISOString()
            };

            studentData.subjects = subjects;
            studentData.updatedAt = new Date().toISOString();

            // Save back to Firebase
            await set(ref(db, `centers/${centerId}/students/${studentId}`), studentData);
            
            // Update local cache so table refreshes instantly
            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjects;

            renderTable();
            closeModal();
            alert('✅ Drop Book entry updated successfully!');
        } catch (err) {
            console.error("Save error:", err);
            alert('❌ Failed to save: ' + err.message);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 Save Changes';
        }
    });

    // Initialize subject tabs
    generateSubjectTabs();
    
    // Initialize month tabs for single view
    if (viewMode === 'single') {
        activeTabMonth = filterMonth.value;
        activeTabYear = filterYear.value;
    }
    
    loadData();
}