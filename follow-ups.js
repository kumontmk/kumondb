import { auth, db } from './auth.js';
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'followUps';
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const GRADE_ORDER = ['K0','K1','K2','K3','1','2','3','4','5','6','7','8','9','10','11','12','13','Over F6'];
const CENTER_ABBREVIATIONS = [
    { match: 'pac tat',  abbr: 'PT' },
    { match: 'mei keng', abbr: 'MK' },
    { match: 'tap siac', abbr: 'TS' },
    { match: 'champs',   abbr: 'C'  }
];
// Single-value DT date fields checked on the student and on each subject
const DT_DATE_KEYS = ['dtDate', 'diagnosticDate', 'diagnosticTestDate', 'testDate', 'dt', 'diagnostic'];
// Lists that hold the Diagnostic Test entries from the DT & AT tab
const DT_ARRAY_KEYS = ['diagnosticTests', 'dtTests', 'diagnostics', 'dts', 'dt', 'diagnostic'];
// Date field names inside each Diagnostic Test entry
const DT_ENTRY_DATE_KEYS = ['date', 'diagnosticDate', 'dtDate', 'testDate'];

let poInitialized = false;

// 🔐 PERMISSION CHECK (unchanged behaviour)
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'index.html'; return; }
    try {
        const userSnap = await get(ref(db, `users/${user.uid}`));
        if (!userSnap.exists()) { window.location.href = 'index.html'; return; }
        const userData = userSnap.val();
        const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
        const dashPerms = userData.permissions?.dashboardCards || {};
        const hasAccess = isAdmin || dashPerms[REQUIRED_PERMISSION] === true;
        if (hasAccess) {
            document.getElementById('accessDenied')?.classList.add('hidden');
            document.getElementById('mainContent')?.classList.remove('hidden');
            if (!poInitialized) {
                poInitialized = true;
                initializePOReport();
            }
        } else {
            document.getElementById('accessDenied')?.classList.remove('hidden');
            document.getElementById('mainContent')?.classList.add('hidden');
            document.getElementById('page-loader')?.classList.add('hidden');
        }
    } catch (err) {
        console.error("Permission check error:", err);
        window.location.href = 'index.html';
    }
});

function initializePOReport() {
    const $ = (id) => document.getElementById(id);
    const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const sessionCenterId = sessionStorage.getItem('selectedCenter') || '';
    const defaultCenter = sessionCenterId || 'all';

    const centerSelect = $('centerSelect');
    const searchInput = $('searchInput');
    const exportBtn = $('exportBtn');
    const loadStatus = $('loadStatus');
    const thead = $('poTableHead');
    const tbody = $('poTableBody');

    let centers = [];
    let allRows = [];
    let currentView = [];
    let currentScope = 'all';
    let statusFilter = 'enrolledNoPo';   // default view: Enrolled · No PO
    let sortKey = 'inquiryDate';
    let sortDir = 1;
    let isFetching = false;
    let centerInitialized = false;
    let searchTimeout = null;
    let toastTimeout = null;

    // ---------- inline editing state ----------
    let pending = {};      // studentId -> { field: newValue }
    let saving = false;

    // ---------- PO confirm modal state ----------
    let modalSid = null;
    let modalPo = 'no';

    function todayIso() {
        const d = new Date();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    }
    function savedVal(r, f) {
        switch (f) {
            case 'inquiryDate': return r.inquiryDate || '';
            case 'school':      return r.school || '';
            case 'grade':       return r.grade || '';
            case 'po':          return r.po;
            case 'poDate':      return r.poDate || '';
            case 'comments':    return r.poComments || '';
        }
        return '';
    }
    function effVal(r, f) {
        const p = pending[r.id];
        return (p && f in p) ? p[f] : savedVal(r, f);
    }
    function isDirty(r, f) {
        const p = pending[r.id];
        return !!p && f in p && p[f] !== savedVal(r, f);
    }
    function pendingStats() {
        let fields = 0, students = 0;
        for (const sid in pending) {
            const n = Object.keys(pending[sid]).length;
            if (n) { students++; fields += n; }
        }
        return { fields, students };
    }
    function updateSaveBar() {
        const bar = $('poSaveBar');
        if (!bar) return;
        const { fields, students } = pendingStats();
        if (!fields) { bar.classList.add('hidden'); return; }
        bar.classList.remove('hidden');
        setText('poSaveText', `${fields} unsaved edit${fields === 1 ? '' : 's'} · ${students} student${students === 1 ? '' : 's'}`);
        const sb = $('poSaveBtn'), db2 = $('poDiscardBtn');
        if (sb) sb.disabled = saving;
        if (db2) db2.disabled = saving;
    }
    function commitEdit(sid, field, rawValue) {
        const r = allRows.find(x => x.id === sid);
        if (!r) return;
        let v = rawValue;
        if (field === 'school' || field === 'comments') v = String(v).trim();
        if (field === 'po') v = (v === 'yes') ? 'yes' : 'no';
        const p = pending[sid] || (pending[sid] = {});
        if (v === savedVal(r, field)) delete p[field];
        else p[field] = v;
        if (!Object.keys(p).length) delete pending[sid];
        renderTable(currentView, currentScope);
        updateSaveBar();
    }

    // ---------- PO modal ----------
    function syncModalOpts() {
        document.querySelectorAll('#poModalStatus .po-modal-opt').forEach(b => {
            const on = b.dataset.po === modalPo;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        const d = $('poModalDate');
        if (d) d.disabled = modalPo !== 'yes';
    }
    function openPoModal(r) {
        modalSid = r.id;
        modalPo = effVal(r, 'po');
        setText('poModalName', r.nameCn || r.namePinyin || 'Unknown');
        const d = $('poModalDate');
        if (d) d.value = effVal(r, 'poDate') || (modalPo === 'yes' ? todayIso() : '');
        syncModalOpts();
        $('poModal')?.classList.remove('hidden');
        if (d && !d.disabled) d.focus();
    }
    function closePoModal() {
        modalSid = null;
        $('poModal')?.classList.add('hidden');
    }
    function confirmPoModal() {
        const r = allRows.find(x => x.id === modalSid);
        if (!r) { closePoModal(); return; }
        const d = $('poModalDate');
        const dateVal = modalPo === 'yes' ? (d?.value || '') : '';
        const p = pending[r.id] || (pending[r.id] = {});
        if (modalPo === savedVal(r, 'po')) delete p.po; else p.po = modalPo;
        if (dateVal === savedVal(r, 'poDate')) delete p.poDate; else p.poDate = dateVal;
        if (!Object.keys(p).length) delete pending[r.id];
        closePoModal();
        renderTable(currentView, currentScope);
        updateSaveBar();
    }

    function startEdit(btn) {
        const sid = btn.dataset.sid;
        const field = btn.dataset.field;
        const r = allRows.find(x => x.id === sid);
        if (!r) return;
        if (field === 'po') { openPoModal(r); return; }
        const cur = effVal(r, field);
        let input;
        if (field === 'grade') {
            input = document.createElement('select');
            input.innerHTML = `<option value="">—</option>` + GRADE_ORDER.map(g => `<option value="${g}">${g}</option>`).join('');
            input.value = cur;
        } else if (field === 'inquiryDate') {
            input = document.createElement('input');
            input.type = 'date';
            input.value = cur;
        } else {
            input = document.createElement('input');
            input.type = 'text';
            input.value = cur;
        }
        input.className = 'po-inline-input';
        btn.replaceWith(input);
        input.focus();
        if (input.select) input.select();
        let done = false;
        const commit = () => { if (done) return; done = true; commitEdit(sid, field, input.value); };
        const cancel = () => { if (done) return; done = true; renderTable(currentView, currentScope); updateSaveBar(); };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        if (input.tagName === 'SELECT' || input.type === 'date') input.addEventListener('change', commit);
    }
    async function saveEdits() {
        if (saving) return;
        const { fields } = pendingStats();
        if (!fields) return;
        saving = true;
        const sb = $('poSaveBtn'), db2 = $('poDiscardBtn');
        if (sb) { sb.disabled = true; sb.textContent = 'Saving…'; }
        if (db2) db2.disabled = true;
        const updates = {};
        const touched = [];
        for (const sid in pending) {
            const r = allRows.find(x => x.id === sid);
            if (!r) continue;
            const p = pending[sid];
            const base = `centers/${r.centerId}/students/${sid}/`;
            const effPo = ('po' in p) ? p.po : r.po;
            if ('inquiryDate' in p) updates[base + 'inquiryDate'] = p.inquiryDate;
            if ('school' in p)      updates[base + 'school'] = p.school;
            if ('grade' in p)       updates[base + 'grade'] = p.grade;
            if ('po' in p)          updates[base + 'parentOrientation'] = (p.po === 'yes' ? 'Yes' : 'No');
            if ('poDate' in p)      updates[base + 'poDate'] = p.poDate;
            if ('comments' in p)    updates[base + (effPo === 'yes' ? 'poNote' : 'poReason')] = p.comments;
            touched.push({ r, p });
        }
        try {
            await update(ref(db), updates);
            touched.forEach(({ r, p }) => {
                if ('inquiryDate' in p) { r.inquiryDate = p.inquiryDate; r.inquiryIsDt = false; }
                if ('school' in p) r.school = p.school;
                if ('grade' in p) r.grade = p.grade;
                if ('po' in p) r.po = p.po;
                if ('poDate' in p) r.poDate = p.poDate;
                if ('comments' in p) {
                    r.poComments = p.comments;
                    r.comments = [r.studyState, p.comments].filter(Boolean).join(' — ');
                }
            });
            pending = {};
            buildView();
            showToast(`💾 Saved ${fields} change${fields === 1 ? '' : 's'} to the database.`, 'ok');
        } catch (err) {
            console.error('PO save error:', err);
            showToast('⚠ Save failed — ' + err.message, 'err', 5000);
        } finally {
            saving = false;
            if (sb) { sb.disabled = false; sb.textContent = '💾 Save changes'; }
            if (db2) db2.disabled = false;
            updateSaveBar();
        }
    }
    function discardEdits() {
        pending = {};
        renderTable(currentView, currentScope);
        updateSaveBar();
        showToast('Edits discarded.');
    }

    // ---------- helpers ----------
    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        }[c]));
    }
    function safeArray(val) {
        if (Array.isArray(val)) return val;
        if (val && typeof val === 'object') return Object.values(val);
        return [];
    }
    function fmtDate(iso) {
        if (!iso) return '';
        const p = String(iso).split('-');
        if (p.length !== 3) return String(iso);
        const m = parseInt(p[1], 10);
        if (!m || m < 1 || m > 12) return String(iso);
        return `${parseInt(p[2], 10)}-${MONTH_SHORT[m - 1]}-${p[0]}`;
    }
    function getCenterAbbr(name) {
        if (!name) return '';
        const lower = name.toLowerCase();
        const rule = CENTER_ABBREVIATIONS.find(r => lower.includes(r.match));
        if (rule) return rule.abbr;
        const stripped = name.replace(/^kumon[\s.-]*/i, '').trim();
        return (stripped || name).substring(0, 2).toUpperCase();
    }
    function letterFor(name) {
        if (!name) return null;
        if (name.includes('Math')) return 'M';
        if (name.includes('ERP')) return 'R';
        if (name.includes('EFL')) return 'L';
        if (name.includes('Chinese')) return 'C';
        return null;
    }
    function gradeIdx(g) {
        const i = GRADE_ORDER.indexOf(g);
        return i === -1 ? 999 : i;
    }
    function nameKey(r) {
        return (r.namePinyin || r.nameCn || '').toLowerCase();
    }
    // Earliest Diagnostic Test date: reads single date fields AND every entry
    // in the Diagnostic Tests list (DT & AT tab), on the student and each subject.
    function pickDtDate(s, subs) {
        const found = [];
        const pushDate = (v) => {
            if (typeof v === 'string' && v.trim()) found.push(v.trim());
            else if (v && typeof v === 'object' && typeof v.date === 'string' && v.date.trim()) found.push(v.date.trim());
        };
        const collect = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            DT_DATE_KEYS.forEach(k => pushDate(obj[k]));
            DT_ARRAY_KEYS.forEach(k => {
                const list = obj[k];
                if (!list) return;
                safeArray(list).forEach(entry => {
                    if (typeof entry === 'string') { pushDate(entry); return; }
                    if (entry && typeof entry === 'object') {
                        DT_ENTRY_DATE_KEYS.forEach(dk => pushDate(entry[dk]));
                    }
                });
            });
        };
        collect(s);
        subs.forEach(collect);
        found.sort();
        return found[0] || '';
    }
    function showToast(message, type = '', duration = 3500) {
        const toast = $('toast');
        if (!toast) return;
        if (toastTimeout) clearTimeout(toastTimeout);
        toast.className = 'toast';
        if (type) toast.classList.add(type);
        toast.textContent = message;
        toast.classList.remove('hidden');
        toastTimeout = setTimeout(() => toast.classList.add('hidden'), duration);
    }

    // ---------- data ----------
    function deriveRow(id, centerId, centerName, s) {
        const subs = safeArray(s.subjects).filter(sub => sub && sub.name);
        // 🚫 Students with no subjects listed are excluded from the report entirely
        if (!subs.length) return null;

        const subjects = { M: false, R: false, L: false, C: false };
        const subjInfo = { M: [], R: [], L: [], C: [] };
        let hasEnrol = false;
        // A manually saved inquiry date (student-level) wins over subject dates
        const manualInquiry = (typeof s.inquiryDate === 'string' && s.inquiryDate.trim()) ? s.inquiryDate.trim() : '';
        let inquiryDate = manualInquiry;
        let activeCount = 0, pauseCount = 0, dropCount = 0, completerCount = 0;

        subs.forEach(sub => {
            const st = sub.status || 'current';
            if (st === 'pause') pauseCount++;
            else if (st === 'drop') dropCount++;
            else if (st === 'completer') completerCount++;
            else activeCount++;
            if (sub.enrolDate || ['current', 'pause', 'completer'].includes(st)) hasEnrol = true;
            if (!manualInquiry && sub.inquiryDate && (!inquiryDate || sub.inquiryDate < inquiryDate)) inquiryDate = sub.inquiryDate;
            if (st === 'drop') return;
            const k = letterFor(sub.name);
            if (!k) return;
            subjects[k] = true;
            const lvl = sub.currentLevel || sub.startLevel || '-';
            subjInfo[k].push(`${sub.name} ${lvl} (${st})`);
        });

        // 🚫 Completers are excluded: at least one completed subject and nothing active or paused
        if (completerCount > 0 && activeCount === 0 && pauseCount === 0) return null;

        // Paused / Dropped label: only when no subject is still active
        const studyState = activeCount === 0
            ? (pauseCount > 0 ? 'Paused' : 'Dropped')
            : '';

        // Inquiry date fallback: use the DT date when no inquiry date exists
        const dtDate = pickDtDate(s, subs);
        const inquiryIsDt = !inquiryDate && !!dtDate;
        if (inquiryIsDt) inquiryDate = dtDate;

        const po = s.parentOrientation === 'Yes' ? 'yes' : 'no';
        const poDate = s.poDate || '';
        const poComments = po === 'yes'
            ? [poDate ? `PO ${fmtDate(poDate)}` : '', (s.poNote || '').trim()].filter(Boolean).join(' — ')
            : (s.poReason || '').trim();
        const comments = [studyState, poComments].filter(Boolean).join(' — ');
        const phone = typeof s.phone === 'string'
            ? s.phone.trim()
            : [s.phone?.mom, s.phone?.dad, s.phone?.own]
                .map(v => (v || '').trim()).filter(Boolean).join(' / ');
        const nameCn = s.nameCn || '';
        const namePinyin = s.namePinyin || s.name || '';
        const school = s.school || '';
        const grade = s.grade || '';
        const abbr = getCenterAbbr(centerName);

        const searchBlob = [
            nameCn, namePinyin, s.nickname || '', phone, school, grade,
            centerName, abbr, studyState, s.poReason || '', s.poNote || '',
            ...Object.values(subjInfo).flat()
        ].join(' ').toLowerCase();

        return {
            id, centerId, centerName, abbr,
            nameCn, namePinyin, phone, school, grade,
            inquiryDate, inquiryIsDt, subjects, subjInfo, hasEnrol,
            studyState, po, poDate, poComments, comments, searchBlob
        };
    }

    async function fetchAll() {
        if (isFetching) return;
        isFetching = true;
        loadStatus.className = 'status-chip';
        loadStatus.textContent = '⏳ Loading all centers…';
        try {
            const snap = await get(ref(db, 'centers'));
            centers = [];
            allRows = [];
            if (snap.exists()) {
                snap.forEach(centerChild => {
                    const cId = centerChild.key;
                    const cVal = centerChild.val() || {};
                    // 🚫 Disabled centers (same flag Center Management uses) are hidden entirely
                    if (cVal.isDisabled === true) return;
                    const cName = cVal.name || cId;
                    centers.push({ id: cId, name: cName });
                    Object.entries(cVal.students || {}).forEach(([sId, s]) => {
                        const row = deriveRow(sId, cId, cName, s || {});
                        if (row) allRows.push(row);
                    });
                });
            }
            centers.sort((a, b) => a.name.localeCompare(b.name));
            populateCenterSelect();
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            loadStatus.className = 'status-chip ok';
            loadStatus.textContent = `✓ ${allRows.length} students · ${centers.length} centers · ${time}`;
            buildView();
        } catch (err) {
            console.error('PO report load error:', err);
            loadStatus.className = 'status-chip err';
            loadStatus.textContent = '⚠ Load failed — tap to retry';
            tbody.innerHTML = `<tr><td colspan="14" class="empty-state">❌ ${esc(err.message)}</td></tr>`;
        } finally {
            isFetching = false;
            $('page-loader')?.classList.add('hidden');
        }
    }

    function populateCenterSelect() {
        const prev = centerInitialized ? centerSelect.value : '';
        let opts = `<option value="all">🌐 All Centers</option>`;
        centers.forEach(c => {
            opts += `<option value="${esc(c.id)}">${esc(c.name)}</option>`;
        });
        centerSelect.innerHTML = opts;
        const wanted = prev || defaultCenter;
        const valid = wanted === 'all' || centers.some(c => c.id === wanted);
        centerSelect.value = valid ? wanted : 'all';
        centerInitialized = true;
    }

    // ---------- filtering / sorting ----------
    function getSubjectSelection() {
        return Array.from(document.querySelectorAll('.po-subj-cb:checked')).map(cb => cb.dataset.subj);
    }
    function statusMatch(r, filter) {
        if (filter === 'enrolledNoPo') return r.hasEnrol && r.po !== 'yes';
        if (filter === 'inquiryNoPo') return !r.hasEnrol && r.po !== 'yes';
        if (filter === 'done') return r.po === 'yes';
        return true;
    }
    function cmp(a, b) {
        let r = 0;
        switch (sortKey) {
            case 'inquiryDate': {
                const av = a.inquiryDate || '', bv = b.inquiryDate || '';
                if (!av && !bv) r = 0;
                else if (!av) return 1;   // missing dates always last
                else if (!bv) return -1;
                else r = av.localeCompare(bv) * sortDir;
                break;
            }
            case 'name':   r = nameKey(a).localeCompare(nameKey(b)) * sortDir; break;
            case 'school': r = (a.school || '').localeCompare(b.school || '') * sortDir; break;
            case 'grade':  r = (gradeIdx(a.grade) - gradeIdx(b.grade)) * sortDir; break;
            case 'po':     r = ((a.po === 'yes' ? 1 : 0) - (b.po === 'yes' ? 1 : 0)) * sortDir; break;
            case 'center': r = a.centerName.localeCompare(b.centerName) * sortDir; break;
        }
        if (r === 0) r = nameKey(a).localeCompare(nameKey(b));
        return r;
    }
    function buildView() {
        const scope = centerSelect.value || 'all';
        const term = searchInput.value.trim().toLowerCase();
        const subjSel = getSubjectSelection();
        const base = allRows.filter(r =>
            (scope === 'all' || r.centerId === scope) &&
            (!subjSel.length || subjSel.some(k => r.subjects[k])) &&
            (!term || r.searchBlob.includes(term))
        );
        const counts = {
            all: base.length,
            enrolledNoPo: base.filter(r => statusMatch(r, 'enrolledNoPo')).length,
            inquiryNoPo: base.filter(r => statusMatch(r, 'inquiryNoPo')).length,
            done: base.filter(r => statusMatch(r, 'done')).length
        };
        currentView = base.filter(r => statusMatch(r, statusFilter)).sort(cmp);
        currentScope = scope;
        renderSummary(counts);
        renderChips(counts);
        renderTable(currentView, scope);
        updateSaveBar();
        const scopeLabel = scope === 'all'
            ? 'All Centers'
            : (centers.find(c => c.id === scope)?.name || scope);
        setText('showingCount', `Showing ${currentView.length} of ${base.length} students · ${scopeLabel}`);
        exportBtn.disabled = allRows.length === 0;
    }

    // ---------- rendering ----------
    function renderSummary(counts) {
        setText('sumTotalNum', counts.all);
        setText('sumDoneNum', counts.done);
        setText('sumEnrolledNum', counts.enrolledNoPo);
        setText('sumInquiryNum', counts.inquiryNoPo);
        const pct = counts.all ? Math.round((counts.done / counts.all) * 100) : 0;
        setText('sumDonePct', `${pct}%`);
        const bar = $('sumDoneBar');
        if (bar) bar.style.width = `${pct}%`;
    }
    function renderChips(counts) {
        setText('cntAll', counts.all);
        setText('cntEnrolledNoPo', counts.enrolledNoPo);
        setText('cntInquiryNoPo', counts.inquiryNoPo);
        setText('cntDone', counts.done);
        document.querySelectorAll('#poStatusChips .tab-btn').forEach(btn => {
            const active = btn.dataset.filter === statusFilter;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }
    function sortInd(key) {
        if (sortKey !== key) return '';
        return `<span class="po-sort-ind">${sortDir === 1 ? '▲' : '▼'}</span>`;
    }
    function editBtn(r, field, inner) {
        const dirty = isDirty(r, field) ? ' dirty' : '';
        return `<button type="button" class="po-editcell${dirty}" data-sid="${esc(r.id)}" data-field="${field}" title="Click to edit">${inner}</button>`;
    }
    function renderTable(rows, scope) {
        const showCenter = scope === 'all';
        const totalCols = showCenter ? 14 : 13;
        thead.innerHTML = `
            <tr>
                <th rowspan="2" class="po-th-num">#</th>
                ${showCenter ? `<th rowspan="2" data-sort="center" class="${sortKey === 'center' ? 'sorted' : ''}">Center${sortInd('center')}</th>` : ''}
                <th rowspan="2" data-sort="inquiryDate" class="${sortKey === 'inquiryDate' ? 'sorted' : ''}">Inquiry Date${sortInd('inquiryDate')}</th>
                <th rowspan="2" data-sort="name" class="${sortKey === 'name' ? 'sorted' : ''}">Name${sortInd('name')}</th>
                <th rowspan="2">Phone Number</th>
                <th rowspan="2" data-sort="school" class="${sortKey === 'school' ? 'sorted' : ''}">School${sortInd('school')}</th>
                <th rowspan="2" data-sort="grade" class="${sortKey === 'grade' ? 'sorted' : ''}">Grade${sortInd('grade')}</th>
                <th colspan="4" class="po-group">SUBJECT</th>
                <th colspan="2" class="po-group">PO</th>
            </tr>
            <tr>
                <th title="Math">M</th>
                <th title="English ERP">R</th>
                <th title="English EFL">L</th>
                <th title="Chinese">C</th>
                <th data-sort="po" class="${sortKey === 'po' ? 'sorted' : ''}">Y/N${sortInd('po')}</th>
                <th>Comments</th>
            </tr>`;

        if (!rows.length) {
            const msg = allRows.length === 0
                ? 'No students with subjects listed in this center scope.'
                : 'No students match the current filters.';
            tbody.innerHTML = `
                <tr><td colspan="${totalCols}">
                    <div class="empty-state">
                        <div class="empty-icon">🗂️</div>
                        <div class="empty-title">${msg}</div>
                        <div class="empty-sub">Try a different center, filter or search term.</div>
                    </div>
                </td></tr>`;
            return;
        }

        const subCell = (r, k) => r.subjects[k]
            ? `<span class="po-yes" title="${esc(r.subjInfo[k].join('\n'))}">Yes</span>`
            : `<span class="po-no-sub">—</span>`;

        const html = rows.map((r, i) => {
            const displayName = r.nameCn || r.namePinyin || 'Unknown';
            const subPinyin = r.nameCn && r.namePinyin ? r.namePinyin : '';
            const editLink = r.centerId === sessionCenterId
                ? ` <a class="po-edit" href="student-form.html?id=${encodeURIComponent(r.id)}" title="Edit student">✏️</a>`
                : '';
            const mobilePills = ['M', 'R', 'L', 'C']
                .filter(k => r.subjects[k])
                .map(k => `<span class="subj-chip ${k === 'M' ? 'math' : k === 'R' ? 'erp' : k === 'L' ? 'efl' : 'chi'}">${k} Yes</span>`)
                .join('') || '<span class="po-no-sub">—</span>';

            const effPo = effVal(r, 'po');
            const effPoDate = effVal(r, 'poDate');
            const poBadgeInner = effPo === 'yes'
                ? `<span class="fu-badge b-ok">YES</span>`
                : `<span class="fu-badge b-bad">NOT YET</span>`;
            const poDirty = (isDirty(r, 'po') || isDirty(r, 'poDate')) ? ' dirty' : '';
            const poBtn = `<button type="button" class="po-editcell${poDirty}" data-sid="${esc(r.id)}" data-field="po" title="Click to set status and confirm date">${poBadgeInner}</button>`;
            const poDateLine = (effPo === 'yes' && effPoDate)
                ? `<div class="sub">${esc(fmtDate(effPoDate))}</div>`
                : '';

            const manualPending = pending[r.id] && 'inquiryDate' in pending[r.id];
            const dtTag = (!manualPending && r.inquiryIsDt && r.inquiryDate)
                ? '<span class="po-dt-tag" title="No inquiry date on record — showing the Diagnostic Test date">DT</span>'
                : '';
            const inquiryInner = (esc(fmtDate(effVal(r, 'inquiryDate'))) || '<span class="po-no-sub">—</span>') + dtTag;

            const stateBadge = r.studyState
                ? `<span class="po-state ${r.studyState === 'Paused' ? 'paused' : 'dropped'}">${r.studyState}</span>`
                : '';
            const commentsInner = editBtn(r, 'comments', esc(effVal(r, 'comments')) || '<span class="po-no-sub">—</span>');

            return `
            <tr>
                <td class="po-num" data-label="#">${i + 1}</td>
                ${showCenter ? `<td data-label="Center"><span class="po-center-pill" title="${esc(r.centerName)}">${esc(r.abbr)}</span></td>` : ''}
                <td class="po-date" data-label="Inquiry">${editBtn(r, 'inquiryDate', inquiryInner)}</td>
                <td data-label="Name"><div class="po-name-wrap"><div class="po-name-cn">${esc(displayName)}${editLink}</div>${subPinyin ? `<div class="sub">${esc(subPinyin)}</div>` : ''}</div></td>
                <td class="po-phone" data-label="Phone">${esc(r.phone) || '<span class="po-no-sub">—</span>'}</td>
                <td data-label="School">${editBtn(r, 'school', esc(effVal(r, 'school')) || '<span class="po-no-sub">—</span>')}</td>
                <td class="po-grade" data-label="Grade">${editBtn(r, 'grade', esc(effVal(r, 'grade')) || '<span class="po-no-sub">—</span>')}</td>
                <td class="po-sub-cell" data-label="M">${subCell(r, 'M')}</td>
                <td class="po-sub-cell" data-label="R">${subCell(r, 'R')}</td>
                <td class="po-sub-cell" data-label="L">${subCell(r, 'L')}</td>
                <td class="po-sub-cell" data-label="C">${subCell(r, 'C')}</td>
                <td class="po-sub-mobile" data-label="Subjects"><div class="po-mobile-pills">${mobilePills}</div></td>
                <td class="po-po" data-label="PO"><div class="po-po-inner">${poBtn}${poDateLine}</div></td>
                <td class="po-comments" data-label="Comments">${stateBadge}${commentsInner}</td>
            </tr>`;
        }).join('');
        tbody.innerHTML = html;
    }

// ---------- Excel export (options modal + multi-section workbook) ----------
const EX_LISTS = [
    { key: 'enrolledNoPo', cb: 'exSecEnrolled', label: 'ENROLLED - NO PO' },
    { key: 'inquiryNoPo',  cb: 'exSecInquiry',  label: 'INQUIRY - NO PO' }
];

function exSelectedCenters() {
    return Array.from(document.querySelectorAll('#exCenterList .ex-center-cb:checked')).map(cb => cb.value);
}
function exSelectedLists() {
    return EX_LISTS.filter(l => $(l.cb)?.checked);
}
function exBaseRows() {
    const term = searchInput.value.trim().toLowerCase();
    const subjSel = getSubjectSelection();
    return allRows.filter(r =>
        (!subjSel.length || subjSel.some(k => r.subjects[k])) &&
        (!term || r.searchBlob.includes(term))
    );
}
function exCollectSections() {
    const sel = exSelectedCenters();
    const lists = exSelectedLists();
    const base = exBaseRows();
    const secs = [];
    centers.forEach(c => {
        if (!sel.includes(c.id)) return;
        lists.forEach(l => {
            const rows = base.filter(r => r.centerId === c.id && statusMatch(r, l.key)).sort(cmp);
            if (rows.length) secs.push({ title: `${getCenterAbbr(c.name)} ${l.label}`, rows });
        });
    });
    return secs;
}
function updateExState() {
    const secs = exCollectSections();
    const students = secs.reduce((n, s) => n + s.rows.length, 0);
    setText('exPreview', secs.length
        ? `${secs.length} section${secs.length === 1 ? '' : 's'} · ${students} student${students === 1 ? '' : 's'}`
        : 'No students match these options.');
    const btn = $('exConfirm');
    if (btn) btn.disabled = secs.length === 0;
    const t = $('exCentersToggle');
    const cbs = Array.from(document.querySelectorAll('#exCenterList .ex-center-cb'));
    if (t) t.textContent = (cbs.length && cbs.every(cb => cb.checked)) ? 'Clear all' : 'Select all';
}
function openExModal() {
    if (!allRows.length) { showToast('No data loaded yet — nothing to export.', 'err'); return; }
    const scope = centerSelect.value || 'all';
    const list = $('exCenterList');
    if (list) {
        list.innerHTML = centers.map(c => {
            const checked = (scope === 'all' || scope === c.id) ? ' checked' : '';
            return `<label class="ex-center-opt">
                <input type="checkbox" class="ex-center-cb" value="${esc(c.id)}"${checked}>
                <span>${esc(c.name)}</span>
                <span class="ex-center-abbr">${esc(getCenterAbbr(c.name))}</span>
            </label>`;
        }).join('');
        list.querySelectorAll('.ex-center-cb').forEach(cb => cb.addEventListener('change', updateExState));
    }
    EX_LISTS.forEach(l => { const cb = $(l.cb); if (cb) cb.checked = true; });
    updateExState();
    $('exModal')?.classList.remove('hidden');
}
function closeExModal() { $('exModal')?.classList.add('hidden'); }
function runExport() {
    const sel = exSelectedCenters();
    const secs = exCollectSections();
    if (!secs.length) { showToast('Nothing to export with these options.', 'err'); return; }
    closeExModal();
    exportSections(secs, sel);
}

function exportSections(secs, selCenterIds) {
    const TOTAL = 12;
    const head1 = ['#', 'INQUIRY DATE', 'NAME', 'PHONE NUMBER', 'SCHOOL', 'GRADE', 'SUBJECT', '', '', '', 'PO', ''];
    const head2 = ['', '', '', '', '', '', 'M', 'R', 'L', 'C', 'Y/N', 'Comments'];
    const dataRow = (r, i) => [
        i + 1,
        fmtDate(r.inquiryDate),
        r.nameCn || r.namePinyin || 'Unknown',
        r.phone,
        r.school,
        r.grade,
        r.subjects.M ? 'Yes' : '',
        r.subjects.R ? 'Yes' : '',
        r.subjects.L ? 'Yes' : '',
        r.subjects.C ? 'Yes' : '',
        r.po === 'yes' ? 'YES' : 'NOT YET',
        r.comments
    ];
    const totalStudents = secs.reduce((n, s) => n + s.rows.length, 0);
    const dateStamp = new Date().toISOString().slice(0, 10);
    const scopeName = selCenterIds.length === 1
        ? (centers.find(c => c.id === selCenterIds[0])?.name || selCenterIds[0])
        : `${selCenterIds.length}-Centers`;
    const safeName = scopeName.replace(/[^\w\u4e00-\u9fff-]+/g, '-');

    // CSV fallback content: title + flat header + rows per section, blank line between
    const flatHeader = head1.map((h, c) => head2[c] || h);
    const csvRows = [];
    secs.forEach((sec, i) => {
        if (i) csvRows.push(new Array(TOTAL).fill(''));
        const t = new Array(TOTAL).fill(''); t[0] = sec.title;
        csvRows.push(t, flatHeader.slice(), ...sec.rows.map(dataRow));
    });

    if (typeof window.XLSX === 'undefined') {
        exportCsvFallback(csvRows, `PO_Report_${safeName}_${dateStamp}.csv`, totalStudents);
        return;
    }
    try {
        const XLSX = window.XLSX;
        const aoa = [], merges = [], rowMeta = [];
        secs.forEach((sec, i) => {
            if (i) { aoa.push(new Array(TOTAL).fill('')); rowMeta.push('spacer'); }
            const tr = aoa.length;
            const title = new Array(TOTAL).fill(''); title[0] = sec.title;
            aoa.push(title); rowMeta.push('title');
            merges.push({ s: { r: tr, c: 0 }, e: { r: tr, c: TOTAL - 1 } });
            const h = aoa.length;
            aoa.push(head1.slice(), head2.slice()); rowMeta.push('header1', 'header2');
            for (let c = 0; c <= 5; c++) merges.push({ s: { r: h, c }, e: { r: h + 1, c } });
            merges.push({ s: { r: h, c: 6 }, e: { r: h, c: 9 } });    // SUBJECT
            merges.push({ s: { r: h, c: 10 }, e: { r: h, c: 11 } }); // PO
            sec.rows.forEach((r, n) => { aoa.push(dataRow(r, n)); rowMeta.push('data'); });
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!merges'] = merges;
        ws['!cols'] = [
            { wch: 5 }, { wch: 14 }, { wch: 20 }, { wch: 18 }, { wch: 14 }, { wch: 8 },
            { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 12 }, { wch: 44 }
        ];
        ws['!rows'] = rowMeta.map(t => ({
            hpt: t === 'title' ? 24 : t === 'header1' ? 26 : t === 'header2' ? 20 : t === 'spacer' ? 12 : 26
        }));
        const border = { style: 'thin', color: { rgb: '000000' } };
        const allBorders = { top: border, bottom: border, left: border, right: border };
        const headerStyle = {
            fill: { fgColor: { rgb: 'FFE699' } },
            font: { bold: true, sz: 11, color: { rgb: '000000' } },
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
            border: allBorders
        };
        const titleStyle = {
            font: { bold: true, sz: 12, color: { rgb: '000000' } },
            alignment: { horizontal: 'center', vertical: 'center' }
        };
        const centerCols = new Set([0, 1, 5, 6, 7, 8, 9, 10]);
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let R = range.s.r; R <= range.e.r; R++) {
            const type = rowMeta[R];
            if (type === 'spacer') continue;
            for (let C = range.s.c; C <= range.e.c; C++) {
                const addr = XLSX.utils.encode_cell({ r: R, c: C });
                if (!ws[addr]) ws[addr] = { t: 's', v: '' };
                const cell = ws[addr];
                if (type === 'title') { cell.s = titleStyle; continue; }
                if (type === 'header1' || type === 'header2') { cell.s = headerStyle; continue; }
                const align = centerCols.has(C) ? 'center' : 'left';
                const style = {
                    font: { sz: 11, color: { rgb: '000000' } },
                    alignment: { horizontal: align, vertical: 'center', wrapText: true },
                    border: allBorders
                };
                const val = String(cell.v ?? '');
                if (C >= 6 && C <= 9 && val === 'Yes') {
                    style.fill = { fgColor: { rgb: 'C6EFCE' } };
                    style.font = { sz: 11, bold: true, color: { rgb: '006100' } };
                }
                if (C === 10) {
                    style.font = val === 'YES'
                        ? { sz: 11, bold: true, color: { rgb: '006100' } }
                        : { sz: 11, bold: true, color: { rgb: '9C0006' } };
                }
                cell.s = style;
            }
        }
        const wb = XLSX.utils.book_new();
        wb.Props = { Title: 'Parent Orientation Report', Author: 'Kumon DB' };
        XLSX.utils.book_append_sheet(wb, ws, 'PO Report');
        const filename = `PO_Report_${safeName}_${dateStamp}.xlsx`;
        XLSX.writeFile(wb, filename, { compression: true });
        showToast(`⬇ Exported ${totalStudents} students · ${secs.length} section${secs.length === 1 ? '' : 's'} — ${filename}`);
    } catch (err) {
        console.error('Excel export error:', err);
        exportCsvFallback(csvRows, `PO_Report_${safeName}_${dateStamp}.csv`, totalStudents);
    }
}

function exportCsvFallback(rows, filename, count) {
    const csvCell = (v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    showToast(`Excel library unavailable — exported CSV instead (${count} students).`);
}

// export modal events
const exModalEl = $('exModal');
if (exModalEl) exModalEl.addEventListener('click', (e) => { if (e.target === exModalEl) closeExModal(); });
$('exCancel')?.addEventListener('click', closeExModal);
$('exConfirm')?.addEventListener('click', runExport);
$('exCentersToggle')?.addEventListener('click', () => {
    const cbs = Array.from(document.querySelectorAll('#exCenterList .ex-center-cb'));
    const all = cbs.length && cbs.every(cb => cb.checked);
    cbs.forEach(cb => { cb.checked = !all; });
    updateExState();
});
EX_LISTS.forEach(l => $(l.cb)?.addEventListener('change', updateExState));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && exModalEl && !exModalEl.classList.contains('hidden')) closeExModal();
});

    // ---------- events ----------
    loadStatus.addEventListener('click', () => {
        if (loadStatus.classList.contains('err')) fetchAll();
    });
    centerSelect.addEventListener('change', buildView);
    searchInput.addEventListener('input', () => {
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(buildView, 150);
    });
    document.querySelectorAll('.po-subj-cb').forEach(cb => cb.addEventListener('change', buildView));
    exportBtn.addEventListener('click', openExModal);

    const saveBtnEl = $('poSaveBtn');
    if (saveBtnEl) saveBtnEl.addEventListener('click', saveEdits);
    const discardBtnEl = $('poDiscardBtn');
    if (discardBtnEl) discardBtnEl.addEventListener('click', discardEdits);
    tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('.po-editcell');
        if (btn) startEdit(btn);
    });

    // PO modal events
    const modalEl = $('poModal');
    if (modalEl) {
        modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closePoModal(); });
    }
    const modalStatus = $('poModalStatus');
    if (modalStatus) {
        modalStatus.addEventListener('click', (e) => {
            const opt = e.target.closest('.po-modal-opt');
            if (!opt) return;
            modalPo = opt.dataset.po;
            const d = $('poModalDate');
            if (d && modalPo === 'yes' && !d.value) d.value = todayIso();
            syncModalOpts();
        });
    }
    const modalCancel = $('poModalCancel');
    if (modalCancel) modalCancel.addEventListener('click', closePoModal);
    const modalConfirm = $('poModalConfirm');
    if (modalConfirm) modalConfirm.addEventListener('click', confirmPoModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalSid) closePoModal();
    });

    document.getElementById('poStatusChips').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-filter]');
        if (!btn) return;
        statusFilter = btn.dataset.filter;
        buildView();
    });

    document.querySelectorAll('#poSummary .balance-card.clickable').forEach(card => {
        const activate = () => { statusFilter = card.dataset.filter; buildView(); };
        card.addEventListener('click', activate);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
    });

    thead.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-sort]');
        if (!th) return;
        const key = th.dataset.sort;
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = 1; }
        buildView();
    });

    fetchAll();
}