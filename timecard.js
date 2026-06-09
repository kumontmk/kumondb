import { db, logout, requireAuth } from './auth.js';
import { ref, get, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

if (!requireAuth()) throw new Error("Auth required");

// ✅ FIX: Safely check if logoutBtn exists before adding event listener
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
}

const CENTERS = [
    { name: "Kumon Taipa Mei Keng", lat: 22.15680419404832, lng: 113.55310261763758 },
    { name: "Kumon Taipa Pac Tat", lat: 22.15864298997591, lng: 113.54896029627456 },
    { name: "Kumon Champs", lat: 22.202188413699155, lng: 113.54954818278166 },
    { name: "Kumon Tap Siac", lat: 22.19974168219132, lng: 113.54570239996973 }
];
const MAX_DIST_KM = 0.2;

let employees = {};
let html5QrCode = null;
let isScanning = false;
let lastScannedCode = '';
let lastScanTimestamp = 0;
const SCAN_COOLDOWN_MS = 3000;

const datePicker = document.getElementById('datePicker');
const searchInput = document.getElementById('searchInput');
const posFilter = document.getElementById('positionFilter');
const startScanBtn = document.getElementById('startScanBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const scanModal = document.getElementById('scanModal');
const closeScanBtn = document.getElementById('closeScan');
const stopScanBtn = document.getElementById('stopScanBtn');

window.addEventListener('DOMContentLoaded', () => {
    if (datePicker) datePicker.value = new Date().toISOString().split('T')[0];
    loadEmployees();
});

function loadEmployees() {
    onValue(ref(db, 'employees'), snapshot => {
        employees = snapshot.val() || {};
        renderTimecardTable();
    });
}

function renderTimecardTable() {
    if (!datePicker) return;
    const date = datePicker.value;
    const filterTxt = searchInput ? searchInput.value.toLowerCase() : '';
    const filterPos = posFilter ? posFilter.value : '';
    const tbody = document.getElementById('timecardBody');
    
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading records...</td></tr>';

    const allLogs = [];
    const promises = [];

    Object.entries(employees).forEach(([id, e]) => {
        if (filterTxt && !e.englishName.toLowerCase().includes(filterTxt) && !(e.chineseName || '').toLowerCase().includes(filterTxt)) return;
        if (filterPos && e.position !== filterPos) return;
        
        const p = get(ref(db, `timecards/${date}/${id}`)).then(snap => {
            const tc = snap.val() || {};
            if (!tc.logs || tc.logs.length === 0) return;
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
        allLogs.sort((a, b) => b.time.localeCompare(a.time));
        renderRows(allLogs);
    });
}

function renderRows(logs) {
    const tbody = document.getElementById('timecardBody');
    if (!tbody) return;
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

if (datePicker) datePicker.addEventListener('change', renderTimecardTable);
if (searchInput) searchInput.addEventListener('input', renderTimecardTable);
if (posFilter) posFilter.addEventListener('change', renderTimecardTable);

async function closeScanner() {
    if (html5QrCode) {
        try { 
            if (isScanning) await html5QrCode.stop(); 
            html5QrCode.clear(); 
        } catch(e) { 
            console.warn("Scanner clear warning:", e); 
        }
        html5QrCode = null;
    }
    isScanning = false;
    if (scanModal) scanModal.classList.add('hidden');
    if (startScanBtn) {
        startScanBtn.textContent = "📷 Start QR Scan";
        startScanBtn.disabled = false;
    }
}

// ✅ ROBUST SCANNER INITIALIZATION FOR CROSS-BROWSER COMPATIBILITY
if (startScanBtn) {
    startScanBtn.addEventListener('click', async () => {
        if (scanModal) scanModal.classList.remove('hidden');
        if (isScanning) return;
        
        if (!window.isSecureContext) {
            showResultModal(false, '❌ Camera requires HTTPS. Please ensure the site is loaded over a secure connection.');
            return;
        }
         
        if (typeof Html5Qrcode === 'undefined') {
            showResultModal(false, '❌ Scanner library not loaded. Please check your internet connection.');
            return;
        }
        
        try {
            html5QrCode = new Html5Qrcode("reader");
            const config = {
                fps: 10,
                qrbox: { width: 250, height: 250 },
                aspectRatio: 1.0,
                disableFlip: false
            };

            let started = false;

            try {
                const devices = await Html5Qrcode.getCameras();
                if (devices && devices.length > 0) {
                    const rearCam = devices.find(d => 
                        d.label.toLowerCase().includes('back') || 
                        d.label.toLowerCase().includes('environment') || 
                        d.label.toLowerCase().includes('rear')
                    );
                    const camId = rearCam ? rearCam.id : devices[0].id;
                    await html5QrCode.start(camId, config, handleScanSuccess, handleScanFailure);
                    started = true;
                }
            } catch (e) {
                console.warn("Camera enumeration failed, falling back to facingMode constraints", e);
            }

            if (!started) {
                try {
                    await html5QrCode.start({ facingMode: "environment" }, config, handleScanSuccess, handleScanFailure);
                    started = true;
                } catch (e) {
                    console.warn("Environment camera failed, trying user/front camera", e);
                    await html5QrCode.start({ facingMode: "user" }, config, handleScanSuccess, handleScanFailure);
                    started = true;
                }
            }

            if (started) {
                isScanning = true;
                startScanBtn.textContent = "📷 Scanning Active";
                startScanBtn.disabled = true;
            } else {
                throw new Error("Could not start any available camera.");
            }

        } catch (err) {
            console.error('Scanner init failed:', err);
            await closeScanner();
            showResultModal(false, `❌ Camera error: ${err.message}. Please ensure you have granted camera permissions in your browser settings.`);
        }
    });
}

async function handleScanSuccess(decodedText) {
    const scanned = decodedText.trim();
    const now = Date.now();
    if (scanned === lastScannedCode && (now - lastScanTimestamp) < SCAN_COOLDOWN_MS) return;
    lastScannedCode = scanned;
    lastScanTimestamp = now;

    if (Object.keys(employees).length === 0) {
        await closeScanner();
        showResultModal(false, '⏳ Employee database still loading...');
        return;
    }

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

    await closeScanner();
    await processAttendance(matchedKey, matchedEmp);
}

function handleScanFailure(errorMessage) {
    // Intentionally left empty to prevent console spam
}

if (closeScanBtn) closeScanBtn.onclick = async () => { await closeScanner(); };
if (stopScanBtn) stopScanBtn.onclick = async () => { await closeScanner(); };

// ✅ FIXED: Manual QR Code Submission Logic
const manualQrInput = document.getElementById('manualQrInput');
const submitManualQrBtn = document.getElementById('manualQrBtn'); // 🔥 FIXED ID TO MATCH YOUR HTML!

if (submitManualQrBtn && manualQrInput) {
    submitManualQrBtn.addEventListener('click', async () => {
        const scanned = manualQrInput.value.trim();
        if (!scanned) {
            showResultModal(false, '❌ Please enter a QR code.');
            return;
        }
        
        if (Object.keys(employees).length === 0) {
            showResultModal(false, '⏳ Employee database still loading...');
            return;
        }

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
            showResultModal(false, `❌ Unknown QR Code: ${scanned}`);
            return;
        }

        // Clear the input for the next use
        manualQrInput.value = '';
        
        // Stop scanner if it's currently running in the background
        await closeScanner();
        await processAttendance(matchedKey, matchedEmp);
    });

    // Allow pressing "Enter" key in the input field to submit
    manualQrInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            submitManualQrBtn.click();
        }
    });
}

// ✅ ROBUST GEOLOCATION WITH RETRY LOGIC
async function getLocationWithRetry(maxAttempts = 2) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const options = attempt === 1
                ? { enableHighAccuracy: true, timeout: 4000, maximumAge: 60000 }
                : { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 };
            
            const pos = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, options);
            });
            
            console.log(`✅ Location obtained (attempt ${attempt}):`, pos.coords);
            return pos;
        } catch (err) {
            console.warn(`⚠️ Location attempt ${attempt} failed:`, err.message);
            if (attempt === maxAttempts) throw err;
            await new Promise(res => setTimeout(res, 500));
        }
    }
}

async function processAttendance(empId, emp) {
    if (!navigator.geolocation) {
        showResultModal(false, '❌ Geolocation not supported by this browser.');
        return;
    }
    try {
        console.log('📍 Requesting location...');
        const pos = await getLocationWithRetry();
        const { latitude, longitude } = pos.coords;
        const matchedCenter = CENTERS.find(c =>
            getDistance(c.lat, c.lng, latitude, longitude) <= MAX_DIST_KM
        );
        
        if (!matchedCenter) {
            const distances = CENTERS.map(c => ({
                name: c.name,
                dist: getDistance(c.lat, c.lng, latitude, longitude)
            }));
            console.warn('🚫 Outside range. Distances:', distances);
            showResultModal(false, `🚫 Outside 200m range. Closest: ${distances.sort((a,b)=>a.dist-b.dist)[0].name} (${distances[0].dist.toFixed(3)}km)`);
            return;
        }

        console.log(`✅ Location verified at: ${matchedCenter.name}`);
        await saveAttendance(empId, matchedCenter.name);
    } catch (err) {
        console.error('🚨 Geolocation error:', err);
        const messages = {
            1: '❌ Location permission denied. Please allow location access for this site in your browser settings.',
            2: '❌ Location unavailable. Ensure GPS/Wi-Fi is enabled on your device.',
            3: '❌ Location request timed out. Please try again with a stronger signal.',
        };
        const msg = messages[err.code] || `❌ Location error: ${err.message}`;
        showResultModal(false, msg);
    }
}

async function saveAttendance(empId, locationName) {
    try {
        const date = datePicker.value;
        const tcRef = ref(db, `timecards/${date}/${empId}`);
        const snap = await get(tcRef);
        const current = snap.val() || { logs: [] };
        const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const lastLog = current.logs.length > 0 ? current.logs[current.logs.length - 1] : null;
        const nextType = (!lastLog || lastLog.type === 'out') ? 'in' : 'out';
        
        await update(tcRef, {
            logs: [...current.logs, { type: nextType, time: now, location: locationName }]
        });

        renderTimecardTable();
        showResultModal(true, `✅ ${nextType.toUpperCase()} at ${locationName}`);
    } catch (err) {
        console.error('💥 Firebase update failed:', err);
        showResultModal(false, `❌ Failed to save: ${err.message}`);
    }
}

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
    if (icon && text) {
        icon.textContent = success ? '✅' : '❌';
        icon.className = success ? 'result-icon success' : 'result-icon error';
        text.innerHTML = message.replace(/\n/g, '<br>');
    }
    modal.classList.remove('hidden');
    setTimeout(() => modal.classList.add('hidden'), 4000);
}

if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', async () => {
        const date = datePicker.value;
        const filterPos = posFilter ? posFilter.value : '';
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
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}