import { auth, db, logout } from './auth.js';
import {
    ref,
    get,
    push,
    remove,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'attendance';

// ===============================
// Utility Functions
// ===============================
function hidePageLoader() {
    document.getElementById('page-loader')?.classList.add('hidden');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (match) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[match]));
}

function normalizeText(value) {
    return String(value ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function toSearchPart(value) {
    if (value === null || value === undefined) return '';

    if (typeof value === 'string') {
        return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    if (typeof value === 'object') {
        const possible = value.full || value.name || value.text || value.pinyin || '';
        return typeof possible === 'string' ? possible.trim() : '';
    }

    return '';
}

// Optional logout button
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    try {
        await logout();
    } catch (err) {
        console.error('Logout error:', err);
    }
    window.location.href = 'index.html';
});

// ===============================
// Permission Check
// ===============================
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
            hidePageLoader();

            initializeAttendance();
        } else {
            document.getElementById('accessDenied')?.classList.remove('hidden');
            document.getElementById('mainContent')?.classList.add('hidden');
            hidePageLoader();

            document.getElementById('backToDashboardBtn')?.addEventListener('click', () => {
                window.location.href = 'dashboard.html';
            });
        }
    } catch (err) {
        console.error('Permission check error:', err);
        hidePageLoader();
        window.location.href = 'index.html';
    }
});

// ===============================
// Main Attendance Logic
// ===============================
function initializeAttendance() {
    const centerId = sessionStorage.getItem('selectedCenter');

    if (!centerId) {
        console.error('❌ No center selected');
        hidePageLoader();
        window.location.href = 'dashboard.html';
        return;
    }

    const attendanceRef = ref(db, `centers/${centerId}/attendance`);
    const studentsRef = ref(db, `centers/${centerId}/students`);

    let allAttendanceData = [];
    let filteredAttendanceData = [];

    let allStudents = [];
    let studentsLoaded = false;
    let studentsById = new Map();
    let studentsByNumber = new Map();

    let attendanceLoaded = false;

    let html5QrCode = null;
    let scannerActive = false;
    let scannedStudentData = null;

    // Elements
    const dateInput = document.getElementById('attendanceDate');
    const subjectSelect = document.getElementById('attendanceSubject');
    const searchInput = document.getElementById('searchStudent');
    const clearSearchBtn = document.getElementById('clearSearchStudent');

    const manualInput = document.getElementById('manualAttendanceInput');
    const manualResults = document.getElementById('manualSearchResults');
    const clearManualBtn = document.getElementById('clearManualSearch');

    const scanModal = document.getElementById('scanModal');
    const confirmModal = document.getElementById('confirmModal');

    // Set default date
    function todayISO() {
        return new Date().toISOString().split('T')[0];
    }

    if (dateInput) dateInput.value = todayISO();

    // ===============================
    // Student Cache / Indexes
    // ===============================
    function rebuildStudentIndexes() {
        studentsById = new Map();
        studentsByNumber = new Map();

        allStudents.forEach((student) => {
            if (student.id) {
                studentsById.set(String(student.id), student);
            }

            if (
                student.studentNumber !== undefined &&
                student.studentNumber !== null &&
                student.studentNumber !== ''
            ) {
                studentsByNumber.set(String(student.studentNumber), student);
            }
        });
    }

    async function loadStudents(force = false) {
        if (studentsLoaded && !force) {
            return allStudents;
        }

        const snapshot = await get(studentsRef);
        allStudents = [];

        if (snapshot.exists()) {
            snapshot.forEach((child) => {
                allStudents.push({
                    ...child.val(),
                    id: child.key
                });
            });
        }

        studentsLoaded = true;
        rebuildStudentIndexes();

        return allStudents;
    }

    // Preload students for faster search
    loadStudents().catch((err) => {
        console.error('❌ Failed to preload students:', err);
    });

    // ===============================
    // Pinyin / Search Helpers
    // ===============================
    function getStudentPinyin(student = {}) {
        const candidates = [
            student.pinyin,
            student.pinyinName,
            student.namePinyin,
            student.pinYin,
            student.pinYinName,
            student.py,
            student.pinyin_name,
            student.romanized,
            student.romanization,
            student.romanName
        ];

        for (const candidate of candidates) {
            const text = toSearchPart(candidate);
            if (text) return text;
        }

        return '';
    }

    function getStudentSearchText(student = {}) {
        const parts = [
            toSearchPart(student.nameCn),
            toSearchPart(student.name),
            toSearchPart(student.chineseName),
            toSearchPart(student.fullName),
            toSearchPart(student.nameEn),
            toSearchPart(student.englishName),
            toSearchPart(student.engName),
            getStudentPinyin(student),
            toSearchPart(student.nickname),
            toSearchPart(student.studentNumber),
            toSearchPart(student.school),
            toSearchPart(student.grade)
        ].filter(Boolean);

        return normalizeText(parts.join(' '));
    }

    function getLinkedStudent(record = {}) {
        if (record.studentId && studentsById.has(String(record.studentId))) {
            return studentsById.get(String(record.studentId));
        }

        if (
            record.studentNumber !== undefined &&
            record.studentNumber !== null &&
            record.studentNumber !== '' &&
            studentsByNumber.has(String(record.studentNumber))
        ) {
            return studentsByNumber.get(String(record.studentNumber));
        }

        return null;
    }

    function getRecordSearchText(record = {}) {
        const linkedStudent = getLinkedStudent(record);

        const parts = [
            toSearchPart(record.nameCn),
            toSearchPart(record.nickname),
            toSearchPart(record.studentNumber),
            toSearchPart(record.grade),
            toSearchPart(record.school),
            toSearchPart(record.subject),
            toSearchPart(record.pinyin),
            linkedStudent ? getStudentSearchText(linkedStudent) : ''
        ].filter(Boolean);

        return normalizeText(parts.join(' '));
    }

    // ===============================
    // Modal Helpers
    // ===============================
    function hideScanModal() {
        if (scanModal) {
            scanModal.classList.add('hidden');
            scanModal.style.display = 'none';
        }
    }

    function hideConfirmModal() {
        if (confirmModal) {
            confirmModal.classList.add('hidden');
            confirmModal.style.display = 'none';
        }
    }

    function openConfirmModal() {
        if (confirmModal) {
            confirmModal.classList.remove('hidden');
            confirmModal.style.display = 'flex';
        }
    }

    function hideManualResults() {
        manualResults?.classList.add('hidden');
    }

    function showManualResults() {
        manualResults?.classList.remove('hidden');
    }

    function showConfirmError(message) {
        openConfirmModal();

        const infoDiv = document.getElementById('studentInfo');
        const subDiv = document.getElementById('subjectCheckboxes');
        const btn = document.getElementById('confirmAttendanceBtn');

        if (infoDiv) {
            infoDiv.innerHTML = `<span style="color:#dc3545">❌ ${escapeHtml(message)}</span>`;
        }

        if (subDiv) {
            subDiv.innerHTML = '';
        }

        if (btn) {
            btn.disabled = true;
            btn.style.display = 'none';
        }
    }

    // ===============================
    // Scanner Lifecycle
    // ===============================
    async function cleanupScanner() {
        if (html5QrCode) {
            try {
                await html5QrCode.stop();
            } catch (e) {
                console.warn('⚠️ Scanner stop warning:', e);
            }

            html5QrCode = null;
        }

        const readerDiv = document.getElementById('qr-reader');
        if (readerDiv) readerDiv.innerHTML = '';

        scannerActive = false;
    }

    async function startScanner() {
        const modal = document.getElementById('scanModal');
        const status = document.getElementById('qr-status') || document.getElementById('scanStatus');
        const readerDiv = document.getElementById('qr-reader');

        if (!modal || !status || !readerDiv) {
            console.error('❌ Missing Scanner UI elements');
            return;
        }

        if (typeof Html5Qrcode === 'undefined') {
            status.innerHTML = `<span style="color:#dc3545">❌ html5-qrcode library not loaded</span>`;
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
            return;
        }

        await cleanupScanner();

        modal.classList.remove('hidden');
        modal.style.display = 'flex';
        status.textContent = '📷 Starting camera...';

        try {
            html5QrCode = new Html5Qrcode("qr-reader");

            await html5QrCode.start(
                { facingMode: "environment" },
                {
                    fps: 10,
                    qrbox: { width: 250, height: 250 },
                    aspectRatio: 1.0
                },
                async (decodedText) => {
                    const cleanValue = decodedText.trim();

                    await cleanupScanner();
                    hideScanModal();

                    try {
                        const student = await findStudentForScan(cleanValue);
                        await handleStudentSelected(student);
                    } catch (err) {
                        console.error('❌ Scan processing failed:', err);
                        showConfirmError(err.message);
                    }
                },
                () => {}
            );

            status.textContent = '✅ Camera ready. Point at QR...';
            scannerActive = true;
        } catch (err) {
            console.error('❌ Scanner init failed:', err);
            status.innerHTML = `<span style="color:#dc3545">❌ Camera: ${escapeHtml(err.message)}</span>`;
        }
    }

    async function stopScanner() {
        await cleanupScanner();
        hideScanModal();
    }

    // ===============================
    // Student Lookup
    // ===============================
    function findStudentByScan(scannedValue) {
        const value = String(scannedValue || '').trim();

        if (!value) return null;

        if (studentsById.has(value)) {
            return studentsById.get(value);
        }

        if (studentsByNumber.has(value)) {
            return studentsByNumber.get(value);
        }

        return allStudents.find((student) => {
            return String(student.qrCode || '') === value;
        }) || null;
    }

    async function findStudentForScan(scannedValue) {
        let student = findStudentByScan(scannedValue);

        if (!student) {
            await loadStudents(true);
            student = findStudentByScan(scannedValue);
        }

        if (!student) {
            throw new Error('Student not found in database');
        }

        return student;
    }

    // ===============================
    // Duplicate Attendance Check
    // ===============================
    async function ensureAttendanceLoaded() {
        if (!attendanceLoaded) {
            await loadAttendanceData();
        }
    }

    async function getExistingAttendanceTodayForStudent(student = {}) {
        await ensureAttendanceLoaded();

        const today = todayISO();

        const studentId = String(student.id || '');
        const studentNumber = String(student.studentNumber || '');
        const studentName = normalizeText(student.nameCn || student.name || '');

        return allAttendanceData.filter((record) => {
            if (record.date !== today) return false;

            const recordStudentId = String(record.studentId || '');
            const recordStudentNumber = String(record.studentNumber || '');
            const recordName = normalizeText(record.nameCn || '');

            if (studentId && recordStudentId && recordStudentId === studentId) {
                return true;
            }

            if (studentNumber && recordStudentNumber && recordStudentNumber === studentNumber) {
                return true;
            }

            if (studentName && recordName && recordName === studentName) {
                return true;
            }

            return false;
        });
    }

    function getExistingSubjectSet(existingRecords = []) {
        return new Set(
            existingRecords
                .map((record) => normalizeText(record.subject))
                .filter(Boolean)
        );
    }

    function formatExistingRecordLabel(record = {}) {
        const subject = record.subject || 'Subject';
        const time = formatTime(record.checkInTime);
        const status = record.status || '-';

        return `${subject} • ${time} • ${status}`;
    }

    function showWarningModal({
        title = '⚠️ Warning',
        message = '',
        items = [],
        proceedText = 'Proceed Anyway'
    }) {
        return new Promise((resolve) => {
            const modal = document.getElementById('duplicateWarningModal');
            const titleEl = document.getElementById('duplicateWarningTitle');
            const textEl = document.getElementById('duplicateWarningText');
            const listEl = document.getElementById('duplicateWarningList');
            const proceedBtn = document.getElementById('proceedDuplicateBtn');
            const cancelBtn = document.getElementById('cancelDuplicateBtn');
            const closeBtn = document.getElementById('closeDuplicateWarningModal');

            // Fallback if modal HTML was not added
            if (!modal || !proceedBtn || !cancelBtn) {
                const fullMessage = items.length
                    ? `${message}\n\n${items.join('\n')}`
                    : message;

                resolve(window.confirm(fullMessage));
                return;
            }

            if (titleEl) titleEl.textContent = title;
            if (textEl) textEl.textContent = message;

            if (listEl) {
                listEl.innerHTML = '';

                if (items.length) {
                    const ul = document.createElement('ul');
                    ul.className = 'duplicate-warning-list';

                    items.forEach((item) => {
                        const li = document.createElement('li');
                        li.textContent = item;
                        ul.appendChild(li);
                    });

                    listEl.appendChild(ul);
                }
            }

            proceedBtn.textContent = proceedText;

            const cleanup = () => {
                modal.classList.add('hidden');
                modal.style.display = 'none';

                proceedBtn.onclick = null;
                cancelBtn.onclick = null;

                if (closeBtn) closeBtn.onclick = null;

                modal.onclick = null;

                document.removeEventListener('keydown', keyHandler, true);
            };

            const keyHandler = (event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    event.preventDefault();

                    cleanup();
                    resolve(false);
                }
            };

            proceedBtn.onclick = () => {
                cleanup();
                resolve(true);
            };

            cancelBtn.onclick = () => {
                cleanup();
                resolve(false);
            };

            if (closeBtn) {
                closeBtn.onclick = () => {
                    cleanup();
                    resolve(false);
                };
            }

            modal.onclick = (event) => {
                if (event.target === modal) {
                    cleanup();
                    resolve(false);
                }
            };

            document.addEventListener('keydown', keyHandler, true);

            modal.classList.remove('hidden');
            modal.style.display = 'flex';
        });
    }

    async function confirmStudentAlreadyCame(student = {}, existingRecords = []) {
        const studentDisplayName =
            student.nameCn ||
            student.name ||
            getStudentPinyin(student) ||
            student.nickname ||
            'This student';

        const items = existingRecords.map((record) => formatExistingRecordLabel(record));

        return showWarningModal({
            title: '⚠️ Student Already Came Today',
            message: `${studentDisplayName} already has attendance recorded today. Do you want to continue?`,
            items,
            proceedText: 'Proceed Anyway'
        });
    }

    async function confirmDuplicateSubjectsWarning(subjectNames = []) {
        return showWarningModal({
            title: '⚠️ Duplicate Subject Attendance',
            message: 'The following subject(s) have already been recorded today for this student:',
            items: subjectNames,
            proceedText: 'Proceed Anyway'
        });
    }

    // ===============================
    // Student Selection Handler
    // ===============================
    async function handleStudentSelected(student) {
        try {
            const existingRecords = await getExistingAttendanceTodayForStudent(student);

            if (existingRecords.length > 0) {
                const proceed = await confirmStudentAlreadyCame(student, existingRecords);

                if (!proceed) {
                    return false;
                }
            }

            scannedStudentData = student;

            openConfirmModal();

            const infoDiv = document.getElementById('studentInfo');
            const subDiv = document.getElementById('subjectCheckboxes');
            const btn = document.getElementById('confirmAttendanceBtn');

            if (infoDiv) infoDiv.textContent = '🔍 Loading student...';
            if (subDiv) subDiv.innerHTML = '';
            if (btn) {
                btn.style.display = 'none';
                btn.disabled = true;
            }

            renderStudentConfirmation(infoDiv, subDiv, btn, existingRecords);

            return true;
        } catch (err) {
            console.error('❌ Student selection failed:', err);
            showConfirmError(err.message);
            return false;
        }
    }

    // ===============================
    // Confirm Attendance UI
    // ===============================
    function renderStudentConfirmation(infoDiv, subDiv, confirmBtn, existingRecords = []) {
        const student = scannedStudentData;

        if (!student) {
            throw new Error('No student selected.');
        }

        const activeSubjects = (student.subjects || []).filter((subject) => {
            return subject && subject.status === 'current' && subject.name;
        });

        if (activeSubjects.length === 0) {
            throw new Error('No active subjects for this student.');
        }

        const now = new Date();
        const dayNames = [
            'Sunday',
            'Monday',
            'Tuesday',
            'Wednesday',
            'Thursday',
            'Friday',
            'Saturday'
        ];

        const todayDay = dayNames[now.getDay()];
        const pinyin = getStudentPinyin(student);

        const existingSubjects = getExistingSubjectSet(existingRecords);

        const existingSubjectsText = existingRecords
            .map((record) => record.subject)
            .filter(Boolean)
            .join(', ');

        const existingWarningHtml = existingRecords.length > 0
            ? `
                <div style="margin-top:0.5rem; color:#b45309; font-size:0.8rem; font-weight:600;">
                    ⚠️ Already recorded today: ${escapeHtml(existingSubjectsText)}
                </div>
            `
            : '';

        if (infoDiv) {
            infoDiv.innerHTML = `
                <div style="background:#f8fafc; padding:0.75rem; border-radius:8px; border:1px solid #e2e8f0;">
                    <h3 style="margin:0 0 0.3rem; font-size:1.1rem; font-weight:700;">
                        ${escapeHtml(student.nameCn || student.name || pinyin || 'N/A')}
                    </h3>

                    <div style="display:flex; flex-wrap:wrap; gap:0.25rem 0.75rem; font-size:0.85rem; color:#475569;">
                        <span><strong>Pinyin:</strong> ${escapeHtml(pinyin || '-')}</span>
                        <span><strong>Nickname:</strong> ${escapeHtml(student.nickname || '-')}</span>
                        <span><strong>Grade:</strong> ${escapeHtml(student.grade || '-')}</span>
                        <span><strong>School:</strong> ${escapeHtml(student.school || '-')}</span>
                    </div>

                    ${existingWarningHtml}
                </div>
            `;
        }

        let html = `
            <div style="border:1px solid #e2e8f0; border-radius:8px; max-height:260px; overflow-y:auto; background:#fff;">
        `;

        activeSubjects.forEach((subject, index) => {
            try {
                const slots = Array.isArray(subject.timeslots) ? subject.timeslots : [];

                const fullSchedule = slots.length > 0
                    ? slots.map((slot) => {
                        return `${slot.day?.substring(0, 3) || '???'} ${slot.time || '--:--'}`;
                    }).join(', ')
                    : 'No schedule set';

                const todaySlot = slots.find((slot) => {
                    return slot.day?.toLowerCase() === todayDay.toLowerCase();
                });

                const todayTime = todaySlot?.time || 'N/A';
                const status = calculateStatus(todayTime, now);
                const color = getStatusColor(status);

                const isLast = index === activeSubjects.length - 1;

                const subjectKey = normalizeText(subject.name);
                const alreadyRecorded = existingSubjects.has(subjectKey);

                const alreadyBadge = alreadyRecorded
                    ? `<span style="color:#b45309; font-size:0.7rem; font-weight:700; margin-left:0.35rem;">Already recorded today</span>`
                    : '';

                html += `
                    <label style="display:flex; align-items:center; gap:0.4rem; padding:0.35rem 0.5rem; border-bottom:${isLast ? 'none' : '1px solid #f1f5f9'}; cursor:pointer;">
                        <input
                            type="checkbox"
                            class="att-subject-check"
                            value="${escapeHtml(subject.name.trim())}"
                            data-status="${escapeHtml(status)}"
                            data-scheduled="${escapeHtml(fullSchedule)}"
                            data-already-recorded="${alreadyRecorded ? 'true' : 'false'}"
                            ${alreadyRecorded ? '' : 'checked'}
                            style="transform:scale(1.1); accent-color:#4682B4; margin:0 !important; padding:0 !important; flex-shrink:0; width:16px; height:16px;"
                        >

                        <div style="flex:1; min-width:0; line-height:1.3;">
                            <div style="font-weight:600; color:#1e293b; font-size:0.88rem;">
                                ${escapeHtml(subject.name)}
                                <span style="color:#64748b; font-weight:400;">
                                    (${escapeHtml(subject.currentLevel || subject.startLevel || '?')})
                                </span>
                                ${alreadyBadge}
                            </div>

                            <div style="font-size:0.75rem; color:#64748b; margin-top:1px;">
                                🕒 ${escapeHtml(fullSchedule)} <br>
                                Today: ${escapeHtml(todayDay)} ${escapeHtml(todayTime)} |
                                Status: <span style="color:${color}; font-weight:600;">${escapeHtml(status)}</span>
                            </div>
                        </div>
                    </label>
                `;
            } catch (err) {
                console.error(`❌ Failed to render subject "${subject?.name}":`, err);
            }
        });

        html += '</div>';

        if (subDiv) {
            subDiv.innerHTML = html;
        }

        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.style.display = 'inline-flex';
        }
    }

    // ===============================
    // Status Logic
    // ===============================
    function calculateStatus(timeStr, now) {
        if (!timeStr || timeStr === 'N/A' || timeStr === 'No schedule set') {
            return 'Not Today';
        }

        const parts = timeStr.split(':');

        if (parts.length < 2) {
            return 'Not Today';
        }

        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);

        if (isNaN(h) || isNaN(m)) {
            return 'Not Today';
        }

        const scheduled = new Date(now);
        scheduled.setHours(h, m, 0, 0);

        const diff = (now - scheduled) / 60000;

        if (diff < -15) return 'Early';
        if (diff > 15) return 'Late';

        return 'On Time';
    }

    function getStatusColor(status) {
        return {
            'On Time': '#10b981',
            'Early': '#f59e0b',
            'Late': '#ef4444',
            'Not Today': '#6b7280'
        }[status] || '#666';
    }

    // ===============================
    // Record Attendance
    // ===============================
    async function recordAttendance() {
        const checks = document.querySelectorAll('.att-subject-check:checked');

        if (!scannedStudentData) {
            alert('⚠️ No student selected.');
            return;
        }

        if (checks.length === 0) {
            alert('⚠️ Select at least one subject.');
            return;
        }

        // Second warning if user selected subjects that were already recorded today
        const alreadyRecordedChecks = Array.from(checks).filter((checkbox) => {
            return checkbox.dataset.alreadyRecorded === 'true';
        });

        if (alreadyRecordedChecks.length > 0) {
            const duplicateSubjects = alreadyRecordedChecks.map((checkbox) => checkbox.value);
            const proceed = await confirmDuplicateSubjectsWarning(duplicateSubjects);

            if (!proceed) {
                return;
            }
        }

        const btn = document.getElementById('confirmAttendanceBtn');
        const originalText = btn?.textContent || 'Confirm';

        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ Saving...';
        }

        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const checkInTime = now.toISOString();

        try {
            const saves = Array.from(checks).map((checkbox) => {
                return push(attendanceRef, {
                    studentId: String(scannedStudentData.id || ''),
                    studentNumber: String(scannedStudentData.studentNumber || ''),
                    nameCn: String(scannedStudentData.nameCn || scannedStudentData.name || '-'),
                    nickname: String(scannedStudentData.nickname || '-'),
                    grade: String(scannedStudentData.grade || '-'),
                    school: String(scannedStudentData.school || '-'),
                    pinyin: String(getStudentPinyin(scannedStudentData) || ''),
                    nameEn: String(scannedStudentData.nameEn || scannedStudentData.englishName || ''),
                    subject: String(checkbox.value.trim()),
                    scheduledTime: String(checkbox.dataset.scheduled || 'No schedule set'),
                    checkInTime: String(checkInTime),
                    date: String(dateStr),
                    status: String(checkbox.dataset.status || ''),
                    timestamp: serverTimestamp()
                });
            });

            await Promise.all(saves);

            hideConfirmModal();
            hideScanModal();

            scannedStudentData = null;

            await loadAttendanceData();
        } catch (err) {
            console.error('❌ Save failed:', err);
            alert('❌ Failed: ' + err.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }
    }

    // ===============================
    // Load Attendance Data
    // ===============================
    async function loadAttendanceData() {
        try {
            const snapshot = await get(attendanceRef);

            allAttendanceData = [];

            if (snapshot.exists()) {
                snapshot.forEach((child) => {
                    allAttendanceData.push({
                        ...child.val(),
                        id: child.key
                    });
                });
            }

            attendanceLoaded = true;

            populateSubjectFilter();
            await filterAndRender();
        } catch (err) {
            console.error('❌ Load error:', err);
        }
    }

    function populateSubjectFilter() {
        if (!subjectSelect) return;

        const currentValue = subjectSelect.value || 'All';

        subjectSelect.innerHTML = '';

        const subjects = new Set([
            'All',
            'Math',
            'Chinese (Trad)',
            'Chinese (Simp)',
            'English ERP',
            'English EFL'
        ]);

        allAttendanceData.forEach((record) => {
            if (record.subject) {
                subjects.add(record.subject.trim());
            }
        });

        Array.from(subjects)
            .sort()
            .forEach((subject) => {
                const option = document.createElement('option');
                option.value = subject;
                option.textContent = subject;

                if (subject === currentValue) {
                    option.selected = true;
                }

                subjectSelect.appendChild(option);
            });
    }

    async function filterAndRender() {
        const selectedDate = dateInput?.value || todayISO();
        const selectedSubject = (subjectSelect?.value || 'All').trim();
        const query = normalizeText(searchInput?.value || '');

        // If searching by text, make sure student cache is available for Pinyin lookup
        if (query && !studentsLoaded) {
            await loadStudents().catch(() => {
                // Continue filtering using attendance records only if student load fails
            });
        }

        filteredAttendanceData = allAttendanceData.filter((record) => {
            if (record.date !== selectedDate) return false;

            const recordSubject = (record.subject || '').trim();

            if (selectedSubject !== 'All' && recordSubject !== selectedSubject) {
                return false;
            }

            if (query) {
                return getRecordSearchText(record).includes(query);
            }

            return true;
        });

        renderTable();
    }

    function renderTable() {
        const tbody = document.getElementById('attendanceBody');

        if (!tbody) return;

        tbody.innerHTML = '';

        if (!filteredAttendanceData.length) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align:center; padding:1rem; color:#666;">
                        No records found for this date.
                    </td>
                </tr>
            `;
            return;
        }

        filteredAttendanceData.sort((a, b) => {
            return String(b.checkInTime || '').localeCompare(String(a.checkInTime || ''));
        });

        const colors = {
            'On Time': '#dcfce7,#166534',
            'Early': '#fef3c7,#92400e',
            'Late': '#fee2e2,#991b1b',
            'Not Today': '#f3f4f6,#374151'
        };

        filteredAttendanceData.forEach((record) => {
            const [bg, txt] = (colors[record.status] || ['#eee', '#333']).split(',');

            const scheduledDisplay = record.scheduledTime && record.scheduledTime !== 'N/A'
                ? escapeHtml(record.scheduledTime)
                : '<span style="color:#999;font-style:italic">No schedule set</span>';

            const linkedStudent = getLinkedStudent(record);
            const pinyin = record.pinyin || getStudentPinyin(linkedStudent || {}) || '';

            const tr = document.createElement('tr');

            tr.innerHTML = `
                <td>${escapeHtml(record.subject || '-')}</td>
                <td title="${escapeHtml(pinyin)}">${escapeHtml(record.nameCn || '-')}</td>
                <td>${escapeHtml(record.nickname || '-')}</td>
                <td>${escapeHtml(record.grade || '-')}</td>
                <td>${escapeHtml(record.school || '-')}</td>
                <td style="font-weight:600; font-size:0.85rem;">${scheduledDisplay}</td>
                <td>${formatTime(record.checkInTime)}</td>
                <td>
                    <span style="background:${bg};color:${txt};padding:0.25rem 0.5rem;border-radius:4px;font-weight:600;font-size:0.85rem;">
                        ${escapeHtml(record.status || '-')}
                    </span>
                </td>
                <td>
                    <button
                        type="button"
                        class="delete-att-btn"
                        data-id="${record.id}"
                        style="cursor:pointer; background:none; border:none; font-size:1.2rem;"
                    >
                        🗑️
                    </button>
                </td>
            `;

            tbody.appendChild(tr);
        });
    }

    function formatTime(isoString) {
        try {
            return new Date(isoString).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch {
            return '-';
        }
    }

    // ===============================
    // Manual Student Search
    // ===============================
    function matchesManualSearch(student, normalizedQuery) {
        return getStudentSearchText(student).includes(normalizedQuery);
    }

    async function handleManualSearchInput() {
        const query = normalizeText(manualInput?.value || '');

        if (!query) {
            hideManualResults();
            return;
        }

        try {
            const students = await loadStudents();

            const matches = students
                .filter((student) => matchesManualSearch(student, query))
                .slice(0, 20);

            renderManualResults(matches);
        } catch (err) {
            console.error('❌ Manual search failed:', err);
            renderManualResults([]);
        }
    }

    function renderManualResults(matches) {
        if (!manualResults) return;

        manualResults.innerHTML = '';

        if (!matches.length) {
            const empty = document.createElement('div');
            empty.className = 'manual-result-empty';
            empty.textContent = 'No matching students found.';
            manualResults.appendChild(empty);
            showManualResults();
            return;
        }

        matches.forEach((student) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'manual-result-item';

            const pinyin = getStudentPinyin(student);

            const displayName =
                student.nameCn ||
                student.name ||
                pinyin ||
                student.nickname ||
                'Unknown Student';

            const name = document.createElement('span');
            name.className = 'manual-result-name';
            name.textContent = displayName;

            const metaParts = [];

            if (pinyin) metaParts.push(pinyin);
            if (student.nickname) metaParts.push(`Nickname: ${student.nickname}`);
            if (student.studentNumber) metaParts.push(`No: ${student.studentNumber}`);
            if (student.grade) metaParts.push(`Grade: ${student.grade}`);
            if (student.school) metaParts.push(student.school);

            const meta = document.createElement('span');
            meta.className = 'manual-result-meta';
            meta.textContent = metaParts.join(' • ');

            item.appendChild(name);
            item.appendChild(meta);

            item.addEventListener('click', async () => {
                await selectManualStudent(student);
            });

            manualResults.appendChild(item);
        });

        showManualResults();
    }

    async function selectManualStudent(student) {
        hideManualResults();

        const success = await handleStudentSelected(student);

        if (success && manualInput) {
            manualInput.value = '';
        }
    }

    // ===============================
    // Event Listeners
    // ===============================

    // Initial load
    loadAttendanceData();

    // Filters
    dateInput?.addEventListener('change', () => filterAndRender());
    subjectSelect?.addEventListener('change', () => filterAndRender());
    searchInput?.addEventListener('input', () => filterAndRender());

    clearSearchBtn?.addEventListener('click', () => {
        if (searchInput) {
            searchInput.value = '';
            filterAndRender();
            searchInput.focus();
        }
    });

    // QR Scanner
    document.getElementById('scanQrBtn')?.addEventListener('click', startScanner);
    document.getElementById('closeScanModal')?.addEventListener('click', stopScanner);

    // Confirm Attendance
    document.getElementById('confirmAttendanceBtn')?.addEventListener('click', recordAttendance);

    document.getElementById('cancelConfirmBtn')?.addEventListener('click', () => {
        hideConfirmModal();
        hideScanModal();
        scannedStudentData = null;
    });

    document.getElementById('closeConfirmModal')?.addEventListener('click', () => {
        hideConfirmModal();
        hideScanModal();
        scannedStudentData = null;
    });

    // Manual attendance search
    manualInput?.addEventListener('input', handleManualSearchInput);
    manualInput?.addEventListener('focus', handleManualSearchInput);

    clearManualBtn?.addEventListener('click', () => {
        if (manualInput) {
            manualInput.value = '';
            hideManualResults();
            manualInput.focus();
        }
    });

    // Close manual dropdown when clicking outside
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.manual-search-wrapper')) {
            hideManualResults();
        }
    });

    // Delete attendance record
    document.addEventListener('click', async (event) => {
        const btn = event.target.closest('.delete-att-btn');

        if (!btn) return;

        const id = btn.dataset.id;

        if (!id) {
            console.warn('⚠️ Missing data-id');
            return;
        }

        if (!confirm('Delete this record?')) return;

        btn.disabled = true;
        btn.innerHTML = '';

        try {
            await remove(ref(db, `centers/${centerId}/attendance/${id}`));
            await loadAttendanceData();
        } catch (err) {
            alert('Delete failed: ' + err.message);
            btn.disabled = false;
            btn.innerHTML = '🗑️';
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            stopScanner();
            hideConfirmModal();
            hideManualResults();
        }
    });

    // Cleanup camera when leaving page
    window.addEventListener('beforeunload', async () => {
        await cleanupScanner();
    });
}