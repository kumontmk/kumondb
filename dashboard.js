import { auth, requireAuth, logout, db } from './auth.js';
import { ref, get, update, remove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ============================================
// GLOBAL STATE
// ============================================
let isAdmin = false;
let poDataMap = {};
let calendarEventsMap = {}; // Stores holiday events
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
      
      // ✅ NEW: Update dashboard header with the logged-in user's name
      const dashboardUserNameEl = document.getElementById('dashboard-user-name');
      if (dashboardUserNameEl) {
        dashboardUserNameEl.textContent = user.name || 'there';
      }
      
      // ✅ Apply Dashboard Permissions & Set Admin Status
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

  // 5. ✅ NEW: Load and display Center Name in Calendar
  await loadCenterName();

  // 6. Initialize PO Calendar and Hide Loader
  try {
    await initPOCalendar();
  } catch (err) {
    console.error("Error initializing dashboard:", err);
  } finally {
    const loader = document.getElementById('page-loader');
    if (loader) loader.classList.add('hidden');
  }

  console.log('Dashboard loaded successfully for user:', auth.currentUser?.email);
});

// ✅ NEW: Function to fetch and display the Center Name
// ✅ NEW: Function to fetch and display the Center Name
async function loadCenterName() {
  if (!centerId) return;
  try {
    const centerSnap = await get(ref(db, `centers/${centerId}`));
    if (centerSnap.exists()) {
      const centerData = centerSnap.val();
      // Adjust 'name' or 'centerName' based on your actual Firebase database schema
      const centerName = centerData.name || centerData.centerName || "Center";
      
      const calendarNameEl = document.getElementById('calendar-center-name');
      if (calendarNameEl) calendarNameEl.textContent = centerName;

      const titleCenterNameEl = document.getElementById('title-center-name');
      if (titleCenterNameEl) titleCenterNameEl.textContent = centerName;

      // ✅ NEW: Show MK Progress Report link if center is Mei Keng
      const mkLink = document.getElementById('link-mk-progress');
      if (mkLink) {
        const isMK = centerName.toLowerCase().includes('mei keng');
        if (isMK) {
          mkLink.style.display = 'flex'; // Reveal the card
        }
      }
    }
  } catch (err) {
    console.error("Error loading center name:", err);
  }
}

// ✅ Permission Logic Function
async function applyDashboardPermissions(user) {
  try {
    const userSnap = await get(ref(db, `users/${user.uid}`));
    if (!userSnap.exists()) return;

    const userData = userSnap.val();
    
    // ✅ Set global admin status
    isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
    const dashPerms = userData.permissions?.dashboardCards || {};

    const cardMap = {
      'card-studentManagement': 'studentManagement',
      'card-timetable': 'timetable',
      'card-monthlyReports': 'monthlyReports',
      'card-progressCharts': 'progressCharts',
      'card-attendance': 'attendance',
      'card-parentOrientation': 'parentOrientation'
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
    // 1. Load PO Data (EXISTING LOGIC PRESERVED)
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
    }

    // 2. Load Calendar Events (Holidays) - NEW
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
    
    // ✅ Always set dataset.date so admin can click any date
    cell.dataset.date = dateStr;

    if (year === todayDate.getFullYear() && month === todayDate.getMonth() && day === todayDate.getDate()) {
      cell.classList.add('today');
    }

    // Apply Holiday Classes (NEW)
    const event = calendarEventsMap[dateStr];
    if (event) {
      if (event.type === 'center') cell.classList.add('has-center-holiday');
      if (event.type === 'employee') cell.classList.add('has-employee-holiday');
    }

    // Apply PO Class (EXISTING)
    if (poDataMap[dateStr] && poDataMap[dateStr].length > 0) {
      cell.classList.add('has-po');
      let tooltipText = `${poDataMap[dateStr].length} Parent Orientation(s) scheduled`;
      if (event) tooltipText += ` | ${event.type === 'center' ? 'Center' : 'Employee'} Holiday`;
      cell.title = tooltipText;
    } else if (event) {
      cell.title = `${event.type === 'center' ? 'Center' : 'Employee'} Holiday` + (event.note ? `: ${event.note}` : '');
    }

    container.appendChild(cell);
  }
}

function setupModalListeners() {
  const poModal = document.getElementById('poModal');
  const closePoBtn = document.getElementById('closePoModal');
  
  const editModal = document.getElementById('editCalendarModal');
  const closeEditBtn = document.getElementById('closeEditCalendarModal');

  // ✅ UPDATED CLICK LOGIC
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('calendar-day') && !e.target.classList.contains('empty')) {
      const dateStr = e.target.dataset.date;
      if (!dateStr) return;

      // 1. If there's a PO, ALWAYS open the full PO modal (for everyone, including admin)
      if (e.target.classList.contains('has-po')) {
        openPOModal(dateStr);
      } 
      // 2. If no PO, only admin can click to edit holidays
      else if (isAdmin) {
        openEditCalendarModal(dateStr);
      }
    }
  });

  closePoBtn.addEventListener('click', () => poModal.classList.add('hidden'));
  poModal.addEventListener('click', (e) => {
    if (e.target === poModal) poModal.classList.add('hidden');
  });

  closeEditBtn.addEventListener('click', () => editModal.classList.add('hidden'));
  editModal.addEventListener('click', (e) => {
    if (e.target === editModal) editModal.classList.add('hidden');
  });
}

// ============================================
// EXISTING PO MODAL LOGIC (100% PRESERVED)
// ============================================
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

  // ✅ NEW: Add button for Admin to edit holidays from the PO Modal
  const existingBtn = document.getElementById('adminEditHolidayBtn');
  if (existingBtn) existingBtn.remove(); // Prevent duplicates if reopened

  if (isAdmin) {
    const editCalBtn = document.createElement('button');
    editCalBtn.id = 'adminEditHolidayBtn';
    editCalBtn.className = 'save-note-btn';
    editCalBtn.style.marginTop = '1.5rem';
    editCalBtn.style.background = '#e65100'; // Orange to match Center Holiday
    editCalBtn.style.width = '100%';
    editCalBtn.textContent = '📅 Edit Center/Employee Holidays for this Date';
    editCalBtn.onclick = () => {
      modal.classList.add('hidden'); // Close PO modal
      openEditCalendarModal(dateStr); // Open Edit Calendar modal
    };
    modal.querySelector('.modal-content').appendChild(editCalBtn);
  }

  modal.classList.remove('hidden');
}

// ============================================
// NEW: ADMIN CALENDAR EDIT MODAL
// ============================================
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
    document.getElementById('calendarNote').value = event.note || '';
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
        // ✅ FIX: Use remove() instead of update(..., null) to properly delete the node
        await remove(ref(db, `centers/${centerId}/calendar/${dateStr}`));
        delete calendarEventsMap[dateStr];
      } else {
        await update(ref(db, `centers/${centerId}/calendar/${dateStr}`), {
          type: eventType,
          note: note,
          updatedAt: new Date().toISOString()
        });
        calendarEventsMap[dateStr] = { type: eventType, note: note };
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

// ============================================
// EXISTING: PO NOTE SAVE FUNCTION (100% PRESERVED)
// ============================================
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