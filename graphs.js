import { auth, db, logout } from './auth.js';
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const REQUIRED_PERMISSION = 'progressCharts';

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
            initializeGraphs();
        } else {
            // 🚫 BLOCKED: Hide content, show error
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
// 📄 MAIN APP LOGIC (Only runs if authorized)
// ==========================================
function initializeGraphs() {
    const centerId = sessionStorage.getItem('selectedCenter');
    const studentsRef = ref(db, `centers/${centerId}/students`);
    const loader = document.getElementById('loadingOverlay');
    let allStudents = [];

    // 1. Config
    const SUBJECT_CONFIG = {
        'English EFL': { color: '#FFB366', levels: ['7A','6A','5A','4A','3A','2A','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'] },
        'Math': { color: '#7DD3C0', levels: ['6A','5A','4A','3A','2A','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'] },
        'Chinese': { color: '#C8E67A', levels: ['7A','6A','5A','4A','3A','2A','AI','AII','BI','BII','CI','CII','DI','DII','EI','EII','FI','FII','GI','GII','HI','HII','I','II','J','K','L'] },
        'English ERP': { color: '#FF9999', levels: ['7A','6A','5A','4A','3A','2A','AI','AII','BI','BII','CI','CII','DI','DII','EI','EII','FI','FII','GI','GII','HI','HII','I','II','J','K','L'] }
    };
    const GRADE_LEVELS = ['K0','K1','K2','K3','1','2','3','4','5','6','7','8','9','10','11','12','13'];
    const SCHOOL_YEAR_MONTHS = [8,9,10,11,12,1,2,3,4,5,6,7];
    const LABELED_MONTHS = {11: '11', 2: '2', 5: '5', 8: '8'};

    // 2. Helpers
    function parseLevel(levelStr) {
        if (!levelStr) return { key: '', ws: 0 };
        const s = String(levelStr).trim().toUpperCase();
        const match = s.match(/^(\d*[A-Z]+(?:II?)?)\s*(\d*)$/);
        return match ? { key: match[1], ws: match[2] ? parseInt(match[2], 10) : 0 } : { key: s.replace(/\s/g, ''), ws: 0 };
    }
    function levelToY(levelStr, subjectName) {
        const config = SUBJECT_CONFIG[subjectName];
        if (!config) return 0;
        const { key, ws } = parseLevel(levelStr);
        const idx = config.levels.findIndex(l => l === key);
        return (idx >= 0 ? idx : 0) * 200 + Math.min(ws, 199);
    }
    function getMonthOffset(monthStr) {
        const m = parseInt(monthStr.split('-')[1], 10);
        return m >= 8 ? m - 8 : m + 4;
    }
    function formatMonthLabel(m) {
        const [y, mon] = m.split('-');
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return `${months[parseInt(mon)-1]} '${y.slice(2)}`;
    }

    // 🔧 SAFETY: Normalize arrays from Firebase objects
    function normalizeArrays(data) {
        data.subjects = Array.isArray(data.subjects) ? data.subjects : Object.values(data.subjects || {});
        if (Array.isArray(data.subjects)) {
            data.subjects.forEach(sub => {
                sub.progress = Array.isArray(sub.progress) ? sub.progress : Object.values(sub.progress || {});
            });
        }
    }

    // 3. Individual Modal Chart
    function renderProgressChartInModal(student, subName) {
        const container = document.getElementById('progressChartModal');
        const subject = student?.subjects?.find(s => (s.name || '').trim() === subName);
        const config = SUBJECT_CONFIG[subName];
        if (!subject || !config) {
            container.innerHTML = '<p style="text-align:center; padding:2rem; color:#666;">Subject configuration missing.</p>';
            return;
        }
        let progress = subject.progress || [];
        if (progress.length === 0) {
            container.innerHTML = '<p style="text-align:center; padding:2rem; color:#666;">No progress data recorded.</p>';
            return;
        }
        progress = [...progress].sort((a, b) => (a?.month || '').localeCompare(b?.month || ''));
        const xVals = [], yVals = [], hoverText = [];
        
        const baseGrade = student.startGrade || student.grade || 'K0';
        const baseYear = parseInt(student.startYear) || (new Date().getFullYear() - 5);
        const startGradeIdx = Math.max(0, GRADE_LEVELS.indexOf(baseGrade));
        const xMin = startGradeIdx;
        const xMax = Math.min(GRADE_LEVELS.length, startGradeIdx + 8);
        const startLevel = subject.startLevel || progress[0]?.currLevel || config.levels[0];
        const startLevelIdx = Math.max(0, config.levels.findIndex(l => l === startLevel));
        const achievedLevels = progress.map(p => config.levels.findIndex(l => l === (p?.currLevel || p?.prevLevel || ''))).filter(i => i >= 0);
        const highestIdx = achievedLevels.length ? Math.max(...achievedLevels) : startLevelIdx;
        const endLevelIdx = Math.max(highestIdx, config.levels.length - 1);
        const levelH = 200;
        const yMin = startLevelIdx * levelH;
        const yMax = endLevelIdx * levelH + levelH;

        progress.forEach(p => {
            const monthStr = p?.month;
            if (!monthStr || !monthStr.includes('-')) return;
            const py = parseInt(monthStr.split('-')[0]);
            if (isNaN(py)) return;

            const gIdx = Math.min(GRADE_LEVELS.length - 1, Math.max(0, startGradeIdx + (py - baseYear)));
            if (gIdx < xMin || gIdx > xMax) return;

            const x = gIdx + (getMonthOffset(monthStr) / 12);
            const y = levelToY(p.currLevel || '', subName);
            if (isNaN(y)) return;

            xVals.push(x); yVals.push(y);
            hoverText.push(`<b>${monthStr}</b><br>Grade: ${GRADE_LEVELS[gIdx]}<br>Level: ${p.currLevel || 'N/A'} (WS ${p.currWS || 0})`);
        });

        if (xVals.length === 0) {
            container.innerHTML = '<p style="text-align:center; padding:2rem; color:#666;">No valid data points for this date range.</p>';
            return;
        }

        const shapes = [], annotations = [];
        for (let i = xMin; i < xMax; i++) {
            shapes.push({ type:'rect', x0:i, x1:i+1, y0:0, y1:1, xref:'x', yref:'paper', fillcolor:(i-xMin)%2?'rgba(241,245,249,0.3)':'rgba(255,255,255,0)', line:{width:0}, layer:'below' });
        }
        for (let g = xMin; g < xMax; g++) {
            for (let m = 0; m < 12; m++) {
                const x = g + (m/12);
                shapes.push({ type:'line', x0:x, x1:x, y0:0, y1:1, xref:'x', yref:'paper', line:{color:'#e2e8f0', width:1, dash:'dot'} });
                const mNum = SCHOOL_YEAR_MONTHS[m];
                if (LABELED_MONTHS[mNum]) annotations.push({ x, y:1.015, xref:'x', yref:'paper', text:LABELED_MONTHS[mNum], showarrow:false, font:{size:8, color:'#94a3b8'}, xanchor:'center' });
            }
        }
        for (let i = xMin; i < xMax; i++) {
            annotations.push({ x:i+0.5, y:-0.05, xref:'x', yref:'paper', text:GRADE_LEVELS[i], showarrow:false, font:{size:9, color:'#64748b'}, xanchor:'center' });
        }
        const yTV = [], yTT = [];
        for (let i = startLevelIdx; i <= endLevelIdx; i++) {
            yTV.push(i * levelH); yTT.push(config.levels[i]);
            [50,100,150].forEach(w => { yTV.push(i * levelH + w); yTT.push(w.toString()); });
        }

        Plotly.newPlot(container, [{
            x: xVals, y: yVals, mode:'lines+markers', line:{color:config.color, width:2.5}, marker:{size:6}, text:hoverText, hoverinfo:'text'
        }], {
            title: { text: `${student.namePinyin||student.nameCn||'Student'} - ${subName}`, font:{size:14, color:'#334155'} },
            xaxis: { title:{text:`Grade (Start: ${baseGrade})`, font:{size:10, color:'#64748b'}}, range:[xMin, xMax], showticklabels:false, zeroline:false },
            yaxis: { title:{text:'Level / Worksheet', font:{size:10, color:'#64748b'}}, range:[yMin, yMax], tickmode:'array', tickvals:yTV, ticktext:yTT, gridcolor:'#f1f5f9', tickfont:{size:8, color:'#64748b'} },
            annotations, shapes, hovermode:'closest', margin:{t:45, r:25, b:45, l:45}, height:620, showlegend:false,
            hoverlabel: { font:{size:11, color:'#f8fafc'}, bgcolor:'#1e293b' }, dragmode:'zoom'
        }, {responsive:true, displayModeBar:false});
    }

    // 4. Aggregate Chart
    let currentMonthIdx = 0;
    const MONTHS_VISIBLE = 6;
    let allMonthsSorted = [];
    let monthSubjectCounts = {};

    function prepareAggregateData() {
        monthSubjectCounts = {};
        const mSet = new Set();
        allStudents.forEach(s => {
            s.subjects?.forEach(sub => {
                sub.progress?.forEach(p => {
                    if (p?.month) mSet.add(p.month);
                    if (!monthSubjectCounts[p.month]) monthSubjectCounts[p.month] = {};
                    monthSubjectCounts[p.month][sub.name] = (monthSubjectCounts[p.month][sub.name] || 0) + 1;
                });
            });
        });
        allMonthsSorted = Array.from(mSet).sort();
        currentMonthIdx = 0;
        updateChartView();
    }

    function updateChartView() {
        const total = allMonthsSorted.length;
        const start = currentMonthIdx;
        const end = Math.min(start + MONTHS_VISIBLE, total);
        const visibleMonths = allMonthsSorted.slice(start, end);
        const visibleLabels = visibleMonths.map(formatMonthLabel);
        const rangeDisplay = document.getElementById('monthRange');
        
        if (rangeDisplay) {
            rangeDisplay.textContent = visibleMonths.length > 0 ? `${visibleLabels[0]} → ${visibleLabels[visibleLabels.length-1]}` : "No Data";
            rangeDisplay.style.color = visibleMonths.length > 0 ? '#334155' : '#999';
        }

        const traces = Object.keys(SUBJECT_CONFIG).map(sub => ({
            x: visibleLabels,
            y: visibleMonths.map(m => monthSubjectCounts[m]?.[sub] || 0),
            name: sub,
            type: 'bar',
            marker: { color: SUBJECT_CONFIG[sub].color, opacity: 0.85, line: {color:'#fff', width:1} },
            hovertemplate: `<b>${sub}</b><br>%{x}<br>Students: %{y}<extra></extra>` 
        }));

        Plotly.newPlot('studentsChart', traces, {
            title: { text: 'Enrollment Trends by Subject', font: { size: 13, color: '#334155' } },
            barmode: 'group', bargap: 0.25,
            xaxis: { title: 'Month', tickangle: -45, automargin: true, tickfont: { size: 9 } },
            yaxis: { title: 'Active Students', dtick: 1, tickfont: { size: 9 } },
            margin: { t: 40, r: 15, b: 60, l: 40 }, height: 380,
            legend: { orientation: 'h', y: -0.15, font: { size: 10 } },
            hovermode: 'x unified'
        }, { responsive: true, displayModeBar: false });

        const prev = document.getElementById('prevMonths');
        const next = document.getElementById('nextMonths');
        if (prev) prev.disabled = start === 0;
        if (next) next.disabled = end >= total;
    }

    // 5. Table & Modal Logic
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
            const tags = s.subjects?.map(sub => 
                `<span class="subject-tag" data-id="${s.id}" data-sub="${sub.name}">${sub.name}</span>` 
            ).join('') || '<span style="color:#999;">None</span>';
            tr.innerHTML = `<td>${name}</td><td>${num}</td><td><div class="subject-tags">${tags}</div></td>`;
            tbody.appendChild(tr);
        });
    }

    document.getElementById('analyticsStudentTable')?.addEventListener('click', (e) => {
        const tag = e.target.closest('.subject-tag');
        if (tag) {
            const stu = allStudents.find(s => s.id === tag.dataset.id);
            if (stu) openModal(stu, tag.dataset.sub);
        }
    });

    function openModal(stu, sub) {
        const m = document.getElementById('progressModal');
        document.getElementById('modalTitle').textContent = `${stu.namePinyin||stu.nameCn||'Student'} - ${sub}`;
        m.classList.remove('hidden'); m.style.display = 'flex';
        renderProgressChartInModal(stu, sub);
    }

    function closeModal() {
        const m = document.getElementById('progressModal');
        m.classList.add('hidden'); m.style.display = 'none';
        Plotly.purge('progressChartModal');
    }

    document.getElementById('closeModalBtn')?.addEventListener('click', closeModal);
    document.getElementById('progressModal')?.addEventListener('click', e => { if(e.target.id==='progressModal') closeModal(); });
    document.addEventListener('keydown', e => { if(e.key==='Escape') closeModal(); });

    // 6. Navigation
    document.getElementById('prevMonths')?.addEventListener('click', () => {
        if (currentMonthIdx > 0) { currentMonthIdx = Math.max(0, currentMonthIdx - MONTHS_VISIBLE); updateChartView(); }
    });
    document.getElementById('nextMonths')?.addEventListener('click', () => {
        if (currentMonthIdx + MONTHS_VISIBLE < allMonthsSorted.length) { currentMonthIdx += MONTHS_VISIBLE; updateChartView(); }
    });

    // 7. Initialization
    async function initGraphs() {
        loader?.classList.remove('hidden');
        try {
            const snap = await get(studentsRef);
            allStudents = [];
            if (snap.exists()) {
                snap.forEach(c => {
                    const v = c.val();
                    v.id = c.key;
                    normalizeArrays(v);
                    allStudents.push(v);
                });
            }
            renderStudentTable();
            prepareAggregateData();
            document.getElementById('studentSearchInput')?.addEventListener('input', e => renderStudentTable(e.target.value));
        } catch (err) {
            console.error('❌ Load error:', err);
            alert('Failed to load analytics data.');
        } finally {
            loader?.classList.add('hidden');
        }
    }

    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    
    // Start the app
    initGraphs();
}