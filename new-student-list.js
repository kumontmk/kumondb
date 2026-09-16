import { auth, db, logout } from './auth.js';
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t } from './new-student-list-i18n.js';

// Wait for i18n before first render
await i18nReady.catch(() => {});

const REQUIRED_PERMISSION = 'newStudentList';
const centerId = sessionStorage.getItem('selectedCenter');

// ✅ Translated month names (refreshed once i18n is ready)
let MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function refreshMonthNames() {
    MONTH_NAMES = t('nsl.months', { returnObjects: true });
}
i18nReady.then(refreshMonthNames).catch(() => {});

let allStudentsData = [];
let viewMode = 'year';
let activeTabMonth = null;
let activeTabYear = null;
let currentDtContext = null;

// === NEW DIRTY TRACKING VARIABLES ===
let dirtyChanges = new Map();
let isSaving = false;
let hideSaveBarTimer = null;

// 1. Auth & Permission Check
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'index.html'; return; }
    try {
        const userSnap = await get(ref(db, `users/${user.uid}`));
        if (!userSnap.exists()) { window.location.href = 'index.html'; return; }

        const userData = userSnap.val();
        const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
        const dashPerms = userData.permissions?.dashboardCards || {};
        const hasAccess = isAdmin || dashPerms[REQUIRED_PERMISSION] === true || dashPerms['editStudent'] === true;

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
    const viewModeSelect = document.getElementById('viewMode');
    const singleMonthControls = document.getElementById('singleMonthControls');
    const rangeControls = document.getElementById('rangeControls');
    const rangeStartMonthSel = document.getElementById('rangeStartMonth');
    const rangeStartYearSel = document.getElementById('rangeStartYear');
    const rangeEndLabel = document.getElementById('rangeEndLabel');
    const monthTabs = document.getElementById('monthTabs');
    const tbody = document.getElementById('newStudentBody');
    const cardList = document.getElementById('cardList');
    const dataArea = document.getElementById('dataArea');
    const resultCount = document.getElementById('resultCount');

    // === NEW SAVE BAR ELEMENTS ===
    const saveActionBar = document.getElementById('saveActionBar');
    const saveChangesBtn = document.getElementById('saveChangesBtn');
    const discardChangesBtn = document.getElementById('discardChangesBtn');
    const saveStatusText = document.getElementById('saveStatusText');

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
    filterYear.value = currentYear;
    let currentMonth = now.getMonth() + 1;
    rangeStartMonthSel.value = String(currentMonth).padStart(2, '0');
    rangeStartYearSel.value = currentYear;
    viewModeSelect.value = 'year';

    function updateRangeEndLabel() {
        const startMonth = parseInt(rangeStartMonthSel.value);
        const startYear = parseInt(rangeStartYearSel.value);
        let endMonth = startMonth + 11;
        let endYear = startYear;
        if (endMonth > 12) { endMonth -= 12; endYear += 1; }
        rangeEndLabel.textContent = t('nsl.rangeEnd', { month: MONTH_NAMES[endMonth - 1], year: endYear });
    }

    function generateMonthTabs() {
        monthTabs.innerHTML = '';
        let startMonth = parseInt(rangeStartMonthSel.value);
        let startYear = parseInt(rangeStartYearSel.value);
        for (let i = 0; i < 12; i++) {
            let month = startMonth + i;
            let year = startYear;
            if (month > 12) { month -= 12; year += 1; }
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

    viewModeSelect.addEventListener('change', () => {
        viewMode = viewModeSelect.value;
        if (viewMode === 'single') {
            singleMonthControls.classList.remove('hidden');
            rangeControls.classList.add('hidden');
            monthTabs.innerHTML = '';
            activeTabMonth = filterMonth.value;
            activeTabYear = filterYear.value;
        } else {
            singleMonthControls.classList.add('hidden');
            rangeControls.classList.remove('hidden');
            updateRangeEndLabel();
            generateMonthTabs();
        }
        renderTable();
    });

    [rangeStartMonthSel, rangeStartYearSel].forEach(el => el.addEventListener('change', () => {
        updateRangeEndLabel();
        generateMonthTabs();
        renderTable();
    }));

    [filterMonth, filterYear].forEach(el => el.addEventListener('change', () => {
        if (viewMode === 'single') {
            activeTabMonth = filterMonth.value;
            activeTabYear = filterYear.value;
        }
        renderTable();
    }));

    async function loadData() {
        if (!centerId) {
            document.getElementById('page-loader')?.classList.add('hidden');
            tbody.innerHTML = `<tr><td colspan="22" style="text-align:center; padding:2rem; color:#dc3545;">${t('nsl.noCenterSelected')}</td></tr>`;
            if (cardList) cardList.innerHTML = `<div class="empty-state" style="color:#dc3545;">${t('nsl.noCenterSelected')}</div>`;
            return;
        }
        try {
            const snap = await get(ref(db, `centers/${centerId}/students`));
            if (snap.exists()) {
                allStudentsData = Object.entries(snap.val()).map(([id, data]) => ({ id, ...data }));
                renderTable();
            } else {
                tbody.innerHTML = `<tr><td colspan="22" style="text-align:center; padding:2rem;">${t('nsl.noStudentsFound')}</td></tr>`;
                if (cardList) cardList.innerHTML = `<div class="empty-state">${t('nsl.noStudentsFound')}</div>`;
            }
        } catch (err) {
            console.error("Error loading students:", err);
        } finally {
            document.getElementById('page-loader')?.classList.add('hidden');
        }
    }

    /* ================= SUBJECT HELPERS ================= */
    function getSubjectEntries(student) {
        const subjects = student?.subjects;
        if (!subjects) return [];
        if (Array.isArray(subjects)) {
            return subjects.map((value, key) => ({ key: String(key), value: value || {} }));
        }
        return Object.entries(subjects).map(([key, value]) => ({ key: String(key), value: value || {} }));
    }

    /* ================= DIRTY TRACKING ================= */
    function getChangeKey(el) {
        return `${el.dataset.sid}|${el.dataset.subkey}|${el.dataset.field}`;
    }

    function markDirty(el) {
        const sid = el.dataset.sid;
        const subkey = el.dataset.subkey;
        const field = el.dataset.field;
        if (!sid || !subkey || !field) return;

        const key = getChangeKey(el);
        dirtyChanges.set(key, { sid, subkey, field, value: el.value });
        el.classList.add('dirty');
        updateSaveBar();
    }

    function restoreDirtyValues() {
        if (dirtyChanges.size === 0) return;
        dirtyChanges.forEach((change) => {
            const selector = `.inline-save[data-sid="${CSS.escape(change.sid)}"][data-subkey="${CSS.escape(change.subkey)}"][data-field="${CSS.escape(change.field)}"]`;
            const el = dataArea.querySelector(selector);
            if (!el) return;
            el.value = change.value;
            el.classList.add('dirty');
            if (change.field === 'enrolled') {
                updateEnrolledVisual(el);
            }
        });
    }

    function updateEnrolledVisual(el) {
        const yes = el.value === 'Yes';
        const row = el.closest('tr');
        if (row) {
            row.classList.remove('row-enrolled-yes', 'row-enrolled-no');
            row.classList.add(yes ? 'row-enrolled-yes' : 'row-enrolled-no');
        }
        const card = el.closest('.student-card');
        if (card) {
            card.classList.remove('card-enrolled-yes', 'card-enrolled-no');
            card.classList.add(yes ? 'card-enrolled-yes' : 'card-enrolled-no');
        }
    }

    /* ================= SAVE BAR UI ================= */
    function refreshSaveControls() {
        if (!saveChangesBtn || !discardChangesBtn) return;
        saveChangesBtn.disabled = isSaving || dirtyChanges.size === 0;
        discardChangesBtn.disabled = isSaving || dirtyChanges.size === 0;
    }

    function showSaveBar(message) {
        if (!saveActionBar || !saveStatusText) return;
        clearTimeout(hideSaveBarTimer);
        saveStatusText.textContent = message;
        saveActionBar.classList.remove('hidden');
    }

    function updateSaveBar() {
        refreshSaveControls();
        if (isSaving) {
            showSaveBar('Saving...');
            return;
        }
        const count = dirtyChanges.size;
        if (count > 0) {
            showSaveBar(`${count} unsaved change${count === 1 ? '' : 's'}`);
        }
    }

    /* ================= LOCAL DATA SYNC ================= */
    function updateLocalFromChange(change) {
        const student = allStudentsData.find(s => s.id === change.sid);
        if (!student) return;
        const entry = getSubjectEntries(student).find(e => e.key === change.subkey);
        if (!entry) return;

        if (change.value === '') {
            delete entry.value[change.field];
        } else {
            entry.value[change.field] = change.value;
        }
        entry.value.updatedAt = new Date().toISOString();

        if (Array.isArray(student.subjects)) {
            const idx = Number(change.subkey);
            if (Number.isInteger(idx)) {
                student.subjects[idx] = entry.value;
            }
        } else if (student.subjects && typeof student.subjects === 'object') {
            student.subjects[change.subkey] = entry.value;
        } else {
            student.subjects = { [change.subkey]: entry.value };
        }
    }

    function getFilteredEntries() {
        const entries = [];
        allStudentsData.forEach(student => {
            getSubjectEntries(student).forEach(({ key, value: sub }) => {
                if (!sub.enrolDate) return;
                const date = new Date(sub.enrolDate);
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const year = date.getFullYear().toString();
                let match = false;
                if (viewMode === 'single') {
                    match = (month === filterMonth.value && year === filterYear.value);
                } else {
                    let startMonth = parseInt(rangeStartMonthSel.value);
                    let startYear = parseInt(rangeStartYearSel.value);
                    const entryDate = new Date(parseInt(year), parseInt(month) - 1);
                    const startDate = new Date(startYear, startMonth - 1);
                    const endDate = new Date(startDate);
                    endDate.setMonth(endDate.getMonth() + 11);
                    if (entryDate >= startDate && entryDate <= endDate) {
                        if (!activeTabMonth || (month === activeTabMonth && year === activeTabYear)) {
                            match = true;
                        }
                    }
                }
                if (match) {
                    entries.push({ student, subject: sub, subjectKey: key, enrolMonth: month, enrolYear: year });
                }
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
    function getPoComment(student) {
        if (student.parentOrientation === 'Yes') return student.poDate || '-';
        if (student.parentOrientation === 'No') return student.poReason || '-';
        return '-';
    }
    function getDisplayName(student) {
        const cn = student.nameCn?.trim();
        if (cn && cn !== '-') return cn;
        const pinyin = student.namePinyin?.trim();
        if (pinyin && pinyin !== '-') return pinyin;
        const nick = student.nickname?.trim();
        if (nick && nick !== '-') return nick;
        return '-';
    }

    /* ================= RENDER: TABLE (desktop) + CARDS (mobile) ================= */
    function renderTable() {
        const entries = getFilteredEntries();

        if (resultCount) {
            resultCount.textContent = t('nsl.recordCount', { count: entries.length });
        }

        tbody.innerHTML = '';
        if (entries.length === 0) {
            tbody.innerHTML = `<tr><td colspan="22" style="text-align:center; padding:2rem;">${t('nsl.noNewStudents')}</td></tr>`;
        } else {
            entries.forEach((entry, idx) => {
                const { student, subject: sub, subjectKey } = entry;
                const enrolledVal = sub.enrolled || 'No';
                const rowClass = enrolledVal === 'Yes' ? 'row-enrolled-yes' : 'row-enrolled-no';

                let dtDisplay = `<button class="dt-cell-btn" data-student="${student.id}" data-subkey="${subjectKey}">${t('nsl.selectDT')}<br><small>${sub.name || ''}</small></button>`;
                if (sub.selectedDT) {
                    dtDisplay = `<button class="dt-cell-btn has-dt" data-student="${student.id}" data-subkey="${subjectKey}">
                        <strong>${sub.name || '-'}</strong><br>
                        <span>${sub.selectedDT.date || '-'}</span><br>
                        <small>${sub.selectedDT.test || ''}</small>
                    </button>`;
                }

                const tr = document.createElement('tr');
                tr.className = rowClass;
                tr.innerHTML = `
                    <td>${idx + 1}</td>
                    <td>${getDisplayName(student)}</td>
                    <td>
                        <select class="inline-save" data-field="refCode" data-sid="${student.id}" data-subkey="${subjectKey}">
                            <option value="" ${!sub.refCode ? 'selected' : ''}>-</option>
                            <option value="IT" ${sub.refCode === 'IT' ? 'selected' : ''}>IT</option>
                            <option value="EO" ${sub.refCode === 'EO' ? 'selected' : ''}>EO</option>
                        </select>
                    </td>
                    <td>
                        <select class="inline-save" data-field="enrolled" data-sid="${student.id}" data-subkey="${subjectKey}">
                            <option value="No" ${enrolledVal === 'No' ? 'selected' : ''}>${t('nsl.enrolledNo')}</option>
                            <option value="Yes" ${enrolledVal === 'Yes' ? 'selected' : ''}>${t('nsl.enrolledYes')}</option>
                        </select>
                    </td>
                    <td>${getPhone(student)}</td>
                    <td>${student.school || '-'}</td>
                    <td>${student.grade || '-'}</td>
                    <td>${student.birthday || '-'}</td>
                    <td>${student.parentOrientation || '-'}</td>
                    <td>${getPoComment(student)}</td>
                    <td><strong>${sub.name || '-'}</strong></td>
                    <td>${formatSchedule(sub.timeslots)}</td>
                    <td><input type="date" class="inline-save" data-field="startDate" data-sid="${student.id}" data-subkey="${subjectKey}" value="${sub.startDate || sub.enrolDate || ''}"></td>
                    <td>
                        <select class="inline-save" data-field="paymentType" data-sid="${student.id}" data-subkey="${subjectKey}">
                            <option value="" ${!sub.paymentType ? 'selected' : ''}>-</option>
                            <option value="Whole" ${sub.paymentType === 'Whole' ? 'selected' : ''}>${t('nsl.paymentWhole')}</option>
                            <option value="Half" ${sub.paymentType === 'Half' ? 'selected' : ''}>${t('nsl.paymentHalf')}</option>
                        </select>
                    </td>
                    <td><input type="text" class="inline-save" data-field="cd1" data-sid="${student.id}" data-subkey="${subjectKey}" value="${sub.cd1 || ''}" style="width:60px;"></td>
                    <td><input type="text" class="inline-save" data-field="cd2" data-sid="${student.id}" data-subkey="${subjectKey}" value="${sub.cd2 || ''}" style="width:60px;"></td>
                    <td>${dtDisplay}</td>
                    <td>${sub.enrolDate || '-'}</td>
                    <td>
                        <select class="inline-save" data-field="admFee" data-sid="${student.id}" data-subkey="${subjectKey}">
                            <option value="" ${!sub.admFee ? 'selected' : ''}>-</option>
                            <option value="Y" ${sub.admFee === 'Y' ? 'selected' : ''}>Y</option>
                            <option value="N" ${sub.admFee === 'N' ? 'selected' : ''}>N</option>
                        </select>
                    </td>
                    <td><input type="number" class="inline-save" data-field="payment1" data-sid="${student.id}" data-subkey="${subjectKey}" value="${sub.payment1 || ''}"></td>
                    <td><input type="number" class="inline-save" data-field="payment2" data-sid="${student.id}" data-subkey="${subjectKey}" value="${sub.payment2 || ''}"></td>
                    <td>
                        <select class="inline-save" data-field="bag" data-sid="${student.id}" data-subkey="${subjectKey}">
                            <option value="" ${!sub.bag ? 'selected' : ''}>-</option>
                            <option value="Y" ${sub.bag === 'Y' ? 'selected' : ''}>Y</option>
                            <option value="N" ${sub.bag === 'N' ? 'selected' : ''}>N</option>
                        </select>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }

        renderCards(entries);
        restoreDirtyValues(); // Restore unsaved changes if table/cards re-rendered
    }

    /* ================= MOBILE CARD BUILDER ================= */
    function buildCard(entry, idx) {
        const { student, subject: sub, subjectKey } = entry;
        const enrolledVal = sub.enrolled || 'No';
        const cardClass = enrolledVal === 'Yes' ? 'card-enrolled-yes' : 'card-enrolled-no';
        const sid = student.id;

        const dtBtn = sub.selectedDT
            ? `<button type="button" class="dt-cell-btn has-dt" data-student="${sid}" data-subkey="${subjectKey}">
                <strong>${sub.name || '-'}</strong><br>
                <span>${sub.selectedDT.date || '-'}</span> · <small>${sub.selectedDT.test || ''}</small>
            </button>`
            : `<button type="button" class="dt-cell-btn" data-student="${sid}" data-subkey="${subjectKey}">
                ${t('nsl.selectDT')}<br><small>${sub.name || ''}</small>
            </button>`;

        return `
        <article class="student-card ${cardClass}">
            <div class="card-top">
                <div class="card-title">
                    <span class="card-index">${idx + 1}</span>
                    <div class="card-name-wrap">
                        <h3 class="card-name">${getDisplayName(student)}</h3>
                        <div class="card-sub">
                            <span class="subject-badge">${sub.name || '-'}</span>
                            <span class="muted">${formatSchedule(sub.timeslots)}</span>
                        </div>
                    </div>
                </div>
                <select class="inline-save enrolled-pill" data-field="enrolled" data-sid="${sid}" data-subkey="${subjectKey}">
                    <option value="No" ${enrolledVal === 'No' ? 'selected' : ''}>${t('nsl.enrolledNo')}</option>
                    <option value="Yes" ${enrolledVal === 'Yes' ? 'selected' : ''}>${t('nsl.enrolledYes')}</option>
                </select>
            </div>

            <div class="card-meta">
                <div><span class="lbl">${t('nsl.cardPhone')}</span><span>${getPhone(student)}</span></div>
                <div><span class="lbl">${t('nsl.cardSchool')}</span><span>${student.school || '-'}</span></div>
                <div><span class="lbl">${t('nsl.cardGrade')}</span><span>${student.grade || '-'}</span></div>
                <div><span class="lbl">${t('nsl.cardDob')}</span><span>${student.birthday || '-'}</span></div>
                <div><span class="lbl">${t('nsl.cardPo')}</span><span>${student.parentOrientation || '-'}</span></div>
                <div><span class="lbl">${t('nsl.cardPoComment')}</span><span>${getPoComment(student)}</span></div>
            </div>

            <button type="button" class="card-toggle" aria-expanded="false">
                <span>${t('nsl.cardDetails')}</span><span class="chevron">▾</span>
            </button>

            <div class="card-details"><div class="details-inner">
                <div class="field-grid">
                    <label class="field"><span class="lbl">${t('nsl.cardRef')}</span>
                        <select class="inline-save" data-field="refCode" data-sid="${sid}" data-subkey="${subjectKey}">
                            <option value="" ${!sub.refCode ? 'selected' : ''}>-</option>
                            <option value="IT" ${sub.refCode === 'IT' ? 'selected' : ''}>IT</option>
                            <option value="EO" ${sub.refCode === 'EO' ? 'selected' : ''}>EO</option>
                        </select>
                    </label>
                    <label class="field"><span class="lbl">${t('nsl.cardStartDate')}</span>
                        <input type="date" class="inline-save" data-field="startDate" data-sid="${sid}" data-subkey="${subjectKey}" value="${sub.startDate || sub.enrolDate || ''}">
                    </label>
                    <label class="field"><span class="lbl">${t('nsl.cardPayment')}</span>
                        <select class="inline-save" data-field="paymentType" data-sid="${sid}" data-subkey="${subjectKey}">
                            <option value="" ${!sub.paymentType ? 'selected' : ''}>-</option>
                            <option value="Whole" ${sub.paymentType === 'Whole' ? 'selected' : ''}>${t('nsl.paymentWhole')}</option>
                            <option value="Half" ${sub.paymentType === 'Half' ? 'selected' : ''}>${t('nsl.paymentHalf')}</option>
                        </select>
                    </label>
                    <div class="field"><span class="lbl">${t('nsl.cardEnrolledDate')}</span>
                        <span class="readonly-value">${sub.enrolDate || '-'}</span>
                    </div>
                    <label class="field"><span class="lbl">${t('nsl.cardCd1')}</span>
                        <input type="text" class="inline-save" data-field="cd1" data-sid="${sid}" data-subkey="${subjectKey}" value="${sub.cd1 || ''}">
                    </label>
                    <label class="field"><span class="lbl">${t('nsl.cardCd2')}</span>
                        <input type="text" class="inline-save" data-field="cd2" data-sid="${sid}" data-subkey="${subjectKey}" value="${sub.cd2 || ''}">
                    </label>
                    <label class="field"><span class="lbl">${t('nsl.cardAdmFee')}</span>
                        <select class="inline-save" data-field="admFee" data-sid="${sid}" data-subkey="${subjectKey}">
                            <option value="" ${!sub.admFee ? 'selected' : ''}>-</option>
                            <option value="Y" ${sub.admFee === 'Y' ? 'selected' : ''}>Y</option>
                            <option value="N" ${sub.admFee === 'N' ? 'selected' : ''}>N</option>
                        </select>
                    </label>
                    <label class="field"><span class="lbl">${t('nsl.cardBag')}</span>
                        <select class="inline-save" data-field="bag" data-sid="${sid}" data-subkey="${subjectKey}">
                            <option value="" ${!sub.bag ? 'selected' : ''}>-</option>
                            <option value="Y" ${sub.bag === 'Y' ? 'selected' : ''}>Y</option>
                            <option value="N" ${sub.bag === 'N' ? 'selected' : ''}>N</option>
                        </select>
                    </label>
                    <label class="field"><span class="lbl">${t('nsl.cardPay1')}</span>
                        <input type="number" inputmode="decimal" class="inline-save" data-field="payment1" data-sid="${sid}" data-subkey="${subjectKey}" value="${sub.payment1 || ''}">
                    </label>
                    <label class="field"><span class="lbl">${t('nsl.cardPay2')}</span>
                        <input type="number" inputmode="decimal" class="inline-save" data-field="payment2" data-sid="${sid}" data-subkey="${subjectKey}" value="${sub.payment2 || ''}">
                    </label>
                    <div class="field field-full"><span class="lbl">${t('nsl.cardDt')}</span>${dtBtn}</div>
                </div>
            </div></div>
        </article>`;
    }

    function renderCards(entries) {
        if (!cardList) return;
        if (entries.length === 0) {
            cardList.innerHTML = `<div class="empty-state">${t('nsl.noNewStudents')}</div>`;
            return;
        }
        cardList.innerHTML = entries.map(buildCard).join('');
    }

    /* ================= DIRTY FIELD LISTENERS ================= */
    function handleDirtyFieldEdit(e) {
        const el = e.target.closest('.inline-save');
        if (!el) return;
        markDirty(el);
        if (el.dataset.field === 'enrolled') {
            updateEnrolledVisual(el);
        }
    }
    dataArea.addEventListener('input', handleDirtyFieldEdit);
    dataArea.addEventListener('change', handleDirtyFieldEdit);

    dataArea.addEventListener('click', (e) => {
        // Card accordion toggle
        const toggle = e.target.closest('.card-toggle');
        if (toggle) {
            const card = toggle.closest('.student-card');
            const expanded = card.classList.toggle('expanded');
            toggle.setAttribute('aria-expanded', expanded);
            return;
        }
        // DT picker button
        const btn = e.target.closest('.dt-cell-btn');
        if (btn) {
            currentDtContext = {
                studentId: btn.dataset.student,
                subjectKey: btn.dataset.subkey
            };
            openDtModal();
        }
    });

    /* ================= SAVE ALL CHANGES ================= */
    async function saveAllChanges() {
        if (isSaving) return;
        if (!centerId) {
            showSaveBar('No center selected');
            return;
        }
        if (document.activeElement?.classList?.contains('inline-save')) {
            markDirty(document.activeElement);
        }
        if (dirtyChanges.size === 0) return;

        isSaving = true;
        updateSaveBar();

        const updates = {};
        const now = new Date().toISOString();

        dirtyChanges.forEach(change => {
            const value = change.value === '' ? null : change.value;
            updates[`${change.sid}/subjects/${change.subkey}/${change.field}`] = value;
            updates[`${change.sid}/updatedAt`] = now;
        });

        try {
            await update(ref(db, `centers/${centerId}/students`), updates);
            dirtyChanges.forEach(change => updateLocalFromChange(change));

            dataArea.querySelectorAll('.inline-save.dirty').forEach(el => {
                el.classList.remove('dirty');
                el.classList.add('saved-flash');
                setTimeout(() => { el.classList.remove('saved-flash'); }, 700);
            });

            dirtyChanges.clear();
            isSaving = false;
            refreshSaveControls();
            showSaveBar('All changes saved');

            clearTimeout(hideSaveBarTimer);
            hideSaveBarTimer = setTimeout(() => {
                if (dirtyChanges.size === 0 && !isSaving) {
                    saveActionBar?.classList.add('hidden');
                }
            }, 2500);
        } catch (err) {
            console.error('Save all error:', err);
            isSaving = false;
            refreshSaveControls();
            showSaveBar(`Save failed: ${err.message}`);
        }
    }

    /* ================= DISCARD CHANGES ================= */
    function discardAllChanges() {
        if (isSaving || dirtyChanges.size === 0) return;
        const confirmed = confirm('Discard unsaved changes?');
        if (!confirmed) return;
        dirtyChanges.clear();
        renderTable();
        refreshSaveControls();
        saveActionBar?.classList.add('hidden');
    }

    saveChangesBtn?.addEventListener('click', saveAllChanges);
    discardChangesBtn?.addEventListener('click', discardAllChanges);

    window.addEventListener('beforeunload', (e) => {
        if (dirtyChanges.size > 0 && !isSaving) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    document.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (!link) return;
        if (dirtyChanges.size > 0 && !isSaving) {
            const leave = confirm('You have unsaved changes. Leave anyway?');
            if (!leave) {
                e.preventDefault();
            }
        }
    });

    /* ===== DT Modal Logic ===== */
    const dtModal = document.getElementById('dtModal');
    const dtModalBody = document.getElementById('dtModalBody');

    function openDtModal() {
        const student = allStudentsData.find(s => s.id === currentDtContext.studentId);
        if (!student) return;
        
        const entries = getSubjectEntries(student);
        const currentSubject = entries.find(e => e.key === currentDtContext.subjectKey)?.value;
        const subjectName = currentSubject?.name || 'Unknown Subject';
        const studentName = getDisplayName(student);

        const modalTitle = document.getElementById('dtModalTitle');
        if (modalTitle) modalTitle.textContent = t('nsl.selectDTFor', { subject: subjectName });
        const modalHint = document.getElementById('dtModalHint');
        if (modalHint) modalHint.textContent = t('nsl.studentHint', { name: studentName });

        dtModalBody.innerHTML = '';
        const dts = student.diagnosticTests || [];
        if (dts.length === 0) {
            dtModalBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:1rem;">${t('nsl.noDTRecorded')}</td></tr>`;
        } else {
            dts.forEach((dt) => {
                const tr = document.createElement('tr');
                const isSelected = currentSubject?.selectedDT?.date === dt.date &&
                                   currentSubject?.selectedDT?.test === dt.test;
                if (isSelected) tr.classList.add('selected');
                tr.innerHTML = `
                    <td>${dt.date || '-'}</td>
                    <td>${dt.test || '-'}</td>
                    <td>${dt.subject || '-'}</td>
                    <td>${dt.time || '-'}</td>
                    <td>${dt.score || '-'}</td>
                    <td>${dt.suggestedStart || dt.actualStart || '-'}</td>
                `;
                tr.addEventListener('click', () => selectDt(dt));
                dtModalBody.appendChild(tr);
            });
        }
        dtModal.classList.remove('hidden');
    }

    async function selectDt(dt) {
        if (!currentDtContext) return;
        const { studentId, subjectKey } = currentDtContext;
        if (!centerId || !studentId || !subjectKey) return;

        try {
            const studentRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const selectedDT = {
                date: dt.date,
                test: dt.test,
                time: dt.time,
                score: dt.score,
                startLvl: dt.suggestedStart || dt.actualStart
            };

            await update(studentRef, {
                [`subjects/${subjectKey}/selectedDT`]: selectedDT,
                updatedAt: new Date().toISOString()
            });

            const localStudent = allStudentsData.find(s => s.id === studentId);
            if (localStudent) {
                const entry = getSubjectEntries(localStudent).find(e => e.key === subjectKey);
                if (entry) {
                    entry.value.selectedDT = selectedDT;
                    entry.value.updatedAt = new Date().toISOString();
                    if (Array.isArray(localStudent.subjects)) {
                        const idx = Number(subjectKey);
                        if (Number.isInteger(idx)) {
                            localStudent.subjects[idx] = entry.value;
                        }
                    } else if (localStudent.subjects && typeof localStudent.subjects === 'object') {
                        localStudent.subjects[subjectKey] = entry.value;
                    } else {
                        localStudent.subjects = { [subjectKey]: entry.value };
                    }
                }
            }
            closeDtModal();
            renderTable();
        } catch (err) {
            console.error("DT Save error:", err);
            alert(t('nsl.failedSaveDT', { message: err.message }));
        }
    }

    function closeDtModal() {
        dtModal.classList.add('hidden');
        currentDtContext = null;
    }

    document.getElementById('closeDtModal')?.addEventListener('click', closeDtModal);
    document.getElementById('cancelDtBtn')?.addEventListener('click', closeDtModal);
    dtModal?.addEventListener('click', (e) => { if (e.target === dtModal) closeDtModal(); });

    /* ===== Keep views in sync when crossing the mobile breakpoint ===== */
    const mobileQuery = window.matchMedia('(max-width: 900px)');
    let wasMobile = mobileQuery.matches;
    const onBreakpoint = () => {
        const isMobile = mobileQuery.matches;
        if (isMobile !== wasMobile) {
            wasMobile = isMobile;
            renderTable(); 
        }
    };
    if (mobileQuery.addEventListener) mobileQuery.addEventListener('change', onBreakpoint);
    else window.addEventListener('resize', onBreakpoint); 

    // Initialize View
    viewMode = 'year';
    singleMonthControls.classList.add('hidden');
    rangeControls.classList.remove('hidden');
    updateRangeEndLabel();
    generateMonthTabs();
    loadData();
}