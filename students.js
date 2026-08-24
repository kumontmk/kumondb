import { auth, db, logout, syncPendingRequests } from './auth.js';
import { ref, get, push, remove, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t } from './students-i18n.js';

await i18nReady.catch(() => {});

const REQUIRED_PERMISSION = 'studentManagement';

// ==========================================
// 🔐 PERMISSION CHECK
// ==========================================
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
            initializePage(isAdmin);
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
// 📄 MAIN APP LOGIC (Only runs if authorized)
// ==========================================
async function initializePage(isAdmin = false) {
    const centerId = sessionStorage.getItem('selectedCenter');
    await syncPendingRequests(centerId);
    const studentsRef = ref(db, `centers/${centerId}/students`);

    if (isAdmin) {
        document.getElementById('deleteAllBtn')?.classList.remove('hidden');
    }

    // ==========================================
    // 📊 PAGINATION CONFIGURATION
    // ==========================================
    let currentPage = 1;
    const ITEMS_PER_PAGE = 100;
    let allStudentsData = [];
    let filteredStudentsData = [];

    // ==========================================
    // 📥 EXCEL IMPORT CONFIGURATION & LOGIC
    // ==========================================
    const COLUMN_MAP_LOWER = {
        'studentno': 'studentNumber', 'family name': 'familyName', 'first name': 'firstName',
        'chinese name': 'nameCn', 'nickname': 'nickname', 'schoolgrade': 'grade',
        'schoolname': 'school', 'dateofbirth': 'birthday', 'nationality': 'nationality',
        'email': 'email', 'phone (emergency_m)': 'phoneMom', 'phone (emergency_d)': 'phoneDad',
        'phone (emergency_self)': 'phoneOwn', 'ship address': 'address',
        'maths': 'mathBool', 'mstarting': 'mathStartLevel', 'mstartingno': 'mathStartWS',
        'menrollmentdate': 'mathEnrolDate', 'mclassday': 'mathDay1', 'mclasstime': 'mathTime1',
        'mclassday2': 'mathDay2', 'mclasstime2': 'mathTime2', 'currentmath': 'mathCurrentLevel', 'mathno': 'mathCurrentWS',
        'english': 'engBool', 'estarting': 'engStartLevel', 'estartingno': 'engStartWS',
        'eenrollmentdate': 'engEnrolDate', 'eclassday': 'engDay1', 'ecclasstime': 'engTime1',
        'eclassday2': 'engDay2', 'ecclasstime2': 'engTime2', 'currenteng': 'engCurrentLevel', 'engno': 'engCurrentWS',
        'efl': 'eflBool', 'eflstarting': 'eflStartLevel', 'eflstartingno': 'eflStartWS',
        'eflenrollmentdate': 'eflEnrolDate', 'eflclassday': 'eflDay1', 'eflclasstime': 'eflTime1',
        'eflclassday2': 'eflDay2', 'eflclasstime2': 'eflTime2', 'currentefl': 'eflCurrentLevel', 'eflno': 'eflCurrentWS',
        'chinese': 'chiBool',
        'chinese_simp': 'chiSimpBool', 'chinese (simp)': 'chiSimpBool', 'chinese simp': 'chiSimpBool',
        'cstarting': 'chiStartLevel', 'cstartingno': 'chiStartWS',
        'cenrollmentdate': 'chiEnrolDate', 'cclassday': 'chiDay1', 'cclasstime': 'chiTime1',
        'cclassday2': 'chiDay2', 'cclasstime2': 'chiTime2', 'currentchinese': 'chiCurrentLevel', 'chino': 'chiCurrentWS'
    };

    function parseExcelDate(val) {
        if (!val) return '';
        if (val instanceof Date) return !isNaN(val) ? val.toISOString().split('T')[0] : '';
        const str = String(val).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
        const parsed = new Date(str);
        return !isNaN(parsed) ? parsed.toISOString().split('T')[0] : str;
    }

    function parseExcelTime(val) {
        if (!val) return '';
        if (typeof val === 'number') {
            const totalMin = Math.round(val * 24 * 60);
            const h = Math.floor(totalMin / 60) % 24;
            const m = totalMin % 60;
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
        let str = String(val).trim().toUpperCase();
        const amPmMatch = str.match(/(AM|PM)/i);
        if (amPmMatch) {
            const [time, mod] = str.split(amPmMatch[0]);
            let [h, m] = time.replace(/[^0-9:]/g, '').split(':');
            h = parseInt(h, 10) || 0;
            if (mod === 'PM' && h < 12) h += 12;
            if (mod === 'AM' && h === 12) h = 0;
            return `${String(h).padStart(2, '0')}:${(m || '00').padStart(2, '0')}`;
        }
        const parts = str.split(':');
        if (parts.length >= 2) return `${String(parts[0]).padStart(2, '0')}:${String(parts[1]).padStart(2, '0')}`;
        return str;
    }

    function isSubjectEnabled(val) {
        if (val === undefined || val === null || val === '') return false;
        const v = String(val).trim().toLowerCase();
        return v === 'true' || v === '1' || v === 'yes';
    }

    function buildSubject(getVal, prefix, name) {
        const boolKey = `${prefix}Bool`;
        if (!isSubjectEnabled(getVal(boolKey))) return null;
        const timeslots = [];
        const d1 = getVal(`${prefix}Day1`);
        const t1 = parseExcelTime(getVal(`${prefix}Time1`));
        if (d1 && t1) timeslots.push({ day: String(d1).trim(), time: t1 });
        const d2 = getVal(`${prefix}Day2`);
        const t2 = parseExcelTime(getVal(`${prefix}Time2`));
        if (d2 && t2) timeslots.push({ day: String(d2).trim(), time: t2 });
        return {
            name,
            startLevel: String(getVal(`${prefix}StartLevel`) || '').trim(),
            startWS: parseInt(getVal(`${prefix}StartWS`)) || 0,
            enrolDate: parseExcelDate(getVal(`${prefix}EnrolDate`)),
            currentLevel: String(getVal(`${prefix}CurrentLevel`) || '').trim(),
            currentWS: parseInt(getVal(`${prefix}CurrentWS`)) || 0,
            timeslots,
            status: 'current',
            progress: []
        };
    }

    async function handleExcelImport(file) {
        const modal = document.getElementById('importProgressModal');
        const status = document.getElementById('importStatus');
        const progress = document.getElementById('importProgressBar');
        const closeBtn = document.getElementById('closeImportModal');
        modal?.classList.remove('hidden');
        closeBtn?.classList.add('hidden');
        if (status) status.textContent = t('students.readingFile');
        if (progress) progress.value = 0;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { cellDates: true, cellNF: true });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
                if (!rawRows || rawRows.length === 0) throw new Error(t('students.emptyFile'));

                let headerRowIndex = -1;
                for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
                    const rowStr = (rawRows[i] || []).map(c => String(c || '').trim().toLowerCase()).join(' ');
                    if (rowStr.includes('studentno') || rowStr.includes('student number')) {
                        headerRowIndex = i;
                        break;
                    }
                }
                if (headerRowIndex === -1) throw new Error(t('students.noHeaderRow'));

                const headers = rawRows[headerRowIndex].map(h => String(h || '').trim().toLowerCase());
                const colIndexMap = {};
                headers.forEach((h, idx) => {
                    if (COLUMN_MAP_LOWER[h]) colIndexMap[COLUMN_MAP_LOWER[h]] = idx;
                });

                const dataRows = rawRows.slice(headerRowIndex + 1);
                let success = 0, skipped = 0;
                if (status) status.textContent = t('students.foundRows', { count: dataRows.length });

                for (let i = 0; i < dataRows.length; i++) {
                    const row = dataRows[i];
                    if (!row || row.every(cell => cell === null || cell === undefined || String(cell).trim() === '')) continue;
                    const getVal = (key) => {
                        const idx = colIndexMap[key];
                        if (idx === undefined || row[idx] === null || row[idx] === undefined) return '';
                        return typeof row[idx] === 'string' ? row[idx].trim() : row[idx];
                    };
                    const studentNo = String(getVal('studentNumber') || '').trim();
                    if (!studentNo || studentNo === '0') { skipped++; continue; }
                    const family = getVal('familyName');
                    const first = getVal('firstName');
                    const namePinyin = (family && first) ? `${family} ${first}` : (family || first || '');
                    const subjects = [];
                    const mathSubj = buildSubject(getVal, 'math', 'Math');
                    if (mathSubj) subjects.push(mathSubj);
                    const engSubj = buildSubject(getVal, 'eng', 'English ERP');
                    if (engSubj) subjects.push(engSubj);
                    const eflSubj = buildSubject(getVal, 'efl', 'English EFL');
                    if (eflSubj) subjects.push(eflSubj);
                    const chiSubj = buildSubject(getVal, 'chi', 'Chinese (Trad)');
                    if (chiSubj) subjects.push(chiSubj);
                    const chiSimpSubj = buildSubject(getVal, 'chiSimp', 'Chinese (Simp)');
                    if (chiSimpSubj) subjects.push(chiSimpSubj);
                    const overallStatus = subjects.length === 0 ? 'Drop' : 'Current';
                    const studentData = {
                        studentNumber: studentNo,
                        namePinyin,
                        nickname: getVal('nickname'),
                        nameCn: getVal('nameCn'),
                        grade: getVal('grade'),
                        school: getVal('school'),
                        birthday: parseExcelDate(getVal('birthday')),
                        nationality: getVal('nationality'),
                        email: getVal('email'),
                        phone: { mom: getVal('phoneMom'), dad: getVal('phoneDad'), own: getVal('phoneOwn') },
                        address: getVal('address'),
                        subjects,
                        overallStatus,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                    await push(studentsRef, studentData);
                    success++;
                    if (progress) progress.value = Math.round(((i + 1) / dataRows.length) * 100);
                }
                if (status) status.textContent = t('students.importDone', { success, skipped });
                closeBtn?.classList.remove('hidden');
            } catch (err) {
                console.error('❌ Import error:', err);
                if (status) status.textContent = t('students.importError', { message: err.message });
            }
        };
        reader.onerror = () => { if (status) status.textContent = t('students.failedReadFile'); };
        reader.readAsArrayBuffer(file);
    }

    // ==========================================
    // 📋 STUDENT LIST & PAGINATION LOGIC
    // ==========================================
    async function loadStudents(searchTerm = '') {
        const loader = document.getElementById('page-loader');
        const tbody = document.getElementById('studentList');
        loader?.classList.remove('hidden');
        tbody.innerHTML = `<tr><td colspan="10" class="hint" style="text-align:center;">${t('students.loading')}</td></tr>`;
        try {
            const snapshot = await get(studentsRef);
            if (!snapshot.exists()) {
                tbody.innerHTML = `<tr><td colspan="10" class="hint" style="text-align:center; padding:1rem;">${t('students.noStudentsFound')}</td></tr>`;
                allStudentsData = [];
                filteredStudentsData = [];
                currentPage = 1;
                renderPagination();
                return;
            }
            const allRows = [];
            snapshot.forEach(child => {
                const student = child.val();
                const id = child.key;
                let overallStatus = student.overallStatus;
                if (student.subjects && Array.isArray(student.subjects) && student.subjects.length > 0) {
                    const hasCurrent = student.subjects.some(sub => sub.status === 'current');
                    const hasInquiry = student.subjects.some(sub => sub.status === 'inquiry');
                    const allDrop = student.subjects.every(sub => sub.status === 'drop');
                    const allFinished = student.subjects.every(sub => sub.status === 'drop' || sub.status === 'completer');
                    const hasCompleter = student.subjects.some(sub => sub.status === 'completer');
                    
                    if (hasCurrent) overallStatus = 'Current';
                    else if (hasInquiry) overallStatus = 'Inquiry';
                    else if (allDrop) overallStatus = 'Drop';
                    else if (allFinished && hasCompleter) overallStatus = 'Completer';
                    else overallStatus = 'Pause';
                }
                if (student.subjects && Array.isArray(student.subjects)) {
                    student.subjects.forEach(sub => {
                        allRows.push({
                            ...student, id,
                            subjectName: sub.name || '-',
                            level: sub.currentLevel || sub.startLevel || '-',
                            enrolDate: sub.enrolDate || '-',
                            subjectStatus: sub.status || overallStatus,
                            overallStatus,
                            rawDob: student.birthday || '',
                            rawEnrolDate: sub.enrolDate || '',
                            worksheetType: sub.worksheetType || student.worksheetType || 'Paper'
                        });
                    });
                } else {
                    allRows.push({
                        ...student, id,
                        subjectName: '-', level: '-', enrolDate: '-',
                        subjectStatus: overallStatus,
                        overallStatus: overallStatus,
                        rawDob: student.birthday || '',
                        rawEnrolDate: '',
                        worksheetType: student.worksheetType || 'Paper'
                    });
                }
            });
            allStudentsData = allRows;
            const statusFilter = document.getElementById('filter-status')?.value || 'current';
            let filtered = statusFilter === 'all'
                ? allRows
                : allRows.filter(r => (r.subjectStatus || 'current').toLowerCase() === statusFilter);
            const subjectFilter = document.getElementById('filter-subject')?.value || '';
            if (subjectFilter) filtered = filtered.filter(r => r.subjectName === subjectFilter);
            if (searchTerm) {
                const term = searchTerm.trim().toLowerCase();
                filtered = filtered.filter(row => {
                    const nameCn = (row.nameCn || '').toLowerCase();
                    const nickname = (row.nickname || '').toLowerCase();
                    const namePinyin = (row.namePinyin || '').toLowerCase();
                    const studentNumber = (row.studentNumber || '').toLowerCase();
                    const grade = (row.grade || '').toLowerCase();
                    const school = (row.school || '').toLowerCase();
                    const subjectName = (row.subjectName || '').toLowerCase();
                    return nameCn.includes(term) ||
                        nickname.includes(term) ||
                        namePinyin.includes(term) ||
                        studentNumber.includes(term) ||
                        grade.includes(term) ||
                        school.includes(term) ||
                        subjectName.includes(term);
                });
            }
            const sortRules = getSortRules();
            const sorted = applyMultiSort(filtered, sortRules);
            filteredStudentsData = sorted;
            if (currentPage !== 1) {
                currentPage = 1;
            }
            renderStudentPage(tbody, sorted);
            renderPagination();
        } catch (error) {
            console.error('Error loading students:', error);
            tbody.innerHTML = `<tr><td colspan="10" class="error">${t('students.errorPrefix', { message: error.message })}</td></tr>`;
        } finally {
            if (loader) setTimeout(() => loader.classList.add('hidden'), 300);
        }
    }

    function renderStudentPage(tbody, allData) {
        const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
        const endIndex = startIndex + ITEMS_PER_PAGE;
        const pageData = allData.slice(startIndex, endIndex);
        tbody.innerHTML = '';
        if (pageData.length === 0) {
            tbody.innerHTML = `<tr><td colspan="10" class="hint" style="text-align:center; padding:1rem;">${t('students.noMatchingStudents')}</td></tr>`;
        } else {
            pageData.forEach(row => {
                const dobDisplay = row.rawDob ? new Date(row.rawDob).toLocaleDateString('en-CA') : '-';
                const enrolDisplay = row.rawEnrolDate ? new Date(row.rawEnrolDate).toLocaleDateString('en-CA') : '-';
                const isKC = row.worksheetType === 'Kumon Connect';
                const kcBadge = isKC ? '<span class="kc-badge" title="Kumon Connect">KC</span>' : '';
                const status = row.subjectStatus || 'Current';
                const statusClass = 'status-' + String(status).toLowerCase();
                const tr = document.createElement('tr');
                tr.className = 'student-row';
                tr.innerHTML = `
                    <td data-label="Name" class="cell-name">${row.namePinyin || '-'}</td>
                    <td data-label="Chinese" class="cell-name-cn">${row.nameCn || '-'}</td>
                    <td data-label="Status"><span class="status-pill ${statusClass}">${status}</span></td>
                    <td data-label="Subject"><span class="subject-chip">${row.subjectName}</span>${kcBadge}</td>
                    <td data-label="Level"><span class="level-badge">${row.level}</span></td>
                    <td data-label="ID">${row.studentNumber || '-'}</td>
                    <td data-label="Grade">${row.grade || '-'}</td>
                    <td data-label="DOB">${dobDisplay}</td>
                    <td data-label="Enrol">${enrolDisplay}</td>
                    <td class="actions-cell"><button class="secondary" onclick="window.location.href='student-form.html?id=${row.id}'">✏️</button></td>
                `;
                tr.style.cursor = 'pointer';
                tr.onclick = (e) => {
                    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
                    window.location.href = `student-form.html?id=${row.id}`;
                };
                tbody.appendChild(tr);
            });
        }
    }

    function renderPagination() {
        const totalPages = Math.ceil(filteredStudentsData.length / ITEMS_PER_PAGE);
        const paginationInfo = document.getElementById('paginationInfo');
        const firstPageBtn = document.getElementById('firstPage');
        const prevPageBtn = document.getElementById('prevPage');
        const nextPageBtn = document.getElementById('nextPage');
        const lastPageBtn = document.getElementById('lastPage');
        const paginationNumbers = document.getElementById('paginationNumbers');
        if (!paginationInfo) return;
        if (filteredStudentsData.length === 0) {
            paginationInfo.textContent = t('students.zeroItems');
        } else {
            const startIndex = (currentPage - 1) * ITEMS_PER_PAGE + 1;
            const endIndex = Math.min(currentPage * ITEMS_PER_PAGE, filteredStudentsData.length);
            paginationInfo.textContent = t('students.itemsOf', { start: startIndex, end: endIndex, total: filteredStudentsData.length });
        }
        if (firstPageBtn) firstPageBtn.disabled = currentPage === 1;
        if (prevPageBtn) prevPageBtn.disabled = currentPage === 1;
        if (nextPageBtn) nextPageBtn.disabled = currentPage >= totalPages;
        if (lastPageBtn) lastPageBtn.disabled = currentPage >= totalPages;
        if (paginationNumbers) {
            paginationNumbers.innerHTML = '';
            if (totalPages <= 10) {
                for (let i = 1; i <= totalPages; i++) {
                    addPageNumberButton(paginationNumbers, i);
                }
            } else {
                let startPage = Math.max(1, currentPage - 2);
                let endPage = Math.min(totalPages, startPage + 4);
                if (endPage - startPage < 4) {
                    startPage = Math.max(1, endPage - 4);
                }
                for (let i = startPage; i <= endPage; i++) {
                    addPageNumberButton(paginationNumbers, i);
                }
            }
        }
    }

    function addPageNumberButton(container, pageNum) {
        const btn = document.createElement('button');
        btn.className = `pagination-btn page-number ${pageNum === currentPage ? 'active' : ''}`;
        btn.textContent = pageNum;
        btn.onclick = () => goToPage(pageNum);
        container.appendChild(btn);
    }

    function goToPage(page) {
        const totalPages = Math.ceil(filteredStudentsData.length / ITEMS_PER_PAGE);
        if (page < 1 || page > totalPages || page === currentPage) return;
        currentPage = page;
        const tbody = document.getElementById('studentList');
        renderStudentPage(tbody, filteredStudentsData);
        renderPagination();
        const tableWrapper = document.querySelector('.table-wrapper');
        if (tableWrapper) {
            tableWrapper.scrollTop = 0;
        }
    }

    function getSortRules() {
        const rules = [];
        for (let i = 1; i <= 2; i++) {
            const field = document.getElementById(`sort${i}-field`)?.value;
            const dir = document.getElementById(`sort${i}-dir`)?.value || 'asc';
            if (field) rules.push({ field, direction: dir });
        }
        if (rules.length === 0) {
            return [
                { field: 'namePinyin', direction: 'asc' },
                { field: 'subjectName', direction: 'asc' },
                { field: 'studentNumber', direction: 'asc' },
                { field: 'nameCn', direction: 'asc' },
                { field: 'rawDob', direction: 'asc' },
                { field: 'grade', direction: 'asc' },
                { field: 'level', direction: 'asc' },
                { field: 'rawEnrolDate', direction: 'asc' }
            ];
        }
        return rules;
    }

    function applyMultiSort(rows, rules) {
        if (rules.length === 0) return rows;
        return rows.sort((a, b) => {
            for (const rule of rules) {
                let valA = a[rule.field] !== undefined ? a[rule.field] : '';
                let valB = b[rule.field] !== undefined ? b[rule.field] : '';
                if (rule.field === 'rawDob') { valA = a.rawDob || ''; valB = b.rawDob || ''; }
                if (rule.field === 'rawEnrolDate') { valA = a.rawEnrolDate || ''; valB = b.rawEnrolDate || ''; }
                if (!valA && valB) return 1;
                if (valA && !valB) return -1;
                if (!valA && !valB) continue;
                const strA = typeof valA === 'string' ? valA.toLowerCase() : valA;
                const strB = typeof valB === 'string' ? valB.toLowerCase() : valB;
                if (strA < strB) return rule.direction === 'asc' ? -1 : 1;
                if (strA > strB) return rule.direction === 'asc' ? 1 : -1;
            }
            return 0;
        });
    }

// ==========================================
// 📤 EXCEL EXPORT LOGIC
// ==========================================
async function fetchAllStudents() {
    const loader = document.getElementById('page-loader');
    loader?.classList.remove('hidden');
    try {
        const snapshot = await get(studentsRef);
        if (!snapshot.exists()) return [];
        const students = [];
        snapshot.forEach(child => {
            students.push({ id: child.key, ...child.val() });
        });
        return students;
    } catch (err) {
        console.error("❌ Fetch failed: ", err);
        alert(t('students.failedFetch'));
        return [];
    } finally {
        loader?.classList.add('hidden');
    }
}

// 🆕 Helper function to map Teacher UIDs to Names
async function getTeachersMap() {
    try {
        const empSnap = await get(ref(db, 'employees'));
        if (empSnap.exists()) {
            const emps = empSnap.val();
            const map = {};
            Object.entries(emps).forEach(([uid, emp]) => {
                // Fallback to UID if no name is found
                map[uid] = emp.englishName || emp.chineseName || 'Unknown'; 
            });
            return map;
        }
    } catch (err) {
        console.error("Error fetching teachers for export:", err);
    }
    return {};
}

// 🔄 Updated Export Function
async function exportFilteredStudents(filterFn, filenameSuffix) {
    const students = await fetchAllStudents();
    if (students.length === 0) {
        alert(t('students.noStudentsExport'));
        return;
    }
    const filtered = students.filter(filterFn);
    if (filtered.length === 0) {
        alert(t('students.noMatchExport'));
        return;
    }

    // Fetch teacher names mapping
    const teachersMap = await getTeachersMap();

    const rows = filtered.map(s => {
        const subs = s.subjects || [];
        const getSubj = (name) => subs.find(sub => sub.name === name) || {};
        const math = getSubj('Math');
        const eng = getSubj('English ERP');
        const efl = getSubj('English EFL');
        const chi = getSubj('Chinese (Trad)');
        const chiSimp = getSubj('Chinese (Simp)');

        // 🆕 Build the Teachers string
        let teachersStr = '';
        if (s.assignedTeachers && typeof s.assignedTeachers === 'object') {
            const teacherNames = new Set();
            Object.values(s.assignedTeachers).forEach(uids => {
                if (Array.isArray(uids)) {
                    uids.forEach(uid => {
                        if (teachersMap[uid]) teacherNames.add(teachersMap[uid]);
                    });
                }
            });
            // Join unique teacher names with a comma
            teachersStr = Array.from(teacherNames).join(', ');
        }

        return {
            'StudentNo': s.studentNumber || '',
            'Chinese Name (Alphabet)': s.namePinyin || '',
            'Chinese Name': s.nameCn || '',
            'Nickname': s.nickname || '',
            'SchoolGrade': s.grade || '',
            'SchoolName': s.school || '',
            'DateOfBirth': s.birthday || '',
            'Nationality': s.nationality || '',
            'Email': s.email || '',
            'Phone (Emergency_M)': s.phone?.mom || '',
            'Phone (Emergency_D)': s.phone?.dad || '',
            'Phone (Emergency_Self)': s.phone?.own || '',
            'Ship Address': s.address || '',
            'Overall Status': s.overallStatus || 'Current',
            'Teachers': teachersStr, // 🆕 Added Teachers Column
            'Maths': math.name ? '1' : '',
            'MStarting': math.startLevel || '',
            'MStartingNo': math.startWS || '',
            'MEnrollmentDate': math.enrolDate || '',
            'MClassDay': math.timeslots?.[0]?.day || '',
            'MClassTime': math.timeslots?.[0]?.time || '',
            'MClassDay2': math.timeslots?.[1]?.day || '',
            'MClassTime2': math.timeslots?.[1]?.time || '',
            'CurrentMath': math.currentLevel || '',
            'MathNo': math.currentWS || '',
            'English': eng.name ? '1' : '',
            'EStarting': eng.startLevel || '',
            'EStartingNo': eng.startWS || '',
            'EEnrollmentDate': eng.enrolDate || '',
            'EClassDay': eng.timeslots?.[0]?.day || '',
            'EClassTime': eng.timeslots?.[0]?.time || '',
            'EClassDay2': eng.timeslots?.[1]?.day || '',
            'EClassTime2': eng.timeslots?.[1]?.time || '',
            'CurrentEng': eng.currentLevel || '',
            'EngNo': eng.currentWS || '',
            'EFL': efl.name ? '1' : '',
            'EFLStarting': efl.startLevel || '',
            'EFLStartingNo': efl.startWS || '',
            'EFLEnrollmentDate': efl.enrolDate || '',
            'EFLClassDay': efl.timeslots?.[0]?.day || '',
            'EFLClassTime': efl.timeslots?.[0]?.time || '',
            'EFLClassDay2': efl.timeslots?.[1]?.day || '',
            'EFLClassTime2': efl.timeslots?.[1]?.time || '',
            'CurrentEFL': efl.currentLevel || '',
            'EFLNo': efl.currentWS || '',
            'Chinese': chi.name ? '1' : '',
            'CStarting': chi.startLevel || '',
            'CStartingNo': chi.startWS || '',
            'CEnrollmentDate': chi.enrolDate || '',
            'CClassDay': chi.timeslots?.[0]?.day || '',
            'CClassTime': chi.timeslots?.[0]?.time || '',
            'CClassDay2': chi.timeslots?.[1]?.day || '',
            'CClassTime2': chi.timeslots?.[1]?.time || '',
            'CurrentChinese': chi.currentLevel || '',
            'ChiNo': chi.currentWS || '',
            'Chinese (Simp)': chiSimp.name ? '1' : '',
            'CSStarting': chiSimp.startLevel || '',
            'CSStartingNo': chiSimp.startWS || '',
            'CSEnrollmentDate': chiSimp.enrolDate || '',
            'CSClassDay': chiSimp.timeslots?.[0]?.day || '',
            'CSClassTime': chiSimp.timeslots?.[0]?.time || '',
            'CSClassDay2': chiSimp.timeslots?.[1]?.day || '',
            'CSClassTime2': chiSimp.timeslots?.[1]?.time || '',
            'CurrentChineseSimp': chiSimp.currentLevel || '',
            'ChiSimpNo': chiSimp.currentWS || ''
        };
    });
    
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Students");
    XLSX.writeFile(wb, `Kumon_Students_${filenameSuffix}_${new Date().toISOString().split('T')[0]}.xlsx`);
}

    async function exportStudentsToExcel() {
        await exportFilteredStudents(() => true, "Export_All");
    }

// ==========================================
// 📤 SUBJECT-SPECIFIC EXPORT LOGIC
// ==========================================

function normalizeStatusValue(value) {
    return String(value || '').trim().toLowerCase();
}

function isCurrentStatusValue(value) {
    const status = normalizeStatusValue(value);
    return status === 'current' || status === 'active';
}

function getSubjectTimeslot(subject, index) {
    const timeslots = subject?.timeslots;

    if (Array.isArray(timeslots)) {
        return timeslots[index] || {};
    }

    if (timeslots && typeof timeslots === 'object') {
        const values = Object.values(timeslots);
        return values[index] || {};
    }

    return {};
}

function buildSubjectExportRow(student, subjectData, subjectName) {
    const slot1 = getSubjectTimeslot(subjectData, 0);
    const slot2 = getSubjectTimeslot(subjectData, 1);

    const commonFields = {
        'StudentNo': student.studentNumber || '',
        'Chinese Name (Alphabet)': student.namePinyin || '',
        'Chinese Name': student.nameCn || '',
        'Nickname': student.nickname || '',
        'SchoolGrade': student.grade || '',
        'SchoolName': student.school || '',
        'DateOfBirth': student.birthday || '',
        'Nationality': student.nationality || '',
        'Email': student.email || '',
        'Phone (Emergency_M)': student.phone?.mom || '',
        'Phone (Emergency_D)': student.phone?.dad || '',
        'Phone (Emergency_Self)': student.phone?.own || '',
        'Ship Address': student.address || '',
        'Overall Status': student.overallStatus || '',
        'Subject': subjectData.name || subjectName,
        'Subject Status': subjectData.status || student.overallStatus || 'Current'
    };

    if (subjectName === 'Math') {
        return {
            ...commonFields,
            'Maths': '1',
            'MStarting': subjectData.startLevel || '',
            'MStartingNo': subjectData.startWS ?? '',
            'MEnrollmentDate': subjectData.enrolDate || '',
            'MClassDay': slot1.day || '',
            'MClassTime': slot1.time || '',
            'MClassDay2': slot2.day || '',
            'MClassTime2': slot2.time || '',
            'CurrentMath': subjectData.currentLevel || '',
            'MathNo': subjectData.currentWS ?? ''
        };
    }

    if (subjectName === 'English ERP') {
        return {
            ...commonFields,
            'English': '1',
            'EStarting': subjectData.startLevel || '',
            'EStartingNo': subjectData.startWS ?? '',
            'EEnrollmentDate': subjectData.enrolDate || '',
            'EClassDay': slot1.day || '',
            'EClassTime': slot1.time || '',
            'EClassDay2': slot2.day || '',
            'EClassTime2': slot2.time || '',
            'CurrentEng': subjectData.currentLevel || '',
            'EngNo': subjectData.currentWS ?? ''
        };
    }

    if (subjectName === 'English EFL') {
        return {
            ...commonFields,
            'EFL': '1',
            'EFLStarting': subjectData.startLevel || '',
            'EFLStartingNo': subjectData.startWS ?? '',
            'EFLEnrollmentDate': subjectData.enrolDate || '',
            'EFLClassDay': slot1.day || '',
            'EFLClassTime': slot1.time || '',
            'EFLClassDay2': slot2.day || '',
            'EFLClassTime2': slot2.time || '',
            'CurrentEFL': subjectData.currentLevel || '',
            'EFLNo': subjectData.currentWS ?? ''
        };
    }

    if (subjectName === 'Chinese (Trad)') {
        return {
            ...commonFields,
            'Chinese': '1',
            'CStarting': subjectData.startLevel || '',
            'CStartingNo': subjectData.startWS ?? '',
            'CEnrollmentDate': subjectData.enrolDate || '',
            'CClassDay': slot1.day || '',
            'CClassTime': slot1.time || '',
            'CClassDay2': slot2.day || '',
            'CClassTime2': slot2.time || '',
            'CurrentChinese': subjectData.currentLevel || '',
            'ChiNo': subjectData.currentWS ?? ''
        };
    }

    if (subjectName === 'Chinese (Simp)') {
        return {
            ...commonFields,
            'Chinese (Simp)': '1',
            'CSStarting': subjectData.startLevel || '',
            'CSStartingNo': subjectData.startWS ?? '',
            'CSEnrollmentDate': subjectData.enrolDate || '',
            'CSClassDay': slot1.day || '',
            'CSClassTime': slot1.time || '',
            'CSClassDay2': slot2.day || '',
            'CSClassTime2': slot2.time || '',
            'CurrentChineseSimp': subjectData.currentLevel || '',
            'ChiSimpNo': subjectData.currentWS ?? ''
        };
    }

    return commonFields;
}

async function exportBySubject(subject) {
    try {
        const students = await fetchAllStudents();

        if (students.length === 0) {
            alert(t('students.noStudentsExport'));
            return;
        }

        const exportRows = [];

        students.forEach(student => {
            const subjects = Array.isArray(student.subjects)
                ? student.subjects
                : Object.values(student.subjects || {});

            const matchingSubject = subjects.find(sub => {
                if (!sub || sub.name !== subject) return false;

                // Prefer the subject's own status.
                // If subject status is missing, fall back to overallStatus.
                const effectiveStatus = sub.status || student.overallStatus;

                return isCurrentStatusValue(effectiveStatus);
            });

            if (matchingSubject) {
                exportRows.push(
                    buildSubjectExportRow(student, matchingSubject, subject)
                );
            }
        });

        if (exportRows.length === 0) {
            alert(t('students.noMatchExport'));
            return;
        }

        const ws = XLSX.utils.json_to_sheet(exportRows);
        const wb = XLSX.utils.book_new();

        const safeSheetName = String(subject || '')
            .replace(/[\\\/\?\*\[\]:]/g, '')
            .substring(0, 31) || 'Students';

        const safeFileName = String(subject || '')
            .trim()
            .replace(/\s+/g, '_')
            .replace(/[^\w\-]+/g, '_');

        XLSX.utils.book_append_sheet(wb, ws, safeSheetName);

        XLSX.writeFile(
            wb,
            `Kumon_Students_${safeFileName}_${new Date().toISOString().split('T')[0]}.xlsx`
        );
    } catch (err) {
        console.error('❌ Subject export failed:', err);
        alert(`Export failed: ${err.message}`);
    }
}

    async function exportByFilter(field, value) {
        await exportFilteredStudents(
            s => s[field] && String(s[field]).toLowerCase() === String(value).toLowerCase(),
            `${field}_${value.replace(/\s+/g, '_')}`
        );
    }

    async function exportByTeacher(teacherUid) {
        await exportFilteredStudents(
            s => {
                if (!s.assignedTeachers) return false;
                return Object.values(s.assignedTeachers).some(teachers =>
                    Array.isArray(teachers) && teachers.includes(teacherUid)
                );
            },
            `Teacher_${teacherUid}`
        );
    }

    async function exportNamesOnlyGrid() {
        const loader = document.getElementById('page-loader');
        loader?.classList.remove('hidden');
        try {
            const snapshot = await get(studentsRef);
            if (!snapshot.exists()) {
                alert(t('students.noStudentsExport'));
                return;
            }
            const normalizeStatus = (value) => {
                return String(value || '').trim().toLowerCase();
            };
            const getSubjectsArray = (subjects) => {
                if (!subjects) return [];
                if (Array.isArray(subjects)) return subjects;
                if (typeof subjects === 'object') {
                    return Object.values(subjects);
                }
                return [];
            };
            const isCurrentStudentOnly = (student) => {
                const subjects = getSubjectsArray(student.subjects);
                if (subjects.length > 0) {
                    const statuses = subjects.map(sub => normalizeStatus(sub?.status));
                    if (statuses.some(status => status === 'current')) {
                        return true;
                    }
                    const nonCurrentStatuses = ['inquiry', 'pause', 'paused', 'drop', 'dropped', 'inactive', 'withdrawn', 'completer'];
                    if (statuses.some(status => nonCurrentStatuses.includes(status))) {
                        return false;
                    }
                    return normalizeStatus(student.overallStatus) === 'current';
                }
                return normalizeStatus(student.overallStatus) === 'current';
            };
            const uniqueNames = new Set();
            snapshot.forEach(child => {
                const s = child.val();
                if (!isCurrentStudentOnly(s)) {
                    return;
                }
                const name = String(s.nameCn || s.namePinyin || 'Unknown').trim();
                if (name && name.toLowerCase() !== 'unknown') {
                    uniqueNames.add(name);
                }
            });
            const names = Array.from(uniqueNames).sort((a, b) => {
                return a.localeCompare(b, 'zh-Hans');
            });
            if (names.length === 0) {
                alert(t('students.noCurrentNames'));
                return;
            }
            const rows = 16;
            const cols = Math.ceil(names.length / rows);
            const aoa = [];
            for (let r = 0; r < rows; r++) {
                const rowData = [];
                for (let c = 0; c < cols; c++) {
                    const index = (c * rows) + r;
                    rowData.push(index < names.length ? names[index] : '');
                }
                aoa.push(rowData);
            }
            const ws = XLSX.utils.aoa_to_sheet(aoa);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Current Names");
            XLSX.writeFile(wb, `Kumon_Current_Names_Grid_${new Date().toISOString().split('T')[0]}.xlsx`);
        } catch (err) {
            console.error("❌ Export failed: ", err);
            alert(t('students.failedExportNames'));
        } finally {
            loader?.classList.add('hidden');
        }
    }

    // ==========================================
    // 🔌 EXPORT MODAL EVENT LISTENERS
    // ==========================================
    async function openExportModal() {
        const modal = document.getElementById('exportModal');
        modal?.classList.remove('hidden');
        const students = await fetchAllStudents();
        const schools = [...new Set(students.map(s => s.school).filter(Boolean))].sort();
        const grades = [...new Set(students.map(s => s.grade).filter(Boolean))].sort();
        const schoolSelect = document.getElementById('exportSchoolSelect');
        if (schoolSelect) {
            schoolSelect.innerHTML = `<option value="">${t('students.selectSchoolOption')}</option>` +
                schools.map(s => `<option value="${s}">${s}</option>`).join('');
        }
        const gradeSelect = document.getElementById('exportGradeSelect');
        if (gradeSelect) {
            gradeSelect.innerHTML = `<option value="">${t('students.selectGradeOption')}</option>` +
                grades.map(g => `<option value="${g}">${g}</option>`).join('');
        }
        const teacherSelect = document.getElementById('exportTeacherSelect');
        if (teacherSelect) {
            teacherSelect.innerHTML = `<option value="">${t('students.loadingTeachers')}</option>`;
            try {
                const empSnap = await get(ref(db, 'employees'));
                if (empSnap.exists()) {
                    const emps = empSnap.val();
                    const teachingPositions = ['Math Teacher', 'English Teacher', 'Chinese Teacher', 'Tutorial Teacher'];
                    const teachers = Object.entries(emps)
                        .filter(([_, emp]) => {
                            const positions = Array.isArray(emp.positions) ? emp.positions : (emp.position ? [emp.position] : []);
                            return positions.some(p => teachingPositions.includes(p)) && !emp.isDisabled;
                        })
                        .map(([uid, emp]) => ({ uid, name: emp.englishName || emp.chineseName || 'Unknown' }))
                        .sort((a, b) => a.name.localeCompare(b.name));
                    teacherSelect.innerHTML = `<option value="">${t('students.selectTeacherOption')}</option>` +
                        teachers.map(t => `<option value="${t.uid}">${t.name}</option>`).join('');
                } else {
                    teacherSelect.innerHTML = `<option value="">${t('students.noTeachersFound')}</option>`;
                }
            } catch (err) {
                console.error("Error loading teachers for export:", err);
                teacherSelect.innerHTML = `<option value="">${t('students.errorLoadingTeachers')}</option>`;
            }
        }
    }

    document.getElementById('exportBtn')?.addEventListener('click', openExportModal);
    document.getElementById('closeExportModal')?.addEventListener('click', () => {
        document.getElementById('exportModal')?.classList.add('hidden');
    });
    document.getElementById('exportAllBtn')?.addEventListener('click', async () => {
        document.getElementById('exportModal')?.classList.add('hidden');
        await exportStudentsToExcel();
    });
    document.getElementById('exportSubjectBtn')?.addEventListener('click', async () => {
        const subject = document.getElementById('exportSubjectSelect').value;
        if (!subject) return alert(t('students.selectSubjectAlert'));
        document.getElementById('exportModal')?.classList.add('hidden');
        await exportBySubject(subject);
    });
    document.getElementById('exportNamesOnlyBtn')?.addEventListener('click', async () => {
        document.getElementById('exportModal')?.classList.add('hidden');
        await exportNamesOnlyGrid();
    });
    document.getElementById('exportSchoolBtn')?.addEventListener('click', async () => {
        const school = document.getElementById('exportSchoolSelect').value;
        if (!school) return alert(t('students.selectSchoolAlert'));
        document.getElementById('exportModal')?.classList.add('hidden');
        await exportByFilter('school', school);
    });
    document.getElementById('exportGradeBtn')?.addEventListener('click', async () => {
        const grade = document.getElementById('exportGradeSelect').value;
        if (!grade) return alert(t('students.selectGradeAlert'));
        document.getElementById('exportModal')?.classList.add('hidden');
        await exportByFilter('grade', grade);
    });
    document.getElementById('exportTeacherBtn')?.addEventListener('click', async () => {
        const teacherUid = document.getElementById('exportTeacherSelect').value;
        if (!teacherUid) return alert(t('students.selectTeacherAlert'));
        document.getElementById('exportModal')?.classList.add('hidden');
        await exportByTeacher(teacherUid);
    });

    // ==========================================
    // 🔌 EVENT LISTENERS
    // ==========================================
    document.getElementById('firstPage')?.addEventListener('click', () => goToPage(1));
    document.getElementById('prevPage')?.addEventListener('click', () => goToPage(currentPage - 1));
    document.getElementById('nextPage')?.addEventListener('click', () => goToPage(currentPage + 1));
    document.getElementById('lastPage')?.addEventListener('click', () => {
        const totalPages = Math.ceil(filteredStudentsData.length / ITEMS_PER_PAGE);
        goToPage(totalPages);
    });
    document.querySelectorAll('#filter-subject, #filter-status, [id^="sort"]').forEach(el => {
        el.addEventListener('change', () => {
            currentPage = 1;
            loadStudents(document.getElementById('searchInput')?.value || '');
        });
    });
    document.getElementById('clearSortBtn')?.addEventListener('click', () => {
        document.getElementById('filter-subject').value = '';
        document.getElementById('filter-status').value = 'current';
        for (let i = 1; i <= 2; i++) {
            document.getElementById(`sort${i}-field`).value = '';
            document.getElementById(`sort${i}-dir`).value = 'asc';
        }
        currentPage = 1;
        loadStudents(document.getElementById('searchInput')?.value || '');
    });

    const toggleFiltersBtn = document.getElementById('toggleFiltersBtn');
    const sortPanelEl = document.querySelector('.sort-panel');
    if (toggleFiltersBtn && sortPanelEl) {
            toggleFiltersBtn.addEventListener('click', () => {
                sortPanelEl.classList.toggle('open');
                toggleFiltersBtn.classList.toggle('active', sortPanelEl.classList.contains('open'));
        });
    }

    let isComposing = false;
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('compositionstart', () => {
            isComposing = true;
        });
        searchInput.addEventListener('compositionend', (e) => {
            isComposing = false;
            currentPage = 1;
            loadStudents(e.target.value);
        });
        searchInput.addEventListener('input', (e) => {
            if (isComposing) return;
            currentPage = 1;
            loadStudents(e.target.value);
        });
    }

    document.getElementById('addStudentBtn')?.addEventListener('click', () => window.location.href = 'student-form.html');
    document.getElementById('logoutBtn')?.addEventListener('click', logout);

    const importBtn = document.getElementById('importBtn');
    const excelFileInput = document.getElementById('excelFileInput');
    if (importBtn && excelFileInput) {
        importBtn.addEventListener('click', () => excelFileInput.click());
        excelFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleExcelImport(file);
            e.target.value = '';
        });
    }

    document.getElementById('closeImportModal')?.addEventListener('click', () => {
        document.getElementById('importProgressModal')?.classList.add('hidden');
        currentPage = 1;
        loadStudents();
    });

    // ==========================================
    // 🗑️ DELETE ALL STUDENTS LOGIC
    // ==========================================
    const deleteAllBtn = document.getElementById('deleteAllBtn');
    const deleteAllModal = document.getElementById('deleteAllModal');
    const closeDeleteAllModal = document.getElementById('closeDeleteAllModal');
    const cancelDeleteAllBtn = document.getElementById('cancelDeleteAllBtn');
    const confirmDeleteAllBtn = document.getElementById('confirmDeleteAllBtn');

    if (deleteAllBtn) {
        deleteAllBtn.addEventListener('click', () => {
            deleteAllModal?.classList.remove('hidden');
        });
    }
    if (closeDeleteAllModal) {
        closeDeleteAllModal.addEventListener('click', () => deleteAllModal?.classList.add('hidden'));
    }
    if (cancelDeleteAllBtn) {
        cancelDeleteAllBtn.addEventListener('click', () => deleteAllModal?.classList.add('hidden'));
    }
    if (confirmDeleteAllBtn) {
        confirmDeleteAllBtn.addEventListener('click', async () => {
            if (!isAdmin) {
                alert(t('students.noPermission'));
                deleteAllModal?.classList.add('hidden');
                return;
            }
            confirmDeleteAllBtn.disabled = true;
            confirmDeleteAllBtn.textContent = t('students.deleting');
            try {
                await remove(studentsRef);
                alert(t('students.deleteSuccess'));
                deleteAllModal?.classList.add('hidden');
                loadStudents();
            } catch (err) {
                console.error('Error deleting all students:', err);
                alert(t('students.deleteFailed', { message: err.message }));
            } finally {
                confirmDeleteAllBtn.disabled = false;
                confirmDeleteAllBtn.textContent = t('students.yesDeleteAll');
            }
        });
    }

    // ==========================================
    // 🍂 BULK GRADE UPGRADE LOGIC (August 15th)
    // ==========================================
    async function processGradeUpdates() {
        const now = new Date();
        const currentYear = now.getFullYear();
        const isAug15OrLater = (now.getMonth() > 7) || (now.getMonth() === 7 && now.getDate() >= 15);
        if (!isAug15OrLater) return;
        const academicYear = currentYear;
        const snapshot = await get(studentsRef);
        if (!snapshot.exists()) return;
        const GRADE_ORDER = ['K0', 'K1', 'K2', 'K3', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
        const getNextGrade = (grade) => {
            const idx = GRADE_ORDER.indexOf(String(grade));
            return (idx !== -1 && idx < GRADE_ORDER.length - 1) ? GRADE_ORDER[idx + 1] : grade;
        };
        const updates = {};
        snapshot.forEach(child => {
            const student = child.val();
            const studentId = child.key;
            if (!student.lastGradeUpdateYear || student.lastGradeUpdateYear < academicYear) {
                const oldGrade = student.grade;
                const newGrade = getNextGrade(oldGrade);
                updates[`${studentId}/grade`] = newGrade;
                updates[`${studentId}/lastGradeUpdateYear`] = academicYear;
                updates[`${studentId}/updatedAt`] = new Date().toISOString();
            }
        });
        if (Object.keys(updates).length > 0) {
            await update(studentsRef, updates);
            console.log(`🍂 Auto-updated grades for ${Object.keys(updates).length / 3} students.`);
        }
    }

    // Initial load
    processGradeUpdates();
    loadStudents();
}