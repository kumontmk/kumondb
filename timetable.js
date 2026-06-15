// timetable.js
import { auth, db, logout } from './auth.js';
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

        // Check if user is admin OR has the specific permission
        const hasAccess = isAdmin || dashPerms[REQUIRED_PERMISSION] === true;

        if (hasAccess) {
            // ✅ ALLOWED: Show content, hide error
            document.getElementById('accessDenied')?.classList.add('hidden');
            document.getElementById('mainContent')?.classList.remove('hidden');
            
            // Initialize the timetable
            initializeTimetable();
        } else {
            // 🚫 BLOCKED: Hide content, show error
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

    const studentsRef = ref(db, `centers/${centerId}/students`);
    const daySelect = document.getElementById('timetableDay');
    const timetableBody = document.getElementById('timetableBody');
    let timetableUnsub = null;

    function showLoader() { 
        document.getElementById('page-loader')?.classList.remove('hidden'); 
    }
    
    function hideLoader() { 
        document.getElementById('page-loader')?.classList.add('hidden'); 
    }

    const DAY_MAP = { 
        Mon: 'Monday', 
        Tue: 'Tuesday', 
        Wed: 'Wednesday', 
        Thu: 'Thursday', 
        Fri: 'Friday', 
        Sat: 'Saturday', 
        Sun: 'Sunday' 
    };
    
    const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const DAY_TO_NUM = { 
        Monday: 1, 
        Tuesday: 2, 
        Wednesday: 3, 
        Thursday: 4, 
        Friday: 5, 
        Saturday: 6, 
        Sunday: 7 
    };

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

    // ✅ Updated to correctly route ERP/EFL to the English column
    function getSubjectGroup(name) {
        if (!name) return null;
        if (name === 'Math' || name.startsWith('Math')) return 'Math';
        if (name.includes('English') || name === 'ERP' || name === 'EFL') return 'English';
        if (name === 'Chinese') return 'Chinese';
        return null;
    }

    function isMathHighLevel(level) {
        if (!level) return false;
        return /^[F-O]/i.test(level);
    }

    // 🔢 Requirement 2: Find next scheduled day (1-7) for a subject
    function getNextDayNum(tsList, currentDay) {
        const days = [...new Set(tsList.map(ts => DAY_MAP[ts.day] || ts.day))];
        if (days.length <= 1) return ''; // Comes only once per week
        const currentIdx = DAY_ORDER.indexOf(currentDay);
        const dayNums = days.map(d => DAY_TO_NUM[d] || 0).filter(n => n > 0);

        let next = dayNums.find(n => n > currentIdx + 1);
        if (next === undefined) next = Math.min(...dayNums); // Wrap around to Monday if needed
        return String(next);
    }

    // 📅 Requirement 3: Get chronological subject order for the day (e.g., MRC)
    function getDaySubjectOrder(subjects, currentDay) {
        const daySubjects = [];
        const seen = new Set();
        
        subjects.forEach(sub => {
            if (sub.status === 'drop' || !sub.timeslots) return;
            const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
            const dayTs = tsList.filter(ts => (DAY_MAP[ts.day] || ts.day) === currentDay);
            
            if (dayTs.length > 0) {
                const earliestTime = dayTs.reduce((min, ts) => ts.time < min ? ts.time : min, '23:59');
                const group = getSubjectGroup(sub.name);
                let letter = 'E';
                if (group === 'Math') letter = 'M';
                else if (group === 'Chinese') letter = 'C';
                else if (sub.name.includes('ERP')) letter = 'R';
                else if (sub.name.includes('EFL')) letter = 'L';
                else if (group === 'English') letter = 'E';

                if (!seen.has(letter)) {
                    seen.add(letter);
                    daySubjects.push({ letter, time: earliestTime });
                }
            }
        });

        daySubjects.sort((a, b) => a.time.localeCompare(b.time));
        return daySubjects.map(s => s.letter).join('');
    }

    function loadTimetable() {
        if (!daySelect || !timetableBody) return;
        showLoader();
        
        if (timetableUnsub) { 
            timetableUnsub(); 
            timetableUnsub = null; 
        }
        
        const cb = (snap) => {
            timetableBody.innerHTML = '';
            const day = daySelect.value;
            const timeSlots = getTimeSlots(day);
            const schedule = {};
            
            timeSlots.forEach(t => schedule[t] = { 
                mathLow: [], 
                mathHigh: [], 
                english: [], 
                chinese: [] 
            });

            snap.forEach(ch => {
                const s = ch.val();
                if (!s?.subjects) return;
                const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});

                // ✅ Pre-calculate daily subject order string for this student
                const dayOrderStr = getDaySubjectOrder(subjects, day);

                subjects.forEach(sub => {
                    if (sub.status === 'drop' || !sub.timeslots) return;
                    const group = getSubjectGroup(sub.name);
                    if (!group) return;

                    const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
                    tsList.forEach(ts => {
                        const tsDay = DAY_MAP[ts.day] || ts.day;
                        if (tsDay === day && schedule[ts.time]) {
                            const level = sub.currentLevel || sub.startLevel || '-';
                            const ws = sub.currentWS ?? sub.startWS ?? 0;
                            const levelWS = `${level}${ws}`;

                            // ✅ Requirement 1: EFL vs ERP indicator
                            let enType = '';
                            if (group === 'English') {
                                enType = sub.name.includes('EFL') ? '(L)' : sub.name.includes('ERP') ? '(R)' : '(L)';
                            }

                            // ✅ Requirement 2: Next day indicator
                            const nextDayNum = getNextDayNum(tsList, day);

                            // ✅ Build formatted display name
                            const baseName = s.nameCn || '-';
                            const nick = s.nickname ? ` (${s.nickname})` : '';
                            const indicators = [enType, nextDayNum].filter(Boolean).join('');
                            const displayName = `${baseName}${nick}${indicators}${dayOrderStr ? ' ' + dayOrderStr : ''}`;

                            const studentObj = { 
                                grade: s.grade || '-', 
                                name: displayName, 
                                level: levelWS 
                            };

                            if (group === 'Math') {
                                if (isMathHighLevel(level)) {
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

            // Sort by grade within each group
            Object.values(schedule).forEach(slot => {
                Object.values(slot).forEach(arr => arr.sort((a, b) => a.grade.localeCompare(b.grade)));
            });

            // Build rows
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
                            row.appendChild(createCell(arr[i].name));
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

        function createCell(content, isEmpty = false) {
            const td = document.createElement('td');
            td.textContent = content;
            if (isEmpty) td.className = 'empty-cell';
            return td;
        }

        onValue(studentsRef, cb);
        timetableUnsub = () => off(studentsRef, 'value', cb);
    }

    if (daySelect) {
        // ✅ Automatically select today's day on page load
        const today = new Date();
        const currentDayName = today.toLocaleDateString('en-US', { weekday: 'long' });
        const hasOption = Array.from(daySelect.options).some(opt => opt.value === currentDayName);
        daySelect.value = hasOption ? currentDayName : 'Monday';

        daySelect.addEventListener('change', loadTimetable);
        loadTimetable();
    }

    document.getElementById('printTimetable')?.addEventListener('click', () => window.print());
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => { 
        if (timetableUnsub) timetableUnsub(); 
    });
}