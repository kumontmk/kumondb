import { db, logout, requireAuth } from './auth.js';
import { ref, get, set, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

if (!requireAuth()) throw new Error("Auth required");

document.getElementById('logoutBtn').addEventListener('click', logout);

const CENTERS = [
  { name: "Kumon Taipa Mei Keng", lat: 22.15680419404832, lng: 113.55310261763758 },
  { name: "Kumon Taipa Pac Tat", lat: 22.15864298997591, lng: 113.54896029627456 },
  { name: "Kumon Champs", lat: 22.202188413699155, lng: 113.54954818278166 },
  { name: "Kumon Tap Siac", lat: 22.19974168219132, lng: 113.54570239996973 }
];
const MAX_DIST_KM = 0.05;

let employees = {};
let timecards = {};
let html5QrCode = null;
let isScanning = false;

const datePicker = document.getElementById('datePicker');
const searchInput = document.getElementById('searchInput');
const posFilter = document.getElementById('positionFilter');
const startScanBtn = document.getElementById('startScanBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const scanModal = document.getElementById('scanModal');
const scanStatus = document.getElementById('scanStatus');

window.addEventListener('DOMContentLoaded', () => {
  datePicker.value = new Date().toISOString().split('T')[0];
  loadEmployees();
});

function loadEmployees() {
  onValue(ref(db, 'employees'), s => {
    employees = s.val() || {};
    renderTimecardTable();
  });
}

function renderTimecardTable() {
  const date = datePicker.value;
  const filterTxt = searchInput.value.toLowerCase();
  const filterPos = posFilter.value;
  const tbody = document.getElementById('timecardBody');
  tbody.innerHTML = '';

  const rows = [];
  Object.entries(employees).forEach(([id, e]) => {
    get(ref(db, `timecards/${date}/${id}`)).then(snap => {
      const tc = snap.val() || {};
      if (!tc.logs || tc.logs.length === 0) return;
      if (filterTxt && !e.englishName.toLowerCase().includes(filterTxt) && !(e.chineseName||'').toLowerCase().includes(filterTxt)) return;
      if (filterPos && e.position !== filterPos) return;

      const latestIn = tc.logs.filter(l => l.type === 'in').pop();
      const latestOut = tc.logs.filter(l => l.type === 'out').pop();
      const status = !latestIn ? 'Not Checked In' : (!latestOut ? 'Checked In' : 'Checked Out');
      
      tbody.innerHTML = '';
      rows.push({ ...e, id, latestIn: latestIn?.time || '-', latestOut: latestOut?.time || '-', status, tc });
      renderRows(rows);
    });
  });
}

function renderRows(rows) {
  const tbody = document.getElementById('timecardBody');
  tbody.innerHTML = '';
  rows.sort((a, b) => {
    const tA = a.latestIn !== '-' ? a.latestIn : a.latestOut;
    const tB = b.latestIn !== '-' ? b.latestIn : b.latestOut;
    return tB.localeCompare(tA);
  });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No attendance records for this date</td></tr>';
    return;
  }

  rows.forEach(r => {
    const statusClass = r.status === 'Checked In' ? 'status-in' : r.status === 'Checked Out' ? 'status-out' : 'status-none';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.chineseName || '-'}</td>
      <td>${r.englishName}</td>
      <td>${r.position}</td>
      <td>${r.latestIn}</td>
      <td>${r.latestOut}</td>
      <td><span class="status-pill ${statusClass}">${r.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

datePicker.addEventListener('change', renderTimecardTable);
searchInput.addEventListener('input', renderTimecardTable);
posFilter.addEventListener('change', renderTimecardTable);

// 📷 SCANNER LIFECYCLE (Matches attendance.js)
async function cleanupScanner() {
  if (html5QrCode) {
    try { await html5QrCode.stop(); } catch(e) {}
    html5QrCode.clear();
    html5QrCode = null;
  }
  const readerDiv = document.getElementById('reader');
  if (readerDiv) readerDiv.innerHTML = '';
  isScanning = false;
}

startScanBtn.addEventListener('click', async () => {
  scanModal.classList.remove('hidden');
  if (isScanning) return;
  if (typeof Html5Qrcode === 'undefined') {
    scanStatus.innerHTML = '<span style="color:#dc3545">❌ Scanner library not loaded</span>';
    return;
  }

  await cleanupScanner();
  scanStatus.textContent = '📷 Initializing camera...';

  try {
    html5QrCode = new Html5Qrcode("reader");
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
      async (decodedText) => {
        const empId = decodedText.replace('EMP_', '');
        if (employees[empId]) {
          scanStatus.innerHTML = `<span style="color:#28a745">✅ Scanned: ${employees[empId].englishName}</span>`;
          await handleScan(empId);
        } else {
          scanStatus.innerHTML = '<span style="color:#dc3545">❌ Unknown QR Code</span>';
        }
      },
      () => {}
    );
    scanStatus.textContent = '✅ Camera ready. Point at QR...';
    isScanning = true;
    startScanBtn.textContent = "📷 Scanning Active";
    startScanBtn.disabled = true;
  } catch (err) {
    console.error('Scanner init failed:', err);
    scanStatus.innerHTML = `<span style="color:#dc3545">❌ Camera: ${err.message}</span>`;
  }
});

document.getElementById('closeScan').onclick = document.getElementById('stopScanBtn').onclick = async () => {
  await cleanupScanner();
  scanModal.classList.add('hidden');
  startScanBtn.textContent = "📷 Start QR Scan";
  startScanBtn.disabled = false;
  scanStatus.textContent = "Position QR in the frame";
};

async function handleScan(empId) {
  if (!navigator.geolocation) { alert("Geolocation not supported"); return; }
  scanStatus.textContent = "📍 Checking location...";
  
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 8000 }));
    const { latitude, longitude } = pos.coords;
    
    const matched = CENTERS.find(c => getDistance(c.lat, c.lng, latitude, longitude) <= MAX_DIST_KM);
    if (!matched) {
      scanStatus.textContent = "🚫 Outside verified 50m range";
      return;
    }

    const date = datePicker.value;
    const tcRef = ref(db, `timecards/${date}/${empId}`);
    const snap = await get(tcRef);
    const current = snap.val() || { logs: [] };
    const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const lastLog = current.logs.length > 0 ? current.logs[current.logs.length - 1] : null;
    
    const nextType = (!lastLog || lastLog.type === 'out') ? 'in' : 'out';
    await update(tcRef, { logs: [...current.logs, { type: nextType, time: now, location: matched.name }] });
    
    scanStatus.innerHTML = `<span style="color:#28a745">✅ ${nextType.toUpperCase()} at ${matched.name}</span>`;
    renderTimecardTable();
    setTimeout(() => { if(isScanning) scanStatus.textContent = "Position QR in the frame"; }, 2000);
  } catch (err) {
    scanStatus.textContent = "❌ Location denied/timeout";
  }
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

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}