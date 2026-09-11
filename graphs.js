import { auth, db, logout } from './auth.js';
import { ref, get, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'progressCharts'; // same key gates both tabs

// 🔐 PERMISSION CHECK
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
            initializeGraphs();
        } else {
            document.getElementById('accessDenied')?.classList.remove('hidden');
            document.getElementById('mainContent')?.classList.add('hidden');
            document.getElementById('loadingOverlay')?.classList.add('hidden');
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
// 📄 MAIN APP LOGIC
// ==========================================
function initializeGraphs() {
    const centerId = sessionStorage.getItem('selectedCenter');
    if (!centerId) window.location.href = 'centers.html';
    const studentsRef = ref(db, `centers/${centerId}/students`);
    const loader = document.getElementById('loadingOverlay');

    // ----------------------------------------
    // 1. CONFIG
    // ----------------------------------------
    const CHART_SUBJECTS = ['Math', 'English EFL', 'English ERP', 'Chinese'];
    const SUBJECT_CONFIG = {
        'Math':        { color: '#7DD3C0', badge: '#0d9488', rowPerYear: 1, kisBaseRow: 5, levels: ['6A','5A','4A','3A','2A','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'] },
        'English EFL': { color: '#FFB366', badge: '#ea580c', rowPerYear: 1, kisBaseRow: 6, levels: ['7A','6A','5A','4A','3A','2A','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'] },
        'English ERP': { color: '#FF9999', badge: '#dc2626', rowPerYear: 2, kisBaseRow: 6, levels: ['7A','6A','5A','4A','3A','2A','AI','AII','BI','BII','CI','CII','DI','DII','EI','EII','FI','FII','GI','GII','HI','HII','I','II','III','J','K','L'] },
        'Chinese':     { color: '#C8E67A', badge: '#65a30d', rowPerYear: 2, kisBaseRow: 6, levels: ['7A','6A','5A','4A','3A','2A','AI','AII','BI','BII','CI','CII','DI','DII','EI','EII','FI','FII','GI','GII','HI','HII','I','II','III','J','K','L'] }
    };
    const P1_IDX = 4; // grade '1' (P1) index in GRADE_AXIS
    const GRADE_AXIS = ['K0','K1','K2','K3','1','2','3','4','5','6','7','8','9','10','11','12','13'];
    const REF_LINES = [
        { yr: 0,   label: 'Kumon International Standard', color: '#16a34a' },
        { yr: 0.5, label: 'ASHR - 6 months ahead',        color: '#db2777' },
        { yr: 2,   label: 'ASHR - 2 years ahead',         color: '#dc2626' },
        { yr: 3,   label: 'ASHR - 3 years ahead',         color: '#ca8a04' }
    ];
    const CELL_CAPACITY = 9;
    const CELL_PX = 140;

    // ----------------------------------------
    // 2. STATE
    // ----------------------------------------
    let allStudents = [];
    let allMonthsSorted = [];
    let activeSubject = 'Math';
    let selectedMonth = null;
    let showInactive = false;
    let showLines = true;
    let showCompleters = true;
    let colorMode = 'uniform';
    let centerSearchTerm = '';
    let individualSearchTerm = '';
    let currentSnapshot = [];
    let centerBuilt = false;

    // ----------------------------------------
    // 3. HELPERS
    // ----------------------------------------
    function gradeLabel(v) {
        if (!v) return '?';
        const g = String(v).trim().toUpperCase();
        if (/^K\d+$/.test(g)) return g;
        const n = parseInt(g, 10);
        if (n >= 1 && n <= 6) return 'P' + n;
        if (n >= 7 && n <= 12) return 'F' + (n - 6);
        return g; // 13 stays "13"
    }
    function parseLevel(levelStr) {
        if (!levelStr) return { key: '', ws: 0 };
        const s = String(levelStr).trim().toUpperCase();
        const match = s.match(/^(\d*[A-Z]+(?:II?)?)\s*(\d*)$/);
        return match ? { key: match[1], ws: match[2] ? parseInt(match[2], 10) : 0 } : { key: s.replace(/\s/g, ''), ws: 0 };
    }
    function matchesSubject(chartSub, dbName) {
        const n = (dbName || '').trim();
        if (chartSub === 'Chinese') return n === 'Chinese (Trad)' || n === 'Chinese (Simp)' || n === 'Chinese';
        return n === chartSub;
    }
    function abbrevName(s) {
        const base = (s.namePinyin || s.nickname || s.nameCn || 'Unknown').toString().toUpperCase().trim();
        const parts = base.split(/\s+/);
        if (parts.length === 1) return parts[0];
        return parts[0] + ' ' + parts.slice(1).map(p => p.charAt(0) + '.').join(' ');
    }
    function fullName(s) { return s.namePinyin || s.nameCn || s.nickname || 'Unknown'; }
    function academicIndex(monthStr) {
        const [y, m] = monthStr.split('-').map(Number);
        return y + (m >= 8 ? 1 : 0);
    }
    function nowMonthStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    function formatMonthLabel(m) {
        if (!m) return '';
        const [y, mon] = m.split('-');
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return `${months[parseInt(mon, 10) - 1]} '${y.slice(2)}`;
    }
    function hexToRgba(hex, a) {
        const h = hex.replace('#', '');
        const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
        return `rgba(${r},${g},${b},${a})`;
    }
    function normalizeArrays(data) {
        data.subjects = Array.isArray(data.subjects) ? data.subjects : Object.values(data.subjects || {});
        (data.subjects || []).forEach(sub => {
            if (sub) sub.progress = Array.isArray(sub.progress) ? sub.progress : Object.values(sub.progress || {});
        });
    }
    function kisRowAt(chartSub, gradeIdx) {
        const cfg = SUBJECT_CONFIG[chartSub];
        return cfg.kisBaseRow + cfg.rowPerYear * (gradeIdx - P1_IDX);
    }
    function diffYears(pt) {
        const cfg = SUBJECT_CONFIG[pt.subject];
        return (pt.row - kisRowAt(pt.subject, pt.gradeIdx)) / cfg.rowPerYear;
    }

    // ----------------------------------------
    // 4. TABS
    // ----------------------------------------
    const tabBtns = document.querySelectorAll('.page-tab');
    function switchTab(tab) {
        tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        document.getElementById('tab-individual').classList.toggle('active', tab === 'individual');
        document.getElementById('tab-center').classList.toggle('active', tab === 'center');
        sessionStorage.setItem('graphsTab', tab);
        if (tab === 'center') {
            if (!centerBuilt) { refreshCenter(); centerBuilt = true; }
            else {
                const el = document.getElementById('centerMapChart');
                if (el && el.data) Plotly.Plots.resize(el);
            }
        }
    }
    tabBtns.forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

    // ----------------------------------------
    // 5. SNAPSHOT (monthly-report based)
    // ----------------------------------------
    function buildSnapshot(month) {
        const pts = [];
        const now = nowMonthStr();
        allStudents.forEach(st => {
            (st.subjects || []).forEach(sub => {
                if (!sub) return;
                const chartSub = CHART_SUBJECTS.find(cs => matchesSubject(cs, sub.name));
                if (!chartSub) return;
                const status = sub.status || 'current';
                const include = status === 'current' || (showInactive && (status === 'pause' || status === 'drop'));
                if (!include) return;
                const progress = [...(sub.progress || [])].sort((a, b) => (a?.month || '').localeCompare(b?.month || ''));
                let entry = progress.find(p => p?.month === month);
                let carried = false;
                if (!entry) {
                    entry = progress.filter(p => p?.month && p.month < month).pop();
                    carried = !!entry;
                }
                if (!entry) return;
                if (sub.enrolDate && month < String(sub.enrolDate).slice(0, 7)) return; // not enrolled yet
                const level = entry.currLevel || sub.currentLevel || '';
                if (!level) return;
                const row = SUBJECT_CONFIG[chartSub].levels.indexOf(parseLevel(level).key);
                if (row < 0) return;
                const gradeIdxNow = GRADE_AXIS.indexOf(String(st.grade || '').trim());
                if (gradeIdxNow < 0) return;
                const steps = academicIndex(now) - academicIndex(month);
                const gradeIdx = Math.max(0, Math.min(GRADE_AXIS.length - 1, gradeIdxNow - steps));
                pts.push({
                    studentId: st.id, student: st, dbName: (sub.name || '').trim(), subject: chartSub,
                    gradeIdx, row, ws: entry.currWS ?? sub.currentWS ?? 0,
                    carried, status, label: abbrevName(st)
                });
            });
        });
        return pts;
    }

    function getCompleters() {
        const list = [];
        allStudents.forEach(st => {
            (st.subjects || []).forEach(sub => {
                if (!sub || (sub.status !== 'completer')) return;
                if (!matchesSubject(activeSubject, sub.name)) return;
                const m = sub.completerMonth ? `${formatMonthLabel(`${sub.completerYear || ''}-${String(sub.completerMonth).padStart(2, '0')}`)}` : '';
                list.push({ name: fullName(st), month: m });
            });
        });
        return list;
    }

    // ----------------------------------------
    // 6. CENTER MAP CHART
    // ----------------------------------------
    const chartEl = document.getElementById('centerMapChart');

    function refreshCenter() {
        rebuildMonthOptions();
        if (!selectedMonth) return;
        currentSnapshot = buildSnapshot(selectedMonth);
        renderCompleters();
        renderStats();
        renderCenterChart();
        const sub = document.getElementById('centerMapSubtitle');
        if (sub) sub.textContent = `${activeSubject} • ${formatMonthLabel(selectedMonth)}`;
        const title = document.getElementById('centerMapTitle');
        if (title) title.textContent = `Center Progress Map — ${activeSubject}`;
    }

    function rebuildMonthOptions() {
        const set = new Set();
        allStudents.forEach(s => (s.subjects || []).forEach(sub => (sub?.progress || []).forEach(p => { if (p?.month) set.add(p.month); })));
        allMonthsSorted = Array.from(set).filter(m => m <= nowMonthStr()).sort();
        const sel = document.getElementById('centerMonthSelect');
        if (!sel) return;
        if (!selectedMonth || !allMonthsSorted.includes(selectedMonth)) {
            selectedMonth = allMonthsSorted.length ? allMonthsSorted[allMonthsSorted.length - 1] : null;
        }
        sel.innerHTML = allMonthsSorted.map(m => `<option value="${m}" ${m === selectedMonth ? 'selected' : ''}>${formatMonthLabel(m)}</option>`).join('')
            || '<option value="">No data</option>';
        const idx = allMonthsSorted.indexOf(selectedMonth);
        document.getElementById('centerPrevMonth').disabled = idx <= 0;
        document.getElementById('centerNextMonth').disabled = idx < 0 || idx >= allMonthsSorted.length - 1;
    }

    function renderStats() {
        let above = 0, ahead2 = 0, below = 0;
        currentSnapshot.forEach(pt => {
            const d = diffYears(pt);
            if (d >= 2) ahead2++;
            if (d >= 0) above++; else below++;
        });
        const comps = getCompleters();
        document.getElementById('statPlotted').textContent = currentSnapshot.length;
        document.getElementById('statAbove').textContent = above;
        document.getElementById('statAhead2').textContent = ahead2;
        document.getElementById('statBelow').textContent = below;
        document.getElementById('statCompleters').textContent = comps.length;
    }

    function renderCompleters() {
        const band = document.getElementById('completersBand');
        const list = document.getElementById('completersList');
        if (!band || !list) return;
        band.classList.toggle('hidden', !showCompleters);
        if (!showCompleters) return;
        const comps = getCompleters();
        list.innerHTML = comps.length
            ? comps.map(c => `<span class="completer-chip">🎓 ${c.name}${c.month ? ` <small>(${c.month})</small>` : ''}</span>`).join('')
            : '<span class="completers-empty">No completers for this subject yet.</span>';
    }

    function renderCenterChart() {
        if (!selectedMonth || !chartEl) return;
        const cfg = SUBJECT_CONFIG[activeSubject];
        const levels = cfg.levels;
        const maxRow = levels.length - 1;
        const nG = GRADE_AXIS.length;

        // 📐 Fixed pixel width per grade cell (wrapper scrolls horizontally)
        const minW = nG * CELL_PX + 170;
        chartEl.style.width = '100%';
        chartEl.style.minWidth = minW + 'px';
        const plotWpx = Math.max(chartEl.clientWidth || minW, minW) - 140; // minus l/r margins
        const pxPerUnit = plotWpx / nG;                                    // data-units → px

        const pts = currentSnapshot.filter(p => p.subject === activeSubject);

        // Group into cells
        const cells = {};
        pts.forEach(p => { (cells[`${p.gradeIdx}|${p.row}`] ||= []).push(p); });
        Object.values(cells).forEach(arr => arr.sort((a, b) => a.label.localeCompare(b.label)));

        const namePts = [], inactivePts = [], badges = [];
        const BASE_FONT = 9, GAP_PX = 3, PAD_PX = 2;
        const widthOf = (p, f) => p.label.length * f * 0.62 + 2; // approx Arial width

        Object.values(cells).forEach(arr => {
            if (arr.length > CELL_CAPACITY) { badges.push(arr); return; }
            arr.forEach((p, i) => { p._slot = i; });

            // ⬇️➡️ Column-major fill: 1,2,3 down the first column, then 4,5,6, then 7,8,9
            const cols = [[], [], []];
            arr.forEach(p => cols[Math.floor(p._slot / 3)].push(p));
            const usedCols = cols.filter(c => c.length);

            // 📏 Compact packing: each column only as wide as its longest name;
            //    shrink font only if the packed row would overflow the cell.
            const colWidth = (c, f) => Math.max(...c.map(p => widthOf(p, f)));
            const totalAt = f => usedCols.reduce((s, c) => s + colWidth(c, f), 0)
                                 + GAP_PX * (usedCols.length - 1) + PAD_PX;
            let F = BASE_FONT;
            if (totalAt(F) > CELL_PX - 2) {
                F = Math.max(5.5, F * (CELL_PX - 2) / totalAt(F));
            }
            let cumPx = PAD_PX;
            usedCols.forEach(c => {
                const w = colWidth(c, F);
                c.forEach(p => {
                    const row = p._slot % 3;          // 0=top, 1=mid, 2=bottom
                    p._dx = cumPx / pxPerUnit;        // offset from cell's LEFT edge
                    p._dy = 0.3333 - row * 0.3333;    // top row first, going down
                    p._fs = F;
                });
                cumPx += w + GAP_PX;                  // minimal gap between columns
            });

            arr.forEach(p => (p.status === 'current' ? namePts : inactivePts).push(p));
        });

        const q = centerSearchTerm.trim().toLowerCase();
        function hoverFor(p) {
            return `<b>${fullName(p.student)}</b><br>Grade: ${gradeLabel(GRADE_AXIS[p.gradeIdx])} • Level: ${levels[p.row]} (WS ${p.ws})`
                + (p.carried ? '<br><i>(carried from earlier report)</i>' : '')
                + (p.status !== 'current' ? `<br><i>(${p.status})</i>` : '');
        }

        const mkTextTrace = (arr, fixedColor) => ({
            type: 'scatter',
            mode: 'text',
            cliponaxis: false,
            x: arr.map(p => p.gradeIdx - 0.5 + p._dx),   // ← left edge of cell + packed offset
            y: arr.map(p => p.row + p._dy),
            text: arr.map(p => p.label),
            textposition: 'middle left',                 // ← always grows rightward from its own x
            textfont: {
                family: 'Arial, Helvetica, sans-serif',
                size: arr.map(p => (q && fullName(p.student).toLowerCase().includes(q)) ? p._fs + 1 : p._fs),
                color: arr.map(p => {
                    if (fixedColor) return fixedColor;
                    if (q) return fullName(p.student).toLowerCase().includes(q) ? '#d97706' : '#d8dee7';
                    if (colorMode === 'standard') {
                        const d = diffYears(p);
                        if (d >= 2) return '#15803d';
                        if (d >= 0) return '#0d9488';
                        if (d > -2) return '#d97706';
                        return '#dc2626';
                    }
                    return '#334155';
                })
            },
            customdata: arr.map(p => [hoverFor(p), 'name', p.studentId, p.dbName]),
            hovertemplate: '%{customdata[0]}<extra></extra>'
        });

        const badgeTrace = {
            type: 'scatter', mode: 'markers+text',
            x: badges.map(a => a[0].gradeIdx), y: badges.map(a => a[0].row),
            text: badges.map(a => String(a.length)),
            textfont: { color: '#fff', size: 11, family: 'Arial Black' },
            textposition: 'middle center',
            marker: { size: 26, color: cfg.badge, symbol: 'circle', line: { color: '#fff', width: 2 } },
            customdata: badges.map(a => [
                `<b>${a.length} students</b><br>Grade ${gradeLabel(GRADE_AXIS[a[0].gradeIdx])} • Level ${levels[a[0].row]}<br><i>Click for full list</i>`,
                'badge', a[0].gradeIdx, a[0].row
            ]),
            hovertemplate: '%{customdata[0]}<extra></extra>'
        };

        // Graph-paper shapes + density shading
        const shapes = [];
        for (let g = -1; g <= nG - 1; g++) shapes.push({ type: 'line', x0: g + 0.5, x1: g + 0.5, y0: -0.5, y1: maxRow + 0.5, line: { color: '#e2e8f0', width: 1 } });
        for (let r = 0; r <= maxRow + 1; r++) shapes.push({ type: 'line', x0: -0.5, x1: nG - 0.5, y0: r - 0.5, y1: r - 0.5, line: { color: '#e2e8f0', width: 1 } });
        if (colorMode === 'density') {
            Object.values(cells).forEach(arr => {
                shapes.push({
                    type: 'rect', x0: arr[0].gradeIdx - 0.5, x1: arr[0].gradeIdx + 0.5,
                    y0: arr[0].row - 0.5, y1: arr[0].row + 0.5,
                    fillcolor: hexToRgba(cfg.color === '#C8E67A' ? '#84cc16' : cfg.badge, Math.min(0.12 + arr.length * 0.08, 0.8)),
                    line: { width: 0 }, layer: 'below'
                });
            });
        }

        // Reference lines
        const traces = [];
        const annotations = [];
        if (showLines) {
            const plotH = chartHeight(maxRow) - 95;
            const angle = Math.round(Math.atan2(plotH / (maxRow + 1), plotWpx / nG) * 180 / Math.PI);
            REF_LINES.forEach(rl => {
                const off = rl.yr * cfg.rowPerYear;
                const yAt = x => cfg.kisBaseRow + off + cfg.rowPerYear * (x - P1_IDX);
                const xAtY = y => P1_IDX + (y - cfg.kisBaseRow - off) / cfg.rowPerYear;
                const x0 = Math.max(-0.5, xAtY(-0.5)), x1 = Math.min(nG - 0.5, yAt(maxRow + 0.5) !== undefined ? xAtY(maxRow + 0.5) : nG - 0.5);
                if (x1 <= x0) return;
                traces.push({
                    type: 'scatter', mode: 'lines', x: [x0, x1], y: [yAt(x0), yAt(x1)],
                    line: { color: rl.color, width: 2 }, hoverinfo: 'skip'
                });
                const xm = x0 + 0.55 * (x1 - x0);
                annotations.push({ x: xm, y: yAt(xm) + 0.2, text: rl.label, showarrow: false, textangle: angle, font: { size: 11, color: rl.color, family: 'Arial Italic' } });
            });
        }

        traces.push(mkTextTrace(namePts, null));
        traces.push(mkTextTrace(inactivePts, '#9ca3af'));
        traces.push(badgeTrace);

        const layout = {
            margin: { t: 30, r: 70, b: 55, l: 70 },
            height: chartHeight(maxRow),
            showlegend: false,
            hovermode: 'closest',
            xaxis: {
                range: [-0.5, nG - 0.5], tickmode: 'array',
                tickvals: GRADE_AXIS.map((_, i) => i), ticktext: GRADE_AXIS.map(gradeLabel),
                tickfont: { size: 11, color: '#4682B4', family: 'Arial Bold' },
                showgrid: false, zeroline: false, side: 'bottom',
                ticks: 'outside', ticklen: 6, tickcolor: '#4682B4'
            },
            yaxis: {
                range: [-0.5, maxRow + 0.5], tickmode: 'array',
                tickvals: levels.map((_, i) => i), ticktext: levels,
                tickfont: { size: 9, color: '#4682B4', family: 'Arial Bold' },
                showgrid: false, zeroline: false
            },
            yaxis2: {
                overlaying: 'y', side: 'right', range: [-0.5, maxRow + 0.5],
                tickmode: 'array', tickvals: levels.map((_, i) => i), ticktext: levels,
                tickfont: { size: 9, color: '#4682B4' }, showgrid: false, zeroline: false, showline: false
            },
            shapes, annotations,
            plot_bgcolor: '#fdfdfb',
            paper_bgcolor: '#fff'
        };

        Plotly.newPlot(chartEl, traces, layout, { responsive: true, displayModeBar: false });
        attachChartClick();
    }

    function chartHeight(maxRow) { return Math.max(600, Math.min(1000, (maxRow + 1) * 30 + 130)); }

    let clickAttached = false;
    function attachChartClick() {
        if (clickAttached || !chartEl.on) return;
        clickAttached = true;
        chartEl.on('plotly_click', (ev) => {
            const pt = ev?.points?.[0];
            if (!pt || !pt.customdata) return;
            const [, type, a, b] = pt.customdata;
            if (type === 'badge') openCellModal(a, b);
            else if (type === 'name') {
                const stu = allStudents.find(s => s.id === a);
                if (stu) openModal(stu, b);
            }
        });
    }

    // ----------------------------------------
    // 7. CELL MODAL
    // ----------------------------------------
    function openCellModal(g, r) {
        const cfg = SUBJECT_CONFIG[activeSubject];
        const arr = (currentSnapshot.filter(p => p.subject === activeSubject && p.gradeIdx === g && p.row === r))
            .sort((x, y) => x.label.localeCompare(y.label));
        if (!arr.length) return;
        document.getElementById('cellModalTitle').textContent =
            `${activeSubject} • Grade ${gradeLabel(GRADE_AXIS[g])} • Level ${cfg.levels[r]} — ${arr.length} student${arr.length > 1 ? 's' : ''}`;
        const list = document.getElementById('cellModalList');
        list.innerHTML = arr.map(p => `
            <div class="cell-row">
                <div>
                    <div class="cr-name">${fullName(p.student)}
                        ${p.carried ? '<span class="carried-badge">CARRIED</span>' : ''}
                        ${p.status !== 'current' ? `<span class="inactive-badge">${p.status.toUpperCase()}</span>` : ''}
                    </div>
                    <div class="cr-meta">${p.student.studentNumber || '-'} • ${cfg.levels[p.row]} (WS ${p.ws})</div>
                </div>
                <button class="cell-view-btn" data-id="${p.studentId}" data-sub="${p.dbName}">📈 View chart</button>
            </div>`).join('');
        list.querySelectorAll('.cell-view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const stu = allStudents.find(s => s.id === btn.dataset.id);
                closeCellModal();
                if (stu) openModal(stu, btn.dataset.sub);
            });
        });
        const m = document.getElementById('cellModal');
        m.classList.remove('hidden'); m.style.display = 'flex';
    }
    function closeCellModal() {
        const m = document.getElementById('cellModal');
        m.classList.add('hidden'); m.style.display = 'none';
    }
    document.getElementById('closeCellModalBtn')?.addEventListener('click', closeCellModal);
    document.getElementById('cellModal')?.addEventListener('click', e => { if (e.target.id === 'cellModal') closeCellModal(); });

    // ----------------------------------------
    // 8. INDIVIDUAL TAB (table + modal chart)
    // ----------------------------------------
    function renderStudentTable(term = '') {
        const tbody = document.getElementById('analyticsStudentTable');
        if (!tbody) return;
        tbody.innerHTML = '';
        const t = term.toLowerCase();
        const filtered = allStudents.filter(s => {
            const n = (s.namePinyin || s.nameCn || s.nickname || '').toLowerCase();
            const id = (s.studentNumber || '').toLowerCase();
            return n.includes(t) || id.includes(t);
        });
        if (!filtered.length) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:1rem;">No students found.</td></tr>';
            return;
        }
        filtered.forEach(s => {
            const tr = document.createElement('tr');
            const name = s.namePinyin || s.nameCn || s.nickname || 'Unknown';
            const num = s.studentNumber || 'N/A';
            const tags = (s.subjects || []).map(sub =>
                `<span class="subject-tag" data-id="${s.id}" data-sub="${(sub.name || '').trim()}">${sub.name || '-'}</span>`
            ).join('') || '<span style="color:#999;">None</span>';
            tr.innerHTML = `<td>${name}</td><td>${num}</td><td><div class="subject-tags">${tags}</div></td>`;
            tbody.appendChild(tr);
        });
    }
    document.getElementById('analyticsStudentTable')?.addEventListener('click', (e) => {
        const tag = e.target.closest('.subject-tag');
        if (!tag) return;
        const stu = allStudents.find(s => s.id === tag.dataset.id);
        if (stu) openModal(stu, tag.dataset.sub);
    });

    function levelToY(levelStr, chartSub) {
        const cfg = SUBJECT_CONFIG[chartSub];
        if (!cfg) return 0;
        const { key, ws } = parseLevel(levelStr);
        const idx = cfg.levels.findIndex(l => l === key);
        return (idx >= 0 ? idx : 0) * 200 + Math.min(ws, 199);
    }
    function getMonthOffset(monthStr) {
        const m = parseInt(monthStr.split('-')[1], 10);
        return m >= 8 ? m - 8 : m + 4;
    }

    function openModal(stu, dbName) {
        const chartSub = CHART_SUBJECTS.find(cs => matchesSubject(cs, dbName));
        if (!chartSub) return;
        const m = document.getElementById('progressModal');
        document.getElementById('modalTitle').textContent = `${fullName(stu)} - ${dbName}`;
        m.classList.remove('hidden'); m.style.display = 'flex';
        renderProgressChartInModal(stu, dbName, chartSub);
    }
    function closeModal() {
        const m = document.getElementById('progressModal');
        m.classList.add('hidden'); m.style.display = 'none';
        Plotly.purge('progressChartModal');
    }
    document.getElementById('closeModalBtn')?.addEventListener('click', closeModal);
    document.getElementById('progressModal')?.addEventListener('click', e => { if (e.target.id === 'progressModal') closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeCellModal(); } });

    function renderProgressChartInModal(student, dbName, chartSub) {
        const container = document.getElementById('progressChartModal');
        const subject = (student.subjects || []).find(s => (s.name || '').trim() === dbName);
        const config = SUBJECT_CONFIG[chartSub];
        if (!subject || !config) { container.innerHTML = '<p style="text-align:center; padding:2rem; color:#666;">Subject configuration missing.</p>'; return; }
        let progress = [...(subject.progress || [])].sort((a, b) => (a?.month || '').localeCompare(b?.month || ''));
        if (!progress.length) { container.innerHTML = '<p style="text-align:center; padding:2rem; color:#666;">No progress data recorded.</p>'; return; }

        const baseGrade = student.grade || 'K0';
        const startGradeIdx = Math.max(0, GRADE_AXIS.indexOf(baseGrade));
        const xMin = Math.max(0, startGradeIdx - 4);
        const xMax = Math.min(GRADE_AXIS.length, startGradeIdx + 6);
        const startLevel = subject.startLevel || progress[0]?.currLevel || config.levels[0];
        const startLevelIdx = Math.max(0, config.levels.findIndex(l => l === parseLevel(startLevel).key));
        const achieved = progress.map(p => config.levels.indexOf(parseLevel(p.currLevel || p.prevLevel || '').key)).filter(i => i >= 0);
        const endLevelIdx = Math.max(...(achieved.length ? achieved : [startLevelIdx]), startLevelIdx);
        const levelH = 200;
        const yMin = startLevelIdx * levelH;
        const yMax = endLevelIdx * levelH + levelH;

        const xVals = [], yVals = [], hoverText = [];
        const now = nowMonthStr();
        progress.forEach(p => {
            const monthStr = p?.month;
            if (!monthStr || !monthStr.includes('-')) return;
            const steps = academicIndex(now) - academicIndex(monthStr);
            const gIdx = Math.max(0, Math.min(GRADE_AXIS.length - 1, startGradeIdx - steps));
            if (gIdx < xMin || gIdx > xMax) return;
            const x = gIdx + (getMonthOffset(monthStr) / 12);
            const y = levelToY(p.currLevel || '', chartSub);
            xVals.push(x); yVals.push(y);
            hoverText.push(`<b>${monthStr}</b><br>Grade: ${gradeLabel(GRADE_AXIS[gIdx])}<br>Level: ${p.currLevel || 'N/A'} (WS ${p.currWS || 0})`);
        });
        if (!xVals.length) { container.innerHTML = '<p style="text-align:center; padding:2rem; color:#666;">No valid data points.</p>'; return; }

        const shapes = [], annotations = [];
        for (let g = xMin; g < xMax; g++) {
            shapes.push({ type: 'line', x0: g + 0.5, x1: g + 0.5, y0: 0, y1: 1, xref: 'x', yref: 'paper', line: { color: '#e2e8f0', width: 1, dash: 'dot' } });
            annotations.push({ x: g, y: -0.07, xref: 'x', yref: 'paper', text: gradeLabel(GRADE_AXIS[g]), showarrow: false, font: { size: 9, color: '#64748b' }, xanchor: 'center' });
        }
        const yTV = [], yTT = [];
        for (let i = startLevelIdx; i <= endLevelIdx; i++) {
            yTV.push(i * levelH); yTT.push(config.levels[i]);
            [50, 100, 150].forEach(w => { yTV.push(i * levelH + w); yTT.push(String(w)); });
        }
        Plotly.newPlot(container, [{
            x: xVals, y: yVals, mode: 'lines+markers',
            line: { color: config.color, width: 2.5 }, marker: { size: 6 },
            text: hoverText, hoverinfo: 'text'
        }], {
            title: { text: `${fullName(student)} - ${dbName}`, font: { size: 14, color: '#334155' } },
            xaxis: { range: [xMin - 0.5, xMax - 0.5], showticklabels: false, zeroline: false },
            yaxis: { title: { text: 'Level / Worksheet', font: { size: 10, color: '#64748b' } }, range: [yMin, yMax], tickmode: 'array', tickvals: yTV, ticktext: yTT, gridcolor: '#f1f5f9', tickfont: { size: 8, color: '#64748b' } },
            annotations, shapes, hovermode: 'closest', margin: { t: 45, r: 25, b: 45, l: 50 }, height: 620, showlegend: false,
            hoverlabel: { font: { size: 11, color: '#f8fafc' }, bgcolor: '#1e293b' }, dragmode: 'zoom'
        }, { responsive: true, displayModeBar: false });
    }

    // ----------------------------------------
    // 9. CONTROLS WIRING
    // ----------------------------------------
    document.getElementById('centerSubjectSegmented')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.segment');
        if (!btn) return;
        document.querySelectorAll('#centerSubjectSegmented .segment').forEach(b => b.classList.toggle('active', b === btn));
        activeSubject = btn.dataset.subject;
        refreshCenter();
    });
    document.getElementById('centerMonthSelect')?.addEventListener('change', (e) => { selectedMonth = e.target.value; refreshCenter(); });
    document.getElementById('centerPrevMonth')?.addEventListener('click', () => {
        const i = allMonthsSorted.indexOf(selectedMonth);
        if (i > 0) { selectedMonth = allMonthsSorted[i - 1]; refreshCenter(); }
    });
    document.getElementById('centerNextMonth')?.addEventListener('click', () => {
        const i = allMonthsSorted.indexOf(selectedMonth);
        if (i >= 0 && i < allMonthsSorted.length - 1) { selectedMonth = allMonthsSorted[i + 1]; refreshCenter(); }
    });
    document.getElementById('colorMode')?.addEventListener('change', (e) => { colorMode = e.target.value; renderCenterChart(); });
    document.getElementById('toggleLines')?.addEventListener('change', (e) => { showLines = e.target.checked; renderCenterChart(); });
    document.getElementById('toggleCompleters')?.addEventListener('change', (e) => { showCompleters = e.target.checked; renderCompleters(); });
    document.getElementById('toggleInactive')?.addEventListener('change', (e) => { showInactive = e.target.checked; refreshCenter(); });
    document.getElementById('centerSearch')?.addEventListener('input', (e) => { centerSearchTerm = e.target.value; renderCenterChart(); });
    document.getElementById('studentSearchInput')?.addEventListener('input', (e) => { individualSearchTerm = e.target.value; renderStudentTable(individualSearchTerm); });

    document.getElementById('exportPngBtn')?.addEventListener('click', () => {
        if (!chartEl.data) return;
        Plotly.downloadImage(chartEl, { format: 'png', width: 1800, height: chartEl.clientHeight, filename: `center-map-${activeSubject}-${selectedMonth}` });
    });
    document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
        const rows = [['Subject', 'Month', 'Student', 'Student No', 'Grade', 'Level', 'WS', 'Carried', 'Status']];
        currentSnapshot.filter(p => p.subject === activeSubject).forEach(p => {
            rows.push([activeSubject, selectedMonth, fullName(p.student), p.student.studentNumber || '', gradeLabel(GRADE_AXIS[p.gradeIdx]), SUBJECT_CONFIG[activeSubject].levels[p.row], p.ws, p.carried ? 'yes' : 'no', p.status]);
        });
        const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = `center-map-${activeSubject}-${selectedMonth}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // ----------------------------------------
    // 10. REALTIME DATA + INIT
    // ----------------------------------------
    let rtTimer = null;
    function ingest(snap) {
        allStudents = [];
        if (snap.exists()) {
            snap.forEach(c => { const v = c.val(); if (v) { v.id = c.key; normalizeArrays(v); allStudents.push(v); } });
        }
    }
    function initGraphs() {
        loader?.classList.remove('hidden');
        get(studentsRef).then(snap => {
            ingest(snap);
            renderStudentTable();
            switchTab(sessionStorage.getItem('graphsTab') === 'center' ? 'center' : 'individual');
            if (sessionStorage.getItem('graphsTab') === 'center') { refreshCenter(); centerBuilt = true; }
        }).catch(err => {
            console.error('❌ Load error:', err);
            alert('Failed to load analytics data.');
        }).finally(() => loader?.classList.add('hidden'));

        // 🔴 Realtime: re-render whenever monthly reports / students change
        onValue(studentsRef, (snap) => {
            ingest(snap);
            clearTimeout(rtTimer);
            rtTimer = setTimeout(() => {
                renderStudentTable(individualSearchTerm);
                const centerVisible = document.getElementById('tab-center')?.classList.contains('active');
                if (centerVisible) { refreshCenter(); } else { centerBuilt = false; }
            }, 250);
        });
    }

    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    initGraphs();
}