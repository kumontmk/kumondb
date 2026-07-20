// timetable.js
import { auth, db, logout, syncPendingRequests } from './auth.js';
import { ref, get, onValue, off } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'timetable';

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
            initializeTimetable();
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

// ============================================
// TIMETABLE INITIALIZATION (Only runs if authorized)
// ============================================
function initializeTimetable() {
    const centerId = sessionStorage.getItem('selectedCenter');
    if (!centerId) {
        window.location.href = 'centers.html';
        return;
    }

    syncPendingRequests(centerId);

    const studentsRef = ref(db, `centers/${centerId}/students`);
    const daySelect = document.getElementById('timetableDay');
    const timetableBody = document.getElementById('timetableBody');
    let timetableUnsub = null;
    let weekTimetableUnsub = null;
    let cachedStudentsSnap = null; // Cache for week view reuse

    // ============================================
    // ✅ NEW: TAB SWITCHING LOGIC
    // ============================================
    const tabBtns = document.querySelectorAll('.tab-btn');
    const dayViewContainer = document.getElementById('dayViewContainer');
    const weekViewContainer = document.getElementById('weekViewContainer');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.dataset.tab;
            // Update active tab button
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Update active tab content
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            if (targetTab === 'dayView') {
                dayViewContainer.classList.add('active');
                dayViewContainer.classList.add('print-active');
                weekViewContainer.classList.remove('print-active');
                if (daySelect) loadTimetable();
            } else if (targetTab === 'weekView') {
                weekViewContainer.classList.add('active');
                weekViewContainer.classList.add('print-active');
                dayViewContainer.classList.remove('print-active');
                document.getElementById('champViewContainer')?.classList.remove('print-active');
                loadWeekTimetable();
            } else if (targetTab === 'champView') {
                const champContainer = document.getElementById('champViewContainer');
                champContainer?.classList.add('active');
                champContainer?.classList.add('print-active');
                dayViewContainer.classList.remove('print-active');
                weekViewContainer.classList.remove('print-active');
                loadChampTimetable();
            }
        });
    });

    dayViewContainer.classList.add('print-active');

    function showLoader() {
        document.getElementById('page-loader')?.classList.remove('hidden');
    }

    function hideLoader() {
        document.getElementById('page-loader')?.classList.add('hidden');
    }

    const DAY_MAP = {
        Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
        Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday'
    };
    const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const DAY_TO_NUM = {
        Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
        Friday: 5, Saturday: 6, Sunday: 7
    };
    const DAY_ABBR = ['MON', 'TUES', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

    function getTimeSlots(day) {
        const isWeekend = ['Saturday', 'Sunday'].includes(day);
        const slots = [];
        const startH = isWeekend ? 10 : 14;
        const endH = isWeekend ? 16 : 19;
        for (let h = startH; h <= endH; h++) {
            const minutes = (h === endH) ? ['00', '15'] : ['00', '15', '30', '45'];
            minutes.forEach(m => {
                if (h === endH && (m === '30' || m === '45')) return;
                slots.push(`${String(h).padStart(2, '0')}:${m}`);
            });
        }
        return slots;
    }

    function getWeekTimeSlots() {
        const slots = [];
        for (let h = 10; h <= 19; h++) {
            const minutes = (h === 19) ? ['00', '15'] : ['00', '15', '30', '45'];
            minutes.forEach(m => {
                slots.push(`${String(h).padStart(2, '0')}:${m}`);
            });
        }
        return slots;
    }

    function getWeekDates() {
        const today = new Date();
        const dayOfWeek = today.getDay();
        const monday = new Date(today);
        monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
        monday.setHours(0, 0, 0, 0);

        const dates = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(monday);
            d.setDate(monday.getDate() + i);
            dates.push({
                date: d.getDate(),
                month: d.toLocaleString('en', { month: 'short' }),
                fullDate: d,
                isToday: d.toDateString() === today.toDateString()
            });
        }
        return dates;
    }

    function getSubjectGroup(name) {
        if (!name) return null;
        const lowerName = name.toLowerCase().trim();
        if (lowerName.includes('math')) return 'Math';
        if (lowerName.includes('english') || lowerName.includes('erp') || lowerName.includes('efl')) return 'English';
        if (lowerName.includes('chinese') || lowerName.includes('mandarin')) return 'Chinese';
        return null;
    }

    function getMathChampGroup(level) {
        if (!level) return null;
        const first = level.charAt(0).toUpperCase();
        const second = level.charAt(1)?.toUpperCase();
        if (/\d/.test(first) && second === 'A') return 'math6A2A';
        if (['A', 'B', 'C', 'D', 'E', 'F'].includes(first)) return 'mathAF';
        if (['G', 'H', 'I'].includes(first)) return 'mathGI';
        if (['J', 'K', 'L', 'M', 'N', 'O'].includes(first)) return 'mathJO';
        return null;
    }

    function getEnglishChampGroup(grade) {
        if (!grade) return null;
        const g = grade.toString().toUpperCase().trim();
        if (['K0', 'K1', 'K2', 'K3'].includes(g)) return 'engK';
        return 'engP1';
    }

    function isMathHighLevel(level) {
        if (!level) return false;
        return /^[F-O]/i.test(level);
    }

    function getNextDayNum(tsList, currentDay) {
        const days = [...new Set(tsList.map(ts => DAY_MAP[ts.day] || ts.day))];
        if (days.length <= 1) return '';
        const currentIdx = DAY_ORDER.indexOf(currentDay);
        const dayNums = days.map(d => DAY_TO_NUM[d] || 0).filter(n => n > 0);
        let next = dayNums.find(n => n > currentIdx + 1);
        if (next === undefined) next = Math.min(...dayNums);
        return String(next);
    }

    function getDaySubjectOrder(subjects, currentDay) {
        const daySubjects = [];
        const seen = new Set();
        subjects.forEach(sub => {
            if (sub.status !== 'current' || !sub.timeslots) return;
            const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
            const dayTs = tsList.filter(ts => (DAY_MAP[ts.day] || ts.day) === currentDay);
            if (dayTs.length > 0) {
                const earliestTime = dayTs.reduce((min, ts) => ts.time < min ? ts.time : min, '23:59');
                const group = getSubjectGroup(sub.name);
                let letter = '';
                const lowerName = sub.name.toLowerCase().trim();
                if (group === 'Math') letter = 'M';
                else if (group === 'Chinese') letter = 'C';
                else if (lowerName.includes('erp')) letter = 'R';
                else if (lowerName.includes('efl')) letter = 'L';
                else if (group === 'English') letter = 'E';

                if (letter && !seen.has(letter)) {
                    seen.add(letter);
                    daySubjects.push({ letter, time: earliestTime });
                }
            }
        });
        daySubjects.sort((a, b) => a.time.localeCompare(b.time));
        return daySubjects.map(s => s.letter).join('');
    }

    function getEffectiveLevelAndWS(sub) {
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        
        let progress = sub.progress;
        if (progress) {
            if (!Array.isArray(progress)) {
                progress = Object.values(progress);
            }
            const validProgress = progress
                .filter(p => p && p.month && p.month <= currentMonth)
                .sort((a, b) => b.month.localeCompare(a.month));
                
            if (validProgress.length > 0) {
                const latest = validProgress[0];
                const level = latest.currLevel || sub.startLevel || '-';
                const ws = latest.currWS ?? sub.startWS ?? 0;
                return { level, ws };
            }
        }
        return {
            level: sub.startLevel || '-',
            ws: sub.startWS ?? 0
        };
    }

    function buildStudentObj(s, sub, tsDay, tsList) {
        const group = getSubjectGroup(sub.name);
        if (!group) return null;
        
        const { level } = getEffectiveLevelAndWS(sub);
        const levelWS = level;

        let enType = '';
        if (group === 'English') {
            enType = sub.name.includes('EFL') ? '(L)' : sub.name.includes('ERP') ? '(R)' : '(L)';
        }
        const nextDayNum = getNextDayNum(tsList, tsDay);
        const baseName = s.nameCn || '-';
        const nick = s.nickname ? ` (${s.nickname})` : '';
        const dayOrderStr = getDaySubjectOrder(
            Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {}),
            tsDay
        );
        const indicators = [enType, nextDayNum].filter(Boolean).join('');
        const displayName = `${baseName}${nick}${indicators}${dayOrderStr ? ' ' + dayOrderStr : ''}`;

        return {
            grade: s.grade || '-',
            name: displayName,
            level: levelWS,
            worksheetType: sub.worksheetType || s.worksheetType || 'Paper' 
        };
    }

    // ============================================
    // DAY VIEW
    // ============================================
    function loadTimetable() {
        if (!daySelect || !timetableBody) return;
        showLoader();
        if (timetableUnsub) { timetableUnsub(); timetableUnsub = null; }

        const cb = (snap) => {
            cachedStudentsSnap = snap;
            timetableBody.innerHTML = '';
            const day = daySelect.value;
            const timeSlots = getTimeSlots(day);
            const schedule = {};
            timeSlots.forEach(t => schedule[t] = {
                mathLow: [], mathHigh: [], english: [], chinese: []
            });

            snap.forEach(ch => {
                const s = ch.val();
                if (!s?.subjects) return;
                const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
                subjects.forEach(sub => {
                    if (sub.status !== 'current' || !sub.timeslots) return;
                    const group = getSubjectGroup(sub.name);
                    if (!group) return;
                    const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
                    tsList.forEach(ts => {
                        const tsDay = DAY_MAP[ts.day] || ts.day;
                        if (tsDay === day && schedule[ts.time]) {
                            const studentObj = buildStudentObj(s, sub, tsDay, tsList);
                            if (!studentObj) return;
                            if (group === 'Math') {
                                if (isMathHighLevel(studentObj.level)) {
                                    schedule[ts.time].mathHigh.push(studentObj);
                                } else {
                                    schedule[ts.time].mathLow.push(studentObj);
                                }
                            } else if (group === 'English') {
                                schedule[ts.time].english.push(studentObj);
                            } else if (group === 'Chinese') {
                                schedule[ts.time].chinese.push(studentObj);
                            }
                        }
                    });
                });
            });

            Object.values(schedule).forEach(slot => {
                Object.values(slot).forEach(arr => arr.sort((a, b) => a.grade.localeCompare(b.grade)));
            });

            timeSlots.forEach(time => {
                const s = schedule[time];
                const maxRows = Math.max(s.mathLow.length, s.mathHigh.length, s.english.length, s.chinese.length);
                const rowCount = maxRows === 0 ? 2 : maxRows;
                for (let i = 0; i < rowCount; i++) {
                    const row = document.createElement('tr');
                    if (i === 0) {
                        const timeCell = document.createElement('td');
                        timeCell.textContent = time;
                        timeCell.className = 'time-cell';
                        timeCell.rowSpan = rowCount;
                        row.appendChild(timeCell);
                    }
                    const addSubjectCells = (arr) => {
                        if (arr[i]) {
                            row.appendChild(createCell(arr[i].grade));
                            row.appendChild(createCell(arr[i].name, false, arr[i].worksheetType === 'Kumon Connect'));
                            row.appendChild(createCell(arr[i].level));
                        } else {
                            row.appendChild(createCell('', true));
                            row.appendChild(createCell('', true));
                            row.appendChild(createCell('', true));
                        }
                    };
                    addSubjectCells(s.mathLow);
                    addSubjectCells(s.mathHigh);
                    addSubjectCells(s.english);
                    addSubjectCells(s.chinese);
                    timetableBody.appendChild(row);
                }
            });
            hideLoader();
        };

        function createCell(content, isEmpty = false, isKC = false) {
            const td = document.createElement('td');
            td.textContent = content;
            if (isEmpty) td.className = 'empty-cell';
            if (isKC) td.classList.add('kc-cell');
            return td;
        }

        onValue(studentsRef, cb);
        timetableUnsub = () => off(studentsRef, 'value', cb);
    }

    // ============================================
    // WEEK VIEW
    // ============================================
    function loadWeekTimetable() {
        const weekBody = document.getElementById('weekTimetableBody');
        const weekDateRow = document.getElementById('weekDateRow');
        const weekDayRow = document.getElementById('weekDayRow');
        const weekRangeLabel = document.getElementById('weekRangeLabel');
        if (!weekBody || !weekDateRow || !weekDayRow) return;

        showLoader();
        if (cachedStudentsSnap) {
            renderWeekView(cachedStudentsSnap);
            hideLoader();
        } else {
            if (weekTimetableUnsub) { weekTimetableUnsub(); weekTimetableUnsub = null; }
            const cb = (snap) => {
                cachedStudentsSnap = snap;
                renderWeekView(snap);
                hideLoader();
            };
            onValue(studentsRef, cb);
            weekTimetableUnsub = () => off(studentsRef, 'value', cb);
        }

        function renderWeekView(snap) {
            const weekDates = getWeekDates();
            const days = DAY_ORDER;

            weekDateRow.innerHTML = '<th rowspan="2" class="th-time">Time</th>';
            weekDates.forEach((wd, i) => {
                const th = document.createElement('th');
                th.textContent = `${wd.date}`;
                th.title = `${wd.month} ${wd.date}`;
                if (wd.isToday) th.classList.add('week-today-header');
                weekDateRow.appendChild(th);
            });

            weekDayRow.innerHTML = '';
            days.forEach((day, i) => {
                const th = document.createElement('th');
                th.textContent = DAY_ABBR[i];
                if (weekDates[i].isToday) th.classList.add('week-today-header');
                weekDayRow.appendChild(th);
            });

            const first = weekDates[0];
            const last = weekDates[6];
            weekRangeLabel.textContent = `Week of ${first.month} ${first.date} – ${last.month} ${last.date}, ${last.fullDate.getFullYear()}`;

            const allTimeSlots = getWeekTimeSlots();
            const schedule = {};
            allTimeSlots.forEach(time => {
                schedule[time] = {};
                days.forEach(day => { schedule[time][day] = []; });
            });

            snap.forEach(ch => {
                const s = ch.val();
                if (!s?.subjects) return;
                const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
                subjects.forEach(sub => {
                    if (sub.status !== 'current' || !sub.timeslots) return;
                    const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
                    tsList.forEach(ts => {
                        const tsDay = DAY_MAP[ts.day] || ts.day;
                        const time = ts.time;
                        if (schedule[time] && schedule[time][tsDay]) {
                            const studentObj = buildStudentObj(s, sub, tsDay, tsList);
                            if (studentObj) {
                                schedule[time][tsDay].push(studentObj);
                            }
                        }
                    });
                });
            });

            Object.values(schedule).forEach(daySchedule => {
                Object.values(daySchedule).forEach(arr => {
                    arr.sort((a, b) => a.grade.localeCompare(b.grade));
                });
            });

            const activeTimeSlots = allTimeSlots.filter(time =>
                days.some(day => schedule[time][day].length > 0)
            );

            weekBody.innerHTML = '';
            if (activeTimeSlots.length === 0) {
                const row = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 8;
                td.className = 'week-empty-msg';
                td.textContent = 'No students scheduled for this week.';
                row.appendChild(td);
                weekBody.appendChild(row);
                return;
            }

            activeTimeSlots.forEach(time => {
                const row = document.createElement('tr');
                const timeTd = document.createElement('td');
                timeTd.textContent = time;
                timeTd.className = 'week-time-cell';
                row.appendChild(timeTd);

                days.forEach((day, dayIdx) => {
                    const td = document.createElement('td');
                    td.className = 'week-cell';
                    if (weekDates[dayIdx].isToday) td.classList.add('week-today-col');

                    const students = schedule[time][day];
                    students.forEach(st => {
                        const div = document.createElement('div');
                        div.className = 'week-student';
                        
                        // ✅ CRITICAL: Add data attribute for bulletproof Excel export detection
                        if (st.worksheetType === 'Kumon Connect') {
                            div.classList.add('kc-student');
                            div.setAttribute('data-kc', 'true');
                        }

                        const gradeSpan = document.createElement('span');
                        gradeSpan.className = 'ws-grade';
                        gradeSpan.textContent = st.grade;

                        const nameSpan = document.createElement('span');
                        nameSpan.className = 'ws-name';
                        nameSpan.textContent = st.name;

                        const levelSpan = document.createElement('span');
                        levelSpan.className = 'ws-level';
                        levelSpan.textContent = st.level;

                        div.appendChild(gradeSpan);
                        div.appendChild(nameSpan);
                        div.appendChild(levelSpan);
                        td.appendChild(div);
                    });
                    row.appendChild(td);
                });
                weekBody.appendChild(row);
            });
        }
    }

    // ============================================
    // CHAMP FORMAT VIEW
    // ============================================
    function loadChampTimetable() {
        const champDaySelect = document.getElementById('champDay');
        const champBody = document.getElementById('champTimetableBody');
        if (!champDaySelect || !champBody) return;

        showLoader();

        const render = (snap) => {
            champBody.innerHTML = '';
            const day = champDaySelect.value;
            const timeSlots = getTimeSlots(day);

            const schedule = {};
            timeSlots.forEach(t => {
                schedule[t] = {
                    math6A2A: [], mathAF: [], mathGI: [], mathJO: [],
                    engK: [], engP1: [],
                    chinese: []
                };
            });

            snap.forEach(ch => {
                const s = ch.val();
                if (!s?.subjects) return;
                const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});

                subjects.forEach(sub => {
                    if (sub.status !== 'current' || !sub.timeslots) return;
                    const group = getSubjectGroup(sub.name);
                    if (!group) return;

                    const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
                    tsList.forEach(ts => {
                        const tsDay = DAY_MAP[ts.day] || ts.day;
                        if (tsDay !== day || !schedule[ts.time]) return;

                        const studentObj = buildStudentObj(s, sub, tsDay, tsList);
                        if (!studentObj) return;

                        if (group === 'Math') {
                            const bucket = getMathChampGroup(studentObj.level);
                            if (bucket) schedule[ts.time][bucket].push(studentObj);
                        } else if (group === 'English') {
                            const bucket = getEnglishChampGroup(s.grade);
                            if (bucket) schedule[ts.time][bucket].push(studentObj);
                        } else if (group === 'Chinese') {
                            schedule[ts.time].chinese.push(studentObj);
                        }
                    });
                });
            });

            const BUCKETS = ['math6A2A', 'mathAF', 'mathGI', 'mathJO', 'engK', 'engP1', 'chinese'];
            Object.values(schedule).forEach(slot => {
                BUCKETS.forEach(b => slot[b].sort((a, b) => a.grade.localeCompare(b.grade)));
            });

            timeSlots.forEach(time => {
                const s = schedule[time];
                const maxRows = Math.max(...BUCKETS.map(b => s[b].length));
                const rowCount = maxRows === 0 ? 2 : maxRows;

                for (let i = 0; i < rowCount; i++) {
                    const row = document.createElement('tr');
                    if (i === 0) {
                        const timeCell = document.createElement('td');
                        timeCell.textContent = time;
                        timeCell.className = 'time-cell';
                        timeCell.rowSpan = rowCount;
                        row.appendChild(timeCell);
                    }

                    const addSubjectCells = (arr) => {
                        if (arr[i]) {
                            row.appendChild(createChampCell(arr[i].grade));
                            row.appendChild(createChampCell(arr[i].name, false, arr[i].worksheetType === 'Kumon Connect'));
                            row.appendChild(createChampCell(arr[i].level));
                        } else {
                            row.appendChild(createChampCell('', true));
                            row.appendChild(createChampCell('', true));
                            row.appendChild(createChampCell('', true));
                        }
                    };

                    BUCKETS.forEach(b => addSubjectCells(s[b]));
                    champBody.appendChild(row);
                }
            });

            hideLoader();
        };

        function createChampCell(content, isEmpty = false, isKC = false) {
            const td = document.createElement('td');
            td.textContent = content;
            if (isEmpty) td.className = 'empty-cell';
            if (isKC) td.classList.add('kc-cell');
            return td;
        }

        if (cachedStudentsSnap) {
            render(cachedStudentsSnap);
        } else {
            const cb = (snap) => {
                cachedStudentsSnap = snap;
                render(snap);
            };
            onValue(studentsRef, cb);
        }
    }

    // ============================================
    // INITIAL LOAD
    // ============================================
    if (daySelect) {
        const today = new Date();
        const currentDayName = today.toLocaleDateString('en-US', { weekday: 'long' });
        const hasOption = Array.from(daySelect.options).some(opt => opt.value === currentDayName);
        daySelect.value = hasOption ? currentDayName : 'Monday';
        daySelect.addEventListener('change', loadTimetable);
        loadTimetable();
    }

    document.getElementById('printTimetable')?.addEventListener('click', () => window.print());
    
    const champDaySelect = document.getElementById('champDay');
    if (champDaySelect) {
        const today = new Date();
        const currentDayName = today.toLocaleDateString('en-US', { weekday: 'long' });
        const hasOption = Array.from(champDaySelect.options).some(opt => opt.value === currentDayName);
        champDaySelect.value = hasOption ? currentDayName : 'Monday';
        champDaySelect.addEventListener('change', loadChampTimetable);
        if (document.getElementById('champViewContainer')?.classList.contains('active')) {
            loadChampTimetable();
        }
    }

    // ============================================
    // ✅ EXPORT TO EXCEL (Bulletproof Nested Table Approach)
    // ============================================
    function exportToExcel() {
        let activeTable = null;
        let viewName = 'Timetable';
        
        if (document.getElementById('dayViewContainer').classList.contains('active')) {
            activeTable = document.getElementById('timetableTable');
            viewName = 'Day_View';
        } else if (document.getElementById('weekViewContainer').classList.contains('active')) {
            activeTable = document.getElementById('weekTimetableTable');
            viewName = 'Week_View';
        } else if (document.getElementById('champViewContainer').classList.contains('active')) {
            activeTable = document.getElementById('champTimetableTable');
            viewName = 'Champ_Format';
        }

        if (!activeTable) {
            alert('Please select a view to export.');
            return;
        }

        const tableClone = activeTable.cloneNode(true);

        // ✅ CRITICAL FIX: Use nested tables for Week View. 
        // Excel's HTML engine IGNORES background-color on <div> elements.
        // It ONLY reliably renders background colors on <td> elements.
        if (viewName === 'Week_View') {
            const cells = tableClone.querySelectorAll('.week-cell');
            cells.forEach(td => {
                const students = td.querySelectorAll('.week-student');
                if (students.length === 0) return;

                let innerHTML = '<table style="width:100%; border-collapse:collapse; border:none; margin:0;">';
                
                students.forEach(div => {
                    const grade = div.querySelector('.ws-grade')?.innerText || '';
                    const name = div.querySelector('.ws-name')?.innerText || '';
                    const level = div.querySelector('.ws-level')?.innerText || '';
                    
                    // Check both class and data attribute for maximum reliability
                    const isKC = div.classList.contains('kc-student') || div.getAttribute('data-kc') === 'true';
                    const bgColor = isKC ? '#fff9c4' : 'transparent';
                    
                    innerHTML += `<tr>
                        <td style="background-color:${bgColor}; padding:2px 3px; border:none; text-align:left; vertical-align:middle; font-size:9.5pt;">
                            <b style="color:#4682B4; font-size:9pt; font-weight:700;">${grade}</b> 
                            <span style="font-size:9.5pt; font-weight:500; color:#000;">${name}</span> 
                            <b style="color:#555; font-size:9pt; font-weight:600; white-space:nowrap;">${level}</b>
                        </td>
                    </tr>`;
                });
                
                innerHTML += '</table>';
                td.innerHTML = innerHTML;
            });
        }

        const excelCSS = `
            <style>
                table { border-collapse: collapse; border: 2px solid #333; font-family: 'Microsoft YaHei', 'PingFang SC', 'Segoe UI', Arial, sans-serif; font-size: 11pt; }
                th, td { border: 1px solid #333; padding: 4px 5px; text-align: center; vertical-align: middle; color: #000; }
                th { font-weight: 700; font-size: 11pt; }
                
                .th-math { background: #008B8B !important; color: #fff !important; }
                .th-english { background: #DC143C !important; color: #fff !important; }
                .th-chinese { background: #9ACD32 !important; color: #333 !important; }
                
                .th-time { background: #555 !important; color: #fff !important; }
                #weekDateRow th { background: #4682B4 !important; color: #fff !important; font-size: 13pt; }
                #weekDayRow th { background: #d0e8f5 !important; color: #333 !important; font-size: 10pt; }
                
                .time-cell, .week-time-cell { font-weight: 600; background: #f8f9fa !important; border-right: 2px solid #cbd5e1 !important; }
                .empty-cell { background: transparent !important; }
                .kc-cell { background-color: #fff9c4 !important; }
                
                .week-today-col { background: rgba(135, 206, 235, 0.15) !important; }
                .week-today-header { background: #2e6da4 !important; color: #fff !important; }
            </style>
        `;

        const htmlTemplate = `
            <html xmlns:o="urn:schemas-microsoft-com:office:office"
                xmlns:x="urn:schemas-microsoft-com:office:excel"
                xmlns="http://www.w3.org/TR/REC-html40">
            <head>
                <meta charset="UTF-8">
                <!--[if gte mso 9]><xml>
                <x:ExcelWorkbook>
                <x:ExcelWorksheets>
                <x:ExcelWorksheet>
                    <x:Name>${viewName}</x:Name>
                    <x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
                </x:ExcelWorksheet>
                </x:ExcelWorksheets>
                </x:ExcelWorkbook>
                </xml><![endif]-->
                ${excelCSS}
            </head>
            <body>
                ${tableClone.outerHTML}
            </body>
            </html>
        `;

        const blob = new Blob([htmlTemplate], { type: 'application/vnd.ms-excel' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const dateStr = new Date().toISOString().slice(0, 10);
        
        a.href = url;
        a.download = `Kumon_Timetable_${viewName}_${dateStr}.xls`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    document.getElementById('exportExcel')?.addEventListener('click', exportToExcel);

    window.addEventListener('beforeunload', () => {
        if (timetableUnsub) timetableUnsub();
        if (weekTimetableUnsub) weekTimetableUnsub();
    });
}