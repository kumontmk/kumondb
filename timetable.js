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

    // ✅ UPDATED: Fetch all centers instead of just the current one
    const centersRef = ref(db, 'centers');
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
    const champViewContainer = document.getElementById('champViewContainer');

    function setPrintActive(container) {
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('print-active'));
        if (container) {
            container.classList.add('print-active');
        }
    }

    function syncPrintActiveToActiveTab() {
        const activePane =
            document.querySelector('.tab-content.active') ||
            document.querySelector('.tab-content.print-active') ||
            dayViewContainer;
        setPrintActive(activePane);
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.dataset.tab;
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            if (targetTab === 'dayView') {
                dayViewContainer.classList.add('active');
                setPrintActive(dayViewContainer);
                if (daySelect) loadTimetable();
            } else if (targetTab === 'weekView') {
                weekViewContainer.classList.add('active');
                setPrintActive(weekViewContainer);
                loadWeekTimetable();
            } else if (targetTab === 'champView') {
                if (champViewContainer) {
                    champViewContainer.classList.add('active');
                    setPrintActive(champViewContainer);
                }
                loadChampTimetable();
            }
        });
    });

    syncPrintActiveToActiveTab();

    function showLoader() { document.getElementById('page-loader')?.classList.remove('hidden'); }
    function hideLoader() { document.getElementById('page-loader')?.classList.add('hidden'); }

    const DAY_MAP = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
    const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const DAY_TO_NUM = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
    const DAY_ABBR = ['MON', 'TUES', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

    function toISODate(dateObj) {
        return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
    }

    function buildClassChangeStudentObj(cc) {
        const baseName = cc.nameCn || cc.nameEn || 'Unknown';
        const nick = cc.nickname ? ` (${cc.nickname})` : '';
        return {
            grade: cc.grade || '-',
            name: `${baseName}${nick} [CC]`,
            level: cc.subjectLevel || '-',
            worksheetType: cc.worksheetType || 'Paper',
            isClassChange: true
        };
    }

    const DAY_NUMBER_TO_NAME = { 0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };
    const DAY_ALIASES = {
        monday: 'Monday', mon: 'Monday', tuesday: 'Tuesday', tue: 'Tuesday', tues: 'Tuesday',
        wednesday: 'Wednesday', wed: 'Wednesday', weds: 'Wednesday',
        thursday: 'Thursday', thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday',
        friday: 'Friday', fri: 'Friday', saturday: 'Saturday', sat: 'Saturday', sunday: 'Sunday', sun: 'Sunday',
        '周一': 'Monday', '星期一': 'Monday', '礼拜一': 'Monday', '周二': 'Tuesday', '星期二': 'Tuesday', '礼拜二': 'Tuesday',
        '周三': 'Wednesday', '星期三': 'Wednesday', '礼拜三': 'Wednesday', '周四': 'Thursday', '星期四': 'Thursday', '礼拜四': 'Thursday',
        '周五': 'Friday', '星期五': 'Friday', '礼拜五': 'Friday', '周六': 'Saturday', '星期六': 'Saturday', '礼拜六': 'Saturday',
        '周日': 'Sunday', '星期日': 'Sunday', '周天': 'Sunday', '星期天': 'Sunday', '礼拜天': 'Sunday', '礼拜日': 'Sunday'
    };

    function normalizeWeekday(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        if (typeof raw === 'number') return DAY_NUMBER_TO_NAME[raw] || null;
        const original = String(raw).trim().toLowerCase();
        if (DAY_ALIASES[original]) return DAY_ALIASES[original];
        const cleaned = original.replace(/[^\p{L}\p{N}]+/gu, '');
        if (!cleaned) return null;
        if (/^\d+$/.test(cleaned)) return DAY_NUMBER_TO_NAME[Number(cleaned)] || null;
        return DAY_ALIASES[cleaned] || DAY_ALIASES[cleaned.slice(0, 3)] || null;
    }

    function normalizeTime(raw) {
        if (raw === null || raw === undefined || raw === '') return '';
        let value = String(raw).trim();
        if (/^\d{4}$/.test(value)) value = `${value.slice(0, 2)}:${value.slice(2)}`;
        if (/^\d{3}$/.test(value)) value = `0${value.slice(0, 1)}:${value.slice(1)}`;
        const match = value.match(/^(\d{1,2}):([0-5]?\d)$/);
        if (!match) return '';
        const h = Number(match[1]);
        const m = Number(match[2]);
        if (h < 0 || h > 23 || m < 0 || m > 59) return '';
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function getTsDay(ts) { return normalizeWeekday(DAY_MAP?.[ts?.day] ?? ts?.day); }
    function getTsTime(ts) { return normalizeTime(ts?.time); }

    function warnInvalidTimeslot(context, centerSnap, centerData, s, sub, ts, extra = {}) {
        console.warn(`[Timetable:${context}] Skipping invalid timeslot`, {
            center: centerSnap?.key, centerName: centerData?.name,
            student: s?.nameCn || s?.name || s?.id, subject: sub?.name, timeslot: ts, ...extra
        });
    }

    function isSubjectActiveOnDate(sub, targetDate) {
        if (!sub || !targetDate) return false;
        const tM = targetDate.getMonth() + 1;
        const tY = targetDate.getFullYear();

        if (sub.resumeRequest && sub.resumeRequest.returnMonth && sub.resumeRequest.returnYear) {
            const rM = parseInt(sub.resumeRequest.returnMonth);
            const rY = parseInt(sub.resumeRequest.returnYear);
            if (rY < tY || (rY === tY && rM <= tM)) return true;
        }

        if (sub.status === 'drop') {
            const dM = parseInt(sub.dropMonth);
            const dY = parseInt(sub.dropYear);
            if (dY < tY || (dY === tY && dM <= tM)) return false;
        } else if (sub.status === 'pause') {
            const pfM = parseInt(sub.pauseFromMonth);
            const pfY = parseInt(sub.pauseFromYear);
            const ptM = sub.pauseToMonth ? parseInt(sub.pauseToMonth) : null;
            const ptY = sub.pauseToYear ? parseInt(sub.pauseToYear) : null;
            const isAfterFrom = (pfY < tY || (pfY === tY && pfM <= tM));
            const isBeforeTo = !ptM || !ptY || (ptY > tY || (ptY === tY && ptM >= tM));
            if (isAfterFrom && isBeforeTo) return false;
        } else if (sub.status === 'inquiry') {
            return false;
        }

        if (sub.pendingRequest && !sub.pendingRequest.cancelled) {
            const pr = sub.pendingRequest;
            if (pr.type === 'drop') {
                const dM = parseInt(pr.dropMonth);
                const dY = parseInt(pr.dropYear);
                if (dY < tY || (dY === tY && dM <= tM)) return false;
            } else if (pr.type === 'pause') {
                const pfM = parseInt(pr.pauseFromMonth);
                const pfY = parseInt(pr.pauseFromYear);
                const ptM = pr.pauseToMonth ? parseInt(pr.pauseToMonth) : null;
                const ptY = pr.pauseToYear ? parseInt(pr.pauseToYear) : null;
                const isAfterFrom = (pfY < tY || (pfY === tY && pfM <= tM));
                const isBeforeTo = !ptM || !ptY || (ptY > tY || (ptY === tY && ptM >= tM));
                if (isAfterFrom && isBeforeTo) return false;
            }
        }
        return sub.status === 'current';
    }

    function getDayViewHeaderInfo(selectedDay) {
        const today = new Date();
        const currentDayNum = today.getDay();
        const targetDayMap = { 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 'Friday': 5, 'Saturday': 6, 'Sunday': 0 };
        const targetDayNum = targetDayMap[selectedDay];
        let daysToAdd = targetDayNum - currentDayNum;
        if (daysToAdd < 0) daysToAdd += 7;
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + daysToAdd);
        const dd = targetDate.getDate();
        const mm = targetDate.getMonth() + 1;
        const dateStr = `${dd}/${mm}`;
        const dayOfWeekNum = targetDayNum === 0 ? 7 : targetDayNum;
        const dayStr = `${dayOfWeekNum} - ${selectedDay}`;
        return { dateStr, dayStr, targetDate };
    }

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
            minutes.forEach(m => { slots.push(`${String(h).padStart(2, '0')}:${m}`); });
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
            dates.push({ date: d.getDate(), month: d.toLocaleString('en', { month: 'short' }), fullDate: d, isToday: d.toDateString() === today.toDateString() });
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
        const days = [...new Set(tsList.map(ts => getTsDay(ts)).filter(Boolean))];
        if (days.length <= 1) return '';
        const currentIdx = DAY_ORDER.indexOf(currentDay);
        const dayNums = days.map(d => DAY_TO_NUM[d] || 0).filter(n => n > 0);
        let next = dayNums.find(n => n > currentIdx + 1);
        if (next === undefined) next = Math.min(...dayNums);
        return String(next);
    }

    function getDaySubjectOrder(subjects, currentDay, targetDate) {
        const daySubjects = [];
        const seen = new Set();
        subjects.forEach(sub => {
            if (!isSubjectActiveOnDate(sub, targetDate) || !sub.timeslots) return;
            const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
            const dayTs = tsList.map(ts => ({ ts, day: getTsDay(ts), time: getTsTime(ts) })).filter(item => item.day === currentDay && item.time);
            if (dayTs.length > 0) {
                const earliestTime = dayTs.reduce((min, item) => item.time < min ? item.time : min, '23:59');
                const group = getSubjectGroup(sub.name);
                let letter = '';
                const lowerName = sub.name.toLowerCase().trim();
                if (group === 'Math') letter = 'M';
                else if (group === 'Chinese') letter = 'C';
                else if (lowerName.includes('erp')) letter = 'R';
                else if (lowerName.includes('efl')) letter = 'L';
                else if (group === 'English') letter = 'E';
                if (letter && !seen.has(letter)) { seen.add(letter); daySubjects.push({ letter, time: earliestTime }); }
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
            if (!Array.isArray(progress)) progress = Object.values(progress);
            const validProgress = progress.filter(p => p && p.month && p.month <= currentMonth).sort((a, b) => b.month.localeCompare(a.month));
            if (validProgress.length > 0) {
                const latest = validProgress[0];
                return { level: latest.currLevel || sub.startLevel || '-', ws: latest.currWS ?? sub.startWS ?? 0 };
            }
        }
        return { level: sub.startLevel || '-', ws: sub.startWS ?? 0 };
    }

    function buildStudentObj(s, sub, tsDay, tsList, targetDate) {
        const group = getSubjectGroup(sub.name);
        if (!group) return null;
        const { level } = getEffectiveLevelAndWS(sub);
        let enType = '';
        if (group === 'English') { enType = sub.name.includes('EFL') ? '(L)' : sub.name.includes('ERP') ? '(R)' : '(L)'; }
        const nextDayNum = getNextDayNum(tsList, tsDay);
        const baseName = s.nameCn || '-';
        const nick = s.nickname ? ` (${s.nickname})` : '';
        const dayOrderStr = getDaySubjectOrder(Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {}), tsDay, targetDate);
        const indicators = [enType, nextDayNum].filter(Boolean).join('');
        const displayName = `${baseName}${nick}${indicators}${dayOrderStr ? ' ' + dayOrderStr : ''}`;
        return { grade: s.grade || '-', name: displayName, level: level, worksheetType: sub.worksheetType || s.worksheetType || 'Paper' };
    }

    function buildMobileStudentRow(st) {
        const li = document.createElement('li');
        li.className = 'mobile-student';
        if (st.worksheetType === 'Kumon Connect') li.classList.add('kc');
        const grade = document.createElement('span'); grade.className = 'm-grade'; grade.textContent = st.grade;
        const name = document.createElement('span'); name.className = 'm-name'; name.textContent = st.name;
        const level = document.createElement('span'); level.className = 'm-level'; level.textContent = st.level;
        li.append(grade, name, level);
        return li;
    }

    function buildMobileGroup(label, cls, students) {
        if (!students || !students.length) return null;
        const sec = document.createElement('section'); sec.className = 'mobile-group ' + cls;
        const h = document.createElement('h4'); h.textContent = label;
        const ul = document.createElement('ul');
        students.forEach(st => ul.appendChild(buildMobileStudentRow(st)));
        sec.append(h, ul);
        return sec;
    }

    function renderDayMobile(containerId, schedule, timeSlots, groupsFn) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        const active = timeSlots.filter(t => groupsFn(schedule[t]).some(g => g.students.length > 0));
        if (!active.length) { container.innerHTML = '<p class="mobile-empty">No students scheduled for this day.</p>'; return; }
        active.forEach(time => {
            const card = document.createElement('article'); card.className = 'slot-card';
            const head = document.createElement('div'); head.className = 'slot-time'; head.textContent = time;
            card.appendChild(head);
            groupsFn(schedule[time]).forEach(g => {
                const sec = buildMobileGroup(g.label, g.cls, g.students);
                if (sec) card.appendChild(sec);
            });
            container.appendChild(card);
        });
    }

    function renderWeekMobile(schedule, days, weekDates) {
        const chips = document.getElementById('weekMobileChips');
        const list = document.getElementById('weekMobileList');
        if (!chips || !list) return;
        chips.innerHTML = ''; list.innerHTML = '';
        const dayEntries = days.map(day => Object.keys(schedule).sort().filter(time => schedule[time][day].length > 0).map(time => ({ time, students: schedule[time][day] })));
        let selected = Math.max(0, weekDates.findIndex(w => w.isToday));
        function renderList() {
            list.innerHTML = '';
            const entries = dayEntries[selected];
            if (!entries.length) { list.innerHTML = '<p class="mobile-empty">No students scheduled for this day.</p>'; return; }
            entries.forEach(e => {
                const card = document.createElement('article'); card.className = 'slot-card';
                const head = document.createElement('div'); head.className = 'slot-time'; head.textContent = e.time;
                const ul = document.createElement('ul'); ul.className = 'mobile-flat';
                e.students.forEach(st => ul.appendChild(buildMobileStudentRow(st)));
                card.append(head, ul); list.appendChild(card);
            });
        }
        days.forEach((day, i) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'day-chip' + (i === selected ? ' active' : '');
            if (weekDates[i].isToday) chip.classList.add('today');
            chip.textContent = DAY_ABBR[i];
            chip.addEventListener('click', () => {
                selected = i;
                chips.querySelectorAll('.day-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                renderList();
            });
            chips.appendChild(chip);
        });
        renderList();
    }

    const dayGroupsFn = (s) => [
        { label: 'Math (6A–E)', cls: 'g-math', students: s.mathLow },
        { label: 'Math (F+)', cls: 'g-math', students: s.mathHigh },
        { label: 'English', cls: 'g-english', students: s.english },
        { label: 'Chinese', cls: 'g-chinese', students: s.chinese }
    ];
    const champGroupsFn = (s) => [
        { label: 'Math (6A–2A)', cls: 'g-math', students: s.math6A2A },
        { label: 'Math (A–F)', cls: 'g-math', students: s.mathAF },
        { label: 'Math (G–I)', cls: 'g-math', students: s.mathGI },
        { label: 'Math (J–O)', cls: 'g-math', students: s.mathJO },
        { label: 'English (K0–K3)', cls: 'g-english', students: s.engK },
        { label: 'English (P1+)', cls: 'g-english', students: s.engP1 },
        { label: 'Chinese', cls: 'g-chinese', students: s.chinese }
    ];

    // ============================================
    // DAY VIEW
    // ============================================
    function loadTimetable() {
        if (!daySelect || !timetableBody) return;
        showLoader();
        if (timetableUnsub) { timetableUnsub(); timetableUnsub = null; }

        const cb = (snap) => {
            try {
                cachedStudentsSnap = snap;
                timetableBody.innerHTML = '';
                const day = daySelect.value;
                const headerDateEl = document.querySelector('#dayViewHeaderRow .header-date');
                const headerDayEl = document.querySelector('#dayViewHeaderRow .header-day');
                const info = getDayViewHeaderInfo(day);
                const targetDate = info.targetDate;
                if (headerDateEl && headerDayEl) {
                    headerDateEl.textContent = info.dateStr;
                    headerDayEl.textContent = info.dayStr;
                }

                const timeSlots = getTimeSlots(day);
                const schedule = {};
                timeSlots.forEach(t => schedule[t] = { mathLow: [], mathHigh: [], english: [], chinese: [] });

                snap.forEach(centerSnap => {
                    const centerData = centerSnap.val();
                    if (!centerData?.students) return;
                    Object.values(centerData.students).forEach(s => {
                        if (!s?.subjects) return;
                        const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
                        subjects.forEach(sub => {
                            if (!isSubjectActiveOnDate(sub, targetDate) || !sub.timeslots) return;
                            const group = getSubjectGroup(sub.name);
                            if (!group) return;
                            const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
                            tsList.forEach(ts => {
                                if (!ts) return;
                                const tsCenter = ts.center || centerSnap.key;
                                if (tsCenter !== centerId) return;
                                const tsDay = getTsDay(ts);
                                const time = getTsTime(ts);
                                if (!tsDay || !time) { warnInvalidTimeslot('Day View', centerSnap, centerData, s, sub, ts); return; }
                                if (tsDay === day && schedule[time]) {
                                    const studentObj = buildStudentObj(s, sub, tsDay, tsList, targetDate);
                                    if (!studentObj) return;
                                    if (group === 'Math') { if (isMathHighLevel(studentObj.level)) schedule[time].mathHigh.push(studentObj); else schedule[time].mathLow.push(studentObj); }
                                    else if (group === 'English') schedule[time].english.push(studentObj);
                                    else if (group === 'Chinese') schedule[time].chinese.push(studentObj);
                                }
                            });
                        });
                    });
                });

                // ============================================
                // 🔄 ADD CLASS CHANGE REPLACEMENTS — DAY VIEW (Runs ONCE)
                // ============================================
                const targetISO = toISODate(targetDate);
                const classChangesSnap = snap.child(`${centerId}/classChanges`);

                if (classChangesSnap.exists()) {
                    classChangesSnap.forEach((child) => {
                        const cc = child.val();
                        if (!cc) return;
                        if (cc.replacementStatus !== 'scheduled') return;
                        if (cc.replacementDate !== targetISO) return;
                        const time = normalizeTime(cc.replacementTime);
                        const group = getSubjectGroup(cc.subject);
                        if (!time || !group || !schedule[time]) return;
                        const studentObj = buildClassChangeStudentObj(cc);
                        if (group === 'Math') { if (isMathHighLevel(studentObj.level)) schedule[time].mathHigh.push(studentObj); else schedule[time].mathLow.push(studentObj); }
                        else if (group === 'English') schedule[time].english.push(studentObj);
                        else if (group === 'Chinese') schedule[time].chinese.push(studentObj);
                    });
                }

                Object.values(schedule).forEach(slot => { Object.values(slot).forEach(arr => arr.sort((a, b) => a.grade.localeCompare(b.grade))); });

                timeSlots.forEach(time => {
                    const s = schedule[time];
                    const maxRows = Math.max(s.mathLow.length, s.mathHigh.length, s.english.length, s.chinese.length);
                    const rowCount = maxRows === 0 ? 2 : maxRows;
                    const isEmptyTimeSlot = maxRows === 0;
                    for (let i = 0; i < rowCount; i++) {
                        const row = document.createElement('tr');
                        if (isEmptyTimeSlot) row.classList.add('empty-time-row');
                        if (i === 0) {
                            const timeCell = document.createElement('td');
                            timeCell.textContent = time; timeCell.className = 'time-cell'; timeCell.rowSpan = rowCount;
                            row.appendChild(timeCell);
                        }
                        const addSubjectCells = (arr) => {
                            if (arr[i]) {
                                row.appendChild(createCell(arr[i].grade));
                                row.appendChild(createCell(arr[i].name, false, arr[i].worksheetType === 'Kumon Connect', !!arr[i].isClassChange));
                                row.appendChild(createCell(arr[i].level));
                            } else {
                                row.appendChild(createCell('', true));
                                row.appendChild(createCell('', true));
                                row.appendChild(createCell('', true));
                            }
                        };
                        addSubjectCells(s.mathLow); addSubjectCells(s.mathHigh); addSubjectCells(s.english); addSubjectCells(s.chinese);
                        timetableBody.appendChild(row);
                    }
                });
            } catch (err) {
                console.error('[Day View] Rendering failed:', err);
                if (timetableBody) timetableBody.innerHTML = `<tr><td colspan="13" class="week-empty-msg">Failed to load day timetable.</td></tr>`;
            } finally { hideLoader(); }
        };

        function createCell(content, isEmpty = false, isKC = false, isCC = false) {
            const td = document.createElement('td'); td.textContent = content;
            if (isEmpty) td.className = 'empty-cell';
            if (isKC) td.classList.add('kc-cell');
            if (isCC) td.classList.add('cc-cell');
            return td;
        }

        onValue(centersRef, cb);
        timetableUnsub = () => off(centersRef, 'value', cb);
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

        function renderWeekViewSafely(snap) {
            try { renderWeekView(snap); } catch (err) {
                console.error('[Week View] Rendering failed:', err);
                if (weekBody) weekBody.innerHTML = `<tr><td colspan="8" class="week-empty-msg">Failed to load week timetable.</td></tr>`;
            } finally { hideLoader(); }
        }

        if (cachedStudentsSnap) renderWeekViewSafely(cachedStudentsSnap);
        else {
            if (weekTimetableUnsub) { weekTimetableUnsub(); weekTimetableUnsub = null; }
            const cb = (snap) => { cachedStudentsSnap = snap; renderWeekViewSafely(snap); };
            onValue(centersRef, cb);
            weekTimetableUnsub = () => off(centersRef, 'value', cb);
        }

        function renderWeekView(snap) {
            const weekDates = getWeekDates();
            const days = DAY_ORDER;
            weekDateRow.innerHTML = '<th rowspan="2" class="th-time">Time</th>';
            weekDates.forEach((wd, i) => {
                const th = document.createElement('th'); th.textContent = `${wd.date}`; th.title = `${wd.month} ${wd.date}`;
                if (wd.isToday) th.classList.add('week-today-header');
                weekDateRow.appendChild(th);
            });
            weekDayRow.innerHTML = '';
            days.forEach((day, i) => {
                const th = document.createElement('th'); th.textContent = DAY_ABBR[i];
                if (weekDates[i].isToday) th.classList.add('week-today-header');
                weekDayRow.appendChild(th);
            });
            const first = weekDates[0], last = weekDates[6];
            weekRangeLabel.textContent = `Week of ${first.month} ${first.date} – ${last.month} ${last.date}, ${last.fullDate.getFullYear()}`;

            const allTimeSlots = getWeekTimeSlots();
            const schedule = {};
            allTimeSlots.forEach(time => { schedule[time] = {}; days.forEach(day => { schedule[time][day] = []; }); });

            snap.forEach(centerSnap => {
                const centerData = centerSnap.val();
                if (!centerData?.students) return;
                Object.values(centerData.students).forEach(s => {
                    if (!s?.subjects) return;
                    const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
                    subjects.forEach(sub => {
                        if (!sub.timeslots) return;
                        const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
                        tsList.forEach(ts => {
                            if (!ts) return;
                            const tsCenter = ts.center || centerSnap.key;
                            if (tsCenter !== centerId) return;
                            const tsDay = getTsDay(ts); const time = getTsTime(ts);
                            if (!tsDay || !time) { warnInvalidTimeslot('Week View', centerSnap, centerData, s, sub, ts, { reason: 'Missing or invalid day/time' }); return; }
                            const dayIdx = days.indexOf(tsDay);
                            if (dayIdx === -1 || !weekDates[dayIdx]?.fullDate) { warnInvalidTimeslot('Week View', centerSnap, centerData, s, sub, ts, { reason: 'Weekday not recognized', tsDay }); return; }
                            if (!schedule[time] || !schedule[time][tsDay]) { warnInvalidTimeslot('Week View', centerSnap, centerData, s, sub, ts, { reason: 'Time is outside the week timetable grid', time, tsDay }); return; }
                            const targetDate = weekDates[dayIdx].fullDate;
                            if (!isSubjectActiveOnDate(sub, targetDate)) return;
                            if (schedule[time] && schedule[time][tsDay]) {
                                const studentObj = buildStudentObj(s, sub, tsDay, tsList, targetDate);
                                if (studentObj) schedule[time][tsDay].push(studentObj);
                            }
                        });
                    });
                });
            });

            // ============================================
            // 🔄 ADD CLASS CHANGE REPLACEMENTS — WEEK VIEW (Runs ONCE)
            // ============================================
            const classChangesSnap = snap.child(`${centerId}/classChanges`);
            if (classChangesSnap.exists()) {
                classChangesSnap.forEach((child) => {
                    const cc = child.val();
                    if (!cc) return;
                    if (cc.replacementStatus !== 'scheduled') return;
                    if (!cc.replacementDate) return;
                    const dayIdx = weekDates.findIndex((w) => toISODate(w.fullDate) === cc.replacementDate);
                    if (dayIdx === -1) return;
                    const time = normalizeTime(cc.replacementTime);
                    const tsDay = days[dayIdx];
                    if (!time || !schedule[time] || !schedule[time][tsDay]) return;
                    schedule[time][tsDay].push(buildClassChangeStudentObj(cc));
                });
            }

            Object.values(schedule).forEach(daySchedule => {
                Object.values(daySchedule).forEach(arr => { arr.sort((a, b) => a.grade.localeCompare(b.grade)); });
            });

            const activeTimeSlots = allTimeSlots.filter(time => days.some(day => schedule[time][day].length > 0));
            weekBody.innerHTML = '';
            if (activeTimeSlots.length === 0) {
                const row = document.createElement('tr');
                const td = document.createElement('td'); td.colSpan = 8; td.className = 'week-empty-msg'; td.textContent = 'No students scheduled for this week.';
                row.appendChild(td); weekBody.appendChild(row); return;
            }

            activeTimeSlots.forEach(time => {
                const row = document.createElement('tr');
                const timeTd = document.createElement('td'); timeTd.textContent = time; timeTd.className = 'week-time-cell'; row.appendChild(timeTd);
                days.forEach((day, dayIdx) => {
                    const td = document.createElement('td'); td.className = 'week-cell';
                    if (weekDates[dayIdx].isToday) td.classList.add('week-today-col');
                    const students = schedule[time][day];
                    students.forEach(st => {
                        const div = document.createElement('div'); div.className = 'week-student';
                        if (st.isClassChange) div.classList.add('cc-student');
                        if (st.worksheetType === 'Kumon Connect') { div.classList.add('kc-student'); div.setAttribute('data-kc', 'true'); }
                        const gradeSpan = document.createElement('span'); gradeSpan.className = 'ws-grade'; gradeSpan.textContent = st.grade;
                        const nameSpan = document.createElement('span'); nameSpan.className = 'ws-name'; nameSpan.textContent = st.name;
                        const levelSpan = document.createElement('span'); levelSpan.className = 'ws-level'; levelSpan.textContent = st.level;
                        div.appendChild(gradeSpan); div.appendChild(nameSpan); div.appendChild(levelSpan);
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
            try {
                champBody.innerHTML = '';
                const day = champDaySelect.value;
                const info = getDayViewHeaderInfo(day);
                const targetDate = info.targetDate;
                const timeSlots = getTimeSlots(day);
                const schedule = {};
                timeSlots.forEach(t => { schedule[t] = { math6A2A: [], mathAF: [], mathGI: [], mathJO: [], engK: [], engP1: [], chinese: [] }; });

                snap.forEach(centerSnap => {
                    const centerData = centerSnap.val();
                    if (!centerData?.students) return;
                    Object.values(centerData.students).forEach(s => {
                        if (!s?.subjects) return;
                        const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
                        subjects.forEach(sub => {
                            if (!isSubjectActiveOnDate(sub, targetDate) || !sub.timeslots) return;
                            const group = getSubjectGroup(sub.name);
                            if (!group) return;
                            const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
                            tsList.forEach(ts => {
                                if (!ts) return;
                                const tsCenter = ts.center || centerSnap.key;
                                if (tsCenter !== centerId) return;
                                const tsDay = getTsDay(ts); const time = getTsTime(ts);
                                if (!tsDay || !time) { warnInvalidTimeslot('Champ View', centerSnap, centerData, s, sub, ts); return; }
                                if (tsDay !== day || !schedule[time]) return;
                                const studentObj = buildStudentObj(s, sub, tsDay, tsList, targetDate);
                                if (!studentObj) return;
                                if (group === 'Math') { const bucket = getMathChampGroup(studentObj.level); if (bucket) schedule[time][bucket].push(studentObj); }
                                else if (group === 'English') { const bucket = getEnglishChampGroup(s.grade); if (bucket) schedule[time][bucket].push(studentObj); }
                                else if (group === 'Chinese') schedule[time].chinese.push(studentObj);
                            });
                        });
                    });
                });

                // ============================================
                // 🔄 ADD CLASS CHANGE REPLACEMENTS — CHAMP VIEW (Runs ONCE)
                // ============================================
                const champTargetISO = toISODate(targetDate);
                const champCCSnap = snap.child(`${centerId}/classChanges`);
                if (champCCSnap.exists()) {
                    champCCSnap.forEach((child) => {
                        const cc = child.val();
                        if (!cc) return;
                        if (cc.replacementStatus !== 'scheduled') return;
                        if (cc.replacementDate !== champTargetISO) return;
                        const time = normalizeTime(cc.replacementTime);
                        const group = getSubjectGroup(cc.subject);
                        if (!time || !group || !schedule[time]) return;
                        const studentObj = buildClassChangeStudentObj(cc);
                        if (group === 'Math') { const bucket = getMathChampGroup(studentObj.level); if (bucket) schedule[time][bucket].push(studentObj); }
                        else if (group === 'English') { const bucket = getEnglishChampGroup(cc.grade); if (bucket) schedule[time][bucket].push(studentObj); }
                        else if (group === 'Chinese') schedule[time].chinese.push(studentObj);
                    });
                }

                const BUCKETS = ['math6A2A', 'mathAF', 'mathGI', 'mathJO', 'engK', 'engP1', 'chinese'];
                Object.values(schedule).forEach(slot => { BUCKETS.forEach(b => slot[b].sort((a, b) => a.grade.localeCompare(b.grade))); });

                timeSlots.forEach(time => {
                    const s = schedule[time];
                    const maxRows = Math.max(...BUCKETS.map(b => s[b].length));
                    const rowCount = maxRows === 0 ? 2 : maxRows;
                    const isEmptyTimeSlot = maxRows === 0;
                    for (let i = 0; i < rowCount; i++) {
                        const row = document.createElement('tr');
                        if (isEmptyTimeSlot) row.classList.add('empty-time-row');
                        if (i === 0) {
                            const timeCell = document.createElement('td');
                            timeCell.textContent = time; timeCell.className = 'time-cell'; timeCell.rowSpan = rowCount;
                            row.appendChild(timeCell);
                        }
                        const addSubjectCells = (arr) => {
                            if (arr[i]) {
                                row.appendChild(createChampCell(arr[i].grade));
                                row.appendChild(createChampCell(arr[i].name, false, arr[i].worksheetType === 'Kumon Connect', !!arr[i].isClassChange));
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
            } catch (err) {
                console.error('[Champ View] Rendering failed:', err);
                if (champBody) champBody.innerHTML = `<tr><td colspan="22" class="week-empty-msg">Failed to load Champ Format timetable.</td></tr>`;
            } finally { hideLoader(); }
        };

        function createChampCell(content, isEmpty = false, isKC = false, isCC = false) {
            const td = document.createElement('td'); td.textContent = content;
            if (isEmpty) td.className = 'empty-cell';
            if (isKC) td.classList.add('kc-cell');
            if (isCC) td.classList.add('cc-cell');
            return td;
        }

        if (cachedStudentsSnap) render(cachedStudentsSnap);
        else {
            const cb = (snap) => { cachedStudentsSnap = snap; render(snap); };
            onValue(centersRef, cb);
        }
    }

    if (daySelect) {
        const today = new Date();
        const currentDayName = today.toLocaleDateString('en-US', { weekday: 'long' });
        const hasOption = Array.from(daySelect.options).some(opt => opt.value === currentDayName);
        daySelect.value = hasOption ? currentDayName : 'Monday';
        daySelect.addEventListener('change', loadTimetable);
        loadTimetable();
    }

    document.getElementById('printTimetable')?.addEventListener('click', () => { syncPrintActiveToActiveTab(); window.print(); });
    window.addEventListener('beforeprint', syncPrintActiveToActiveTab);

    const champDaySelect = document.getElementById('champDay');
    if (champDaySelect) {
        const today = new Date();
        const currentDayName = today.toLocaleDateString('en-US', { weekday: 'long' });
        const hasOption = Array.from(champDaySelect.options).some(opt => opt.value === currentDayName);
        champDaySelect.value = hasOption ? currentDayName : 'Monday';
        champDaySelect.addEventListener('change', loadChampTimetable);
        if (document.getElementById('champViewContainer')?.classList.contains('active')) loadChampTimetable();
    }

    function exportToExcel() {
        let activeTable = null;
        let viewName = 'Timetable';
        if (document.getElementById('dayViewContainer').classList.contains('active')) { activeTable = document.getElementById('timetableTable'); viewName = 'Day_View'; }
        else if (document.getElementById('weekViewContainer').classList.contains('active')) { activeTable = document.getElementById('weekTimetableTable'); viewName = 'Week_View'; }
        else if (document.getElementById('champViewContainer').classList.contains('active')) { activeTable = document.getElementById('champTimetableTable'); viewName = 'Champ_Format'; }
        if (!activeTable) { alert('Please select a view to export.'); return; }
        const tableClone = activeTable.cloneNode(true);

        if (viewName === 'Day_View') {
            const headerRow = tableClone.querySelector('#dayViewHeaderRow');
            if (headerRow) {
                const th = headerRow.querySelector('th');
                const dateText = th.querySelector('.header-date')?.textContent || '';
                const dayText = th.querySelector('.header-day')?.textContent || '';
                headerRow.innerHTML = `
                    <th style="text-align: left; padding: 8px 12px; font-size: 14pt; font-weight: 600; background: #fff !important; color: #000 !important; border: 1px solid #333 !important;">${dateText}</th>
                    <th colspan="12" style="text-align: right; padding: 8px 12px; font-size: 18pt; font-weight: 700; background: #fff !important; color: #dc3545 !important; border: 1px solid #333 !important;">${dayText}</th>
                `;
            }
        }

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
                    const isKC = div.classList.contains('kc-student') || div.getAttribute('data-kc') === 'true';
                    const isCC = div.classList.contains('cc-student');
                    const bgColor = isKC ? '#fff9c4' : (isCC ? '#e0f2fe' : 'transparent');
                    innerHTML += `<tr><td style="background-color:${bgColor}; padding:2px 3px; border:none; text-align:left; vertical-align:middle; font-size:9.5pt;"><b style="color:#4682B4; font-size:9pt; font-weight:700;">${grade}</b> <span style="font-size:9.5pt; font-weight:500; color:#000;">${name}</span> <b style="color:#555; font-size:9pt; font-weight:600; white-space:nowrap;">${level}</b></td></tr>`;
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
                .cc-cell { background-color: #e0f2fe !important; }
                .week-today-col { background: rgba(135, 206, 235, 0.15) !important; }
                .week-today-header { background: #2e6da4 !important; color: #fff !important; }
            </style>
        `;

        const htmlTemplate = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${viewName}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->${excelCSS}</head><body>${tableClone.outerHTML}</body></html>`;
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

    // ============================================
// 📄 UNIFIED PRINT / EXPORT — FAB + OPTIONS MODAL (v3)
// Default = original print/export untouched.
// Custom options = clone with identical markup/classes.
// v3: Math combined (6A–E rows then F+ rows) + multi-day = ONE table.
// ============================================
const TT_SETTINGS_KEY = 'kumonTimetableExportV1';
const ttFab = document.getElementById('timetableFab');
const ttModal = document.getElementById('timetableExportModal');
const ttClose = document.getElementById('closeTimetableExportModal');
const ttCancel = document.getElementById('ttCancelBtn');
const ttConfirm = document.getElementById('ttConfirmBtn');
const ttOutputBtns = document.querySelectorAll('.tt-output-btn');
const ttDayChipsWrap = document.getElementById('ttDayChips');
const ttDaysSection = document.getElementById('ttDaysSection');
const ttDaysHint = document.getElementById('ttDaysHint');
const ttSubjectSection = document.getElementById('ttSubjectSection');
const ttSubjectFilter = document.getElementById('ttSubjectFilter');
const ttPreview = document.getElementById('ttPreviewText');
const ttCenterLabel = document.getElementById('ttModalCenterLabel');
const ttPrintArea = document.getElementById('printArea');
let ttCurrentView = 'dayView';
let ttOutput = 'print';
let ttCenterName = '';

const TT_DAY_SUBJECTS = [
    { key: 'all', label: 'All subjects' },
    { key: 'math', label: 'Math (6A–E + F+)' },
    { key: 'english', label: 'English' },
    { key: 'chinese', label: 'Chinese' }
];
const TT_CHAMP_SUBJECTS = [
    { key: 'all', label: 'All subjects' },
    { key: 'math6A2A', label: 'Math (6A–2A)' },
    { key: 'mathAF', label: 'Math (A–F)' },
    { key: 'mathGI', label: 'Math (G–I)' },
    { key: 'mathJO', label: 'Math (J–O)' },
    { key: 'engK', label: 'English (K0–K3)' },
    { key: 'engP1', label: 'English (P1+)' },
    { key: 'chinese', label: 'Chinese' }
];
const TT_DAY_GROUP_META = [
    { key: 'mathLow', label: 'Math (6A–E)', cls: 'th-math' },
    { key: 'mathHigh', label: 'Math (F+)', cls: 'th-math' },
    { key: 'english', label: 'English', cls: 'th-english' },
    { key: 'chinese', label: 'Chinese', cls: 'th-chinese' }
];
const TT_CHAMP_GROUP_META = [
    { key: 'math6A2A', label: 'Math (6A–2A)', cls: 'th-math' },
    { key: 'mathAF', label: 'Math (A–F)', cls: 'th-math' },
    { key: 'mathGI', label: 'Math (G–I)', cls: 'th-math' },
    { key: 'mathJO', label: 'Math (J–O)', cls: 'th-math' },
    { key: 'engK', label: 'English (K0–K3)', cls: 'th-english' },
    { key: 'engP1', label: 'English (P1+)', cls: 'th-english' },
    { key: 'chinese', label: 'Chinese', cls: 'th-chinese' }
];

function ttEsc(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function ttGetActiveView() { return document.querySelector('.tab-btn.active')?.dataset.tab || 'dayView'; }
function ttLoadSettings() { try { return JSON.parse(localStorage.getItem(TT_SETTINGS_KEY) || '{}'); } catch { return {}; } }
function ttSaveSettings(s) { try { localStorage.setItem(TT_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
function ttSubjectLabel(view, subjectKey) {
    const list = view === 'champView' ? TT_CHAMP_SUBJECTS : TT_DAY_SUBJECTS;
    return (list.find(s => s.key === subjectKey) || {}).label || 'All subjects';
}

function ttToast(msg) {
    const t = document.getElementById('ttToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function ttBuildChips(container, selectedDays) {
    container.innerHTML = '';
    DAY_ORDER.forEach((day, i) => {
        const label = document.createElement('label');
        label.className = 'tt-chip';
        const input = document.createElement('input');
        input.type = 'checkbox'; input.value = day;
        input.checked = selectedDays.includes(day);
        const span = document.createElement('span'); span.textContent = DAY_ABBR[i];
        label.append(input, span);
        container.appendChild(label);
    });
}
function ttSelectedDays(container) { return [...container.querySelectorAll('input:checked')].map(i => i.value); }

function ttSetOutput(mode) {
    ttOutput = mode;
    ttOutputBtns.forEach(b => b.classList.toggle('active', b.dataset.output === mode));
    ttConfirm.innerHTML = mode === 'print' ? '🖨️ Print Now' : '📊 Download Excel';
    const s = ttLoadSettings(); s.output = mode; ttSaveSettings(s);
}

function ttUpdatePreview() {
    const days = ttSelectedDays(ttDayChipsWrap);
    const viewLabel = ttCurrentView === 'weekView' ? 'Whole Week View' : ttCurrentView === 'champView' ? 'Champs Format' : 'Day View';
    const isWeek = ttCurrentView === 'weekView';
    const subjectKey = isWeek ? 'all' : ttSubjectFilter.value;
    const isFiltered = isWeek ? days.length !== DAY_ORDER.length : (subjectKey !== 'all' || days.length > 1);
    const bits = [viewLabel, `${days.length} day(s)`];
    if (!isWeek) bits.push(subjectKey === 'all' ? 'All subjects' : (ttSubjectFilter.selectedOptions[0]?.textContent || ''));
    bits.push(isFiltered ? '• custom selection (same print format)' : '• standard layout');
    ttPreview.textContent = bits.join(' • ');
}

async function openTimetableExportModal() {
    ttCurrentView = ttGetActiveView();
    const settings = ttLoadSettings();

    if (!ttCenterName) {
        try {
            if (!cachedStudentsSnap) cachedStudentsSnap = await get(centersRef);
            ttCenterName = cachedStudentsSnap.child(`${centerId}/name`).val() || 'Timetable';
        } catch { ttCenterName = 'Timetable'; }
    }
    ttCenterLabel.textContent = `Centre: ${ttCenterName}`;
    ttSetOutput(settings.output || 'print');

    if (ttCurrentView === 'weekView') {
        ttDaysSection.classList.remove('hidden');
        ttSubjectSection.classList.add('hidden');
        ttDaysHint.textContent = 'Uncheck days this centre doesn’t operate — they will be removed from the printed page.';
        const savedWeekDays = Array.isArray(settings.weekDays) && settings.weekDays.length ? settings.weekDays : [...DAY_ORDER];
        ttBuildChips(ttDayChipsWrap, savedWeekDays);
    } else {
        const isChamp = ttCurrentView === 'champView';
        const daySelectEl = document.getElementById(isChamp ? 'champDay' : 'timetableDay');
        const currentDay = daySelectEl?.value || 'Monday';
        ttDaysSection.classList.remove('hidden');
        ttDaysHint.textContent = 'Add extra days to print together on one page — e.g. Chinese Tue + Wed + Thu.';
        const savedExtra = Array.isArray(settings.extraDays) ? settings.extraDays : [];
        ttBuildChips(ttDayChipsWrap, [...new Set([currentDay, ...savedExtra.filter(d => d !== currentDay)])]);

        ttSubjectSection.classList.remove('hidden');
        const subjects = isChamp ? TT_CHAMP_SUBJECTS : TT_DAY_SUBJECTS;
        ttSubjectFilter.innerHTML = subjects.map(s => `<option value="${s.key}">${s.label}</option>`).join('');
        ttSubjectFilter.value = settings.subject || 'all';
        // If a saved setting no longer exists (old mathLow/mathHigh), reset to all
        if (ttSubjectFilter.value !== settings.subject) ttSubjectFilter.value = 'all';
    }
    ttUpdatePreview();
    ttModal.classList.add('open');
    ttModal.setAttribute('aria-hidden', 'false');
}
function closeTtModal() { ttModal.classList.remove('open'); ttModal.setAttribute('aria-hidden', 'true'); }

function ttPersistLight() {
    const s = ttLoadSettings();
    const days = ttSelectedDays(ttDayChipsWrap);
    if (ttCurrentView === 'weekView') s.weekDays = days; else s.extraDays = days;
    if (ttCurrentView !== 'weekView') s.subject = ttSubjectFilter.value;
    ttSaveSettings(s);
}

// ---------- Data builders (reuse cached snapshot; same logic as on-screen views) ----------
function ttBuildDaySchedule(snap, day, targetDate, view) {
    const isChamp = view === 'champView';
    const timeSlots = getTimeSlots(day);
    const makeEmpty = () => isChamp
        ? { math6A2A: [], mathAF: [], mathGI: [], mathJO: [], engK: [], engP1: [], chinese: [] }
        : { mathLow: [], mathHigh: [], english: [], chinese: [] };
    const schedule = {};
    timeSlots.forEach(t => schedule[t] = makeEmpty());
    const targetISO = toISODate(targetDate);

    snap.forEach(centerSnap => {
        const centerData = centerSnap.val();
        if (!centerData?.students) return;
        Object.values(centerData.students).forEach(s => {
            if (!s?.subjects) return;
            const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
            subjects.forEach(sub => {
                if (!isSubjectActiveOnDate(sub, targetDate) || !sub.timeslots) return;
                const group = getSubjectGroup(sub.name);
                if (!group) return;
                const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
                tsList.forEach(ts => {
                    if (!ts) return;
                    if ((ts.center || centerSnap.key) !== centerId) return;
                    const tsDay = getTsDay(ts); const time = getTsTime(ts);
                    if (!tsDay || !time || tsDay !== day || !schedule[time]) return;
                    const st = buildStudentObj(s, sub, tsDay, tsList, targetDate);
                    if (!st) return;
                    if (isChamp) {
                        if (group === 'Math') { const b = getMathChampGroup(st.level); if (b) schedule[time][b].push(st); }
                        else if (group === 'English') { const b = getEnglishChampGroup(s.grade); if (b) schedule[time][b].push(st); }
                        else if (group === 'Chinese') schedule[time].chinese.push(st);
                    } else {
                        if (group === 'Math') { if (isMathHighLevel(st.level)) schedule[time].mathHigh.push(st); else schedule[time].mathLow.push(st); }
                        else if (group === 'English') schedule[time].english.push(st);
                        else if (group === 'Chinese') schedule[time].chinese.push(st);
                    }
                });
            });
        });
    });

    const ccSnap = snap.child(`${centerId}/classChanges`);
    if (ccSnap.exists()) {
        ccSnap.forEach(child => {
            const cc = child.val();
            if (!cc || cc.replacementStatus !== 'scheduled' || cc.replacementDate !== targetISO) return;
            const time = normalizeTime(cc.replacementTime);
            const group = getSubjectGroup(cc.subject);
            if (!time || !group || !schedule[time]) return;
            const st = buildClassChangeStudentObj(cc);
            if (isChamp) {
                if (group === 'Math') { const b = getMathChampGroup(st.level); if (b) schedule[time][b].push(st); }
                else if (group === 'English') { const b = getEnglishChampGroup(cc.grade); if (b) schedule[time][b].push(st); }
                else if (group === 'Chinese') schedule[time].chinese.push(st);
            } else {
                if (group === 'Math') { if (isMathHighLevel(st.level)) schedule[time].mathHigh.push(st); else schedule[time].mathLow.push(st); }
                else if (group === 'English') schedule[time].english.push(st);
                else if (group === 'Chinese') schedule[time].chinese.push(st);
            }
        });
    }
    Object.values(schedule).forEach(slot => Object.values(slot).forEach(arr => arr.sort((a, b) => String(a.grade).localeCompare(String(b.grade)))));
    return { timeSlots, schedule };
}

function ttBuildWeekSchedule(snap) {
    const weekDates = getWeekDates();
    const allTimeSlots = getWeekTimeSlots();
    const schedule = {};
    allTimeSlots.forEach(time => { schedule[time] = {}; DAY_ORDER.forEach(d => { schedule[time][d] = []; }); });

    snap.forEach(centerSnap => {
        const centerData = centerSnap.val();
        if (!centerData?.students) return;
        Object.values(centerData.students).forEach(s => {
            if (!s?.subjects) return;
            const subjects = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
            subjects.forEach(sub => {
                if (!sub.timeslots) return;
                const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots || {});
                tsList.forEach(ts => {
                    if (!ts) return;
                    if ((ts.center || centerSnap.key) !== centerId) return;
                    const tsDay = getTsDay(ts); const time = getTsTime(ts);
                    if (!tsDay || !time) return;
                    const dayIdx = DAY_ORDER.indexOf(tsDay);
                    if (dayIdx === -1 || !weekDates[dayIdx]?.fullDate) return;
                    if (!schedule[time] || !schedule[time][tsDay]) return;
                    if (!isSubjectActiveOnDate(sub, weekDates[dayIdx].fullDate)) return;
                    const st = buildStudentObj(s, sub, tsDay, tsList, weekDates[dayIdx].fullDate);
                    if (st) schedule[time][tsDay].push(st);
                });
            });
        });
    });

    const ccSnap = snap.child(`${centerId}/classChanges`);
    if (ccSnap.exists()) {
        ccSnap.forEach(child => {
            const cc = child.val();
            if (!cc || cc.replacementStatus !== 'scheduled' || !cc.replacementDate) return;
            const dayIdx = weekDates.findIndex(w => toISODate(w.fullDate) === cc.replacementDate);
            if (dayIdx === -1) return;
            const time = normalizeTime(cc.replacementTime);
            const tsDay = DAY_ORDER[dayIdx];
            if (!time || !schedule[time] || !schedule[time][tsDay]) return;
            schedule[time][tsDay].push(buildClassChangeStudentObj(cc));
        });
    }
    Object.values(schedule).forEach(ds => Object.values(ds).forEach(arr => arr.sort((a, b) => String(a.grade).localeCompare(String(b.grade)))));
    return { weekDates, allTimeSlots, schedule };
}

// ---------- Subject student lists (Math = 6A–E rows first, then F+ rows) ----------
function ttGetSubjectStudents(slot, subjectKey) {
    if (!slot) return [];
    if (subjectKey === 'math') {
        const low = (slot.mathLow || []).map(st => ({ st }));
        const high = (slot.mathHigh || []).map((st, i) => ({ st, sep: i === 0 && low.length > 0 }));
        return [...low, ...high];
    }
    return (slot[subjectKey] || []).map(st => ({ st }));
}

// ---------- Clones: SAME markup/classes as the on-screen tables ----------
function ttCloneRows(timeSlots, schedule, visible) {
    let tbody = '';
    timeSlots.forEach(time => {
        const s = schedule[time];
        const maxRows = Math.max(...visible.map(g => (s[g.key] || []).length));
        const rowCount = maxRows === 0 ? 2 : maxRows;
        const isEmpty = maxRows === 0;
        for (let i = 0; i < rowCount; i++) {
            let row = `<tr${isEmpty ? ' class="empty-time-row"' : ''}>`;
            if (i === 0) row += `<td class="time-cell" rowspan="${rowCount}">${time}</td>`;
            visible.forEach(g => {
                const st = (s[g.key] || [])[i];
                if (st) {
                    const kc = st.worksheetType === 'Kumon Connect' ? ' kc-cell' : '';
                    const cc = st.isClassChange ? ' cc-cell' : '';
                    row += `<td class="col-grade">${ttEsc(st.grade)}</td><td class="col-name${kc}${cc}">${ttEsc(st.name)}</td><td class="col-level">${ttEsc(st.level)}</td>`;
                } else {
                    row += `<td class="empty-cell"></td><td class="empty-cell"></td><td class="empty-cell"></td>`;
                }
            });
            row += '</tr>';
            tbody += row;
        }
    });
    return tbody;
}

// Single subject, one day: Gr/Name/Lvl rows; Math = 6A–E block then F+ block (divider row)
function ttCloneSubjectRows(timeSlots, schedule, subjectKey) {
    let tbody = '';
    timeSlots.forEach(time => {
        const list = ttGetSubjectStudents(schedule[time], subjectKey);
        const rowCount = list.length === 0 ? 2 : list.length;
        const isEmpty = list.length === 0;
        for (let i = 0; i < rowCount; i++) {
            const item = list[i];
            const cls = [isEmpty ? 'empty-time-row' : '', item?.sep ? 'p-sep-row' : ''].filter(Boolean).join(' ');
            let row = `<tr${cls ? ` class="${cls}"` : ''}>`;
            if (i === 0) row += `<td class="time-cell" rowspan="${rowCount}">${time}</td>`;
            if (item) {
                const st = item.st;
                const kc = st.worksheetType === 'Kumon Connect' ? ' kc-cell' : '';
                const cc = st.isClassChange ? ' cc-cell' : '';
                row += `<td class="col-grade">${ttEsc(st.grade)}</td><td class="col-name${kc}${cc}">${ttEsc(st.name)}</td><td class="col-level">${ttEsc(st.level)}</td>`;
            } else {
                row += `<td class="empty-cell"></td><td class="empty-cell"></td><td class="empty-cell"></td>`;
            }
            row += '</tr>';
            tbody += row;
        }
    });
    return tbody;
}

function ttCloneDayOrChampTable(snap, day, subjectKey, view) {
    const isChamp = view === 'champView';
    const info = getDayViewHeaderInfo(day);
    const { timeSlots, schedule } = ttBuildDaySchedule(snap, day, info.targetDate, view);

    let headerGroups, rowsHtml;
    if (subjectKey === 'all') {
        headerGroups = isChamp ? TT_CHAMP_GROUP_META : TT_DAY_GROUP_META;
        rowsHtml = ttCloneRows(timeSlots, schedule, headerGroups);
    } else if (isChamp) {
        headerGroups = TT_CHAMP_GROUP_META.filter(g => g.key === subjectKey);
        rowsHtml = ttCloneSubjectRows(timeSlots, schedule, subjectKey);
    } else {
        headerGroups = subjectKey === 'math'
            ? [{ key: 'math', label: 'Math (6A–E + F+)', cls: 'th-math' }]
            : TT_DAY_GROUP_META.filter(g => g.key === subjectKey);
        rowsHtml = ttCloneSubjectRows(timeSlots, schedule, subjectKey);
    }

    const colCount = 1 + headerGroups.length * 3;
    const thead = `
        <tr class="day-view-header-row"><th colspan="${colCount}"><div class="day-view-date-header"><span class="header-date">${ttEsc(info.dateStr)}</span><span class="header-day">${ttEsc(info.dayStr)}</span></div></th></tr>
        <tr><th rowspan="2" class="col-time">Time</th>${headerGroups.map(g => `<th colspan="3" class="${g.cls}">${g.label}</th>`).join('')}</tr>
        <tr>${headerGroups.map(() => `<th class="col-grade">Gr</th><th class="col-name">Name</th><th class="col-level">Lvl</th>`).join('')}</tr>`;
    const tableId = isChamp ? 'champTimetableTable' : 'timetableTable';
    return `<table id="${tableId}"><thead>${thead}</thead><tbody>${rowsHtml}</tbody></table>`;
}

// 🆕 Subject + multiple days = ONE table with day columns (12/10 / 1-Monday)
function ttCloneCombinedDaysTable(snap, opts) {
    const isChamp = opts.view === 'champView';
    const label = ttSubjectLabel(opts.view, opts.subjectKey);
    const perDay = opts.days.map(day => {
        const info = getDayViewHeaderInfo(day);
        const { schedule } = ttBuildDaySchedule(snap, day, info.targetDate, opts.view);
        return { day, info, schedule };
    });
    const allTimes = [...new Set(perDay.flatMap(d => Object.keys(d.schedule)))].sort();
    const activeTimes = allTimes.filter(t => perDay.some(d => ttGetSubjectStudents(d.schedule[t], opts.subjectKey).length));

    let rows = '';
    activeTimes.forEach(time => {
        let row = `<tr><td class="time-cell">${time}</td>`;
        perDay.forEach(d => {
            const list = ttGetSubjectStudents(d.schedule[time], opts.subjectKey);
            const inner = list.map(({ st, sep }) => {
                const cls = 'week-student' +
                    (st.isClassChange ? ' cc-student' : '') +
                    (st.worksheetType === 'Kumon Connect' ? ' kc-student' : '') +
                    (sep ? ' p-sep' : '');
                return `<div class="${cls}"><span class="ws-grade">${ttEsc(st.grade)}</span><span class="ws-name">${ttEsc(st.name)}</span><span class="ws-level">${ttEsc(st.level)}</span></div>`;
            }).join('');
            row += `<td class="week-cell">${inner}</td>`;
        });
        row += '</tr>';
        rows += row;
    });
    if (!rows) rows = `<tr><td colspan="${perDay.length + 1}" class="week-empty-msg">No students found for the selected options.</td></tr>`;

    const thead = `
        <tr class="day-view-header-row"><th colspan="${perDay.length + 1}"><div class="day-view-date-header"><span class="header-date">${ttEsc(label)}</span><span class="header-day">${ttEsc(perDay[0].info.dateStr)} – ${ttEsc(perDay[perDay.length - 1].info.dateStr)}</span></div></th></tr>
        <tr><th class="col-time">Time</th>${perDay.map(d => `<th class="p-day-th"><span class="p-day-date">${ttEsc(d.info.dateStr)}</span><br><span class="p-day-name">${ttEsc(d.info.dayStr)}</span></th>`).join('')}</tr>`;
    const tableId = isChamp ? 'champTimetableTable' : 'timetableTable';
    return `<table id="${tableId}"><thead>${thead}</thead><tbody>${rows}</tbody></table>`;
}

function ttCloneWeekTable(snap, includedDays) {
    const { weekDates, allTimeSlots, schedule } = ttBuildWeekSchedule(snap);
    const days = DAY_ORDER.filter(d => includedDays.includes(d));
    const activeTimes = allTimeSlots.filter(t => days.some(d => schedule[t][d].length));
    let thead = `<tr id="weekDateRow"><th rowspan="2" class="th-time col-time">Time</th>` +
    days.map(d => { const i = DAY_ORDER.indexOf(d); return `<th class="${weekDates[i].isToday ? 'week-today-header' : ''}">${weekDates[i].date}</th>`; }).join('') + `</tr>
        <tr id="weekDayRow">` + days.map(d => { const i = DAY_ORDER.indexOf(d); return `<th class="${weekDates[i].isToday ? 'week-today-header' : ''}">${DAY_ABBR[i]}</th>`; }).join('') + `</tr>`;
    let tbody = '';
    if (!activeTimes.length) {
        tbody = `<tr><td colspan="${days.length + 1}" class="week-empty-msg">No students scheduled for this week.</td></tr>`;
    } else {
        activeTimes.forEach(time => {
            let row = `<tr><td class="week-time-cell">${time}</td>`;
            days.forEach(d => {
                const i = DAY_ORDER.indexOf(d);
                const cls = 'week-cell' + (weekDates[i].isToday ? ' week-today-col' : '');
                const inner = schedule[time][d].map(st => {
                    const sc = 'week-student' + (st.isClassChange ? ' cc-student' : '') + (st.worksheetType === 'Kumon Connect' ? ' kc-student' : '');
                    return `<div class="${sc}"><span class="ws-grade">${ttEsc(st.grade)}</span><span class="ws-name">${ttEsc(st.name)}</span><span class="ws-level">${ttEsc(st.level)}</span></div>`;
                }).join('');
                row += `<td class="${cls}">${inner}</td>`;
            });
            row += '</tr>';
            tbody += row;
        });
    }
    return `<table id="weekTimetableTable"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

// ---------- Custom-option outputs ----------
function ttBuildCloneHtml(opts, snap) {
    if (opts.view === 'weekView') return ttCloneWeekTable(snap, opts.days);
    if (opts.subjectKey !== 'all' && opts.days.length > 1) return ttCloneCombinedDaysTable(snap, opts);
    return opts.days.map(day => ttCloneDayOrChampTable(snap, day, opts.subjectKey, opts.view)).join('');
}

function ttRunPrint(opts, snap) {
    ttPrintArea.innerHTML = ttBuildCloneHtml(opts, snap);
    document.body.classList.add('tt-printing');
    setTimeout(() => window.print(), 80);
}
window.addEventListener('afterprint', () => {
    document.body.classList.remove('tt-printing');
    ttPrintArea.innerHTML = '';
});

function ttRunExcel(opts, snap) {
    const viewName = opts.view === 'weekView' ? 'Week_View' : opts.view === 'champView' ? 'Champ_Format' : 'Day_View';
    const body = ttBuildCloneHtml(opts, snap);
    const excelCSS = `<style>
        body { font-family: 'Microsoft YaHei','PingFang SC','Segoe UI',Arial,sans-serif; }
        table { border-collapse: collapse; border: 2px solid #333; width: 100%; font-size: 11pt; }
        table + table { margin-top: 12px; }
        th, td { border: 1px solid #333; padding: 3px 5px; text-align: center; vertical-align: middle; color: #000; line-height: 1.2; }
        th { background: #eee; font-weight: 700; }
        .th-math { background: #008B8B !important; color: #fff !important; }
        .th-english { background: #DC143C !important; color: #fff !important; }
        .th-chinese { background: #9ACD32 !important; color: #333 !important; }
        .th-time { background: #555 !important; color: #fff !important; }
        .col-time, .col-grade, .col-level { width: 1%; white-space: nowrap; }
        .time-cell, .week-time-cell { font-weight: 600; background: #f8f9fa !important; }
        .empty-cell { background: transparent !important; }
        .kc-cell { background: #fff9c4 !important; }
        .cc-cell { background: #e0f2fe !important; }
        .empty-time-row td { height: 18pt; }
        .day-view-header-row th { background: #fff !important; }
        .header-date { font-size: 14pt; font-weight: 600; text-align: left; }
        .header-day { font-size: 18pt; font-weight: 700; color: #dc3545 !important; text-align: right; }
        .p-day-name { color: #dc3545 !important; font-weight: 700; }
        .p-day-date { font-size: 9pt; }
        tr.p-sep-row td { border-top: 2px solid #888 !important; }
        .p-sep { border-top: 2px solid #888; }
        #weekDateRow th { background: #4682B4 !important; color: #fff !important; font-size: 13pt; }
        #weekDayRow th { background: #d0e8f5 !important; color: #333 !important; font-size: 10pt; }
        .week-cell { text-align: left; vertical-align: top; }
        .week-student { font-size: 9.5pt; padding: 1px 2px; border-bottom: 1px solid #eee; text-align: left; }
        .ws-grade { font-weight: 700; color: #4682B4; }
        .ws-level { font-weight: 600; color: #555; white-space: nowrap; }
        .kc-student { background: #fff9c4; }
        .cc-student { background: #e0f2fe; }
        .week-today-col { background: rgba(135,206,235,.15); }
        .week-today-header { background: #2e6da4 !important; color: #fff !important; }
    </style>`;
    const htmlTemplate = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${viewName}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->${excelCSS}</head><body>${body}</body></html>`;
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
    ttToast('✅ Excel file downloaded');
}

// ---------- Wiring ----------
if (ttFab) {
    ttFab.addEventListener('click', openTimetableExportModal);
    ttOutputBtns.forEach(b => b.addEventListener('click', () => ttSetOutput(b.dataset.output)));
    ttClose?.addEventListener('click', closeTtModal);
    ttCancel?.addEventListener('click', closeTtModal);
    ttModal?.addEventListener('click', e => { if (e.target === ttModal) closeTtModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTtModal(); });
    document.getElementById('ttDaysAll')?.addEventListener('click', () => { ttDayChipsWrap.querySelectorAll('input').forEach(i => i.checked = true); ttPersistLight(); ttUpdatePreview(); });
    document.getElementById('ttDaysNone')?.addEventListener('click', () => { ttDayChipsWrap.querySelectorAll('input').forEach(i => i.checked = false); ttPersistLight(); ttUpdatePreview(); });
    ttDayChipsWrap?.addEventListener('change', () => { ttPersistLight(); ttUpdatePreview(); });
    ttSubjectFilter?.addEventListener('change', () => { ttPersistLight(); ttUpdatePreview(); });

    ttConfirm?.addEventListener('click', async () => {
        const days = ttSelectedDays(ttDayChipsWrap);
        if (!days.length) { alert('⚠️ Please select at least one day.'); return; }
        ttPersistLight();

        const isWeek = ttCurrentView === 'weekView';
        const subjectKey = isWeek ? 'all' : ttSubjectFilter.value;
        const isFiltered = isWeek ? days.length !== DAY_ORDER.length : (subjectKey !== 'all' || days.length > 1);
        const opts = { view: ttCurrentView, days, subjectKey };

        try {
            ttConfirm.disabled = true;
            ttConfirm.textContent = '⏳ Preparing…';

            if (ttOutput === 'print') {
                if (!isFiltered) {
                    // ✅ 100% ORIGINAL print path — nothing changed
                    closeTtModal();
                    syncPrintActiveToActiveTab();
                    window.print();
                } else {
                    if (!cachedStudentsSnap) cachedStudentsSnap = await get(centersRef);
                    closeTtModal();
                    ttRunPrint(opts, cachedStudentsSnap);
                }
            } else {
                if (!isFiltered) {
                    // ✅ 100% ORIGINAL export path — nothing changed
                    closeTtModal();
                    exportToExcel();
                } else {
                    if (!cachedStudentsSnap) cachedStudentsSnap = await get(centersRef);
                    ttRunExcel(opts, cachedStudentsSnap);
                    closeTtModal();
                }
            }
        } catch (err) {
            console.error('Print/Export error:', err);
            alert('❌ Failed to prepare the timetable: ' + err.message);
        } finally {
            ttConfirm.disabled = false;
            ttConfirm.innerHTML = ttOutput === 'print' ? '🖨️ Print Now' : '📊 Download Excel';
        }
    });
}

    window.addEventListener('beforeunload', () => {
        if (timetableUnsub) timetableUnsub();
        if (weekTimetableUnsub) weekTimetableUnsub();
    });
}

(function initMobileTimetable() {
    const DAY_LABELS = ['Math (6A–E)', 'Math (F+)', 'English', 'Chinese'];
    const DAY_CLASSES = ['g-math', 'g-math', 'g-english', 'g-chinese'];
    const CHAMP_LABELS = ['Math (6A–2A)', 'Math (A–F)', 'Math (G–I)', 'Math (J–O)', 'English (K0–K3)', 'English (P1+)', 'Chinese'];
    const CHAMP_CLASSES = ['g-math', 'g-math', 'g-math', 'g-math', 'g-english', 'g-english', 'g-chinese'];

    function ensureContainers() {
        [{ host: 'dayViewContainer', id: 'dayViewMobile' }, { host: 'weekViewContainer', id: 'weekViewMobile', chips: 'weekMobileChips', list: 'weekMobileList' }, { host: 'champViewContainer', id: 'champViewMobile' }].forEach(sp => {
            const host = document.getElementById(sp.host);
            if (!host || document.getElementById(sp.id)) return;
            const el = document.createElement('div');
            el.id = sp.id; el.className = 'mobile-schedule';
            if (sp.chips) { const c = document.createElement('div'); c.id = sp.chips; c.className = 'mobile-day-chips'; const l = document.createElement('div'); l.id = sp.list; el.append(c, l); }
            const wrapper = host.querySelector('.timetable-wrapper');
            wrapper ? wrapper.after(el) : host.appendChild(el);
        });
    }

    function studentLi(st) {
        const li = document.createElement('li');
        li.className = 'mobile-student' + (st.kc ? ' kc' : '');
        const g = document.createElement('span'); g.className = 'm-grade'; g.textContent = st.grade;
        const n = document.createElement('span'); n.className = 'm-name'; n.textContent = st.name;
        const l = document.createElement('span'); l.className = 'm-level'; l.textContent = st.level;
        li.append(g, n, l);
        return li;
    }

    function parseDayTable(bodyId, labels) {
        const body = document.getElementById(bodyId);
        if (!body) return [];
        const slots = []; let current = null;
        body.querySelectorAll('tr').forEach(tr => {
            const timeCell = tr.querySelector('td.time-cell');
            if (timeCell) { current = { time: timeCell.textContent.trim(), groups: labels.map(() => []) }; slots.push(current); }
            if (!current) return;
            const cells = Array.from(tr.children).filter(td => !td.classList.contains('time-cell'));
            labels.forEach((_, gi) => {
                const nameTd = cells[gi * 3 + 1];
                const name = nameTd?.textContent.trim() || '';
                if (!name || nameTd.classList.contains('empty-cell')) return;
                current.groups[gi].push({ grade: cells[gi * 3]?.textContent.trim() || '', name, level: cells[gi * 3 + 2]?.textContent.trim() || '', kc: nameTd.classList.contains('kc-cell') });
            });
        });
        return slots.filter(s => s.groups.some(g => g.length));
    }

    function renderCards(containerId, slots, labels, classes) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';
        if (!slots.length) { el.innerHTML = '<p class="mobile-empty">No students scheduled for this day.</p>'; return; }
        slots.forEach(slot => {
            const card = document.createElement('article'); card.className = 'slot-card';
            const head = document.createElement('div'); head.className = 'slot-time'; head.textContent = slot.time;
            card.appendChild(head);
            slot.groups.forEach((students, g) => {
                if (!students.length) return;
                const sec = document.createElement('section'); sec.className = 'mobile-group ' + classes[g];
                const h = document.createElement('h4'); h.textContent = labels[g];
                const ul = document.createElement('ul');
                students.forEach(st => ul.appendChild(studentLi(st)));
                sec.append(h, ul); card.appendChild(sec);
            });
            el.appendChild(card);
        });
    }

    function renderWeek() {
        const chips = document.getElementById('weekMobileChips');
        const list = document.getElementById('weekMobileList');
        const body = document.getElementById('weekTimetableBody');
        if (!chips || !list || !body) return;
        const days = Array.from({ length: 7 }, () => []);
        body.querySelectorAll('tr').forEach(tr => {
            const timeCell = tr.querySelector('td.week-time-cell');
            if (!timeCell) return;
            const time = timeCell.textContent.trim();
            Array.from(tr.children).filter(td => td.classList.contains('week-cell')).forEach((td, i) => {
                const students = [];
                td.querySelectorAll('.week-student').forEach(div => students.push({
                    grade: div.querySelector('.ws-grade')?.textContent.trim() || '',
                    name: div.querySelector('.ws-name')?.textContent.trim() || '',
                    level: div.querySelector('.ws-level')?.textContent.trim() || '',
                    kc: div.classList.contains('kc-student')
                }));
                if (students.length && days[i]) days[i].push({ time, students });
            });
        });
        const headers = Array.from(document.querySelectorAll('#weekDayRow th'));
        const labels = headers.length ? headers.map(th => th.textContent.trim()) : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
        let selected = Math.max(0, headers.findIndex(th => th.classList.contains('week-today-header')));
        chips.innerHTML = '';
        const renderList = () => {
            list.innerHTML = '';
            const entries = days[selected] || [];
            if (!entries.length) { list.innerHTML = '<p class="mobile-empty">No students scheduled for this day.</p>'; return; }
            entries.forEach(e => {
                const card = document.createElement('article'); card.className = 'slot-card';
                const head = document.createElement('div'); head.className = 'slot-time'; head.textContent = e.time;
                const ul = document.createElement('ul'); ul.className = 'mobile-flat';
                e.students.forEach(st => ul.appendChild(studentLi(st)));
                card.append(head, ul); list.appendChild(card);
            });
        };
        labels.forEach((label, i) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'day-chip' + (i === selected ? ' active' : '') + (headers[i]?.classList.contains('week-today-header') ? ' today' : '');
            chip.textContent = label;
            chip.addEventListener('click', () => {
                selected = i;
                chips.querySelectorAll('.day-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                renderList();
            });
            chips.appendChild(chip);
        });
        renderList();
    }

    function refreshAll() {
        renderCards('dayViewMobile', parseDayTable('timetableBody', DAY_LABELS), DAY_LABELS, DAY_CLASSES);
        renderCards('champViewMobile', parseDayTable('champTimetableBody', CHAMP_LABELS), CHAMP_LABELS, CHAMP_CLASSES);
        renderWeek();
    }

    ensureContainers();
    ['timetableBody', 'champTimetableBody', 'weekTimetableBody'].forEach(id => {
        const el = document.getElementById(id);
        if (el) new MutationObserver(refreshAll).observe(el, { childList: true, subtree: true });
    });
    refreshAll();
})();