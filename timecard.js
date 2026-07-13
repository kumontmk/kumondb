import { db, logout, requireAuth } from './auth.js';
import { ref, get, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

if (!requireAuth()) throw new Error("Auth required");
const auth = getAuth();

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
const MAX_DIST_KM = 0.05;

let employees = {};
let firebaseCenters = {}; // 🆕 Loaded from Firebase for NFC UID mapping
let currentDayLogs = {};
let timecardUnsubscribe = null;
let html5QrCode = null;
let isScanning = false;
let lastScannedCode = '';
let lastScanTimestamp = 0;
const SCAN_COOLDOWN_MS = 3000;

let currentEmployeeId = null;
let currentEmployeeData = null;
let hasFullAccess = false;
let nfcAbortController = null; // 🆕 Controls NFC scanning lifecycle

// 🆕 Track when Firebase Auth has fully resolved the user session
let authInitialized = false;
onAuthStateChanged(auth, () => {
    authInitialized = true;
    // Re-evaluate current user in case auth resolved after employees loaded
    if (Object.keys(employees).length > 0) {
        identifyCurrentUser();
        renderTimecardTable(); 
    }
});

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

const datePicker = document.getElementById('datePicker');
const searchInput = document.getElementById('searchInput');
const posFilter = document.getElementById('positionFilter');
const startScanBtn = document.getElementById('startScanBtn');
const startNfcBtn = document.getElementById('startNfcBtn'); // 🆕 Restored
const exportCsvBtn = document.getElementById('exportCsvBtn');
const scanModal = document.getElementById('scanModal');
const closeScanBtn = document.getElementById('closeScan');
const stopScanBtn = document.getElementById('stopScanBtn');

window.addEventListener('DOMContentLoaded', () => {
    if (datePicker) datePicker.value = new Date().toISOString().split('T')[0];
    loadEmployees();
    loadFirebaseCenters(); // 🆕 Load centers for NFC UID mapping
    if (datePicker) setupTimecardListener(datePicker.value);
    
    checkNfcUrlClockIn(); // 🆕 Check if user arrived via iOS NFC URL tap
});

// 🆕 Load centers from Firebase to map NFC UIDs to Center Names
function loadFirebaseCenters() {
    onValue(ref(db, 'centers'), (snapshot) => {
        firebaseCenters = snapshot.val() || {};
    });
}

function loadEmployees() {
    onValue(ref(db, 'employees'), snapshot => {
        employees = snapshot.val() || {};
        identifyCurrentUser();
        renderTimecardTable();
    });
}

// 🔒 PERMISSION CONTROL: Identify current user and their access level
function identifyCurrentUser() {
    const user = auth.currentUser;
    if (!user) return;
    currentEmployeeId = null;
    currentEmployeeData = null;
    hasFullAccess = false;

    if (employees[user.uid]) {
        currentEmployeeId = user.uid;
        currentEmployeeData = employees[user.uid];
    } else {
        for (const [id, emp] of Object.entries(employees)) {
            if (emp.uid === user.uid || (user.email && emp.email === user.email)) {
                currentEmployeeId = id;
                currentEmployeeData = emp;
                break;
            }
        }
    }

    if (currentEmployeeData) {
        // ✅ FIX: Helper to get all positions (matches employees.js logic)
        const getPositions = (emp) => {
            if (Array.isArray(emp.positions)) return emp.positions;
            if (emp.position) return [emp.position];
            return [];
        };
        
        const userPositions = getPositions(currentEmployeeData).map(p => p.trim().toLowerCase());
        const isManagerOrAdmin = userPositions.includes('manager') || userPositions.includes('master admin');
        
        const centerStr = (currentEmployeeData.center || currentEmployeeData.branch || currentEmployeeData.location || currentEmployeeData.centerName || '').toLowerCase();
        const isChamps = centerStr.includes('champs');
        
        // ✅ Grant full access if they are Champs staff, Manager, or Master Admin
        hasFullAccess = isChamps || isManagerOrAdmin;
    }

    // ✅ Fallback: Force full access for Master Admin email just in case
    if (!hasFullAccess && user.email) {
        const emailLower = user.email.toLowerCase();
        if (emailLower.includes('champs') || emailLower === 'kumonchamps@gmail.com') {
            hasFullAccess = true;
        }
    }

    console.log("🔒 [Auth Debug] User:", user.email, "| Found in DB:", !!currentEmployeeData, "| Full Access:", hasFullAccess);
}

function setupTimecardListener(date) {
    if (timecardUnsubscribe) {
        timecardUnsubscribe();
        timecardUnsubscribe = null;
    }
    currentDayLogs = {};
    renderTimecardTable();
    timecardUnsubscribe = onValue(ref(db, `timecards/${date}`), snapshot => {
        currentDayLogs = snapshot.val() || {};
        renderTimecardTable(); 
    });
}

function renderTimecardTable() {
    const tbody = document.getElementById('timecardBody');
    if (!tbody) return;
    
    const filterTxt = searchInput ? searchInput.value.toLowerCase() : '';
    const filterPos = posFilter ? posFilter.value : '';
    const allLogs = [];

    Object.entries(employees).forEach(([id, e]) => {
        if (!hasFullAccess && id !== currentEmployeeId) return; 
        if (filterTxt && !e.englishName.toLowerCase().includes(filterTxt) && !(e.chineseName || '').toLowerCase().includes(filterTxt)) return;
        if (filterPos) {
            const empPositions = (Array.isArray(e.positions) ? e.positions : (e.position ? [e.position] : [])).map(p => p.toLowerCase());
            if (!empPositions.includes(filterPos.toLowerCase())) return;
        }
        
        const logs = currentDayLogs[id]?.logs || [];
        if (logs.length === 0) return;
        
        logs.forEach(log => {
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

    allLogs.sort((a, b) => b.time.localeCompare(a.time));
    renderRows(allLogs);
}

function renderRows(logs) {
    const tbody = document.getElementById('timecardBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (logs.length === 0) {
        const msg = !hasFullAccess ? 'No personal attendance records for this date' : 'No attendance records for this date';
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${msg}</td></tr>`;
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

if (datePicker) {
    datePicker.addEventListener('change', (e) => {
        setupTimecardListener(e.target.value);
    });
}
if (searchInput) searchInput.addEventListener('input', renderTimecardTable);
if (posFilter) posFilter.addEventListener('change', renderTimecardTable);

// ==========================================
// 📡 NFC CLOCK-IN/OUT LOGIC (ANDROID UID READER)
// ==========================================
if (startNfcBtn) {
    startNfcBtn.addEventListener('click', async () => {
        if (!('NDEFReader' in window)) {
            showResultModal(false, '❌ NFC is not supported on this device/browser.<br>Please use <strong>Chrome on Android</strong> over HTTPS.');
            return;
        }

        if (!currentEmployeeId) {
            showResultModal(false, '🚫 You must be logged in as a registered employee to use NFC clock-in.');
            return;
        }

        if (nfcAbortController) nfcAbortController.abort();
        nfcAbortController = new AbortController();

        try {
            const reader = new NDEFReader();
            
            reader.onreading = async (event) => {
                if (nfcAbortController) nfcAbortController.abort();
                resetNfcButton();

                // 1. Read the unique hardware UID (Serial Number) of the sticker
                const uid = Array.from(event.serialNumber)
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join(':')
                    .toUpperCase();

                console.log("📡 Read NFC UID:", uid);

                // 2. Find which center has this UID registered in the database
                let matchedCenterName = null;
                for (const [id, data] of Object.entries(firebaseCenters)) {
                    if (data.nfcUid && data.nfcUid.toUpperCase() === uid) {
                        matchedCenterName = data.name || id;
                        break;
                    }
                }

                // 3. If the UID isn't in the database, reject it
                if (!matchedCenterName) {
                    showResultModal(false, '❌ Unregistered NFC Tag.<br>This sticker has not been assigned to a center yet.<br>Please contact an admin to register it in Center Management.');
                    return;
                }

                // 4. Clock the logged-in employee in/out at this specific center
                await saveAttendance(currentEmployeeId, matchedCenterName);
            };

            reader.onreadingerror = () => {
                resetNfcButton();
                showResultModal(false, '❌ Could not read NFC tag. Please try again.');
            };

            await reader.scan({ signal: nfcAbortController.signal });
            
            startNfcBtn.textContent = "📡 Waiting for tap...";
            startNfcBtn.disabled = true;
            
            // Auto-reset button after 15 seconds if no tap
            setTimeout(resetNfcButton, 15000);

        } catch (err) {
            resetNfcButton();
            if (err.name === 'AbortError') return;
            if (err.name === 'NotAllowedError') {
                showResultModal(false, '⚠️ NFC permission denied.<br>Please allow NFC access in your browser settings.');
            } else {
                showResultModal(false, `❌ NFC Error: ${err.message}`);
            }
        }
    });
}

function resetNfcButton() {
    if (startNfcBtn) {
        startNfcBtn.textContent = "📡 Tap NFC to Clock In/Out";
        startNfcBtn.disabled = false;
    }
}

// ==========================================
// 🍏 AUTO CLOCK-IN FOR iOS / URL-BASED NFC TAGS
// ==========================================
function checkNfcUrlClockIn() {
    const params = new URLSearchParams(window.location.search);
    let centerId = params.get('center');
    let isNfcTrigger = params.get('nfc_clock') === '1';

    // 1. If triggered via URL, save to sessionStorage immediately before any auth redirects
    if (isNfcTrigger && centerId) {
        sessionStorage.setItem('pendingNfcCenter', centerId);
    }

    // 2. Check if we have a pending NFC center (either from URL just now, or from sessionStorage after login)
    if (!centerId) {
        centerId = sessionStorage.getItem('pendingNfcCenter');
    }

    if (centerId) {
        showResultModal(true, '📡 NFC Tag Detected!<br>Loading data & verifying...');

        const checkInterval = setInterval(() => {
            const employeesLoaded = Object.keys(employees).length > 0;
            const centersLoaded = Object.keys(firebaseCenters).length > 0;
            
            // Wait for Auth, Employees, and Centers to all be fully loaded
            if (employeesLoaded && centersLoaded && authInitialized) {
                clearInterval(checkInterval);
                
                // Clean up URL and sessionStorage
                window.history.replaceState({}, document.title, window.location.pathname);
                sessionStorage.removeItem('pendingNfcCenter');

                if (!currentEmployeeId) {
                    showResultModal(false, '🚫 You must be logged in.<br>Please log in to the web app, then tap the NFC tag again.');
                    return;
                }

                const centerData = firebaseCenters[centerId];
                if (centerData) {
                    // Automatically clock them in!
                    saveAttendance(currentEmployeeId, centerData.name);
                } else {
                    showResultModal(false, '❌ Center ID not found in database.');
                }
            }
        }, 200);

        // Failsafe: stop checking after 8 seconds to prevent infinite loops
        setTimeout(() => {
            clearInterval(checkInterval);
        }, 8000);
    }
}

// ==========================================
// 📷 QR CODE SCANNER LOGIC
// ==========================================
async function closeScanner() {
    if (html5QrCode) {
        try {
            if (isScanning) await html5QrCode.stop();
            html5QrCode.clear();
        } catch(e) { console.warn("Scanner clear warning:", e); }
        html5QrCode = null;
    }
    isScanning = false;
    if (scanModal) scanModal.classList.add('hidden');
    if (startScanBtn) {
        startScanBtn.textContent = "📷 Start QR Scan";
        startScanBtn.disabled = false;
    }
}

function ensureChoiceModal() {
    let modal = document.getElementById('scanChoiceModal');
    if (modal) return modal;
    
    modal = document.createElement('div');
    modal.id = 'scanChoiceModal';
    modal.className = 'result-modal hidden';
    modal.innerHTML = `
        <div class="result-content" style="min-width:300px;">
            <div class="result-icon" style="color:#4682B4;">📷</div>
            <div class="result-text" style="margin-bottom:1.2rem;">Choose scan method</div>
            <div style="display:flex; flex-direction:column; gap:0.6rem;">
                <button id="choiceCameraBtn" class="scan-btn" style="justify-content:center; width:100%;">📷 Scan with Camera</button>
                <button id="choiceUploadBtn" class="scan-btn" style="justify-content:center; width:100%; background:#6c757d;">🖼️ Upload QR Image</button>
                <button id="choiceCancelBtn" style="padding:0.5rem; background:transparent; color:#666; border:none; cursor:pointer;">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    let fileInput = document.getElementById('qrFileInput');
    if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'qrFileInput';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);
    }

    document.getElementById('choiceCameraBtn').addEventListener('click', async () => {
        modal.classList.add('hidden');
        await startCameraScan();
    });
    document.getElementById('choiceUploadBtn').addEventListener('click', () => {
        modal.classList.add('hidden');
        document.getElementById('qrFileInput').click();
    });
    document.getElementById('choiceCancelBtn').addEventListener('click', () => {
        modal.classList.add('hidden');
    });

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        fileInput.value = ''; 
        if (!file) return;
        await handleUploadedQr(file);
    });

    return modal;
}

async function handleUploadedQr(file) {
    if (typeof Html5Qrcode === 'undefined') { showResultModal(false, '❌ Scanner library not loaded.'); return; }
    if (Object.keys(employees).length === 0) { showResultModal(false, '⏳ Employee database still loading...'); return; }
    
    let uploadReaderEl = document.getElementById('qrUploadReader');
    if (!uploadReaderEl) {
        uploadReaderEl = document.createElement('div');
        uploadReaderEl.id = 'qrUploadReader';
        uploadReaderEl.style.display = 'none';
        document.body.appendChild(uploadReaderEl);
    }
    
    showResultModal(true, '⏳ Reading uploaded image...');
    try {
        const scanner = new Html5Qrcode('qrUploadReader', { verbose: false });
        const decodedText = await scanner.scanFile(file, false);
        try { scanner.clear(); } catch (e) { console.warn("Scanner clear warning:", e); }
        if (!decodedText) throw new Error('No QR code found in image.');
        await handleScanSuccess(decodedText);
    } catch (err) {
        console.error('Upload QR decode failed:', err);
        showResultModal(false, `❌ Could not read QR from image: ${err.message || err}`);
    }
}

async function startCameraScan() {
    if (scanModal) scanModal.classList.remove('hidden');
    if (isScanning) return;
    
    if (!window.isSecureContext) { showResultModal(false, '❌ Camera requires HTTPS.'); return; }
    if (typeof Html5Qrcode === 'undefined') { showResultModal(false, '❌ Scanner library not loaded.'); return; }
    
    try {
        html5QrCode = new Html5Qrcode("reader");
        const config = { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0, disableFlip: false };
        let started = false;
        
        try {
            const devices = await Html5Qrcode.getCameras();
            if (devices && devices.length > 0) {
                const rearCam = devices.find(d => d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('environment') || d.label.toLowerCase().includes('rear'));
                const camId = rearCam ? rearCam.id : devices[0].id;
                await html5QrCode.start(camId, config, handleScanSuccess, handleScanFailure);
                started = true;
            }
        } catch (e) { console.warn("Camera enumeration failed, falling back", e); }
        
        if (!started) await html5QrCode.start({ facingMode: "environment" }, config, handleScanSuccess, handleScanFailure);
        if (!started) await html5QrCode.start({ facingMode: "user" }, config, handleScanSuccess, handleScanFailure);
        
        if (started) {
            isScanning = true;
            startScanBtn.textContent = "📷 Scanning Active";
            startScanBtn.disabled = true;
        }
    } catch (err) {
        console.error('Scanner init failed:', err);
        await closeScanner();
        showResultModal(false, `❌ Camera error: ${err.message}`);
    }
}

if (startScanBtn) {
    startScanBtn.addEventListener('click', async () => {
        const choiceModal = ensureChoiceModal();
        choiceModal.classList.remove('hidden');
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

    if (!hasFullAccess && matchedKey !== currentEmployeeId) {
        await closeScanner();
        showResultModal(false, '🚫 You can only clock in/out for yourself.');
        return;
    }

    await closeScanner();
    await processAttendance(matchedKey, matchedEmp);
}

function handleScanFailure(errorMessage) {}

if (closeScanBtn) closeScanBtn.onclick = async () => { await closeScanner(); };
if (stopScanBtn) stopScanBtn.onclick = async () => { await closeScanner(); };

const manualQrInput = document.getElementById('manualQrInput');
const submitManualQrBtn = document.getElementById('manualQrBtn');

if (submitManualQrBtn && manualQrInput) {
    submitManualQrBtn.addEventListener('click', async () => {
        const scanned = manualQrInput.value.trim();
        if (!scanned) { showResultModal(false, '❌ Please enter a QR code.'); return; }
        if (Object.keys(employees).length === 0) { showResultModal(false, '⏳ Employee database still loading...'); return; }
        
        let matchedKey = null, matchedEmp = null;
        for (const [firebaseKey, emp] of Object.entries(employees)) {
            if ((emp.qrCode || '').trim() === scanned) { matchedKey = firebaseKey; matchedEmp = emp; break; }
        }
        
        if (!matchedEmp) { showResultModal(false, `❌ Unknown QR Code: ${scanned}`); return; }
        if (!hasFullAccess && matchedKey !== currentEmployeeId) {
            showResultModal(false, '🚫 You can only clock in/out for yourself.');
            return;
        }
        
        manualQrInput.value = '';
        await closeScanner();
        await processAttendance(matchedKey, matchedEmp);
    });
    manualQrInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitManualQrBtn.click(); });
}

// ==========================================
// 📍 GPS & ATTENDANCE SAVING LOGIC
// ==========================================
async function getLocationWithRetry(maxAttempts = 2) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const options = attempt === 1 ? { enableHighAccuracy: true, timeout: 4000, maximumAge: 60000 } : { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 };
            const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
            return pos;
        } catch (err) {
            if (attempt === maxAttempts) throw err;
            await new Promise(res => setTimeout(res, 500));
        }
    }
}

// Used by QR Code (Requires GPS)
async function processAttendance(empId, emp) {
    if (!navigator.geolocation) { showResultModal(false, '❌ Geolocation not supported.'); return; }
    
    try {
        const pos = await getLocationWithRetry();
        const { latitude, longitude } = pos.coords;
        const matchedCenter = CENTERS.find(c => getDistance(c.lat, c.lng, latitude, longitude) <= MAX_DIST_KM);
        
        if (!matchedCenter) {
            const distances = CENTERS.map(c => ({ name: c.name, dist: getDistance(c.lat, c.lng, latitude, longitude) }));
            showResultModal(false, `🚫 Outside 50m range. Closest: ${distances.sort((a,b)=>a.dist-b.dist)[0].name} (${distances[0].dist.toFixed(3)}km)`);
            return;
        }
        
        await saveAttendance(empId, matchedCenter.name);
    } catch (err) {
        const messages = { 1: '❌ Location permission denied.', 2: '❌ Location unavailable.', 3: '❌ Location request timed out.' };
        showResultModal(false, messages[err.code] || `❌ Location error: ${err.message}`);
    }
}

// Shared saving logic (Used by QR, Android NFC UID, and iOS NFC URL)
async function saveAttendance(empId, locationName) {
    try {
        const date = datePicker.value;
        const tcRef = ref(db, `timecards/${date}/${empId}`);
        const snap = await get(tcRef);
        const current = snap.val() || { logs: [] };
        
        const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const lastLog = current.logs.length > 0 ? current.logs[current.logs.length - 1] : null;
        
        let nextType;
        let autoOutLog = null;
        
        if (!lastLog || lastLog.type === 'out') {
            nextType = 'in';
        } 
        else if (lastLog.type === 'in' && lastLog.location !== locationName) {
            nextType = 'in';
            const empTerms = employees[empId]?.terms || 'Full-time';
            if (empTerms === 'Full-time') {
                const nowMins = timeToMinutes(now);
                const autoOutMins = Math.max(0, nowMins - 1);
                autoOutLog = {
                    type: 'out',
                    time: minutesToTime(autoOutMins),
                    location: lastLog.location,
                    autoGenerated: true
                };
            }
        } 
        else {
            nextType = 'out';
        }
        
        const newLogs = [...current.logs];
        if (autoOutLog) newLogs.push(autoOutLog);
        newLogs.push({ type: nextType, time: now, location: locationName });
        
        await update(tcRef, { logs: newLogs });
        
        let msg = `✅ ${nextType.toUpperCase()} at ${locationName}`;
        if (autoOutLog) msg += `<br>⚡ Auto-clocked OUT at ${autoOutLog.location} (${autoOutLog.time})`;
        
        showResultModal(true, msg);
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
        modal.innerHTML = `
            <div class="result-content">
                <div id="resultIcon" class="result-icon"></div>
                <div id="resultMessage" class="result-text"></div>
            </div>
        `;
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
    exportCsvBtn.addEventListener('click', () => {
        const date = datePicker.value;
        const filterPos = posFilter ? posFilter.value : '';
        
        if (Object.keys(currentDayLogs).length === 0) {
            alert('No attendance data loaded for this date.');
            return;
        }
        
        let csv = "Date,Employee ID,English Name,Chinese Name,Position,Type,Time,Location\n";
        Object.entries(currentDayLogs).forEach(([empId, data]) => {
            if (!hasFullAccess && empId !== currentEmployeeId) return;
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