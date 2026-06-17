import { auth, requireAuth, logout, db } from './auth.js';
import { ref, get, set, remove, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ============================================
// GLOBAL STATE
// ============================================
let centerId = sessionStorage.getItem('selectedCenter');
let centerName = "";
let calendarEventsMap = {};
let currentCalendarYear = new Date().getFullYear();
let currentScheduleYear = new Date().getFullYear();

// ✅ NEW: Permission flag for holiday management
let canEditHolidays = false;

// Center Operating Hours (0 = Sunday, 6 = Saturday, 2 = Tuesday)
const centerClosedDays = {
    'mei keng': [0],
    'pac tat': [0, 6],
    'champs': [0],
    'tap siac': [2]
};

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    const isAuth = requireAuth();
    if (!isAuth) return;
    
    if (!centerId) {
        alert("No center selected. Redirecting to centers page.");
        window.location.href = "centers.html";
        return;
    }

    await loadCenterDetails();
    
    // ✅ NEW: Check user permissions before setting up the UI
    await checkUserPermissions();
    
    setupTabs();
    setupHolidayForm();
    setupYearControls();

    document.getElementById('calendarYearDisplay').textContent = currentCalendarYear;
    document.getElementById('scheduleYearDisplay').textContent = currentScheduleYear;

    // Real-time listener for calendar events
    onValue(ref(db, `centers/${centerId}/calendar`), (snapshot) => {
        calendarEventsMap = snapshot.exists() ? snapshot.val() : {};
        renderYearCalendar(currentCalendarYear);
        renderClassSchedule(currentScheduleYear);
        renderHolidaysTable();
    });

    document.getElementById('page-loader').classList.add('hidden');
});

// ✅ NEW: Function to check if the current user is an Admin or Manager
async function checkUserPermissions() {
    const user = auth.currentUser;
    if (!user) return;

    try {
        let canEdit = false;
        
        // ✅ CHECK 1: Direct admin email from Firebase Auth
        if (user.email && user.email.toLowerCase() === 'kumonchamps@gmail.com') {
            canEdit = true;
        }
        
        // ✅ CHECK 2: Look in employees table for position
        if (!canEdit) {
            const employeeSnap = await get(ref(db, `employees/${user.uid}`));
            
            if (employeeSnap.exists()) {
                const employeeData = employeeSnap.val();
                const position = employeeData.position;
                
                // Grant access if position is 'Manager' (case-insensitive)
                if (position && position.toLowerCase() === 'manager') {
                    canEdit = true;
                }
            }
        }
        
        canEditHolidays = canEdit;
        applyHolidayUIRestrictions();
    } catch (error) {
        console.error("Error fetching employee permissions:", error);
        canEditHolidays = false; // Fail secure
    }
}

// ✅ NEW: Function to hide/show UI elements based on permissions
function applyHolidayUIRestrictions() {
    const form = document.getElementById('holidayForm');
    const formCard = form ? form.closest('.card') : null;
    
    if (!canEditHolidays) {
        // Hide the "Add New Holiday" form card
        if (formCard) {
            formCard.style.display = 'none';
        }
        
        // Optional: Add a read-only notice above the table
        const tableCard = document.getElementById('holidayTableBody')?.closest('.card');
        if (tableCard && !document.getElementById('readonly-notice')) {
            const notice = document.createElement('p');
            notice.id = 'readonly-notice';
            notice.style.textAlign = 'center';
            notice.style.padding = '1rem';
            notice.style.color = '#666';
            notice.style.fontStyle = 'italic';
            notice.innerHTML = '<i class="fas fa-lock"></i> Holiday management is restricted to Admins and Managers.';
            tableCard.parentNode.insertBefore(notice, tableCard);
        }
    }
}

async function loadCenterDetails() {
    const snap = await get(ref(db, `centers/${centerId}`));
    if (snap.exists()) {
        const data = snap.val();
        centerName = data.name || data.centerName || "Center";
        document.getElementById('calendar-center-name').textContent = `${centerName} Calendar`;
    }
}

// ============================================
// TAB SWITCHING
// ============================================
function setupTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
        });
    });
}

// ============================================
// TAB 1: HOLIDAYS CRUD
// ============================================
function setupHolidayForm() {
    const form = document.getElementById('holidayForm');
    form.addEventListener('submit', async (e) => {
        // ✅ SECURITY GUARD: Prevent submission if not authorized
        if (!canEditHolidays) {
            e.preventDefault();
            alert("You do not have permission to add holidays.");
            return;
        }

        e.preventDefault();
        const date = document.getElementById('holidayDate').value;
        const type = document.getElementById('holidayType').value;
        const name = document.getElementById('holidayName').value.trim();
        const muc = document.getElementById('holidayMUC').value === 'true';
        
        if (!date || !name) return;

        try {
            await set(ref(db, `centers/${centerId}/calendar/${date}`), {
                type: type,
                name: name,
                muc: muc,
                updatedAt: new Date().toISOString()
            });
            form.reset();
            document.getElementById('holidayDate').valueAsDate = new Date();
        } catch (err) {
            console.error("Error adding holiday:", err);
            alert("Failed to add holiday.");
        }
    });

    document.getElementById('holidayDate').valueAsDate = new Date();
}

function renderHolidaysTable() {
    const tbody = document.getElementById('holidayTableBody');
    tbody.innerHTML = '';
    
    const events = Object.entries(calendarEventsMap)
        .map(([key, val]) => {
            const isDateKey = /^\d{4}-\d{2}-\d{2}$/.test(key);
            return { id: key, ...val, date: isDateKey ? key : val.date };
        })
        .filter(e => e.date)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    if (events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#666;">No holidays added yet.</td></tr>';
        return;
    }

    events.forEach(event => {
        const tr = document.createElement('tr');
        const mucDisplay = event.muc 
            ? '<span class="muc-yes">Yes</span>' 
            : '<span class="muc-no">No</span>';
        
        const typeDisplay = event.type === 'public' ? 'Public Holiday' : 'Center Holiday';

        // ✅ CONDITIONAL RENDER: Only show Delete button if authorized
        const actionCell = canEditHolidays 
            ? `<button class="btn-danger" onclick="deleteHoliday('${event.id}')"><i class="fas fa-trash"></i> Delete</button>`
            : `<span style="color:#999; font-size:0.85rem;">Restricted</span>`;

        tr.innerHTML = `
            <td>${event.date}</td>
            <td>${typeDisplay}</td>
            <td>${event.name || '-'}</td>
            <td>${mucDisplay}</td>
            <td>${actionCell}</td>
        `;
        tbody.appendChild(tr);
    });
}

window.deleteHoliday = async function(eventId) {
    // ✅ SECURITY GUARD: Prevent deletion if not authorized
    if (!canEditHolidays) {
        alert("You do not have permission to delete holidays.");
        return;
    }

    if (!confirm("Are you sure you want to delete this holiday?")) return;
    try {
        await remove(ref(db, `centers/${centerId}/calendar/${eventId}`));
    } catch (err) {
        console.error("Error deleting holiday:", err);
        alert("Failed to delete.");
    }
};

// ============================================
// TAB 2: CENTER CALENDAR (12 Months)
// ============================================
function setupYearControls() {
    document.getElementById('prevYearBtn').addEventListener('click', () => {
        currentCalendarYear--;
        document.getElementById('calendarYearDisplay').textContent = currentCalendarYear;
        renderYearCalendar(currentCalendarYear);
    });
    document.getElementById('nextYearBtn').addEventListener('click', () => {
        currentCalendarYear++;
        document.getElementById('calendarYearDisplay').textContent = currentCalendarYear;
        renderYearCalendar(currentCalendarYear);
    });
    document.getElementById('schedulePrevYearBtn').addEventListener('click', () => {
        currentScheduleYear--;
        document.getElementById('scheduleYearDisplay').textContent = currentScheduleYear;
        renderClassSchedule(currentScheduleYear);
    });
    document.getElementById('scheduleNextYearBtn').addEventListener('click', () => {
        currentScheduleYear++;
        document.getElementById('scheduleYearDisplay').textContent = currentScheduleYear;
        renderClassSchedule(currentScheduleYear);
    });
}

function renderYearCalendar(year) {
    const container = document.getElementById('yearCalendarGrid');
    container.innerHTML = '';
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const closedDays = getClosedDaysForCenter(centerName);
    const today = new Date();
    
    monthNames.forEach((monthName, monthIndex) => {
        const monthDiv = document.createElement('div');
        monthDiv.className = 'month-calendar';
        
        let gridHtml = `<h4>${monthName} ${year}</h4><div class="mini-calendar-grid">`;
        
        dayNames.forEach(day => {
            gridHtml += `<div class="day-header">${day}</div>`;
        });

        const firstDay = new Date(year, monthIndex, 1).getDay();
        const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

        for (let i = 0; i < firstDay; i++) {
            gridHtml += `<div class="day-cell empty"></div>`;
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayOfWeek = new Date(year, monthIndex, day).getDay();
            
            let classes = ['day-cell'];
            let tooltip = '';

            if (year === today.getFullYear() && monthIndex === today.getMonth() && day === today.getDate()) {
                classes.push('today');
            }

            let isClosed = closedDays.includes(dayOfWeek);
            const event = calendarEventsMap[dateStr];
 
            if (event && !event.muc) {
                if (event.type === 'public') {
                    classes.push('has-public');
                    tooltip = `Public Holiday: ${event.name || ''}`;
                } else if (event.type === 'center') {
                    classes.push('has-center');
                    tooltip = `Center Holiday: ${event.name || ''}`;
                }
            }

            if (isClosed && !event) {
                classes.push('closed');
            }

            gridHtml += `<div class="${classes.join(' ')}" title="${tooltip}">${day}</div>`;
        }

        gridHtml += `</div>`;
        monthDiv.innerHTML = gridHtml;
        container.appendChild(monthDiv);
    });
}

// ============================================
// TAB 3: MONTHLY CLASS SCHEDULE
// ============================================
function renderClassSchedule(year) {
    const container = document.getElementById('classScheduleContainer');
    container.innerHTML = '';
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const closedDays = getClosedDaysForCenter(centerName);
    const openDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !closedDays.includes(d));
    
    monthNames.forEach((monthName, monthIndex) => {
        const monthDiv = document.createElement('div');
        monthDiv.className = 'schedule-month';
        
        let bodyHtml = `<div class="schedule-month-header">${monthName} ${year}</div><div class="schedule-month-body">`;
        let hasClasses = false;

        openDays.forEach(dayOfWeek => {
            const datesInMonth = [];
            const firstDayOfMonth = new Date(year, monthIndex, 1).getDay();
            const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
            
            let firstDate = 1 + (dayOfWeek - firstDayOfMonth + 7) % 7;
            
            for (let d = firstDate; d <= daysInMonth; d += 7) {
                datesInMonth.push(d);
            }

            if (datesInMonth.length > 0) {
                hasClasses = true;
                const validDates = datesInMonth.map(d => {
                    const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    const event = calendarEventsMap[dateStr];
                      
                    if (event && !event.muc) {
                        return null; // Skip regular holidays
                    }
                    return event && event.muc ? `${d}*` : `${d}`; // Mark MUC with *
                }).filter(d => d !== null);

                if (validDates.length > 0) {
                    bodyHtml += `
                        <div class="schedule-day-group">
                            <h5>${dayNames[dayOfWeek]}</h5>
                            <div class="schedule-dates">
                                ${validDates.map(d => d.includes('*') ? `<span class="muc-date">${d}</span>` : d).join(', ')}
                            </div>
                        </div>
                    `;
                }
            }
        });

        bodyHtml += `</div>`;
        
        if (hasClasses) {
            monthDiv.innerHTML = bodyHtml;
            container.appendChild(monthDiv);
        }
    });

    if (container.innerHTML === '') {
        container.innerHTML = '<p style="text-align:center; color:#666; padding: 2rem;">No class days found for this year based on center operating hours.</p>';
    }
}

// ============================================
// HELPER FUNCTIONS
// ============================================
function getClosedDaysForCenter(name) {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('mei keng')) return centerClosedDays['mei keng'];
    if (lowerName.includes('pac tat')) return centerClosedDays['pac tat'];
    if (lowerName.includes('champs')) return centerClosedDays['champs'];
    if (lowerName.includes('tap siac')) return centerClosedDays['tap siac'];
    return [0]; // Default fallback
}