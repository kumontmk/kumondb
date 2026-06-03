import { db, logout, requireAuth } from './auth.js';
import { ref, get, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// 🔒 Auth Guard
if (!requireAuth()) throw new Error("Auth required");
document.getElementById('logoutBtn').addEventListener('click', logout);

// 📍 Location Configuration
const CENTERS = [
  { name: "Kumon Taipa Mei Keng", lat: 22.15680419404832, lng: 113.55310261763758 },
  { name: "Kumon Taipa Pac Tat", lat: 22.15864298997591, lng: 113.54896029627456 },
  { name: "Kumon Champs", lat: 22.202188413699155, lng: 113.54954818278166 },
  { name: "Kumon Tap Siac", lat: 22.19974168219132, lng: 113.54570239996973 }
];
const MAX_DIST_KM = 0.2; // ✅ Strict 200m radius

// 🧠 State
let employees = {};
let html5QrCode = null;
let isScanning = false;
let lastScannedCode = '';
let lastScanTimestamp = 0;
const SCAN_COOLDOWN_MS = 3000; // Prevent rapid double-scans

// 🖥️ DOM References
const datePicker = document.getElementById('datePicker');
const searchInput = document.getElementById('searchInput');
const posFilter = document.getElementById('positionFilter');
const startScanBtn = document.getElementById('startScanBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const scanModal = document.getElementById('scanModal');

//  Initialization
window.addEventListener('DOMContentLoaded', () => {
  datePicker.value = new Date().toISOString().split('T')[0];
  loadEmployees();
});

function loadEmployees() {
  onValue(ref(db, 'employees'), snapshot => {
    employees = snapshot.val() || {};
    renderTimecardTable();
  });
}

//  Render Table (Shows ALL records, not just latest)
function renderTimecardTable() {
  const date = datePicker.value;
  const filterTxt = searchInput.value.toLowerCase();
  const filterPos = posFilter.value;
  const tbody = document.getElementById('timecardBody');
  tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading records...</td></tr>';

  const allLogs = [];
  const promises = [];

  Object.entries(employees).forEach(([id, e]) => {
    if (filterTxt && !e.englishName.toLowerCase().includes(filterTxt) && !(e.chineseName || '').toLowerCase().includes(filterTxt)) return;
    if (filterPos && e.position !== filterPos) return;

    const p = get(ref(db, `timecards/${date}/${id}`)).then(snap => {
      const tc = snap.val() || {};
      if (!tc.logs || tc.logs.length === 0) return;

      // ✅ Flatten every log entry into the master list
      tc.logs.forEach(log => {
        allLogs.push({
          chineseName: e.chineseName || '-',
          englishName: e.englishName,
          position: e.position,
          time: log.time,
          location: log.location || '-',
          type: log.type
        });
      });
    });
    promises.push(p);
  });

  Promise.all(promises).then(() => {
    allLogs.sort((a, b) => b.time.localeCompare(a.time)); // Newest first
    renderRows(allLogs);
  });
}

function renderRows(logs) {
  const tbody = document.getElementById('timecardBody');
  tbody.innerHTML = '';

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No attendance records for this date</td></tr>';
    return;
  }

  logs.forEach(log => {
    const statusClass = log.type === 'in' ? 'status-in' : log.type === 'out' ? 'status-out' : 'status-none';
    const tr = document.createElement('tr');
    tr.className = 'student-row';
    tr.innerHTML = `
      <td>${log.chineseName}</td>
      <td>${log.englishName}</td>
      <td>${log.position}</td>
      <td>${log.time}</td>
      <td>${log.location}</td>
      <td><span class="status-pill ${statusClass}">${log.type.toUpperCase()}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// 🔍 Filter Listeners
datePicker.addEventListener('change', renderTimecardTable);
searchInput.addEventListener('input', renderTimecardTable);
posFilter.addEventListener('change', renderTimecardTable);

// 📷 Scanner Lifecycle
async function closeScanner() {
  if (html5QrCode) {
    try { await html5QrCode.stop(); } catch(e) {}
    html5QrCode.clear();
    html5QrCode = null;
  }
  isScanning = false;
  scanModal.classList.add('hidden');
  startScanBtn.textContent = "📷 Start QR Scan";
  startScanBtn.disabled = false;
}

startScanBtn.addEventListener('click', async () => {
  scanModal.classList.remove('hidden');
  if (isScanning) return;
  if (typeof Html5Qrcode === 'undefined') {
    showResultModal(false, '❌ Scanner library not loaded.');
    return;
  }

  try {
    html5QrCode = new Html5Qrcode("reader");
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
      async (decodedText) => {
        const scanned = decodedText.trim();
        const now = Date.now();

        // 🛡️ Cooldown
        if (scanned === lastScannedCode && (now - lastScanTimestamp) < SCAN_COOLDOWN_MS) return;
        lastScannedCode = scanned;
        lastScanTimestamp = now;

        if (Object.keys(employees).length === 0) {
          await closeScanner();
          showResultModal(false, '⏳ Employee database still loading...');
          return;
        }

        // 🔍 Match by qrCode field, not Firebase key
        let matchedKey = null;
        let matchedEmp = null;
        for (const [firebaseKey, emp] of Object.entries(employees)) {
          if ((emp.qrCode || '').trim() === scanned) {
            matchedKey = firebaseKey;
            matchedEmp = emp;
            break;
          }
        }

        if (!matchedEmp) {
          await closeScanner();
          showResultModal(false, `❌ Unknown QR Code: ${scanned}`);
          return;
        }

        // ✅ Close scanner immediately, then process
        await closeScanner();
        await processAttendance(matchedKey, matchedEmp);
      },
      () => {}
    );
    isScanning = true;
    startScanBtn.textContent = "📷 Scanning Active";
    startScanBtn.disabled = true;
  } catch (err) {
    console.error('Scanner init failed:', err);
    await closeScanner();
    showResultModal(false, `❌ Camera error: ${err.message}`);
  }
});

document.getElementById('closeScan').onclick = document.getElementById('stopScanBtn').onclick = async () => {
  await closeScanner();
};

//  Core Attendance Logic (Strict Geolocation)
async function processAttendance(empId, emp) {
  // ⚠️ Browsers BLOCK geolocation on http:// (except localhost). Must use https:// or localhost.
  if (!navigator.geolocation) {
    showResultModal(false, '❌ Geolocation not supported by this browser.');
    return;
  }

  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      });
    });

    const { latitude, longitude } = pos.coords;
    console.log(`📍 GPS Received: ${latitude}, ${longitude}`);

    // 📏 Verify distance
    const matchedCenter = CENTERS.find(c => getDistance(c.lat, c.lng, latitude, longitude) <= MAX_DIST_KM);
    if (!matchedCenter) {
      showResultModal(false, `🚫 Outside 200m range. Scan rejected.`);
      return; // ✅ STRICT: No DB write if outside radius
    }

    //  Update Firebase
    const date = datePicker.value;
    const tcRef = ref(db, `timecards/${date}/${empId}`);
    const snap = await get(tcRef);
    const current = snap.val() || { logs: [] };
    const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const lastLog = current.logs.length > 0 ? current.logs[current.logs.length - 1] : null;
    const nextType = (!lastLog || lastLog.type === 'out') ? 'in' : 'out';

    await update(tcRef, {
      logs: [...current.logs, { type: nextType, time: now, location: matchedCenter.name }]
    });

    renderTimecardTable();
    showResultModal(true, `✅ ${nextType.toUpperCase()} at ${matchedCenter.name}`);

  } catch (err) {
    // 🚨 Precise error mapping
    let msg = '❌ Location check failed.';
    if (err.code === 1) {
      msg = '❌ Permission denied. Please allow location access in your browser/site settings.';
    } else if (err.code === 2) {
      msg = '❌ Position unavailable. Check if GPS/Location is enabled on your device.';
    } else if (err.code === 3) {
      msg = '❌ Location request timed out. Please try again.';
    } else {
      msg = `❌ Location error: ${err.message}`;
    }
    console.error('Geolocation Error:', err);
    showResultModal(false, msg);
  }
}

// 🪟 Result Toast Modal
function showResultModal(success, message) {
  let modal = document.getElementById('scanResultModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'scanResultModal';
    modal.className = 'result-modal hidden';
    modal.innerHTML = `<div class="result-content"><div id="resultIcon" class="result-icon"></div><div id="resultMessage" class="result-text"></div></div>`;
    document.body.appendChild(modal);
  }

  const icon = document.getElementById('resultIcon');
  const text = document.getElementById('resultMessage');
  icon.textContent = success ? '✅' : '❌';
  icon.className = success ? 'result-icon success' : 'result-icon error';
  text.innerHTML = message;

  modal.classList.remove('hidden');
  setTimeout(() => modal.classList.add('hidden'), 3000);
}

// 📥 CSV Export
exportCsvBtn.addEventListener('click', async () => {
  const date = datePicker.value;
  const filterPos = posFilter.value;
  let csv = "Date,Employee ID,English Name,Chinese Name,Position,Type,Time,Location\n";

  const snap = await get(ref(db, `timecards/${date}`));
  const dayData = snap.val() || {};

  Object.entries(dayData).forEach(([empId, data]) => {
    if (!employees[empId] || (filterPos && employees[empId].position !== filterPos)) return;
    const emp = employees[empId];
    data.logs?.forEach(log => {
      csv += `${date},${empId},${emp.englishName},${emp.chineseName || ''},${emp.position},${log.type.toUpperCase()},${log.time},${log.location}\n`;
    });
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `timecard_${date}.csv`;
  link.click();
});

// 📐 Haversine Distance
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}