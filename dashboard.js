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
const centerId = sessionStorage.getItem('selectedCenter');

// ============================================
// DASHBOARD INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
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
        userInfoEl.textContent = `Welcome, ${user.name}`;
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
      logoutBtn.textContent = 'Logging out...';
      logoutBtn.disabled = true;
      await logout();
    });
  }

  // 4. Set current date
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-US', {
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
    saveBtn.textContent = '💾 Schedule PO';

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
            dropdown.innerHTML = '<li style="padding:0.75rem; color:#999; text-align:center;">No students found</li>';
        } else {
            matches.slice(0, 20).forEach(s => {
                const li = document.createElement('li');
                li.style.padding = '0.75rem';
                li.style.cursor = 'pointer';
                li.style.borderBottom = '1px solid #f1f5f9';
                li.innerHTML = `
                    <div style="font-weight:600; color:var(--text);">${s.nameCn || 'N/A'} <span style="color:var(--text-light); font-weight:400;">(${s.namePinyin || ''})</span></div>
                    <div style="font-size:0.8rem; color:var(--text-light);">Grade: ${s.grade || '-'} | No: ${s.studentNumber || '-'}</div>
                `;
                li.onclick = () => {
                    hiddenId.value = s.id;
                    searchInput.value = `${s.nameCn} (${s.namePinyin})`;
                    selectedInfo.textContent = `✅ Selected: ${s.nameCn} (${s.namePinyin})`;
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

        if (!studentId) return alert('⚠️ Please select a student.');
        if (!poDate) return alert('⚠️ Please select a PO date.');

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

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
            alert('✅ Parent Orientation scheduled successfully!');

        } catch (err) {
            console.error('Error scheduling PO:', err);
            alert('❌ Failed to schedule PO. Please try again.');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 Schedule PO';
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
  const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
  const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  
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

// ✅ NEW: Auto-shrink holiday names to fit inside the calendar cell
function autoShrinkHolidayNames() {
    document.querySelectorAll('.holiday-name').forEach(el => {
        let fontSize = 0.6; // Starting size in rem
        el.style.fontSize = fontSize + 'rem';
        // Shrink until it fits or hits minimum size
        while (el.scrollWidth > el.clientWidth && fontSize > 0.35) {
            fontSize -= 0.05;
            el.style.fontSize = fontSize + 'rem';
        }
    });
}

function renderMonthGrid(year, month, containerId, todayDate) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

    const event = calendarEventsMap[dateStr];
    if (event) {
      if (event.type === 'public') cell.classList.add('has-public-holiday');
      if (event.type === 'center') cell.classList.add('has-center-holiday');
      
      // ✅ NEW: Display holiday name inside the cell
      if (event.name) {
          const nameEl = document.createElement('div');
          nameEl.className = 'holiday-name';
          nameEl.textContent = event.name;
          nameEl.title = event.name; // Full name on hover
          cell.appendChild(nameEl);
      }
    }

    if (poDataMap[dateStr] && poDataMap[dateStr].length > 0) {
      cell.classList.add('has-po');
      let tooltipText = `${poDataMap[dateStr].length} Parent Orientation(s) scheduled`;
      if (event) {
        let hType = event.type === 'center' ? 'Center' : 'Public';
        tooltipText += ` | ${hType} Holiday`;
        if (event.name) tooltipText += `: ${event.name}`;
        if (event.muc) tooltipText += ' (MUC)';
      }
      cell.title = tooltipText;
    } else if (event) {
      let hType = event.type === 'center' ? 'Center' : 'Public';
      let titleText = `${hType} Holiday`;
      if (event.name) titleText += `: ${event.name}`;
      if (event.muc) titleText += ' (MUC)';
      cell.title = titleText;
    } else if (isClosed) {
      cell.classList.add('closed-day');
    }
    
    // ✅ UPDATED: Apply DT Class, Tooltip, AND Visual Indicators
    const hasDT = dtDataMap[dateStr] && dtDataMap[dateStr].length > 0;
    if (hasDT) {
        cell.classList.add('has-dt');
        
        // 1. Count DTs by subject abbreviation
        const dtCounts = {};
        dtDataMap[dateStr].forEach(entry => {
            const subj = entry.dtData.subject || '';
            let abbr = '';
            
            if (subj === 'Math') abbr = 'M';
            else if (subj === 'English EFL') abbr = 'L';
            else if (subj === 'English ERP') abbr = 'R';
            else if (subj.includes('Chinese')) abbr = 'C'; // Covers both Trad & Simp
            
            if (abbr) {
                dtCounts[abbr] = (dtCounts[abbr] || 0) + 1;
            }
        });
        
        // 2. Build indicator string, e.g., "M (2) L (1)"
        const indicators = Object.entries(dtCounts)
            .map(([abbr, count]) => `${abbr} (${count})`)
            .join(' ');
            
        // 3. Add indicator visually inside the calendar cell
        const indicatorEl = document.createElement('div');
        indicatorEl.className = 'dt-indicator';
        indicatorEl.textContent = indicators;
        cell.appendChild(indicatorEl);
        
        // 4. Update the hover tooltip to be more descriptive
        const dtTooltip = `DTs Scheduled: ${indicators.replace(/ /g, ', ')}`;
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
    if (e.target.classList.contains('calendar-day') && !e.target.classList.contains('empty')) {
      const dateStr = e.target.dataset.date;
      if (!dateStr) return;

      if (e.target.classList.contains('has-po')) {
          openPOModal(dateStr);
      } else if (e.target.classList.contains('has-dt')) {
          openDTModal(dateStr);
      } else if (isAdmin) {
          openEditCalendarModal(dateStr);
      }
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
  title.textContent = `Parent Orientations on ${dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

  list.innerHTML = '';
  const students = poDataMap[dateStr] || [];

  if (students.length === 0) {
    list.innerHTML = '<p style="text-align:center; color:#666;">No orientations scheduled for this date.</p>';
  } else {
    students.forEach(student => {
      const card = document.createElement('div');
      card.className = 'po-student-card';
      
      const nameParts = [];
      if (student.nameCn) nameParts.push(`<span class="student-name-cn">${student.nameCn}</span>`);
      if (student.namePinyin) nameParts.push(`<span class="student-name-pinyin">(${student.namePinyin})</span>`);
      if (student.nickname) nameParts.push(`<span class="student-name-nickname">"${student.nickname}"</span>`);
      
      const fullNameHtml = nameParts.length > 0 ? nameParts.join(' ') : 'Unknown Student';

      const subjectsHtml = student.subjects.length > 0 
        ? student.subjects.map(s => `<span class="po-subject-tag">${s.name} (Current: ${s.currentLevel})</span>`).join('')
        : '<span style="color:#999; font-size:0.85rem;">No active subjects</span>';

      let dtHtml = '';
      if (student.diagnosticTests && student.diagnosticTests.length > 0) {
        dtHtml = `
          <table class="dt-mini-table">
            <thead>
              <tr>
                <th>Date</th><th>Subject</th><th>Test / AT</th><th>Score</th><th>Time (mins)</th><th>Start Lvl</th><th>Start WS</th>
              </tr>
            </thead>
            <tbody>
              ${student.diagnosticTests.map(dt => {
                const subj = student.subjects.find(s => s.name === dt.subject);
                const startLvl = subj ? subj.startLevel : '-';
                const startWs = subj ? subj.startWS : '-';
                return `
                  <tr>
                    <td>${dt.date || '-'}</td><td>${dt.subject || '-'}</td><td>${dt.test || '-'}</td>
                    <td>${dt.score || '-'}</td><td>${dt.time ? dt.time : '-'}</td><td>${startLvl}</td><td>${startWs}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `;
      } else {
        dtHtml = '<p style="font-size:0.85rem; color:#999; margin-top:0.5rem;">No Diagnostic Tests recorded.</p>';
      }

      card.innerHTML = `
        <h4>
          <span> ${fullNameHtml}</span>
          <span class="grade-school-badge">Grade: ${student.grade} | ${student.school}</span>
        </h4>
        <div class="po-detail-grid">
          <div class="po-detail-item">
            <strong>Subjects & Levels</strong>
            <div>${subjectsHtml}</div>
          </div>
        </div>
        <div class="po-detail-item">
          <strong>Diagnostic Test (DT) Results</strong>
          ${dtHtml}
        </div>
        <div class="po-note-wrapper">
          <label for="note-${student.id}">📝 Instructor Notes for this Student:</label>
          <textarea id="note-${student.id}" class="po-note-area" placeholder="Add notes about this student's orientation...">${student.poNote}</textarea>
          <div style="display:flex; align-items:center; margin-top: 0.5rem;">
            <button class="save-note-btn" onclick="savePoNote('${student.id}', 'note-${student.id}', this)">💾 Save Note</button>
            <span class="save-status" id="status-${student.id}">✅ Saved!</span>
          </div>
        </div>
      `;
      list.appendChild(card);
    });
  }

  const existingBtn = document.getElementById('adminEditHolidayBtn');
  if (existingBtn) existingBtn.remove();

  if (isAdmin) {
    const editCalBtn = document.createElement('button');
    editCalBtn.id = 'adminEditHolidayBtn';
    editCalBtn.className = 'save-note-btn';
    editCalBtn.style.marginTop = '1.5rem';
    editCalBtn.style.background = '#e65100';
    editCalBtn.style.width = '100%';
    editCalBtn.textContent = '📅 Edit Center/Public Holidays for this Date';
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
  const dateObj = new Date(dateStr + 'T00:00:00');
  title.textContent = `Edit Calendar: ${dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
  
  const form = document.getElementById('editCalendarForm');
  form.reset();
  
  const event = calendarEventsMap[dateStr];
  if (event) {
    const radio = form.querySelector(`input[name="eventType"][value="${event.type}"]`);
    if (radio) radio.checked = true;
    document.getElementById('calendarNote').value = event.name || ''; 
  } else {
    form.querySelector('input[name="eventType"][value="none"]').checked = true;
  }

  modal.classList.remove('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    const eventType = form.querySelector('input[name="eventType"]:checked').value;
    const note = document.getElementById('calendarNote').value.trim();
    const saveBtn = form.querySelector('button[type="submit"]');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      if (eventType === 'none') {
        await remove(ref(db, `centers/${centerId}/calendar/${dateStr}`));
        delete calendarEventsMap[dateStr];
      } else {
        const existingEvent = calendarEventsMap[dateStr] || {};
        await update(ref(db, `centers/${centerId}/calendar/${dateStr}`), {
          type: eventType,
          name: note, 
          muc: existingEvent.muc || false,
          updatedAt: new Date().toISOString()
        });
        calendarEventsMap[dateStr] = { type: eventType, name: note, muc: existingEvent.muc || false };
      }
      renderDualCalendar();
      modal.classList.add('hidden');
    } catch (err) {
      console.error("Error saving calendar event:", err);
      alert("Failed to save. Please check your connection.");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save Changes';
    }
  };

  document.getElementById('clearCalendarBtn').onclick = () => {
    if (confirm("Are you sure you want to clear this calendar event?")) {
      form.querySelector('input[name="eventType"][value="none"]').checked = true;
      document.getElementById('calendarNote').value = '';
      form.dispatchEvent(new Event('submit'));
    }
  };
}

window.savePoNote = async function(studentId, textareaId, btnElement) {
  const textarea = document.getElementById(textareaId);
  const statusEl = document.getElementById(`status-${studentId}`);
  const noteText = textarea.value.trim();
  btnElement.disabled = true;
  btnElement.textContent = 'Saving...';

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
    alert("Failed to save note. Please check your connection.");
  } finally {
    btnElement.disabled = false;
    btnElement.textContent = '💾 Save Note';
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
            dropdown.innerHTML = '<li style="padding:0.75rem; color:#999; text-align:center;">No students found</li>';
        } else {
            matches.slice(0, 30).forEach(s => {
                const li = document.createElement('li');
                li.style.padding = '0.75rem';
                li.style.cursor = 'pointer';
                li.style.borderBottom = '1px solid #f1f5f9';
                li.innerHTML = `
                    <div style="font-weight:600; color:var(--text);">${s.nameCn || 'N/A'} <span style="color:var(--text-light); font-weight:400;">(${s.namePinyin || ''})</span></div>
                    <div style="font-size:0.8rem; color:var(--text-light); margin-top:0.25rem;">
                        Grade: ${s.grade || '-'} | No: ${s.studentNumber || '-'}
                    </div>
                    ${s.phoneMom || s.phoneDad || s.phoneOwn ? `
                    <div style="font-size:0.75rem; color:#666; margin-top:0.25rem;">
                        📞 ${s.phoneMom ? `Mom: ${s.phoneMom}` : ''} 
                        ${s.phoneMom && s.phoneDad ? ' | ' : ''}
                        ${s.phoneDad ? `Dad: ${s.phoneDad}` : ''}
                        ${s.phoneMom && s.phoneOwn || s.phoneDad && s.phoneOwn ? ' | ' : ''}
                        ${s.phoneOwn ? `Student: ${s.phoneOwn}` : ''}
                    </div>` : ''}
                `;
                li.onclick = () => {
                    hiddenId.value = s.id;
                    searchInput.value = `${s.nameCn} (${s.namePinyin})`;
                    selectedInfo.textContent = `✅ Selected: ${s.nameCn} (${s.namePinyin})`;
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
        if (!studentId) return alert('⚠️ Please select a student.');
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
    title.textContent = `Diagnostic Tests on ${dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
    list.innerHTML = '';
    
    const entries = dtDataMap[dateStr] || [];
    if (entries.length === 0) {
        list.innerHTML = '<p style="text-align:center; color:#666;">No diagnostic tests scheduled for this date.</p>';
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
            const fullNameHtml = nameParts.length > 0 ? nameParts.join(' ') : 'Unknown Student';
            
            const phone = s.phone ? `${s.phone.mom || ''} ${s.phone.dad ? '| ' + s.phone.dad : ''} ${s.phone.own ? '| ' + s.phone.own : ''}`.trim().replace(/^\| /, '') : 'N/A';
            
            const subjectsArray = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
            const activeSubjects = subjectsArray.filter(sub => sub.status !== 'drop').map(sub => sub.name);
            const subjectsHtml = activeSubjects.length > 0 
                ? activeSubjects.map(name => `<span class="po-subject-tag">${name}</span>`).join('')
                : '<span style="color:#999; font-size:0.85rem;">No active subjects</span>';
                
            let dtTableHtml = `
                <table class="dt-mini-table">
                    <thead><tr><th>Subject</th><th>Test</th><th>Score</th><th>Time</th><th>Suggested</th><th>Actual</th><th>Note</th><th>Action</th></tr></thead>
                    <tbody>
            `;
            studentEntries.forEach(entry => {
                const dt = entry.dtData;
                const safeSubject = (dt.subject || '').replace(/'/g, "\\'"); 
                dtTableHtml += `<tr>
                    <td>${dt.subject || '-'}</td>
                    <td>${dt.test || '-'}</td>
                    <td>${dt.score || '-'}</td>
                    <td>${dt.time || '-'}</td>
                    <td>${dt.suggestedStart || '-'}</td>
                    <td>${dt.actualStart || '-'}</td>
                    <td>${dt.dtNote || '-'}</td>
                    <td style="white-space: nowrap;">
                        <button class="dt-action-btn cancel" data-student="${studentId}" data-date="${dateStr}" data-subject="${safeSubject}" title="Cancel DT">❌</button>
                        <button class="dt-action-btn reschedule" data-student="${studentId}" data-date="${dateStr}" data-subject="${safeSubject}" title="Reschedule DT">📅</button>
                    </td>
                </tr>`;
            });
            dtTableHtml += `</tbody></table>`;
            
            const firstDt = studentEntries[0].dtData;
            const noteId = `dt-note-${studentId}`;
            
            card.innerHTML = `
                <h4><span>${fullNameHtml}</span><span class="grade-school-badge">Grade: ${s.grade || 'N/A'} | ${s.school || 'N/A'}</span></h4>
                <div class="po-detail-grid">
                    <div class="po-detail-item"><strong>Contact</strong><div>${phone}</div></div>
                    <div class="po-detail-item"><strong>Subjects</strong><div>${subjectsHtml}</div></div>
                </div>
                <div class="po-detail-item"><strong>Diagnostic Test (DT) Details</strong>${dtTableHtml}</div>
                <div class="po-note-wrapper">
                    <label for="${noteId}">📝 DT Notes for this Student:</label>
                    <textarea id="${noteId}" class="po-note-area" placeholder="Add notes about this student's diagnostic test...">${firstDt.dtNote || ''}</textarea>
                    <div style="display:flex; align-items:center; margin-top: 0.5rem;">
                        <button class="save-note-btn" onclick="saveDtNote('${studentId}', '${dateStr}', '${noteId}', this)">💾 Save Note</button>
                        <span class="save-status" id="dt-status-${studentId}">✅ Saved!</span>
                    </div>
                </div>
            `;
            list.appendChild(card);

            card.querySelectorAll('.dt-action-btn.cancel').forEach(btn => {
                btn.onclick = () => cancelDT(btn.dataset.student, btn.dataset.date, btn.dataset.subject);
            });
            
            card.querySelectorAll('.dt-action-btn.reschedule').forEach(btn => {
                btn.onclick = (e) => {
                    const cell = e.target.closest('td');
                    e.target.outerHTML = `<input type="date" class="inline-reschedule-date">`;
                    const cancelBtn = cell.querySelector('.cancel');
                    if(cancelBtn) cancelBtn.style.display = 'none';

                    const dateInput = cell.querySelector('.inline-reschedule-date');
                    dateInput.focus();

                    const saveReschedule = async () => {
                        const newDate = dateInput.value;
                        if (!newDate) { revertUI(); return; }
                        await rescheduleDT(btn.dataset.student, btn.dataset.date, btn.dataset.subject, newDate);
                    };

                    dateInput.onchange = saveReschedule;
                    dateInput.onblur = () => setTimeout(revertUI, 200);

                    function revertUI() {
                        openDTModal(dateStr);
                    }
                };
            });
        });
    }
    modal.classList.remove('hidden');
}

async function cancelDT(studentId, dateStr, subject) {
    if (!confirm(`Cancel Diagnostic Test for ${subject} on ${dateStr}?\nThis will also remove it from the student's form.`)) return;

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
        alert('✅ DT Cancelled successfully.');
    } catch (err) {
        console.error('Error cancelling DT:', err);
        alert('❌ Failed to cancel DT.');
    }
}

async function rescheduleDT(studentId, oldDateStr, subject, newDateStr) {
    if (oldDateStr === newDateStr) {
        openDTModal(oldDateStr);
        return;
    }

    try {
        const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
        if (!snap.exists()) return;
        const s = snap.val();

        if (s.diagnosticTests) {
            const dt = s.diagnosticTests.find(d => d.date === oldDateStr && d.subject === subject);
            if (dt) {
                const exists = s.diagnosticTests.some(d => d.date === newDateStr && d.subject === subject);
                if (exists) {
                    alert('⚠️ This student already has a DT for this subject on the new date.');
                    openDTModal(oldDateStr);
                    return;
                }
                dt.date = newDateStr;
                await update(ref(db, `centers/${centerId}/students/${studentId}`), { diagnosticTests: s.diagnosticTests });
            }
        }

        if (dtDataMap[oldDateStr]) {
            const entryIndex = dtDataMap[oldDateStr].findIndex(e => e.id === studentId && e.dtData.date === oldDateStr && e.dtData.subject === subject);
            if (entryIndex !== -1) {
                const entry = dtDataMap[oldDateStr][entryIndex];
                entry.dtData.date = newDateStr;

                if (!dtDataMap[newDateStr]) dtDataMap[newDateStr] = [];
                dtDataMap[newDateStr].push(entry);
                dtDataMap[oldDateStr].splice(entryIndex, 1);
                if (dtDataMap[oldDateStr].length === 0) delete dtDataMap[oldDateStr];
            }
        }

        renderDualCalendar();
        openDTModal(newDateStr); 
        alert('✅ DT Rescheduled successfully.');
    } catch (err) {
        console.error('Error rescheduling DT:', err);
        alert('❌ Failed to reschedule DT.');
    }
}

window.saveDtNote = async function(studentId, dateStr, textareaId, btnElement) {
    const textarea = document.getElementById(textareaId);
    const statusEl = document.getElementById(`dt-status-${studentId}`);
    const noteText = textarea.value.trim();
    btnElement.disabled = true;
    btnElement.textContent = 'Saving...';
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
        alert("Failed to save note.");
    } finally {
        btnElement.disabled = false;
        btnElement.textContent = '💾 Save Note';
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
    
    // 1. Hard reset using inline styles to guarantee visibility state
    existingForm.style.display = 'none';
    searchInput.value = '';
    dropdown.innerHTML = '';
    dropdown.style.display = 'none';
    selectedInfo.style.display = 'none';
    hiddenId.value = '';
    container.innerHTML = '';
    addDTSubjectRow(); // Start with one empty row
    
    // 2. Show modal
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
        if (!term) { 
            dropdown.style.display = 'none'; 
            return; 
        }
        const matches = allStudentsForSearch.filter(s => 
            (s.namePinyin || '').toLowerCase().includes(term) ||
            (s.nameCn || '').toLowerCase().includes(term) ||
            (s.studentNumber || '').toLowerCase().includes(term)
        );
        dropdown.innerHTML = '';
        if (matches.length === 0) {
            dropdown.innerHTML = '<li style="padding:0.75rem; color:#999; text-align:center;">No students found</li>';
        } else {
            matches.slice(0, 20).forEach(s => {
                const li = document.createElement('li');
                li.style.cssText = 'padding:0.75rem; cursor:pointer; border-bottom:1px solid #f1f5f9;';
                li.innerHTML = `<div style="font-weight:600;">${s.nameCn || 'N/A'} <span style="color:var(--text-light); font-weight:400;">(${s.namePinyin || ''})</span></div><div style="font-size:0.8rem; color:var(--text-light);">Grade: ${s.grade || '-'} | No: ${s.studentNumber || '-'}</div>`;
                li.onclick = () => {
                    hiddenId.value = s.id;
                    searchInput.value = `${s.nameCn} (${s.namePinyin})`;
                    document.getElementById('selectedDTStudentName').textContent = `${s.nameCn} (${s.namePinyin})`;
                    selectedInfo.style.display = 'flex'; // ✅ Reliably shows the indicator
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
        if (!studentId) return alert('⚠️ Please select a student.');
        
        const rows = container.querySelectorAll('.dt-subject-row');
        let dtEntries = [];
        let hasError = false;

        rows.forEach(row => {
            const subject = row.querySelector('.dt-row-subject').value;
            const date = row.querySelector('.dt-row-date').value;
            if (subject && date) {
                dtEntries.push({ subject, date });
            } else if (subject || date) {
                hasError = true;
            }
        });

        if (hasError) return alert('⚠️ Please complete both Subject and Date for all added rows, or remove empty rows.');
        if (dtEntries.length === 0) return alert('⚠️ Please add at least one subject and date.');
        
        const saveBtn = document.getElementById('saveScheduleDTBtnDash');
        saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
        try {
            const snap = await get(ref(db, `centers/${centerId}/students/${studentId}`));
            if (!snap.exists()) throw new Error('Student not found.');
            const s = snap.val();
            if (!s.diagnosticTests) s.diagnosticTests = [];
            
            let addedCount = 0;
            for (const entry of dtEntries) {
                const exists = s.diagnosticTests.some(dt => dt.subject === entry.subject && dt.date === entry.date);
                if (!exists) {
                    const newDT = { subject: entry.subject, date: entry.date, test: '', score: '', time: '', suggestedStart: '', actualStart: '', dtNote: '' };
                    s.diagnosticTests.push(newDT);
                    addedCount++;
                    
                    if (!dtDataMap[entry.date]) dtDataMap[entry.date] = [];
                    dtDataMap[entry.date].push({ id: studentId, studentData: s, dtData: newDT });
                }
            }
            
            if (addedCount > 0) {
                await update(ref(db, `centers/${centerId}/students/${studentId}`), { diagnosticTests: s.diagnosticTests });
            }
            
            renderDualCalendar();
            modal.classList.add('hidden');
            alert(`✅ ${addedCount} Diagnostic Test(s) scheduled successfully!`);
        } catch (err) {
            console.error('Error scheduling DT:', err);
            alert('❌ Failed to schedule DT.');
        } finally {
            saveBtn.disabled = false; saveBtn.textContent = '💾 Schedule DT(s)';
        }
    };
}

// ✅ SINGLE, CLEAN VERSION OF THIS FUNCTION
function addDTSubjectRow() {
    const container = document.getElementById('dtSubjectsContainer');
    const row = document.createElement('div');
    row.className = 'dt-subject-row';
    row.innerHTML = `
        <div class="dt-row-group">
            <label>Subject *</label>
            <select class="dt-row-subject">
                <option value="">Select Subject</option>
                <option value="Math">Math</option>
                <option value="Chinese (Trad)">Chinese (Trad)</option>
                <option value="Chinese (Simp)">Chinese (Simp)</option>
                <option value="English ERP">English ERP</option>
                <option value="English EFL">English EFL</option>
            </select>
        </div>
        <div class="dt-row-group">
            <label>Diagnostic Date *</label>
            <input type="date" class="dt-row-date">
        </div>
        <button type="button" class="remove-dt-row-btn" title="Remove">×</button>
    `;
    row.querySelector('.remove-dt-row-btn').onclick = () => {
        row.remove();
        if (container.children.length === 0) addDTSubjectRow(); // Keep at least one row
    };
    container.appendChild(row);
}

// Close listeners for Schedule DT Modal
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
            // Close FAB menu
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
    
    form.reset();
    container.innerHTML = '';
    qiSubjectCount = 0;
    
    // Populate Grades
    const gradeSelect = document.getElementById('qiGrade');
    gradeSelect.innerHTML = '<option value="">Select Grade</option>' + 
        GRADES_QI.map(g => `<option value="${g}">${g}</option>`).join('');

    addQISubjectRow(); // Add first subject row
    modal.classList.remove('hidden');
}

function addQISubjectRow() {
    const container = document.getElementById('qiSubjectsContainer');
    if (qiSubjectCount >= 3) {
        alert('⚠️ Maximum 3 subjects allowed for inquiry.');
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
        return `<option value="${s}" ${isUsed ? 'disabled' : ''}>${s}${isUsed ? ' (Added)' : ''}</option>`;
    }).join('');

    // ✅ UPDATED HTML STRUCTURE
    row.innerHTML = `
        <div class="qi-row-group" style="flex: 2;">
            <label>Subject *</label>
            <select class="qi-subject-select" required>
                <option value="">Select Subject</option>
                ${subjectOptions}
            </select>
        </div>
        <div class="qi-row-group checkbox-group">
            <label class="checkbox-label">
                <input type="checkbox" class="qi-schedule-dt">
                <span>Schedule DT?</span>
            </label>
        </div>
        <div class="qi-row-group qi-dt-date-wrapper" style="flex: 1.5;">
            <label>DT Date *</label>
            <input type="date" class="qi-dt-date">
        </div>
        <button type="button" class="remove-qi-row-btn" title="Remove">×</button>
    `;

    // The rest of the event listeners remain exactly the same
    const dtCheckbox = row.querySelector('.qi-schedule-dt');
    const dtDateWrapper = row.querySelector('.qi-dt-date-wrapper');
    const dtDateInput = row.querySelector('.qi-dt-date');

    dtCheckbox.addEventListener('change', () => {
        if (dtCheckbox.checked) {
            dtDateWrapper.classList.add('visible');
            dtDateInput.required = true;
        } else {
            dtDateWrapper.classList.remove('visible');
            dtDateInput.required = false;
            dtDateInput.value = '';
        }
    });

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
        sel.innerHTML = '<option value="">Select Subject</option>' + 
            SUBJECTS_QI.map(s => {
                const isUsed = usedSubjects.has(s) && s !== currentVal;
                return `<option value="${s}" ${s === currentVal ? 'selected' : ''} ${isUsed ? 'disabled' : ''}>${s}${isUsed ? ' (Added)' : ''}</option>`;
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

    // Validations
    if (!nameCn) return alert('⚠️ Name (Chinese) is required.');
    if (!dob) return alert('⚠️ Date of Birth is required.');
    if (!grade) return alert('⚠️ Grade is required.');
    if (!school) return alert('⚠️ School is required.');
    if (!phoneMom && !phoneDad && !phoneOwn) return alert('⚠️ At least one Contact Number is required.');

    const container = document.getElementById('qiSubjectsContainer');
    const rows = container.querySelectorAll('.qi-subject-row');
    
    if (rows.length === 0) return alert('⚠️ Please add at least one subject.');

    const subjects = [];
    const diagnosticTests = [];
    const todayStr = new Date().toISOString().split('T')[0];

    for (const row of rows) {
        const subject = row.querySelector('.qi-subject-select').value;
        const scheduleDT = row.querySelector('.qi-schedule-dt').checked;
        const dtDate = row.querySelector('.qi-dt-date').value;

        if (!subject) return alert('⚠️ Please select a subject for all rows.');
        if (scheduleDT && !dtDate) return alert(`⚠️ Please select a DT date for ${subject}.`);

        // Construct Subject Object matching student-form.js expectations for 'inquiry'
        subjects.push({
            name: subject,
            startLevel: '',
            startWS: 0,
            inquiryDate: todayStr,
            currentLevel: '',
            enrolDate: '',
            status: 'inquiry', // Crucial: Sets status to inquiry
            timeslots: [],
            progress: [],
            pencilSkill: null,
            pauseFromMonth: '', pauseFromYear: '', pauseToMonth: '', pauseToYear: '', pauseReason: '',
            dropMonth: '', dropYear: '', dropReason: '',
            pendingRequest: null,
            worksheetType: 'Paper'
        });

        if (scheduleDT && dtDate) {
            diagnosticTests.push({
                subject: subject,
                date: dtDate,
                test: '',
                score: '',
                time: '',
                suggestedStart: '',
                actualStart: '',
                dtNote: ''
            });
        }
    }

    // Construct Final Student Data Object
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
        phone: { mom: phoneMom, dad: phoneDad, own: phoneOwn },
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
    saveBtn.textContent = 'Saving...';

    try {
        // Push to Firebase
        const newStudentRef = push(ref(db, `centers/${centerId}/students`), studentData);
        const newStudentId = newStudentRef.key;

        // Update local DT map so the calendar reflects the new DT immediately
        diagnosticTests.forEach(dt => {
            if (!dtDataMap[dt.date]) dtDataMap[dt.date] = [];
            dtDataMap[dt.date].push({
                id: newStudentId,
                studentData: studentData,
                dtData: dt
            });
        });

        renderDualCalendar(); // Refresh calendar UI
        
        document.getElementById('quickInquiryModal').classList.add('hidden');
        alert('✅ Student Inquiry added successfully!');
        
    } catch (err) {
        console.error('Error saving quick inquiry:', err);
        alert('❌ Failed to save inquiry. Please try again.');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Inquiry';
    }
}