// dashboard.js (PART 1/2)
import './dashboard-i18n.js';
import { i18nReady, t, currentLanguage } from './i18n-core.js';
import { auth, requireAuth, logout, db, syncPendingRequests } from './auth.js';
import { ref, get, update, remove, push, serverTimestamp, onValue, off, onChildAdded, onChildRemoved } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ============================================
// GLOBAL STATE
// ============================================
let isAdmin = false;
let poDataMap = {};
let dtDataMap = {}; // Stores Diagnostic Test events
let calendarEventsMap = {}; // Stores holiday events
let centerName = ""; // Stores the center name to determine closed days

// Tracks which month the user is currently viewing in the calendar
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();

let editingCalendarDate = null;
let pendingOtherEvents = [];

const centerId = sessionStorage.getItem('selectedCenter');

// Locale-aware date formatting
const dateLocale = () => (currentLanguage() === 'zh-TW' ? 'zh-TW' : 'en-US');

// ============================================
// 🕒 DASHBOARD ATTENDANCE STATE
// ============================================
let allStudentsForAttendance = [];
let attendanceStudentsLoaded = false;
let attendanceStudentById = new Map();
let attendanceStudentByNumber = new Map();
let attendanceStudentByQr = new Map();

let attendanceRecordsCache = [];
let attendanceRecordsLoaded = false;

let attendanceSelectedStudent = null;
let attendanceLastMethod = 'manual';

let attendanceHtml5QrCode = null;
let dashAttendanceRestartTimer = null;

let expectedRealtimeRef = null;
let expectedTickerTimer = null;

// ============================================
// 🌐 CROSS-CENTER ATTENDANCE STATE
// ============================================
let allStudentsGlobal = [];
let allStudentsGlobalLoaded = false;
let allStudentsByIdGlobal = new Map();
let allStudentsByNumberGlobal = new Map();
let centerNamesCache = new Map();

// ============================================
// DASHBOARD INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  await i18nReady.catch(() => {});

  // 1. Ensure user is authenticated
  const isAuth = requireAuth();
  if (!isAuth) return;

  // 2. Populate User Info in Header
  const storedUser = sessionStorage.getItem('kumonUser');
  if (storedUser) {
    try {
      const user = JSON.parse(storedUser);
      const userInfoEl = document.getElementById('userInfo');
      if (userInfoEl) {
        userInfoEl.textContent = t('dashboard.welcome', { name: user.name });
      }
      const dashboardUserNameEl = document.getElementById('dashboard-user-name');
      if (dashboardUserNameEl) {
        dashboardUserNameEl.textContent = user.name || 'there';
      }
      await applyDashboardPermissions(user);
    } catch (error) {
      console.error('Error parsing user data:', error);
    }
  }

  // 3. Attach Logout Event Listener
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      logoutBtn.textContent = t('common.loggingOut');
      logoutBtn.disabled = true;
      await logout();
    });
  }

  // 4. Set current date
  const today = new Date();
  const formattedDate = today.toLocaleDateString(dateLocale(), {
    year: 'numeric', month: 'long', day: 'numeric'
  });
  const dateEl = document.getElementById('current-date');
  if (dateEl) dateEl.textContent = formattedDate;

  // 5. Load and display Center Name in Calendar
  await loadCenterName();
  await processResumeRequests();
  await processGradeUpdates();
  await syncPendingRequests(centerId);

  // 6. Initialize PO Calendar and Hide Loader
  try {
    await initPOCalendar();
    initCalendarNav();
    initFAB();
    initQuickInquiry();
    setupSchedulePOModalListeners();
    setupSearchStudentModalListeners();
    setupDashboardAttendanceModals();
  } catch (err) {
    console.error("Error initializing dashboard:", err);
  } finally {
    const loader = document.getElementById('page-loader');
    if (loader) loader.classList.add('hidden');
  }
  console.log('Dashboard loaded successfully for user:', auth.currentUser?.email);
});

// ============================================
// FAB & SCHEDULE PO LOGIC
// ============================================
let allStudentsForPO = []; // Cache for students without PO

function initFAB() {
  const fabBtn = document.getElementById('fabBtn');
  const fabMenu = document.getElementById('fabMenu');
  const fabOverlay = document.getElementById('fabOverlay');
  const fabAddStudent = document.getElementById('fabAddStudent');
  const fabSchedulePO = document.getElementById('fabSchedulePO');
  const fabSearchStudent = document.getElementById('fabSearchStudent');
  const fabScheduleDT = document.getElementById('fabScheduleDT');
  const fabAttendance = document.getElementById('fabAttendance');
  if (!fabBtn || !fabMenu || !fabOverlay) return;

  function closeFAB() {
    fabBtn.classList.remove('active');
    fabMenu.classList.add('hidden');
    fabOverlay.classList.add('hidden');
  }
  fabBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isActive = fabBtn.classList.toggle('active');
    fabMenu.classList.toggle('hidden', !isActive);
    fabOverlay.classList.toggle('hidden', !isActive);
  });
  fabOverlay.addEventListener('click', closeFAB);
  fabAddStudent.addEventListener('click', () => {
    closeFAB();
    window.location.href = 'student-form.html?returnUrl=dashboard.html'; 
  });
  fabSchedulePO.addEventListener('click', () => {
    closeFAB();
    openSchedulePOModal();
  });
  fabSearchStudent.addEventListener('click', () => {
    closeFAB();
    openSearchStudentModal();
  });
  if (fabScheduleDT) {
    fabScheduleDT.addEventListener('click', () => {
      closeFAB();
      openScheduleDTModalDash();
    });
  }
  if (fabAttendance) {
    fabAttendance.addEventListener('click', async () => {
      closeFAB();
      await openDashboardAttendanceEntry();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !fabMenu.classList.contains('hidden')) {
      closeFAB();
    }
  });
}

function setupSchedulePOModalListeners() {
  const modal = document.getElementById('schedulePOModal');
  const closeBtn = document.getElementById('closeSchedulePOModal');
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
}

async function openSchedulePOModal() {
  const modal = document.getElementById('schedulePOModal');
  const searchInput = document.getElementById('poStudentSearch');
  const dropdown = document.getElementById('poStudentListDropdown');
  const selectedInfo = document.getElementById('selectedPOStudentInfo');
  const hiddenId = document.getElementById('selectedPOStudentId');
  const dateInput = document.getElementById('poDateInput');
  const notesInput = document.getElementById('poNotesInput');
  const saveBtn = document.getElementById('saveSchedulePOBtn');

  searchInput.value = '';
  dropdown.innerHTML = '';
  dropdown.style.display = 'none';
  selectedInfo.style.display = 'none';
  selectedInfo.textContent = '';
  hiddenId.value = '';
  dateInput.value = '';
  notesInput.value = '';
  saveBtn.disabled = false;
  saveBtn.textContent = t('dashboard.schedulePO.saveBtn');

  await fetchStudentsWithoutPO();
  modal.classList.remove('hidden');

  searchInput.oninput = () => {
    const term = searchInput.value.toLowerCase().trim();
    if (!term) {
      dropdown.style.display = 'none';
      return;
    }
    const matches = allStudentsForPO.filter(s => 
      (s.namePinyin || '').toLowerCase().includes(term) ||
      (s.nameCn || '').toLowerCase().includes(term) ||
      (s.studentNumber || '').toLowerCase().includes(term)
    );
    dropdown.innerHTML = '';
    if (matches.length === 0) {
      dropdown.innerHTML = `<li style="padding:0.75rem; color:#999; text-align:center;">${t('dashboard.noStudentsFound')}</li>`;
    } else {
      matches.slice(0, 20).forEach(s => {
        const li = document.createElement('li');
        li.style.padding = '0.75rem';
        li.style.cursor = 'pointer';
        li.style.borderBottom = '1px solid #f1f5f9';
        li.innerHTML = `
          <div style="font-weight:600; color:var(--text);">${s.nameCn || 'N/A'} <span style="color:var(--text-light); font-weight:400;">(${s.namePinyin || ''})</span></div>
          <div style="font-size:0.8rem; color:var(--text-light);">${t('dashboard.gradeNo', { grade: s.grade || '-', number: s.studentNumber || '-' })}</div>
        `;
        li.onclick = () => {
          hiddenId.value = s.id;
          searchInput.value = `${s.nameCn} (${s.namePinyin})`;
          selectedInfo.textContent = t('dashboard.selected', { name: `${s.nameCn} (${s.namePinyin})` });
          selectedInfo.style.display = 'block';
          dropdown.style.display = 'none';
        };
        li.onmouseover = () => li.style.background = '#f8fafc';
        li.onmouseout = () => li.style.background = 'white';
        dropdown.appendChild(li);
      });
    }
    dropdown.style.display = 'block';
  };
  searchInput.onblur = () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 200);
  };

  saveBtn.onclick = async () => {
    const studentId = hiddenId.value;
    const poDate = dateInput.value;
    const poNote = notesInput.value.trim();
    if (!studentId) return alert(t('dashboard.schedulePO.selectStudent'));
    if (!poDate) return alert(t('dashboard.schedulePO.selectDate'));
    
    saveBtn.disabled = true;
    saveBtn.textContent = t('common.saving');
    try {
      await update(ref(db, `centers/${centerId}/students/${studentId}`), {
        parentOrientation: 'Yes',
        poDate: poDate,
        poNote: poNote,
        updatedAt: new Date().toISOString()
      });
      const studentSnap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
      const s = studentSnap.val();
      if (!poDataMap[poDate]) poDataMap[poDate] = [];
      const subjectsArray = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
      const activeSubjects = subjectsArray
        .filter(sub => sub.status !== 'drop' && sub.status !== 'pause')
        .map(sub => ({ 
          name: sub.name, 
          startLevel: sub.startLevel || '-', 
          startWS: sub.startWS || '-',
          currentLevel: sub.currentLevel || '-' 
        }));
      poDataMap[poDate].push({
        id: studentId,
        nameCn: s.nameCn || '',
        namePinyin: s.namePinyin || '',
        nickname: s.nickname || '',
        grade: s.grade || '-',
        school: s.school || '-',
        subjects: activeSubjects,
        diagnosticTests: s.diagnosticTests || [],
        poNote: poNote
      });
      renderDualCalendar();
      modal.classList.add('hidden');
      alert(t('dashboard.schedulePO.success'));
    } catch (err) {
      console.error('Error scheduling PO:', err);
      alert(t('dashboard.schedulePO.failed'));
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = t('dashboard.schedulePO.saveBtn');
    }
  };
}

async function fetchStudentsWithoutPO() {
  try {
    const snap = await get(ref(db, `centers/${centerId}/students`));
    if (!snap.exists()) {
      allStudentsForPO = [];
      return;
    }
    allStudentsForPO = [];
    snap.forEach(child => {
      const val = child.val();
      if (!val.poDate) {
        allStudentsForPO.push({
          id: child.key,
          nameCn: val.nameCn || '',
          namePinyin: val.namePinyin || '',
          grade: val.grade || '',
          studentNumber: val.studentNumber || ''
        });
      }
    });
    allStudentsForPO.sort((a, b) => {
      const nameA = (a.namePinyin || a.nameCn || '').toLowerCase();
      const nameB = (b.namePinyin || b.nameCn || '').toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });
  } catch (err) {
    console.error('Error fetching students for PO:', err);
    allStudentsForPO = [];
  }
}

async function loadCenterName() {
  if (!centerId) return;
  try {
    const centerSnap = await get(ref(db, `centers/${centerId}`));
    if (centerSnap.exists()) {
      const centerData = centerSnap.val();
      centerName = centerData.name || centerData.centerName || "Center";
      const calendarNameEl = document.getElementById('calendar-center-name');
      if (calendarNameEl) calendarNameEl.textContent = centerName;
      const titleCenterNameEl = document.getElementById('title-center-name');
      if (titleCenterNameEl) titleCenterNameEl.textContent = centerName;
      const mkLink = document.getElementById('link-mk-progress');
      if (mkLink) {
        const isMK = centerName.toLowerCase().includes('mei keng');
        if (isMK) {
          mkLink.style.display = 'flex';
        }
      }
    }
  } catch (err) {
    console.error("Error loading center name:", err);
  }
}

async function processResumeRequests() {
  if (!centerId) return;
  try {
    const snap = await get(ref(db, `centers/${centerId}/students`));
    if (!snap.exists()) return;
    const students = snap.val();
    const now = new Date();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentYear = String(now.getFullYear());
    for (const [studentId, student] of Object.entries(students)) {
      const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
      let changed = false;
      subjects.forEach(sub => {
        if (sub.resumeRequest && !sub.resumeRequest.processed) {
          const { returnMonth, returnYear } = sub.resumeRequest;
          if (returnYear && returnMonth) {
            if (parseInt(returnYear) < parseInt(currentYear) || 
                (parseInt(returnYear) === parseInt(currentYear) && parseInt(returnMonth) <= parseInt(currentMonth))) {
              sub.status = 'current';
              sub.resumed = true;
              sub.resumedAt = new Date().toISOString();
              delete sub.resumeRequest;
              changed = true;
            }
          }
        }
      });
      if (changed) {
        student.subjects = subjects;
        student.updatedAt = new Date().toISOString();
        await update(ref(db, `centers/${centerId}/students/${studentId}`), student);
      }
    }
  } catch (err) {
    console.error("Error processing resume requests:", err);
  }
}

async function processGradeUpdates() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const isAug15OrLater = (now.getMonth() > 7) || (now.getMonth() === 7 && now.getDate() >= 15);
  if (!isAug15OrLater) return; 
  const academicYear = currentYear;
  const studentsRef = ref(db, `centers/${centerId}/students`);
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

async function applyDashboardPermissions(user) {
  try {
    const userSnap = await get(ref(db, `users/${user.uid}`));
    if (!userSnap.exists()) return;
    const userData = userSnap.val();
    isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
    const dashPerms = userData.permissions?.dashboardCards || {};
    const cardMap = {
      'card-studentManagement': 'studentManagement',
      'card-timetable': 'timetable',
      'card-monthlyReports': 'monthlyReports',
      'card-progressCharts': 'progressCharts',
      'card-attendance': 'attendance',
      'card-followUps': 'followUps',
      'card-dropBook': 'dropBook',
      'card-bulletin': 'bulletin',
      'card-newStudentList': 'newStudentList',
      'card-labelEditor': 'labelEditor'
    };
    for (const [cardId, permKey] of Object.entries(cardMap)) {
      const card = document.getElementById(cardId);
      if (card) {
        if (isAdmin || dashPerms[permKey] === true) {
          card.style.display = 'flex'; 
        } else {
          card.style.display = 'none';
        }
      }
    }
    // 🕒 Show/hide New Attendance FAB item
    const fabAttendance = document.getElementById('fabAttendance');
    if (fabAttendance) {
      if (isAdmin || dashPerms.attendance === true) {
        fabAttendance.style.display = 'flex';
      } else {
        fabAttendance.style.display = 'none';
      }
    }
  } catch (err) {
    console.error("Error applying dashboard permissions:", err);
  }
}

// ============================================
// CALENDAR & PO LOGIC
// ============================================
async function initPOCalendar() {
  if (!centerId) return;
  try {
    const snap = await get(ref(db, `centers/${centerId}/students`));
    if (snap.exists()) {
      const students = snap.val();
      poDataMap = {};
      Object.entries(students).forEach(([id, s]) => {
        if (s.parentOrientation === 'Yes' && s.poDate) {
          const dateKey = s.poDate; 
          if (!poDataMap[dateKey]) poDataMap[dateKey] = [];
          const subjectsArray = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
          const activeSubjects = subjectsArray
            .filter(sub => sub.status !== 'drop' && sub.status !== 'pause')
            .map(sub => ({ 
              name: sub.name, 
              startLevel: sub.startLevel || '-', 
              startWS: sub.startWS || '-',
              currentLevel: sub.currentLevel || '-' 
            }));
          poDataMap[dateKey].push({
            id,
            nameCn: s.nameCn || '',
            namePinyin: s.namePinyin || '',
            nickname: s.nickname || '',
            grade: s.grade || '-',
            school: s.school || '-',
            subjects: activeSubjects,
            diagnosticTests: s.diagnosticTests || [],
            poNote: s.poNote || ''
          });
        }
      });
      // Map Diagnostic Tests to dtDataMap
      dtDataMap = {};
      Object.entries(students).forEach(([id, s]) => {
        if (s.diagnosticTests && Array.isArray(s.diagnosticTests)) {
          s.diagnosticTests.forEach(dt => {
            if (dt.date) {
              if (!dtDataMap[dt.date]) dtDataMap[dt.date] = [];
              dtDataMap[dt.date].push({
                id: id,
                studentData: s,
                dtData: dt
              });
            }
          });
        }
      });
    }
    const calSnap = await get(ref(db, `centers/${centerId}/calendar`));
    if (calSnap.exists()) {
      calendarEventsMap = calSnap.val();
    } else {
      calendarEventsMap = {};
    }
    renderDualCalendar();
    setupModalListeners();
  } catch (err) {
    console.error("Error loading calendar data: ", err);
  }
}

function renderDualCalendar() {
    const today = new Date(); // Actual current date (used for highlighting "today")
    
    // Use the viewed month/year instead of the actual current month
    const currentYear = viewYear;
    const currentMonth = viewMonth;
    
    const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
    const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;

    const monthNames = t('dashboard.months', { returnObjects: true });
    document.getElementById('currentMonthTitle').textContent = `${monthNames[currentMonth]} ${currentYear}`;
    document.getElementById('nextMonthTitle').textContent = `${monthNames[nextMonth]} ${nextYear}`;

    // Pass the actual 'today' date so the grid knows which day to highlight as "today"
    renderMonthGrid(currentYear, currentMonth, 'calendarCurrent', today);
    renderMonthGrid(nextYear, nextMonth, 'calendarNext', today);

    autoShrinkHolidayNames();
}


function initCalendarNav() {
    const prevBtn = document.getElementById('calPrevBtn');
    const nextBtn = document.getElementById('calNextBtn');
    const todayBtn = document.getElementById('calTodayBtn');

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            viewMonth--;
            if (viewMonth < 0) {
                viewMonth = 11;
                viewYear--;
            }
            renderDualCalendar();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            viewMonth++;
            if (viewMonth > 11) {
                viewMonth = 0;
                viewYear++;
            }
            renderDualCalendar();
        });
    }

    if (todayBtn) {
        todayBtn.addEventListener('click', () => {
            const now = new Date();
            viewYear = now.getFullYear();
            viewMonth = now.getMonth();
            renderDualCalendar();
        });
    }
}

function getClosedDaysForCenter(name) {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('mei keng')) return [0];
  if (lowerName.includes('pac tat')) return [0, 6];
  if (lowerName.includes('champs')) return [0];
  if (lowerName.includes('tap siac')) return [2];
  return [];
}

function autoShrinkHolidayNames() {
  document.querySelectorAll('.holiday-name, .other-name').forEach(el => {
    let fontSize = 0.6;
    el.style.fontSize = fontSize + 'rem';

    while (el.scrollWidth > el.clientWidth && fontSize > 0.35) {
      fontSize -= 0.05;
      el.style.fontSize = fontSize + 'rem';
    }
  });
}

// ============================================
// 🕒 DT TIMESLOT HELPERS
// ============================================
function getSubjectAbbr(subject) {
  if (subject === 'Math') return 'M';
  if (subject === 'English EFL') return 'L';
  if (subject === 'English ERP') return 'R';
  if ((subject || '').includes('Chinese')) return 'C';
  return subject ? subject.charAt(0).toUpperCase() : '';
}

function getDTDateWarnings(dateStr) {
  const warnings = [];
  if (!dateStr) return warnings;

  const event = calendarEventsMap[dateStr];
  const nameSuffix = event?.name ? `: ${event.name}` : '';

  if (event?.type === 'public') {
    warnings.push(t('dashboard.dtWarning.publicHoliday', {
      date: dateStr,
      name: nameSuffix
    }));
  }

  if (event?.type === 'center') {
    warnings.push(t('dashboard.dtWarning.centerHoliday', {
      date: dateStr,
      name: nameSuffix
    }));
  }

  const dateObj = new Date(`${dateStr}T00:00:00`);
  if (!isNaN(dateObj.getTime())) {
    const closedDays = getClosedDaysForCenter(centerName);
    if (closedDays.includes(dateObj.getDay())) {
      warnings.push(t('dashboard.dtWarning.closedDay', { date: dateStr }));
    }
  }

  return warnings;
}

function confirmDTDateWarnings(dates = []) {
  const uniqueWarnings = [
    ...new Set(
      dates
        .filter(Boolean)
        .flatMap(date => getDTDateWarnings(date))
    )
  ];

  if (uniqueWarnings.length === 0) return true;

  return confirm(
    `${t('dashboard.dtWarning.continueAnyway')}\n\n${uniqueWarnings.join('\n')}`
  );
}

// ============================================
// 🕒 GLOBAL DT DATE & TIMESLOT HELPERS
// ============================================
function ensureScheduleDTGlobalFields() {
  const container = document.getElementById('dtSubjectsContainer');
  if (!container || document.getElementById('dtGlobalFieldsWrapper')) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'dtGlobalFieldsWrapper';
  wrapper.innerHTML = `
    <div class="dt-global-date-group">
      <label for="dtDateInput" id="dtDateLabel">${t('dashboard.scheduleDT.dateLabel')}</label>
      <input type="date" id="dtDateInput" required>
    </div>
    <div class="dt-global-timeslot-group">
      <label for="dtTimeslotInput" id="dtTimeslotLabel">${t('dashboard.scheduleDT.timeslotLabel')}</label>
      <input type="time" id="dtTimeslotInput" required>
    </div>
  `;
  container.insertAdjacentElement('beforebegin', wrapper);
}

function ensureQIDTGlobalFields() {
  const container = document.getElementById('qiSubjectsContainer');
  if (!container || document.getElementById('qiGlobalFieldsWrapper')) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'qiGlobalFieldsWrapper';
  wrapper.innerHTML = `
    <div class="qi-global-dt-group">
      <label class="checkbox-label">
        <input type="checkbox" id="qiScheduleDTGlobal">
        <span id="qiScheduleDTGlobalLabel">${t('dashboard.inquiry.scheduleDTGlobal')}</span>
      </label>
    </div>
    <div class="qi-global-dt-details" id="qiGlobalDtDetails" style="display: none;">
      <div class="qi-form-grid">
        <div class="form-group">
          <label for="qiDTDateGlobal" id="qiDTDateLabel">${t('dashboard.inquiry.dtDate')}</label>
          <input type="date" id="qiDTDateGlobal">
        </div>
        <div class="form-group">
          <label for="qiDTTimeslotGlobal" id="qiDTTimeslotLabel">${t('dashboard.inquiry.dtTimeslot')}</label>
          <input type="time" id="qiDTTimeslotGlobal">
        </div>
      </div>
    </div>
  `;
  container.insertAdjacentElement('beforebegin', wrapper);

  const checkbox = document.getElementById('qiScheduleDTGlobal');
  const details = document.getElementById('qiGlobalDtDetails');
  checkbox.addEventListener('change', () => {
    details.style.display = checkbox.checked ? 'block' : 'none';
    if (!checkbox.checked) {
      document.getElementById('qiDTDateGlobal').value = '';
      document.getElementById('qiDTTimeslotGlobal').value = '';
    }
  });
}

// ============================================
// 🩷 OTHER EVENTS HELPERS
// ============================================

function generateOtherEventKey() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `other_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getOtherEventsFromCalendarEvent(event) {
  if (!event) return [];

  const results = [];

  if (event.others) {
    if (Array.isArray(event.others)) {
      event.others.forEach((item, index) => {
        if (!item) return;

        const name = typeof item === 'string' ? item : item.name;

        if (name) {
          results.push({
            id: item.id || `array_${index}`,
            name
          });
        }
      });
    } else if (typeof event.others === 'object') {
      Object.entries(event.others).forEach(([id, item]) => {
        if (!item) return;

        const name = typeof item === 'string' ? item : item.name;

        if (name) {
          results.push({
            id,
            name
          });
        }
      });
    }
  }

  // Legacy fallback:
  // If an older/simple version saved type: "other"
  if (event.type === 'other' && event.name) {
    results.push({
      id: 'legacy_other',
      name: event.name
    });
  }

  return results;
}

function renderOtherEventsList() {
  const list = document.getElementById('otherEventsList');
  if (!list) return;

  list.innerHTML = '';

  if (!pendingOtherEvents.length) {
    list.innerHTML = `<p class="no-other-events">${t('dashboard.noOtherEvents')}</p>`;
    return;
  }

  pendingOtherEvents.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'other-event-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'other-event-name';
    nameEl.textContent = item.name;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-other-btn';
    removeBtn.textContent = '×';
    removeBtn.title = t('dashboard.removeOther');

    removeBtn.onclick = () => {
      pendingOtherEvents.splice(index, 1);
      renderOtherEventsList();
    };

    row.appendChild(nameEl);
    row.appendChild(removeBtn);

    list.appendChild(row);
  });
}

function renderMonthGrid(year, month, containerId, todayDate) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(k => t('dashboard.days.' + k));
  days.forEach(day => {
    const header = document.createElement('div');
    header.className = 'calendar-day-header';
    header.textContent = day;
    container.appendChild(header);
  });
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const closedDays = getClosedDaysForCenter(centerName);
  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement('div');
    empty.className = 'calendar-day empty';
    container.appendChild(empty);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'calendar-day';
    cell.textContent = day;
    cell.dataset.date = dateStr;
    if (year === todayDate.getFullYear() && month === todayDate.getMonth() && day === todayDate.getDate()) {
      cell.classList.add('today');
    }
    const dayOfWeek = new Date(year, month, day).getDay();
    const isClosed = closedDays.includes(dayOfWeek);
    const event = calendarEventsMap[dateStr] || null;
const otherEvents = getOtherEventsFromCalendarEvent(event);

const hasHoliday = event && (
  event.type === 'center' ||
  event.type === 'public'
);

if (hasHoliday) {
  if (event.type === 'public') {
    cell.classList.add('has-public-holiday');
  }

  if (event.type === 'center') {
    cell.classList.add('has-center-holiday');
  }
}

if (otherEvents.length > 0) {
  cell.classList.add('has-other-event');
}

if (hasHoliday && event.name) {
  const nameEl = document.createElement('div');
  nameEl.className = 'holiday-name';
  nameEl.textContent = event.name;
  nameEl.title = event.name;
  cell.appendChild(nameEl);
}

otherEvents.forEach(other => {
  const otherEl = document.createElement('div');
  otherEl.className = 'holiday-name other-name';
  otherEl.textContent = other.name;
  otherEl.title = other.name;
  cell.appendChild(otherEl);
});

const tooltipParts = [];

if (poDataMap[dateStr] && poDataMap[dateStr].length > 0) {
  cell.classList.add('has-po');

  tooltipParts.push(
    t('dashboard.poTooltip', {
      count: poDataMap[dateStr].length
    })
  );
}

if (hasHoliday) {
  const hType = event.type === 'center'
    ? t('dashboard.holidayCenter')
    : t('dashboard.holidayPublic');

  let holidayText = `${hType} ${t('dashboard.holiday')}`;

  if (event.name) {
    holidayText += `: ${event.name}`;
  }

  if (event.muc) {
    holidayText += ` ${t('dashboard.muc')}`;
  }

  tooltipParts.push(holidayText);
}

if (otherEvents.length > 0) {
  tooltipParts.push(
    `${t('dashboard.holidayOther')}: ${otherEvents.map(o => o.name).join(', ')}`
  );
}

if (tooltipParts.length > 0) {
  cell.title = tooltipParts.join(' | ');
} else if (isClosed) {
  cell.classList.add('closed-day');
}
    const hasDT = dtDataMap[dateStr] && dtDataMap[dateStr].length > 0;

    if (hasDT) {
      cell.classList.add('has-dt');

      const dtCounts = {};
      const dtTimesBySubject = {};

      dtDataMap[dateStr].forEach(entry => {
        const subj = entry.dtData.subject || '';
        const abbr = getSubjectAbbr(subj);

        if (!abbr) return;

        dtCounts[abbr] = (dtCounts[abbr] || 0) + 1;

        if (!dtTimesBySubject[abbr]) {
          dtTimesBySubject[abbr] = [];
        }

        if (entry.dtData.DTtimeslot) {
          dtTimesBySubject[abbr].push(entry.dtData.DTtimeslot);
        }
      });

      const indicators = Object.entries(dtCounts)
        .map(([abbr, count]) => `${abbr} (${count})`)
        .join(' ');

      const indicatorEl = document.createElement('div');
      indicatorEl.className = 'dt-indicator';
      indicatorEl.textContent = indicators;
      cell.appendChild(indicatorEl);

      const tooltipIndicators = Object.entries(dtCounts)
        .map(([abbr, count]) => {
          const uniqueTimes = [...new Set(dtTimesBySubject[abbr] || [])].sort();
          const timeText = uniqueTimes.length
            ? uniqueTimes.join(', ')
            : t('dashboard.noTime');

          return `${abbr} (${count}) ${timeText}`;
        })
        .join(', ');

      const dtTooltip = t('dashboard.dtTooltip', {
        indicators: tooltipIndicators
      });

      cell.title = cell.title ? `${cell.title} | ${dtTooltip}` : dtTooltip;
    }
    container.appendChild(cell);
  }
}

function setupModalListeners() {
  const poModal = document.getElementById('poModal');
  const closePoBtn = document.getElementById('closePoModal');
  const editModal = document.getElementById('editCalendarModal');
  const closeEditBtn = document.getElementById('closeEditCalendarModal');
  const dtModal = document.getElementById('dtModal');
  const closeDtBtn = document.getElementById('closeDtModal');
document.addEventListener('click', (e) => {
  const dayEl = e.target.closest('.calendar-day');

  if (!dayEl || dayEl.classList.contains('empty')) return;

  const dateStr = dayEl.dataset.date;
  if (!dateStr) return;

  if (dayEl.classList.contains('has-po')) {
    openPOModal(dateStr);
    return;
  }

  if (dayEl.classList.contains('has-dt')) {
    openDTModal(dateStr);
    return;
  }

  if (isAdmin) {
    openEditCalendarModal(dateStr);
    return;
  }

  // Non-admin users can view Other events if they exist
  const event = calendarEventsMap[dateStr] || null;
  const otherEvents = getOtherEventsFromCalendarEvent(event);

  if (otherEvents.length > 0) {
    const message = [
      `${t('dashboard.holidayOther')}:`,
      ...otherEvents.map(o => `• ${o.name}`)
    ].join('\n');

    alert(message);
  }
});
  closeDtBtn.addEventListener('click', () => dtModal.classList.add('hidden'));
  dtModal.addEventListener('click', (e) => { if (e.target === dtModal) dtModal.classList.add('hidden'); });
  closePoBtn.addEventListener('click', () => poModal.classList.add('hidden'));
  poModal.addEventListener('click', (e) => { if (e.target === poModal) poModal.classList.add('hidden'); });
  closeEditBtn.addEventListener('click', () => editModal.classList.add('hidden'));
  editModal.addEventListener('click', (e) => { if (e.target === editModal) editModal.classList.add('hidden'); });
}

function openPOModal(dateStr) {
  const modal = document.getElementById('poModal');
  const title = document.getElementById('modalDateTitle');
  const list = document.getElementById('poStudentList');
  const dateObj = new Date(dateStr + 'T00:00:00');
  title.textContent = t('dashboard.poOnDate', {
    date: dateObj.toLocaleDateString(dateLocale(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  });
  list.innerHTML = '';
  const students = poDataMap[dateStr] || [];
  if (students.length === 0) {
    list.innerHTML = `<p style="text-align:center; color:#666;">${t('dashboard.noOrientations')}</p>`;
  } else {
    students.forEach(student => {
      const card = document.createElement('div');
      card.className = 'po-student-card';
      const nameParts = [];
      if (student.nameCn) nameParts.push(`<span class="student-name-cn">${student.nameCn}</span>`);
      if (student.namePinyin) nameParts.push(`<span class="student-name-pinyin">(${student.namePinyin})</span>`);
      if (student.nickname) nameParts.push(`<span class="student-name-nickname">"${student.nickname}"</span>`);
      const fullNameHtml = nameParts.length > 0 ? nameParts.join(' ') : t('dashboard.unknownStudent');
      const subjectsHtml = student.subjects.length > 0 
        ? student.subjects.map(s => `<span class="po-subject-tag">${s.name} (Current: ${s.currentLevel})</span>`).join('')
        : `<span style="color:#999; font-size:0.85rem;">${t('dashboard.noActiveSubjects')}</span>`;
        let dtHtml = '';

        if (student.diagnosticTests && student.diagnosticTests.length > 0) {
          dtHtml = `
            <div class="dt-table-wrapper">
              <table class="dt-mini-table">
                <thead>
                  <tr>
                    <th>${t('dashboard.poTable.date')}</th>
                    <th>${t('dashboard.poTable.subject')}</th>
                    <th>${t('dashboard.poTable.timeslot')}</th>
                    <th>${t('dashboard.poTable.testAt')}</th>
                    <th>${t('dashboard.poTable.score')}</th>
                    <th>${t('dashboard.poTable.time')}</th>
                    <th>${t('dashboard.poTable.startLvl')}</th>
                    <th>${t('dashboard.poTable.startWS')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${student.diagnosticTests.map(dt => {
                    const subj = student.subjects.find(s => s.name === dt.subject);
                    const startLvl = subj ? subj.startLevel : '-';
                    const startWs = subj ? subj.startWS : '-';

                    return `
                      <tr>
                        <td>${dt.date || '-'}</td>
                        <td>${dt.subject || '-'}</td>
                        <td>${dt.DTtimeslot ? dt.DTtimeslot : t('dashboard.noTime')}</td>
                        <td>${dt.test || '-'}</td>
                        <td>${dt.score || '-'}</td>
                        <td>${dt.time ? dt.time : '-'}</td>
                        <td>${startLvl}</td>
                        <td>${startWs}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `;
        } else {
          dtHtml = `<p style="font-size:0.85rem; color:#999; margin-top:0.5rem;">${t('dashboard.noDTRecorded')}</p>`;
        }
      card.innerHTML = `
        <h4>
          <span> ${fullNameHtml}</span>
          <span class="grade-school-badge">${t('dashboard.gradeSchool', { grade: student.grade, school: student.school })}</span>
        </h4>
        <div class="po-detail-grid">
          <div class="po-detail-item">
            <strong>${t('dashboard.subjectsLevels')}</strong>
            <div>${subjectsHtml}</div>
          </div>
        </div>
        <div class="po-detail-item">
          <strong>${t('dashboard.dtResults')}</strong>
          ${dtHtml}
        </div>
        <div class="po-note-wrapper">
          <label for="note-${student.id}">${t('dashboard.instructorNotes')}</label>
          <textarea id="note-${student.id}" class="po-note-area" placeholder="${t('dashboard.poNotePlaceholder')}">${student.poNote}</textarea>
          <div style="display:flex; align-items:center; margin-top: 0.5rem;">
            <button class="save-note-btn" onclick="savePoNote('${student.id}', 'note-${student.id}', this)">${t('common.saveNote')}</button>
            <span class="save-status" id="status-${student.id}">${t('common.saved')}</span>
          </div>
        </div>
      `;
      list.appendChild(card);
    });
  }
const existingBtn =
  document.getElementById('adminEditCalendarFromPoBtn') ||
  document.getElementById('adminEditHolidayBtn');

if (existingBtn) existingBtn.remove();

if (isAdmin) {
  const editCalBtn = document.createElement('button');

  editCalBtn.id = 'adminEditCalendarFromPoBtn';
  editCalBtn.className = 'save-note-btn';
  editCalBtn.style.marginTop = '1.5rem';
  editCalBtn.style.background = '#be185d';
  editCalBtn.style.width = '100%';
  editCalBtn.textContent = t('dashboard.editCalendarOtherBtn');

  editCalBtn.onclick = () => {
    modal.classList.add('hidden');
    openEditCalendarModal(dateStr);
  };

  modal.querySelector('.modal-content').appendChild(editCalBtn);
}
  modal.classList.remove('hidden');
}

function openEditCalendarModal(dateStr) {
  const modal = document.getElementById('editCalendarModal');
  const title = document.getElementById('editCalendarDateTitle');
  const form = document.getElementById('editCalendarForm');

  if (!modal || !form) return;

  editingCalendarDate = dateStr;

  const dateObj = new Date(dateStr + 'T00:00:00');

  title.textContent = t('dashboard.editCalendarTitle', {
    date: dateObj.toLocaleDateString(dateLocale(), {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  });

  form.reset();

  const existingEvent = calendarEventsMap[dateStr] || {};

  const holidayType =
    existingEvent.type === 'center' ||
    existingEvent.type === 'public'
      ? existingEvent.type
      : 'none';

  const radio = form.querySelector(`input[name="eventType"][value="${holidayType}"]`);

  if (radio) {
    radio.checked = true;
  }

  const noteInput = document.getElementById('calendarNote');

  if (noteInput) {
    noteInput.value = holidayType === 'none'
      ? ''
      : (existingEvent.name || '');
  }

  // Load Other events
  pendingOtherEvents = getOtherEventsFromCalendarEvent(existingEvent).map(item => ({
    id: item.id,
    name: item.name
  }));

  renderOtherEventsList();

  const otherSection = document.getElementById('otherEventsSection');
  if (otherSection) {
    otherSection.style.display = isAdmin ? 'block' : 'none';
  }

  const addOtherBtn = document.getElementById('addOtherEventBtn');
  const newOtherInput = document.getElementById('newOtherEventInput');

  if (newOtherInput) {
    newOtherInput.value = '';
  }

  if (addOtherBtn && newOtherInput) {
    addOtherBtn.onclick = () => {
      const value = newOtherInput.value.trim();

      if (!value) return;

      pendingOtherEvents.push({
        id: null,
        name: value
      });

      newOtherInput.value = '';
      renderOtherEventsList();
      newOtherInput.focus();
    };

    newOtherInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addOtherBtn.click();
      }
    };
  }

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();

    const eventType = form.querySelector('input[name="eventType"]:checked')?.value || 'none';
    const note = document.getElementById('calendarNote').value.trim();

    const saveBtn = form.querySelector('button[type="submit"]');

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = t('common.saving');
    }

    try {
      const othersPayload = {};

      pendingOtherEvents.forEach(item => {
        const key = item.id && item.id !== 'legacy_other' && !String(item.id).startsWith('array_')
          ? item.id
          : generateOtherEventKey();

        othersPayload[key] = {
          name: item.name,
          updatedAt: new Date().toISOString()
        };
      });

      const hasHoliday = eventType !== 'none';
      const hasOthers = Object.keys(othersPayload).length > 0;

      const calendarRef = ref(db, `centers/${centerId}/calendar/${dateStr}`);

      if (!hasHoliday && !hasOthers) {
        await remove(calendarRef);
        delete calendarEventsMap[dateStr];
      } else {
        const updates = {
          type: hasHoliday ? eventType : null,
          name: hasHoliday ? note : null,
          muc: hasHoliday ? (existingEvent.muc || false) : null,
          others: hasOthers ? othersPayload : null,
          updatedAt: new Date().toISOString()
        };

        await update(calendarRef, updates);

        const newLocalEvent = {};

        if (hasHoliday) {
          newLocalEvent.type = eventType;
          newLocalEvent.name = note;
          newLocalEvent.muc = existingEvent.muc || false;
        }

        if (hasOthers) {
          newLocalEvent.others = othersPayload;
        }

        calendarEventsMap[dateStr] = newLocalEvent;
      }

      renderDualCalendar();
      modal.classList.add('hidden');
    } catch (err) {
      console.error("Error saving calendar event:", err);
      alert(t('dashboard.failedSave'));
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = t('common.saveChanges');
      }
    }
  };

  const clearBtn = document.getElementById('clearCalendarBtn');

  if (clearBtn) {
    clearBtn.onclick = () => {
      if (!confirm(t('dashboard.confirmClearEvent'))) return;

      const noneRadio = form.querySelector('input[name="eventType"][value="none"]');

      if (noneRadio) {
        noneRadio.checked = true;
      }

      const noteInput = document.getElementById('calendarNote');

      if (noteInput) {
        noteInput.value = '';
      }

      /*
        By default, Clear Event clears the holiday only.
        It does NOT clear Other events.

        If you want Clear Event to also delete all Other events,
        uncomment these lines:

        pendingOtherEvents = [];
        renderOtherEventsList();
      */

      form.dispatchEvent(new Event('submit'));
    };
  }
}

window.savePoNote = async function(studentId, textareaId, btnElement) {
  const textarea = document.getElementById(textareaId);
  const statusEl = document.getElementById(`status-${studentId}`);
  const noteText = textarea.value.trim();
  btnElement.disabled = true;
  btnElement.textContent = t('common.saving');
  try {
    await update(ref(db, `centers/${centerId}/students/${studentId}`), {
      poNote: noteText,
      updatedAt: new Date().toISOString()
    });
    const dateStr = Object.keys(poDataMap).find(key => 
      poDataMap[key].some(s => s.id === studentId)
    );
    if (dateStr) {
      const student = poDataMap[dateStr].find(s => s.id === studentId);
      if (student) student.poNote = noteText;
    }
    statusEl.classList.add('visible');
    setTimeout(() => statusEl.classList.remove('visible'), 2500);
  } catch (err) {
    console.error("Error saving note:", err);
    alert(t('dashboard.failedSaveNote'));
  } finally {
    btnElement.disabled = false;
    btnElement.textContent = t('common.saveNote');
  }
};


// ============================================
// SEARCH STUDENT MODAL LOGIC
// ============================================
let allStudentsForSearch = [];

function setupSearchStudentModalListeners() {
  const modal = document.getElementById('searchStudentModal');
  const closeBtn = document.getElementById('closeSearchStudentModal');
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
}

async function openSearchStudentModal() {
  const modal = document.getElementById('searchStudentModal');
  const searchInput = document.getElementById('searchStudentInput');
  const dropdown = document.getElementById('searchStudentDropdown');
  const selectedInfo = document.getElementById('selectedSearchStudentInfo');
  const hiddenId = document.getElementById('selectedSearchStudentId');
  const openFormBtn = document.getElementById('openStudentFormBtn');

  searchInput.value = '';
  dropdown.innerHTML = '';
  dropdown.style.display = 'none';
  selectedInfo.style.display = 'none';
  selectedInfo.textContent = '';
  hiddenId.value = '';
  openFormBtn.disabled = true;

  await fetchStudentsForSearch();
  modal.classList.remove('hidden');
  setTimeout(() => searchInput.focus(), 100);

  searchInput.oninput = () => {
    const term = searchInput.value.toLowerCase().trim();
    if (!term) {
      dropdown.style.display = 'none';
      return;
    }
    const matches = allStudentsForSearch.filter(s => 
      (s.namePinyin || '').toLowerCase().includes(term) ||
      (s.nameCn || '').toLowerCase().includes(term) ||
      (s.nickname || '').toLowerCase().includes(term) ||
      (s.studentNumber || '').toLowerCase().includes(term) ||
      (s.phoneMom || '').toLowerCase().includes(term) ||
      (s.phoneDad || '').toLowerCase().includes(term) ||
      (s.phoneOwn || '').toLowerCase().includes(term)
    );
    dropdown.innerHTML = '';
    if (matches.length === 0) {
      dropdown.innerHTML = `<li style="padding:0.75rem; color:#999; text-align:center;">${t('dashboard.noStudentsFound')}</li>`;
    } else {
      matches.slice(0, 30).forEach(s => {
        const li = document.createElement('li');
        li.style.padding = '0.75rem';
        li.style.cursor = 'pointer';
        li.style.borderBottom = '1px solid #f1f5f9';
            const nicknameHtml = s.nickname ? `<span style="color:var(--primary-dark); font-weight:500; font-style:italic;">"${s.nickname}"</span> ` : '';
            li.innerHTML = `
                <div style="font-weight:600; color:var(--text);">${nicknameHtml}${s.nameCn || 'N/A'} <span style="color:var(--text-light); font-weight:400;">(${s.namePinyin || ''})</span></div>
                <div style="font-size:0.8rem; color:var(--text-light); margin-top:0.25rem;">
                    ${t('dashboard.gradeNo', { grade: s.grade || '-', number: s.studentNumber || '-' })}
                </div>
          ${s.phoneMom || s.phoneDad || s.phoneOwn ? `
          <div style="font-size:0.75rem; color:#666; margin-top:0.25rem;">
            📞 ${s.phoneMom ? t('dashboard.phoneMom', { value: s.phoneMom }) : ''} 
            ${s.phoneMom && s.phoneDad ? ' | ' : ''}
            ${s.phoneDad ? t('dashboard.phoneDad', { value: s.phoneDad }) : ''}
            ${(s.phoneMom && s.phoneOwn) || (s.phoneDad && s.phoneOwn) ? ' | ' : ''}
            ${s.phoneOwn ? t('dashboard.phoneOwn', { value: s.phoneOwn }) : ''}
          </div>` : ''}
        `;
        li.onclick = () => {
          hiddenId.value = s.id;
          searchInput.value = `${s.nameCn} (${s.namePinyin})`;
          selectedInfo.textContent = t('dashboard.selected', { name: `${s.nameCn} (${s.namePinyin})` });
          selectedInfo.style.display = 'block';
          dropdown.style.display = 'none';
          openFormBtn.disabled = false;
        };
        li.onmouseover = () => li.style.background = '#f8fafc';
        li.onmouseout = () => li.style.background = 'white';
        dropdown.appendChild(li);
      });
    }
    dropdown.style.display = 'block';
  };
  searchInput.onblur = () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 200);
  };

  openFormBtn.onclick = () => {
    const studentId = hiddenId.value;
    if (!studentId) return alert(t('dashboard.schedulePO.selectStudent'));
    window.location.href = `student-form.html?id=${studentId}&returnUrl=dashboard.html`;
  };
}

// ============================================
// 🟠 DT DETAILS MODAL (CALENDAR CLICK)
// ============================================
function openDTModal(dateStr) {
  const modal = document.getElementById('dtModal');
  const title = document.getElementById('dtModalDateTitle');
  const list = document.getElementById('dtStudentList');
  const dateObj = new Date(dateStr + 'T00:00:00');
  title.textContent = t('dashboard.dtOnDate', {
    date: dateObj.toLocaleDateString(dateLocale(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  });
  list.innerHTML = '';
  const entries = dtDataMap[dateStr] || [];

  if (entries.length === 0) {
    list.innerHTML = `<p style="text-align:center; color:#666;">${t('dashboard.noDTs')}</p>`;
  } else {
    const groupedByStudent = {};
    entries.forEach(entry => {
      if (!groupedByStudent[entry.id]) groupedByStudent[entry.id] = [];
      groupedByStudent[entry.id].push(entry);
    });

    Object.entries(groupedByStudent).forEach(([studentId, studentEntries]) => {
      const s = studentEntries[0].studentData;
      const card = document.createElement('div');
      card.className = 'po-student-card';
      card.style.borderLeftColor = '#FF8C00';

      const nameParts = [];
      if (s.nameCn) nameParts.push(`<span class="student-name-cn">${s.nameCn}</span>`);
      if (s.namePinyin) nameParts.push(`<span class="student-name-pinyin">(${s.namePinyin})</span>`);
      if (s.nickname) nameParts.push(`<span class="student-name-nickname">"${s.nickname}"</span>`);
      const fullNameHtml = nameParts.length > 0 ? nameParts.join(' ') : t('dashboard.unknownStudent');
      
      const phone = s.phone ? `${s.phone.mom || ''} ${s.phone.dad ? '| ' + s.phone.dad : ''} ${s.phone.own ? '| ' + s.phone.own : ''}`.trim().replace(/^\| /, '') : 'N/A';
      
      const subjectsArray = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
      const activeSubjects = subjectsArray.filter(sub => sub.status !== 'drop').map(sub => sub.name);
      const subjectsHtml = activeSubjects.length > 0 
        ? activeSubjects.map(name => `<span class="po-subject-tag">${name}</span>`).join('')
        : `<span style="color:#999; font-size:0.85rem;">${t('dashboard.noActiveSubjects')}</span>`;

      let dtTableHtml = `
        <div class="dt-table-wrapper">
          <table class="dt-mini-table">
            <thead>
              <tr>
                <th>${t('dashboard.dtTable.subject')}</th>
                <th>${t('dashboard.dtTable.timeslot')}</th>
                <th>${t('dashboard.dtTable.test')}</th>
                <th>${t('dashboard.dtTable.score')}</th>
                <th>${t('dashboard.dtTable.time')}</th>
                <th>${t('dashboard.dtTable.suggested')}</th>
                <th>${t('dashboard.dtTable.actual')}</th>
                <th>${t('dashboard.dtTable.note')}</th>
                <th>${t('dashboard.dtTable.action')}</th>
              </tr>
            </thead>
            <tbody>
      `;

      studentEntries.forEach(entry => {
        const dt = entry.dtData;
        const safeSubject = (dt.subject || '').replace(/'/g, "\\'");
        const safeTime = dt.DTtimeslot || '';

        dtTableHtml += `
          <tr>
            <td>${dt.subject || '-'}</td>
            <td>${dt.DTtimeslot ? dt.DTtimeslot : t('dashboard.noTime')}</td>
            <td>${dt.test || '-'}</td>
            <td>${dt.score || '-'}</td>
            <td>${dt.time || '-'}</td>
            <td>${dt.suggestedStart || '-'}</td>
            <td>${dt.actualStart || '-'}</td>
            <td>${dt.dtNote || '-'}</td>
            <td style="white-space: nowrap;">
              <button class="dt-action-btn cancel"
                data-student="${studentId}"
                data-date="${dateStr}"
                data-subject="${safeSubject}"
                title="Cancel DT">❌</button>

              <button class="dt-action-btn reschedule"
                data-student="${studentId}"
                data-date="${dateStr}"
                data-subject="${safeSubject}"
                data-time="${safeTime}"
                title="Reschedule DT">📅</button>
            </td>
          </tr>
        `;
      });

      dtTableHtml += `</tbody></table></div>`;

      const firstDt = studentEntries[0].dtData;
      const noteId = `dt-note-${studentId}`;
      
      card.innerHTML = `
        <h4>
          <span>${fullNameHtml}</span>
          <span class="grade-school-badge">${t('dashboard.gradeSchool', { grade: s.grade || 'N/A', school: s.school || 'N/A' })}</span>
        </h4>
        <div class="po-detail-grid">
          <div class="po-detail-item"><strong>${t('dashboard.birthday')}</strong><div>${s.birthday || s.dob || 'N/A'}</div></div>
          <div class="po-detail-item"><strong>${t('dashboard.contact')}</strong><div>${phone}</div></div>
          <div class="po-detail-item"><strong>${t('dashboard.subjects')}</strong><div>${subjectsHtml}</div></div>
        </div>
        <div class="po-detail-item">
          <strong>${t('dashboard.dtDetails')}</strong>
          ${dtTableHtml}
        </div>
        <div class="po-note-wrapper">
          <label for="${noteId}">${t('dashboard.dtNotes')}</label>
          <textarea id="${noteId}" class="po-note-area" placeholder="${t('dashboard.dtNotePlaceholder')}">${firstDt.dtNote || ''}</textarea>
          <div style="display:flex; align-items:center; margin-top: 0.5rem;">
            <button class="save-note-btn" onclick="saveDtNote('${studentId}', '${dateStr}', '${noteId}', this)">${t('common.saveNote')}</button>
            <span class="save-status" id="dt-status-${studentId}">${t('common.saved')}</span>
          </div>
        </div>
      `;
      list.appendChild(card);

      card.querySelectorAll('.dt-action-btn.cancel').forEach(btn => {
        btn.onclick = () => cancelDT(btn.dataset.student, btn.dataset.date, btn.dataset.subject);
      });
      card.querySelectorAll('.dt-action-btn.reschedule').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();

          const cell = btn.closest('td');
          if (!cell || cell.querySelector('.inline-reschedule-wrapper')) return;

          const { student, date: oldDate, subject } = btn.dataset;
          const oldTime = btn.dataset.time || '';

          cell.querySelectorAll('.dt-action-btn').forEach(b => (b.style.display = 'none'));

          const wrapper = document.createElement('div');
          wrapper.className = 'inline-reschedule-wrapper';
          wrapper.innerHTML = `
            <input type="date" class="inline-reschedule-date" value="${oldDate}">
            <input type="time" class="inline-reschedule-time" value="${oldTime}">
            <button type="button" class="inline-confirm-btn" title="Confirm">✓</button>
            <button type="button" class="inline-cancel-btn" title="Cancel">×</button>
          `;

          cell.appendChild(wrapper);

          const dateInput = wrapper.querySelector('.inline-reschedule-date');
          const timeInput = wrapper.querySelector('.inline-reschedule-time');
          const confirmBtn = wrapper.querySelector('.inline-confirm-btn');
          const cancelBtn = wrapper.querySelector('.inline-cancel-btn');

          const restoreButtons = () => {
            wrapper.remove();
            cell.querySelectorAll('.dt-action-btn').forEach(b => (b.style.display = ''));
          };

          confirmBtn.onclick = async (ev) => {
            ev.stopPropagation();

            const newDate = dateInput.value;
            const newTime = timeInput.value;

            if (!newDate) {
              alert(t('dashboard.schedulePO.selectDate'));
              return;
            }

            if (newDate === oldDate && newTime === oldTime) {
              restoreButtons();
              return;
            }

            if (!confirmDTDateWarnings([newDate])) {
              return;
            }

            restoreButtons();
            await rescheduleDT(student, oldDate, subject, newDate, newTime);
          };

          cancelBtn.onclick = (ev) => {
            ev.stopPropagation();
            restoreButtons();
          };

          dateInput.onkeydown = (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              confirmBtn.click();
            }

            if (ev.key === 'Escape') {
              ev.stopPropagation();
              cancelBtn.click();
            }
          };

          timeInput.onkeydown = (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              confirmBtn.click();
            }

            if (ev.key === 'Escape') {
              ev.stopPropagation();
              cancelBtn.click();
            }
          };
        };
      });
    });
  }
  const existingDtBtn = document.getElementById('adminEditCalendarFromDtBtn');

  if (existingDtBtn) {
    existingDtBtn.remove();
  }

  if (isAdmin) {
    const editCalBtn = document.createElement('button');

    editCalBtn.id = 'adminEditCalendarFromDtBtn';
    editCalBtn.className = 'save-note-btn';
    editCalBtn.style.marginTop = '1.5rem';
    editCalBtn.style.background = '#be185d';
    editCalBtn.style.width = '100%';
    editCalBtn.textContent = t('dashboard.editCalendarOtherBtn');

    editCalBtn.onclick = () => {
      modal.classList.add('hidden');
      openEditCalendarModal(dateStr);
    };

    modal.querySelector('.modal-content').appendChild(editCalBtn);
  }
  modal.classList.remove('hidden');
}

async function cancelDT(studentId, dateStr, subject) {
  if (!confirm(t('dashboard.cancelDT.confirm', { subject, date: dateStr }))) return;
  try {
    const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
    if (!snap.exists()) return;
    const s = snap.val();
    if (s.diagnosticTests) {
      s.diagnosticTests = s.diagnosticTests.filter(dt => !(dt.date === dateStr && dt.subject === subject));
      await update(ref(db, `centers/${centerId}/students/${studentId}`), { diagnosticTests: s.diagnosticTests });
    }
    if (dtDataMap[dateStr]) {
      dtDataMap[dateStr] = dtDataMap[dateStr].filter(entry => !(entry.id === studentId && entry.dtData.date === dateStr && entry.dtData.subject === subject));
      if (dtDataMap[dateStr].length === 0) delete dtDataMap[dateStr];
    }
    renderDualCalendar();
    openDTModal(dateStr);
    alert(t('dashboard.cancelDT.success'));
  } catch (err) {
    console.error('Error cancelling DT:', err);
    alert(t('dashboard.cancelDT.failed'));
  }
}

async function rescheduleDT(studentId, oldDateStr, subject, newDateStr, newTimeslot = null) {
  try {
    const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
    if (!snap.exists()) return;

    const s = snap.val();
    let updatedDt = null;

    if (s.diagnosticTests) {
      const dt = s.diagnosticTests.find(d => d.date === oldDateStr && d.subject === subject);

      if (dt) {
        const existsOnNewDate = s.diagnosticTests.some(
          d => d !== dt && d.subject === subject && d.date === newDateStr
        );

        if (existsOnNewDate) {
          alert(t('dashboard.rescheduleDT.exists'));
          openDTModal(oldDateStr);
          return;
        }

        dt.date = newDateStr;

        if (newTimeslot !== null) {
          dt.DTtimeslot = newTimeslot;
        }

        updatedDt = dt;
      }
    }

    if (!updatedDt) return;

    await update(ref(db, `centers/${centerId}/students/${studentId}`), {
      diagnosticTests: s.diagnosticTests
    });

    if (dtDataMap[oldDateStr]) {
      const entryIndex = dtDataMap[oldDateStr].findIndex(
        e =>
          e.id === studentId &&
          e.dtData.date === oldDateStr &&
          e.dtData.subject === subject
      );

      if (entryIndex !== -1) {
        const entry = dtDataMap[oldDateStr][entryIndex];

        entry.dtData.date = newDateStr;

        if (newTimeslot !== null) {
          entry.dtData.DTtimeslot = newTimeslot;
        }

        if (oldDateStr !== newDateStr) {
          if (!dtDataMap[newDateStr]) dtDataMap[newDateStr] = [];

          dtDataMap[newDateStr].push(entry);
          dtDataMap[oldDateStr].splice(entryIndex, 1);

          if (dtDataMap[oldDateStr].length === 0) {
            delete dtDataMap[oldDateStr];
          }
        }
      }
    }

    renderDualCalendar();
    openDTModal(newDateStr);
    alert(t('dashboard.rescheduleDT.success'));
  } catch (err) {
    console.error('Error rescheduling DT:', err);
    alert(t('dashboard.rescheduleDT.failed'));
  }
}

window.saveDtNote = async function(studentId, dateStr, textareaId, btnElement) {
  const textarea = document.getElementById(textareaId);
  const statusEl = document.getElementById(`dt-status-${studentId}`);
  const noteText = textarea.value.trim();
  btnElement.disabled = true;
  btnElement.textContent = t('common.saving');
  try {
    const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
    if (snap.exists()) {
      const s = snap.val();
      if (s.diagnosticTests && Array.isArray(s.diagnosticTests)) {
        let updated = false;
        s.diagnosticTests.forEach(dt => {
          if (dt.date === dateStr) { dt.dtNote = noteText; updated = true; }
        });
        if (updated) await update(ref(db, `centers/${centerId}/students/${studentId}`), { diagnosticTests: s.diagnosticTests });
      }
    }
    if (dtDataMap[dateStr]) {
      dtDataMap[dateStr].forEach(entry => {
        if (entry.id === studentId && entry.dtData.date === dateStr) entry.dtData.dtNote = noteText;
      });
    }
    statusEl.classList.add('visible');
    setTimeout(() => statusEl.classList.remove('visible'), 2500);
  } catch (err) {
    console.error("Error saving DT note:", err);
    alert(t('dashboard.failedSaveNote'));
  } finally {
    btnElement.disabled = false;
    btnElement.textContent = t('common.saveNote');
  }
};

// ============================================
// 📝 SCHEDULE DT MODAL (FAB ACTION)
// ============================================
function openScheduleDTModalDash() {
  const modal = document.getElementById('scheduleDTModalDash');
  const existingForm = document.getElementById('dtExistingForm');
  const searchInput = document.getElementById('dtStudentSearch');
  const dropdown = document.getElementById('dtStudentListDropdown');
  const selectedInfo = document.getElementById('selectedDTStudentInfo');
  const hiddenId = document.getElementById('selectedDTStudentId');
  const container = document.getElementById('dtSubjectsContainer');

  existingForm.style.display = 'none';
  searchInput.value = '';
  dropdown.innerHTML = '';
  dropdown.style.display = 'none';
  selectedInfo.style.display = 'none';
  hiddenId.value = '';
  container.innerHTML = '';

  // Inject global fields and reset them
  ensureScheduleDTGlobalFields();
  const dtDateLabel = document.getElementById('dtDateLabel');
  if (dtDateLabel) {
    dtDateLabel.textContent = t('dashboard.scheduleDT.dateLabel');
  }
  const dtTimeslotLabel = document.getElementById('dtTimeslotLabel');
  if (dtTimeslotLabel) {
    dtTimeslotLabel.textContent = t('dashboard.scheduleDT.timeslotLabel');
  }
  const dtDateInput = document.getElementById('dtDateInput');
  const dtTimeslotInput = document.getElementById('dtTimeslotInput');

if (dtDateInput) dtDateInput.value = '';
if (dtTimeslotInput) dtTimeslotInput.value = '';

  addDTSubjectRow(); 

  modal.classList.remove('hidden');
  document.getElementById('dtNewStudentBtn').onclick = () => {
    window.location.href = 'student-form.html?returnUrl=dashboard.html';
  };
  document.getElementById('dtExistingStudentBtn').onclick = async () => {
    existingForm.style.display = 'block';
    if (allStudentsForSearch.length === 0) await fetchStudentsForSearch();
  };
  document.getElementById('addDTSubjectRowBtn').onclick = () => addDTSubjectRow();

  searchInput.oninput = () => {
    const term = searchInput.value.toLowerCase().trim();
    if (!term) { dropdown.style.display = 'none'; return; }
    const matches = allStudentsForSearch.filter(s => 
      (s.namePinyin || '').toLowerCase().includes(term) ||
      (s.nameCn || '').toLowerCase().includes(term) ||
      (s.studentNumber || '').toLowerCase().includes(term)
    );
    dropdown.innerHTML = '';
    if (matches.length === 0) {
      dropdown.innerHTML = `<li style="padding:0.75rem; color:#999; text-align:center;">${t('dashboard.noStudentsFound')}</li>`;
    } else {
      matches.slice(0, 20).forEach(s => {
        const li = document.createElement('li');
        li.style.cssText = 'padding:0.75rem; cursor:pointer; border-bottom:1px solid #f1f5f9;';
        li.innerHTML = `
          <div style="font-weight:600;">${s.nameCn || 'N/A'} <span style="color:var(--text-light); font-weight:400;">(${s.namePinyin || ''})</span></div>
          <div style="font-size:0.8rem; color:var(--text-light);">${t('dashboard.gradeNo', { grade: s.grade || '-', number: s.studentNumber || '-' })}</div>
        `;
        li.onclick = () => {
          hiddenId.value = s.id;
          searchInput.value = `${s.nameCn} (${s.namePinyin})`;
          document.getElementById('selectedDTStudentName').textContent = `${s.nameCn} (${s.namePinyin})`;
          selectedInfo.style.display = 'flex'; 
          dropdown.style.display = 'none';
        };
        li.onmouseover = () => li.style.background = '#f8fafc';
        li.onmouseout = () => li.style.background = 'white';
        dropdown.appendChild(li);
      });
    }
    dropdown.style.display = 'block';
  };
  searchInput.onblur = () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 200);
  };

document.getElementById('saveScheduleDTBtnDash').onclick = async () => {
  const studentId = hiddenId.value;
  if (!studentId) return alert(t('dashboard.schedulePO.selectStudent'));

  const globalDate = document.getElementById('dtDateInput')?.value || '';
  const globalTimeslot = document.getElementById('dtTimeslotInput')?.value || '';

  if (!globalDate) return alert(t('dashboard.scheduleDT.selectDate'));
  if (!globalTimeslot) return alert(t('dashboard.scheduleDT.selectTimeslot'));

  const rows = container.querySelectorAll('.dt-subject-row');
  const dtEntries = [];
  let hasError = false;
  let duplicateSubject = null;
  const seenSubjects = new Set();

  for (const row of rows) {
    const subject = row.querySelector('.dt-row-subject')?.value || '';
    if (subject) {
      if (seenSubjects.has(subject)) {
        duplicateSubject = subject;
        break;
      }
      seenSubjects.add(subject);
      dtEntries.push({ subject });
    } else {
      hasError = true;
    }
  }

  if (duplicateSubject) {
    return alert(t('dashboard.scheduleDT.duplicateSubject', { subject: duplicateSubject }));
  }
  if (hasError) return alert(t('dashboard.scheduleDT.completeBoth'));
  if (dtEntries.length === 0) return alert(t('dashboard.scheduleDT.addAtLeastOne'));

  if (!confirmDTDateWarnings([globalDate])) return;

  const saveBtn = document.getElementById('saveScheduleDTBtnDash');

  try {
    const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
    if (!snap.exists()) throw new Error('Student not found.');

    const s = snap.val();
    if (!s.diagnosticTests) s.diagnosticTests = [];

    // Check against existing DB records: block same subject + same date
    let existingDuplicate = null;
    for (const entry of dtEntries) {
      const exists = s.diagnosticTests.some(
        dt => dt.subject === entry.subject && dt.date === globalDate
      );
      if (exists) {
        existingDuplicate = entry;
        break;
      }
    }

    if (existingDuplicate) {
      return alert(t('dashboard.scheduleDT.duplicateSubjectDate', { 
        subject: existingDuplicate.subject, 
        date: globalDate 
      }));
    }

    saveBtn.disabled = true;
    saveBtn.textContent = t('common.saving');

    let addedCount = 0;
    for (const entry of dtEntries) {
      const newDT = {
        subject: entry.subject,
        date: globalDate,
        DTtimeslot: globalTimeslot,
        test: '', score: '', time: '', suggestedStart: '', actualStart: '', dtNote: ''
      };

      s.diagnosticTests.push(newDT);
      addedCount++;

      if (!dtDataMap[globalDate]) dtDataMap[globalDate] = [];
      dtDataMap[globalDate].push({ id: studentId, studentData: s, dtData: newDT });
    }

    if (addedCount > 0) {
      await update(ref(db, `centers/${centerId}/students/${studentId}`), { diagnosticTests: s.diagnosticTests });
    }

    renderDualCalendar();
    modal.classList.add('hidden');
    alert(t('dashboard.scheduleDT.success', { count: addedCount }));
  } catch (err) {
    console.error('Error scheduling DT:', err);
    alert(t('dashboard.scheduleDT.failed'));
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = t('dashboard.scheduleDT.saveBtn');
  }
};
}

function addDTSubjectRow() {
  const container = document.getElementById('dtSubjectsContainer');
  const row = document.createElement('div');
  row.className = 'dt-subject-row';
  row.innerHTML = `
    <div class="dt-row-group" style="flex: 1;">
      <label>${t('dashboard.scheduleDT.subjectLabel')}</label>
      <select class="dt-row-subject">
        <option value="">${t('dashboard.scheduleDT.selectSubject')}</option>
        <option value="Math">Math</option>
        <option value="Chinese (Trad)">Chinese (Trad)</option>
        <option value="Chinese (Simp)">Chinese (Simp)</option>
        <option value="English ERP">English ERP</option>
        <option value="English EFL">English EFL</option>
      </select>
    </div>
    <button type="button" class="remove-dt-row-btn" title="Remove">×</button>
  `;
  row.querySelector('.remove-dt-row-btn').onclick = () => {
    row.remove();
    if (container.children.length === 0) addDTSubjectRow(); 
  };
  container.appendChild(row);
}

document.getElementById('closeScheduleDTModalDash')?.addEventListener('click', () => document.getElementById('scheduleDTModalDash').classList.add('hidden'));
document.getElementById('scheduleDTModalDash')?.addEventListener('click', (e) => { if (e.target.id === 'scheduleDTModalDash') e.target.classList.add('hidden'); });

async function fetchStudentsForSearch() {
  try {
    const snap = await get(ref(db, `centers/${centerId}/students`));
    if (!snap.exists()) {
      allStudentsForSearch = [];
      return;
    }
    allStudentsForSearch = [];
        snap.forEach(child => {
            const val = child.val();
            allStudentsForSearch.push({
                id: child.key,
                nameCn: val.nameCn || '',
                namePinyin: val.namePinyin || '',
                nickname: val.nickname || '', 
                grade: val.grade || '',
                studentNumber: val.studentNumber || '',
                phoneMom: val.phone?.mom || '',
                phoneDad: val.phone?.dad || '',
                phoneOwn: val.phone?.own || ''
            });
        });
    allStudentsForSearch.sort((a, b) => {
      const nameA = (a.namePinyin || a.nameCn || '').toLowerCase();
      const nameB = (b.namePinyin || b.nameCn || '').toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });
  } catch (err) {
    console.error('Error fetching students for search:', err);
    allStudentsForSearch = [];
  }
}

// ============================================
// 🔍 QUICK INQUIRY MODAL LOGIC
// ============================================
const SUBJECTS_QI = ['Math', 'Chinese (Trad)', 'Chinese (Simp)', 'English ERP', 'English EFL'];
const GRADES_QI = ['K0', 'K1', 'K2', 'K3', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
let qiSubjectCount = 0;

function initQuickInquiry() {
  const fabBtn = document.getElementById('fabAddInquiry');
  if (fabBtn) {
    fabBtn.addEventListener('click', () => {
      document.getElementById('fabBtn')?.classList.remove('active');
      document.getElementById('fabMenu')?.classList.add('hidden');
      document.getElementById('fabOverlay')?.classList.add('hidden');
      openQuickInquiryModal();
    });
  }

  const modal = document.getElementById('quickInquiryModal');
  const closeBtn = document.getElementById('closeQuickInquiryModal');
  const cancelBtn = document.getElementById('qiCancelBtn');
  const form = document.getElementById('quickInquiryForm');
  const addSubjectBtn = document.getElementById('qiAddSubjectBtn');

  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  if (cancelBtn) cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  if (addSubjectBtn) addSubjectBtn.addEventListener('click', () => addQISubjectRow());
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveQuickInquiry();
    });
  }
}

function openQuickInquiryModal() {
  const modal = document.getElementById('quickInquiryModal');
  const form = document.getElementById('quickInquiryForm');
  const container = document.getElementById('qiSubjectsContainer');

  if (!modal || !form || !container) {
    console.error('Quick Inquiry modal elements not found.');
    return;
  }

  form.reset();

  container.innerHTML = '';
  qiSubjectCount = 0;

  const gradeSelect = document.getElementById('qiGrade');
  if (gradeSelect) {
    gradeSelect.innerHTML =
      `<option value="">${t('dashboard.inquiry.selectGrade')}</option>` +
      GRADES_QI.map(g => `<option value="${g}">${g}</option>`).join('');
  }

  // ============================================
  // 🕒 INJECT GLOBAL DT DATE/TIME FIELDS
  // ============================================
  if (typeof ensureQIDTGlobalFields === 'function') {
    ensureQIDTGlobalFields();
  }

  // Refresh global DT labels in case language changed
  const scheduleDTGlobalLabel = document.getElementById('qiScheduleDTGlobalLabel');
  if (scheduleDTGlobalLabel) {
    scheduleDTGlobalLabel.textContent = t('dashboard.inquiry.scheduleDTGlobal');
  }

  const dtDateLabel = document.getElementById('qiDTDateLabel');
  if (dtDateLabel) {
    dtDateLabel.textContent = t('dashboard.inquiry.dtDate');
  }

  const dtTimeslotLabel =
    document.getElementById('qiDTTimeslotLabel') ||
    document.querySelector('label[for="qiDTTimeslotGlobal"]') ||
    document.querySelector('label[for="qiDTTimeslotInput"]');

  if (dtTimeslotLabel) {
    dtTimeslotLabel.textContent = t('dashboard.inquiry.dtTimeslot');
  }

  // ============================================
  // RESET GLOBAL DT FIELDS
  // ============================================
  const qiCheckbox = document.getElementById('qiScheduleDTGlobal');
  const qiDetails = document.getElementById('qiGlobalDtDetails');
  const qiDate = document.getElementById('qiDTDateGlobal');

  // Supports either new global time ID or previous time ID
  const qiTime =
    document.getElementById('qiDTTimeslotGlobal') ||
    document.getElementById('qiDTTimeslotInput');

  if (qiCheckbox) qiCheckbox.checked = false;
  if (qiDetails) qiDetails.style.display = 'none';
  if (qiDate) qiDate.value = '';
  if (qiTime) qiTime.value = '';

  // Add first subject row after global fields are ready
  addQISubjectRow();

  modal.classList.remove('hidden');
}

function addQISubjectRow() {
  const container = document.getElementById('qiSubjectsContainer');
  if (qiSubjectCount >= 3) {
    alert(t('dashboard.inquiry.max3'));
    return;
  }
  const row = document.createElement('div');
  row.className = 'qi-subject-row';
  const usedSubjects = new Set();
  container.querySelectorAll('.qi-subject-select').forEach(sel => {
    if (sel.value) usedSubjects.add(sel.value);
  });
  const subjectOptions = SUBJECTS_QI.map(s => {
    const isUsed = usedSubjects.has(s);
    return `<option value="${s}" ${isUsed ? 'disabled' : ''}>${s}${isUsed ? t('dashboard.inquiry.added') : ''}</option>`;
  }).join('');

  row.innerHTML = `
    <div class="qi-row-group" style="flex: 1;">
      <label>${t('dashboard.scheduleDT.subjectLabel')}</label>
      <select class="qi-subject-select" required>
        <option value="">${t('dashboard.scheduleDT.selectSubject')}</option>
        ${subjectOptions}
      </select>
    </div>
    <button type="button" class="remove-qi-row-btn" title="Remove">×</button>
  `;

  const removeBtn = row.querySelector('.remove-qi-row-btn');
  removeBtn.addEventListener('click', () => {
    row.remove();
    qiSubjectCount--;
    updateQISubjectOptions();
  });

  container.appendChild(row);
  qiSubjectCount++;
}

function updateQISubjectOptions() {
  const container = document.getElementById('qiSubjectsContainer');
  const usedSubjects = new Set();
  container.querySelectorAll('.qi-subject-select').forEach(sel => {
    if (sel.value) usedSubjects.add(sel.value);
  });
  container.querySelectorAll('.qi-subject-select').forEach(sel => {
    const currentVal = sel.value;
    sel.innerHTML = `<option value="">${t('dashboard.scheduleDT.selectSubject')}</option>` + 
      SUBJECTS_QI.map(s => {
        const isUsed = usedSubjects.has(s) && s !== currentVal;
        return `<option value="${s}" ${s === currentVal ? 'selected' : ''} ${isUsed ? 'disabled' : ''}>${s}${isUsed ? t('dashboard.inquiry.added') : ''}</option>`;
      }).join('');
  });
}

async function saveQuickInquiry() {
  const nameCn = document.getElementById('qiNameCn').value.trim();
  const namePinyin = document.getElementById('qiNamePinyin').value.trim();
  const dob = document.getElementById('qiDOB').value;
  const grade = document.getElementById('qiGrade').value;
  const school = document.getElementById('qiSchool').value.trim();
  const gender = document.getElementById('qiGender').value;
  const phoneMom = document.getElementById('qiPhoneMom').value.trim();
  const phoneDad = document.getElementById('qiPhoneDad').value.trim();
  const phoneOwn = document.getElementById('qiPhoneOwn').value.trim();

  if (!nameCn) return alert(t('dashboard.inquiry.nameCnRequired'));
  if (!dob) return alert(t('dashboard.inquiry.dobRequired'));
  if (!grade) return alert(t('dashboard.inquiry.gradeRequired'));
  if (!school) return alert(t('dashboard.inquiry.schoolRequired'));
  if (!phoneMom && !phoneDad && !phoneOwn) return alert(t('dashboard.inquiry.phoneRequired'));

  const container = document.getElementById('qiSubjectsContainer');
  const rows = container.querySelectorAll('.qi-subject-row');

  if (rows.length === 0) {
    return alert(t('dashboard.inquiry.addOneSubject'));
  }

  // ============================================
  // 🕒 GLOBAL DT DATE & TIMESLOT
  // ============================================
  const scheduleDTGlobal = document.getElementById('qiScheduleDTGlobal')?.checked || false;

  const dtDateGlobal =
    document.getElementById('qiDTDateGlobal')?.value || '';

  // Supports either the new global timeslot ID or your previous timeslot ID
  const dtTimeslotGlobal =
    document.getElementById('qiDTTimeslotGlobal')?.value ||
    document.getElementById('qiDTTimeslotInput')?.value ||
    '';

  if (scheduleDTGlobal) {
    if (!dtDateGlobal) {
      return alert(
        t('dashboard.inquiry.selectDTDateGlobal') ||
        '⚠️ Please select a DT date.'
      );
    }

    if (!dtTimeslotGlobal) {
      return alert(
        t('dashboard.inquiry.selectDTTimeslot') ||
        '⚠️ Please select a DT timeslot.'
      );
    }

    // Warn if DT date is a holiday/closed day, but allow saving
    if (!confirmDTDateWarnings([dtDateGlobal])) {
      return;
    }
  }

  const subjects = [];
  const diagnosticTests = [];
  const todayStr = new Date().toISOString().split('T')[0];
  const seenSubjects = new Set();

  for (const row of rows) {
    const subject = row.querySelector('.qi-subject-select')?.value || '';

    if (!subject) {
      return alert(t('dashboard.inquiry.selectSubjectAll'));
    }

    // Extra safety: prevent duplicate subject rows
    if (seenSubjects.has(subject)) {
      return alert(
        t('dashboard.inquiry.duplicateSubject') ||
        `⚠️ ${subject} has already been selected.`
      );
    }

    seenSubjects.add(subject);

    subjects.push({
      name: subject,
      startLevel: '',
      startWS: 0,
      inquiryDate: todayStr,
      currentLevel: '',
      enrolDate: '',
      status: 'inquiry',
      timeslots: [],
      progress: [],
      pencilSkill: null,
      pauseFromMonth: '',
      pauseFromYear: '',
      pauseToMonth: '',
      pauseToYear: '',
      pauseReason: '',
      dropMonth: '',
      dropYear: '',
      dropReason: '',
      pendingRequest: null,
      worksheetType: 'Paper'
    });

    // If global DT is checked, create one DT per selected subject
    // using the same global date and timeslot
    if (scheduleDTGlobal) {
      diagnosticTests.push({
        subject: subject,
        date: dtDateGlobal,
        DTtimeslot: dtTimeslotGlobal,
        test: '',
        score: '',
        time: '',
        suggestedStart: '',
        actualStart: '',
        dtNote: ''
      });
    }
  }

  const studentData = {
    gender: gender,
    studentNumber: '',
    nickname: '',
    namePinyin: namePinyin,
    nameCn: nameCn,
    grade: grade,
    school: school,
    address: '',
    nationality: '',
    email: '',
    birthday: dob,
    parentOrientation: 'No',
    poDate: '',
    poReason: 'Pending Inquiry',
    phone: {
      mom: phoneMom,
      dad: phoneDad,
      own: phoneOwn
    },
    qrCode: '',
    kcNo: '',
    subjects: subjects,
    diagnosticTests: diagnosticTests,
    achievementTests: [],
    assignedTeachers: {},
    updatedAt: new Date().toISOString()
  };

  const saveBtn = document.getElementById('qiSaveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = t('common.saving');

  try {
    const newStudentRef = push(ref(db, `centers/${centerId}/students`), studentData);
    const newStudentId = newStudentRef.key;

    diagnosticTests.forEach(dt => {
      if (!dtDataMap[dt.date]) dtDataMap[dt.date] = [];

      dtDataMap[dt.date].push({
        id: newStudentId,
        studentData: studentData,
        dtData: dt
      });
    });

    renderDualCalendar();

    document.getElementById('quickInquiryModal')?.classList.add('hidden');

    alert(t('dashboard.inquiry.saved'));
  } catch (err) {
    console.error('Error saving quick inquiry:', err);
    alert(t('dashboard.inquiry.failed'));
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = t('dashboard.inquiry.saveBtn');
  }
}

// ============================================
// 🕒 DASHBOARD ATTENDANCE
// ============================================

function dashAttendanceTodayISO() {
  return new Date().toISOString().split('T')[0];
}

function dashAttendanceEscapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match]));
}

function dashAttendanceNormalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dashAttendanceToSearchPart(value) {
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

function getDashAttendancePinyin(student = {}) {
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
    const text = dashAttendanceToSearchPart(candidate);
    if (text) return text;
  }

  return '';
}

function getDashAttendanceSearchText(student = {}) {
  const parts = [
    dashAttendanceToSearchPart(student.nameCn),
    dashAttendanceToSearchPart(student.name),
    dashAttendanceToSearchPart(student.chineseName),
    dashAttendanceToSearchPart(student.fullName),
    dashAttendanceToSearchPart(student.nameEn),
    dashAttendanceToSearchPart(student.englishName),
    dashAttendanceToSearchPart(student.engName),
    getDashAttendancePinyin(student),
    dashAttendanceToSearchPart(student.nickname),
    dashAttendanceToSearchPart(student.studentNumber),
    dashAttendanceToSearchPart(student.school),
    dashAttendanceToSearchPart(student.grade),
    dashAttendanceToSearchPart(student.phone?.mom),
    dashAttendanceToSearchPart(student.phone?.dad),
    dashAttendanceToSearchPart(student.phone?.own)
  ].filter(Boolean);

  return dashAttendanceNormalizeText(parts.join(' '));
}

function normalizeDashAttendanceSubjects(student = {}) {
  const raw = student.subjects;

  if (Array.isArray(raw)) {
    return raw;
  }

  if (raw && typeof raw === 'object') {
    return Object.values(raw);
  }

  return [];
}

function getDashAttendanceCurrentSubjects(student = {}) {
  return normalizeDashAttendanceSubjects(student).filter((subject) => {
    return subject && subject.status === 'current' && subject.name;
  });
}

function hasCurrentDashAttendanceSubjects(student = {}) {
  return getDashAttendanceCurrentSubjects(student).length > 0;
}

function rebuildDashAttendanceIndexes() {
  attendanceStudentById = new Map();
  attendanceStudentByNumber = new Map();
  attendanceStudentByQr = new Map();

  allStudentsForAttendance.forEach((student) => {
    if (student.id) {
      attendanceStudentById.set(String(student.id), student);
    }

    if (
      student.studentNumber !== undefined &&
      student.studentNumber !== null &&
      String(student.studentNumber).trim() !== ''
    ) {
      attendanceStudentByNumber.set(String(student.studentNumber), student);
    }

    if (
      student.qrCode !== undefined &&
      student.qrCode !== null &&
      String(student.qrCode).trim() !== ''
    ) {
      attendanceStudentByQr.set(String(student.qrCode), student);
    }
  });
}

async function loadDashboardAttendanceStudents(force = false) {
  if (!centerId) return [];

  if (attendanceStudentsLoaded && !force) {
    return allStudentsForAttendance;
  }

  const snap = await get(ref(db, `centers/${centerId}/students`));
  allStudentsForAttendance = [];

  if (snap.exists()) {
    snap.forEach((child) => {
      allStudentsForAttendance.push({
        ...child.val(),
        id: child.key
      });
    });
  }

  attendanceStudentsLoaded = true;
  rebuildDashAttendanceIndexes();

  return allStudentsForAttendance;
}

async function loadDashboardAttendanceRecords(force = false) {
  if (!centerId) return [];

  if (attendanceRecordsLoaded && !force) {
    return attendanceRecordsCache;
  }

  const snap = await get(ref(db, `centers/${centerId}/attendance`));
  attendanceRecordsCache = [];

  if (snap.exists()) {
    snap.forEach((child) => {
      attendanceRecordsCache.push({
        ...child.val(),
        id: child.key
      });
    });
  }

  attendanceRecordsLoaded = true;

  return attendanceRecordsCache;
}

function getDashAttendanceExistingTodayFromCache(student = {}) {
  const now = new Date();
  const studentId = String(student.id || '');
  const studentNumber = String(student.studentNumber || '');
  const studentName = dashAttendanceNormalizeText(student.nameCn || student.name || '');

  return attendanceRecordsCache.filter((record) => {
    // ✅ Robust local-date check using checkInTime
    let isToday = false;
    if (record.checkInTime) {
      const d = new Date(record.checkInTime);
      if (!isNaN(d.getTime())) {
        isToday = (d.getFullYear() === now.getFullYear() &&
                   d.getMonth() === now.getMonth() &&
                   d.getDate() === now.getDate());
      }
    }
    if (!isToday) {
      // Fallback to date string if checkInTime is missing
      const todayUtc = dashAttendanceTodayISO();
      const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (record.date !== todayUtc && record.date !== todayLocal) return false;
    }

    const recordStudentId = String(record.studentId || '');
    const recordStudentNumber = String(record.studentNumber || '');
    const recordName = dashAttendanceNormalizeText(record.nameCn || '');

    if (studentId && recordStudentId && recordStudentId === studentId) return true;
    if (studentNumber && recordStudentNumber && recordStudentNumber === studentNumber) return true;
    if (studentName && recordName && recordName === studentName) return true;
    return false;
  });
}

function formatDashAttendanceTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '-';
  }
}

function formatDashAttendanceRecordLabel(record = {}) {
  const subject = record.subject || 'Subject';
  const time = formatDashAttendanceTime(record.checkInTime);
  const status = record.status || '-';

  return `${subject} • ${time} • ${status}`;
}

function calculateDashAttendanceStatus(timeStr, now) {
  if (!timeStr || timeStr === 'N/A' || timeStr === 'No schedule set') {
    return 'Not Today';
  }
  const parts = timeStr.split(':');
  if (parts.length < 2) return 'Not Today';
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return 'Not Today';
  const scheduled = new Date(now);
  scheduled.setHours(h, m, 0, 0);
  const diff = (now - scheduled) / 60000;
  if (diff < -15) return 'Early';
  if (diff > 15) return 'Late';
  return 'On Time';
}

// ============================================
// ⏳ EXPECTED TODAY — NOT ARRIVED (Manual modal panel)
// Timetable-grade logic ported from timetable.js
// ============================================
function expectedT(key, fallback, vars) {
  try {
    const out = t(key, vars);
    return (out && out !== key) ? out : fallback;
  } catch { return fallback; }
}

function getTodayDayName(date = new Date()) {
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return dayNames[date.getDay()];
}

// ---- Ported from timetable.js: robust day normalization ----
const EXPECTED_DAY_NUMBER_TO_NAME = {
  0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
  4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday'
};
const EXPECTED_DAY_ALIASES = {
  monday: 'Monday', mon: 'Monday',
  tuesday: 'Tuesday', tue: 'Tuesday', tues: 'Tuesday',
  wednesday: 'Wednesday', wed: 'Wednesday', weds: 'Wednesday',
  thursday: 'Thursday', thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday',
  friday: 'Friday', fri: 'Friday',
  saturday: 'Saturday', sat: 'Saturday',
  sunday: 'Sunday', sun: 'Sunday',
  '周一': 'Monday', '星期一': 'Monday', '礼拜一': 'Monday',
  '周二': 'Tuesday', '星期二': 'Tuesday', '礼拜二': 'Tuesday',
  '周三': 'Wednesday', '星期三': 'Wednesday', '礼拜三': 'Wednesday',
  '周四': 'Thursday', '星期四': 'Thursday', '礼拜四': 'Thursday',
  '周五': 'Friday', '星期五': 'Friday', '礼拜五': 'Friday',
  '周六': 'Saturday', '星期六': 'Saturday', '礼拜六': 'Saturday',
  '周日': 'Sunday', '星期日': 'Sunday', '周天': 'Sunday', '星期天': 'Sunday', '礼拜天': 'Sunday', '礼拜日': 'Sunday'
};
function expectedNormalizeWeekday(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return EXPECTED_DAY_NUMBER_TO_NAME[raw] || null;
  const original = String(raw).trim().toLowerCase();
  if (EXPECTED_DAY_ALIASES[original]) return EXPECTED_DAY_ALIASES[original];
  const cleaned = original.replace(/[^\p{L}\p{N}]+/gu, '');
  if (!cleaned) return null;
  if (/^\d+$/.test(cleaned)) return EXPECTED_DAY_NUMBER_TO_NAME[Number(cleaned)] || null;
  return EXPECTED_DAY_ALIASES[cleaned] || EXPECTED_DAY_ALIASES[cleaned.slice(0, 3)] || null;
}

// ---- Ported from timetable.js: robust time normalization ----
function expectedNormalizeTime(raw) {
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

// ---- Ported from timetable.js: isSubjectActiveOnDate ----
function expectedIsSubjectActiveOnDate(sub, targetDate) {
  if (!sub || !targetDate) return false;
  const tM = targetDate.getMonth() + 1;
  const tY = targetDate.getFullYear();

  // 1. Resume request brings the student back
  if (sub.resumeRequest && sub.resumeRequest.returnMonth && sub.resumeRequest.returnYear) {
    const rM = parseInt(sub.resumeRequest.returnMonth);
    const rY = parseInt(sub.resumeRequest.returnYear);
    if (rY < tY || (rY === tY && rM <= tM)) return true;
  }

  // 2. Current status: drop / pause / inquiry
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

  // 3. Pending request
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

  if (sub.status === 'current') return true;
  return false;
}

// Multi-slot aware: Late only once the LAST slot of the day has passed
function expectedSlotStatus(sortedTimes, now) {
  for (const tm of sortedTimes) {
    if (calculateDashAttendanceStatus(tm, now) === 'On Time') return 'On Time';
  }
  const last = sortedTimes[sortedTimes.length - 1];
  if (calculateDashAttendanceStatus(last, now) === 'Early') return 'Early';
  return 'Late';
}

function computeExpectedNotArrived() {
  const groups = new Map();
  const now = new Date();
  const todayName = getTodayDayName(now);
  const todayUtc = dashAttendanceTodayISO();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const validDates = new Set([todayUtc, todayLocal]);

  const isRecordToday = (r) => {
    if (r.checkInTime) {
      const d = new Date(r.checkInTime);
      if (!isNaN(d.getTime())) {
        return d.getFullYear() === now.getFullYear() &&
               d.getMonth() === now.getMonth() &&
               d.getDate() === now.getDate();
      }
    }
    return validDates.has(r.date);
  };

  // Arrived index: id / studentNumber / name → Set(normalized subjects)
  const arrivedSubjects = new Map();
  const markArrived = (key, subj) => {
    if (!key) return;
    if (!arrivedSubjects.has(key)) arrivedSubjects.set(key, new Set());
    arrivedSubjects.get(key).add(subj);
  };

  attendanceRecordsCache.forEach(r => {
    if (!isRecordToday(r)) return;
    const subj = dashAttendanceNormalizeText(r.subject);
    if (!subj) return;
    if (r.studentId) markArrived(`id:${r.studentId}`, subj);
    if (r.studentNumber !== undefined && r.studentNumber !== null && String(r.studentNumber).trim() !== '') {
      markArrived(`num:${String(r.studentNumber)}`, subj);
    }
    // ✅ Index by nameCn if available
    const recNameCn = dashAttendanceNormalizeText(r.nameCn || '');
    if (recNameCn && recNameCn !== '-') markArrived(`name:${recNameCn}`, subj);

    // ✅ Also index by nameEn/name if different
    const recNameEn = dashAttendanceNormalizeText(r.nameEn || r.name || '');
    if (recNameEn && recNameEn !== '-' && recNameEn !== recNameCn) {
      markArrived(`name:${recNameEn}`, subj);
    }
  });

  const hasArrived = (student, subjKey) => {
    const keys = [];
    if (student.id) keys.push(`id:${student.id}`);
    if (student.studentNumber !== undefined && student.studentNumber !== null && String(student.studentNumber).trim() !== '') {
      keys.push(`num:${String(student.studentNumber)}`);
    }
    // ✅ Check both nameCn and name
    const nameCn = dashAttendanceNormalizeText(student.nameCn || '');
    if (nameCn && nameCn !== '-') keys.push(`name:${nameCn}`);
    const nameEn = dashAttendanceNormalizeText(student.name || '');
    if (nameEn && nameEn !== '-' && nameEn !== nameCn) keys.push(`name:${nameEn}`);
    
    return keys.some(k => arrivedSubjects.get(k)?.has(subjKey));
  };

  const roster = (allStudentsGlobalLoaded && allStudentsGlobal.length)
    ? allStudentsGlobal
    : allStudentsForAttendance;

  roster.forEach(student => {
    normalizeDashAttendanceSubjects(student).forEach(sub => {
      if (!sub || !sub.name || !sub.timeslots) return;
      if (!expectedIsSubjectActiveOnDate(sub, now)) return;

      const tsList = Array.isArray(sub.timeslots) ? sub.timeslots : Object.values(sub.timeslots);
      const todaysSlots = [];
      tsList.forEach(ts => {
        if (!ts) return;
        const tsCenter = ts.center || student.homeCenterId || centerId;
        if (tsCenter !== centerId) return;
        if (expectedNormalizeWeekday(ts.day) !== todayName) return;
        const time = expectedNormalizeTime(ts.time);
        if (!time) return;
        todaysSlots.push(time);
      });
      if (!todaysSlots.length) return;

      // ✅ Already checked in for this subject today → remove from list
      if (hasArrived(student, dashAttendanceNormalizeText(sub.name))) return;

      const sorted = todaysSlots.sort();
      if (!groups.has(sub.name)) groups.set(sub.name, []);
      groups.get(sub.name).push({
        student,
        subjectName: sub.name,
        time: sorted[0],
        allTimes: sorted,
        status: expectedSlotStatus(sorted, now)
      });
    });
  });

  groups.forEach(list => list.sort((a, b) => {
    const aLate = a.status === 'Late', bLate = b.status === 'Late';
    if (aLate !== bLate) return aLate ? -1 : 1;
    return (a.time || '99:99').localeCompare(b.time || '99:99');
  }));

  return groups;
}

function buildExpectedStudentRow({ student, time, allTimes, status }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'expected-student-row';

  const visiting = student.homeCenterId && student.homeCenterId !== centerId;
  if (visiting) btn.classList.add('visiting');

  const pinyin = getDashAttendancePinyin(student);
  const displayName = student.nameCn || student.name || pinyin || student.nickname || 'Unknown';
  const meta = [pinyin, student.grade ? `Grade ${student.grade}` : '', student.studentNumber ? `No: ${student.studentNumber}` : '']
    .filter(Boolean).join(' • ');

  let chipClass = 'chip-scheduled', chipText = expectedT('dashboard.attendance.scheduled', 'Scheduled');
  if (status === 'Late') { chipClass = 'chip-late'; chipText = expectedT('dashboard.attendance.late', 'Late'); }
  else if (status === 'On Time') { chipClass = 'chip-due'; chipText = expectedT('dashboard.attendance.dueNow', 'Due now'); }

  btn.innerHTML = `
    <span class="expected-student-main">
      <span class="expected-student-name">${dashAttendanceEscapeHtml(displayName)}</span>
      ${meta ? `<span class="expected-student-sub">${dashAttendanceEscapeHtml(meta)}</span>` : ''}
    </span>
    ${visiting ? `<span class="expected-student-center">🏫 ${dashAttendanceEscapeHtml(student.homeCenterName || '')}</span>` : ''}
    <span class="expected-student-time" title="${dashAttendanceEscapeHtml(allTimes.join(', '))}">🕒 ${dashAttendanceEscapeHtml(time || '--:--')}</span>
    <span class="expected-status-chip ${chipClass}">${chipText}</span>
  `;
  btn.addEventListener('click', () => selectDashboardAttendanceStudent(student, 'manual'));
  return btn;
}

function renderExpectedNotArrived() {
const section = document.getElementById('dashAttendanceExpectedSection');
const container = document.getElementById('expectedSubjectsContainer');
const totalBadge = document.getElementById('expectedTotalBadge');
if (!section || !container) return;

// ✅ 'now' MUST be declared before the debug line uses it
const now = new Date();
console.info('[Expected] cache:', attendanceRecordsCache.length,
  '| today:', attendanceRecordsCache.filter(r => {
      if (r.checkInTime) {
        const d = new Date(r.checkInTime);
        return d.toDateString() === now.toDateString();
      }
      return r.date === dashAttendanceTodayISO();
  }).length);

if (!attendanceRecordsLoaded) { section.classList.add('hidden'); return; }

const groups = computeExpectedNotArrived();
let total = 0;
groups.forEach(list => total += list.length);
if (totalBadge) totalBadge.textContent = total;

container.innerHTML = '';
section.classList.remove('hidden');

if (total === 0) {
  container.innerHTML = `<div class="expected-all-done">✅ ${expectedT('dashboard.attendance.allArrived', 'All expected students have arrived!')}</div>`;
  return;
}

groups.forEach((list, subjectName) => {
  const group = document.createElement('div');
  group.className = 'expected-subject-group';
  group.innerHTML = `
    <div class="expected-subject-header">
      <span class="expected-subject-name">${dashAttendanceEscapeHtml(subjectName)}</span>
      <span class="expected-subject-count">${list.length}</span>
    </div>`;
  const listEl = document.createElement('div');
  listEl.className = 'expected-student-list';
  list.forEach(entry => listEl.appendChild(buildExpectedStudentRow(entry)));
  group.appendChild(listEl);
  container.appendChild(group);
});
}

// ✅ FIX: Use child listeners instead of onValue to prevent the "cache drops to 1" bug
function startExpectedRealtimeSync() {
  if (!centerId || expectedRealtimeRef) return;
  expectedRealtimeRef = ref(db, `centers/${centerId}/attendance`);
  
  // 1. Listen for NEW attendance records (Real-time check-ins)
  onChildAdded(expectedRealtimeRef, (snap) => {
    const newRecord = { ...snap.val(), id: snap.key };
    // Avoid duplicates (in case it was already added locally by push())
    if (!attendanceRecordsCache.some(r => r.id === snap.key)) {
      attendanceRecordsCache.push(newRecord);
      if (!isDashModalHidden('dashAttendanceManualModal')) {
        renderExpectedNotArrived();
      }
    }
  }, (err) => console.error('Expected-list realtime sync (added) error:', err));
  
  // 2. Listen for DELETED records (if someone deletes a record from the attendance page)
  onChildRemoved(expectedRealtimeRef, (snap) => {
    const removedId = snap.key;
    const initialLength = attendanceRecordsCache.length;
    attendanceRecordsCache = attendanceRecordsCache.filter(r => r.id !== removedId);
    if (attendanceRecordsCache.length !== initialLength && !isDashModalHidden('dashAttendanceManualModal')) {
      renderExpectedNotArrived();
    }
  }, (err) => console.error('Expected-list realtime sync (removed) error:', err));
}

function stopExpectedRealtimeSync() {
  if (!expectedRealtimeRef) return;
  off(expectedRealtimeRef); // Removes ALL listeners (onChildAdded, onChildRemoved, etc.)
  expectedRealtimeRef = null;
}

// ✅ Short, lightweight re-sync after a check-in (not a long loader)
function refreshExpectedSoon() {
  [500, 1200].forEach(ms => {
    setTimeout(async () => {
      try {
        await loadDashboardAttendanceRecords(true);
        if (!isDashModalHidden('dashAttendanceManualModal')) renderExpectedNotArrived();
      } catch (e) { console.warn('refreshExpectedSoon:', e); }
    }, ms);
  });
}

// Keeps Late / Due-now chips accurate while the modal stays open
function startExpectedTicker() {
  if (expectedTickerTimer) return;
  expectedTickerTimer = setInterval(() => {
    if (!isDashModalHidden('dashAttendanceManualModal')) renderExpectedNotArrived();
  }, 5000);
}
function stopExpectedTicker() {
  if (expectedTickerTimer) { clearInterval(expectedTickerTimer); expectedTickerTimer = null; }
}
function stopExpectedSync() { stopExpectedRealtimeSync(); stopExpectedTicker(); }

function closeAttendanceConfirmModal() {
  hideDashModal('dashAttendanceConfirmModal');
  attendanceSelectedStudent = null;
  if (attendanceLastMethod === 'manual') openDashboardAttendanceManualModal();
}

function getDashAttendanceStatusColor(status) {
  return {
    'On Time': '#10b981',
    'Early': '#f59e0b',
    'Late': '#ef4444',
    'Not Today': '#6b7280'
  }[status] || '#666';
}

function getDashAttendanceDateWarnings(dateStr) {
  const warnings = [];

  if (!dateStr) return warnings;

  const event = calendarEventsMap[dateStr];
  const nameSuffix = event?.name ? `: ${event.name}` : '';

  if (event?.type === 'public') {
    warnings.push(t('dashboard.dtWarning.publicHoliday', {
      date: dateStr,
      name: nameSuffix
    }));
  }

  if (event?.type === 'center') {
    warnings.push(t('dashboard.dtWarning.centerHoliday', {
      date: dateStr,
      name: nameSuffix
    }));
  }

  const otherEvents = getOtherEventsFromCalendarEvent(event);
  if (otherEvents.length > 0) {
    warnings.push(
      `${t('dashboard.holidayOther')}: ${otherEvents.map(o => o.name).join(', ')}`
    );
  }

  const dateObj = new Date(`${dateStr}T00:00:00`);
  if (!isNaN(dateObj.getTime())) {
    const closedDays = getClosedDaysForCenter(centerName);
    if (closedDays.includes(dateObj.getDay())) {
      warnings.push(t('dashboard.dtWarning.closedDay', { date: dateStr }));
    }
  }

  return warnings;
}

// ===============================
// Cross-Center: Load ALL students from ALL centers
// ===============================
async function loadAllStudentsGlobal(force = false) {
    if (allStudentsGlobalLoaded && !force) return allStudentsGlobal;

    try {
        const centersSnap = await get(ref(db, 'centers'));
        allStudentsGlobal = [];
        allStudentsByIdGlobal = new Map();
        allStudentsByNumberGlobal = new Map();
        centerNamesCache = new Map();

        if (centersSnap.exists()) {
            centersSnap.forEach((centerSnap) => {
                const cId = centerSnap.key;
                const centerData = centerSnap.val() || {};
                const centerName = centerData.name || centerData.centerName || cId;
                centerNamesCache.set(cId, centerName);

                const students = centerData.students || {};
                Object.keys(students).forEach((studentId) => {
                    const student = {
                        ...students[studentId],
                        id: studentId,
                        homeCenterId: cId,
                        homeCenterName: centerName
                    };
                    allStudentsGlobal.push(student);
                    allStudentsByIdGlobal.set(String(studentId), student);

                    if (
                        student.studentNumber !== undefined &&
                        student.studentNumber !== null &&
                        String(student.studentNumber).trim() !== ''
                    ) {
                        allStudentsByNumberGlobal.set(String(student.studentNumber), student);
                    }
                });
            });
        }
        allStudentsGlobalLoaded = true;
    } catch (err) {
        console.error('❌ Failed to load all students globally:', err);
    }
    return allStudentsGlobal;
}

// Helper: is this student visiting from another center?
function isVisitingStudent(student) {
    if (!student || !student.homeCenterId) return false;
    return student.homeCenterId !== centerId;
}

async function confirmDashAttendanceDateWarnings() {
  const today = dashAttendanceTodayISO();
  const warnings = getDashAttendanceDateWarnings(today);

  if (warnings.length === 0) return true;

  return confirm(
    `${t('dashboard.attendance.holidayContinue')}\n\n${warnings.join('\n')}`
  );
}

function showDashboardToast(message, isError = false) {
  const toast = document.getElementById('dashboardToast');

  if (!toast) {
    alert(message);
    return;
  }

  toast.textContent = message;
  toast.className = `dashboard-toast${isError ? ' error' : ''}`;

  clearTimeout(toast._timer);

  toast._timer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}

function showDashModal(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

function hideDashModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

function isDashModalHidden(id) {
  const el = document.getElementById(id);
  return !el || el.classList.contains('hidden');
}

function setupDashboardAttendanceModals() {
  // Choice modal
  document.getElementById('closeDashAttendanceChoiceModal')?.addEventListener('click', () => {
    hideDashModal('dashAttendanceChoiceModal');
  });

  document.getElementById('dashAttendanceChoiceModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'dashAttendanceChoiceModal') {
      hideDashModal('dashAttendanceChoiceModal');
    }
  });

  // Manual modal — stop live sync when it closes
  document.getElementById('closeDashAttendanceManualModal')?.addEventListener('click', () => {
    hideDashModal('dashAttendanceManualModal');
    stopExpectedSync();
  });
  document.getElementById('dashAttendanceManualModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'dashAttendanceManualModal') {
      hideDashModal('dashAttendanceManualModal');
      stopExpectedSync();
    }
  });

  // Confirm modal — cancelling returns to the manual modal (and its live list)
  document.getElementById('closeDashAttendanceConfirmModal')?.addEventListener('click', closeAttendanceConfirmModal);
  document.getElementById('dashAttendanceConfirmModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'dashAttendanceConfirmModal') closeAttendanceConfirmModal();
  });
  document.getElementById('dashAttendanceCancelBtn')?.addEventListener('click', closeAttendanceConfirmModal);
  document.getElementById('dashAttendanceConfirmBtn')?.addEventListener('click', recordDashboardAttendance);

  // Scan modal
  document.getElementById('closeDashAttendanceScanModal')?.addEventListener('click', async () => {
    await stopDashboardAttendanceScanner();
  });

  document.getElementById('dashAttendanceScanModal')?.addEventListener('click', async (e) => {
    if (e.target.id === 'dashAttendanceScanModal') {
      await stopDashboardAttendanceScanner();
    }
  });

  // Attendance method options
  document.getElementById('dashAttendanceManualOption')?.addEventListener('click', () => {
    hideDashModal('dashAttendanceChoiceModal');
    openDashboardAttendanceManualModal();
  });

  document.getElementById('dashAttendanceScanOption')?.addEventListener('click', async () => {
    hideDashModal('dashAttendanceChoiceModal');
    await startDashboardAttendanceScanner();
  });

  // Manual search
  const manualSearch = document.getElementById('dashAttendanceManualSearch');

  if (manualSearch) {
    manualSearch.addEventListener('input', handleDashboardAttendanceManualSearch);
    manualSearch.addEventListener('focus', handleDashboardAttendanceManualSearch);
  }

  // Close manual results when clicking outside
  document.addEventListener('click', (event) => {
    const results = document.getElementById('dashAttendanceManualResults');
    const manualModal = document.getElementById('dashAttendanceManualModal');

    if (
      results &&
      manualModal &&
      !manualModal.classList.contains('hidden') &&
      !event.target.closest('#dashAttendanceManualSearch') &&
      !event.target.closest('#dashAttendanceManualResults')
    ) {
      results.classList.add('hidden');
    }
  });

  // Escape handling
  document.addEventListener('keydown', async (e) => {
    if (e.key !== 'Escape') return;
    // Warning modal handles its own Escape inside the Promise
    if (!isDashModalHidden('dashAttendanceWarningModal')) return;
    if (!isDashModalHidden('dashAttendanceScanModal')) {
      await stopDashboardAttendanceScanner();
      return;
    }
    if (!isDashModalHidden('dashAttendanceConfirmModal')) {
      closeAttendanceConfirmModal();
      return;
    }
    hideDashModal('dashAttendanceChoiceModal');
    hideDashModal('dashAttendanceManualModal');
    stopExpectedSync();
  });
}

function showDashAttendanceWarning({
  title = '⚠️ Warning',
  message = '',
  items = [],
  proceedText = 'Proceed Anyway',
  cancelText = 'Cancel'
}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('dashAttendanceWarningModal');
    const titleEl = document.getElementById('dashAttendanceWarningTitle');
    const textEl = document.getElementById('dashAttendanceWarningText');
    const listEl = document.getElementById('dashAttendanceWarningList');
    const proceedBtn = document.getElementById('dashAttendanceWarningProceedBtn');
    const cancelBtn = document.getElementById('dashAttendanceWarningCancelBtn');
    const closeBtn = document.getElementById('closeDashAttendanceWarningModal');

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
    cancelBtn.textContent = cancelText;

    const cleanup = () => {
      hideDashModal('dashAttendanceWarningModal');

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

    showDashModal('dashAttendanceWarningModal');
  });
}

async function openDashboardAttendanceEntry() {
    if (!centerId) {
        alert('No center selected.');
        return;
    }
    const canContinue = await confirmDashAttendanceDateWarnings();
    if (!canContinue) return;
    
    // Preload in background (Added loadAllStudentsGlobal)
    loadDashboardAttendanceStudents().catch(console.error);
    loadAllStudentsGlobal().catch(console.error);
    loadDashboardAttendanceRecords().catch(console.error);
    
    showDashModal('dashAttendanceChoiceModal');
}

async function openDashboardAttendanceManualModal() {
  const input = document.getElementById('dashAttendanceManualSearch');
  const results = document.getElementById('dashAttendanceManualResults');
  
  if (input) {
    input.value = '';
    input.placeholder = t('dashboard.attendance.manualPlaceholder');
  }
  if (results) {
    results.innerHTML = '';
    results.classList.add('hidden');
  }
  
  showDashModal('dashAttendanceManualModal');
  
  setTimeout(() => {
    input?.focus();
  }, 100);
  
  try {
    // ✅ Ensure we force reload attendance records
    await Promise.all([
      loadDashboardAttendanceStudents(),
      loadAllStudentsGlobal(),
      loadDashboardAttendanceRecords(true)  // Force reload
    ]);
  } catch (err) { 
    console.error('Expected list preload failed:', err); 
  }
  
  // ✅ Render the expected list after records are loaded
  renderExpectedNotArrived();
  
  startExpectedRealtimeSync();
  startExpectedTicker();
}

async function handleDashboardAttendanceManualSearch() {
    const input = document.getElementById('dashAttendanceManualSearch');
    const results = document.getElementById('dashAttendanceManualResults');
    if (!input || !results) return;
    
    const query = dashAttendanceNormalizeText(input.value);
    if (!query) {
        results.innerHTML = '';
        results.classList.add('hidden');
        return;
    }
    
    try {
        // Load both current and global students
        await Promise.all([loadDashboardAttendanceStudents(), loadAllStudentsGlobal()]);
        
        const matches = allStudentsGlobal
            .filter((student) => {
                return hasCurrentDashAttendanceSubjects(student) &&
                       getDashAttendanceSearchText(student).includes(query);
            })
            .slice(0, 20);
            
        renderDashboardAttendanceManualResults(matches);
    } catch (err) {
        console.error('Dashboard attendance manual search failed:', err);
        renderDashboardAttendanceManualResults([]);
    }
}

function renderDashboardAttendanceManualResults(matches) {
    const results = document.getElementById('dashAttendanceManualResults');
    if (!results) return;
    results.innerHTML = '';
    
    if (!matches.length) {
        results.innerHTML = `<div class="dash-attendance-result-empty"> No matching current students found. </div>`;
        results.classList.remove('hidden');
        return;
    }
    
    matches.forEach((student) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dash-attendance-result-item';
        
        const visiting = isVisitingStudent(student);
        if (visiting) item.classList.add('visiting-student');

        const pinyin = getDashAttendancePinyin(student);
        const displayName = student.nameCn || student.name || pinyin || student.nickname || 'Unknown Student';
        
        const metaParts = [];
        if (pinyin) metaParts.push(pinyin);
        if (student.nickname) metaParts.push(`Nickname: ${student.nickname}`);
        if (student.studentNumber) metaParts.push(`No: ${student.studentNumber}`);
        if (student.grade) metaParts.push(`Grade: ${student.grade}`);
        if (student.school) metaParts.push(student.school);
        
        // 🏫 Center indicator for visiting students
        if (visiting) {
            metaParts.push(`🏫 ${student.homeCenterName}`);
        }

        item.innerHTML = `
          <span class="dash-attendance-result-name">
            ${dashAttendanceEscapeHtml(displayName)}
          </span>
          <span class="dash-attendance-result-meta">
            ${dashAttendanceEscapeHtml(metaParts.join(' • '))}
          </span>
        `;
        item.addEventListener('click', async () => {
            await selectDashboardAttendanceStudent(student, 'manual');
        });
        results.appendChild(item);
    });
    results.classList.remove('hidden');
}

async function selectDashboardAttendanceStudent(student, method = 'manual') {
  attendanceLastMethod = method;

  hideDashModal('dashAttendanceChoiceModal');
  hideDashModal('dashAttendanceManualModal');
  stopExpectedSync();

  if (!student || !student.id) {
    showDashboardToast(t('dashboard.attendance.studentNotFound'), true);

    if (method === 'qr') {
      dashAttendanceRestartTimer = setTimeout(async () => {
        await startDashboardAttendanceScanner();
      }, 1200);
    }

    return;
  }

  if (!hasCurrentDashAttendanceSubjects(student)) {
    showDashboardToast(t('dashboard.attendance.noActiveSubjects'), true);

    if (method === 'qr') {
      dashAttendanceRestartTimer = setTimeout(async () => {
        await startDashboardAttendanceScanner();
      }, 1600);
    }

    return;
  }

  try {
      await loadDashboardAttendanceRecords(true);   // ✅ always fresh → duplicate warning works

    const existingRecords = getDashAttendanceExistingTodayFromCache(student);

    if (existingRecords.length > 0) {
      const studentDisplayName =
        student.nameCn ||
        student.name ||
        getDashAttendancePinyin(student) ||
        student.nickname ||
        'This student';

      const proceed = await showDashAttendanceWarning({
        title: t('dashboard.attendance.duplicateStudentTitle'),
        message: t('dashboard.attendance.duplicateStudentText', {
          name: studentDisplayName
        }),
        items: existingRecords.map(formatDashAttendanceRecordLabel),
        proceedText: t('dashboard.attendance.proceed'),
        cancelText: t('dashboard.attendance.cancel')
      });

      if (!proceed) {
        if (method === 'qr') {
          dashAttendanceRestartTimer = setTimeout(async () => {
            await startDashboardAttendanceScanner();
          }, 700);
        }

        return;
      }
    }

    attendanceSelectedStudent = student;
    openDashboardAttendanceConfirmModal(existingRecords);
  } catch (err) {
    console.error('Dashboard attendance selection failed:', err);
    showDashboardToast(err.message || 'Attendance error', true);

    if (method === 'qr') {
      dashAttendanceRestartTimer = setTimeout(async () => {
        await startDashboardAttendanceScanner();
      }, 1200);
    }
  }
}

function openDashboardAttendanceConfirmModal(existingRecords = []) {
  renderDashboardAttendanceConfirm(existingRecords);
  showDashModal('dashAttendanceConfirmModal');
}

function renderDashboardAttendanceConfirm(existingRecords = []) {
  const infoDiv = document.getElementById('dashAttendanceStudentInfo');
  const subDiv = document.getElementById('dashAttendanceSubjectCheckboxes');
  const confirmBtn = document.getElementById('dashAttendanceConfirmBtn');

  if (!infoDiv || !subDiv || !confirmBtn) return;

  const student = attendanceSelectedStudent;

  if (!student) {
    infoDiv.innerHTML = `<span style="color:#dc3545;">❌ No student selected.</span>`;
    subDiv.innerHTML = '';
    confirmBtn.style.display = 'none';
    return;
  }

  const currentSubjects = getDashAttendanceCurrentSubjects(student);

  if (!currentSubjects.length) {
    infoDiv.innerHTML = `
      <span style="color:#dc3545;">
        ❌ ${dashAttendanceEscapeHtml(t('dashboard.attendance.noActiveSubjects'))}
      </span>
    `;
    subDiv.innerHTML = '';
    confirmBtn.style.display = 'none';
    return;
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
  const pinyin = getDashAttendancePinyin(student);

  const existingSubjects = new Set(
    existingRecords
      .map((record) => dashAttendanceNormalizeText(record.subject))
      .filter(Boolean)
  );

  const existingSubjectsText = existingRecords
    .map((record) => record.subject)
    .filter(Boolean)
    .join(', ');

  const existingWarningHtml = existingRecords.length > 0
    ? `
      <div style="margin-top:0.5rem; color:#b45309; font-size:0.8rem; font-weight:700;">
        ⚠️ Already recorded today: ${dashAttendanceEscapeHtml(existingSubjectsText)}
      </div>
    `
    : '';

    const visiting = isVisitingStudent(student);
    const visitingBanner = visiting
        ? `<div style="background:#fef3c7; color:#92400e; padding:0.55rem 0.75rem; border-radius:6px; margin-bottom:0.75rem; font-size:0.85rem; font-weight:600; border:1px solid #fcd34d;">
             🏫 Visiting from: <strong>${dashAttendanceEscapeHtml(student.homeCenterName)}</strong>
           </div>`
        : '';

    infoDiv.innerHTML = `
        ${visitingBanner}
        <div style="background:#f8fafc; padding:0.75rem; border-radius:10px; border:1px solid #e2e8f0;">
            <h3 style="margin:0 0 0.3rem; font-size:1.1rem; font-weight:800;">
                ${dashAttendanceEscapeHtml(student.nameCn || student.name || pinyin || 'N/A')}
            </h3>
            <div style="display:flex; flex-wrap:wrap; gap:0.25rem 0.75rem; font-size:0.85rem; color:#475569;">
                <span><strong>Pinyin:</strong> ${dashAttendanceEscapeHtml(pinyin || '-')}</span>
                <span><strong>Nickname:</strong> ${dashAttendanceEscapeHtml(student.nickname || '-')}</span>
                <span><strong>Grade:</strong> ${dashAttendanceEscapeHtml(student.grade || '-')}</span>
                <span><strong>School:</strong> ${dashAttendanceEscapeHtml(student.school || '-')}</span>
                ${visiting ? `<span><strong>Home Center:</strong> ${dashAttendanceEscapeHtml(student.homeCenterName)}</span>` : ''}
            </div>
            ${existingWarningHtml}
        </div>
    `;

  let html = '';

  currentSubjects.forEach((subject, index) => {
    const slots = Array.isArray(subject.timeslots) ? subject.timeslots : [];

    const fullSchedule = slots.length > 0
      ? slots.map((slot) => {
          return `${String(slot.day || '').substring(0, 3)} ${slot.time || '--:--'}`;
        }).join(', ')
      : t('dashboard.attendance.noSchedule');

    const todaySlot = slots.find((slot) => {
      return expectedNormalizeWeekday(slot.day) === todayDay;
    });

    const todayTime = todaySlot?.time || 'N/A';
    const status = calculateDashAttendanceStatus(todayTime, now);
    const color = getDashAttendanceStatusColor(status);

    const subjectKey = dashAttendanceNormalizeText(subject.name);
    const alreadyRecorded = existingSubjects.has(subjectKey);

    const alreadyBadge = alreadyRecorded
      ? `<span class="dash-attendance-already">${t('dashboard.attendance.alreadyRecordedBadge')}</span>`
      : '';

    const isLast = index === currentSubjects.length - 1;

    html += `
      <label class="dash-attendance-subject-label" style="border-bottom:${isLast ? 'none' : '1px solid #f1f5f9'};">
        <input
          type="checkbox"
          class="att-subject-check"
          value="${dashAttendanceEscapeHtml(subject.name.trim())}"
          data-status="${dashAttendanceEscapeHtml(status)}"
          data-scheduled="${dashAttendanceEscapeHtml(fullSchedule)}"
          data-already-recorded="${alreadyRecorded ? 'true' : 'false'}"
          ${alreadyRecorded ? '' : 'checked'}
        >

        <div class="dash-attendance-subject-body">
          <div class="dash-attendance-subject-name">
            ${dashAttendanceEscapeHtml(subject.name)}
            <span class="dash-attendance-subject-level">
              (${dashAttendanceEscapeHtml(subject.currentLevel || subject.startLevel || '?')})
            </span>
            ${alreadyBadge}
          </div>

          <div class="dash-attendance-subject-meta">
            🕒 ${dashAttendanceEscapeHtml(fullSchedule)}<br>
            ${t('dashboard.attendance.today')}: ${dashAttendanceEscapeHtml(todayDay)} ${dashAttendanceEscapeHtml(todayTime)} |
            ${t('dashboard.attendance.status')}:
            <span style="color:${color}; font-weight:700;">
              ${dashAttendanceEscapeHtml(status)}
            </span>
          </div>
        </div>
      </label>
    `;
  });

  subDiv.innerHTML = html;

  confirmBtn.disabled = false;
  confirmBtn.style.display = 'inline-flex';
  confirmBtn.textContent = t('dashboard.attendance.confirm');
}

async function recordDashboardAttendance() {
  const checks = document.querySelectorAll('#dashAttendanceSubjectCheckboxes .att-subject-check:checked');

  if (!attendanceSelectedStudent) {
    showDashboardToast('No student selected.', true);
    return;
  }

  if (checks.length === 0) {
    showDashboardToast(t('dashboard.attendance.selectSubject'), true);
    return;
  }

  const alreadyRecordedSelected = Array.from(checks)
    .filter((checkbox) => checkbox.dataset.alreadyRecorded === 'true')
    .map((checkbox) => checkbox.value);

  if (alreadyRecordedSelected.length > 0) {
    const proceed = await showDashAttendanceWarning({
      title: t('dashboard.attendance.duplicateSubjectTitle'),
      message: t('dashboard.attendance.duplicateSubjectText'),
      items: alreadyRecordedSelected,
      proceedText: t('dashboard.attendance.proceed'),
      cancelText: t('dashboard.attendance.cancel')
    });

    if (!proceed) return;
  }

  const btn = document.getElementById('dashAttendanceConfirmBtn');
  const originalText = btn?.textContent || 'Confirm';

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Saving...';
  }

  const now = new Date();
  const dateStr = dashAttendanceTodayISO();
  const checkInTime = now.toISOString();

  try {
    const attendanceRef = ref(db, `centers/${centerId}/attendance`);

    const saves = Array.from(checks).map(async (checkbox) => {
    const payload = {
      studentId: String(attendanceSelectedStudent.id || ''),
      studentNumber: String(attendanceSelectedStudent.studentNumber || ''),
      nameCn: String(attendanceSelectedStudent.nameCn || attendanceSelectedStudent.name || '-'),
      nickname: String(attendanceSelectedStudent.nickname || '-'),
      grade: String(attendanceSelectedStudent.grade || '-'),
      school: String(attendanceSelectedStudent.school || '-'),
      pinyin: String(getDashAttendancePinyin(attendanceSelectedStudent) || ''),
      nameEn: String(attendanceSelectedStudent.nameEn || attendanceSelectedStudent.englishName || ''),
      subject: String(checkbox.value.trim()),
      scheduledTime: String(checkbox.dataset.scheduled || t('dashboard.attendance.noSchedule')),
      checkInTime: String(checkInTime),
      date: String(dateStr),
      status: String(checkbox.dataset.status || ''),
      // ✅ NEW: cross-center tracking
      homeCenterId: String(attendanceSelectedStudent.homeCenterId || ''),
      homeCenterName: String(attendanceSelectedStudent.homeCenterName || ''),
      isVisiting: isVisitingStudent(attendanceSelectedStudent),
      timestamp: serverTimestamp()
    };

      const newRef = push(attendanceRef, payload);
      await newRef;

      attendanceRecordsCache.push({
        ...payload,
        id: newRef.key
      });
    });

    await Promise.all(saves);
    
    // ✅ INSTANT UPDATE: The records are already in the cache via the .push() above.
    if (!isDashModalHidden('dashAttendanceManualModal')) {
      renderExpectedNotArrived();
    }

    hideDashModal('dashAttendanceConfirmModal');
    
    // ✅ BACKGROUND SYNC (0.5s load): Give Firebase server time to propagate the write, 
    // then force a fresh pull just in case the server data differs from the local push.
    setTimeout(async () => {
      try {
        await loadDashboardAttendanceRecords(true);
        if (!isDashModalHidden('dashAttendanceManualModal')) {
          renderExpectedNotArrived();
        }
      } catch (e) { 
        console.warn('Background attendance sync failed:', e); 
      }
    }, 500);

    const studentName =
      attendanceSelectedStudent.nameCn ||
      attendanceSelectedStudent.name ||
      getDashAttendancePinyin(attendanceSelectedStudent) ||
      attendanceSelectedStudent.nickname ||
      'student';

    showDashboardToast(t('dashboard.attendance.saveSuccess', {
      name: studentName
    }));

    const method = attendanceLastMethod;
    attendanceSelectedStudent = null;

    if (method === 'qr') {
      dashAttendanceRestartTimer = setTimeout(async () => {
        await startDashboardAttendanceScanner();
      }, 700);
    } else {
      setTimeout(() => {
        openDashboardAttendanceManualModal();
      }, 700);
    }
  } catch (err) {
    console.error('Dashboard attendance save failed:', err);
    showDashboardToast(t('dashboard.attendance.saveFailed'), true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

async function cleanupDashboardAttendanceScanner() {
  if (dashAttendanceRestartTimer) {
    clearTimeout(dashAttendanceRestartTimer);
    dashAttendanceRestartTimer = null;
  }

  if (attendanceHtml5QrCode) {
    try {
      await attendanceHtml5QrCode.stop();
    } catch (err) {
      console.warn('Dashboard attendance scanner stop warning:', err);
    }

    try {
      attendanceHtml5QrCode.clear();
    } catch (err) {
      console.warn('Dashboard attendance scanner clear warning:', err);
    }

    attendanceHtml5QrCode = null;
  }

  const readerDiv = document.getElementById('dashAttendanceQrReader');
  if (readerDiv) {
    readerDiv.innerHTML = '';
  }
}

async function stopDashboardAttendanceScanner() {
  await cleanupDashboardAttendanceScanner();
  hideDashModal('dashAttendanceScanModal');
}

function findDashboardAttendanceStudentByScan(scannedValue) {
    let value = String(scannedValue || '').trim();
    if (!value) return null;
    
    try {
        const url = new URL(value);
        const possible =
            url.searchParams.get('studentNumber') ||
            url.searchParams.get('student') ||
            url.searchParams.get('id') ||
            url.searchParams.get('qr') ||
            url.searchParams.get('qrCode');
        if (possible) value = possible.trim();
    } catch {
        // Not a URL, use raw value
    }
    
    // Current center first (fast path)
    if (attendanceStudentById.has(value)) return attendanceStudentById.get(value);
    if (attendanceStudentByNumber.has(value)) return attendanceStudentByNumber.get(value);
    if (attendanceStudentByQr.has(value)) return attendanceStudentByQr.get(value);
    
    // Global (all centers)
    if (allStudentsByIdGlobal.has(value)) return allStudentsByIdGlobal.get(value);
    if (allStudentsByNumberGlobal.has(value)) return allStudentsByNumberGlobal.get(value);
    
    return allStudentsGlobal.find((student) => {
        return (
            String(student.id || '') === value ||
            String(student.studentNumber || '') === value ||
            String(student.qrCode || '') === value
        );
    }) || null;
}

async function startDashboardAttendanceScanner() {
  const modal = document.getElementById('dashAttendanceScanModal');
  const status = document.getElementById('dashAttendanceScanStatus');
  const readerDiv = document.getElementById('dashAttendanceQrReader');

  if (!modal || !status || !readerDiv) {
    console.error('Missing dashboard attendance scanner elements.');
    return;
  }

  if (typeof Html5Qrcode === 'undefined') {
    showDashModal('dashAttendanceScanModal');
    status.textContent = t('dashboard.attendance.libraryMissing');
    return;
  }

  await cleanupDashboardAttendanceScanner();

  showDashModal('dashAttendanceScanModal');
  status.textContent = t('dashboard.attendance.cameraStarting');

  try {
    attendanceHtml5QrCode = new Html5Qrcode('dashAttendanceQrReader');

    await attendanceHtml5QrCode.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: {
          width: 250,
          height: 250
        },
        aspectRatio: 1.0
      },
      // Inside the scanner success callback (decodedText):
      async (decodedText) => {
          const cleanValue = decodedText.trim();
          await cleanupDashboardAttendanceScanner();
          hideDashModal('dashAttendanceScanModal');
          try {
              let student = findDashboardAttendanceStudentByScan(cleanValue);
              
              // Fallback: force reload both lists if not found initially
              if (!student) {
                  await Promise.all([loadDashboardAttendanceStudents(true), loadAllStudentsGlobal(true)]);
                  student = findDashboardAttendanceStudentByScan(cleanValue);
              }
              
              if (!student) {
                  throw new Error(t('dashboard.attendance.studentNotFound'));
          }
              await selectDashboardAttendanceStudent(student, 'qr');
          } catch (err) {
              console.error('Dashboard attendance scan processing failed:', err);
              showDashboardToast(err.message || 'Scan error', true);
              dashAttendanceRestartTimer = setTimeout(async () => {
                  await startDashboardAttendanceScanner();
              }, 1200);
          }
      },
      () => {
        // Ignore QR decode frame errors
      }
    );

    status.textContent = t('dashboard.attendance.cameraReady');
  } catch (err) {
    console.error('Dashboard attendance scanner init failed:', err);

    let message = err.message || String(err);

    if (err.name === 'NotAllowedError') {
      message = 'Camera permission denied.';
    } else if (err.name === 'NotFoundError') {
      message = 'No camera found.';
    } else if (err.name === 'NotReadableError') {
      message = 'Camera is being used by another application.';
    }

    status.textContent = t('dashboard.attendance.cameraError', {
      message
    });

    attendanceHtml5QrCode = null;
  }
}