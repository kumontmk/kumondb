import { auth, db, logout, syncPendingRequests } from './auth.js';
import { ref, get, set } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t } from './dropbook-i18n.js';

await i18nReady.catch(() => {});

const REQUIRED_PERMISSION = 'dropBook';
const centerId = sessionStorage.getItem('selectedCenter');

// ✅ Translated month names (refreshed once i18n is ready)
let MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function refreshMonthNames() {
    MONTH_NAMES = t('dropbook.months', { returnObjects: true });
}
i18nReady.then(refreshMonthNames).catch(() => {});

const SUBJECT_FILTERS = ['All Subjects', 'Math', 'English EFL', 'English ERP', 'Chinese'];

// ✅ Translate subject filter labels (internal values stay English for filtering)
function subjectFilterLabel(subject) {
    const map = {
        'All Subjects': 'dropbook.allSubjects',
        'Math': 'dropbook.subjectMath',
        'English EFL': 'dropbook.subjectEFL',
        'English ERP': 'dropbook.subjectERP',
        'Chinese': 'dropbook.subjectChinese'
    };
    return map[subject] ? t(map[subject]) : subject;
}

let allStudentsData = [];
let currentEditContext = null;
let viewMode = 'year';
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
    const cardsContainer = document.getElementById('dropBookCards'); // ✱ MOBILE: card list
    const modal = document.getElementById('detailModal');
    const callStatusBtn = document.getElementById('mCallStatusBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    const resumeSection = document.getElementById('resumeSection');
    const resumeMonthYearSel = document.getElementById('mResumeMonthYear');
    const cancelResumeBtn = document.getElementById('cancelResumeBtn');
    const cancelResumeRequestBtn = document.getElementById('cancelResumeRequestBtn');

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
    if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
    const nextMonthStr = String(nextMonth).padStart(2, '0');
    rangeStartMonthSel.value = nextMonthStr;
    rangeStartYearSel.value = nextYear;
    viewModeSelect.value = 'year';

    // ✱ MOBILE: segmented status filter → syncs hidden select used by existing logic
    const statusSegments = document.querySelectorAll('#statusSegmented .segment');
    statusSegments.forEach(btn => {
        btn.addEventListener('click', () => {
            statusSegments.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterStatus.value = btn.dataset.value;
            filterStatus.dispatchEvent(new Event('change'));
        });
    });

    function generateSubjectTabs() {
        subjectTabs.innerHTML = '';
        SUBJECT_FILTERS.forEach(subject => {
            const tab = document.createElement('button');
            tab.className = 'sub-tab-btn';
            if (subject === activeSubjectFilter) tab.classList.add('active');
            tab.textContent = subjectFilterLabel(subject);
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
            rangeControls.classList.add('hidden');
            generateMonthTabs();
        } else if (viewMode === 'range') {
            singleMonthControls.classList.add('hidden');
            rangeControls.classList.remove('hidden');
            updateRangeEndLabel();
            generateMonthTabs();
        }
        renderTable();
    });

    rangeStartMonthSel.addEventListener('change', () => { updateRangeEndLabel(); generateMonthTabs(); renderTable(); });
    rangeStartYearSel.addEventListener('change', () => { updateRangeEndLabel(); generateMonthTabs(); renderTable(); });

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
        if (viewMode === 'year') {
            const now = new Date();
            const currentYear = now.getFullYear();
            let defaultMonth = now.getMonth() + 2;
            let defaultYear = currentYear;
            if (defaultMonth > 12) { defaultMonth = 1; defaultYear += 1; }
            if (defaultYear !== currentYear) { defaultMonth = now.getMonth() + 1; defaultYear = currentYear; }

            for (let m = 1; m <= 12; m++) {
                const tab = document.createElement('button');
                tab.className = 'tab-btn';
                tab.textContent = `${MONTH_NAMES[m - 1]} ${currentYear}`;
                tab.dataset.month = String(m).padStart(2, '0');
                tab.dataset.year = currentYear;
                if (m === defaultMonth) { tab.classList.add('active'); activeTabMonth = tab.dataset.month; activeTabYear = tab.dataset.year; }
                tab.addEventListener('click', () => {
                    document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    activeTabMonth = tab.dataset.month;
                    activeTabYear = tab.dataset.year;
                    renderTable();
                });
                monthTabs.appendChild(tab);
            }
            if (!activeTabMonth) { const firstTab = monthTabs.querySelector('.tab-btn'); if (firstTab) firstTab.click(); }
        } else if (viewMode === 'range') {
            let startMonth = parseInt(rangeStartMonthSel.value);
            let startYear = parseInt(rangeStartYearSel.value);
            for (let i = 0; i < 12; i++) {
                let month = startMonth + i;
                let year = startYear;
                if (month > 12) { month = month - 12; year = year + 1; }
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
    }

    [filterMonth, filterYear, filterStatus].forEach(el =>
        el.addEventListener('change', () => {
            if (viewMode === 'single') { activeTabMonth = filterMonth.value; activeTabYear = filterYear.value; }
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
                tbody.innerHTML = `<tr><td colspan="12" class="empty-state">${t('dropbook.noStudentsFound')}</td></tr>`;
                if (cardsContainer) cardsContainer.innerHTML = `<div class="empty-state cards-empty">${t('dropbook.noStudentsFound')}</div>`;
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

    function getFilteredEntries() {
        const mStatus = filterStatus.value;
        const entries = [];
        allStudentsData.forEach(student => {
            const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
            subjects.forEach((sub, index) => {
                let targetMonth, targetYear, reason, type, isPending = false, isResume = false, isResumed = false;
                const hasActivePendingRequest = sub.pendingRequest && !sub.pendingRequest.cancelled && sub.pendingRequest.type;
                const isDirectDropPause = sub.status === 'drop' || sub.status === 'pause';
                const hasActiveResume = sub.resumeRequest && !sub.resumeRequest.processed && (sub.status === 'drop' || sub.status === 'pause');
                const isHistoricallyResumed = sub.resumed === true;

                if (hasActivePendingRequest) {
                    isPending = true;
                    type = sub.pendingRequest.type;
                    reason = sub.pendingRequest.reason;
                    if (type === 'drop') { targetMonth = sub.pendingRequest.dropMonth; targetYear = sub.pendingRequest.dropYear; }
                    else { targetMonth = sub.pendingRequest.pauseFromMonth; targetYear = sub.pendingRequest.pauseFromYear; }
                }
                else if (hasActiveResume) {
                    isResume = true;
                    type = sub.status;
                    reason = sub.status === 'drop' ? (sub.dropReason || 'Resume requested') : (sub.pauseReason || 'Resume requested');
                    targetMonth = sub.status === 'drop' ? sub.dropMonth : sub.pauseFromMonth;
                    targetYear = sub.status === 'drop' ? sub.dropYear : sub.pauseFromYear;
                }
                else if (isDirectDropPause) {
                    type = sub.status;
                    reason = sub.status === 'drop' ? sub.dropReason : sub.pauseReason;
                    targetMonth = sub.status === 'drop' ? sub.dropMonth : sub.pauseFromMonth;
                    targetYear = sub.status === 'drop' ? sub.dropYear : sub.pauseFromYear;
                }
                else if (isHistoricallyResumed) {
                    isResumed = true;
                    type = sub.dropMonth ? 'drop' : 'pause';
                    reason = type === 'drop' ? (sub.dropReason || 'Resumed') : (sub.pauseReason || 'Resumed');
                    targetMonth = type === 'drop' ? sub.dropMonth : sub.pauseFromMonth;
                    targetYear = type === 'drop' ? sub.dropYear : sub.pauseFromYear;
                }
                else if (sub.pendingRequest && sub.pendingRequest.cancelled) {
                    isPending = true;
                    type = sub.pendingRequest.type || 'drop';
                    reason = sub.pendingRequest.reason || 'Cancelled';
                    targetMonth = sub.pendingRequest.dropMonth || sub.pendingRequest.pauseFromMonth;
                    targetYear = sub.pendingRequest.dropYear || sub.pendingRequest.pauseFromYear;
                }
                else { return; }

                if (mStatus !== 'all' && type !== mStatus) return;
                if (!matchesSubjectFilter(sub.name)) return;
                if (!targetMonth || !targetYear) return;

                if (viewMode === 'single') {
                    const mMonth = filterMonth.value;
                    const mYear = filterYear.value;
                    if (mMonth && targetMonth !== mMonth) return;
                    if (mYear && targetYear !== mYear) return;
                } else if (viewMode === 'year') {
                    const currentYear = new Date().getFullYear();
                    if (parseInt(targetYear) !== currentYear) return;
                    if (activeTabMonth && activeTabYear) { if (targetMonth !== activeTabMonth || targetYear !== activeTabYear) return; }
                } else if (viewMode === 'range') {
                    let startMonth = parseInt(rangeStartMonthSel.value);
                    let startYear = parseInt(rangeStartYearSel.value);
                    const entryDate = new Date(parseInt(targetYear), parseInt(targetMonth) - 1);
                    const startDate = new Date(startYear, startMonth - 1);
                    const endDate = new Date(startDate);
                    endDate.setMonth(endDate.getMonth() + 11);
                    if (entryDate < startDate || entryDate > endDate) return;
                    if (activeTabMonth && activeTabYear) { if (targetMonth !== activeTabMonth || targetYear !== activeTabYear) return; }
                }

                let isCancelled = false;
                if (sub.pendingRequest && sub.pendingRequest.cancelled && !isDirectDropPause && !isResumed) isCancelled = true;

                entries.push({ studentId: student.id, subjectIndex: index, student, subject: sub, isPending, isCancelled, isResume, isResumed, targetMonth, targetYear, type, reason });
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

    // ✱ MOBILE: shared action-button click handler for table rows AND cards
    function handleRowAction(e) {
        const btn = e.target.closest('.confirm-row-btn');
        if (btn && !btn.disabled) {
            e.stopPropagation();
            const studentId = btn.dataset.studentId;
            const subjectIndex = parseInt(btn.dataset.subIndex);
            const action = btn.dataset.action;
            if (action === 'cancel') triggerCancelAction(studentId, subjectIndex);
            else if (action === 'cancel-resume') triggerCancelResumeAction(studentId, subjectIndex);
            else if (action === 'reinstate') triggerReinstateAction(studentId, subjectIndex);
            else triggerConfirmAction(studentId, subjectIndex);
        }
    }
    tbody.addEventListener('click', handleRowAction);
    cardsContainer?.addEventListener('click', handleRowAction);

    // ✱ MOBILE: renders BOTH the desktop table and the mobile card list
    function renderTable() {
        const entries = getFilteredEntries();
        tbody.innerHTML = '';
        if (cardsContainer) cardsContainer.innerHTML = '';

        if (entries.length === 0) {
            tbody.innerHTML = `<tr><td colspan="12" class="empty-state">${t('dropbook.noRecords')}</td></tr>`;
            if (cardsContainer) cardsContainer.innerHTML = `<div class="empty-state cards-empty">${t('dropbook.noRecords')}</div>`;
            return;
        }

        entries.forEach((entry, idx) => {
            const { student, subject, isPending, type, isCancelled, isResume, isResumed } = entry;
            const sub = entry.subject;
            const tMonth = entry.targetMonth;
            const tYear = entry.targetYear;
            const dateStr = tMonth && tYear ? `${MONTH_NAMES[parseInt(tMonth) - 1]} ${tYear}` : '-';

            const callStatus = sub.dropBook?.callStatus || false;
            const callBadge = callStatus ? '<span class="call-badge green">✔</span>' : '<span class="call-badge red">✖</span>';
            const statusText = type === 'drop' ? t('dropbook.statusDrop') : t('dropbook.statusPause');
            const statusClass = type === 'drop' ? 'status-badge-drop' : 'status-badge-pause';
            const reason = entry.reason || '-';
            const isConfirmed = sub.dropBook?.confirmed;
            const pendingBadge = (isPending && !isConfirmed && !isCancelled && !isResumed) ? `<span class="status-badge-pending">${t('dropbook.pendingBadge')}</span>` : '';
            const resumeBadge = isResume ? `<span class="status-badge-resume">${t('dropbook.resumePendingBadge')}</span>` : '';
            const resumedBadge = isResumed ? `<span class="status-badge-resumed">${t('dropbook.resumedBadge')}</span>` : '';

            let actionBtn = '';
            if (isResumed) {
                actionBtn = `<button class="confirm-row-btn" disabled style="padding: 0.3rem 0.6rem; font-size: 0.8rem; background:#dcfce7; color:#166534; border:1px solid #86efac;">${t('dropbook.resumedBtn')}</button>`;
            } else if (isCancelled) {
                actionBtn = `
                    <div style="display:flex; gap:4px; flex-wrap:wrap;">
                        <button class="confirm-row-btn cancelled" disabled style="padding: 0.3rem 0.6rem; font-size: 0.8rem;">${t('dropbook.cancelledBadge')}</button>
                        <button class="confirm-row-btn reinstate-btn" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" data-student-id="${student.id}" data-sub-index="${entry.subjectIndex}" data-action="reinstate">${t('dropbook.reinstate')}</button>
                    </div>
                `;
            } else if (isResume) {
                actionBtn = `
                    <div style="display:flex; gap:4px; flex-wrap:wrap;">
                        <button class="confirm-row-btn" disabled style="padding: 0.3rem 0.6rem; font-size: 0.8rem; background:#e8f5e9; color:#2e7d32; border:1px solid #a5d6a7;">${t('dropbook.resumePendingBtn')}</button>
                        <button class="confirm-row-btn cancel-btn" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" data-student-id="${student.id}" data-sub-index="${entry.subjectIndex}" data-action="cancel-resume">${t('dropbook.cancelResume')}</button>
                    </div>
                `;
            } else if (isConfirmed) {
                actionBtn = `<button class="confirm-row-btn confirmed" disabled>${t('dropbook.confirmedBtn')}</button>`;
            } else {
                const isDirectDropPause = (sub.status === 'drop' || sub.status === 'pause') && !isPending;
                const showCancelBtn = isPending || isDirectDropPause;
                const cancelBtnText = isPending ? t('dropbook.cancelRequest') : t('dropbook.cancelDropPauseBtn');
                actionBtn = `
                    <div style="display:flex; gap:4px; flex-wrap:wrap;">
                        <button class="confirm-row-btn" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" data-student-id="${student.id}" data-sub-index="${entry.subjectIndex}" data-action="confirm">${t('dropbook.confirm')}</button>
                        ${showCancelBtn ? `<button class="confirm-row-btn cancel-btn" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" data-student-id="${student.id}" data-sub-index="${entry.subjectIndex}" data-action="cancel">${cancelBtnText}</button>` : ''}
                    </div>
                `;
            }

            // ── 🖥️ Desktop table row ──
            const tr = document.createElement('tr');
            if (isCancelled) tr.classList.add('cancelled-row');
            if (isResumed) tr.classList.add('resumed-row');
            tr.innerHTML = `
                <td>${idx + 1}</td>
                <td>${student.nameCn || '-'} ${resumeBadge}${resumedBadge}</td>
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

            // ── 📱 Mobile card ──
            if (cardsContainer) {
                const card = document.createElement('div');
                card.className = `db-card ${type === 'drop' ? 'card-drop' : 'card-pause'}`;
                if (isCancelled) card.classList.add('cancelled-row');
                if (isResumed) card.classList.add('resumed-row');
                card.innerHTML = `
                    <div class="db-card-top">
                        <div class="db-card-name-row">
                            <span class="db-card-name">${student.nameCn || '-'}</span>
                            ${student.nickname ? `<span class="db-card-nick">(${student.nickname})</span>` : ''}
                            ${resumeBadge}${resumedBadge}
                        </div>
                        ${callBadge}
                    </div>
                    <div class="db-card-badges">
                        <span class="db-card-date">${dateStr}</span>
                        <span class="${statusClass}">${statusText}</span>
                        ${pendingBadge}
                    </div>
                    <div class="db-card-meta">
                        <span>📚 ${sub.name || '-'}</span>
                        <span>🎓 ${student.grade || '-'}</span>
                        <span>📈 ${sub.currentLevel || sub.startLevel || '-'}</span>
                    </div>
                    <div class="db-card-meta secondary-meta">
                        <span>🕒 ${formatSchedule(sub.timeslots)}</span>
                        <span>📞 ${getPhone(student)}</span>
                    </div>
                    ${reason && reason !== '-' ? `<div class="db-card-reason">💬 ${reason}</div>` : ''}
                    <div class="db-card-actions">${actionBtn}</div>
                `;
                card.addEventListener('click', () => openModal(entry));
                cardsContainer.appendChild(card);
            }
        });
    }

    async function triggerCancelAction(studentId, subjectIndex) {
        const student = allStudentsData.find(s => s.id === studentId);
        if (!student) return;
        const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
        const sub = subjects[subjectIndex];
        if (!sub) return;

        const hasActivePending = sub.pendingRequest && !sub.pendingRequest.cancelled && sub.pendingRequest.type;
        const isDirectDropPause = sub.status === 'drop' || sub.status === 'pause';

        let confirmMsg = t('dropbook.cancelPendingMsg');
        if (isDirectDropPause && !hasActivePending) confirmMsg = t('dropbook.cancelDropPauseMsg');
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
            alert(t('dropbook.cancelledSuccess'));
        } catch (err) {
            console.error("Cancel error: ", err);
            alert(t('dropbook.failedCancel', { message: err.message }));
        }
    }

    async function triggerCancelResumeAction(studentId, subjectIndex) {
        if (!confirm(t('dropbook.cancelResumeMsg'))) return;
        try {
            const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");
            const studentData = snap.val();
            let subjectsData = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            if (subjectsData[subjectIndex]) delete subjectsData[subjectIndex].resumeRequest;
            studentData.subjects = subjectsData;
            studentData.updatedAt = new Date().toISOString();
            await set(studentRef, studentData);

            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjectsData;
            renderTable();
            alert(t('dropbook.resumeCancelled'));
        } catch (err) {
            console.error("Cancel resume error: ", err);
            alert(t('dropbook.failedCancelResume', { message: err.message }));
        }
    }

    async function triggerReinstateAction(studentId, subjectIndex) {
        if (!confirm(t('dropbook.reinstateMsg'))) return;
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
            alert(t('dropbook.reinstatedSuccess'));
        } catch (err) {
            console.error("Reinstate error: ", err);
            alert(t('dropbook.failedReinstate', { message: err.message }));
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
                pauseFromMonth = pr.pauseFromMonth; pauseFromYear = pr.pauseFromYear;
                expectedReturnMonth = pr.pauseToMonth; expectedReturnYear = pr.pauseToYear;
            }
        } else {
            isPause = subject.status === 'pause';
            reason = subject.status === 'drop' ? subject.dropReason : subject.pauseReason;
            if (isPause) {
                pauseFromMonth = subject.pauseFromMonth; pauseFromYear = subject.pauseFromYear;
                expectedReturnMonth = subject.pauseToMonth; expectedReturnYear = subject.pauseToYear;
            }
        }

        document.getElementById('mReason').value = reason;

        const pauseFromGroup = document.getElementById('mPauseFromGroup');
        if (isPause && pauseFromMonth && pauseFromYear) {
            document.getElementById('mPauseFrom').value = `${MONTH_NAMES[parseInt(pauseFromMonth) - 1]} ${pauseFromYear}`;
            pauseFromGroup.style.display = 'flex';
        } else pauseFromGroup.style.display = 'none';

        const expectedReturnGroup = document.getElementById('mExpectedReturnGroup');
        if (isPause && expectedReturnMonth && expectedReturnYear) {
            let retMonth = parseInt(expectedReturnMonth) + 1;
            let retYear = parseInt(expectedReturnYear);
            if (retMonth > 12) { retMonth = 1; retYear++; }
            document.getElementById('mExpectedReturn').value = `${MONTH_NAMES[retMonth - 1]} ${retYear}`;
            expectedReturnGroup.style.display = 'flex';
        } else expectedReturnGroup.style.display = 'none';

        const dbInfo = subject.dropBook || {};
        updateCallStatusBtn(dbInfo.callStatus || false);
        document.getElementById('mCalledBy').value = dbInfo.calledBy || '';
        document.getElementById('mNotes').value = dbInfo.notes || '';
        document.getElementById('mExitAutopay').checked = dbInfo.exitFormAutopay || false;
        document.getElementById('mAccounts').value = dbInfo.accounts || '';

        const confirmDropBtn = document.getElementById('confirmDropBtn');
        confirmDropBtn.style.display = dbInfo.confirmed ? 'none' : 'inline-block';

        const cancelRequestBtn = document.getElementById('cancelRequestBtn');
        const reinstateRequestBtn = document.getElementById('reinstateRequestBtn');
        const isDirectDropPause = (subject.status === 'drop' || subject.status === 'pause') && !isPending;

        if (isPending && !subject.pendingRequest.cancelled) {
            cancelRequestBtn.style.display = 'inline-block';
            cancelRequestBtn.textContent = t('dropbook.cancelRequest');
            reinstateRequestBtn.style.display = 'none';
        } else if (isPending && subject.pendingRequest.cancelled) {
            cancelRequestBtn.style.display = 'none';
            reinstateRequestBtn.style.display = 'inline-block';
        } else if (isDirectDropPause) {
            cancelRequestBtn.style.display = 'inline-block';
            cancelRequestBtn.textContent = t('dropbook.cancelDropPauseBtn');
            reinstateRequestBtn.style.display = 'none';
        } else {
            cancelRequestBtn.style.display = 'none';
            reinstateRequestBtn.style.display = 'none';
        }

        const isDroppedOrPaused = subject.status === 'drop' || subject.status === 'pause';
        const hasActiveResume = subject.resumeRequest && !subject.resumeRequest.processed;

        if (isDroppedOrPaused && !hasActiveResume) {
            if (resumeBtn) resumeBtn.style.display = 'inline-block';
            if (cancelResumeRequestBtn) cancelResumeRequestBtn.style.display = 'none';
            if (resumeSection) resumeSection.style.display = 'none';
            if (resumeMonthYearSel) resumeMonthYearSel.value = '';
        } else if (isDroppedOrPaused && hasActiveResume) {
            if (resumeBtn) resumeBtn.style.display = 'none';
            if (cancelResumeRequestBtn) cancelResumeRequestBtn.style.display = 'inline-block';
            if (resumeSection) resumeSection.style.display = 'block';
            if (resumeMonthYearSel) {
                const rM = subject.resumeRequest.returnMonth || '';
                const rY = subject.resumeRequest.returnYear || '';
                resumeMonthYearSel.value = (rY && rM) ? `${rY}-${rM}` : '';
            }
        } else {
            if (resumeBtn) resumeBtn.style.display = 'none';
            if (cancelResumeRequestBtn) cancelResumeRequestBtn.style.display = 'none';
            if (resumeSection) resumeSection.style.display = 'none';
            if (resumeMonthYearSel) resumeMonthYearSel.value = '';
        }

        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }

    function updateCallStatusBtn(isCalled) {
        if (isCalled) { callStatusBtn.className = 'call-status-btn green'; callStatusBtn.textContent = t('dropbook.called'); }
        else { callStatusBtn.className = 'call-status-btn red'; callStatusBtn.textContent = t('dropbook.notCalled'); }
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
    document.getElementById('cancelModalBtn')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    document.getElementById('saveModalBtn').addEventListener('click', async () => {
        if (!currentEditContext) return;
        const { studentId, subjectIndex, isPending } = currentEditContext;
        const saveBtn = document.getElementById('saveModalBtn');

        const isCalled = callStatusBtn.classList.contains('green');
        const calledBy = document.getElementById('mCalledBy').value.trim();
        const notes = document.getElementById('mNotes').value.trim();
        if (isCalled) {
            if (!calledBy) { alert(t('dropbook.calledByRequired')); return; }
            if (!notes) { alert(t('dropbook.callNotesRequired')); return; }
        }

        saveBtn.disabled = true;
        saveBtn.textContent = t('dropbook.saving');

        try {
            const studentSnap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
            if (!studentSnap.exists()) throw new Error("Student not found");
            const studentData = studentSnap.val();
            let subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            if (!subjects[subjectIndex]) throw new Error("Subject not found");
            const sub = subjects[subjectIndex];

            const newReason = document.getElementById('mReason').value.trim();

            if (resumeSection && resumeSection.style.display !== 'none') {
                const rMY = resumeMonthYearSel ? resumeMonthYearSel.value : '';
                if (!rMY) {
                    alert(t('dropbook.selectReturnMonth'));
                    saveBtn.disabled = false;
                    saveBtn.textContent = t('dropbook.saveChanges');
                    return;
                }
                const [rYear, rMonth] = rMY.split('-');
                sub.resumeRequest = { returnMonth: rMonth, returnYear: rYear, requestedAt: new Date().toISOString(), processed: false };
            }

            if (isPending && sub.pendingRequest.type) sub.pendingRequest.reason = newReason;
            else {
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
            alert(t('dropbook.updatedSuccess'));
        } catch (err) {
            console.error("Save error: ", err);
            alert(t('dropbook.failedSave', { message: err.message }));
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = t('dropbook.saveChanges');
        }
    });

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

        let confirmMsg = t('dropbook.cancelPendingMsg');
        if (isDirectDropPause && !hasActivePending) confirmMsg = t('dropbook.cancelDropPauseMsg');
        if (!confirm(confirmMsg)) return;

        const btn = document.getElementById('cancelRequestBtn');
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = t('dropbook.cancelling');

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
            alert(t('dropbook.cancelledSuccess'));
        } catch (err) {
            console.error("Cancel error:", err);
            alert(t('dropbook.failedCancel', { message: err.message }));
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });

    document.getElementById('reinstateRequestBtn').addEventListener('click', async () => {
        if (!currentEditContext) return;
        if (!confirm(t('dropbook.reinstateMsg'))) return;
        const { studentId, subjectIndex } = currentEditContext;
        const btn = document.getElementById('reinstateRequestBtn');
        btn.disabled = true;
        btn.textContent = t('dropbook.reinstating');

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
            alert(t('dropbook.reinstatedSuccess'));
        } catch (err) {
            console.error("Reinstate error:", err);
            alert(t('dropbook.failedReinstate', { message: err.message }));
        } finally {
            btn.disabled = false;
            btn.textContent = t('dropbook.reinstateRequest');
        }
    });

    resumeBtn?.addEventListener('click', () => {
        if (resumeSection) resumeSection.style.display = 'block';
        if (resumeBtn) resumeBtn.style.display = 'none';
        const now = new Date();
        let nextM = now.getMonth() + 2;
        let nextY = now.getFullYear();
        if (nextM > 12) { nextM = 1; nextY++; }
        if (resumeMonthYearSel) resumeMonthYearSel.value = `${nextY}-${String(nextM).padStart(2, '0')}`;
    });

    cancelResumeBtn?.addEventListener('click', () => {
        if (resumeSection) resumeSection.style.display = 'none';
        if (resumeBtn) resumeBtn.style.display = 'inline-block';
        if (resumeMonthYearSel) resumeMonthYearSel.value = '';
    });

    cancelResumeRequestBtn?.addEventListener('click', async () => {
        if (!currentEditContext) return;
        if (!confirm(t('dropbook.cancelResumeMsg'))) return;
        const { studentId, subjectIndex } = currentEditContext;
        const btn = cancelResumeRequestBtn;
        btn.disabled = true;
        btn.textContent = t('dropbook.cancelling');

        try {
            const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");
            const studentData = snap.val();
            let subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            if (subjects[subjectIndex]) delete subjects[subjectIndex].resumeRequest;
            studentData.subjects = subjects;
            studentData.updatedAt = new Date().toISOString();
            await set(studentRef, studentData);

            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjects;
            renderTable();
            closeModal();
            alert(t('dropbook.resumeCancelled'));
        } catch (err) {
            console.error("Cancel resume error:", err);
            alert(t('dropbook.failedCancelResume', { message: err.message }));
        } finally {
            btn.disabled = false;
            btn.textContent = t('dropbook.cancelResume');
        }
    });

    const confirmActionModal = document.getElementById('confirmActionModal');
    const confirmTitle = document.getElementById('confirmTitle');
    const confirmMessage = document.getElementById('confirmMessage');
    let proceedConfirmBtn = document.getElementById('proceedConfirmBtn');

    document.getElementById('confirmDropBtn').addEventListener('click', () => {
        if (currentEditContext) triggerConfirmAction(currentEditContext.studentId, currentEditContext.subjectIndex);
    });
    document.getElementById('cancelConfirmBtn').addEventListener('click', () => {
        confirmActionModal.classList.add('hidden');
        confirmActionModal.style.display = 'none';
    });
    confirmActionModal.addEventListener('click', (e) => {
        if (e.target === confirmActionModal) { confirmActionModal.classList.add('hidden'); confirmActionModal.style.display = 'none'; }
    });

    function triggerConfirmAction(studentId, subjectIndex) {
        const student = allStudentsData.find(s => s.id === studentId);
        if (!student) return;
        const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
        const sub = subjects[subjectIndex];
        if (!sub || sub.dropBook?.confirmed) return;

        const isCalled = sub.dropBook?.callStatus || false;
        if (!isCalled) {
            confirmTitle.textContent = t('dropbook.parentsNotCalledTitle');
            confirmMessage.textContent = t('dropbook.parentsNotCalledMsg');
            proceedConfirmBtn.style.background = '#dc3545';
            proceedConfirmBtn.style.color = '#fff';
        } else {
            confirmTitle.textContent = t('dropbook.confirmDropPauseTitle');
            confirmMessage.textContent = t('dropbook.confirmDropPauseMsg');
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
                callStatus: isCalled, calledBy, notes, exitFormAutopay, accounts,
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
                        if (pr.type === 'drop') { sub.dropMonth = pr.dropMonth; sub.dropYear = pr.dropYear; sub.dropReason = pr.reason; }
                        else { sub.pauseFromMonth = pr.pauseFromMonth; sub.pauseFromYear = pr.pauseFromYear; sub.pauseToMonth = pr.pauseToMonth; sub.pauseToYear = pr.pauseToYear; sub.pauseReason = pr.reason; }
                        delete sub.pendingRequest;
                    }
                } else if (sub.status === 'drop' || sub.status === 'pause') delete sub.pendingRequest;
            }

            studentData.subjects = subjects;
            studentData.updatedAt = new Date().toISOString();
            await set(studentRef, studentData);

            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) localStudent.subjects = subjects;
            renderTable();

            const detailModal = document.getElementById('detailModal');
            if (!detailModal.classList.contains('hidden')) closeModal();
            alert(t('dropbook.confirmedSuccess'));
        } catch (err) {
            console.error("Confirm error: ", err);
            alert(t('dropbook.failedConfirm', { message: err.message }));
        }
    }

    const searchModal = document.getElementById('searchRequestModal');
    const searchInput = document.getElementById('searchStudentInput');
    const searchResults = document.getElementById('searchResults');
    const searchStep = document.getElementById('searchStep');
    const detailsStep = document.getElementById('detailsStep');
    const reqTypeSelect = document.getElementById('reqType');

    document.getElementById('addRequestBtn').addEventListener('click', () => {
        selectedStudent = null;
        searchInput.value = '';
        searchResults.innerHTML = `<div class="search-result-item" style="color:#999; text-align:center;">${t('dropbook.typeToSearch')}</div>`;
        searchStep.classList.remove('hidden');
        detailsStep.classList.add('hidden');
        searchModal.classList.remove('hidden');
        searchModal.style.display = 'flex';
        searchInput.focus();

        reqTypeSelect.value = 'pause';
        document.getElementById('reqPauseFields').classList.remove('hidden');
        document.getElementById('reqDropFields').classList.add('hidden');
        document.getElementById('reqReason').value = '';
        document.getElementById('reqPauseFrom').value = '';
        document.getElementById('reqPauseTo').value = '';
        document.getElementById('reqDrop').value = '';

        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        document.getElementById('reqPauseFrom').min = currentMonth;
        document.getElementById('reqPauseTo').min = currentMonth;
        document.getElementById('reqDrop').min = currentMonth;
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
            searchResults.innerHTML = `<div class="search-result-item" style="color:#999; text-align:center;">${t('dropbook.typeToSearch')}</div>`;
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
            searchResults.innerHTML = `<div class="search-result-item" style="color:#999; text-align:center;">${t('dropbook.noCurrentStudents')}</div>`;
            return;
        }

        searchResults.innerHTML = matches.map(s => `
            <div class="search-result-item" data-id="${s.id}">
                <strong>${s.nameCn || '-'}</strong> (${s.nickname || '-'})
                <div style="font-size:0.8rem; color:#666;">${t('dropbook.grade')}: ${s.grade || '-'}</div>
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
            subjectSelect.innerHTML = `<option value="">${t('dropbook.noAvailableSubjects')}</option>`;
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

        if (isNaN(subjectIndex)) return alert(t('dropbook.selectValidSubject'));
        if (!reason) return alert(t('dropbook.reasonRequired'));

        let pendingRequest = { type, reason };
        if (type === 'pause') {
            const pauseFromVal = document.getElementById('reqPauseFrom').value;
            const pauseToVal = document.getElementById('reqPauseTo').value;
            if (!pauseFromVal || !pauseToVal) return alert(t('dropbook.selectPauseDates'));
            const [fy, fm] = pauseFromVal.split('-');
            const [ty, tm] = pauseToVal.split('-');
            pendingRequest.pauseFromMonth = fm; pendingRequest.pauseFromYear = fy;
            pendingRequest.pauseToMonth = tm; pendingRequest.pauseToYear = ty;
        } else {
            const dropVal = document.getElementById('reqDrop').value;
            if (!dropVal) return alert(t('dropbook.selectDropMonth'));
            const [dy, dm] = dropVal.split('-');
            pendingRequest.dropMonth = dm; pendingRequest.dropYear = dy;
        }

        const saveBtn = document.getElementById('saveReqBtn');
        saveBtn.disabled = true;
        saveBtn.textContent = t('dropbook.saving');

        try {
            const studentRef = ref(db, `centers/${centerId}/students/${selectedStudent.id}`);
            const snap = await get(studentRef);
            if (!snap.exists()) throw new Error("Student not found");
            const studentData = snap.val();
            let subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects || {});
            if (!subjects[subjectIndex]) throw new Error("Subject not found");
            if (subjects[subjectIndex].pendingRequest) throw new Error(t('dropbook.pendingRequestExists'));

            subjects[subjectIndex].pendingRequest = pendingRequest;
            studentData.subjects = subjects;
            studentData.updatedAt = new Date().toISOString();
            await set(studentRef, studentData);

            const localStudent = allStudentsData.find(s => s.id === selectedStudent.id);
            if (localStudent) localStudent.subjects = subjects;
            renderTable();
            closeSearchModal();
            alert(t('dropbook.requestAdded'));
        } catch (err) {
            console.error("Save request error: ", err);
            alert(t('dropbook.failedSave', { message: err.message }));
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = t('dropbook.saveRequest');
        }
    });

    // Initialize
    generateSubjectTabs();
    viewMode = 'year';
    singleMonthControls.classList.add('hidden');
    rangeControls.classList.add('hidden');
    generateMonthTabs();
    loadData();
}