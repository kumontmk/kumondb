import { db, logout, requireAuth, firebaseConfig } from './auth.js';
import { ref, set, get, update, onValue, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth as getSecondaryAuth, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// 🆕 SECONDARY APP FOR BACKGROUND USER CREATION
const secondaryApp = initializeApp(firebaseConfig, 'SecondaryApp');
const secondaryAuth = getSecondaryAuth(secondaryApp);

const AUTHORIZED_EMAIL = "kumonchamps@gmail.com";
const auth = getAuth();
const mainContent = document.getElementById('mainContent');
const accessDenied = document.getElementById('accessDenied');

// 🆕 Helper to handle both new (array) and old (string) position data
function getEmpPositions(emp) {
  if (Array.isArray(emp.positions)) return emp.positions;
  if (emp.position) return [emp.position];
  return [];
}

async function checkAuthorization(user) {
  if (!user) {
    showAccessDenied('🔐 Please log in first', 'No user session found.');
    return false;
  }
  const actualEmail = user.email?.toLowerCase() || '';
  const requiredEmail = AUTHORIZED_EMAIL.toLowerCase();

  if (actualEmail === requiredEmail) {
    grantAccess();
    return true;
  }

  try {
    const userSnap = await get(ref(db, `users/${user.uid}`));
    const userData = userSnap.val();
    if (userData) {
      // 🆕 Check if user has 'manager' or 'master admin' in their positions array
      const userPositions = getEmpPositions(userData).map(p => p.trim().toLowerCase());
      if (userPositions.includes('manager') || userPositions.includes('master admin')) {
        grantAccess();
        return true;
      }
    }

    const empSnap = await get(ref(db, 'employees'));
    const empData = empSnap.val();
    if (empData) {
      const matchingEmp = Object.values(empData).find(e => e.email?.toLowerCase() === user.email?.toLowerCase());
      if (matchingEmp) {
        // 🆕 Check if employee has 'manager' or 'master admin' in their positions array
        const empPositions = getEmpPositions(matchingEmp).map(p => p.trim().toLowerCase());
        if (empPositions.includes('manager') || empPositions.includes('master admin')) {
          grantAccess();
          return true;
        }
      }
    }
  } catch (err) {
    console.error('❌ Error checking user role:', err);
  }

  showAccessDenied('🔐 Access Restricted', `<p><strong>${user.email || 'Not available'} is not authorized to access this page.</strong></p>`);
  return false;
}

function grantAccess() {
  if (accessDenied) accessDenied.classList.add('hidden');
  if (mainContent) {
    mainContent.classList.remove('hidden');
    mainContent.style.opacity = '1';
    mainContent.style.pointerEvents = 'auto';
  }
}

function showAccessDenied(title, messageHtml) {
  if (mainContent) mainContent.classList.add('hidden');
  if (accessDenied) {
    accessDenied.classList.remove('hidden');
    const content = accessDenied.querySelector('.access-denied-content');
    if (content) {
      content.innerHTML = `<h2>${title}</h2>${messageHtml}<button id="backToDashboard" class="primary" style="margin-top:1rem">← Back to Centers</button>`;
    }
  }
  document.getElementById('backToDashboard')?.addEventListener('click', () => {
    window.location.href = 'centers.html';
  });
}

onAuthStateChanged(auth, async (user) => {
  const isAuthorized = await checkAuthorization(user);
  if (isAuthorized) {
    initApp();
  }
});

function initApp() {
  let employees = {};
  let currentQrData = "";
  let availableCenters = [];
  let currentTimeclockEmpId = null;
  let initialLoadDone = false; 

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
  const timeclockDateFilter = document.getElementById('timeclockDateFilter');
  const clearTimeclockFilter = document.getElementById('clearTimeclockFilter');

  document.getElementById('logoutBtn')?.addEventListener('click', logout);

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

  timeclockDateFilter?.addEventListener('change', (e) => {
    if (currentTimeclockEmpId) loadTimeclock(currentTimeclockEmpId, e.target.value || null);
  });
  clearTimeclockFilter?.addEventListener('click', (e) => {
    e.preventDefault();
    if (timeclockDateFilter) timeclockDateFilter.value = '';
    if (currentTimeclockEmpId) loadTimeclock(currentTimeclockEmpId, null);
  });

  window.resetPassword = async (email) => {
    if (!confirm(`Send a password reset email to ${email}?`)) return;
    try {
      await sendPasswordResetEmail(auth, email);
      alert('✅ Password reset email sent successfully!');
    } catch (err) {
      alert('❌ Failed to send reset email: ' + err.message);
    }
  };

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
              positions: userData.positions || (userData.position ? [userData.position] : []),
              position: userData.position || (userData.positions ? userData.positions[0] : ''),
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

  async function seedMasterAdmin() {
    const empSnap = await get(ref(db, 'employees'));
    const empData = empSnap.val() || {};
    const hasMaster = Object.values(empData).some(e => e.email?.toLowerCase() === 'kumonchamps@gmail.com');
    if (!hasMaster) {
      const usersSnap = await get(ref(db, 'users'));
      const usersData = usersSnap.val() || {};
      let masterUid = Object.keys(usersData).find(uid => usersData[uid].email?.toLowerCase() === 'kumonchamps@gmail.com');
      if (masterUid) {
        await set(ref(db, `employees/${masterUid}`), {
          englishName: 'Kumon Master Admin',
          email: 'kumonchamps@gmail.com',
          positions: ['Master Admin'],
          position: 'Master Admin',
          terms: 'Full-time',
          employmentDate: new Date().toISOString().split('T')[0],
          isVerified: true,
          mustChangePassword: false,
          permissions: { centers: {}, dashboardCards: {} }
        });
      }
    }
  }

  function loadEmployees() {
    onValue(ref(db, 'employees'), (snapshot) => {
      employees = snapshot.val() || {};
      renderTable();
      if (!initialLoadDone) {
        initialLoadDone = true;
        updateIncompleteBadge();
      }
    }, { onlyOnce: false });
  }

function loadVerifications() {
  onValue(ref(db, 'users'), (snapshot) => {
    const users = snapshot.val() || {};
    const tbody = document.getElementById('verificationsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    const pending = Object.entries(users).filter(([uid, u]) => !u.isVerified);
    
    const vBadge = document.getElementById('verificationsBadge');
    if (vBadge) {
      if (pending.length > 0) {
        vBadge.textContent = pending.length > 99 ? '99+' : pending.length;
        vBadge.classList.remove('hidden'); // ✅ FIX: Toggle class instead of style.display
      } else {
        vBadge.classList.add('hidden');
      }
    }
    
    if (pending.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No pending verifications.</td></tr>';
      return;
    }
    
    pending.forEach(([uid, u]) => {
      const row = document.createElement('tr');
      const userPositions = getEmpPositions(u).join(', ') || '-';
      row.innerHTML = `
        <td>${u.email || '-'}</td>
        <td>${u.englishName || '-'}</td>
        <td>${userPositions}</td>
        <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}</td>
        <td class="student-actions">
          <button class="primary" onclick="window.verifyUser('${uid}', true)">✅ Verify</button>
          <button class="danger" onclick="window.verifyUser('${uid}', false)">❌ Reject</button>
        </td>
      `;
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

  loadEmployees();
  loadVerifications();
  loadCentersForPermissions();
  setupTabs();
  seedMasterAdmin();

  function renderTable(filter = '') {
    const lower = filter.toLowerCase();
    const filtered = Object.entries(employees).filter(([_, e]) => {
      const positionsStr = getEmpPositions(e).join(' ').toLowerCase();
      return e.englishName?.toLowerCase().includes(lower) ||
        (e.chineseName || '').toLowerCase().includes(lower) ||
        positionsStr.includes(lower) ||
        e.email?.toLowerCase().includes(lower);
    });
    
    tableBody.innerHTML = filtered.length === 0
      ? '<tr><td colspan="7" class="empty-state">No employees found</td></tr>'
      : '';
      
    filtered.forEach(([id, e]) => {
      const isDisabled = e.isDisabled === true;
      const rowClass = isDisabled ? 'disabled-row' : '';
      const statusBadge = isDisabled
        ? `<span class="status-badge disabled">Disabled</span>`
        : `<span class="status-badge active">Active</span>`;
      const toggleBtnText = isDisabled ? 'Enable' : 'Disable';
      const toggleBtnClass = isDisabled ? 'secondary' : 'danger';
      const positionsText = getEmpPositions(e).join(', ') || '-'; 
      
      const row = document.createElement('tr');
      row.className = rowClass;
      row.innerHTML = `
        <td>${e.englishName || ''} ${statusBadge}</td>
        <td>${e.chineseName || '-'}</td>
        <td>${e.email || '-'}</td>
        <td>${positionsText}</td>
        <td>${e.terms || ''}</td>
        <td class="student-actions">
          <button class="secondary" onclick="window.editEmp('${id}')">Edit</button>
          <button class="secondary" onclick="window.resetPassword('${e.email}')" title="Send Password Reset Email" style="background:#f8f9fa;color:#4682B4;border:1px solid #cbd5e1;">🔑 Reset</button>
          <button class="${toggleBtnClass}" onclick="window.toggleEmpStatus('${id}', ${!isDisabled})">${toggleBtnText}</button>
        </td>`;
      tableBody.appendChild(row);
    });
  }

  async function openEmployeeModal(id) {
    openModal('employeeModal');
    document.getElementById('modalTitle').textContent = id ? 'Edit Employee' : 'Add Employee';
    document.querySelectorAll('#employeeModal .tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#employeeModal .tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('#employeeModal .tab-btn[data-tab="details"]').classList.add('active');
    document.getElementById('tab-details').classList.add('active');
    form.reset();
    natOther.classList.remove('visible');

    const pwField = document.getElementById('passwordFieldContainer');
    if (pwField) {
      pwField.style.display = id ? 'none' : 'block';
      if (!id) document.getElementById('empPassword').value = 'Kumon123';
    }

    if (id && employees[id]) {
      const e = employees[id];
      document.getElementById('empId').value = id;
      document.getElementById('empEnglish').value = e.englishName || '';
      document.getElementById('empChinese').value = e.chineseName || '';
      document.getElementById('empEmail').value = e.email || '';
      document.getElementById('empNationality').value = ['Filipino', 'Chinese', 'Portuguese'].includes(e.nationality) ? e.nationality : 'Others';
      if (!['Filipino', 'Chinese', 'Portuguese'].includes(e.nationality)) natOther.value = e.nationality || '';
      
      // 🆕 Check positions
      document.querySelectorAll('#empPositionsGroup input').forEach(cb => cb.checked = false);
      const empPositions = getEmpPositions(e);
      empPositions.forEach(pos => {
        const cb = document.querySelector(`#empPositionsGroup input[value="${pos}"]`);
        if (cb) cb.checked = true;
      });

      document.getElementById('empDate').value = e.employmentDate || new Date().toISOString().split('T')[0];
      document.getElementById('empTerms').value = e.terms || 'Full-time';
      currentQrData = e.qrCode || `EMP_${id}`;
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
      currentQrData = `EMP_${crypto.randomUUID().slice(0, 8)}`;
      document.querySelectorAll('#empPositionsGroup input').forEach(cb => cb.checked = false);
      setTimeout(() => {
        document.querySelectorAll('#tab-permissions input').forEach(cb => cb.checked = false);
      }, 100);
    }

    const currentUserEmail = auth.currentUser?.email?.toLowerCase();
    let isAdmin = currentUserEmail === 'kumonchamps@gmail.com';
    if (!isAdmin && auth.currentUser) {
      try {
        const userSnap = await get(ref(db, `users/${auth.currentUser.uid}`));
        const userData = userSnap.val();
        if (userData) {
          const userPositions = getEmpPositions(userData).map(p => p.trim().toLowerCase());
          if (userPositions.includes('manager') || userPositions.includes('master admin')) isAdmin = true;
        }
        if (!isAdmin) {
          const empSnap = await get(ref(db, 'employees'));
          const empData = empSnap.val();
          if (empData) {
            const matchingEmp = Object.values(empData).find(e => e.email?.toLowerCase() === currentUserEmail);
            if (matchingEmp) {
              const empPositions = getEmpPositions(matchingEmp).map(p => p.trim().toLowerCase());
              if (empPositions.includes('manager') || empPositions.includes('master admin')) isAdmin = true;
            }
          }
        }
      } catch (err) { console.error('Error checking admin status:', err); }
    }

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
    if (typeof window.QRCode === 'undefined') return;
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
    } catch (e) { console.error('QR Generation Error:', e); }
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
    
    // 🆕 Read checked positions
    const positions = [];
    document.querySelectorAll('#empPositionsGroup input:checked').forEach(cb => positions.push(cb.value));
    if (positions.length === 0) {
      return alert('Please select at least one position.');
    }
    const position = positions[0]; // For backward compatibility

    const employmentDate = document.getElementById('empDate')?.value;
    const terms = document.getElementById('empTerms')?.value;
    const initialPassword = document.getElementById('empPassword')?.value || 'Kumon123';

    if (!englishName || !nationality || positions.length === 0 || !employmentDate || !email) {
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
      positions: positions,
      position: position,
      employmentDate,
      terms,
      qrCode: currentQrData,
      permissions: { centers, dashboardCards },
      updatedAt: new Date().toISOString()
    };

    try {
      let saveId = empId;

      if (!empId) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Creating Account...';
        try {
          const userCred = await createUserWithEmailAndPassword(secondaryAuth, email, initialPassword);
          const newUid = userCred.user.uid;
          await signOut(secondaryAuth); 

          await set(ref(db, `users/${newUid}`), {
            email,
            englishName,
            chineseName,
            nationality,
            positions: positions,
            position: position,
            employmentDate,
            terms,
            isVerified: true,
            mustChangePassword: true,
            permissions: { centers, dashboardCards },
            createdAt: new Date().toISOString()
          });

          saveId = newUid; 
          employeeData.authUid = newUid;
        } catch (authErr) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Employee';
          if (authErr.code === 'auth/email-already-in-use') {
            return alert('❌ This email is already registered in the system.');
          }
          throw authErr;
        }
      }

      const empRef = ref(db, `employees/${saveId}`);
      await set(empRef, employeeData);

      if (empId) {
        const usersSnap = await get(ref(db, 'users'));
        const usersData = usersSnap.val();
        if (usersData) {
          if (usersData[empId]) {
            await update(ref(db, `users/${empId}`), {
              permissions: { centers, dashboardCards },
              positions: positions,
              position: position
            });
            console.log(`✅ Synced permissions to users/${empId} (Direct Match)`);
          } else {
            const matchingUserUid = Object.keys(usersData).find(uid => usersData[uid].email?.toLowerCase() === employeeData.email.toLowerCase());
            if (matchingUserUid) {
              await update(ref(db, `users/${matchingUserUid}`), {
                permissions: { centers, dashboardCards },
                positions: positions,
                position: position
              });
              console.log(`✅ Synced permissions to users/${matchingUserUid} (Email Match)`);
            } else {
              console.warn('⚠️ Could not find matching user in users node to sync permissions!');
            }
          }
        }
      }

      employees[saveId] = { ...employeeData, id: saveId };
      renderTable(searchInput?.value || '');
      closeModal('employeeModal');
      alert(`✅ Employee ${empId ? 'updated' : 'added'} successfully!${!empId ? '\n\nThey can now log in with the default password. They will be prompted to change it on first login.' : ''}`);
    } catch (err) {
      console.error('Save error:', err);
      alert('❌ Failed to save employee: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Employee';
    }
  }

  cancelBtn.onclick = closeBtn.onclick = () => closeModal('employeeModal');

  // ==========================================
  // ALL ORIGINAL FUNCTIONS RESTORED BELOW
  // ==========================================

  function timeToMinutes(timeStr) {
    if (!timeStr) return null;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return (hours * 60) + minutes;
  }

  function minutesToTime(mins) {
    if (mins < 0) mins = 0;
    if (mins > 1439) mins = 1439;
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

  function autoFixLogs(logs, terms = 'Full-time') {
    if (!logs || logs.length === 0) return { logs, changed: false };
    const sorted = [...logs].sort((a, b) => a.time.localeCompare(b.time));
    const fixedLogs = [];
    let changed = false;
    let currentInLog = null;
    for (let i = 0; i < sorted.length; i++) {
      const log = sorted[i];
      if (log.type === 'in') {
        if (currentInLog && currentInLog.location !== log.location) {
          if (terms === 'Full-time') {
            const inTimeMins = timeToMinutes(log.time);
            const autoOutMins = Math.max(0, inTimeMins - 1);
            fixedLogs.push({
              type: 'out', time: minutesToTime(autoOutMins),
              location: currentInLog.location, autoGenerated: true
            });
            changed = true;
          }
        }
        currentInLog = log;
        fixedLogs.push(log);
      } else if (log.type === 'out') {
        if (currentInLog) {
          currentInLog = null;
          fixedLogs.push(log);
        } else {
          fixedLogs.push(log);
        }
      }
    }
    fixedLogs.sort((a, b) => a.time.localeCompare(b.time));
    return { logs: fixedLogs, changed };
  }

  function getLogsRows(logs) {
    const sortedLogs = [...logs].sort((a, b) => a.time.localeCompare(b.time));
    const rows = [];
    let currentRow = { inTime: '', inIndex: -1, outTime: '', outIndex: -1, inLocation: '' };
    for (let i = 0; i < sortedLogs.length; i++) {
      const log = sortedLogs[i];
      if (log.type === 'in') {
        if (currentRow.inTime !== '') {
          rows.push(currentRow);
          currentRow = { inTime: log.time, inIndex: i, outTime: '', outIndex: -1, inLocation: log.location };
        } else {
          currentRow.inTime = log.time;
          currentRow.inIndex = i;
          currentRow.inLocation = log.location;
        }
      } else if (log.type === 'out') {
        if (currentRow.outTime !== '') {
          rows.push(currentRow);
          currentRow = { inTime: '', inIndex: -1, outTime: log.time, outIndex: i, inLocation: '' };
        } else if (currentRow.inTime !== '' && currentRow.inLocation !== log.location) {
          rows.push(currentRow);
          currentRow = { inTime: '', inIndex: -1, outTime: log.time, outIndex: i, inLocation: '' };
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

  function loadTimeclock(empId, filterDate = null) {
    currentTimeclockEmpId = empId;
    let fetchPromise;
    if (filterDate) {
      fetchPromise = get(ref(db, `timecards/${filterDate}/${empId}`)).then(snap => {
        const data = snap.val();
        if (data) {
          return { [filterDate]: { [empId]: data } };
        }
        return {};
      });
    } else {
      fetchPromise = get(ref(db, 'timecards')).then(snap => snap.val() || {});
    }
    fetchPromise.then(all => {
      timeclockBody.innerHTML = '';
      const records = [];
      let maxCycles = 3;
      Object.entries(all).forEach(([date, dayData]) => {
        if (dayData[empId]?.logs?.length) {
          const rawLogs = dayData[empId].logs;
          const { logs: fixedLogs } = autoFixLogs(rawLogs, employees[empId]?.terms || 'Full-time');
          const sortedLogs = [...fixedLogs].sort((a, b) => a.time.localeCompare(b.time));
          const rows = getLogsRows(sortedLogs);
          if (rows.length > maxCycles) {
            maxCycles = rows.length;
          }
          let totalMinutes = 0;
          let hasValidCycle = false;
          let currentIn = null;
          let currentInLocation = null;
          for (const log of sortedLogs) {
            if (log.type === 'in') {
              currentIn = timeToMinutes(log.time);
              currentInLocation = log.location;
            } else if (log.type === 'out') {
              if (currentIn !== null && currentInLocation === log.location) {
                const outMins = timeToMinutes(log.time);
                if (outMins !== null && outMins >= currentIn) {
                  totalMinutes += (outMins - currentIn);
                  hasValidCycle = true;
                }
                currentIn = null;
                currentInLocation = null;
              } else {
                currentIn = null;
                currentInLocation = null;
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
              const { logs: logsToSaveBase } = autoFixLogs(currentLogs, employees[empId]?.terms || 'Full-time');
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
              position: getEmpPositions(emp).join(', ') || 'Unknown',
              totalMinutes: 0,
              centers: {}
            };
          }
          const rawLogs = empDayData.logs || [];
          const { logs } = autoFixLogs(rawLogs, employeesData[empId]?.terms || 'Full-time');
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
        if (btn.dataset.mainTab === 'incomplete') {
          loadIncompleteTimecards();
        }
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

async function updateIncompleteBadge() {
  if (Object.keys(employees).length === 0) return;
  try {
    const [timecardsSnap, verificationsSnap] = await Promise.all([
      get(ref(db, 'timecards')),
      get(ref(db, 'timecardVerifications'))
    ]);
    
    const timecards = timecardsSnap.val() || {};
    const verifications = verificationsSnap.val() || {};
    
    let count = 0;
    
    // 1. Count real-time incomplete records
    Object.entries(timecards).forEach(([date, dayData]) => {
      Object.entries(dayData).forEach(([empId, empData]) => {
        const emp = employees[empId];
        if (!emp) return;
        const rawLogs = empData.logs || [];
        const { logs: fixedLogs } = autoFixLogs(rawLogs, emp.terms || 'Full-time');
        const sortedLogs = [...fixedLogs].sort((a, b) => a.time.localeCompare(b.time));
        let currentIn = null;
        for (const log of sortedLogs) {
          if (log.type === 'in') {
            if (currentIn !== null) count++;
            currentIn = log;
          } else if (log.type === 'out') {
            if (currentIn !== null && currentIn.location === log.location) {
              currentIn = null;
            } else {
              if (currentIn !== null) count++;
              count++;
              currentIn = null;
            }
          }
        }
        if (currentIn !== null) count++;
      });
    });
    
    // 2. Add pending verifications to the count
    const pendingCount = Object.values(verifications).filter(v => v.status === 'pending').length;
    count += pendingCount;
    
    // 3. Update the badge UI
    const badge = document.getElementById('incompleteBadge');
    if (badge) {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.classList.remove('hidden'); // ✅ FIX: Toggle class instead of style.display
      } else {
        badge.classList.add('hidden');
      }
    }
  } catch (err) {
    console.error('Error updating incomplete badge:', err);
  }
}


// ✅ UPDATED: Integrates real-time incomplete records with verification requests
async function loadIncompleteTimecards() {
  const tbody = document.getElementById('incompleteTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="empty-state">⏳ Loading...</td></tr>';
  
  try {
    const [timecardsSnap, verificationsSnap] = await Promise.all([
      get(ref(db, 'timecards')),
      get(ref(db, 'timecardVerifications'))
    ]);
    
    const timecards = timecardsSnap.val() || {};
    const verifications = verificationsSnap.val() || {};
    
    const incompleteRecords = [];
    Object.entries(timecards).forEach(([date, dayData]) => {
      Object.entries(dayData).forEach(([empId, empData]) => {
        const emp = employees[empId];
        if (!emp) return;
        const rawLogs = empData.logs || [];
        const { logs: fixedLogs } = autoFixLogs(rawLogs, emp.terms || 'Full-time');
        const sortedLogs = [...fixedLogs].sort((a, b) => a.time.localeCompare(b.time));
        let currentIn = null;
        for (let i = 0; i < sortedLogs.length; i++) {
          const log = sortedLogs[i];
          if (log.type === 'in') {
            if (currentIn !== null) {
              incompleteRecords.push({ empId, date, name: emp.englishName || '', chineseName: emp.chineseName || '', position: getEmpPositions(emp).join(', ') || '', terms: emp.terms || 'Full-time', center: currentIn.location || '', type: 'IN', time: currentIn.time, missingType: 'out' });
            }
            currentIn = log;
          } else if (log.type === 'out') {
            if (currentIn !== null && currentIn.location === log.location) {
              currentIn = null;
            } else {
              if (currentIn !== null) {
                incompleteRecords.push({ empId, date, name: emp.englishName || '', chineseName: emp.chineseName || '', position: getEmpPositions(emp).join(', ') || '', terms: emp.terms || 'Full-time', center: currentIn.location || '', type: 'IN', time: currentIn.time, missingType: 'out' });
              }
              incompleteRecords.push({ empId, date, name: emp.englishName || '', chineseName: emp.chineseName || '', position: getEmpPositions(emp).join(', ') || '', terms: emp.terms || 'Full-time', center: log.location || '', type: 'OUT', time: log.time, missingType: 'in' });
              currentIn = null;
            }
          }
        }
        if (currentIn !== null) {
          incompleteRecords.push({ empId, date, name: emp.englishName || '', chineseName: emp.chineseName || '', position: getEmpPositions(emp).join(', ') || '', terms: emp.terms || 'Full-time', center: currentIn.location || '', type: 'IN', time: currentIn.time, missingType: 'out' });
        }
      });
    });
    
    const verificationList = Object.entries(verifications).map(([id, v]) => ({ id, ...v }));
    const verificationKeys = new Set(verificationList.filter(v => v.status !== 'confirmed').map(v => `${v.empId}_${v.date}_${v.inTime}`));
    
    const filteredIncomplete = incompleteRecords.filter(rec => 
      !verificationKeys.has(`${rec.empId}_${rec.date}_${rec.time}`)
    );
    
    const allRecords = [
      ...filteredIncomplete.map(r => ({ ...r, isVerification: false, status: 'Incomplete' })),
      ...verificationList.map(v => ({ ...v, isVerification: true, status: v.status }))
    ];
    
    allRecords.sort((a, b) => {
      const statusOrder = { 'Pending': 0, 'Denied': 1, 'Incomplete': 2, 'Confirmed': 3 };
      const orderDiff = (statusOrder[a.status] || 99) - (statusOrder[b.status] || 99);
      if (orderDiff !== 0) return orderDiff;
      return b.date.localeCompare(a.date) || (a.name || a.empName || '').localeCompare(b.name || b.empName || '');
    });
    
    tbody.innerHTML = '';
    if (allRecords.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">🎉 No incomplete timecards or pending verifications!</td></tr>';
      return;
    }
    
    allRecords.forEach(rec => {
      const tr = document.createElement('tr');
      tr.dataset.empId = rec.empId;
      tr.dataset.date = rec.date;
      tr.dataset.missingType = rec.missingType;
      tr.dataset.center = rec.center;
      tr.dataset.time = rec.time || rec.inTime;
      
      const name = rec.name || rec.empName || 'Unknown';
      const chineseName = rec.chineseName || '';
      const position = rec.position || '-';
      const terms = rec.terms || '-';
      const date = rec.date;
      const center = rec.center || '-';
      
      let statusBadge = '';
      let timeCell = '';
      let actionCell = '';
      
      if (rec.isVerification) {
        const inTime = rec.inTime || rec.proposedInTime || '-';
        const outTime = rec.outTime || rec.proposedOutTime || rec.actualOutTime || '-';
        const isMissingOut = rec.missingType === 'out';
        
        if (rec.status === 'pending') {
          statusBadge = '<span class="status-badge" style="background:#fef3c7;color:#92400e;">Pending</span>';
          timeCell = isMissingOut ? `IN: <strong>${inTime}</strong><br>Proposed OUT: <strong>${outTime}</strong>` : `Proposed IN: <strong>${inTime}</strong><br>OUT: <strong>${outTime}</strong>`;
          actionCell = `
            <button class="primary verify-btn" data-id="${rec.id}" data-action="confirm" style="padding:0.4rem 0.8rem;font-size:0.85rem;margin-right:0.25rem;">✅ Confirm</button>
            <button class="danger verify-btn" data-id="${rec.id}" data-action="deny" style="padding:0.4rem 0.8rem;font-size:0.85rem;">❌ Deny</button>
          `;
        } else if (rec.status === 'denied') {
          statusBadge = '<span class="status-badge" style="background:#fee2e2;color:#991b1b;">Denied</span>';
          const inputVal = isMissingOut ? (rec.actualOutTime || '') : (rec.actualInTime || '');
          timeCell = isMissingOut
            ? `IN: <strong>${inTime}</strong><br>Manual OUT: <input type="time" class="manual-time-input" value="${inputVal}" style="width:110px;padding:0.4rem;border:1px solid #cbd5e1;border-radius:4px;">`
            : `Manual IN: <input type="time" class="manual-time-input" value="${inputVal}" style="width:110px;padding:0.4rem;border:1px solid #cbd5e1;border-radius:4px;"><br>OUT: <strong>${outTime}</strong>`;
          actionCell = `<button class="primary save-manual-btn" data-id="${rec.id}" style="padding:0.4rem 0.8rem;font-size:0.85rem;">Save</button>`;
        } else if (rec.status === 'confirmed') {
          statusBadge = '<span class="status-badge" style="background:#d1fae5;color:#065f46;">Confirmed</span>';
          timeCell = `IN: <strong>${inTime}</strong><br>OUT: <strong>${outTime}</strong>`;
          actionCell = '<span style="color:#059669;font-weight:600;">Resolved</span>';
          tr.style.opacity = '0.6';
        }
      } else {
        const typeLabel = rec.type === 'IN' ? '<span class="status-badge" style="background:#dbeafe;color:#1e40af;">IN only</span>' : '<span class="status-badge" style="background:#fef3c7;color:#92400e;">OUT only</span>';
        statusBadge = '<span class="status-badge" style="background:#e2e8f0;color:#475569;">Incomplete</span>';
        timeCell = `${typeLabel} <small style="color:#666;">missing ${rec.missingType.toUpperCase()}</small><br><strong>${rec.time}</strong>`;
        actionCell = `
          <input type="time" class="incomplete-time-input" style="width:110px;padding:0.4rem;border:1px solid #cbd5e1;border-radius:4px;">
          <button class="primary save-incomplete-btn" style="padding:0.4rem 0.8rem;font-size:0.85rem;margin-left:0.25rem;">Save</button>
        `;
      }
      
      tr.innerHTML = `
        <td>${name} ${chineseName ? '(' + chineseName + ')' : ''}</td>
        <td>${position}</td>
        <td>${terms}</td>
        <td>${date}</td>
        <td>${center}</td>
        <td>${timeCell}</td>
        <td>${statusBadge}</td>
        <td>${actionCell}</td>
      `;
      tbody.appendChild(tr);
    });
    
    // Attach listeners for regular incomplete saves
    tbody.querySelectorAll('.save-incomplete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const input = tr.querySelector('.incomplete-time-input');
        const newTime = input.value.trim();
        if (!newTime) { alert('⚠️ Please enter the missing time.'); input.focus(); return; }
        
        const empId = tr.dataset.empId;
        const date = tr.dataset.date;
        const missingType = tr.dataset.missingType;
        const center = tr.dataset.center;
        
        btn.disabled = true; btn.textContent = 'Saving...';
        try {
          const daySnap = await get(ref(db, `timecards/${date}/${empId}`));
          let currentLogs = daySnap.val()?.logs || [];
          if (!Array.isArray(currentLogs)) currentLogs = Object.values(currentLogs);
          currentLogs.push({ type: missingType, time: newTime, location: center || 'Manual Fix' });
          currentLogs.sort((a, b) => a.time.localeCompare(b.time));
          await update(ref(db, `timecards/${date}/${empId}`), { logs: currentLogs });
          btn.textContent = '✅ Saved'; btn.classList.remove('primary'); btn.style.background = '#059669';
          input.disabled = true;
          setTimeout(() => { tr.style.opacity = '0.4'; tr.style.textDecoration = 'line-through'; }, 500);
          updateIncompleteBadge();
        } catch (err) {
          console.error(err); alert('❌ Failed to save.'); btn.disabled = false; btn.textContent = 'Save';
        }
      });
    });
    
  } catch (err) {
    console.error('Error loading incomplete timecards:', err);
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">❌ Error loading records</td></tr>';
  }
}

// ✅ NEW: Event delegation for verification buttons (Add this inside initApp() after loadIncompleteTimecards is defined)
document.getElementById('incompleteTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  
  if (btn.classList.contains('verify-btn')) {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    
    if (action === 'confirm') {
      if (!confirm('Confirm this proposed time?')) return;
      try {
        await update(ref(db, `timecardVerifications/${id}`), {
          status: 'confirmed', resolvedBy: auth.currentUser.uid, resolvedAt: new Date().toISOString()
        });
        const vSnap = await get(ref(db, `timecardVerifications/${id}`));
        const v = vSnap.val();
        const daySnap = await get(ref(db, `timecards/${v.date}/${v.empId}`));
        let logs = daySnap.val()?.logs || [];
        if (!Array.isArray(logs)) logs = Object.values(logs);
        logs.push({ type: 'out', time: v.proposedOutTime, location: v.center || 'Manual Fix' });
        logs.sort((a, b) => a.time.localeCompare(b.time));
        await update(ref(db, `timecards/${v.date}/${v.empId}`), { logs });
        loadIncompleteTimecards();
      } catch (err) { console.error(err); alert('Failed to confirm.'); }
    } else if (action === 'deny') {
      if (!confirm('Deny this proposed time? You will be able to enter the correct time manually.')) return;
      try {
        await update(ref(db, `timecardVerifications/${id}`), {
          status: 'denied', resolvedBy: auth.currentUser.uid, resolvedAt: new Date().toISOString()
        });
        loadIncompleteTimecards();
      } catch (err) { console.error(err); alert('Failed to deny.'); }
    }
  }
  
  if (btn.classList.contains('save-manual-btn')) {
    const id = btn.dataset.id;
    const tr = btn.closest('tr');
    const input = tr.querySelector('.manual-time-input');
    const newTime = input.value.trim();
    if (!newTime) { alert('Please enter the correct time.'); return; }
    
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      const vSnap = await get(ref(db, `timecardVerifications/${id}`));
      const v = vSnap.val();
      const daySnap = await get(ref(db, `timecards/${v.date}/${v.empId}`));
      let logs = daySnap.val()?.logs || [];
      if (!Array.isArray(logs)) logs = Object.values(logs);
      logs.push({ type: 'out', time: newTime, location: v.center || 'Manual Fix' });
      logs.sort((a, b) => a.time.localeCompare(b.time));
      await update(ref(db, `timecards/${v.date}/${v.empId}`), { logs });
      await update(ref(db, `timecardVerifications/${id}`), {
        status: 'confirmed', actualOutTime: newTime, resolvedBy: auth.currentUser.uid, resolvedAt: new Date().toISOString()
      });
      loadIncompleteTimecards();
    } catch (err) {
      console.error(err); alert('Failed to save.'); btn.disabled = false; btn.textContent = 'Save';
    }
  }
});

  window.editEmp = (id) => openEmployeeModal(id);
}