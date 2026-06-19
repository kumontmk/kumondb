import { db, logout, requireAuth } from './auth.js';
import { ref, set, get, update, onValue, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const AUTHORIZED_EMAIL = "kumonchamps@gmail.com";
const auth = getAuth();

const mainContent = document.getElementById('mainContent');
const accessDenied = document.getElementById('accessDenied');
const backToDashboardBtn = document.getElementById('backToDashboard');

function checkAuthorization(user) {
  console.log('🔐 Auth Check:', { email: user?.email, uid: user?.uid, isVerified: user?.emailVerified, required: AUTHORIZED_EMAIL });
  if (!user) {
    showAccessDenied('🔐 Please log in first', 'No user session found.');
    return false;
  }
  const actualEmail = user.email?.toLowerCase() || '';
  const requiredEmail = AUTHORIZED_EMAIL.toLowerCase();
  if (actualEmail !== requiredEmail) {
    showAccessDenied('🔐 Access Restricted', `<p><strong>${user.email || 'Not available'} is not authorized to access this page.</strong></p><p style="margin-top:1rem;color:#666;font-size:0.9rem;">Please log in with an authorized account or contact your administrator if you believe this is an error.</p>`);
    return false;
  }
  if (accessDenied) accessDenied.classList.add('hidden');
  if (mainContent) {
    mainContent.classList.remove('hidden');
    mainContent.style.opacity = '1';
    mainContent.style.pointerEvents = 'auto';
  }
  return true;
}

function showAccessDenied(title, messageHtml) {
  if (mainContent) mainContent.classList.add('hidden');
  if (accessDenied) {
    accessDenied.classList.remove('hidden');
    const content = accessDenied.querySelector('.access-denied-content');
    if (content) {
      content.innerHTML = `<h2>${title}</h2>${messageHtml}<button id="backToDashboard" class="primary" style="margin-top:1rem">← Back to Dashboard</button>`;
    }
  }
  document.getElementById('backToDashboard')?.addEventListener('click', () => {
    window.location.href = 'centers.html';
  });
}

onAuthStateChanged(auth, (user) => {
  const isAuthorized = checkAuthorization(user);
  if (isAuthorized) {
    initApp();
  }
});

function initApp() {
  let employees = {};
  let currentQrData = "";
  let availableCenters = []; 
  let currentTimeclockEmpId = null; // Track which employee's timeclock is open

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('hidden'); el.style.display = 'flex'; }
  }
  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.add('hidden'); el.style.display = 'none'; }
  }

  const searchInput = document.getElementById('searchEmployee');
  const tableBody = document.getElementById('employeeTableBody');
  const form = document.getElementById('employeeForm');
  const natSelect = document.getElementById('empNationality');
  const natOther = document.getElementById('empNationalityOther');
  const saveBtn = document.getElementById('saveEmployee');
  const cancelBtn = document.getElementById('cancelModal');
  const closeBtn = document.getElementById('closeModal');
  const addBtn = document.getElementById('addEmployeeBtn');
  const downloadQrBtn = document.getElementById('downloadQrBtn');
  const timeclockBody = document.getElementById('timeclockHistoryBody');
  const exportBtn = document.getElementById('exportExcelBtn');
  const monthPicker = document.getElementById('exportMonthPicker');
  
  // ✅ DATE FILTER ELEMENTS
  const timeclockDateFilter = document.getElementById('timeclockDateFilter');
  const clearTimeclockFilter = document.getElementById('clearTimeclockFilter');

  document.getElementById('logoutBtn')?.addEventListener('click', logout);

  loadEmployees();
  loadVerifications();
  loadCentersForPermissions();
  setupTabs();

  if (monthPicker) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    monthPicker.value = `${yyyy}-${mm}`;
  }
  exportBtn?.addEventListener('click', exportToExcel);

  natSelect?.addEventListener('change', e => natOther.classList.toggle('visible', e.target.value === 'Others'));
  saveBtn?.addEventListener('click', saveEmployee);
  searchInput?.addEventListener('input', e => renderTable(e.target.value));
  addBtn?.addEventListener('click', () => openEmployeeModal(null));

  // ✅ DATE FILTER EVENT LISTENERS
  timeclockDateFilter?.addEventListener('change', (e) => {
    if (currentTimeclockEmpId) {
      loadTimeclock(currentTimeclockEmpId, e.target.value || null);
    }
  });

  clearTimeclockFilter?.addEventListener('click', (e) => {
    e.preventDefault(); // Prevent any default form submission
    if (timeclockDateFilter) timeclockDateFilter.value = '';
    if (currentTimeclockEmpId) {
      loadTimeclock(currentTimeclockEmpId, null);
    }
  });

  function loadEmployees() {
    onValue(ref(db, 'employees'), (snapshot) => {
      employees = snapshot.val() || {};
      renderTable();
    }, { onlyOnce: false });
  }

  function loadVerifications() {
    onValue(ref(db, 'users'), (snapshot) => {
      const users = snapshot.val() || {};
      const tbody = document.getElementById('verificationsTableBody');
      if (!tbody) return;
      tbody.innerHTML = '';
      const pending = Object.entries(users).filter(([uid, u]) => !u.isVerified);
      if (pending.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No pending verifications.</td></tr>';
        return;
      }
      pending.forEach(([uid, u]) => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${u.email || '-'}</td>
          <td>${u.englishName || '-'}</td>
          <td>${u.position || '-'}</td>
          <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}</td>
          <td class="student-actions">
            <button class="primary" onclick="window.verifyUser('${uid}', true)">✅ Verify</button>
            <button class="danger" onclick="window.verifyUser('${uid}', false)">❌ Reject</button>
          </td>`;
        tbody.appendChild(row);
      });
    });
  }

  async function loadCentersForPermissions() {
    const centerPermsContainer = document.getElementById('centerPermissions');
    if (!centerPermsContainer) return;

    try {
      const centersSnap = await get(ref(db, 'centers'));
      if (centersSnap.exists()) {
        const centers = centersSnap.val();
        availableCenters = Object.entries(centers).map(([id, data]) => ({ id, name: data.name || id }));
        centerPermsContainer.innerHTML = '';

        Object.entries(centers).forEach(([centerId, centerData]) => {
          const label = document.createElement('label');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = centerId;

          label.appendChild(checkbox);
          label.appendChild(document.createTextNode(` ${centerData.name || centerId}`));
          centerPermsContainer.appendChild(label);
        });
      }
    } catch (err) {
      console.error("Error loading centers for permissions:", err);
    }
  }

  window.verifyUser = async (uid, isVerified) => {
    if (!confirm(`Are you sure you want to ${isVerified ? 'verify' : 'reject'} this account?`)) return;
    try {
      if (isVerified) {
        const userSnap = await get(ref(db, `users/${uid}`));
        const userData = userSnap.val();
        if (userData) {
          await update(ref(db, `users/${uid}`), { isVerified: true });
          const empSnap = await get(ref(db, `employees/${uid}`));
          if (!empSnap.exists()) {
            const empData = {
              englishName: userData.englishName || '',
              chineseName: userData.chineseName || '',
              email: userData.email || '',
              nationality: userData.nationality || '',
              position: userData.position || '',
              employmentDate: userData.employmentDate || new Date().toISOString().split('T')[0],
              terms: userData.terms || 'Full-time',
              qrCode: `EMP_${uid.slice(0, 8)}`,
              permissions: { centers: {}, dashboardCards: {} },
              updatedAt: new Date().toISOString()
            };
            await set(ref(db, `employees/${uid}`), empData);
          }
        }
        alert('✅ Account verified successfully and added to the employee list!');
      } else {
        await update(ref(db, `users/${uid}`), { isVerified: false, status: 'rejected' });
        alert('❌ Account rejected.');
      }
    } catch (err) {
      console.error(err);
      alert('Failed to update user status.');
    }
  };

  window.toggleEmpStatus = async (uid, disable) => {
    const emp = employees[uid];
    const name = emp?.englishName || 'this employee';
    const action = disable ? 'disable' : 'enable';
    if (!confirm(`Are you sure you want to ${action} ${name}?`)) return;
    try {
      await update(ref(db, `employees/${uid}`), { isDisabled: disable });
      await update(ref(db, `users/${uid}`), { isDisabled: disable });
      alert(`✅ ${name} has been successfully ${action}d.`);
    } catch (err) {
      console.error('Toggle error:', err);
      alert('❌ Failed to update employee status.');
    }
  };

  function renderTable(filter = '') {
    const lower = filter.toLowerCase();
    const filtered = Object.entries(employees).filter(([_, e]) =>
      e.englishName?.toLowerCase().includes(lower) ||
      (e.chineseName||'').toLowerCase().includes(lower) ||
      e.position?.toLowerCase().includes(lower) ||
      e.email?.toLowerCase().includes(lower)
    );
    tableBody.innerHTML = filtered.length === 0
      ? '<tr><td colspan="6" class="empty-state">No employees found</td></tr>'
      : '';

    filtered.forEach(([id, e]) => {
      const isDisabled = e.isDisabled === true;
      const rowClass = isDisabled ? 'disabled-row' : '';
      const statusBadge = isDisabled
        ? `<span class="status-badge disabled">Disabled</span>`
        : `<span class="status-badge active">Active</span>`;
      const toggleBtnText = isDisabled ? 'Enable' : 'Disable';
      const toggleBtnClass = isDisabled ? 'secondary' : 'danger';

      const row = document.createElement('tr');
      row.className = rowClass;
      row.innerHTML = `
        <td>${e.englishName || ''} ${statusBadge}</td>
        <td>${e.chineseName || '-'}</td>
        <td>${e.email || '-'}</td>
        <td>${e.position || ''}</td>
        <td>${e.terms || ''}</td>
        <td class="student-actions">
          <button class="secondary" onclick="window.editEmp('${id}')">Edit/View</button>
          <button class="${toggleBtnClass}" onclick="window.toggleEmpStatus('${id}', ${!isDisabled})">${toggleBtnText}</button>
        </td>`;
      tableBody.appendChild(row);
    });
  }

  function openEmployeeModal(id) {
    openModal('employeeModal');
    document.getElementById('modalTitle').textContent = id ? 'Edit Employee' : 'Add Employee';

    document.querySelectorAll('#employeeModal .tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#employeeModal .tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('#employeeModal .tab-btn[data-tab="details"]').classList.add('active');
    document.getElementById('tab-details').classList.add('active');

    form.reset();
    natOther.classList.remove('visible');

    if (id && employees[id]) {
      const e = employees[id];
      document.getElementById('empId').value = id;
      document.getElementById('empEnglish').value = e.englishName || '';
      document.getElementById('empChinese').value = e.chineseName || '';
      document.getElementById('empEmail').value = e.email || '';
      document.getElementById('empNationality').value = ['Filipino','Chinese','Portuguese'].includes(e.nationality) ? e.nationality : 'Others';
      if (!['Filipino','Chinese','Portuguese'].includes(e.nationality)) natOther.value = e.nationality || '';
      document.getElementById('empPosition').value = e.position || '';
      document.getElementById('empDate').value = e.employmentDate || new Date().toISOString().split('T')[0];
      document.getElementById('empTerms').value = e.terms || 'Full-time';
      currentQrData = e.qrCode || `EMP_${id}`;
      
      // ✅ Pass the currently selected date filter (if any)
      const selectedDate = timeclockDateFilter?.value || null;
      loadTimeclock(id, selectedDate);

      const perms = e.permissions || {};
      const centerPerms = perms.centers || {};
      const dashPerms = perms.dashboardCards || {};

      setTimeout(() => {
        document.querySelectorAll('#centerPermissions input').forEach(cb => cb.checked = !!centerPerms[cb.value]);
        document.querySelectorAll('#dashboardPermissions input').forEach(cb => cb.checked = !!dashPerms[cb.value]);
      }, 100);

    } else {
      document.getElementById('empId').value = '';
      document.getElementById('empDate').value = new Date().toISOString().split('T')[0];
      currentQrData = `EMP_${crypto.randomUUID().slice(0,8)}`;
      setTimeout(() => {
        document.querySelectorAll('#tab-permissions input').forEach(cb => cb.checked = false);
      }, 100);
    }

    const currentUserEmail = auth.currentUser?.email?.toLowerCase();
    const isAdmin = currentUserEmail === 'kumonchamps@gmail.com';
    const permInputs = document.querySelectorAll('#tab-permissions input');
    const permMsg = document.getElementById('permissionsLockedMsg');

    if (!isAdmin) {
      permInputs.forEach(input => input.disabled = true);
      permMsg.style.display = 'block';
    } else {
      permInputs.forEach(input => input.disabled = false);
      permMsg.style.display = 'none';
    }

    const qrContainer = document.getElementById('qrContainer');
    if (qrContainer) {
      qrContainer.querySelectorAll('canvas, img.qrcode').forEach(el => {
        if (el.id !== 'empQrImg') el.remove();
      });
    }
    generateQR(currentQrData);
  }

  function generateQR(text) {
    const qrImg = document.getElementById('empQrImg');
    if (!qrImg || !text) return;
    qrImg.style.opacity = '0.5';
    qrImg.alt = 'Generating...';
    qrImg.src = '';
    if (typeof window.QRCode === 'undefined') {
      console.error('❌ qrcodejs library not loaded');
      qrImg.alt = 'Library Missing';
      return;
    }
    try {
      const tempDiv = document.createElement('div');
      tempDiv.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;';
      document.body.appendChild(tempDiv);
      new window.QRCode(tempDiv, { text: text, width: 200, height: 200, correctLevel: window.QRCode.CorrectLevel.H });
      setTimeout(() => {
        const generated = tempDiv.querySelector('canvas') || tempDiv.querySelector('img.qrcode');
        if (generated) {
          qrImg.src = generated.tagName === 'CANVAS' ? generated.toDataURL('image/png') : generated.src;
          qrImg.style.opacity = '1';
          qrImg.alt = 'Employee QR Code';
        }
        tempDiv.remove();
      }, 100);
    } catch (e) {
      console.error('QR Generation Error:', e);
      qrImg.alt = 'Generation Failed';
    }
  }

  downloadQrBtn?.addEventListener('click', () => {
    const qrImg = document.getElementById('empQrImg');
    if (!qrImg || !qrImg.src || qrImg.src.includes(window.location.href)) {
      const container = document.getElementById('qrContainer');
      const generated = container?.querySelector('img.qrcode') || container?.querySelector('canvas');
      if (generated) {
        const url = generated.tagName === 'CANVAS' ? generated.toDataURL('image/png') : generated.src;
        const link = document.createElement('a');
        link.download = `qr_${currentQrData}.png`;
        link.href = url;
        link.click();
        return;
      }
      return alert('QR not ready yet.');
    }
    const link = document.createElement('a');
    link.download = `qr_${currentQrData}.png`;
    link.href = qrImg.src;
    link.click();
  });

  async function saveEmployee() {
    const empId = document.getElementById('empId')?.value;
    const englishName = document.getElementById('empEnglish')?.value.trim();
    const chineseName = document.getElementById('empChinese')?.value.trim();
    const email = document.getElementById('empEmail')?.value.trim();
    let nationality = document.getElementById('empNationality')?.value;
    if (nationality === 'Others') nationality = document.getElementById('empNationalityOther')?.value.trim();
    const position = document.getElementById('empPosition')?.value;
    const employmentDate = document.getElementById('empDate')?.value;
    const terms = document.getElementById('empTerms')?.value;

    if (!englishName || !nationality || !position || !employmentDate || !email) {
      return alert('Please fill in all required fields.');
    }

    const centers = {};
    document.querySelectorAll('#centerPermissions input').forEach(cb => { centers[cb.value] = cb.checked; });
    const dashboardCards = {};
    document.querySelectorAll('#dashboardPermissions input').forEach(cb => { dashboardCards[cb.value] = cb.checked; });

    const employeeData = {
      englishName,
      chineseName: chineseName || '',
      email,
      nationality,
      position,
      employmentDate,
      terms,
      qrCode: currentQrData,
      permissions: { centers, dashboardCards },
      updatedAt: new Date().toISOString()
    };

    try {
      const empRef = empId ? ref(db, `employees/${empId}`) : push(ref(db, 'employees'));
      const saveId = empId || empRef.key;
      await set(empRef, employeeData);

      if (empId) {
        const userRef = ref(db, `users/${empId}`);
        const userSnap = await get(userRef);
        if (userSnap.exists()) {
          await update(userRef, {
            permissions: { centers, dashboardCards }
          });
        }
      }

      employees[saveId] = { ...employeeData, id: saveId };
      renderTable(searchInput?.value || '');
      closeModal('employeeModal');
      alert(`✅ Employee ${empId ? 'updated' : 'added'} successfully!`);
    } catch (err) {
      console.error('Save error:', err);
      alert('❌ Failed to save employee. Check console for details.');
    }
  }

  cancelBtn.onclick = closeBtn.onclick = () => closeModal('employeeModal');

  function timeToMinutes(timeStr) {
    if (!timeStr) return null;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return (hours * 60) + minutes;
  }

  // 🌟 NEW HELPER: Convert minutes back to HH:MM
  function minutesToTime(mins) {
    if (mins < 0) mins = 0;
    if (mins > 1439) mins = 1439; // Cap at 23:59
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function formatDuration(minutes) {
    if (minutes === null || minutes < 0) return '-';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} mins`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  // 🌟 NEW CORE LOGIC: Auto-fix missing clock-outs/ins
  function autoFixLogs(logs) {
    if (!logs || logs.length === 0) return { logs, changed: false };
    
    const sorted = [...logs].sort((a, b) => a.time.localeCompare(b.time));
    const fixedLogs = [];
    let changed = false;
    let currentInLog = null; 
    
    for (let i = 0; i < sorted.length; i++) {
      const log = sorted[i];
      
      if (log.type === 'in') {
        // Scenario 1: Missed OUT at previous center, now IN at new center
        if (currentInLog && currentInLog.location !== log.location) {
          const inTimeMins = timeToMinutes(log.time);
          const autoOutMins = Math.max(0, inTimeMins - 1); 
          fixedLogs.push({
            type: 'out', time: minutesToTime(autoOutMins), 
            location: currentInLog.location, autoGenerated: true
          });
          changed = true;
        }
        currentInLog = log;
        fixedLogs.push(log);
      } 
      else if (log.type === 'out') {
        if (currentInLog) {
          if (currentInLog.location === log.location) {
            // Normal pair (IN and OUT at same center)
            currentInLog = null;
            fixedLogs.push(log);
          } 
          else {
            // 🌟 SCENARIO 2: IN at Center A, OUT at Center B
            const inMins = timeToMinutes(currentInLog.time);
            const outMins = timeToMinutes(log.time);
            let totalDuration = outMins - inMins;
            if (totalDuration < 0) totalDuration = 0; 
            
            const halfDuration = Math.floor(totalDuration / 2);
            const autoOutMins = inMins + halfDuration;
            const autoInMins = autoOutMins + 1; 
            
            fixedLogs.push({
              type: 'out', time: minutesToTime(autoOutMins), 
              location: currentInLog.location, autoGenerated: true
            });
            fixedLogs.push({
              type: 'in', time: minutesToTime(autoInMins), 
              location: log.location, autoGenerated: true
            });
            fixedLogs.push(log);
            currentInLog = null;
            changed = true;
          }
        } else {
          // Scenario 3: Missed IN at center, just logged OUT
          const outTimeMins = timeToMinutes(log.time);
          const autoInMins = Math.max(0, outTimeMins - 1);
          fixedLogs.push({
            type: 'in', time: minutesToTime(autoInMins), 
            location: log.location, autoGenerated: true
          });
          fixedLogs.push(log);
          changed = true;
        }
      }
    }
    fixedLogs.sort((a, b) => a.time.localeCompare(b.time));
    return { logs: fixedLogs, changed };
  }

  function getLogsRows(logs) {
    const sortedLogs = [...logs].sort((a, b) => a.time.localeCompare(b.time));
    const rows = [];
    let currentRow = { inTime: '', inIndex: -1, outTime: '', outIndex: -1 };

    for (let i = 0; i < sortedLogs.length; i++) {
      const log = sortedLogs[i];
      if (log.type === 'in') {
        if (currentRow.inTime !== '') {
          rows.push(currentRow);
          currentRow = { inTime: log.time, inIndex: i, outTime: '', outIndex: -1 };
        } else {
          currentRow.inTime = log.time;
          currentRow.inIndex = i;
        }
      } else if (log.type === 'out') {
        if (currentRow.outTime !== '') {
          rows.push(currentRow);
          currentRow = { inTime: '', inIndex: -1, outTime: log.time, outIndex: i };
        } else {
          currentRow.outTime = log.time;
          currentRow.outIndex = i;
        }
      }
    }

    if (currentRow.inTime !== '' || currentRow.outTime !== '') {
      rows.push(currentRow);
    }

    return rows;
  }

  // ✅ UPDATED: Now accepts a filterDate parameter for fast single-day fetching
  function loadTimeclock(empId, filterDate = null) {
    currentTimeclockEmpId = empId; // Remember who we are viewing
    
    let fetchPromise;
    if (filterDate) {
      // Fetch ONLY the specific date for this employee (Much faster!)
      fetchPromise = get(ref(db, `timecards/${filterDate}/${empId}`)).then(snap => {
        const data = snap.val();
        if (data) {
          return { [filterDate]: { [empId]: data } };
        }
        return {};
      });
    } else {
      // Fetch all timecards
      fetchPromise = get(ref(db, 'timecards')).then(snap => snap.val() || {});
    }

    fetchPromise.then(all => {
      timeclockBody.innerHTML = '';
      const records = [];
      let maxCycles = 3;

      Object.entries(all).forEach(([date, dayData]) => {
        if (dayData[empId]?.logs?.length) {
          const rawLogs = dayData[empId].logs;
          const { logs: fixedLogs } = autoFixLogs(rawLogs); // 🌟 AUTO-FIX ON THE FLY
          
          const sortedLogs = [...fixedLogs].sort((a, b) => a.time.localeCompare(b.time));
          const rows = getLogsRows(sortedLogs);

          if (rows.length > maxCycles) {
            maxCycles = rows.length;
          }

          let totalMinutes = 0;
          let hasValidCycle = false;
          let currentIn = null;

          for (const log of sortedLogs) {
            if (log.type === 'in') {
              currentIn = timeToMinutes(log.time);
            } else if (log.type === 'out') {
              if (currentIn !== null) {
                const outMins = timeToMinutes(log.time);
                if (outMins !== null && outMins >= currentIn) {
                  totalMinutes += (outMins - currentIn);
                  hasValidCycle = true;
                }
                currentIn = null;
              }
            }
          }
          const durationText = hasValidCycle ? formatDuration(totalMinutes) : '-';

          records.push({ date, rows, durationText });
        }
      });

      records.sort((a, b) => b.date.localeCompare(a.date));

      if (records.length === 0) {
        timeclockBody.innerHTML = `<tr><td colspan="${maxCycles * 2 + 3}" class="empty-state">No records found</td></tr>`;
        return;
      }

      const table = timeclockBody.parentElement;
      let theadHtml = `<thead id="timeclockThead"><tr><th rowspan="2">Date</th>`;
      for (let i = 0; i < maxCycles; i++) {
        const ordinal = i + 1;
        const suffix = ordinal === 1 ? 'st' : ordinal === 2 ? 'nd' : ordinal === 3 ? 'rd' : 'th';
        theadHtml += `<th colspan="2" style="text-align:center;">${ordinal}${suffix} Time</th>`;
      }
      theadHtml += `<th rowspan="2">Total Hours</th><th rowspan="2">Action</th></tr><tr>`;
      for (let i = 0; i < maxCycles; i++) {
        theadHtml += `<th>In</th><th>Out</th>`;
      }
      theadHtml += `</tr></thead>`;

      const existingThead = table.querySelector('thead');
      if (existingThead) {
        existingThead.outerHTML = theadHtml;
      } else {
        table.insertAdjacentHTML('afterbegin', theadHtml);
      }

      records.forEach(r => {
        const row = document.createElement('tr');
        row.dataset.editing = 'false';
        row.dataset.date = r.date;

        let rowHtml = `<td>${r.date}</td>`;
        for (let i = 0; i < maxCycles; i++) {
          const cycle = r.rows[i] || { inTime: '', inIndex: -1, outTime: '', outIndex: -1 };
          rowHtml += `
            <td><input type="time" value="${cycle.inTime}" disabled class="tc-input" data-idx="${cycle.inIndex}" data-type="in"></td>
            <td><input type="time" value="${cycle.outTime}" disabled class="tc-input" data-idx="${cycle.outIndex}" data-type="out"></td>
          `;
        }
        rowHtml += `
          <td style="font-weight: 600; color: #4682B4; text-align: center;">${r.durationText}</td>
          <td><button class="edit-log-btn secondary" data-date="${r.date}">Edit</button></td>
        `;
        row.innerHTML = rowHtml;
        timeclockBody.appendChild(row);
      });

      document.querySelectorAll('.edit-log-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          const mainRow = btn.closest('tr');
          const isEditing = mainRow.dataset.editing === 'true';
          const date = btn.dataset.date;
          const inputs = mainRow.querySelectorAll('.tc-input');

          if (!isEditing) {
            mainRow.dataset.editing = 'true';
            inputs.forEach(input => {
              input.disabled = false;
              input.style.borderColor = '#4682B4';
            });
            btn.textContent = 'Save';
            btn.classList.remove('secondary');
            btn.classList.add('primary');

            // ✅ Add center dropdown for new entries
            const modalContent = document.querySelector('#employeeModal .modal-content');
            let dropdownContainer = modalContent?.querySelector('.center-selector-container');
            
            if (!dropdownContainer) {
              dropdownContainer = document.createElement('div');
              dropdownContainer.className = 'center-selector-container';
              dropdownContainer.style.cssText = 'margin-top: 1rem; padding: 1rem; background: #f8f9fa; border-radius: 8px; border: 1px solid #e2e8f0;';
              dropdownContainer.innerHTML = `
                <label style="font-size: 0.9rem; font-weight: 600; color: #4682B4; display: block; margin-bottom: 0.5rem;">
                  📍 Center for New Entries:
                </label>
                <select id="newEntryCenter" style="width: 100%; max-width: 400px; padding: 0.6rem; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.9rem; background: white;">
                  <option value="auto">🔍 Auto-detect (from nearby logs)</option>
                  ${availableCenters.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}
                </select>
                <small style="font-size: 0.8rem; color: #666; display: block; margin-top: 0.5rem;">
                  Only applies to newly added time entries
                </small>
              `;
              if (modalContent) {
                modalContent.appendChild(dropdownContainer);
              }
            }

          } else {
            btn.textContent = 'Saving...';
            btn.disabled = true;

            try {
              const daySnap = await get(ref(db, `timecards/${date}/${empId}`));
              let currentLogs = daySnap.val()?.logs || [];
              if (!Array.isArray(currentLogs)) currentLogs = Object.values(currentLogs);

              // 🌟 CRITICAL: Apply autoFixLogs here too so array indices perfectly match the UI!
              const { logs: logsToSaveBase } = autoFixLogs(currentLogs);
              let logsToSave = [...logsToSaveBase];

              const modifications = [];
              inputs.forEach(input => {
                modifications.push({
                  idx: parseInt(input.dataset.idx, 10),
                  type: input.dataset.type,
                  newTime: input.value
                });
              });

              modifications.sort((a, b) => b.idx - a.idx);

              const centerSelect = document.getElementById('newEntryCenter');
              const selectedCenter = centerSelect?.value || 'auto';

              modifications.forEach(mod => {
                if (mod.idx !== -1) {
                  if (mod.newTime) {
                    logsToSave[mod.idx].time = mod.newTime;
                  } else {
                    logsToSave.splice(mod.idx, 1);
                  }
                } else {
                  if (mod.newTime) {
                    let matchedLocation = 'Manual Edit';

                    if (selectedCenter !== 'auto') {
                      matchedLocation = selectedCenter;
                    } else {
                      const newTimeMins = timeToMinutes(mod.newTime);
                      let closestLog = null;
                      let minTimeDiff = Infinity;

                      currentLogs.forEach(existingLog => {
                        const existingTimeMins = timeToMinutes(existingLog.time);
                        const timeDiff = Math.abs(existingTimeMins - newTimeMins);

                        if (timeDiff < 120 && timeDiff < minTimeDiff) {
                          minTimeDiff = timeDiff;
                          closestLog = existingLog;
                        }
                      });

                      if (closestLog && closestLog.location && closestLog.location !== 'Manual Edit') {
                        matchedLocation = closestLog.location;
                      }
                    }

                    logsToSave.push({
                      type: mod.type,
                      time: mod.newTime,
                      location: matchedLocation
                    });
                  }
                }
              });

              logsToSave.sort((a, b) => a.time.localeCompare(b.time));

              await update(ref(db, `timecards/${date}/${empId}`), { logs: logsToSave });

              mainRow.dataset.editing = 'false';
              inputs.forEach(input => {
                input.disabled = true;
                input.style.borderColor = '#cbd5e1';
              });

              const dropdown = document.querySelector('#employeeModal .modal-content .center-selector-container');
              if (dropdown) dropdown.remove();

              btn.textContent = 'Edit';
              btn.classList.remove('primary');
              btn.classList.add('secondary');
              btn.disabled = false;

              // ✅ Reload with the currently selected date filter
              const selectedDate = timeclockDateFilter?.value || null;
              loadTimeclock(empId, selectedDate);

            } catch (err) {
              console.error("Error saving timeclock:", err);
              alert("Failed to save. Check console.");
              btn.textContent = 'Save';
              btn.disabled = false;
            }
          }
        });
      });

    }).catch(err => {
      console.error("Error loading timeclock:", err);
      timeclockBody.innerHTML = '<tr><td colspan="9" class="empty-state">Error loading records</td></tr>';
    });
  }

  // ==========================================
  // ✅ EXCEL EXPORT FEATURE
  // ==========================================
  async function exportToExcel() {
    if (typeof XLSX === 'undefined') {
      return alert('❌ Excel library not loaded. Please check your internet connection or script tags.');
    }

    const selectedMonth = monthPicker?.value;
    if (!selectedMonth) return alert('⚠️ Please select a month to export.');

    const [year, month] = selectedMonth.split('-');

    const originalText = exportBtn.textContent;
    exportBtn.textContent = 'Exporting...';
    exportBtn.disabled = true;

    try {
      const timecardsSnap = await get(ref(db, 'timecards'));
      const timecards = timecardsSnap.val() || {};
      const employeesSnap = await get(ref(db, 'employees'));
      const employeesData = employeesSnap.val() || {};

      const empData = {};

      Object.entries(timecards).forEach(([date, dayData]) => {
        if (!date.startsWith(selectedMonth)) return;

        Object.entries(dayData).forEach(([empId, empDayData]) => {
          if (!empData[empId]) {
            const emp = employeesData[empId] || {};
            empData[empId] = {
              name: emp.englishName || 'Unknown',
              position: emp.position || 'Unknown',
              totalMinutes: 0,
              centers: {}
            };
          }

          const rawLogs = empDayData.logs || [];
          const { logs } = autoFixLogs(rawLogs); // 🌟 AUTO-FIX FOR EXCEL EXPORT
          const centerLogs = {};

          logs.forEach(log => {
            const abbr = getCenterAbbr(log.location);
            if (abbr === 'Unknown') return;
            if (!centerLogs[abbr]) centerLogs[abbr] = [];
            centerLogs[abbr].push(log);
          });

          Object.entries(centerLogs).forEach(([abbr, cLogs]) => {
            if (!empData[empId].centers[abbr]) {
              empData[empId].centers[abbr] = { minutes: 0, records: [] };
            }

            cLogs.sort((a, b) => a.time.localeCompare(b.time));

            const rows = getLogsRows(cLogs);

            let dayTotalMinutes = 0;
            const cycles = [];

            rows.forEach(row => {
              if (row.inTime && row.outTime) {
                const inMins = timeToMinutes(row.inTime);
                const outMins = timeToMinutes(row.outTime);
                if (inMins !== null && outMins !== null && outMins >= inMins) {
                  const diff = outMins - inMins;
                  dayTotalMinutes += diff;
                  cycles.push({ in: row.inTime, out: row.outTime });
                }
              } else if (row.inTime && !row.outTime) {
                cycles.push({ in: row.inTime, out: '' });
              } else if (!row.inTime && row.outTime) {
                cycles.push({ in: '', out: row.outTime });
              }
            });

            empData[empId].centers[abbr].minutes += dayTotalMinutes;
            empData[empId].totalMinutes += dayTotalMinutes;

            if (cycles.length > 0) {
              empData[empId].centers[abbr].records.push({ date, cycles });
            }
          });
        });
      });

      if (Object.keys(empData).length === 0) {
        alert('⚠️ No records found for the selected month.');
        exportBtn.textContent = originalText;
        exportBtn.disabled = false;
        return;
      }

      const wb = XLSX.utils.book_new();

      const summaryData = [['Name', 'Position', 'Total Hours', 'C', 'PT', 'MK', 'TS']];
      Object.values(empData).forEach(emp => {
        summaryData.push([
          emp.name,
          emp.position,
          formatExcelTime(emp.totalMinutes),
          formatExcelTime(emp.centers['C']?.minutes || 0),
          formatExcelTime(emp.centers['PT']?.minutes || 0),
          formatExcelTime(emp.centers['MK']?.minutes || 0),
          formatExcelTime(emp.centers['TS']?.minutes || 0)
        ]);
      });
      const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

      Object.entries(empData).forEach(([empId, emp]) => {
        Object.entries(emp.centers).forEach(([abbr, centerData]) => {
          if (centerData.records.length === 0) return;

          let maxCycles = 0;
          centerData.records.forEach(rec => {
            if (rec.cycles.length > maxCycles) maxCycles = rec.cycles.length;
          });

          const headers = ['Date'];
          for (let i = 1; i <= maxCycles; i++) {
            headers.push(`In${i}`, `Out${i}`);
          }
          headers.push('Overall Total');

          const sheetData = [headers];
          centerData.records.forEach(rec => {
            const row = [rec.date];
            let dayMins = 0;

            for (let i = 0; i < maxCycles; i++) {
              const cycle = rec.cycles[i];
              if (cycle) {
                row.push(cycle.in || '', cycle.out || '');
                if (cycle.in && cycle.out) {
                  const inM = timeToMinutes(cycle.in);
                  const outM = timeToMinutes(cycle.out);
                  if (inM !== null && outM !== null && outM >= inM) {
                    dayMins += (outM - inM);
                  }
                }
              } else {
                row.push('', '');
              }
            }
            row.push(formatExcelTime(dayMins));
            sheetData.push(row);
          });

          const sheet = XLSX.utils.aoa_to_sheet(sheetData);
          const tabName = `${abbr}_${emp.name}`.substring(0, 31);
          XLSX.utils.book_append_sheet(wb, sheet, tabName);
        });
      });

      XLSX.writeFile(wb, `Kumon_Timeclock_Records_${month}-${year}.xlsx`);
      alert('✅ Export successful!');

    } catch (err) {
      console.error('Export error:', err);
      alert('❌ Failed to export. Check console for details.');
    } finally {
      exportBtn.textContent = originalText;
      exportBtn.disabled = false;
    }
  }

  function getCenterAbbr(location) {
    if (!location) return 'Unknown';
    const loc = location.toLowerCase();
    if (loc.includes('mei keng')) return 'MK';
    if (loc.includes('pac tat')) return 'PT';
    if (loc.includes('tap siac')) return 'TS';
    if (loc.includes('champs')) return 'C';
    if (loc.includes('taipa')) return 'TS';
    return 'Unknown';
  }

  function formatExcelTime(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}:${String(m).padStart(2, '0')}:00`;
  }

  function setupTabs() {
    document.querySelectorAll('[data-main-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-main-tab]').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('[id^="main-tab-"]').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`main-tab-${btn.dataset.mainTab}`)?.classList.add('active');
      });
    });
    document.querySelectorAll('#employeeModal .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#employeeModal .tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('#employeeModal .tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');
      });
    });
  }

  // 🔄 MIGRATION: Updates existing database records
  async function fixExistingTimecards() {
    if (!confirm("This will scan all timecards and auto-fix missing clock-outs/ins in the database. This may take a moment. Continue?")) return;
    
    try {
      const snap = await get(ref(db, 'timecards'));
      const timecards = snap.val() || {};
      let updates = {};
      let fixedCount = 0;

      for (const [date, dayData] of Object.entries(timecards)) {
        for (const [empId, empData] of Object.entries(dayData)) {
          const rawLogs = empData.logs || [];
          const { logs: fixedLogs, changed } = autoFixLogs(rawLogs);
          
          if (changed) {
            updates[`timecards/${date}/${empId}/logs`] = fixedLogs;
            fixedCount++;
          }
        }
      }

      if (fixedCount === 0) {
        alert('✅ All records are already accurate! No changes needed.');
      } else {
        await update(ref(db), updates);
        alert(`✅ Successfully updated ${fixedCount} employee-day records in the database!`);
      }
    } catch (err) {
      console.error('Fix error:', err);
      alert('❌ Failed to fix records. Check console for details.');
    }
  }
  window.fixExistingTimecards = fixExistingTimecards;

  window.editEmp = (id) => openEmployeeModal(id);
}