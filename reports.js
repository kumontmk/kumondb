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

    // 🚀 FIX 1: LOCALSTORAGE CACHE SETUP (Saves Firebase Bandwidth)
    const CACHE_KEY = `students_cache_${centerId}`;
    const CACHE_TIME_KEY = `students_cache_time_${centerId}`;
    const CACHE_DURATION = 5 * 60 * 1000; // Cache valid for 5 minutes

    function getCachedStudents() {
        const cached = localStorage.getItem(CACHE_KEY);
        const timestamp = localStorage.getItem(CACHE_TIME_KEY);
        if (cached && timestamp && (Date.now() - parseInt(timestamp)) < CACHE_DURATION) {
            try { return JSON.parse(cached); } catch (e) { return null; }
        }
        return null;
    }

    function cacheStudents(students) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(students));
            localStorage.setItem(CACHE_TIME_KEY, Date.now().toString());
        } catch (e) {
            console.warn('LocalStorage quota exceeded or unavailable');
        }
    }

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
        
        // Clear cache if forcing refresh
        if (forceRefresh) {
            localStorage.removeItem(CACHE_KEY);
            localStorage.removeItem(CACHE_TIME_KEY);
        } else {
            // 🚀 Try cache first to prevent Firebase download
            const cached = getCachedStudents();
            if (cached) {
                cachedStudents = cached;
                isDataLoaded = true;
                console.log('✅ Loaded from cache (0 Firebase bandwidth used)');
                return;
            }
        }

        showLoader();
        cachedStudents = [];
        try {
            const snap = await get(studentsRef);
            if (snap.exists()) {
                snap.forEach(child => {
                    const data = child.val();
                    
                    // 🚀 Skip inactive/dropped students immediately to save bandwidth
                    if (data.status === 'drop' || data.status === 'pause') return;
                    
                    data.subjects = Array.isArray(data.subjects) ? data.subjects : Object.values(data.subjects || {});
                    
                    // 🚀 Filter out inactive subjects
                    data.subjects = data.subjects.filter(sub => 
                        sub && !['drop', 'pause', 'inquiry'].includes(sub.status)
                    );
                    
                    cachedStudents.push({ id: child.key, data });
                });
            }
            
            // 🚀 Save filtered students to LocalStorage
            cacheStudents(cachedStudents);
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
            
            // 1️⃣ Primary Sort: By Grade
            if (orderA !== orderB) return orderA - orderB;
            
            // 2️⃣ Secondary Sort: By Pinyin Name (Fallback: Nickname -> Chinese Name)
            // We use .toUpperCase() to ensure strict A-Z sorting regardless of how it's capitalized in the DB
            const nameA = (a.data.namePinyin || a.data.nickname || a.data.nameCn || '').trim().toUpperCase();
            const nameB = (b.data.namePinyin || b.data.nickname || b.data.nameCn || '').trim().toUpperCase();
            
            // Use English locale for standard A-Z alphabetical sorting
            return nameA.localeCompare(nameB, 'en', { sensitivity: 'base' });
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
                    if (!sub) return; // Status already filtered in loadStudents
                    
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
                        
                        row.querySelector('.add-at-btn').addEventListener('click', () => {
                            container.insertAdjacentHTML('beforeend', createATBlock({}));
                            toggleTests();
                        });

                        container.addEventListener('click', (e) => {
                            if (e.target.classList.contains('remove-at-btn')) {
                                if (container.children.length > 1 || confirm('Remove this AT block?')) {
                                    e.target.closest('.at-block').remove();
                                }
                            }
                        });

                        toggleTests();
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
            
            const emptyDates = document.querySelectorAll('.test-date');
            emptyDates.forEach(input => {
                if (!input.value || input.value.trim() === '') {
                    input.classList.add('hide-on-print');
                }
            });
            
            window.print();
            
            setTimeout(() => {
                allATBlocks.forEach(block => block.classList.remove('hide-on-print'));
                emptyDates.forEach(input => input.classList.remove('hide-on-print'));
            }, 1000);
        });
    }

    // 🚀 FIX 2: HIGH-SPEED SAVE LOGIC (Granular updates & Change detection)
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
                    const pencilLevelEl = row.querySelector('.pencil-level');
                    const pencilWSEl = row.querySelector('.pencil-ws');

                    // 🚀 USE CACHED DATA INSTEAD OF FETCHING FROM FIREBASE
                    const cachedStudent = cachedStudents.find(s => s.id === studentId);
                    if (!cachedStudent) continue;
                    const student = cachedStudent.data;
                    
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

                    const basePath = `centers/${centerId}/students/${studentId}/subjects/${subjectKey}`;

                    // 🚀 GRANULAR UPDATES (Only send exactly what changed!)
                    if (currLevelEl) {
                        const newLevel = currLevelEl.value?.trim() || '';
                        if (newLevel && newLevel !== subjectData.currentLevel) {
                            batchUpdates[`${basePath}/currentLevel`] = newLevel;
                            subjectData.currentLevel = newLevel; // Update memory
                        }
                    }
                    if (currWSEl) {
                        const newWS = currWSEl.value?.trim() !== '' ? parseInt(currWSEl.value.trim()) : 0;
                        if (newWS !== subjectData.currentWS) {
                            batchUpdates[`${basePath}/currentWS`] = newWS;
                            subjectData.currentWS = newWS;
                        }
                    }

                    if (pencilLevelEl || pencilWSEl) {
                        const pLevel = pencilLevelEl ? (pencilLevelEl.value?.trim() || '') : '';
                        const pWS = pencilWSEl ? (pencilWSEl.value?.trim() || '') : '';
                        const oldPencil = subjectData.pencilSkill || {};
                        
                        if (pLevel !== '' || pWS !== '') {
                            if (pLevel !== oldPencil.level) batchUpdates[`${basePath}/pencilSkill/level`] = pLevel;
                            const newPWS = pWS !== '' ? (parseInt(pWS) || 0) : '';
                            if (newPWS !== oldPencil.ws) batchUpdates[`${basePath}/pencilSkill/ws`] = newPWS;
                            subjectData.pencilSkill = { level: pLevel, ws: newPWS };
                        } else if (subjectData.pencilSkill) {
                            batchUpdates[`${basePath}/pencilSkill`] = null; // Deletes from Firebase
                            delete subjectData.pencilSkill;
                        }
                    }

                    let progArr = Array.isArray(subjectData.progress) ? subjectData.progress : Object.values(subjectData.progress || {});
                    const entry = { month };
                    
                    const pL = getVal('prev-level'); if (pL) entry.prevLevel = pL;
                    const pW = getVal('prev-ws'); if (pW) entry.prevWS = parseInt(pW);
                    if (currLevelEl && currLevelEl.value?.trim()) entry.currLevel = currLevelEl.value.trim();
                    if (currWSEl && currWSEl.value?.trim() !== '') entry.currWS = parseInt(currWSEl.value.trim()) || 0;

                    // Gather multiple ATs
                    const testsArray = [];
                    row.querySelectorAll('.at-block').forEach(block => {
                        const tDate = block.querySelector('.test-date')?.value?.trim() || '';
                        const tLevel = block.querySelector('.test-level')?.value?.trim() || '';
                        const tScore = block.querySelector('.test-score')?.value?.trim() || '';
                        const tTime = block.querySelector('.test-time')?.value?.trim() || '';
                        const tGroup = block.querySelector('.test-group')?.value?.trim() || '';
                        
                        if (tDate || tLevel || tScore || tTime || tGroup) {
                            testsArray.push({ date: tDate, level: tLevel, score: tScore, time: parseInt(tTime) || 0, group: tGroup });
                        }
                    });
                    
                    // Always set tests array so deletions are saved correctly
                    entry.tests = testsArray;

                    // Update the specific progress index instead of the whole array
                    const idx = progArr.findIndex(p => p?.month === month);
                    if (idx >= 0) {
                        const oldEntry = progArr[idx];
                        // 🚀 CHANGE DETECTION (Only update if data actually changed)
                        const changed = Object.keys(entry).some(k => JSON.stringify(oldEntry[k]) !== JSON.stringify(entry[k]));
                        if (changed) {
                            progArr[idx] = { ...oldEntry, ...entry };
                            batchUpdates[`${basePath}/progress/${idx}`] = progArr[idx];
                        }
                    } else {
                        progArr.push(entry);
                        batchUpdates[`${basePath}/progress/${progArr.length - 1}`] = entry;
                    }
                    subjectData.progress = progArr;
                }

                if (Object.keys(batchUpdates).length > 0) {
                    await update(ref(db), batchUpdates);
                    alert('✅ Saved successfully!');
                    
                    // 🚀 UPDATE CACHE & REBUILD WITHOUT RELOADING FROM FIREBASE
                    cacheStudents(cachedStudents);
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

    // 🚀 Removed 'true' so it respects the cache on initial page load
    setTimeout(() => loadStudents().then(buildReport), 200);
}