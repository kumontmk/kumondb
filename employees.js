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

  document.getElementById('logoutBtn')?.addEventListener('click', logout);

  loadEmployees();
  loadVerifications(); 
  loadCentersForPermissions(); // ✅ Dynamically load ALL centers into the permissions tab
  setupTabs();
  
  natSelect?.addEventListener('change', e => natOther.classList.toggle('visible', e.target.value === 'Others'));
  saveBtn?.addEventListener('click', saveEmployee);
  searchInput?.addEventListener('input', e => renderTable(e.target.value));
  addBtn?.addEventListener('click', () => openEmployeeModal(null));

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

  // ✅ NEW: Fetch all centers from DB and generate checkboxes dynamically
  async function loadCentersForPermissions() {
    const centerPermsContainer = document.getElementById('centerPermissions');
    if (!centerPermsContainer) return;
    
    try {
      const centersSnap = await get(ref(db, 'centers'));
      if (centersSnap.exists()) {
        const centers = centersSnap.val();
        centerPermsContainer.innerHTML = ''; // Clear any hardcoded centers
        
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
              permissions: { centers: {}, dashboardCards: {} }, // ✅ Removed centerAdminCards
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
      loadTimeclock(id);

      // ✅ LOAD PERMISSIONS
      const perms = e.permissions || {};
      const centerPerms = perms.centers || {};
      const dashPerms = perms.dashboardCards || {};
      
      // Wait a brief moment to ensure dynamic checkboxes are rendered before checking them
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

    // ✅ ENFORCE ADMIN-ONLY PERMISSIONS EDITING
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

  // ✅ UPDATED: Syncs permissions to BOTH employees and users nodes
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

    // Gather permissions
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
      permissions: { centers, dashboardCards }, // ✅ Removed centerAdminCards
      updatedAt: new Date().toISOString()
    };

    try {
      const empRef = empId ? ref(db, `employees/${empId}`) : push(ref(db, 'employees'));
      const saveId = empId || empRef.key;
      await set(empRef, employeeData);
      
      // ✅ CRITICAL FIX: Also save permissions to the 'users' node so centers.js can read them!
      if (empId) {
        const userRef = ref(db, `users/${empId}`);
        const userSnap = await get(userRef);
        if (userSnap.exists()) {
          await update(userRef, {
            permissions: { centers, dashboardCards } // ✅ Removed centerAdminCards
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

  function formatDuration(minutes) {
    if (minutes === null || minutes < 0) return '-';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} mins`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  function loadTimeclock(empId) {
    get(ref(db, 'timecards')).then(snap => {
      const all = snap.val() || {};
      timeclockBody.innerHTML = '';
      const records = [];
      Object.entries(all).forEach(([date, dayData]) => {
        if (dayData[empId]?.logs?.length) {
          const logs = dayData[empId].logs;
          const sortedLogs = [...logs].sort((a, b) => a.time.localeCompare(b.time));
          const inLogs = sortedLogs.filter(l => l.type === 'in');
          const outLogs = sortedLogs.filter(l => l.type === 'out');
          const firstIn = inLogs.length > 0 ? inLogs[0].time : '';
          const lastOut = outLogs.length > 0 ? outLogs[outLogs.length - 1].time : '';
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
          let durationText = hasValidCycle ? formatDuration(totalMinutes) : '-';
          records.push({ date, firstIn, lastOut, durationText });
        }
      });
      records.sort((a, b) => b.date.localeCompare(a.date));
      if (records.length === 0) {
        timeclockBody.innerHTML = '<tr><td colspan="5" class="empty-state">No records found</td></tr>';
        return;
      }
      records.forEach(r => {
        const row = document.createElement('tr');
        row.innerHTML = `
           <td>${r.date}</td>
           <td><input type="time" value="${r.firstIn}"></td>
           <td><input type="time" value="${r.lastOut}"></td>
           <td style="font-weight: 600; color: #4682B4; text-align: center;">${r.durationText}</td>
           <td><button class="save-log-btn" data-date="${r.date}">💾 Save</button></td>`;
        timeclockBody.appendChild(row);
      });
      document.querySelectorAll('.save-log-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const date = btn.dataset.date;
          const inputs = btn.closest('tr').querySelectorAll('input[type="time"]');
          const newIn = inputs[0].value;
          const newOut = inputs[1].value;
          try {
            const daySnap = await get(ref(db, `timecards/${date}/${empId}`));
            let currentLogs = daySnap.val()?.logs || [];
            if (!Array.isArray(currentLogs)) currentLogs = Object.values(currentLogs);
            if (currentLogs.length === 0) {
              if (newIn) currentLogs.push({ type: 'in', time: newIn, location: 'Manual' });
              if (newOut) currentLogs.push({ type: 'out', time: newOut, location: 'Manual' });
            } else {
              let earliestInIdx = -1, latestOutIdx = -1, earliestInTime = '99:99', latestOutTime = '00:00';
              for (let i = 0; i < currentLogs.length; i++) {
                if (currentLogs[i].type === 'in' && currentLogs[i].time < earliestInTime) {
                  earliestInTime = currentLogs[i].time; earliestInIdx = i;
                }
                if (currentLogs[i].type === 'out' && currentLogs[i].time > latestOutTime) {
                  latestOutTime = currentLogs[i].time; latestOutIdx = i;
                }
              }
              if (earliestInIdx !== -1 && newIn) currentLogs[earliestInIdx].time = newIn;
              if (latestOutIdx !== -1 && newOut) currentLogs[latestOutIdx].time = newOut;
            }
            await update(ref(db, `timecards/${date}/${empId}`), { logs: currentLogs });
            btn.textContent = '✅ Saved';
            setTimeout(() => { btn.textContent = '💾 Save'; loadTimeclock(empId); }, 1500);
          } catch (err) {
            console.error("Error saving timeclock: ", err);
            alert("Failed to save. Check console.");
          }
        });
      });
    }).catch(err => {
      console.error("Error loading timeclock: ", err);
      timeclockBody.innerHTML = '<tr><td colspan="5" class="empty-state">Error loading records</td></tr>';
    });
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

  window.editEmp = (id) => openEmployeeModal(id);
}