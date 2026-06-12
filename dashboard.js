import { auth, requireAuth, logout, db } from './auth.js';
import { ref, get, update } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

// ============================================
// DASHBOARD INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Ensure user is authenticated
    const isAuth = requireAuth();
    if (!isAuth) return;

    // 2. Hide page loader once ready
    const loader = document.getElementById('page-loader');
    if (loader) {
        setTimeout(() => loader.classList.add('hidden'), 300);
    }

    // 3. Populate User Info in Header
    const storedUser = sessionStorage.getItem('kumonUser');
    if (storedUser) {
        try {
            const user = JSON.parse(storedUser);
            const userInfoEl = document.getElementById('userInfo');
            if (userInfoEl) {
                userInfoEl.textContent = `Welcome, ${user.name}`;
            }
        } catch (error) {
            console.error('Error parsing user data:', error);
        }
    }

    // 4. Attach Logout Event Listener
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            logoutBtn.textContent = 'Logging out...';
            logoutBtn.disabled = true;
            await logout();
        });
    }

    // 5. Initialize PO Calendar
    await initPOCalendar();

    console.log('Dashboard loaded successfully for user:', auth.currentUser?.email);
});

// ============================================
// CALENDAR & PO LOGIC
// ============================================
let poDataMap = {}; // Format: { "YYYY-MM-DD": [studentObject, ...] }
const centerId = sessionStorage.getItem('selectedCenter');

async function initPOCalendar() {
    if (!centerId) return;

    try {
        const snap = await get(ref(db, `centers/${centerId}/students`));
        if (!snap.exists()) return;

        const students = snap.val();
        poDataMap = {};

        // Process students to find PO dates
        Object.entries(students).forEach(([id, s]) => {
            if (s.parentOrientation === 'Yes' && s.poDate) {
                const dateKey = s.poDate; // Already in YYYY-MM-DD format from <input type="date">
                if (!poDataMap[dateKey]) poDataMap[dateKey] = [];

                // Extract active subjects
                const subjectsArray = Array.isArray(s.subjects) ? s.subjects : Object.values(s.subjects || {});
                const activeSubjects = subjectsArray
                    .filter(sub => sub.status !== 'drop' && sub.status !== 'pause')
                    .map(sub => ({ 
                        name: sub.name, 
                        startLevel: sub.startLevel || '-', 
                        startWS: sub.startWS || '-' 
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

        renderDualCalendar();
        setupModalListeners();
    } catch (err) {
        console.error("Error loading PO calendar data:", err);
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

    // Day headers
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    days.forEach(day => {
        const header = document.createElement('div');
        header.className = 'calendar-day-header';
        header.textContent = day;
        container.appendChild(header);
    });

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Empty cells for days before the 1st
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'calendar-day empty';
        container.appendChild(empty);
    }

    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        cell.textContent = day;

        // Highlight today
        if (year === todayDate.getFullYear() && month === todayDate.getMonth() && day === todayDate.getDate()) {
            cell.classList.add('today');
        }

        // Highlight if PO exists
        if (poDataMap[dateStr] && poDataMap[dateStr].length > 0) {
            cell.classList.add('has-po');
            cell.dataset.date = dateStr;
            cell.title = `${poDataMap[dateStr].length} Parent Orientation(s) scheduled`;
        }

        container.appendChild(cell);
    }
}

function setupModalListeners() {
    const modal = document.getElementById('poModal');
    const closeBtn = document.getElementById('closePoModal');

    // Delegate click events to calendar days
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('has-po')) {
            openPOModal(e.target.dataset.date);
        }
    });

    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
    });
}

function openPOModal(dateStr) {
    const modal = document.getElementById('poModal');
    const title = document.getElementById('modalDateTitle');
    const list = document.getElementById('poStudentList');
    
    // Format date for display (prevent timezone shift)
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
            
            // Build formatted name HTML (Chinese, Pinyin, Nickname)
            const nameParts = [];
            if (student.nameCn) nameParts.push(`<span class="student-name-cn">${student.nameCn}</span>`);
            if (student.namePinyin) nameParts.push(`<span class="student-name-pinyin">(${student.namePinyin})</span>`);
            if (student.nickname) nameParts.push(`<span class="student-nickname">"${student.nickname}"</span>`);
            
            const fullNameHtml = nameParts.length > 0 ? nameParts.join(' ') : 'Unknown Student';

            // Build Subjects HTML
            const subjectsHtml = student.subjects.length > 0 
                ? student.subjects.map(s => `<span class="po-subject-tag">${s.name} (Lvl: ${s.startLevel}, WS: ${s.startWS})</span>`).join('')
                : '<span style="color:#999; font-size:0.85rem;">No active subjects</span>';

            // Build DT Table HTML
            let dtHtml = '';
            if (student.diagnosticTests && student.diagnosticTests.length > 0) {
                dtHtml = `
                    <table class="dt-mini-table">
                        <thead>
                            <tr><th>Subject</th><th>Test / AT</th><th>Score</th><th>Time (mins)</th></tr>
                        </thead>
                        <tbody>
                            ${student.diagnosticTests.map(dt => `
                                <tr>
                                    <td>${dt.subject || '-'}</td>
                                    <td>${dt.test || '-'}</td>
                                    <td>${dt.score || '-'}</td>
                                    <td>${dt.time ? dt.time : '-'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                `;
            } else {
                dtHtml = '<p style="font-size:0.85rem; color:#999; margin-top:0.5rem;">No Diagnostic Tests recorded.</p>';
            }

            card.innerHTML = `
                <h4>
                    <span>👤 ${fullNameHtml}</span>
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
                    <textarea 
                        id="note-${student.id}" 
                        class="po-note-area" 
                        placeholder="Add notes about this student's orientation..."
                    >${student.poNote}</textarea>
                    <div style="display:flex; align-items:center; margin-top: 0.5rem;">
                        <button class="save-note-btn" onclick="savePoNote('${student.id}', 'note-${student.id}', this)">💾 Save Note</button>
                        <span class="save-status" id="status-${student.id}">✅ Saved!</span>
                    </div>
                </div>
            `;
            list.appendChild(card);
        });
    }

    modal.classList.remove('hidden');
}

// Exposed to global scope for the onclick handler in the generated HTML
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
        
        // Update local map so it persists if modal is reopened without refreshing
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