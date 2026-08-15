// dashboard.js (PART 1/2)
import './dashboard-i18n.js';
import { i18nReady, t, currentLanguage } from './i18n-core.js';
import { auth, requireAuth, logout, db, syncPendingRequests } from './auth.js';
import { ref, get, update, remove, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ============================================
// GLOBAL STATE
// ============================================
let isAdmin = false;
let poDataMap = {};
let dtDataMap = {}; // Stores Diagnostic Test events
let calendarEventsMap = {}; // Stores holiday events
let centerName = ""; // Stores the center name to determine closed days

let editingCalendarDate = null;
let pendingOtherEvents = [];

const centerId = sessionStorage.getItem('selectedCenter');

// Locale-aware date formatting
const dateLocale = () => (currentLanguage() === 'zh-TW' ? 'zh-TW' : 'en-US');

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
    initFAB();
    initQuickInquiry();
    setupSchedulePOModalListeners();
    setupSearchStudentModalListeners();
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
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();
  const nextMonth = currentMonth === 11 ? 0  : currentMonth + 1;
  const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
  
  const monthNames = t('dashboard.months', { returnObjects: true });
  document.getElementById('currentMonthTitle').textContent = `${monthNames[currentMonth]} ${currentYear}`;
  document.getElementById('nextMonthTitle').textContent = `${monthNames[nextMonth]} ${nextYear}`;
  
  renderMonthGrid(currentYear, currentMonth, 'calendarCurrent', today);
  renderMonthGrid(nextYear, nextMonth, 'calendarNext', today);
  autoShrinkHolidayNames();
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
        li.innerHTML = `
          <div style="font-weight:600; color:var(--text);">${s.nameCn || 'N/A'} <span style="color:var(--text-light); font-weight:400;">(${s.namePinyin || ''})</span></div>
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