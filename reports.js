import { auth, db, logout } from './auth.js';
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'monthlyReports';

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
            initializeReports();
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
// 📄 MAIN APP LOGIC
// ==========================================
function initializeReports() {
    const centerId = sessionStorage.getItem('selectedCenter');
    if (!centerId) window.location.href = 'centers.html';
    const studentsRef = ref(db, `centers/${centerId}/students`);
    let cachedStudents = [];
    let isDataLoaded = false;
    let activeSubject = 'all';

    const reportMonthInput = document.getElementById('reportMonth');
    const generateBtn = document.getElementById('generateReport');
    const saveBtn = document.getElementById('saveReportBtn');
    const saveBar = document.getElementById('saveBar');
    const reportOutput = document.getElementById('reportOutput');
    const monthlyReportContainer = document.getElementById('monthlyReport');
    const printBtn = document.getElementById('printReport');

    function showLoader() { document.getElementById('page-loader')?.classList.remove('hidden'); }
    function hideLoader() { document.getElementById('page-loader')?.classList.add('hidden'); }

    document.querySelectorAll('.subject-card').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.subject-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            activeSubject = card.dataset.subject;
            if (isDataLoaded) buildReport();
        });
    });

    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (reportMonthInput) {
        reportMonthInput.max = currentMonthStr;
        reportMonthInput.value = currentMonthStr;
        const blockFuture = (e) => { if (e.target.value > currentMonthStr) e.target.value = currentMonthStr; };
        reportMonthInput.addEventListener('change', (e) => { blockFuture(e); buildReport(); });
        reportMonthInput.addEventListener('input', blockFuture);
    }

    async function loadStudents(forceRefresh = false) {
        if (isDataLoaded && !forceRefresh) return;
        showLoader();
        cachedStudents = [];
        try {
            const snap = await get(studentsRef);
            if (snap.exists()) {
                snap.forEach(child => {
                    const data = child.val();
                    data.subjects = Array.isArray(data.subjects) ? data.subjects : Object.values(data.subjects || {});
                    cachedStudents.push({ id: child.key, data });
                });
            }
            isDataLoaded = true;
        } catch (err) {
            console.error('❌ Load failed:', err);
            alert('Failed to load student data.');
        }
        hideLoader();
    }

    function getGradeOrder(grade) {
        if (!grade) return 999;
        const g = String(grade).trim().toUpperCase();
        if (/^K\d+$/.test(g)) {
            const n = parseInt(g.slice(1), 10);
            return (n >= 0 && n <= 3) ? n : 998;
        }
        const n = parseInt(g, 10);
        return (n >= 1 && n <= 13) ? n + 4 : 998;
    }

    function getTheadHTML(isPencil) {
        if (isPencil) {
            return `<thead><tr><th>Student No</th><th>Chinese Name</th><th>Pinyin/Nickname</th><th>Grade</th><th>Subject</th><th>Pencil Level</th><th>Pencil WS</th></tr></thead>`;
        }
        return `
            <thead>
                <tr>
                    <th rowspan="2">Student No</th>
                    <th rowspan="2">Chinese Name</th>
                    <th rowspan="2">Pinyin/Nickname</th>
                    <th rowspan="2">Grade</th>
                    <th rowspan="2">Prev Level</th>
                    <th rowspan="2">Prev WS</th>
                    <th rowspan="2">Current Level</th>
                    <th rowspan="2">Current WS</th>
                    <th colspan="5" style="text-align:center; background: rgba(135,206,235,0.3);">Achievement Tests (AT)</th>
                </tr>
                <tr>
                    <th style="background: rgba(135,206,235,0.2);">Date</th>
                    <th style="background: rgba(135,206,235,0.2);">Level</th>
                    <th style="background: rgba(135,206,235,0.2);">Score</th>
                    <th style="background: rgba(135,206,235,0.2);">Time</th>
                    <th style="background: rgba(135,206,235,0.2);">Group</th>
                </tr>
            </thead>
        `;
    }

    function createInput(val, cls, readonly = false, type = 'text') {
        return `<input type="${type}" value="${val ?? ''}" class="report-input ${cls}" ${readonly ? 'readonly' : ''} autocomplete="off">`;
    }

    function createATBlock(test = {}) {
        const dateVal = test.date || '';
        const levelVal = test.level || '';
        const scoreVal = test.score || '';
        const timeVal = test.time || '';
        const groupVal = test.group || '';
        
        return `
            <div class="at-block">
                <input type="date" class="report-input test-date" value="${dateVal}" title="Date">
                <input type="text" class="report-input test-level" value="${levelVal}" placeholder="Level" title="Level">
                <input type="text" class="report-input test-score" value="${scoreVal}" placeholder="Score" title="Score">
                <input type="number" class="report-input test-time" value="${timeVal}" placeholder="Time" title="Time">
                <input type="text" class="report-input test-group" value="${groupVal}" placeholder="Group" title="Group">
                <button type="button" class="remove-at-btn" title="Remove AT">✕</button>
            </div>
        `;
    }

    function buildReport() {
        if (!isDataLoaded) return;
        const month = reportMonthInput?.value;
        reportOutput.innerHTML = '';
        monthlyReportContainer?.classList.add('hidden');
        if (saveBar) saveBar.classList.add('hidden');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save Changes'; }

        if (!month) {
            reportOutput.innerHTML = `<div class="empty-state">📅 Please select a month.</div>`;
            monthlyReportContainer?.classList.remove('hidden');
            return;
        }

        const sortedStudents = [...cachedStudents].sort((a, b) => {
            const orderA = getGradeOrder(a.data.grade);
            const orderB = getGradeOrder(b.data.grade);
            if (orderA !== orderB) return orderA - orderB;
            return (a.data.nameCn || '').localeCompare(b.data.nameCn || '', 'zh-Hans-CN', { sensitivity: 'base' });
        });

        let totalRows = 0;
        const subjectsToRender = activeSubject === 'all'
            ? ['Math', 'Chinese', 'English ERP', 'English EFL']
            : activeSubject === 'Pencil'
            ? ['Pencil']
            : [activeSubject];

        subjectsToRender.forEach(subName => {
            const rowsForSubject = [];
            sortedStudents.forEach(({ id, data: s }) => {
                if (!s?.subjects) return;
                
                s.subjects.forEach(sub => {
                    if (!sub || ['drop', 'pause', 'inquiry'].includes(sub.status)) return;
                    
                    const isPencil = subName === 'Pencil';
                    if (isPencil) {
                        if (!sub.pencilSkill || !sub.pencilSkill.level) return;
                    } else {
                        if ((sub.name || '').trim() !== subName) return; 
                    }
                    
                    let progress = Array.isArray(sub.progress) ? sub.progress : Object.values(sub.progress || {});
                    const prog = progress.find(p => p?.month === month);
                    const sorted = [...progress].sort((a, b) => (a?.month || '').localeCompare(b?.month || ''));
                    const prev = sorted.filter(p => p?.month && p.month < month).pop();
                    
                    const prevLevel = prev?.currLevel || sub.startLevel || '';
                    const prevWS = prev?.currWS ?? sub.startWS ?? 0;
                    const currLevel = prog?.currLevel || sub.currentLevel || '';
                    const currWS = prog?.currWS ?? sub.currentWS ?? 0;
                    
                    // Support both new 'tests' array and legacy 'test' object
                    const tests = prog?.tests || (prog?.test ? [prog.test] : []);

                    const row = document.createElement('tr');
                    row.dataset.studentId = id;
                    row.dataset.subjectName = sub.name;

                    let rowHTML = '';
                    if (isPencil) {
                        rowHTML = `
                            <td>${s.studentNumber || '-'}</td>
                            <td>${s.nameCn || '-'}</td>
                            <td>${s.namePinyin || s.nickname || '-'}</td>
                            <td>${s.grade || '-'}</td>
                            <td>${sub.name || '-'}</td>
                            <td>${createInput(sub.pencilSkill?.level || '', 'pencil-level', false)}</td>
                            <td>${createInput(sub.pencilSkill?.ws || '', 'pencil-ws', false, 'number')}</td>
                        `;
                    } else {
                        rowHTML = `
                            <td>${s.studentNumber || '-'}</td>
                            <td>${s.nameCn || '-'}</td>
                            <td>${s.namePinyin || s.nickname || '-'}</td>
                            <td>${s.grade || '-'}</td>
                            <td>${createInput(prevLevel, 'prev-level', true)}</td>
                            <td>${createInput(prevWS, 'prev-ws', true, 'number')}</td>
                            <td>${createInput(currLevel, 'curr-level')}</td>
                            <td>${createInput(currWS, 'curr-ws', false, 'number')}</td>
                            <td colspan="5" style="padding: 0.5rem; min-width: 420px;">
                                <div class="tests-container"></div>
                                <button type="button" class="add-at-btn">➕ Add AT</button>
                            </td>
                        `;
                    }
                    
                    row.innerHTML = rowHTML;
                    rowsForSubject.push(row);
                    totalRows++;

                    if (!isPencil) {
                        const currInput = row.querySelector('.curr-level');
                        const container = row.querySelector('.tests-container');
                        
                        // Populate existing tests or add one empty block by default
                        if (tests.length > 0) {
                            tests.forEach(t => container.insertAdjacentHTML('beforeend', createATBlock(t)));
                        } else {
                            container.insertAdjacentHTML('beforeend', createATBlock({}));
                        }

                        const toggleTests = () => {
                            const curr = (currInput?.value || '').trim();
                            const prevVal = (row.querySelector('.prev-level')?.value || '').trim();
                            const changed = curr !== '' && prevVal !== '' && curr !== prevVal;
                            
                            const testInputs = container.querySelectorAll('.test-date, .test-level, .test-score, .test-time, .test-group');
                            testInputs.forEach(input => {
                                input.readOnly = !changed;
                                input.style.background = changed ? '#fff' : '#f8f9fa';
                                input.style.color = changed ? 'inherit' : '#999';
                                input.style.cursor = changed ? 'text' : 'not-allowed';
                                if (!changed && input.value) input.value = '';
                            });
                        };

                        currInput?.addEventListener('input', toggleTests);
                        
                        // Add AT Button Logic
                        row.querySelector('.add-at-btn').addEventListener('click', () => {
                            container.insertAdjacentHTML('beforeend', createATBlock({}));
                            toggleTests(); // Apply readonly state to new inputs immediately
                        });

                        // Remove AT Button Logic (Event Delegation)
                        container.addEventListener('click', (e) => {
                            if (e.target.classList.contains('remove-at-btn')) {
                                if (container.children.length > 1 || confirm('Remove this AT block?')) {
                                    e.target.closest('.at-block').remove();
                                }
                            }
                        });

                        toggleTests(); // Initial call
                    }
                });
            });

            if (rowsForSubject.length > 0) {
                const wrapper = document.createElement('div');
                wrapper.className = 'table-wrapper';
                const table = document.createElement('table');
                table.className = 'subject-table report-table report-sticky-table';
                
                const isPencil = subName === 'Pencil';
                table.dataset.subject = isPencil ? 'Pencil' : subName;
                const captionText = isPencil 
                    ? `ZI/ZII Pencil Skill Report - ${month}` 
                    : `${subName} Progress Report - ${month}`;
                    
                table.innerHTML = `<caption>${captionText}</caption>${getTheadHTML(isPencil)}<tbody></tbody>`;
                const tbody = table.querySelector('tbody');
                rowsForSubject.forEach(r => tbody.appendChild(r));
                wrapper.appendChild(table);
                reportOutput.appendChild(wrapper);
            }
        });

        if (totalRows > 0) {
            monthlyReportContainer?.classList.remove('hidden');
            if (saveBar) saveBar.classList.remove('hidden');
        } else {
            reportOutput.innerHTML = `<div class="empty-state">📭 No matching active students for ${month}</div>`;
            monthlyReportContainer?.classList.remove('hidden');
        }
    }

    if (generateBtn) generateBtn.addEventListener('click', buildReport);
    
    if (printBtn) {
        printBtn.addEventListener('click', () => {
            // Mark empty AT blocks for hiding
            const allATBlocks = document.querySelectorAll('.at-block');
            allATBlocks.forEach(block => {
                const dateInput = block.querySelector('.test-date');
                const hasAnyData = Array.from(block.querySelectorAll('input')).some(input => {
                    return input.value && input.value.trim() !== '';
                });
                
                if (!hasAnyData && dateInput) {
                    block.classList.add('hide-on-print');
                }
            });
            
            // Hide empty date inputs specifically
            const emptyDates = document.querySelectorAll('.test-date');
            emptyDates.forEach(input => {
                if (!input.value || input.value.trim() === '') {
                    input.classList.add('hide-on-print');
                }
            });
            
            window.print();
            
            // Clean up classes after print
            setTimeout(() => {
                allATBlocks.forEach(block => block.classList.remove('hide-on-print'));
                emptyDates.forEach(input => input.classList.remove('hide-on-print'));
            }, 1000);
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const rows = reportOutput?.querySelectorAll('tr[data-student-id]') || [];
            if (rows.length === 0) return alert('No data to save.');
            if (!confirm('💾 Save changes?\n\nPartial saves are supported. Empty fields will be skipped.')) return;
            
            showLoader();
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Saving...';
            const batchUpdates = {};
            const month = reportMonthInput?.value;

            try {
                for (const row of rows) {
                    const studentId = row.dataset.studentId;
                    const subjectName = row.dataset.subjectName;
                    if (!studentId || !subjectName) continue;
                    
                    const getVal = (cls) => row.querySelector(`.${cls}`)?.value?.trim() || '';
                    
                    const currLevelEl = row.querySelector('.curr-level');
                    const currWSEl = row.querySelector('.curr-ws');
                    
                    const currLevel = currLevelEl ? (currLevelEl.value?.trim() || '') : '';
                    const currWS = currWSEl ? (parseInt(currWSEl.value?.trim()) || 0) : null;
                    
                    const pencilLevelEl = row.querySelector('.pencil-level');
                    const pencilWSEl = row.querySelector('.pencil-ws');

                    const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
                    if (!snap.exists()) continue;
                    const student = snap.val();
                    let subjects = student.subjects || {};
                    let subjectKey = null;
                    let subjectData = null;

                    if (Array.isArray(subjects)) {
                        subjectKey = subjects.findIndex(s => (s.name || '').trim() === subjectName);
                        subjectData = subjectKey !== -1 ? subjects[subjectKey] : null;
                    } else {
                        for (const key in subjects) {
                            if ((subjects[key]?.name || '').trim() === subjectName) {
                                subjectKey = key; subjectData = subjects[key]; break;
                            }
                        }
                    }
                    if (!subjectData) continue;

                    if (currLevelEl && currLevel) subjectData.currentLevel = currLevel;
                    if (currWSEl) subjectData.currentWS = currWS !== null ? currWS : 0;

                    if (pencilLevelEl || pencilWSEl) {
                        const pencilLevel = pencilLevelEl ? (pencilLevelEl.value?.trim() || '') : '';
                        const pencilWS = pencilWSEl ? (pencilWSEl.value?.trim() || '') : '';
                        if (pencilLevel !== '' || pencilWS !== '') {
                            if (!subjectData.pencilSkill) subjectData.pencilSkill = {};
                            subjectData.pencilSkill.level = pencilLevel;
                            subjectData.pencilSkill.ws = pencilWS !== '' ? (parseInt(pencilWS) || 0) : '';
                        } else if (subjectData.pencilSkill) {
                            delete subjectData.pencilSkill;
                        }
                    }

                    let progArr = Array.isArray(subjectData.progress) ? subjectData.progress : Object.values(subjectData.progress || {});
                    const entry = { month };
                    const pL = getVal('prev-level'); if (pL) entry.prevLevel = pL;
                    const pW = getVal('prev-ws'); if (pW) entry.prevWS = parseInt(pW);
                    
                    if (currLevelEl && currLevel) entry.currLevel = currLevel;
                    if (currWSEl) entry.currWS = currWS !== null ? currWS : 0;

                    // 🔄 NEW: Gather multiple ATs
                    const testsArray = [];
                    const atBlocks = row.querySelectorAll('.at-block');
                    atBlocks.forEach(block => {
                        const tDate = block.querySelector('.test-date')?.value?.trim() || '';
                        const tLevel = block.querySelector('.test-level')?.value?.trim() || '';
                        const tScore = block.querySelector('.test-score')?.value?.trim() || '';
                        const tTime = block.querySelector('.test-time')?.value?.trim() || '';
                        const tGroup = block.querySelector('.test-group')?.value?.trim() || '';
                        
                        // Only save if at least one field has data
                        if (tDate || tLevel || tScore || tTime || tGroup) {
                            testsArray.push({
                                date: tDate,
                                level: tLevel,
                                score: tScore,
                                time: parseInt(tTime) || 0,
                                group: tGroup
                            });
                        }
                    });

                    if (testsArray.length > 0) {
                        entry.tests = testsArray;
                    }

                    const idx = progArr.findIndex(p => p?.month === month);
                    if (idx >= 0) progArr[idx] = { ...progArr[idx], ...entry };
                    else progArr.push(entry);

                    subjectData.progress = progArr;
                    batchUpdates[`centers/${centerId}/students/${studentId}/subjects/${subjectKey}`] = subjectData;
                }

                if (Object.keys(batchUpdates).length > 0) {
                    await update(ref(db), batchUpdates);
                    alert('✅ Saved successfully!');
                    isDataLoaded = false;
                    await loadStudents(true);
                    setTimeout(buildReport, 300);
                } else {
                    alert('ℹ️ No changes detected.');
                }
            } catch (err) {
                console.error('Save error:', err);
                alert('❌ Save failed: ' + err.message);
            } finally {
                hideLoader();
                saveBtn.disabled = false;
                saveBtn.textContent = '💾 Save Changes';
            }
        });
    }

    setTimeout(() => loadStudents(true).then(buildReport), 200);
}