import { auth, db, logout } from './auth.js';
import { ref, get, push, remove, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'attendance';

// 🔐 PERMISSION CHECK
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        const userSnap = await get(ref(db, `users/${user.uid}`));
        if (!userSnap.exists()) {
            window.location.href = 'index.html';
            return;
        }

        const userData = userSnap.val();
        const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
        const dashPerms = userData.permissions?.dashboardCards || {};

        const hasAccess = isAdmin || dashPerms[REQUIRED_PERMISSION] === true;

        if (hasAccess) {
            // ✅ ALLOWED: Show content, hide error
            document.getElementById('accessDenied')?.classList.add('hidden');
            document.getElementById('mainContent')?.classList.remove('hidden');
            initializeAttendance();
        } else {
            //  BLOCKED: Hide content, show error
            document.getElementById('accessDenied')?.classList.remove('hidden');
            document.getElementById('mainContent')?.classList.add('hidden');
            document.getElementById('page-loader')?.classList.add('hidden');

            document.getElementById('backToDashboardBtn')?.addEventListener('click', () => {
                window.location.href = 'dashboard.html'; 
            });
        }
    } catch (err) {
        console.error("Permission check error:", err);
        window.location.href = 'index.html';
    }
});

// ==========================================
// 📄 MAIN APP LOGIC (Only runs if authorized)
// ==========================================
function initializeAttendance() {
    const centerId = sessionStorage.getItem('selectedCenter');
    if (!centerId) { console.error('❌ No center selected'); window.location.href = 'dashboard.html'; }
    const attendanceRef = ref(db, `centers/${centerId}/attendance`);
    const studentsRef = ref(db, `centers/${centerId}/students`);
    let allAttendanceData = [];
    let filteredAttendanceData = [];
    let html5QrCode = null;
    let scannerActive = false;
    let scannedStudentData = null;

    // 📷 SCANNER LIFECYCLE
    async function cleanupScanner() {
        if (html5QrCode) {
            try { await html5QrCode.stop(); } catch(e) { console.warn('️ Scanner stop warning:', e); }
            html5QrCode = null;
        }
        const readerDiv = document.getElementById('qr-reader');
        if (readerDiv) readerDiv.innerHTML = '';
        scannerActive = false;
    }

    function hideScanModal() {
        const sm = document.getElementById('scanModal');
        if (sm) { sm.classList.add('hidden'); sm.style.display = 'none'; }
    }

    function hideConfirmModal() {
        const cm = document.getElementById('confirmModal');
        if (cm) { cm.classList.add('hidden'); cm.style.display = 'none'; }
    }

    async function startScanner() {
        const modal = document.getElementById('scanModal');
        const status = document.getElementById('qr-status') || document.getElementById('scanStatus');
        const readerDiv = document.getElementById('qr-reader');
        if (!modal || !status || !readerDiv) { console.error('❌ Missing Scanner UI elements'); return; }
        if (typeof Html5Qrcode === 'undefined') {
            status.innerHTML = `<span style="color:#dc3545">❌ html5-qrcode library not loaded</span>`;
            modal.classList.remove('hidden'); return;
        }

        await cleanupScanner();
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
        status.textContent = '📷 Starting camera...';

        try {
            html5QrCode = new Html5Qrcode("qr-reader");
            await html5QrCode.start(
                { facingMode: "environment" },
                { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
                async (decodedText) => {
                    const cleanValue = decodedText.trim();
                    await cleanupScanner();
                    hideScanModal();
                    
                    const confirmModal = document.getElementById('confirmModal');
                    if (confirmModal) { confirmModal.classList.remove('hidden'); confirmModal.style.display = 'flex'; }
                    
                    const infoDiv = document.getElementById('studentInfo');
                    const subDiv = document.getElementById('subjectCheckboxes');
                    const btn = document.getElementById('confirmAttendanceBtn');
                    
                    if (infoDiv) infoDiv.textContent = '🔍 Looking up student...';
                    if (subDiv) subDiv.innerHTML = '';
                    if (btn) { btn.style.display = 'none'; btn.disabled = true; }
                    
                    try { await processScanResult(cleanValue, infoDiv, subDiv, btn); } 
                    catch (err) {
                        console.error('❌ Scan processing failed:', err);
                        if (infoDiv) infoDiv.innerHTML = `<span style="color:#dc3545">❌ ${err.message}</span>`;
                    }
                },
                () => {}
            );
            status.textContent = '✅ Camera ready. Point at QR...';
            scannerActive = true;
        } catch (err) {
            console.error('❌ Scanner init failed:', err);
            status.innerHTML = `<span style="color:#dc3545">❌ Camera: ${err.message}</span>`;
        }
    }

    async function stopScanner() {
        await cleanupScanner();
        hideScanModal();
    }

    // 🔍 CORE SCAN PROCESSOR
    async function processScanResult(scannedValue, infoDiv, subDiv, confirmBtn) {
        console.log('🚀 Fetching student data...');
        const snapshot = await get(studentsRef);
        let student = null;
        snapshot.forEach(child => {
            const s = child.val();
            if (child.key === scannedValue || s.studentNumber === scannedValue || s.qrCode === scannedValue) {
                student = { ...s, id: child.key };
            }
        });

        if (!student) throw new Error('Student not found in database');

        scannedStudentData = student;
        const activeSubjects = (student.subjects || []).filter(s => s && s.status === 'current' && s.name);
        if (activeSubjects.length === 0) throw new Error('No active subjects for this student.');

        const now = new Date();
        const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const todayDay = dayNames[now.getDay()];

        if (infoDiv) {
            infoDiv.innerHTML = `
                <div style="background:#f8fafc; padding:0.75rem; border-radius:8px; border:1px solid #e2e8f0;">
                    <h3 style="margin:0 0 0.3rem; font-size:1.1rem; font-weight:700;"> ${student.nameCn || 'N/A'}</h3>
                    <div style="display:flex; flex-wrap:wrap; gap:0.25rem 0.75rem; font-size:0.85rem; color:#475569;">
                        <span><strong>Nickname:</strong> ${student.nickname || '-'}</span>
                        <span><strong>Grade:</strong> ${student.grade || '-'}</span>
                        <span><strong>School:</strong> ${student.school || '-'}</span>
                    </div>
                </div>`;
        }

        let html = '<div style="border:1px solid #e2e8f0; border-radius:8px; max-height:260px; overflow-y:auto; background:#fff;">';
        for (let i = 0; i < activeSubjects.length; i++) {
            const sub = activeSubjects[i];
            try {
                const slots = Array.isArray(sub.timeslots) ? sub.timeslots : [];
                const fullSchedule = slots.length > 0
                    ? slots.map(t => `${t.day?.substring(0,3) || '???'} ${t.time || '--:--'}`).join(', ')
                    : 'No schedule set';
                
                const todaySlot = slots.find(t => t.day?.toLowerCase() === todayDay.toLowerCase());
                const todayTime = todaySlot?.time || 'N/A';
                const status = calculateStatus(todayTime, now);
                const color = getStatusColor(status);
                const isLast = i === activeSubjects.length - 1;

                html += `
                    <label style="display:flex; align-items:center; gap:0.4rem; padding:0.35rem 0.5rem; border-bottom:${isLast ? 'none' : '1px solid #f1f5f9'}; cursor:pointer;">
                        <input type="checkbox" class="att-subject-check" value="${sub.name.trim()}" data-status="${status}" data-scheduled="${fullSchedule}" checked style="transform:scale(1.1); accent-color:#4682B4; margin:0 !important; padding:0 !important; flex-shrink:0; width:16px; height:16px;">
                        <div style="flex:1; min-width:0; line-height:1.3;">
                            <div style="font-weight:600; color:#1e293b; font-size:0.88rem;">
                                ${sub.name} <span style="color:#64748b; font-weight:400;">(${sub.currentLevel || sub.startLevel || '?'})</span>
                            </div>
                            <div style="font-size:0.75rem; color:#64748b; margin-top:1px;">
                                🕒 ${fullSchedule} <br>
                                Today: ${todayDay} ${todayTime} | Status: <span style="color:${color}; font-weight:600;">${status}</span>
                            </div>
                        </div>
                    </label>
                `;
            } catch (err) {
                console.error(`❌ Failed to render subject "${sub?.name}":`, err);
            }
        }
        html += '</div>';

        if (subDiv) subDiv.innerHTML = html;
        if (confirmBtn) { 
            confirmBtn.disabled = false; 
            confirmBtn.style.display = 'inline-flex'; 
        }
    }

    // ⏱️ STATUS LOGIC
    function calculateStatus(timeStr, now) {
        if (!timeStr || timeStr === 'N/A' || timeStr === 'No schedule set') return 'Not Today';
        const parts = timeStr.split(':');
        if (parts.length < 2) return 'Not Today';
        const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
        if (isNaN(h) || isNaN(m)) return 'Not Today';
        const sched = new Date(now); sched.setHours(h, m, 0, 0);
        const diff = (now - sched) / 60000;
        if (diff < -15) return 'Early';
        if (diff > 15) return 'Late';
        return 'On Time';
    }

    function getStatusColor(s) {
        return { 'On Time':'#10b981', 'Early':'#f59e0b', 'Late':'#ef4444', 'Not Today':'#6b7280' }[s] || '#666';
    }

    // ✅ RECORD ATTENDANCE
    async function recordAttendance() {
        const checks = document.querySelectorAll('.att-subject-check:checked');
        if (checks.length === 0) return alert('⚠️ Select at least one subject.');
        const btn = document.getElementById('confirmAttendanceBtn');
        const orig = btn?.textContent || 'Confirm';
        if(btn) { btn.disabled = true; btn.textContent = '⏳ Saving...'; }

        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const checkInTime = now.toISOString();

        try {
            const saves = Array.from(checks).map(cb => push(attendanceRef, {
                studentId: String(scannedStudentData.id || ''),
                studentNumber: String(scannedStudentData.studentNumber || ''),
                nameCn: String(scannedStudentData.nameCn || '-'),
                nickname: String(scannedStudentData.nickname || '-'),
                grade: String(scannedStudentData.grade || '-'),
                school: String(scannedStudentData.school || '-'),
                subject: String(cb.value.trim()),
                scheduledTime: String(cb.dataset.scheduled || 'No schedule set'),
                checkInTime: String(checkInTime),
                date: String(dateStr),
                status: String(cb.dataset.status || ''),
                timestamp: serverTimestamp()
            }));
            
            await Promise.all(saves);
            hideConfirmModal(); hideScanModal(); scannedStudentData = null;
            await loadAttendanceData();
        } catch (err) {
            console.error(' Save failed:', err);
            alert('❌ Failed: ' + err.message);
        } finally {
            if(btn) { btn.disabled = false; btn.textContent = orig; }
        }
    }

    // 📊 DATA & RENDERING
    async function loadAttendanceData() {
        try {
            const snap = await get(attendanceRef);
            allAttendanceData = [];
            if (snap.exists()) {
                snap.forEach(c => {
                    const record = { ...c.val(), id: c.key };
                    allAttendanceData.push(record);
                });
            }
            populateSubjectFilter();
            filterAndRender();
        } catch (err) {
            console.error('❌ Load error:', err);
        }
    }

    function populateSubjectFilter() {
        const sel = document.getElementById('attendanceSubject');
        if (!sel) return;
        const curVal = sel.value || 'All';
        sel.innerHTML = '';
        const subs = new Set(['All', 'Math', 'Chinese (Trad)', 'Chinese (Simp)', 'English ERP', 'English EFL']);
        allAttendanceData.forEach(r => { if (r.subject) subs.add(r.subject.trim()); });
        Array.from(subs).sort().forEach(s => {
            const o = document.createElement('option'); o.value = s; o.textContent = s;
            if (s === curVal) o.selected = true;
            sel.appendChild(o);
        });
    }

    function filterAndRender() {
        const dateInput = document.getElementById('attendanceDate');
        const d = dateInput?.value || new Date().toISOString().split('T')[0];
        const s = (document.getElementById('attendanceSubject')?.value || 'All').trim();
        const q = document.getElementById('searchStudent')?.value?.toLowerCase() || '';
        filteredAttendanceData = allAttendanceData.filter(r => {
            if (r.date !== d) return false;
            const rSubject = (r.subject || '').trim();
            if (s !== 'All' && rSubject !== s) return false;
            if (q) {
                const searchable = [r.nameCn, r.nickname, r.studentNumber, r.grade, r.school, rSubject].filter(v => v).join(' ').toLowerCase();
                return searchable.includes(q);
            }
            return true;
        });
        renderTable();
    }

    function renderTable() {
        const tbody = document.getElementById('attendanceBody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!filteredAttendanceData.length) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:1rem; color:#666;">No records found for this date.</td></tr>';
            return;
        }

        filteredAttendanceData.sort((a,b) => b.checkInTime.localeCompare(a.checkInTime));
        const colors = { 'On Time':'#dcfce7,#166534', 'Early':'#fef3c7,#92400e', 'Late':'#fee2e2,#991b1b', 'Not Today':'#f3f4f6,#374151' };

        filteredAttendanceData.forEach(r => {
            const [bg, txt] = (colors[r.status] || ['#eee','#333']).split(',');
            const schedDisplay = r.scheduledTime && r.scheduledTime !== 'N/A' ? r.scheduledTime : '<span style="color:#999;font-style:italic">No schedule set</span>';
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${r.subject || '-'}</td>
                <td>${r.nameCn || '-'}</td>
                <td>${r.nickname || '-'}</td>
                <td>${r.grade || '-'}</td>
                <td>${r.school || '-'}</td>
                <td style="font-weight:600; font-size:0.85rem;">${schedDisplay}</td>
                <td>${formatTime(r.checkInTime)}</td>
                <td><span style="background:${bg};color:${txt};padding:0.25rem 0.5rem;border-radius:4px;font-weight:600;font-size:0.85rem;">${r.status || '-'}</span></td>
                <td><button type="button" class="delete-att-btn" data-id="${r.id}" style="cursor:pointer; background:none; border:none; font-size:1.2rem;">🗑️</button></td>
            `;
            tbody.appendChild(tr);
        });
    }

    function formatTime(iso) {
        try { return new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
        catch { return '-'; }
    }

    // 🔌 EVENT LISTENERS (Run immediately since DOM is already loaded)
    const d = document.getElementById('attendanceDate');
    if (d) d.value = new Date().toISOString().split('T')[0];
    loadAttendanceData();
    d?.addEventListener('change', () => filterAndRender());
    document.getElementById('attendanceSubject')?.addEventListener('change', filterAndRender);
    document.getElementById('searchStudent')?.addEventListener('input', filterAndRender);
    document.getElementById('scanQrBtn')?.addEventListener('click', startScanner);
    document.getElementById('closeScanModal')?.addEventListener('click', stopScanner);
    document.getElementById('confirmAttendanceBtn')?.addEventListener('click', recordAttendance);
    document.getElementById('cancelConfirmBtn')?.addEventListener('click', () => { hideConfirmModal(); hideScanModal(); scannedStudentData = null; });

    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.delete-att-btn');
        if (btn) {
            const id = btn.dataset.id;
            if (!id) return console.warn('⚠️ Missing data-id');
            if (confirm('Delete this record?')) {
                btn.disabled = true; btn.innerHTML = '';
                try { await remove(ref(db, `centers/${centerId}/attendance/${id}`)); await loadAttendanceData(); }
                catch(err) { alert('Delete failed: ' + err.message); btn.disabled = false; btn.innerHTML = '🗑️'; }
            }
        }
    });

    document.addEventListener('keydown', e => { if (e.key === 'Escape') { stopScanner(); hideConfirmModal(); } });
    window.addEventListener('beforeunload', async () => { await cleanupScanner(); });
}