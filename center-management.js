import { db, requireAuth } from './auth.js';
import { ref, set, get, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

if (!requireAuth()) throw new Error("Auth required");
const auth = getAuth();

// DOM Elements
const mainContent = document.getElementById('mainContent');
const accessDenied = document.getElementById('accessDenied');
const centersGrid = document.getElementById('centersGrid');
const centerModal = document.getElementById('centerModal');
const centerForm = document.getElementById('centerForm');
const pageLoader = document.getElementById('page-loader');

let centers = {};
let currentNfcUid = '';
let nfcAbortController = null; // FIX: Controls NFC scanning lifecycle

// ==========================================
// 1. AUTHORIZATION CHECK
// ==========================================
async function checkAuthorization(user) {
    if (!user) {
        showAccessDenied('🔐 Please log in first', 'No user session found.');
        return false;
    }

    const actualEmail = user.email?.toLowerCase() || '';
    if (actualEmail === 'kumonchamps@gmail.com') {
        grantAccess();
        return true;
    }

    try {
        const userSnap = await get(ref(db, `users/${user.uid}`));
        const userData = userSnap.val();
        if (userData && userData.position?.trim().toLowerCase() === 'manager') {
            grantAccess();
            return true;
        }

        const empSnap = await get(ref(db, 'employees'));
        const empData = empSnap.val();
        if (empData) {
            const matchingEmp = Object.values(empData).find(e => e.email?.toLowerCase() === user.email?.toLowerCase());
            if (matchingEmp && matchingEmp.position?.trim().toLowerCase() === 'manager') {
                grantAccess();
                return true;
            }
        }
    } catch (err) {
        console.error('Error checking user role:', err);
    }

    showAccessDenied('🔐 Access Restricted', `<p><strong>${user.email} is not authorized.</strong></p><p>Only Administrators and Managers can access Center Management.</p>`);
    return false;
}

function grantAccess() {
    if (accessDenied) accessDenied.classList.add('hidden');
    if (mainContent) {
        mainContent.classList.remove('hidden');
        if(pageLoader) pageLoader.classList.add('hidden');
    }
}

function showAccessDenied(title, messageHtml) {
    if (mainContent) mainContent.classList.add('hidden');
    if (accessDenied) {
        accessDenied.classList.remove('hidden');
        if(pageLoader) pageLoader.classList.add('hidden');
    }
}

// ==========================================
// 2. APP INITIALIZATION & DATA LOADING
// ==========================================
onAuthStateChanged(auth, async (user) => {
    const isAuthorized = await checkAuthorization(user);
    if (isAuthorized) {
        initApp();
    }
});

function initApp() {
    document.getElementById('backToDashboard')?.addEventListener('click', () => window.location.href = 'centers.html');
    
    document.getElementById('addCenterBtn').addEventListener('click', () => openModal(null));
    document.getElementById('closeModalBtn').addEventListener('click', closeModal);
    document.getElementById('cancelBtn').addEventListener('click', closeModal);
    centerForm.addEventListener('submit', saveCenter);

    // NFC Buttons
    document.getElementById('readNfcBtn').addEventListener('click', readNfcTag);
    document.getElementById('writeNfcBtn').addEventListener('click', writeNfcTag);
    document.getElementById('clearNfcBtn').addEventListener('click', clearNfcUid);
    
    // Manual UID Input
    document.getElementById('manualNfcUid').addEventListener('input', (e) => {
        currentNfcUid = e.target.value.trim();
        updateNfcUi();
    });

    checkNfcSupport();
    loadCenters();
}

function loadCenters() {
    onValue(ref(db, 'centers'), (snapshot) => {
        centers = snapshot.val() || {};
        migrateCenterCoordinates(); // Auto-fix missing GPS
        renderCenters();
    });
}

// FIX: Auto-populate GPS for existing centers that are missing it
function migrateCenterCoordinates() {
    const knownCoords = {
        'Kumon Taipa Mei Keng': { lat: 22.15680419404832, lng: 113.55310261763758 },
        'Kumon Taipa Pac Tat': { lat: 22.15864298997591, lng: 113.54896029627456 },
        'Kumon Champs': { lat: 22.202188413699155, lng: 113.54954818278166 },
        'Kumon Tap Siac': { lat: 22.19974168219132, lng: 113.54570239996973 }
    };

    Object.entries(centers).forEach(([id, data]) => {
        if ((!data.lat || !data.lng) && knownCoords[data.name]) {
            console.log(`📍 Auto-migrating coordinates for ${data.name}`);
            update(ref(db, `centers/${id}`), {
                lat: knownCoords[data.name].lat,
                lng: knownCoords[data.name].lng
            });
        }
    });
}

function renderCenters() {
    centersGrid.innerHTML = '';
    
    if (Object.keys(centers).length === 0) {
        centersGrid.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color: var(--text-light);">No centers found. Click "Add New Center" to create one.</p>';
        return;
    }

    Object.entries(centers).forEach(([id, data]) => {
        const isDisabled = data.isDisabled === true;
        const card = document.createElement('div');
        card.className = `center-card-item ${isDisabled ? 'disabled' : ''}`;
        
        const statusBadge = isDisabled 
            ? `<span class="status-badge disabled">Disabled</span>` 
            : `<span class="status-badge active">Active</span>`;

        const nfcStatus = data.nfcUid 
            ? `<div class="nfc-status registered"><span>📡 UID:</span> <code>${data.nfcUid}</code></div>`
            : `<div class="nfc-status"><span>📡 No NFC Tag Registered</span></div>`;

        card.innerHTML = `
            <h3>${data.name || id} ${statusBadge}</h3>
            <p><strong>Address:</strong> ${data.address || '-'}</p>
            <p><strong>GPS:</strong> ${data.lat && data.lng ? `${data.lat}, ${data.lng}` : 'Not set'}</p>
            <p><strong>Phone:</strong> ${data.phone || '-'}</p>
            <p><strong>Hours:</strong> ${data.hours || '-'}</p>
            ${nfcStatus}
            <div class="actions">
                <button class="secondary edit-btn" data-id="${id}">Edit</button>
                <button class="${isDisabled ? 'success' : 'danger'} toggle-btn" data-id="${id}" data-disable="${!isDisabled}">
                    ${isDisabled ? 'Enable' : 'Disable'}
                </button>
            </div>
        `;
        centersGrid.appendChild(card);
    });

    // Attach event listeners
    document.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => openModal(e.target.dataset.id));
    });

    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => toggleCenterStatus(e.target.dataset.id, e.target.dataset.disable === 'true'));
    });
}

// ==========================================
// 3. MODAL & CRUD OPERATIONS
// ==========================================
function openModal(id) {
    centerForm.reset();
    currentNfcUid = '';
    
    if (id && centers[id]) {
        document.getElementById('modalTitle').textContent = 'Edit Center';
        document.getElementById('centerId').value = id;
        const c = centers[id];
        document.getElementById('centerName').value = c.name || '';
        document.getElementById('centerAddress').value = c.address || '';
        document.getElementById('centerLat').value = c.lat || '';
        document.getElementById('centerLng').value = c.lng || '';
        document.getElementById('centerPhone').value = c.phone || '';
        document.getElementById('centerHours').value = c.hours || '';
        
        currentNfcUid = c.nfcUid || '';
    } else {
        document.getElementById('modalTitle').textContent = 'Add Center';
        document.getElementById('centerId').value = '';
    }
    
    updateNfcUi();
    centerModal.classList.remove('hidden');
}

function closeModal() {
    centerModal.classList.add('hidden');
    // FIX: Abort NFC scan when closing modal to prevent background reading
    if (nfcAbortController) {
        nfcAbortController.abort();
        nfcAbortController = null;
    }
}

async function saveCenter(e) {
    e.preventDefault();
    const id = document.getElementById('centerId').value;
    const name = document.getElementById('centerName').value.trim();
    
    if (!name) return alert('Center Name is required.');

    const centerData = {
        name: name,
        address: document.getElementById('centerAddress').value.trim(),
        lat: parseFloat(document.getElementById('centerLat').value) || null,
        lng: parseFloat(document.getElementById('centerLng').value) || null,
        phone: document.getElementById('centerPhone').value.trim(),
        hours: document.getElementById('centerHours').value.trim(),
        nfcUid: currentNfcUid,
        updatedAt: new Date().toISOString()
    };

    try {
        if (id) {
            await update(ref(db, `centers/${id}`), centerData);
            alert('✅ Center updated successfully!');
        } else {
            const newId = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
            centerData.createdAt = new Date().toISOString();
            centerData.isDisabled = false;
            await set(ref(db, `centers/${newId}`), centerData);
            alert('✅ Center added successfully!');
        }
        closeModal();
    } catch (err) {
        console.error('Save error:', err);
        alert('❌ Failed to save center: ' + err.message);
    }
}

async function toggleCenterStatus(id, disable) {
    const action = disable ? 'disable' : 'enable';
    if (!confirm(`Are you sure you want to ${action} this center?`)) return;

    try {
        await update(ref(db, `centers/${id}`), { isDisabled: disable, updatedAt: new Date().toISOString() });
        alert(`✅ Center ${action}d.`);
    } catch (err) {
        alert('❌ Failed to update status.');
    }
}

// ==========================================
// 4. NFC FUNCTIONALITY (Web NFC API)
// ==========================================
function checkNfcSupport() {
    const isSupported = 'NDEFReader' in window;
    const warning = document.getElementById('nfcWarning');
    const readBtn = document.getElementById('readNfcBtn');
    const writeBtn = document.getElementById('writeNfcBtn');

    if (!isSupported) {
        warning.classList.remove('hidden');
        readBtn.disabled = true;
        writeBtn.disabled = true;
    }
}

function updateNfcUi() {
    const statusText = document.getElementById('nfcStatusText');
    const statusBox = document.getElementById('nfcStatusBox');
    const clearBtn = document.getElementById('clearNfcBtn');
    const manualInput = document.getElementById('manualNfcUid');

    if (currentNfcUid) {
        statusText.innerHTML = `📡 Registered UID: <code>${currentNfcUid}</code>`;
        statusBox.classList.add('registered');
        clearBtn.style.display = 'inline-flex';
    } else {
        statusText.textContent = 'No NFC tag registered';
        statusBox.classList.remove('registered');
        clearBtn.style.display = 'none';
    }

    // Sync manual input field
    if (manualInput && manualInput.value !== currentNfcUid) {
        manualInput.value = currentNfcUid;
    }
}

function clearNfcUid() {
    currentNfcUid = '';
    updateNfcUi();
}

async function readNfcTag() {
    if (!('NDEFReader' in window)) return alert('Web NFC not supported.');
    
    // FIX: Abort any existing scan before starting a new one
    if (nfcAbortController) {
        nfcAbortController.abort();
    }
    nfcAbortController = new AbortController();

    try {
        const reader = new NDEFReader();
        reader.onreading = (event) => {
            const uid = Array.from(event.serialNumber)
                .map(b => b.toString(16).padStart(2, '0'))
                .join(':')
                .toUpperCase();
            
            currentNfcUid = uid;
            updateNfcUi();
            alert(`✅ Successfully read NFC Tag!\nUID: ${uid}`);
            
            // Stop scanning after successful read
            if (nfcAbortController) nfcAbortController.abort();
        };
        
        reader.onreadingerror = () => {
            alert('❌ Cannot read data from this NFC tag.');
        };

        // Pass the abort signal to the scan method
        await reader.scan({ signal: nfcAbortController.signal });
    } catch (err) {
        if (err.name === 'AbortError') return; // Ignore manual aborts
        if (err.name === 'NotAllowedError') {
            alert('⚠️ NFC permission denied. Please allow NFC access in your browser settings.');
        } else {
            alert('❌ NFC Scan failed: ' + err.message);
        }
    }
}

async function writeNfcTag() {
    if (!('NDEFWriter' in window)) return alert('Web NFC not supported.');
    
    const centerId = document.getElementById('centerId').value;
    const centerName = document.getElementById('centerName').value.trim();
    
    if (!centerId && !centerName) {
        return alert('⚠️ Please save the center details first before writing to an NFC tag.');
    }

    const payload = `KUMON_CENTER:${centerId || centerName.toLowerCase().replace(/\s+/g, '-')}`;

    try {
        const writer = new NDEFWriter();
        await writer.write({
            records: [{ recordType: "text", data: payload }]
        });
        alert(`✅ Successfully wrote to NFC Tag!\nData: ${payload}`);
    } catch (err) {
        if (err.name === 'NotAllowedError') {
            alert('⚠️ NFC permission denied.');
        } else {
            alert('❌ NFC Write failed: ' + err.message);
        }
    }
}