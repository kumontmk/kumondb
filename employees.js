import { db, logout, requireAuth } from './auth.js';
import { ref, set, get, update, onValue, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// 🔐 EMAIL-BASED AUTHORIZATION
const AUTHORIZED_EMAIL = "kumonchamps@gmail.com";

// Get Firebase Auth instance
const auth = getAuth();

// DOM REFERENCES (cache early)
const mainContent = document.getElementById('mainContent');
const accessDenied = document.getElementById('accessDenied');
const backToDashboardBtn = document.getElementById('backToDashboard');

// 🔐 Check authorization AFTER auth state is ready
function checkAuthorization(user) {
  console.log('🔐 Auth Check:', {
    email: user?.email,
    uid: user?.uid,
    isVerified: user?.emailVerified,
    required: AUTHORIZED_EMAIL
  });

  if (!user) {
    showAccessDenied('🔐 Please log in first', 'No user session found.');
    return false;
  }

  const actualEmail = user.email?.toLowerCase() || '';
  const requiredEmail = AUTHORIZED_EMAIL.toLowerCase();

  if (actualEmail !== requiredEmail) {
    showAccessDenied('🔐 Access Restricted', `
      <p><strong>${user.email || 'Not available'} is not authorized to access this page.</strong></p>
      <p style="margin-top:1rem;color:#666;font-size:0.9rem">
        Please log in with an authorized account or contact your administrator if you believe this is an error.
      </p>
    `);
    return false;
  }

  // ✅ Authorized - show main content
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
      content.innerHTML = `
        <h2>${title}</h2>
        ${messageHtml}
        <button id="backToDashboard" class="primary" style="margin-top:1rem">← Back to Dashboard</button>
      `;
    }
  }
  // Re-attach click handler to new button
  document.getElementById('backToDashboard')?.addEventListener('click', () => {
    window.location.href = 'dashboard.html';
  });
}

// ✅ Wait for auth state, then check authorization
onAuthStateChanged(auth, (user) => {
  const isAuthorized = checkAuthorization(user);
  
  if (isAuthorized) {
    // Only initialize app if authorized
    initApp();
  }
});

// ✅ App initialization (only runs if authorized)
function initApp() {
  let employees = {};
  let currentQrData = "";

  // 🔧 MODAL HELPERS
  function openModal(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('hidden'); el.style.display = 'flex'; }
  }
  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.add('hidden'); el.style.display = 'none'; }
  }

  // DOM REFERENCES
  const searchInput = document.getElementById('searchEmployee');
  const tableBody = document.getElementById('employeeTableBody');
  const employeeModal = document.getElementById('employeeModal');
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

  // Initialize UI
  loadEmployees();
  setupTabs();
  natSelect?.addEventListener('change', e => natOther.classList.toggle('visible', e.target.value === 'Others'));
  saveBtn?.addEventListener('click', saveEmployee);

  // 🔍 SEARCH & FILTER
  searchInput?.addEventListener('input', e => renderTable(e.target.value));
  addBtn?.addEventListener('click', () => openEmployeeModal(null));

  // ✅ LOAD EMPLOYEES FROM FIREBASE
  function loadEmployees() {
    onValue(ref(db, 'employees'), (snapshot) => {
      employees = snapshot.val() || {};
      renderTable();
    }, { onlyOnce: false });
  }

  // ✅ RENDER TABLE
  function renderTable(filter = '') {
    const lower = filter.toLowerCase();
    const filtered = Object.entries(employees).filter(([_, e]) =>
      e.englishName?.toLowerCase().includes(lower) ||
      (e.chineseName||'').toLowerCase().includes(lower) ||
      e.position?.toLowerCase().includes(lower)
    );
    
    tableBody.innerHTML = filtered.length === 0 
      ? '<tr><td colspan="5" class="empty-state">No employees found</td></tr>' 
      : '';
    
    filtered.forEach(([id, e]) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${e.englishName || ''}</td>
        <td>${e.chineseName || '-'}</td>
        <td>${e.position || ''}</td>
        <td>${e.terms || ''}</td>
        <td class="student-actions">
          <button class="secondary" onclick="window.editEmp('${id}')">Edit/View</button>
        </td>`;
      tableBody.appendChild(row);
    });
  }

  // ✅ OPEN EMPLOYEE MODAL
  function openEmployeeModal(id) {
    openModal('employeeModal');
    document.getElementById('modalTitle').textContent = id ? 'Edit Employee' : 'Add Employee';
    saveBtn.textContent = id ? 'Update Employee' : 'Save Employee';
    form.reset();
    natOther.classList.remove('visible');
    
    if (id && employees[id]) {
      const e = employees[id];
      document.getElementById('empId').value = id;
      document.getElementById('empEnglish').value = e.englishName || '';
      document.getElementById('empChinese').value = e.chineseName || '';
      document.getElementById('empNationality').value = ['Filipino','Chinese','Portuguese'].includes(e.nationality) ? e.nationality : 'Others';
      if (!['Filipino','Chinese','Portuguese'].includes(e.nationality)) natOther.value = e.nationality || '';
      document.getElementById('empPosition').value = e.position || '';
      document.getElementById('empDate').value = e.employmentDate || new Date().toISOString().split('T')[0];
      document.getElementById('empTerms').value = e.terms || 'Full-time';
      currentQrData = e.qrCode || `EMP_${id}`;
      loadTimeclock(id);
    } else {
      document.getElementById('empId').value = '';
      document.getElementById('empDate').value = new Date().toISOString().split('T')[0];
      currentQrData = `EMP_${crypto.randomUUID().slice(0,8)}`;
    }
    
    // Clear old QR before generating new
    const qrContainer = document.getElementById('qrContainer');
    if (qrContainer) {
      qrContainer.querySelectorAll('canvas, img.qrcode').forEach(el => {
        if (el.id !== 'empQrImg') el.remove();
      });
    }
    generateQR(currentQrData);
  }

  // ✅ QR CODE GENERATION
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

      new window.QRCode(tempDiv, {
        text: text,
        width: 200,
        height: 200,
        correctLevel: window.QRCode.CorrectLevel.H
      });

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

  // ✅ DOWNLOAD QR BUTTON
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

  // ✅ SAVE EMPLOYEE TO FIREBASE
  async function saveEmployee() {
    const empId = document.getElementById('empId')?.value;
    const englishName = document.getElementById('empEnglish')?.value.trim();
    const chineseName = document.getElementById('empChinese')?.value.trim();
    let nationality = document.getElementById('empNationality')?.value;
    if (nationality === 'Others') nationality = document.getElementById('empNationalityOther')?.value.trim();
    const position = document.getElementById('empPosition')?.value;
    const employmentDate = document.getElementById('empDate')?.value;
    const terms = document.getElementById('empTerms')?.value;
    
    if (!englishName || !nationality || !position || !employmentDate) {
      return alert('Please fill in all required fields.');
    }
    
    const employeeData = {
      englishName,
      chineseName: chineseName || '',
      nationality,
      position,
      employmentDate,
      terms,
      qrCode: currentQrData,
      updatedAt: new Date().toISOString()
    };
    
    try {
      const empRef = empId ? ref(db, `employees/${empId}`) : push(ref(db, 'employees'));
      const saveId = empId || empRef.key;
      await set(empRef, employeeData);

      employees[saveId] = { ...employeeData, id: saveId };
      renderTable(searchInput?.value || '');
      closeModal('employeeModal');
      alert(`✅ Employee ${empId ? 'updated' : 'added'} successfully!`);
    } catch (err) {
      console.error('Save error:', err);
      alert('❌ Failed to save employee. Check console for details.');
    }
  }

  // ✅ MODAL CLOSE HANDLERS
  cancelBtn.onclick = closeBtn.onclick = () => closeModal('employeeModal');

  // ✅ LOAD TIMECLOCK HISTORY
  function loadTimeclock(empId) {
    get(ref(db, 'timecards')).then(snap => {
      const all = snap.val() || {};
      timeclockBody.innerHTML = '';
      const records = [];
      
      Object.entries(all).forEach(([date, dayData]) => {
        if (dayData[empId]?.logs?.length) records.push({ date, logs: dayData[empId].logs });
      });
      
      records.sort((a, b) => b.date.localeCompare(a.date));
      
      if (records.length === 0) {
        timeclockBody.innerHTML = '<tr><td colspan="4" class="empty-state">No records found</td></tr>';
        return;
      }
      
      records.forEach(r => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${r.date}</td>
          <td><input type="time" value="${r.logs[0]?.time || ''}"></td>
          <td><input type="time" value="${r.logs[1]?.time || ''}"></td>
          <td><button class="save-log-btn" data-date="${r.date}">💾 Save</button></td>`;
        timeclockBody.appendChild(row);
      });
      
      document.querySelectorAll('.save-log-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const date = btn.dataset.date;
          const inputs = btn.closest('tr').querySelectorAll('input[type="time"]');
          await update(ref(db, `timecards/${date}/${empId}`), {
            logs: [
              { type: 'in', time: inputs[0].value || '', location: 'Manual' },
              { type: 'out', time: inputs[1].value || '', location: 'Manual' }
            ]
          });
          btn.textContent = '✅ Saved';
          setTimeout(() => btn.textContent = '💾 Save', 1500);
        });
      });
    });
  }

  // ✅ TABS SETUP
  function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');
      });
    });
  }

  // ✅ GLOBAL EDIT FUNCTION FOR INLINE ONCLICK
  window.editEmp = (id) => openEmployeeModal(id);
}