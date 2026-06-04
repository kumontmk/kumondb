import { db, logout, requireAuth } from './auth.js';
import { ref, set, get, update, onValue, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

if (!requireAuth()) throw new Error("Auth required");

let employees = {};
let currentQrData = "";
let managerAuthGranted = false;
let managerQrScanner = null;
let managerScannerActive = false;

// 🔧 ROBUST MODAL TOGGLE
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
const pinFallback = document.getElementById('pinAuthFallback');
const managerScannerWrapper = document.getElementById('managerScannerWrapper');
const managerScanStatus = document.getElementById('managerScanStatus');
const startManagerScanBtn = document.getElementById('startManagerScanBtn');
const mainContent = document.getElementById('mainContent');
const managerAuthModal = document.getElementById('managerAuthModal');
const authHint = document.getElementById('authHint');
const managerManualQrInput = document.getElementById('managerManualQrInput');
const managerManualQrBtn = document.getElementById('managerManualQrBtn');

document.getElementById('logoutBtn').addEventListener('click', logout);

window.addEventListener('DOMContentLoaded', async () => {
  loadEmployees();
  setupTabs();
  natSelect.addEventListener('change', e => natOther.classList.toggle('visible', e.target.value === 'Others'));
  
  if (managerAuthModal) {
    managerAuthModal.style.display = 'flex';
    managerAuthModal.classList.remove('hidden');
  }
  await setupManagerAuth();

  saveBtn.addEventListener('click', saveEmployee);
});

// 🔐 MANAGER AUTH SETUP
async function setupManagerAuth() {
  try {
    const snap = await get(ref(db, 'employees'));
    const data = snap.val() || {};
    const managers = Object.values(data).filter(e => e.position === 'Manager');
    
    if (managers.length === 0) {
      if (pinFallback) { pinFallback.style.display = 'block'; pinFallback.classList.remove('hidden'); }
      if (managerScannerWrapper) managerScannerWrapper.style.display = 'none';
      if (authHint) authHint.textContent = "No managers configured. Use default PIN (1111).";
    } else {
      if (pinFallback) pinFallback.style.display = 'none';
      if (managerScannerWrapper) { managerScannerWrapper.style.display = 'block'; managerScannerWrapper.classList.remove('hidden'); }
      if (authHint) authHint.textContent = "Scan or type a manager QR code to proceed";
    }
  } catch (err) {
    console.error("Auth setup error:", err);
    if (authHint) authHint.textContent = "⚠️ DB Error. Using PIN fallback.";
    if (pinFallback) pinFallback.style.display = 'block';
    if (managerScannerWrapper) managerScannerWrapper.style.display = 'none';
  }
}

document.getElementById('verifyInitialPinBtn').addEventListener('click', () => {
  const pin = document.getElementById('initialPinInput')?.value || '';
  if (pin === '1111') {
    grantManagerAccess();
    alert('Access granted. Please add a Manager profile to secure future access.');
  } else {
    alert('Invalid PIN. Use 1111 for initial setup.');
  }
});

// ✅ NEW: Manual QR Verification for Managers
async function handleManagerManualQr() {
  const qrValue = managerManualQrInput.value.trim();
  if (!qrValue) {
    managerScanStatus.innerHTML = '<span style="color:#dc3545">❌ Please enter a QR code.</span>';
    return;
  }
  
  managerScanStatus.textContent = '🔍 Verifying...';
  const emp = Object.values(employees).find(e => (e.qrCode || '').trim() === qrValue);
  
  if (emp && emp.position === 'Manager') {
    managerScanStatus.innerHTML = '<span style="color:#28a745">✅ Manager Verified</span>';
    managerManualQrInput.value = '';
    setTimeout(() => grantManagerAccess(), 500);
  } else {
    managerScanStatus.innerHTML = '<span style="color:#dc3545">❌ Invalid or non-Manager QR</span>';
    setTimeout(() => { managerScanStatus.textContent = "Position/Type Manager QR"; }, 1500);
  }
}

managerManualQrBtn.addEventListener('click', handleManagerManualQr);
managerManualQrInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleManagerManualQr();
});

async function cleanupManagerScanner() {
  if (managerQrScanner) { try { await managerQrScanner.stop(); } catch(e) {} managerQrScanner = null; }
  const readerDiv = document.getElementById('managerReader');
  if (readerDiv) readerDiv.innerHTML = '';
  managerScannerActive = false;
}

startManagerScanBtn.addEventListener('click', async () => {
  if (managerScannerActive) { await cleanupManagerScanner(); return; }
  if (typeof Html5Qrcode === 'undefined') {
    managerScanStatus.innerHTML = '<span style="color:#dc3545">❌ Scanner library not loaded</span>';
    return;
  }
  await cleanupManagerScanner();
  managerScanStatus.textContent = '📷 Initializing camera...';
  
  try {
    managerQrScanner = new Html5Qrcode("managerReader");
    await managerQrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
      async (decodedText) => {
        await cleanupManagerScanner();
        managerScanStatus.textContent = '🔍 Verifying...';
        const scannedQR = decodedText.trim();
        const emp = Object.values(employees).find(e => (e.qrCode || '').trim() === scannedQR);

        if (emp && emp.position === 'Manager') {
          managerScanStatus.innerHTML = '<span style="color:#28a745">✅ Manager Verified</span>';
          setTimeout(() => grantManagerAccess(), 500);
        } else {
          managerScanStatus.innerHTML = '<span style="color:#dc3545">❌ Not a valid Manager QR</span>';
          setTimeout(() => managerScanStatus.textContent = "Position manager QR in frame", 1500);
        }
      },
      () => {}
    );
    managerScanStatus.textContent = '✅ Camera ready. Point at QR...';
    managerScannerActive = true;
    startManagerScanBtn.textContent = '⏹ Stop Scanner';
  } catch (err) {
    console.error('Scanner init failed:', err);
    managerScanStatus.innerHTML = `<span style="color:#dc3545">❌ Camera: ${err.message}</span>`;
  }
});

function grantManagerAccess() {
  managerAuthGranted = true;
  closeModal('managerAuthModal');
  mainContent.style.opacity = '1';
  mainContent.style.pointerEvents = 'auto';
}

function loadEmployees() {
  onValue(ref(db, 'employees'), (snapshot) => {
    employees = snapshot.val() || {};
    renderTable();
  }, { onlyOnce: false });
}

function renderTable(filter = '') {
  const lower = filter.toLowerCase();
  const filtered = Object.entries(employees).filter(([_, e]) =>
    e.englishName.toLowerCase().includes(lower) ||
    (e.chineseName||'').toLowerCase().includes(lower) ||
    e.position.toLowerCase().includes(lower)
  );
  
  tableBody.innerHTML = filtered.length === 0 ? '<tr><td colspan="5" class="empty-state">No employees found</td></tr>' : '';
  
  filtered.forEach(([id, e]) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${e.englishName}</td>
      <td>${e.chineseName || '-'}</td>
      <td>${e.position}</td>
      <td>${e.terms}</td>
      <td class="student-actions">
        <button class="secondary" onclick="window.editEmp('${id}')">Edit/View</button>
      </td>`;
    tableBody.appendChild(row);
  });
}

searchInput.addEventListener('input', e => renderTable(e.target.value));
addBtn.addEventListener('click', () => openEmployeeModal(null));
window.editEmp = (id) => openEmployeeModal(id);

function openEmployeeModal(id) {
  openModal('employeeModal');
  document.getElementById('modalTitle').textContent = id ? 'Edit Employee' : 'Add Employee';
  saveBtn.textContent = id ? 'Update Employee' : 'Save Employee';
  form.reset();
  natOther.classList.remove('visible');
  
  if (id) {
    const e = employees[id];
    document.getElementById('empId').value = id;
    document.getElementById('empEnglish').value = e.englishName;
    document.getElementById('empChinese').value = e.chineseName || '';
    document.getElementById('empNationality').value = ['Filipino','Chinese','Portuguese'].includes(e.nationality) ? e.nationality : 'Others';
    if (!['Filipino','Chinese','Portuguese'].includes(e.nationality)) natOther.value = e.nationality;
    document.getElementById('empPosition').value = e.position;
    document.getElementById('empDate').value = e.employmentDate;
    document.getElementById('empTerms').value = e.terms;
    currentQrData = e.qrCode || `EMP_${id}`;
    loadTimeclock(id);
  } else {
    document.getElementById('empId').value = '';
    document.getElementById('empDate').value = new Date().toISOString().split('T')[0];
    currentQrData = `EMP_${crypto.randomUUID().slice(0,8)}`;
  }
  
  const qrContainer = document.getElementById('qrContainer');
  if (qrContainer) {
    qrContainer.querySelectorAll('canvas, img.qrcode').forEach(el => {
      if (el.id !== 'empQrImg') el.remove();
    });
  }
  generateQR(currentQrData);
}

// ✅ QR GENERATION
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

// ✅ DOWNLOAD BUTTON
downloadQrBtn.addEventListener('click', () => {
  const qrImg = document.getElementById('empQrImg');
  if (!qrImg || !qrImg.src || qrImg.src.includes(window.location.href)) {
    const container = document.getElementById('qrContainer');
    const generated = container.querySelector('img.qrcode') || container.querySelector('canvas');
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

// ✅ SAVE EMPLOYEE
async function saveEmployee() {
  const empId = document.getElementById('empId').value;
  const englishName = document.getElementById('empEnglish').value.trim();
  const chineseName = document.getElementById('empChinese').value.trim();
  let nationality = document.getElementById('empNationality').value;
  if (nationality === 'Others') nationality = document.getElementById('empNationalityOther').value.trim();
  const position = document.getElementById('empPosition').value;
  const employmentDate = document.getElementById('empDate').value;
  const terms = document.getElementById('empTerms').value;
  
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
    renderTable(searchInput.value);
    closeModal('employeeModal');
    alert(`✅ Employee ${empId ? 'updated' : 'added'} successfully!`);
  } catch (err) {
    console.error('Save error:', err);
    alert('❌ Failed to save employee. Check console for details.');
  }
}

cancelBtn.onclick = closeBtn.onclick = () => closeModal('employeeModal');

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

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}