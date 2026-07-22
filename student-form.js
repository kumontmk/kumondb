import { auth, db, logout } from './auth.js';
import { ref, push, set, get, remove, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'editStudent';

// 🔐 PERMISSION CHECK
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    try {
        let userData = null;
        const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';

        // 1. Try to get data from the users node first
        const userSnap = await get(ref(db, `users/${user.uid}`));
        if (userSnap.exists()) {
            userData = userSnap.val();
        }

        // 2. Fallback: If not found or missing permissions, check the employees node by email
        if (!userData || !userData.permissions) {
            const empSnap = await get(ref(db, 'employees'));
            const empData = empSnap.val();
            if (empData) {
                const matchingEmp = Object.values(empData).find(e => e.email?.toLowerCase() === user.email?.toLowerCase());
                if (matchingEmp) {
                    userData = matchingEmp;
                }
            }
        }

        // 3. Evaluate Permissions
        // ⚠️ CRITICAL: 'editStudentDetails' is the specific permission for this form
        const dashPerms = userData?.permissions?.dashboardCards || {};
        const hasAccess = isAdmin || dashPerms['editStudentDetails'] === true;

        if (hasAccess) {
            document.getElementById('accessDenied')?.classList.add('hidden');
            document.getElementById('mainContent')?.classList.remove('hidden');
            document.getElementById('page-loader')?.classList.add('hidden');
            initApp();
        } else {
            document.getElementById('accessDenied')?.classList.remove('hidden');
            document.getElementById('mainContent')?.classList.add('hidden');
            document.getElementById('page-loader')?.classList.add('hidden');

            document.getElementById('backToStudentsBtn')?.addEventListener('click', () => {
                window.location.href = 'students.html'; 
            });
        }
    } catch (err) {
        console.error("Permission check error:", err);
        window.location.href = 'index.html';
    }
});

function initApp() {
    const SUBJECTS = ['Math', 'Chinese (Trad)', 'Chinese (Simp)', 'English ERP', 'English EFL'];
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const SUBJECT_COLORS = {
        'Math': 'subj-Math', 'Chinese (Trad)': 'subj-Chinese', 'Chinese (Simp)': 'subj-Chinese',
        'English ERP': 'subj-ERP', 'English EFL': 'subj-EFL'
    };

    document.getElementById('studentForm')?.setAttribute('novalidate', '');

    const GRADE_ORDER = ['K0', 'K1', 'K2', 'K3', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
    let currentStudentData = null;

    function getNextGrade(grade) {
        const idx = GRADE_ORDER.indexOf(String(grade));
        return (idx !== -1 && idx < GRADE_ORDER.length - 1) ? GRADE_ORDER[idx + 1] : grade;
    }

    function checkSeptemberGradeUpdate(studentData) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const isSeptOrLater = now.getMonth() >= 8;
        const academicYear = isSeptOrLater ? currentYear : currentYear - 1;

        if (isSeptOrLater && (!studentData.lastGradeUpdateYear || studentData.lastGradeUpdateYear < academicYear)) {
            const oldGrade = studentData.grade;
            studentData.grade = getNextGrade(oldGrade);
            studentData.lastGradeUpdateYear = academicYear;
            studentData.updatedAt = new Date().toISOString();
            return oldGrade !== studentData.grade;
        }
        return false;
    }

    // 🆕 Auto-execute pending drop/pause requests
    function processPendingRequests(studentData) {
        if (!studentData.subjects) return false;
        const subjects = Array.isArray(studentData.subjects) ? studentData.subjects : Object.values(studentData.subjects);
        const now = new Date();
        const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
        const currentYear = String(now.getFullYear());
        let changed = false;

        subjects.forEach(sub => {
            if (sub.pendingRequest && (sub.status === 'current' || sub.status === 'inquiry')) {
                if (sub.pendingRequest.cancelled) return;
                
                const pr = sub.pendingRequest;
                let triggerMonth = '', triggerYear = '';
                if (pr.type === 'drop') { triggerMonth = pr.dropMonth; triggerYear = pr.dropYear; } 
                else if (pr.type === 'pause') { triggerMonth = pr.pauseFromMonth; triggerYear = pr.pauseFromYear; }
                
             if (triggerYear && triggerMonth) {
                 if (triggerYear < currentYear || (triggerYear === currentYear && triggerMonth <= currentMonth)) {
                     sub.status = pr.type;
                     if (pr.type === 'drop') { sub.dropMonth = pr.dropMonth; sub.dropYear = pr.dropYear; sub.dropReason = pr.reason; } 
                     else { sub.pauseFromMonth = pr.pauseFromMonth; sub.pauseFromYear = pr.pauseFromYear; sub.pauseToMonth = pr.pauseToMonth; sub.pauseToYear = pr.pauseToYear; sub.pauseReason = pr.reason; }
                     
                     // 🆕 AUTO-CONFIRM: Mark as confirmed since the target month has arrived
                     if (!sub.dropBook) sub.dropBook = {};
                     sub.dropBook.confirmed = true;
                     sub.dropBook.confirmedAt = new Date().toISOString();

                     delete sub.pendingRequest;
                     changed = true;
                 }
             }
            }
        });
        return changed;
    }

    let subjectCount = 0;
    let html5QrCode = null;
    let scannerActive = false;
    let originalFormData = null;
    const centerId = sessionStorage.getItem('selectedCenter');
    const urlParams = new URLSearchParams(window.location.search);
    const studentId = urlParams.get('id');
    const isEdit = !!studentId;
    const formTitleEl = document.getElementById('formTitle');
    if (formTitleEl) formTitleEl.textContent = isEdit ? '✏️ Edit Student' : '➕ Add Student';

    // ==========================================
    // 🧭 NAVIGATION & AUTOCOMPLETE SEARCH LOGIC
    // ==========================================
    let allStudentsList = [];
    let filteredStudentsList = [];
    let currentListIndex = -1;
    const searchParam = urlParams.get('search') || '';
    const searchInput = document.getElementById('studentSearchInput');
    const searchDropdown = document.getElementById('searchDropdown');
    let activeDropdownIndex = -1;

    async function fetchStudentList() {
        try {
            const snap = await get(ref(db, `centers/${centerId}/students`));
            if (!snap.exists()) return [];
            const list = [];
            snap.forEach(child => {
                const val = child.val();
                list.push({
                    id: child.key,
                    namePinyin: val.namePinyin || '',
                    nameCn: val.nameCn || '',
                    grade: val.grade || '',
                    studentNumber: val.studentNumber || ''
                });
            });
            return list;
        } catch (err) {
            console.error("Error fetching student list:", err);
            return [];
        }
    }

    function sortStudentList(list) {
        return list.sort((a, b) => {
            const nameA = (a.namePinyin || a.nameCn || '').toLowerCase();
            const nameB = (b.namePinyin || b.nameCn || '').toLowerCase();
            if (nameA < nameB) return -1;
            if (nameA > nameB) return 1;
            
            const gradeA = GRADE_ORDER.indexOf(a.grade);
            const gradeB = GRADE_ORDER.indexOf(b.grade);
            const gA = gradeA === -1 ? 999 : gradeA;
            const gB = gradeB === -1 ? 999 : gradeB;
            if (gA < gB) return -1;
            if (gA > gB) return 1;
            
            const numA = a.studentNumber || '';
            const numB = b.studentNumber || '';
            if (numA < numB) return -1;
            if (numA > numB) return 1;
            
            return 0;
        });
    }

    function updateNavUI() {
        const prevBtn = document.getElementById('prevStudentBtn');
        const nextBtn = document.getElementById('nextStudentBtn');
        const indicator = document.getElementById('studentPositionIndicator');
        
        if (currentListIndex === -1) {
            if (prevBtn) prevBtn.disabled = true;
            if (nextBtn) nextBtn.disabled = true;
            if (indicator) indicator.textContent = 'Not in list';
            return;
        }
        
        if (prevBtn) prevBtn.disabled = currentListIndex === 0;
        if (nextBtn) nextBtn.disabled = currentListIndex >= filteredStudentsList.length - 1;
        if (indicator) indicator.textContent = `${currentListIndex + 1} / ${filteredStudentsList.length}`;
    }

    function navigateToStudent(direction) {
        let newIndex = currentListIndex + direction;
        if (newIndex < 0 || newIndex >= filteredStudentsList.length) return;
        
        const newStudentId = filteredStudentsList[newIndex].id;
        navigateToStudentById(newStudentId);
    }

    function navigateToStudentById(id) {
        hideSearchDropdown();
        if (id === studentId) return;
        const url = new URL(window.location);
        url.searchParams.set('id', id);
        window.location.href = url.toString(); 
    }

    function updateSearchDropdown(term) {
        if (!searchDropdown) return;
        
        if (!term) {
            hideSearchDropdown();
            filteredStudentsList = [...allStudentsList];
            currentListIndex = filteredStudentsList.findIndex(s => s.id === studentId);
            updateNavUI();
            return;
        }

        const lowerTerm = term.toLowerCase();
        const matches = allStudentsList.filter(s => 
            (s.namePinyin || '').toLowerCase().includes(lowerTerm) ||
            (s.nameCn || '').toLowerCase().includes(lowerTerm) ||
            (s.studentNumber || '').toLowerCase().includes(lowerTerm)
        );

        filteredStudentsList = matches;
        currentListIndex = filteredStudentsList.findIndex(s => s.id === studentId);
        updateNavUI();

        searchDropdown.innerHTML = '';
        activeDropdownIndex = -1;

        if (matches.length === 0) {
            searchDropdown.innerHTML = '<li class="no-results">No students found</li>';
        } else {
            matches.slice(0, 50).forEach(s => { 
                const li = document.createElement('li');
                li.setAttribute('data-id', s.id);
                
                const nameContainer = document.createElement('span');
                nameContainer.className = 'student-name-container';
                
                const cnSpan = document.createElement('span');
                cnSpan.className = 'student-name-cn';
                cnSpan.textContent = s.nameCn || 'N/A';
                
                const pySpan = document.createElement('span');
                pySpan.className = 'student-name-pinyin';
                pySpan.textContent = s.namePinyin || '';
                
                nameContainer.appendChild(cnSpan);
                nameContainer.appendChild(pySpan);
                
                const gradeSpan = document.createElement('span');
                gradeSpan.className = 'student-grade';
                gradeSpan.textContent = s.grade || '';
                
                li.appendChild(nameContainer);
                li.appendChild(gradeSpan);
                
                li.addEventListener('mousedown', (e) => {
                    e.preventDefault(); 
                    navigateToStudentById(s.id);
                });
                
                searchDropdown.appendChild(li);
            });
        }
        
        searchDropdown.classList.remove('hidden');
    }

    function updateActiveDropdownItem(items) {
        items.forEach((item, idx) => {
            if (idx === activeDropdownIndex) {
                item.classList.add('active');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('active');
            }
        });
    }

    function hideSearchDropdown() {
        if (searchDropdown) {
            searchDropdown.classList.add('hidden');
            activeDropdownIndex = -1;
        }
    }

    async function initNavigation() {
        const navBar = document.getElementById('student-nav-bar');
        
        if (!isEdit) {
            if (navBar) navBar.style.display = 'none';
            return;
        }
        
        allStudentsList = sortStudentList(await fetchStudentList());
        
        if (searchInput) {
            searchInput.value = searchParam; 
            
            searchInput.addEventListener('input', (e) => {
                const term = e.target.value;
                const url = new URL(window.location);
                if (term) {
                    url.searchParams.set('search', term);
                } else {
                    url.searchParams.delete('search');
                }
                window.history.replaceState({}, '', url); 
                updateSearchDropdown(term);
            });

            searchInput.addEventListener('focus', () => {
                if (searchInput.value) {
                    updateSearchDropdown(searchInput.value);
                }
            });

            searchInput.addEventListener('keydown', (e) => {
                if (!searchDropdown || searchDropdown.classList.contains('hidden')) {
                    if (e.key === 'ArrowLeft') navigateToStudent(-1);
                    if (e.key === 'ArrowRight') navigateToStudent(1);
                    return;
                }
                
                const items = searchDropdown.querySelectorAll('li[data-id]');
                if (items.length === 0) return;

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    activeDropdownIndex = (activeDropdownIndex + 1) % items.length;
                    updateActiveDropdownItem(items);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    activeDropdownIndex = (activeDropdownIndex - 1 + items.length) % items.length;
                    updateActiveDropdownItem(items);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (activeDropdownIndex >= 0 && items[activeDropdownIndex]) {
                        const selectedId = items[activeDropdownIndex].getAttribute('data-id');
                        navigateToStudentById(selectedId);
                    }
                } else if (e.key === 'Escape') {
                    hideSearchDropdown();
                    searchInput.blur();
                }
            });
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-input-wrapper')) {
                hideSearchDropdown();
            }
        });
        
        document.getElementById('prevStudentBtn')?.addEventListener('click', () => navigateToStudent(-1));
        document.getElementById('nextStudentBtn')?.addEventListener('click', () => navigateToStudent(1));
        
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
            if (e.key === 'ArrowLeft') navigateToStudent(-1);
            if (e.key === 'ArrowRight') navigateToStudent(1);
        });

        if (searchParam) {
            const lowerTerm = searchParam.toLowerCase();
            filteredStudentsList = allStudentsList.filter(s => 
                (s.namePinyin || '').toLowerCase().includes(lowerTerm) ||
                (s.nameCn || '').toLowerCase().includes(lowerTerm) ||
                (s.studentNumber || '').toLowerCase().includes(lowerTerm)
            );
            currentListIndex = filteredStudentsList.findIndex(s => s.id === studentId);
            updateNavUI();
        } else {
            filteredStudentsList = [...allStudentsList];
            currentListIndex = filteredStudentsList.findIndex(s => s.id === studentId);
            updateNavUI();
        }
    }

    initNavigation();

    function showError(msg) {
        const modal = document.getElementById('errorModal');
        if (modal) {
            const msgEl = document.getElementById('errorMessage');
            if (msgEl) msgEl.textContent = msg;
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
            modal.style.zIndex = '10000';
        } else { 
            alert(msg);
        }
    }

    function hideErrorModal() {
        const modal = document.getElementById('errorModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.style.display = 'none';
        }
    }

    document.getElementById('closeErrorBtn')?.addEventListener('click', hideErrorModal);
    document.getElementById('errorModal')?.addEventListener('click', (e) => { if (e.target.id === 'errorModal') hideErrorModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideErrorModal(); });

    function hideLoader() {
        const loader = document.getElementById('page-loader');
        if (loader) setTimeout(() => loader.classList.add('hidden'), 300);
    }
    function showLoader() {
        document.getElementById('page-loader')?.classList.remove('hidden');
    }

    function getWSDropdownOptions(currentValue = '') {
        let opts = '<option value="">Select WS</option>';
        const currentStr = String(currentValue);
        for (let i = 1; i <= 191; i += 10) {
            const val = i.toString();
            opts += `<option value="${val}" ${val === currentStr ? 'selected' : ''}>${val}</option>`;
        }
        return opts;
    }

    function initOtherInputs() {
        const fields = ['grade', 'school', 'nationality'];
        fields.forEach(fieldId => {
            const select = document.getElementById(fieldId);
            const otherInput = document.getElementById(fieldId + 'Other');
            if (select && otherInput) {
                if (select.value === 'Other') {
                    otherInput.classList.add('visible');
                    otherInput.required = true;
                    select.required = false;
                } else {
                    otherInput.classList.remove('visible');
                    otherInput.required = false;
                    select.required = true;
                }
                select.addEventListener('change', () => {
                    if (select.value === 'Other') {
                        otherInput.classList.add('visible');
                        otherInput.focus();
                        otherInput.required = true;
                        select.required = false;
                    } else {
                        otherInput.classList.remove('visible');
                        otherInput.required = false;
                        select.required = true;
                    }
                });
            }
        });
    }

    function updateAgeDisplay() {
        const bdayEl = document.getElementById('birthday');
        const ageEl = document.getElementById('ageDisplay');
        if (!ageEl) return;
        const bday = bdayEl?.value;
        if (!bday) { ageEl.value = ''; return; }
        const today = new Date();
        const birth = new Date(bday);
        let age = today.getFullYear() - birth.getFullYear();
        const m = today.getMonth() - birth.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
        ageEl.value = age >= 0 ? `${age} yr` : '';
    }

    document.getElementById('birthday')?.addEventListener('input', updateAgeDisplay);
    setInterval(updateAgeDisplay, 60000);

    function updateOverallStatus() {
        const statuses = Array.from(document.querySelectorAll('.subject-entry')).map(e => e.querySelector('.status')?.value || 'drop');
        const overall = document.getElementById('overallStatus');
        if (!overall) return;
        if (statuses.length === 0) { overall.value = 'Drop'; return; }
        const hasCurrent = statuses.some(s => s === 'current');
        const hasInquiry = statuses.some(s => s === 'inquiry');
        const allDrop = statuses.every(s => s === 'drop');
        if (hasCurrent) overall.value = 'Current';
        else if (hasInquiry) overall.value = 'Inquiry';
        else if (allDrop) overall.value = 'Drop';
        else overall.value = 'Pause';
    }

    function updateCurrentLevelsSummary() {
        const summaryContainer = document.getElementById('currentLevelsSummary');
        if (!summaryContainer) return;
        const entries = document.querySelectorAll('.subject-entry');
        let hasSubjects = false;
        let html = '';
        entries.forEach(entry => {
            const status = entry.querySelector('.status')?.value;
            if (status === 'inquiry') return;
            const subjectName = entry.querySelector('.subject-name')?.value || 'Unknown';
            const currentLevel = entry.querySelector('.current-level-display')?.value || 'Not Set';
            hasSubjects = true;
            let pillStyle = '';
            let colorClass = 'subj-Math';
            if (status === 'drop' || status === 'pause') {
                pillStyle = 'background: #9ca3af !important; color: #fff !important;';
            } else {
                if (subjectName.includes('Chinese')) colorClass = 'subj-Chinese';
                else if (subjectName.includes('ERP')) colorClass = 'subj-ERP';
                else if (subjectName.includes('EFL')) colorClass = 'subj-EFL';
            }
            html += `<div style="background:#f8f9fa; padding:0.75rem; border-radius:8px; border-left:4px solid var(--primary);">
                <div style="font-size:0.85rem; color:var(--text-light); margin-bottom:0.25rem; text-transform:capitalize;">
                    ${subjectName} <span style="font-size:0.75rem; color:#888;">(${status})</span>
                </div>
                <div class="slot-pill ${colorClass}" style="margin:0; min-width:auto; padding:0.4rem 0.8rem; font-size:0.9rem; display:inline-block; ${pillStyle}">
                    ${currentLevel}
                </div>
            </div>`;
        });
        summaryContainer.innerHTML = hasSubjects ? html : '<p class="hint" style="grid-column: 1 / -1; margin:0;">Add subjects to view their current levels.</p>';
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const targetId = `tab-${btn.dataset.tab}`;
            document.getElementById(targetId)?.classList.add('active');
            if (btn.dataset.tab === 'schedule') renderSchedule();
            if (btn.dataset.tab === 'dt-at') renderATTable();
        });
    });

    function renderSchedule() {
        const thead = document.getElementById('scheduleHeader');
        const tbody = document.getElementById('scheduleBody');
        if (!thead || !tbody) return;
        thead.innerHTML = '';
        DAYS.forEach(day => {
            const th = document.createElement('th');
            th.textContent = day.substring(0, 3);
            thead.appendChild(th);
        });
        tbody.innerHTML = '';
        const schedule = DAYS.reduce((acc, d) => ({...acc, [d]: []}), {});
        document.querySelectorAll('.subject-entry').forEach(entry => {
            const nameEl = entry.querySelector('.subject-name');
            const statusEl = entry.querySelector('.status');
            const name = nameEl?.value;
            const status = statusEl?.value;
            if (!name || status === 'drop' || status === 'pause' || status === 'inquiry') return;
            entry.querySelectorAll('.timeslot-row').forEach(row => {
                const day = row.querySelector('.ts-day')?.value;
                const h = row.querySelector('.ts-hour')?.value;
                const m = row.querySelector('.ts-min')?.value;
                if (day && h && m) schedule[day].push({ name, time: `${h}:${m}`, color: SUBJECT_COLORS[name] });
            });
        });
        const tr = document.createElement('tr');
        DAYS.forEach(day => {
            const td = document.createElement('td');
            schedule[day].sort((a,b) => a.time.localeCompare(b.time)).forEach(slot => {
                const pill = document.createElement('span');
                pill.className = `slot-pill ${slot.color}`;
                pill.textContent = `${slot.name.substring(0,3)} ${slot.time}`;
                td.appendChild(pill);
            });
            if (schedule[day].length === 0) td.innerHTML = '<span style="color:#999;">-</span>';
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    }

    const scanBtn = document.getElementById('startScannerBtn');
    const qrModal = document.getElementById('qrModal');
    const closeQrModal = document.getElementById('closeQrModal');
    const qrStatus = document.getElementById('qr-status');
    const qrInput = document.getElementById('qrCodeInput');

    if (scanBtn && qrModal) {
        scanBtn.addEventListener('click', async () => {
            if (scannerActive) { await stopScanner(); return; }
            qrModal.style.display = 'flex';
            qrStatus.textContent = 'Initializing camera...';
            try {
                if (!html5QrCode) html5QrCode = new Html5Qrcode("qr-reader");
                await html5QrCode.start(
                    { facingMode: "environment" },
                    { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
                    (decodedText) => {
                        if (qrInput) qrInput.value = decodedText;
                        qrStatus.innerHTML = `<span style="color:#28a745;">✅ Scanned: <strong>${decodedText}</strong></span>`;
                        stopScanner();
                    },
                    () => {}
                );
                qrStatus.textContent = 'Point camera at QR code...';
                scannerActive = true;
                scanBtn.textContent = '⏹ Stop';
            } catch (err) {
                qrStatus.innerHTML = `<span style="color:#dc3545;">❌ Camera error: ${err.message}</span>`;
                qrModal.style.display = 'none';
                scannerActive = false;
            }
        });
        
        async function stopScanner() {
            if (html5QrCode && scannerActive) { try { await html5QrCode.stop(); } catch(e) {} }
            scannerActive = false;
            qrModal.style.display = 'none';
            scanBtn.textContent = '📷 Scan QR';
            qrStatus.textContent = 'Point camera at QR code...';
        }
        closeQrModal?.addEventListener('click', stopScanner);
        qrModal?.addEventListener('click', (e) => { if (e.target === qrModal) stopScanner(); });
    }
    window.addEventListener('beforeunload', async () => { if (html5QrCode && scannerActive) await html5QrCode.stop(); });

    function getLevelOptions(subject, currentValue = '') {
        let levels = [];
        if (subject === 'Math') {
            for (let i = 6; i >= 2; i--) levels.push(`${i}A`);
            levels = levels.concat(['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O']);
        } else if (subject === 'English EFL') {
            for (let i = 7; i >= 2; i--) levels.push(`${i}A`);
            levels = levels.concat(['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O']);
        } else if (subject.includes('Chinese') || subject === 'English ERP') {
            for (let i = 7; i >= 2; i--) levels.push(`${i}A`);
            ['A','B','C','D','E','F','G','H'].forEach(l => { levels.push(`${l}I`); levels.push(`${l}II`); });
            levels.push('II', 'III', 'J', 'K', 'L');
        }

        let optionsHTML = '<option value="">Select Level</option>';
        levels.forEach(lvl => { 
            optionsHTML += `<option value="${lvl}" ${lvl === currentValue ? 'selected' : ''}>${lvl}</option>`; 
        });
        return optionsHTML;
    }

    let activePREntry = null;

    function updatePRBanner(entry) {
        const banner = entry.querySelector('.pending-request-banner');
        const btn = entry.querySelector('.add-pr-btn');
        const prType = entry.querySelector('.pr-type')?.value;
        if (!prType) {
            banner.classList.add('hidden');
            const status = entry.querySelector('.status')?.value;
            if (btn && status !== 'drop' && status !== 'pause') btn.style.display = 'inline-block';
            return;
        }
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        let text = '';
        if (prType === 'drop') {
            const val = entry.querySelector('.pr-drop-month-year')?.value;
            const reason = entry.querySelector('.pr-reason')?.value;
            if (val) {
                const parts = val.split('-');
                const m = parts[1];
                const y = parts[0];
                text = `⚠️ Drop requested for ${m ? months[parseInt(m, 10) - 1] : ''} ${y}. Reason: ${reason}`;
            }
        } else {
            const fmVal = entry.querySelector('.pr-pause-from-month-year')?.value;
            const tmVal = entry.querySelector('.pr-pause-to-month-year')?.value;
            const reason = entry.querySelector('.pr-reason')?.value;
            let fm = '', fy = '', tm = '', ty = '';
            if (fmVal) { const p = fmVal.split('-'); fy = p[0]; fm = months[parseInt(p[1], 10) - 1] || ''; }
            if (tmVal) { const p = tmVal.split('-'); ty = p[0]; tm = months[parseInt(p[1], 10) - 1] || ''; }
            text = `⚠️ Pause requested from ${fm} ${fy} to ${tm} ${ty}. Reason: ${reason}`;
        }
        banner.querySelector('.banner-text').textContent = text;
        banner.classList.remove('hidden');
        if (btn) btn.style.display = 'none';
    }

    function openPRModal(entry) {
        activePREntry = entry;
        const type = entry.querySelector('.pr-type')?.value || 'pause';
        document.getElementById('prType').value = type;
        document.getElementById('prType').dispatchEvent(new Event('change'));
        document.getElementById('prReason').value = entry.querySelector('.pr-reason')?.value || '';
        
        const setMY = (id, m, y) => {
            const el = document.getElementById(id);
            if (el && y && m) el.value = `${y}-${String(m).padStart(2, '0')}`;
        };

        if (type === 'pause') {
            setMY('prPauseFromMonthYear', entry.querySelector('.pr-pause-from-month')?.value, entry.querySelector('.pr-pause-from-year')?.value);
            setMY('prPauseToMonthYear', entry.querySelector('.pr-pause-to-month')?.value, entry.querySelector('.pr-pause-to-year')?.value);
        } else {
            setMY('prDropMonthYear', entry.querySelector('.pr-drop-month')?.value, entry.querySelector('.pr-drop-year')?.value);
        }
        document.getElementById('dropPauseRequestModal').classList.remove('hidden');
    }

    function applySubjectUI(entry) {
        const statusEl = entry.querySelector('.status');
        if (!statusEl) return;
        const status = statusEl.value;
        const inquiryDate = entry.querySelector('.fld-inquiry-date');
        const startLevel = entry.querySelector('.fld-start-level');
        const startWS = entry.querySelector('.fld-start-ws');
        const enrolDate = entry.querySelector('.fld-enrol-date');
        const timeslots = entry.querySelector('.timeslots-container');

        const pauseFrom = entry.querySelector('.fld-pause-from');
        const pauseTo = entry.querySelector('.fld-pause-to');
        const pauseReason = entry.querySelector('.fld-pause-reason');

        const dropDate = entry.querySelector('.fld-drop-date');
        const dropReason = entry.querySelector('.fld-drop-reason');

        [inquiryDate, enrolDate].forEach(el => { if(el) el.style.display = 'none'; });
        [startLevel, startWS].forEach(el => { if(el) el.style.display = 'none'; });

        [pauseFrom, pauseTo, pauseReason, dropDate, dropReason].forEach(el => {
            if (el) el.style.display = 'none';
        });
        
        entry.querySelectorAll('.pause-from-month-year, .pause-to-month-year, .pause-reason').forEach(el => { if(el) el.required = false; });
        entry.querySelectorAll('.drop-month-year, .drop-reason').forEach(el => { if(el) el.required = false; });

        if (status === 'inquiry') {
            if (inquiryDate) { inquiryDate.style.display = 'block'; const input = inquiryDate.querySelector('input'); if (input) input.required = true; }
        } else {
            if (inquiryDate) { inquiryDate.style.display = 'none'; const input = inquiryDate.querySelector('input'); if (input) input.required = false; }
        }

        if (status === 'inquiry') {
            if (enrolDate) { enrolDate.style.display = 'none'; const input = enrolDate.querySelector('input'); if (input) input.required = false; }
            if (timeslots) timeslots.style.display = 'none';
        } else {
            if (enrolDate) { enrolDate.style.display = 'block'; const input = enrolDate.querySelector('input'); if (input) input.required = true; }
            if (timeslots) timeslots.style.display = 'block';
        }

        if (status === 'inquiry') {
            if (startLevel) { startLevel.style.display = 'none'; const sel = startLevel.querySelector('select'); if (sel) sel.required = false; }
            if (startWS) { startWS.style.display = 'none'; const sel = startWS.querySelector('select'); if (sel) sel.required = false; }
        } else {
            if (startLevel) { startLevel.style.display = 'block'; const sel = startLevel.querySelector('select'); if (sel) sel.required = true; }
            if (startWS) { startWS.style.display = 'block'; const sel = startWS.querySelector('select'); if (sel) sel.required = true; }
        }

        if (status === 'pause') {
            if (pauseFrom) {
                pauseFrom.style.display = 'block';
                const input = pauseFrom.querySelector('input');
                if (input) input.required = true;
            }
            if (pauseTo) {
                pauseTo.style.display = 'block';
                const input = pauseTo.querySelector('input');
                if (input) input.required = true;
            }
            if (pauseReason) {
                pauseReason.style.display = 'block';
                const input = pauseReason.querySelector('input');
                if (input) input.required = true;
            }
            if (timeslots) timeslots.style.display = 'none';
            if (enrolDate) { enrolDate.style.display = 'none'; const input = enrolDate.querySelector('input'); if (input) input.required = false; }
            if (startLevel) { startLevel.style.display = 'none'; const sel = startLevel.querySelector('select'); if (sel) sel.required = false; }
            if (startWS) { startWS.style.display = 'none'; const sel = startWS.querySelector('select'); if (sel) sel.required = false; }
        }

        if (status === 'drop') {
            if (dropDate) {
                dropDate.style.display = 'block';
                const input = dropDate.querySelector('input');
                if (input) input.required = true;
            }
            if (dropReason) {
                dropReason.style.display = 'block';
                const input = dropReason.querySelector('input');
                if (input) input.required = true;
            }
            if (timeslots) timeslots.style.display = 'none';
            if (enrolDate) { enrolDate.style.display = 'none'; const input = enrolDate.querySelector('input'); if (input) input.required = false; }
            if (startLevel) { startLevel.style.display = 'none'; const sel = startLevel.querySelector('select'); if (sel) sel.required = false; }
            if (startWS) { startWS.style.display = 'none'; const sel = startWS.querySelector('select'); if (sel) sel.required = false; }
        }

        if (status === 'drop') {
            entry.style.opacity = '0.65';
            entry.style.filter = 'grayscale(0.4)';
        } else if (status === 'pause') {
            entry.style.opacity = '0.85';
            entry.style.filter = 'none';
        } else {
            entry.style.opacity = '1';
            entry.style.filter = 'none';
        }

        const statusSelect = entry.querySelector('.status');
        if (statusSelect) statusSelect.disabled = false;

        const addPrBtn = entry.querySelector('.add-pr-btn');
        if (addPrBtn) {
            if (status === 'drop' || status === 'pause') {
                addPrBtn.style.display = 'none';
                if (entry.querySelector('.pr-type')?.value || entry.querySelector('.pr-cancelled')?.value === 'true') {
                    entry.querySelector('.pr-cancelled').value = 'true';
                    entry.querySelectorAll('.pr-type, .pr-reason, .pr-pause-from-month-year, .pr-pause-to-month-year, .pr-drop-month-year').forEach(el => el.value = '');
                    updatePRBanner(entry);
                }
            } else {
                updatePRBanner(entry);
            }
        }

        updateOverallStatus();
        renderSchedule();
        updateSubjectEntry(entry); 
        updateCurrentLevelsSummary();
        renderTeachersTab();
    }

    function collectFormData() {
        const subjects = [];
        
        // Helper to parse YYYY-MM into separate month and year for DB compatibility
        const parseMonthYear = (val) => {
            if (!val) return { month: '', year: '' };
            const parts = val.split('-');
            return { year: parts[0] || '', month: parts[1] || '' };
        };

        for (const entry of document.querySelectorAll('.subject-entry')) {
            const statusEl = entry.querySelector('.status');
            const status = statusEl?.value || 'drop';
            const timeslots = [];
            if (status !== 'inquiry' && status !== 'pause' && status !== 'drop') {
                entry.querySelectorAll('.timeslots-list .timeslot-row').forEach(row => {
                    const dayEl = row.querySelector('.ts-day');
                    const hourEl = row.querySelector('.ts-hour');
                    const minEl = row.querySelector('.ts-min');
                    timeslots.push({ day: dayEl?.value || '', time: `${hourEl?.value || '00'}:${minEl?.value || '00'}` });
                });
            }
            const pencilEntry = entry.querySelector('.pencil-skill-entry');
            const pencilVisible = pencilEntry && pencilEntry.style.display !== 'none';
            let pencilData = null;
            if (pencilVisible) {
                const pencilLevel = entry.querySelector('.pencil-level');
                const pencilWs = entry.querySelector('.pencil-ws');
                pencilData = { level: pencilLevel?.value || '', ws: pencilWs?.value || '' };
            }
            
            const pauseFromMY = parseMonthYear(entry.querySelector('.pause-from-month-year')?.value);
            const pauseToMY = parseMonthYear(entry.querySelector('.pause-to-month-year')?.value);
            const dropMY = parseMonthYear(entry.querySelector('.drop-month-year')?.value);

            subjects.push({
                name: entry.querySelector('.subject-name')?.value || '',
                startLevel: entry.querySelector('.start-level')?.value || '',
                startWS: parseInt(entry.querySelector('.start-ws')?.value) || 0,
                inquiryDate: entry.querySelector('.inquiry-date')?.value || '',
                currentLevel: entry.querySelector('.current-level-db')?.value || '',
                enrolDate: entry.querySelector('.enrol-date')?.value || '',
                status,
                timeslots,
                progress: [],
                pencilSkill: pencilData,
                pauseFromMonth: pauseFromMY.month,
                pauseFromYear: pauseFromMY.year,
                pauseToMonth: pauseToMY.month,
                pauseToYear: pauseToMY.year, 
                pauseReason: entry.querySelector('.pause-reason')?.value?.trim() || '',
                dropMonth: dropMY.month,
                dropYear: dropMY.year,
                dropReason: entry.querySelector('.drop-reason')?.value?.trim() || '',
                pendingRequest: (() => {
                    const isCancelled = entry.querySelector('.pr-cancelled')?.value === 'true';
                    if (isCancelled) return { cancelled: true, cancelledAt: new Date().toISOString() };
                    
                    const prType = entry.querySelector('.pr-type')?.value;
                    if (!prType) return null;
                    
                    const prPauseFromMY = parseMonthYear(entry.querySelector('.pr-pause-from-month-year')?.value);
                    const prPauseToMY = parseMonthYear(entry.querySelector('.pr-pause-to-month-year')?.value);
                    const prDropMY = parseMonthYear(entry.querySelector('.pr-drop-month-year')?.value);
                    
                    return {
                        type: prType,
                        pauseFromMonth: prPauseFromMY.month,
                        pauseFromYear: prPauseFromMY.year,
                        pauseToMonth: prPauseToMY.month,
                        pauseToYear: prPauseToMY.year,
                        dropMonth: prDropMY.month,
                        dropYear: prDropMY.year,
                        reason: entry.querySelector('.pr-reason')?.value || ''
                    };
                })(),
                worksheetType: entry.querySelector('.worksheet-type')?.value || 'Paper'
            });
        }
        const diagnosticTests = [];
        document.querySelectorAll('#dtTableBody tr').forEach(row => {
            diagnosticTests.push({
                subject: row.querySelector('.dt-subject')?.value || '',
                date: row.querySelector('.dt-date')?.value || '',
                test: row.querySelector('.dt-test')?.value || '',
                score: row.querySelector('.dt-score')?.value || '',
                time: row.querySelector('.dt-time')?.value || '',
                suggestedStart: row.querySelector('.dt-suggested')?.value || '',
                actualStart: row.querySelector('.dt-actual')?.value || ''
            });
        });
        const getVal = (id) => {
            const select = document.getElementById(id);
            const other = document.getElementById(id + 'Other');
            if (!select) return '';
            if (select.value === 'Other' && other) return other.value?.trim() || '';
            return select.value?.trim() || '';
        };
        const assignedTeachers = {};
        document.querySelectorAll('.teacher-checkbox:checked').forEach(cb => {
            const subj = cb.dataset.subject;
            const uid = cb.dataset.uid;
            if (!assignedTeachers[subj]) assignedTeachers[subj] = [];
            assignedTeachers[subj].push(uid);
        });
        return {
            gender: document.getElementById('gender')?.value || '',
            studentNumber: document.getElementById('studentNumber')?.value?.trim() || '',
            nickname: document.getElementById('nickname')?.value?.trim() || '',
            namePinyin: document.getElementById('namePinyin')?.value?.trim() || '',
            nameCn: document.getElementById('nameCn')?.value?.trim() || '',
            grade: getVal('grade'),
            school: getVal('school'),
            address: document.getElementById('address')?.value?.trim() || '',
            nationality: getVal('nationality'),
            email: document.getElementById('email')?.value?.trim() || '',
            birthday: document.getElementById('birthday')?.value || '',
            parentOrientation: document.getElementById('parentOrientation')?.value || '',
            poDate: document.getElementById('poDate')?.value || '',
            poReason: document.getElementById('poReason')?.value?.trim() || '',
            phone: {
                mom: document.getElementById('phoneMom')?.value?.trim() || '',
                dad: document.getElementById('phoneDad')?.value?.trim() || '',
                own: document.getElementById('phoneOwn')?.value?.trim() || ''
            },
            qrCode: document.getElementById('qrCodeInput')?.value?.trim() || '',
            kcNo: document.getElementById('kcNo')?.value?.trim() || '',
            subjects,
            diagnosticTests,
            assignedTeachers 
        };
    }

    // ==========================================
    // 🆕 HELPER: COUNT ACTIVE SUBJECTS
    // ==========================================
    function getActiveSubjectCount(excludeEntry = null) {
        let count = 0;
        document.querySelectorAll('.subject-entry').forEach(entry => {
            if (entry === excludeEntry) return;
            const status = entry.querySelector('.status')?.value;
            if (status && status !== 'drop') count++;
        });
        return count;
    }

    function getUsedSubjects(excludeEntry = null) {
        const used = new Set();
        document.querySelectorAll('.subject-entry').forEach(entry => {
            if (entry === excludeEntry) return;
            const subjectSelect = entry.querySelector('.subject-name');
            const statusSelect = entry.querySelector('.status');
            const subject = subjectSelect?.value;
            const status = statusSelect?.value;
            if (subject && status !== 'drop') used.add(subject);
        });
        return used;
    }

    function refreshSubjectOptions(subjectSelect) {
        if (!subjectSelect) return;
        const currentValue = subjectSelect.value;
        const entry = subjectSelect.closest('.subject-entry');
        const usedSubjects = getUsedSubjects(entry);
        let optionsHTML = '<option value="">Select Subject *</option>';
        SUBJECTS.forEach(s => {
            const isSelected = s === currentValue;
            const isUsed = usedSubjects.has(s) && !isSelected;
            const disabled = isUsed ? 'disabled' : '';
            const hint = isUsed ? ' (Added)' : '';
            optionsHTML += `<option value="${s}" ${isSelected ? 'selected' : ''} ${disabled}>${s}${hint}</option>`;
        });
        subjectSelect.innerHTML = optionsHTML;
    }

    function updateSubjectEntry(entry) {
        const subjectSelect = entry.querySelector('.subject-name');
        const subject = subjectSelect?.value;
        entry.classList.remove('subj-Math', 'subj-Chinese', 'subj-ERP', 'subj-EFL');
        if (subject && SUBJECT_COLORS[subject]) entry.classList.add(SUBJECT_COLORS[subject]);
    }


function addSubjectField(data = {}) {
    if (subjectCount >= 4) return showError('Maximum 4 subjects allowed.');
    const container = document.getElementById('subjectsContainer');
    if (!container) return;
    
    if (data.pencilSkill) {
        let rawLevel = String(data.pencilSkill.level || '');
        let rawWs = String(data.pencilSkill.ws || '');
        const match = rawLevel.match(/^(ZI|ZII)(\d+)$/i);
        if (match) {
            data.pencilSkill.level = match[1].toUpperCase();
            data.pencilSkill.ws = match[2];
        }
    }
    
    const div = document.createElement('div');  
    div.className = 'subject-entry';
    const usedSubjects = getUsedSubjects(div);
    const initialSubject = data.name || 'Math';
    const levelOptionsHTML = getLevelOptions(initialSubject, data.startLevel);
    
    div.innerHTML = `
     <div class="form-grid">
         <div>
             <label>Status</label>
             <select class="status">
                 <option value="inquiry" ${data.status === 'inquiry' ? 'selected' : ''}>Inquiry</option>
                 <option value="current" ${data.status === 'current' ? 'selected' : ''} ${!data.status ? 'selected' : ''}>Current</option>
                 <option value="pause" ${data.status === 'pause' ? 'selected' : ''}>Pause</option>
                 <option value="drop" ${data.status === 'drop' ? 'selected' : ''}>Drop</option>
             </select>
         </div>
         <div class="fld-pause-from" style="display:${data.status === 'pause' ? 'block' : 'none'};">
             <label>Pause From *</label>
             <input type="month" class="pause-from-month-year" value="${(data.pauseFromYear && data.pauseFromMonth) ? `${data.pauseFromYear}-${String(data.pauseFromMonth).padStart(2, '0')}` : ''}">
         </div>
         <div class="fld-pause-to" style="display:${data.status === 'pause' ? 'block' : 'none'};">
             <label>Pause To *</label>
             <input type="month" class="pause-to-month-year" value="${(data.pauseToYear && data.pauseToMonth) ? `${data.pauseToYear}-${String(data.pauseToMonth).padStart(2, '0')}` : ''}">
         </div>
         <div class="fld-drop-date" style="display:${data.status === 'drop' ? 'block' : 'none'};">
             <label>Drop Month *</label>
             <input type="month" class="drop-month-year" value="${(data.dropYear && data.dropMonth) ? `${data.dropYear}-${String(data.dropMonth).padStart(2, '0')}` : ''}">
         </div>
         <div>
             <label>Select Subject *</label>
             <select class="subject-name" required>
                 <option value="">Select Subject *</option>
                ${SUBJECTS.map(s => {
                    const isSelected = data.name === s;
                    const isUsed = usedSubjects.has(s) && !isSelected;
                    return `<option value="${s}" ${isSelected ? 'selected' : ''} ${isUsed ? 'disabled' : ''}>${s}${isUsed ? ' (Added)' : ''}</option>`;
                }).join('')}
             </select>
         </div>
         <div class="fld-inquiry-date" style="display:${data.status === 'inquiry' ? 'block' : 'none'};">
             <label>Inquiry Date *</label>
             <input type="date" class="inquiry-date" value="${data.inquiryDate || ''}">
         </div>
         <div class="fld-start-level" style="display:${(data.status === 'inquiry' || data.status === 'pause' || data.status === 'drop') ? 'none' : 'block'};">
             <label>Start Level *</label>
             <select class="start-level subject-level-select">${levelOptionsHTML}</select>
         </div>
         <div class="fld-start-ws" style="display:${(data.status === 'inquiry' || data.status === 'pause' || data.status === 'drop') ? 'none' : 'block'};">
             <label>Start WS # *</label>
             <select class="start-ws">${getWSDropdownOptions(data.startWS)}</select>
         </div>
         <input type="hidden" class="current-level-db" value="${data.currentLevel || ''}">
         <div class="fld-current-level-readonly" style="display:block;">
             <label>Current Level <span style="color:#999; font-weight:400;">(From Database)</span></label>
             <input type="text" class="current-level-display" readonly value="${data.currentLevel || 'Not Set'}" style="background:#f1f5f9; color:#64748b; cursor:not-allowed;">
         </div>
         <div class="fld-enrol-date" style="display:${(data.status === 'inquiry' || data.status === 'pause' || data.status === 'drop') ? 'none' : 'block'};">
             <label>Enrol Date *</label>
             <input type="date" class="enrol-date" value="${data.enrolDate || ''}">
         </div>
         <div class="fld-worksheet-type">
             <label>Worksheet Type</label>
             <select class="worksheet-type">
                 <option value="Paper" ${data.worksheetType === 'Paper' || !data.worksheetType ? 'selected' : ''}>Paper</option>
                 <option value="Kumon Connect" ${data.worksheetType === 'Kumon Connect' ? 'selected' : ''}>Kumon Connect</option>
             </select>
         </div>
     </div>
     <div class="pending-request-banner hidden">
         <div class="banner-content">
             <span class="banner-icon">⏳</span>
             <span class="banner-text"></span>
         </div>
         <button type="button" class="cancel-pr-btn danger">Cancel Request</button>
     </div>
     <input type="hidden" class="pr-cancelled" value="${data.pendingRequest?.cancelled ? 'true' : 'false'}">
     <input type="hidden" class="pr-type" value="${data.pendingRequest?.cancelled ? '' : (data.pendingRequest?.type || '')}">
     <input type="hidden" class="pr-pause-from-month-year" value="${data.pendingRequest?.cancelled ? '' : ((data.pendingRequest?.pauseFromYear && data.pendingRequest?.pauseFromMonth) ? `${data.pendingRequest.pauseFromYear}-${String(data.pendingRequest.pauseFromMonth).padStart(2, '0')}` : '')}">
     <input type="hidden" class="pr-pause-to-month-year" value="${data.pendingRequest?.cancelled ? '' : ((data.pendingRequest?.pauseToYear && data.pendingRequest?.pauseToMonth) ? `${data.pendingRequest.pauseToYear}-${String(data.pendingRequest.pauseToMonth).padStart(2, '0')}` : '')}">
     <input type="hidden" class="pr-drop-month-year" value="${data.pendingRequest?.cancelled ? '' : ((data.pendingRequest?.dropYear && data.pendingRequest?.dropMonth) ? `${data.pendingRequest.dropYear}-${String(data.pendingRequest.dropMonth).padStart(2, '0')}` : '')}">
     <input type="hidden" class="pr-reason" value="${data.pendingRequest?.cancelled ? '' : (data.pendingRequest?.reason || '')}">
     <button type="button" class="add-pr-btn secondary" style="position:absolute; bottom:1rem; right:1rem; background:#fff3cd; color:#856404; border:1px solid #ffeeba; width:auto; padding:0.4rem 0.8rem; font-size:0.85rem; z-index:10;">🗓️ Drop/Pause Request</button>
     <button type="button" class="add-pencil-btn secondary" style="margin:0.25rem 0 0.75rem; padding:0.3rem 0.7rem; font-size:0.85rem; width:auto; background:#e8f0fe; color:#667eea; border:1px solid #667eea;">➕ Add Pencil Skill</button>
     <div class="pencil-skill-entry" style="display:none; margin-top:0.5rem; margin-bottom:1rem; padding:0.75rem; background:#e8f0fe; border-radius:8px; border-left:4px solid #667eea;">
         <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
             <h4 style="font-size:0.9rem; margin:0; color:#333;">Pencil Skill</h4>
             <button type="button" class="remove-pencil-btn" style="background:none; border:none; cursor:pointer; color:#dc3545; font-size:1.2rem; padding:0; line-height:1;">×</button>
         </div>
         <div class="form-grid">
             <div> <label>Pencil Level</label> <select class="pencil-level"> <option value="">Select Level</option>${['ZI','ZII'].map(l => `<option value="${l}" ${data.pencilSkill?.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select> </div>
             <div> <label>Pencil Start WS</label> <select class="pencil-ws">${getWSDropdownOptions(data.pencilSkill?.ws)}</select> </div>
         </div>
     </div>
     <div class="fld-pause-reason pause-drop-reason-field" style="display:${data.status === 'pause' ? 'block' : 'none'};">
         <label>Reason for Pause *</label>
         <input type="text" class="pause-reason" placeholder="Enter reason for pause..." value="${data.pauseReason || ''}">
     </div>
     <div class="fld-drop-reason pause-drop-reason-field" style="display:${data.status === 'drop' ? 'block' : 'none'};">
         <label>Reason for Drop *</label>
         <input type="text" class="drop-reason" placeholder="Enter reason for drop..." value="${data.dropReason || ''}">
     </div>
  <div class="timeslots-container" style="display:${(data.status === 'inquiry' || data.status === 'pause' || data.status === 'drop') ? 'none' : 'block'}; margin-bottom:1rem;">
     <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
         <h4 style="font-size:0.9rem; margin:0;">Timeslots (Max 6)</h4>
         <button type="button" class="add-timeslot-btn secondary" style="margin:0; padding:0.3rem 0.8rem; font-size:0.8rem; width:auto;">+ Add Timeslot</button>
     </div>
     <div class="timeslots-list"></div>
 </div>
 <button type="button" class="remove-subject" style="background:#dc3545; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; margin-top:1.5rem;">Remove Subject</button>`;  
 
    const timeslotsList = div.querySelector('.timeslots-list');
    
    // ✅ MODIFIED: Only populate timeslots if they exist in the database (editing). 
    // Removed the 'else' block that automatically added a default empty timeslot row.
    if (data.timeslots?.length) {
        data.timeslots.forEach(ts => addTimeslotField(timeslotsList, ts));
    }

    const addPencilBtn = div.querySelector('.add-pencil-btn');
    const pencilEntry = div.querySelector('.pencil-skill-entry');
    if (data.pencilSkill && (data.pencilSkill.level || data.pencilSkill.ws)) {
        pencilEntry.style.display = 'block';
        addPencilBtn.style.display = 'none';
        const pencilLevel = pencilEntry.querySelector('.pencil-level');
        const pencilWs = pencilEntry.querySelector('.pencil-ws');
        if (pencilLevel) pencilLevel.required = true;
        if (pencilWs) pencilWs.required = true;
    }
    
    if (addPencilBtn) {
        addPencilBtn.onclick = () => {
            const anyVisible = Array.from(document.querySelectorAll('.pencil-skill-entry')).some(el => el.style.display !== 'none');
            if (anyVisible) return showError('⚠️ Only one Pencil Skill can be added per student.');
            pencilEntry.style.display = 'block';  
            addPencilBtn.style.display = 'inline-block';
            const pencilLevel = pencilEntry.querySelector('.pencil-level');
            const pencilWs = pencilEntry.querySelector('.pencil-ws');
            if (pencilLevel) pencilLevel.required = true;
            if (pencilWs) pencilWs.required = true;
        };
    }
    
    const removePencilBtn = div.querySelector('.remove-pencil-btn');
    if (removePencilBtn) {
        removePencilBtn.onclick = () => {
            pencilEntry.style.display = 'none';
            if (addPencilBtn) addPencilBtn.style.display = 'inline-block';
            const pencilLevel = pencilEntry.querySelector('.pencil-level');
            const pencilWs = pencilEntry.querySelector('.pencil-ws');
            if (pencilLevel) { pencilLevel.value = ''; pencilLevel.required = false; }
            if (pencilWs) { pencilWs.value = ''; pencilWs.required = false; }
        };
    }
    
    const addPrBtn = div.querySelector('.add-pr-btn');
    if (addPrBtn) addPrBtn.onclick = () => openPRModal(div);
    
    const cancelPrBtn = div.querySelector('.cancel-pr-btn');
    if (cancelPrBtn) {
        cancelPrBtn.onclick = () => {
            div.querySelector('.pr-cancelled').value = 'true';
            div.querySelectorAll('.pr-type, .pr-reason, .pr-pause-from-month-year, .pr-pause-to-month-year, .pr-drop-month-year').forEach(el => el.value = '');
            updatePRBanner(div);
        };
    }
    
    updatePRBanner(div); 
    
    const addTimeslotBtn = div.querySelector('.add-timeslot-btn');
    if (addTimeslotBtn) addTimeslotBtn.onclick = () => addTimeslotField(timeslotsList);
    
    const removeSubjectBtn = div.querySelector('.remove-subject');
    if (removeSubjectBtn) {
        removeSubjectBtn.onclick = () => {
            div.remove();
            subjectCount--;
            renderTeachersTab();
            updateOverallStatus();
            renderSchedule();
            updateCurrentLevelsSummary();
            document.querySelectorAll('.subject-entry').forEach(entry => {
                const select = entry.querySelector('.subject-name');
                if (select) refreshSubjectOptions(select);
            });
        };
    }
    
    const subjectNameSelect = div.querySelector('.subject-name');
    if (subjectNameSelect) {
        subjectNameSelect.addEventListener('change', (e) => {
            const startLevelSelect = div.querySelector('.start-level');
            if (startLevelSelect) startLevelSelect.innerHTML = getLevelOptions(e.target.value, '');
            validateConflict(e.target);
            renderSchedule();
            updateSubjectEntry(div);
            renderTeachersTab();
            updateCurrentLevelsSummary();
            document.querySelectorAll('.subject-entry').forEach(entry => {
                const select = entry.querySelector('.subject-name');
                if (select && select !== e.target) refreshSubjectOptions(select);
            });
        });
    }
    
    const statusSelect = div.querySelector('.status');
    if (statusSelect) {
        statusSelect.addEventListener('change', () => {
            // Prevent activating a 4th subject
            if (statusSelect.value !== 'drop' && getActiveSubjectCount(div) >= 3) {
                showError('⚠️ Maximum 3 active subjects allowed. Please drop another subject first.');
                statusSelect.value = 'drop'; // Revert selection to prevent invalid state
            }
            applySubjectUI(div);
        });
    }
    
    container.appendChild(div);
    subjectCount++;
    applySubjectUI(div);
}

    function validateConflict(currentSelect) {
        if (!currentSelect) return;
        const selected = currentSelect.value;
        if (!selected) return;
        const entry = currentSelect.closest('.subject-entry');
        const currentStatusEl = entry?.querySelector('.status');
        const currentStatus = currentStatusEl?.value;
        const others = Array.from(document.querySelectorAll('.subject-name')).filter(s => s !== currentSelect);
        for (const s of others) {
            const otherEntry = s.closest('.subject-entry');
            const otherStatusEl = otherEntry?.querySelector('.status');
            const otherStatus = otherStatusEl?.value;
            if (s.value === selected && otherStatus !== 'drop' && currentStatus !== 'drop') {
                showError(`⚠️ ${selected} is already added. Please choose a different subject or drop the existing one.`);
                currentSelect.value = ''; return;
            }
            if (['English ERP', 'English EFL'].includes(selected) && ['English ERP', 'English EFL'].includes(s.value)) {
                if (otherStatus !== 'drop' && currentStatus !== 'drop') {
                    showError('English ERP & EFL cannot be together unless one is Dropped.');
                    currentSelect.value = ''; return;
                }
            }
            if (selected.includes('Chinese') && s.value.includes('Chinese')) {
                if (otherStatus !== 'drop' && currentStatus !== 'drop') {
                    showError('Please select only one type of Chinese (Traditional or Simplified).');
                    currentSelect.value = ''; return;
                }
            }
        }
    }

    function getHourOptions(selectedHour, day = 'Monday') {
        const isWeekend = ['Saturday', 'Sunday'].includes(day);
        let opts = '';
        for (let i = isWeekend ? 9 : 10; i <= (isWeekend ? 18 : 21); i++) {
            const val = String(i).padStart(2, '0');
            opts += `<option value="${val}" ${val === selectedHour ? 'selected' : ''}>${val}</option>`;
        }
        return opts;
    }

    function getMinuteOptions(selectedMin) {
        let opts = '';
        for (let i = 0; i < 60; i++) {
            const val = String(i).padStart(2, '0');
            opts += `<option value="${val}" ${val === selectedMin ? 'selected' : ''}>${val}</option>`;
        }
        return opts;
    }

    function isTimeslotGloballyUsed(day, hour, min, excludeRow = null) {
        for (const row of document.querySelectorAll('.timeslot-row')) {
            if (row === excludeRow) continue;
            const subjectEntry = row.closest('.subject-entry');
            if (subjectEntry?.querySelector('.status')?.value === 'drop') continue;
            if (row.querySelector('.ts-day')?.value === day && row.querySelector('.ts-hour')?.value === hour && row.querySelector('.ts-min')?.value === min) {
                return subjectEntry?.querySelector('.subject-name')?.value || 'another subject';
            }
        }
        return false;
    }

    function addTimeslotField(timeslotsList, data = {}) {
        if (!timeslotsList || timeslotsList.children.length >= 6) return showError('Maximum 6 timeslots per subject');
        let h = '01', m = '00', day = data.day || 'Monday';
        if (data.time) { const p = data.time.split(':'); if(p.length===2) { h = p[0]; m = p[1]; } }
        const row = document.createElement('div');
        row.className = 'timeslot-row';
        row.innerHTML = `
         <div> <label>Day</label> <select class="ts-day" required>${DAYS.map(d => `<option value="${d}" ${data.day === d ? 'selected' : ''}>${d}</option>`).join('')}</select> </div>
         <div> <label>Time (24h)</label> <div class="time-input-group"> <select class="ts-hour" required>${getHourOptions(h, day)}</select> <span class="time-separator">:</span> <select class="ts-min" required>${getMinuteOptions(m)}</select> </div> </div>
         <div class="remove-timeslot-wrapper"> <button type="button" class="remove-ts-btn" title="Remove">×</button> </div>`;
        
        const daySel = row.querySelector('.ts-day'), hourSel = row.querySelector('.ts-hour'), minSel = row.querySelector('.ts-min');
        const checkConflict = () => {
            if (!daySel?.value || !hourSel?.value || !minSel?.value) return;
            const conflict = isTimeslotGloballyUsed(daySel.value, hourSel.value, minSel.value, row);
            if (conflict) showError(`⚠️ Timeslot conflict: ${daySel.value} ${hourSel.value}:${minSel.value} booked for ${conflict}.`);
        };
        if (daySel) daySel.addEventListener('change', e => {
            if (hourSel) hourSel.innerHTML = getHourOptions(hourSel.value, e.target.value);
            checkConflict(); renderSchedule();
        });
        if (hourSel) hourSel.addEventListener('change', () => { checkConflict(); renderSchedule(); });
        if (minSel) minSel.addEventListener('change', () => { checkConflict(); renderSchedule(); });
        const removeBtn = row.querySelector('.remove-ts-btn');
        if (removeBtn) removeBtn.onclick = () => { row.remove(); renderSchedule(); };
        timeslotsList.appendChild(row);
    }

        document.getElementById('addSubjectBtn')?.addEventListener('click', () => {
            if (subjectCount >= 4) return showError('Maximum 4 subjects allowed in the system.');
            if (getActiveSubjectCount() >= 3) return showError('⚠️ Maximum 3 active subjects allowed. Please drop an existing subject before adding a new one.');
            addSubjectField();
        });

    function addDTRow(data = {}) {
        const tbody = document.getElementById('dtTableBody');
        if (!tbody) return;
        const tr = document.createElement('tr');  
        tr.innerHTML = `
         <td> <select class="dt-subject" required style="width:100%; padding:0.5rem;"> <option value="">Select Subject</option>${SUBJECTS.map(s => `<option value="${s}" ${data.subject === s ? 'selected' : ''}>${s}</option>`).join('')}</select> </td>
         <td> <input type="date" class="dt-date" value="${data.date || ''}" required style="width:100%; padding:0.5rem;"> </td>
         <td> <input type="text" class="dt-test" placeholder="e.g., K1/K2" value="${data.test || ''}" required style="width:100%; padding:0.5rem;"> </td>
         <td> <input type="text" class="dt-score" placeholder="e.g., 85/100" value="${data.score || ''}" required style="width:100%; padding:0.5rem;"> </td>
         <td> <input type="number" class="dt-time" placeholder="30" value="${data.time || ''}" required style="width:100%; padding:0.5rem;"> </td>
         <td> <input type="text" class="dt-suggested" placeholder="e.g., 7A" value="${data.suggestedStart || ''}" style="width:100%; padding:0.5rem;"> </td>
         <td> <input type="text" class="dt-actual" placeholder="e.g., 7A" value="${data.actualStart || ''}" style="width:100%; padding:0.5rem;"> </td>
         <td style="text-align:center;"> <button type="button" class="remove-dt-btn danger" style="padding:0.4rem 0.8rem;">🗑️</button> </td>`;
        tbody.appendChild(tr);
        tr.querySelector('.remove-dt-btn').onclick = () => tr.remove();
    }

    function renderATTable() {
        const tbody = document.getElementById('atTableBody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!currentStudentData || !currentStudentData.subjects) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#999; padding:1rem;">No student data loaded.</td></tr>';
            return;
        }
        const subjects = Array.isArray(currentStudentData.subjects) ? currentStudentData.subjects : Object.values(currentStudentData.subjects || {});
        let hasData = false;
        subjects.forEach(sub => {
            if (!sub.progress) return;
            const progArray = Array.isArray(sub.progress) ? sub.progress : Object.values(sub.progress || {});
            progArray.forEach(prog => {
                const testsToRender = prog.tests || (prog.test ? [prog.test] : []);
                testsToRender.forEach(test => {
                    if (test && (test.date || test.level || test.score || test.time || test.group)) {
                        hasData = true;
                        const tr = document.createElement('tr');
                        tr.innerHTML = `
                         <td>${sub.name || 'Unknown'}</td>
                         <td>${test.level || '-'}</td>
                         <td>${test.date || '-'}</td>
                         <td>${test.score || '-'}</td>
                         <td>${test.time || '-'}</td>
                         <td>${test.group || '-'}</td>`;
                        tbody.appendChild(tr);
                    }
                });
            });
        });
        if (!hasData) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#999; padding:1rem;">No Achievement Tests recorded yet. Update monthly reports to see data here.</td></tr>';
        }
    }

    document.getElementById('addDTBtn')?.addEventListener('click', () => addDTRow());

    async function loadStudentData() {
        try {
            if (!centerId || !studentId) {
                showError('Missing center or student ID');
                hideLoader();  
                return;
            }
            const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
            if (snap.exists()) {
                let s = snap.val();
                
                if (processPendingRequests(s)) {
                    s.updatedAt = new Date().toISOString();
                    await update(ref(db, `centers/${centerId}/students/${studentId}`), s);
                    console.log("⏳ Pending Drop/Pause requests auto-executed and saved.");
                }
                
                currentStudentData = s;
                if (checkSeptemberGradeUpdate(s)) {
                    await set(ref(db, `centers/${centerId}/students/${studentId}`), s);
                    console.log(`🍂 Grade auto-updated for Sept: ${s.grade}`);
                }
                const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
                const setFieldWithOther = (id, value) => {
                    const select = document.getElementById(id);
                    const otherInput = document.getElementById(id + 'Other');
                    if (!select) return;
                    let found = false;
                    if (select.options) {
                        for (let i = 0; i < select.options.length; i++) {
                            if (select.options[i].value === value) { found = true; break; }
                        }
                    }
                    if (found) {
                        select.value = value;
                        if (otherInput) otherInput.classList.remove('visible');
                    } else {
                        select.value = 'Other';
                        if (otherInput) {
                            otherInput.value = value || '';
                            otherInput.classList.add('visible');
                        }
                    }
                };
                ['studentNumber','nickname','namePinyin','nameCn','email','address','gender'].forEach(id => setVal(id, s[id]));
                setVal('kcNo', s.kcNo || '');
                
                if (s.grade) setFieldWithOther('grade', s.grade);
                if (s.school) setFieldWithOther('school', s.school);
                if (s.nationality) setFieldWithOther('nationality', s.nationality);
                setVal('birthday', s.birthday);
                updateAgeDisplay();
                if (s.qrCode && qrInput) qrInput.value = s.qrCode;
                if (s.phone) {
                    ['mom','dad','own'].forEach(k => {
                        const el = document.getElementById(`phone${k.charAt(0).toUpperCase()+k.slice(1)}`);
                        if (el) el.value = s.phone[k] || '';
                    });
                }
                if (s.diagnosticTests && Array.isArray(s.diagnosticTests)) {
                    s.diagnosticTests.forEach(dt => addDTRow(dt));
                }
                
                if (s.subjects?.length) {
                    s.subjects.forEach(sub => {
                        if (sub.kcNo && !s.kcNo) {
                            s.kcNo = sub.kcNo;
                            setVal('kcNo', s.kcNo);
                        }
                        if (!sub.worksheetType && s.worksheetType) {
                            sub.worksheetType = s.worksheetType;
                        }
                        addSubjectField(sub);
                        const entries = document.querySelectorAll('.subject-entry');
                        if (entries.length) applySubjectUI(entries[entries.length - 1]);
                    });
                } else {
                    addSubjectField();
                }
                setVal('parentOrientation', s.parentOrientation);
                setVal('poDate', s.poDate);
                setVal('poReason', s.poReason);
                if (typeof togglePO === 'function') togglePO();
                updateOverallStatus();
                updateCurrentLevelsSummary();
                renderTeachersTab(); 
                originalFormData = collectFormData();
            } else {
                showError('Student not found in database.');
                setTimeout(() => window.location.href = 'students.html', 1500);
            }
        } catch (err) {
            console.error('Load Error:', err);
            showError('Error loading student: ' + err.message);
        } finally {
            hideLoader();
        }
    }

    const deleteBtn = document.getElementById('deleteBtn');
    if(isEdit && deleteBtn) {
        deleteBtn.style.display = '';
        deleteBtn.onclick = async () => {
            if(confirm('Permanently delete this student?')) {
                try {
                    showLoader();
                    await remove(ref(db, `centers/${centerId}/students/${studentId}`));
                    alert('Deleted!');
                    window.location.href='students.html';
                } catch(err) {
                    showError('Error: '+err.message);
                } finally {
                    hideLoader();
                }
            }
        };
    }

    const transferBtn = document.getElementById('transferBtn');
    const transferModal = document.getElementById('transferModal');
    const targetCenterSelect = document.getElementById('targetCenterSelect');
    if(isEdit && transferBtn) {
        transferBtn.style.display = '';
        transferBtn.onclick = async () => {
            transferModal.classList.remove('hidden');
            targetCenterSelect.innerHTML = '<option value="">Loading centers...</option>';
            try {
                const snap = await get(ref(db, 'centers'));
                if (snap.exists()) {
                    let opts = '';
                    Object.keys(snap.val()).forEach(k => {
                        if(k !== centerId) opts += `<option value="${k}">${snap.val()[k].name || k}</option>`;
                    });
                    targetCenterSelect.innerHTML = opts || '<option value="">No centers available</option>';
                }
            } catch {
                targetCenterSelect.innerHTML = '<option value="">Error loading</option>';
            }
        };
    }

    document.getElementById('closeTransferModal')?.addEventListener('click', () => transferModal.classList.add('hidden'));
    document.getElementById('confirmTransferBtn')?.addEventListener('click', async () => {
        const targetId = targetCenterSelect?.value;
        if (!targetId || targetId === centerId) return showError('Please select a valid target center.');
        if (!confirm(`Transfer student to ${targetId.replace(/kumon-/g,'').replace(/-/g,' ').toUpperCase()}?`)) return;
        transferModal.classList.add('hidden');
        showLoader();
        try {
            const sourceRef = ref(db, `centers/${centerId}/students/${studentId}`);
            const snap = await get(sourceRef);
            if(!snap.exists()) throw new Error('Student not found.');
            const data = snap.val();
            data.transferredFrom = centerId;
            data.transferredAt = new Date().toISOString();
            await push(ref(db, `centers/${targetId}/students`), data);
            await remove(sourceRef);
            alert('✅ Transferred!');
            window.location.href = 'students.html';
        } catch(err) {
            showError('Transfer failed: ' + err.message);
        } finally {
            hideLoader();
        }
    });

    document.getElementById('studentForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!centerId) return showError('Error: No center selected.');
        if (html5QrCode && scannerActive) await html5QrCode.stop();
        
        const contactChecks = [
            { id: 'nameCn', label: 'Full Name (Chinese)' }, { id: 'birthday', label: 'Birthday' },
            { id: 'grade', label: 'Grade' }, { id: 'school', label: 'School' }, { id: 'nationality', label: 'Nationality' }
        ];
        for (const check of contactChecks) {
            const el = document.getElementById(check.id);
            const otherEl = document.getElementById(check.id + 'Other');
            const val = el?.value === 'Other' ? otherEl?.value?.trim() : el?.value?.trim();
            if (!val) return showError(`⚠️ "${check.label}" is required.`);
        }
        
        const phoneMom = document.getElementById('phoneMom')?.value?.trim();
        const phoneDad = document.getElementById('phoneDad')?.value?.trim();
        const phoneOwn = document.getElementById('phoneOwn')?.value?.trim();
        if (!phoneMom && !phoneDad && !phoneOwn) return showError('⚠️ At least one Phone Number is required.');
        
        const poSelect = document.getElementById('parentOrientation');
        const poVal = poSelect?.value;
        if (!poVal) return showError('⚠️ "Parent Orientation" is required.');
        if (poVal === 'Yes') {
            const poDateEl = document.getElementById('poDate');
            if (poDateEl && !poDateEl.value) return showError('⚠️ Please select a Parent Orientation date.');
        }
        if (poVal === 'No') {
            const poReasonEl = document.getElementById('poReason');
            if (poReasonEl && !poReasonEl.value?.trim()) return showError('⚠️ Please provide a reason for no Parent Orientation.');
        }

        let hasKCSubject = false;
        for (const entry of document.querySelectorAll('.subject-entry')) {
            if (entry.querySelector('.worksheet-type')?.value === 'Kumon Connect') {
                hasKCSubject = true;
                break;
            }
        }
        const globalKcNo = document.getElementById('kcNo')?.value?.trim();
        if (hasKCSubject && !globalKcNo) {
            return showError('⚠️ KC No. is required at the top level when a subject uses Kumon Connect.');
        }

        const pencilCount = Array.from(document.querySelectorAll('.pencil-skill-entry')).filter(el => el.style.display !== 'none').length;
        if (pencilCount > 1) return showError('⚠️ Only one Pencil Skill can be added per student.');
        
            // 🆕 CHECK MAX ACTIVE SUBJECTS ON SUBMIT
            let activeSubjectsCount = 0;
            for (const entry of document.querySelectorAll('.subject-entry')) {
                if (entry.querySelector('.status')?.value !== 'drop') activeSubjectsCount++;
            }
            if (activeSubjectsCount > 3) {
                return showError('⚠️ You can only have a maximum of 3 active subjects. Please ensure at least one subject is dropped.');
            }

            let subIdx = 1;
            for (const entry of document.querySelectorAll('.subject-entry')) {
            if (entry.style.display === 'none' || entry.querySelector('.status')?.value === 'drop') {
                const status = entry.querySelector('.status')?.value;
                if (status === 'drop') {
                    const dropMY = entry.querySelector('.drop-month-year');
                    const dropReason = entry.querySelector('.drop-reason');
                    if (!dropMY?.value) return showError(`⚠️ Subject #${subIdx}: Drop month is required.`);
                    if (!dropReason?.value?.trim()) return showError(`⚠️ Subject #${subIdx}: Reason for Drop is required.`);
                }
                subIdx++;
                continue;
            }
            const status = entry.querySelector('.status')?.value;
            const subject = entry.querySelector('.subject-name');
            const startLevel = entry.querySelector('.start-level');
            const startWS = entry.querySelector('.start-ws');
            const enrolDate = entry.querySelector('.enrol-date');
            const inquiryDate = entry.querySelector('.inquiry-date');
            
            if (!subject?.value) return showError(`⚠️ Subject #${subIdx}: Please select a Subject.`);

            if (status === 'pause') {
                const pauseFromMY = entry.querySelector('.pause-from-month-year');
                const pauseToMY = entry.querySelector('.pause-to-month-year');
                const pauseReason = entry.querySelector('.pause-reason');
                if (!pauseFromMY?.value) return showError(`⚠️ Subject #${subIdx}: Pause From month is required.`);
                if (!pauseToMY?.value) return showError(`⚠️ Subject #${subIdx}: Pause To month is required.`);
                if (!pauseReason?.value?.trim()) return showError(`⚠️ Subject #${subIdx}: Reason for Pause is required.`);
            }

            if (status === 'drop') {
                const dropMY = entry.querySelector('.drop-month-year');
                const dropReason = entry.querySelector('.drop-reason');
                if (!dropMY?.value) return showError(`⚠️ Subject #${subIdx}: Drop month is required.`);
                if (!dropReason?.value?.trim()) return showError(`⚠️ Subject #${subIdx}: Reason for Drop is required.`);
            }

            if (status === 'inquiry') {
                if (!inquiryDate?.value) return showError(`⚠️ Subject #${subIdx}: Inquiry Date is required.`);
            } else if (status === 'current') {
                if (!enrolDate?.value) return showError(`⚠️ Subject #${subIdx}: Enrol Date is required.`);
                if (entry.querySelectorAll('.timeslots-list .timeslot-row').length === 0) return showError(`⚠️ Subject #${subIdx}: Add at least one timeslot.`);
                if (!startLevel?.value) return showError(`⚠️ Subject #${subIdx}: Please select a Start Level.`);
                if (!startWS?.value) return showError(`⚠️ Subject #${subIdx}: Please select a Start WS #.`);
            }
            subIdx++;
        }
        if (subIdx === 1) return showError('⚠️ Please add at least one subject.');
        
        let dtIdx = 1;
        for (const row of document.querySelectorAll('#dtTableBody tr')) {
            const subject = row.querySelector('.dt-subject')?.value;
            const date = row.querySelector('.dt-date')?.value;
            const test = row.querySelector('.dt-test')?.value;
            const score = row.querySelector('.dt-score')?.value;
            const time = row.querySelector('.dt-time')?.value;
            if (subject || date || test || score || time) {
                if (!subject) return showError(`⚠️ DT #${dtIdx}: Subject is required.`);
                if (!date) return showError(`⚠️ DT #${dtIdx}: Diagnostic Date is required.`);
                if (!test) return showError(`⚠️ DT #${dtIdx}: Test Name/Level is required.`);
                if (!score) return showError(`⚠️ DT #${dtIdx}: Score is required.`);
                if (!time) return showError(`⚠️ DT #${dtIdx}: Time is required.`);
            }
            dtIdx++;
        }
        
        const globalTimeslots = new Map();
        let hasConflict = false;
        for (const entry of document.querySelectorAll('.subject-entry')) {
            if (entry.querySelector('.status')?.value === 'drop') continue;
            if (entry.querySelector('.status')?.value === 'pause') continue;
            const subjectName = entry.querySelector('.subject-name')?.value || 'Unknown';
            entry.querySelectorAll('.timeslots-list .timeslot-row').forEach(row => {
                const day = row.querySelector('.ts-day')?.value, hour = row.querySelector('.ts-hour')?.value, min = row.querySelector('.ts-min')?.value;
                if (day && hour && min) {
                    const key = `${day}-${hour}:${min}`;
                    if (globalTimeslots.has(key)) {
                        showError(`⚠️ Timeslot conflict: ${subjectName} & ${globalTimeslots.get(key)} on ${day} at ${hour}:${min}`);
                        hasConflict = true;
                    } else {
                        globalTimeslots.set(key, subjectName);
                    }
                }
            });
            if (hasConflict) return;
        }
        
        const currentFormData = collectFormData();
        for (const sub of currentFormData.subjects) {
            if (sub.pencilSkill && !sub.pencilSkill.ws) return showError('⚠️ Please select a Pencil Start WS.');
        }
        if (isEdit && JSON.stringify(currentFormData) === JSON.stringify(originalFormData)) return showError('ℹ️ No changes made.');
        
        const studentData = { ...currentFormData, updatedAt: new Date().toISOString() };
        if (isEdit) {
            const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
            if (snap.exists()) {
                const existingData = snap.val();
                const oldSubjects = Array.isArray(existingData.subjects) ? existingData.subjects : Object.values(existingData.subjects || {});
                studentData.subjects = studentData.subjects.map(newSub => {
                    const oldSub = oldSubjects.find(s => s.name === newSub.name);
                    if (oldSub) {
                        if (Array.isArray(oldSub.progress)) newSub.progress = oldSub.progress;
                        if (!newSub.pendingRequest && oldSub.pendingRequest) {
                            newSub.pendingRequest = oldSub.pendingRequest;
                        }
                    }
                    return newSub;
                });
                if (existingData.poNote) studentData.poNote = existingData.poNote;
            }
        }
        
        try {
            showLoader();
            if (isEdit) await set(ref(db, `centers/${centerId}/students/${studentId}`), studentData);
            else await push(ref(db, `centers/${centerId}/students`), studentData);
            alert(isEdit ? '✅ Updated!' : '✅ Added!');
            window.location.href = 'students.html';
        } catch (err) {
            showError('Error saving: ' + err.message);
        } finally {
            hideLoader();
        }
    });

    document.getElementById('cancelBtn')?.addEventListener('click', () => { if (confirm('Discard changes?')) window.location.href = 'students.html'; });
    document.getElementById('backToStudents')?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!originalFormData) { window.location.href = 'students.html'; return; }
        if (JSON.stringify(collectFormData()) !== JSON.stringify(originalFormData)) {
            if (confirm('You have unsaved changes. Are you sure you want to leave?')) window.location.href = 'students.html';
        } else {
            window.location.href = 'students.html';
        }
    });

    function initParentOrientation() {
        const poSelect = document.getElementById('parentOrientation');
        if (!poSelect) return;
        const dateWrapper = document.getElementById('poDateWrapper');
        const reasonWrapper = document.getElementById('poReasonWrapper');
        const dateInput = document.getElementById('poDate');
        const reasonInput = document.getElementById('poReason');
        function togglePOFields() {
            const val = poSelect.value;
            if (val === 'Yes') {
                if (dateWrapper) dateWrapper.classList.add('visible');
                if (reasonWrapper) reasonWrapper.classList.remove('visible');
                if (dateInput) { dateInput.required = true; }
                if (reasonInput) { reasonInput.required = false; reasonInput.value = ''; }
            } else if (val === 'No') {
                if (dateWrapper) dateWrapper.classList.remove('visible');
                if (reasonWrapper) reasonWrapper.classList.add('visible');
                if (dateInput) { dateInput.required = false; dateInput.value = ''; }
                if (reasonInput) { reasonInput.required = true; }
            } else {
                if (dateWrapper) dateWrapper.classList.remove('visible');
                if (reasonWrapper) reasonWrapper.classList.remove('visible');
                if (dateInput) dateInput.required = false;
                if (reasonInput) reasonInput.required = false;
            }
        }
        poSelect.addEventListener('change', togglePOFields);
        return togglePOFields;
    }

    const togglePO = initParentOrientation();
    initOtherInputs();

    const prModal = document.getElementById('dropPauseRequestModal');
    const prTypeSelect = document.getElementById('prType');
    
    prTypeSelect?.addEventListener('change', () => {
        if (prTypeSelect.value === 'pause') {
            document.getElementById('prPauseFields').style.display = 'block';
            document.getElementById('prDropFields').style.display = 'none';
        } else {
            document.getElementById('prPauseFields').style.display = 'none';
            document.getElementById('prDropFields').style.display = 'block';
        }
    });

    document.getElementById('closeDropPauseModal')?.addEventListener('click', () => prModal.classList.add('hidden'));
    document.getElementById('cancelDropPauseBtn')?.addEventListener('click', () => prModal.classList.add('hidden'));

    document.getElementById('saveDropPauseBtn')?.addEventListener('click', () => {
        if (!activePREntry) return;
        const type = prTypeSelect.value;
        const reason = document.getElementById('prReason').value.trim();
        if (!reason) return showError('⚠️ Reason is required.');
        
        activePREntry.querySelector('.pr-cancelled').value = 'false'; 
        activePREntry.querySelector('.pr-type').value = type;
        activePREntry.querySelector('.pr-reason').value = reason;
        
        if (type === 'pause') {
            const fm = document.getElementById('prPauseFromMonthYear').value;
            const tm = document.getElementById('prPauseToMonthYear').value;
            if (!fm || !tm) return showError('⚠️ Please select Pause From and To dates.');
            activePREntry.querySelector('.pr-pause-from-month-year').value = fm;
            activePREntry.querySelector('.pr-pause-to-month-year').value = tm;
            activePREntry.querySelector('.pr-drop-month-year').value = '';
        } else {
            const dm = document.getElementById('prDropMonthYear').value;
            if (!dm) return showError('⚠️ Please select Drop Month.');
            activePREntry.querySelector('.pr-drop-month-year').value = dm;
            activePREntry.querySelector('.pr-pause-from-month-year').value = '';
            activePREntry.querySelector('.pr-pause-to-month-year').value = '';
        }
        updatePRBanner(activePREntry);
        prModal.classList.add('hidden');
    });

    // ==========================================
    // 👩‍🏫 TEACHERS TAB LOGIC
    // ==========================================
    const SUBJECT_TO_POSITION = {
        'Math': 'Math Teacher',
        'Chinese (Trad)': 'Chinese Teacher',
        'Chinese (Simp)': 'Chinese Teacher',
        'English ERP': 'English Teacher',
        'English EFL': 'English Teacher'
    };

    let allTeachersCache = [];

        // ==========================================
    // 🔍 DUPLICATE STUDENT CHECK (Debounced)
    // ==========================================
    let duplicateCheckTimeout = null;

    function getSubjectColorClass(subjectName) {
        if (!subjectName) return '';
        if (subjectName === 'Math') return 'subj-Math';
        if (subjectName.includes('Chinese')) return 'subj-Chinese';
        if (subjectName.includes('ERP')) return 'subj-ERP';
        if (subjectName.includes('EFL')) return 'subj-EFL';
        return '';
    }

    function setupDuplicateCheck() {
        const nameCnInput = document.getElementById('nameCn');
        const namePinyinInput = document.getElementById('namePinyin');

        const handleInput = (e) => {
            const value = e.target.value.trim();
            const field = e.target.id; // 'nameCn' or 'namePinyin'

            if (duplicateCheckTimeout) clearTimeout(duplicateCheckTimeout);

            if (value.length < 2) return; // Need at least 2 chars

            duplicateCheckTimeout = setTimeout(() => {
                checkForDuplicateStudent(field, value);
            }, 1000);
        };

        if (nameCnInput) nameCnInput.addEventListener('input', handleInput);
        if (namePinyinInput) namePinyinInput.addEventListener('input', handleInput);
    }

    async function checkForDuplicateStudent(field, value) {
        try {
            const snap = await get(ref(db, `centers/${centerId}/students`));
            if (!snap.exists()) return;

            const matches = [];
            snap.forEach(child => {
                const data = child.val();
                const id = child.key;

                // Skip the student currently being edited
                if (isEdit && id === studentId) return;

                let isMatch = false;
                if (field === 'nameCn') {
                    isMatch = data.nameCn && data.nameCn.trim() === value;
                } else if (field === 'namePinyin') {
                    isMatch = data.namePinyin &&
                            data.namePinyin.trim().toLowerCase() === value.toLowerCase();
                }

                if (isMatch) {
                    matches.push({
                        id,
                        nameCn: data.nameCn || '',
                        namePinyin: data.namePinyin || '',
                        grade: data.grade || '',
                        subjects: data.subjects || []
                    });
                }
            });

            if (matches.length > 0) {
                showDuplicateModal(matches);
            }
        } catch (err) {
            console.error('Duplicate check error:', err);
        }
    }

    function showDuplicateModal(matches) {
        const modal = document.getElementById('duplicateStudentModal');
        const listContainer = document.getElementById('duplicateStudentList');
        if (!modal || !listContainer) return;

        listContainer.innerHTML = '';

        matches.forEach(student => {
            const card = document.createElement('div');
            card.className = 'duplicate-student-card';

            const subjects = Array.isArray(student.subjects)
                ? student.subjects
                : Object.values(student.subjects || {});

            const activeSubjects = subjects.filter(s => s.status && s.status !== 'drop');
            const subjectsHtml = activeSubjects.length > 0
                ? activeSubjects.map(s =>
                    `<span class="subj-pill ${getSubjectColorClass(s.name)}">${s.name} <small>(${s.status})</small></span>`
                ).join('')
                : '<span style="color:#999; font-size:0.8rem;">No active subjects</span>';

            card.innerHTML = `
                <div class="duplicate-student-info">
                    <div class="duplicate-name-cn">${student.nameCn || 'N/A'}</div>
                    <div class="duplicate-name-pinyin">${student.namePinyin || ''}</div>
                    <div class="duplicate-grade"><strong>Grade:</strong> ${student.grade || 'N/A'}</div>
                    <div class="duplicate-subjects">${subjectsHtml}</div>
                </div>
                <button type="button" class="edit-existing-btn primary" data-id="${student.id}">✏️ Edit Existing</button>
            `;

            listContainer.appendChild(card);
        });

        // Wire up "Edit Existing" buttons
        listContainer.querySelectorAll('.edit-existing-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                hideDuplicateModal();
                navigateToStudentById(id);
            });
        });

        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }

    function hideDuplicateModal() {
        const modal = document.getElementById('duplicateStudentModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.style.display = 'none';
        }
    }

    // Modal close handlers
    document.getElementById('closeDuplicateModal')?.addEventListener('click', hideDuplicateModal);
    document.getElementById('addAnywayBtn')?.addEventListener('click', hideDuplicateModal);
    document.getElementById('duplicateStudentModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'duplicateStudentModal') hideDuplicateModal();
    });

    // Kick it off
    setupDuplicateCheck();

    async function fetchTeachers() {
        try {
            const snap = await get(ref(db, 'employees'));
            if (snap.exists()) {
                allTeachersCache = Object.entries(snap.val()).map(([uid, data]) => ({
                    uid,
                    name: data.englishName || data.chineseName || 'Unknown',
                    positions: data.positions || (data.position ? [data.position] : []),
                    isDisabled: data.isDisabled
                })).filter(t => !t.isDisabled); 
            }
        } catch (err) {
            console.error("Error fetching teachers:", err);
        }
    }

    function setupTeachersTab() {
        const tabsContainer = document.querySelector('.tabs');
        if (tabsContainer && !document.getElementById('tab-teachers-btn')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tab-btn';
            btn.dataset.tab = 'teachers';
            btn.id = 'tab-teachers-btn';
            btn.textContent = '👩‍ Teachers';
            tabsContainer.appendChild(btn);

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('tab-teachers').classList.add('active');
            });
        }

        const formContainer = document.querySelector('.form-container');
        if (formContainer && !document.getElementById('tab-teachers')) {
            const contentDiv = document.createElement('div');
            contentDiv.id = 'tab-teachers';
            contentDiv.className = 'tab-content';
            contentDiv.innerHTML = `
                <h3 style="color: var(--primary-dark); margin-bottom: 1rem;">Assign Teachers</h3>
                <p class="hint" style="margin-bottom: 1rem;">Tick the boxes to assign teachers to this student based on their enrolled subjects.</p>
                <div id="teachers-list-container" style="display: flex; flex-direction: column; gap: 1.5rem;"></div>
            `;
            
            const actionButtons = document.querySelector('.form-actions') || 
                                  document.querySelector('button[type="submit"]')?.parentElement ||
                                  document.getElementById('studentForm');
            
            if (actionButtons) {
                actionButtons.parentNode.insertBefore(contentDiv, actionButtons);
            } else {
                formContainer.appendChild(contentDiv);
            }
        }
    }

    function renderTeachersTab() {
        const container = document.getElementById('teachers-list-container');
        if (!container) return;
        container.innerHTML = '';

        const currentSubjects = new Set();
        document.querySelectorAll('.subject-entry').forEach(entry => {
            const subj = entry.querySelector('.subject-name')?.value;
            const status = entry.querySelector('.status')?.value;
            if (subj && status !== 'drop') currentSubjects.add(subj);
        });

        if (currentSubjects.size === 0) {
            container.innerHTML = '<p class="hint">Add subjects in the "Subjects" tab to assign teachers.</p>';
            return;
        }

        const assignedTeachers = currentStudentData?.assignedTeachers || {};

        currentSubjects.forEach(subj => {
            const reqPosition = SUBJECT_TO_POSITION[subj];
            if (!reqPosition) return;

            const teachersForSubj = allTeachersCache.filter(t => t.positions.includes(reqPosition));

            const section = document.createElement('div');
            section.innerHTML = `<h4>${subj}</h4>`;

            if (teachersForSubj.length === 0) {
                section.innerHTML += '<p class="hint" style="margin:0;">No active teachers found for this subject.</p>';
            } else {
                const grid = document.createElement('div');
                grid.className = 'teacher-grid';

                teachersForSubj.forEach(t => {
                    const isChecked = assignedTeachers[subj]?.includes(t.uid);
                    const label = document.createElement('label');
                    label.className = `teacher-checkbox-label ${isChecked ? 'checked' : ''}`;

                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = isChecked;
                    checkbox.dataset.subject = subj;
                    checkbox.dataset.uid = t.uid;
                    checkbox.className = 'teacher-checkbox';
                    
                    checkbox.addEventListener('change', () => {
                        label.classList.toggle('checked', checkbox.checked);
                    });

                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'teacher-name';
                    nameSpan.textContent = t.name;

                    label.appendChild(checkbox);
                    label.appendChild(nameSpan);
                    grid.appendChild(label);
                });
                section.appendChild(grid);
            }
            container.appendChild(section);
        });
    }   

    setupTeachersTab();
    fetchTeachers().then(() => {
        if (isEdit) loadStudentData(); 
        else { 
            addSubjectField(); 
            renderTeachersTab(); 
            hideLoader(); 
        }
    });
         
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
}