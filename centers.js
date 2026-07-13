import { db, logout } from './auth.js';
import { ref, get, push, set } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const auth = getAuth();
const centerGrid = document.getElementById('centerGrid');
const userEmailEl = document.getElementById('userEmail');
const pageLoader = document.getElementById('page-loader');

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  
  userEmailEl.textContent = user.email;
  document.getElementById('logoutBtn').addEventListener('click', logout);
  
  try {
    const userSnap = await get(ref(db, `users/${user.uid}`));
    if (!userSnap.exists()) {
      console.error("User profile not found");
      window.location.href = 'index.html';
      return;
    }
    
    const userData = userSnap.val();
    const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
    const userPermissions = userData.permissions?.centers || {};
    const centersSnap = await get(ref(db, 'centers'));
    
    if (!centersSnap.exists()) {
      centerGrid.innerHTML = '<p style="text-align:center; color:#666; grid-column: 1/-1;">No centers found in database. Please contact admin.</p>';
      pageLoader.classList.add('hidden');
      return;
    }
    
    const allCenters = centersSnap.val();
    centerGrid.innerHTML = '';
    let hasVisibleCenters = false;
    
    Object.entries(allCenters).forEach(([centerId, centerData]) => {
      const hasAccess = isAdmin || userPermissions[centerId] === true;
      if (hasAccess) {
        hasVisibleCenters = true;
        const card = document.createElement('div');
        card.className = 'center-card';
        card.style.cursor = 'pointer';
        card.innerHTML = `
          <div class="card-icon">🏢</div>
          <h3>${centerData.name || centerId}</h3>
          <p>Manage students, reports, and daily operations</p>
        `;
        card.addEventListener('click', () => {
          sessionStorage.setItem('selectedCenter', centerId);
          window.location.href = 'dashboard.html';
        });
        centerGrid.appendChild(card);
      }
    });
    
    if (!hasVisibleCenters) {
      centerGrid.innerHTML = `
        <div class="center-card" style="cursor: default; border-left: 4px solid #dc3545; grid-column: 1 / -1;">
          <div class="card-icon"></div>
          <h3>No Centers Assigned</h3>
          <p>You do not have permission to access any centers. Please contact the administrator to update your permissions.</p>
        </div>
      `;
    }
    
    checkMissingClockOuts();
    pageLoader.classList.add('hidden');
  } catch (error) {
    console.error("Error loading centers:", error);
    centerGrid.innerHTML = '<p style="text-align:center; color:#dc3545; grid-column: 1/-1;">Error loading centers. Please refresh.</p>';
    pageLoader.classList.add('hidden');
  }
});

// ✅ NEW: Check for missing clock-outs and show notification modal
async function checkMissingClockOuts() {
  const user = auth.currentUser;
  if (!user) return;

  const today = new Date().toISOString().split('T')[0];
  
  try {
    const [timecardsSnap, verificationsSnap] = await Promise.all([
      get(ref(db, 'timecards')),
      get(ref(db, 'timecardVerifications'))
    ]);
    
    if (!timecardsSnap.exists()) return;
    
    const timecards = timecardsSnap.val();
    const verifications = verificationsSnap.exists() ? verificationsSnap.val() : {};
    
    // Get pending verification keys to exclude
    const pendingVerificationKeys = new Set();
    Object.entries(verifications).forEach(([id, v]) => {
      if (v.status === 'pending' && v.empId === user.uid) {
        pendingVerificationKeys.add(`${v.date}_${v.inTime}`);
      }
    });
    
    const missingRecords = [];
    
    Object.entries(timecards).forEach(([date, dayData]) => {
      // ONLY check dates before today (ignores real-time same-day records)
      if (date >= today) return; 
      
      const empData = dayData[user.uid];
      if (!empData || !empData.logs) return;
      
      const rawLogs = Array.isArray(empData.logs) ? empData.logs : Object.values(empData.logs);
      const sortedLogs = [...rawLogs].sort((a, b) => a.time.localeCompare(b.time));
      let currentIn = null;
      
      for (const log of sortedLogs) {
        if (log.type === 'in') {
          if (currentIn) {
            // Found another IN without OUT - this is a missing OUT
            const recordKey = `${date}_${currentIn.time}`;
            if (!pendingVerificationKeys.has(recordKey)) {
              missingRecords.push({ 
                date, 
                center: currentIn.location, 
                inTime: currentIn.time, 
                missingType: 'out' 
              });
            }
          }
          currentIn = log;
        } else if (log.type === 'out') {
          if (currentIn && currentIn.location === log.location) {
            // Valid pair found
            currentIn = null;
          }
          // If OUT without matching IN, we ignore it (not showing missing IN)
        }
      }
      
      // If we end with an IN, it's missing an OUT
      if (currentIn) {
        const recordKey = `${date}_${currentIn.time}`;
        if (!pendingVerificationKeys.has(recordKey)) {
          missingRecords.push({ 
            date, 
            center: currentIn.location, 
            inTime: currentIn.time, 
            missingType: 'out' 
          });
        }
      }
    });
    
    if (missingRecords.length > 0) {
      showMissingClockOutModal(missingRecords);
    }
  } catch (err) {
    console.error("Error checking missing clock-outs:", err);
  }
}

function showMissingClockOutModal(records) {
  let modal = document.getElementById('missingClockOutModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'missingClockOutModal';
    modal.className = 'modal';
    modal.style.zIndex = '10000';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 600px; text-align: left;">
        <button class="close-btn" id="closeMissingModalBtn">&times;</button>
        <h3 style="text-align: center; color: #dc3545; margin-bottom: 1rem;">⚠️ Missing Clock-Out Records</h3>
        <p style="color: #666; margin-bottom: 1.5rem; text-align: center;">You have incomplete timecard records from previous days. Please provide the missing times for manager approval.</p>
        <div id="missingRecordsList" style="max-height: 400px; overflow-y: auto; margin-bottom: 1rem;"></div>
        <div style="display:flex; gap:1rem; justify-content:flex-end;">
          <button class="secondary" id="remindLaterBtn">Remind Me Later</button>
          <button class="primary" id="submitMissingClockOutsBtn">Submit for Review</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    document.getElementById('closeMissingModalBtn').onclick = () => modal.style.display = 'none';
    document.getElementById('remindLaterBtn').onclick = () => modal.style.display = 'none';
    
    document.getElementById('submitMissingClockOutsBtn').addEventListener('click', async () => {
      const inputs = document.querySelectorAll('.missing-time-input');
      const recordsToSubmit = [];
      let hasError = false;
      
      inputs.forEach(input => {
        const time = input.value;
        if (!time) {
          hasError = true;
          input.style.borderColor = '#dc3545';
        } else {
          input.style.borderColor = '#cbd5e1';
          recordsToSubmit.push({
            empId: input.dataset.empId,
            date: input.dataset.date,
            center: input.dataset.center,
            inTime: input.dataset.inTime,
            missingType: input.dataset.missingType,
            proposedTime: time
          });
        }
      });
      
      if (hasError) {
        alert('Please fill in all missing times.');
        return;
      }
      
      const btn = document.getElementById('submitMissingClockOutsBtn');
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      
      try {
        const userName = sessionStorage.getItem('kumonUser') ? JSON.parse(sessionStorage.getItem('kumonUser')).name : '';
        for (const rec of recordsToSubmit) {
          const newRef = push(ref(db, 'timecardVerifications'));
          await set(newRef, {
            empId: rec.empId,
            empName: userName,
            date: rec.date,
            center: rec.center,
            inTime: rec.inTime,
            missingType: rec.missingType,
            proposedOutTime: rec.missingType === 'out' ? rec.proposedTime : '',
            status: 'pending',
            requestedAt: new Date().toISOString()
          });
        }
        alert('✅ Submitted successfully! Your manager will review the records.');
        modal.style.display = 'none';
      } catch (err) {
        console.error(err);
        alert('Failed to submit. Please try again.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Submit for Review';
      }
    });
  }
  
  const list = document.getElementById('missingRecordsList');
  list.innerHTML = '';
  
  records.forEach(rec => {
    const item = document.createElement('div');
    item.style.cssText = 'padding: 0.75rem; background: #f8f9fa; border-radius: 6px; margin-bottom: 0.5rem; border: 1px solid #e2e8f0;';
    
    item.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
        <span style="font-weight:600; color:#4682B4;">📅 ${rec.date}</span>
        <span style="font-size:0.85rem; color:#666;"> ${rec.center || 'Unknown'}</span>
      </div>
      <div style="font-size:0.9rem; margin-bottom:0.5rem;">
        Clock-In: <strong>${rec.inTime}</strong> | 
        Missing: <strong style="color:#dc3545;">Clock-Out</strong>
      </div>
      <label style="font-size:0.85rem; font-weight:500; display:block; margin-bottom:0.25rem;">Proposed Clock-Out Time:</label>
      <input type="time" class="missing-time-input" 
             data-emp-id="${auth.currentUser.uid}" 
             data-date="${rec.date}" 
             data-center="${rec.center || ''}" 
             data-in-time="${rec.inTime}" 
             data-missing-type="${rec.missingType}" 
             style="width:100%; padding:0.5rem; border:1px solid #cbd5e1; border-radius:4px;">
    `;
    list.appendChild(item);
  });
  
  modal.style.display = 'flex';
}