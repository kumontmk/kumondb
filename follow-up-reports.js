// 📣 VERSION M — Per-student history now opens in a MODAL timeline:
//    click a name → modal with compact timeline → click a timeline row → expands contents.
//    FIX: .m-dot month chips were unstyled ("JunJulAugSepOctNov") → CSS added; strip moved into modal.
//    The old inline #pshDetail panel is hidden (no HTML layout changes).
//    Keeps: 👤 Per Student History tab, tab memory, copy-message, recent-sort + onlyFu filter.
window.__fuBooted = true;
console.info('%c📣 follow-up-reports.js VERSION M loaded', 'color:#065f46;font-weight:700');
import { auth, db, logout } from './auth.js';
import { ref, get, update, remove, push, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t, applyI18n, currentLanguage } from './follow-up-reports-i18n.js';
await i18nReady.catch(() => {});
document.documentElement.lang = currentLanguage;
applyI18n();
const SUBJECTS = ['Math', 'English ERP', 'English EFL', 'Chinese (Trad)', 'Chinese (Simp)'];
const GRADE_ORDER = ['K0','K1','K2','K3','1','2','3','4','5','6','7','8','9','10','11','12','13'];
const ITEMS_PER_PAGE = 100;
const PICKER_MAX_ROWS = 50;
const ROSTER_STATUSES = ['Current'];
const OVERDUE_SEVERE_DAYS = 60;
const OVERDUE_WARNING_DAYS = 30;
const RECENT_LOGS_LIMIT = 500;
const TREND_MONTHS = 6;
const PRESELECT_TIMEOUT_MS = 10000;
const CENTER_ABBREVIATIONS = [
{ abbr: 'PT', test: s => s.includes('tat') && (s.includes('pac') || s.includes('pat')) },
{ abbr: 'MK', test: s => s.includes('mei') && s.includes('keng') },
{ abbr: 'TS', test: s => s.includes('tap') && s.includes('siac') },
{ abbr: 'C',  test: s => s.includes('champs') }
];
function getCenterAbbr(name) {
if (!name) return '';
const s = String(name).toLowerCase();
const rule = CENTER_ABBREVIATIONS.find(r => r.test(s));
if (rule) return rule.abbr;
const stripped = String(name).replace(/^kumon[\s.-]*/i, '').trim();
return (stripped || String(name)).substring(0, 2).toUpperCase();
}
const TEMPLATES = {
progress: {
en: "Dear parents of {name},\n\nHere is a progress update for {subject}. {name} is currently working on Level {level} and has been doing well in class.\n\nPlease feel free to reach out if you have any questions.\n\nBest regards,\n{teacher}\nKumon {center}",
zh: "{name}家長您好：\n\n這是{name}{subject}科的進度匯報。{name}目前學習至{level}階段，課堂表現良好。\n\n如有任何疑問，歡迎隨時與我們聯繫。\n\n{teacher} 敬上\nKumon {center}"
},
levelup: {
en: "Dear parents of {name},\n\nCongratulations! {name} has completed Level {level} in {subject} and will be moving up to the next level. Keep up the great work!\n\nBest regards,\n{teacher}\nKumon {center}",
zh: "{name}家長您好：\n\n恭喜！{name}已完成{subject}科{level}階段的學習，即將進入下一階段。請繼續加油！\n\n{teacher} 敬上\nKumon {center}"
},
short: {
en: "Dear parents of {name},\n\nJust a quick note: {name} attended class today and is progressing steadily in {subject} (Level {level}).\n\nBest regards,\n{teacher}\nKumon {center}",
zh: "{name}家長您好：\n\n簡短通知：{name}今天如常上課，{subject}科（{level}階段）進度穩定。\n\n{teacher} 敬上\nKumon {center}"
}
};
const state = {
currentUser: null,
centerId: '', centerName: '', centerNames: {},
allStudents: [], followUps: [],
teachersMap: {}, teacherOptions: [],
dataLoaded: false, loadError: '',
viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth() + 1,
currentPage: 1, filteredRoster: [], selectedIds: new Set(),
logStudents: [], rosterCache: {}, trendCache: {},
logSearch: '', logSubject: '',
psh: { search: '', status: '', sort: 'recent', selectedId: null, onlyFu: false },
shm: { studentId: null, expandedId: null },
_fuByStudent: null
};
const $ = id => document.getElementById(id);
const pad2 = n => String(n).padStart(2, '0');
const ymKey = (y, m) => `${y}-${pad2(m)}`;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; };
const monthLabel = (y, m) => new Date(y, m-1, 1).toLocaleDateString('en-US', { month:'long', year:'numeric' });
const isCurrentMonth = (y, m) => { const d = new Date(); return d.getFullYear()===y && d.getMonth()+1===m; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = d => { if(!d) return '-'; const dt = new Date(d+'T00:00:00'); if(isNaN(dt.getTime())) return String(d); return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); };
const truncate = (s, n=60) => { s = String(s||'').replace(/\s+/g,' ').trim(); return s.length > n ? s.slice(0,n)+'…' : s; };
const nameOf = s => s.nameCn || s.namePinyin || s.nickname || s.name || s.englishName || '-';
const searchHay = s => s._search || [s.nameCn,s.namePinyin,s.nickname,s.studentNumber,s.school,s.nameEn,s.englishName,s.name,s.chineseName].filter(Boolean).join(' ').toLowerCase();
const centerTag = name => name ? `<span class="fu-badge b-msg" title="${esc(name)}">🏫 ${esc(getCenterAbbr(name))}</span>` : '';
const maskPhone = p => { if (!p) return ''; const s = String(p); if (s.replace(/\D/g,'').length < 4) return s; return s.replace(/\d(?=(?:\D*\d){3})/g, 'X'); };
function debounce(fn, ms = 250) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
function showToast(msg, isError=false) { const t = $('toast'); if(!t) return; t.textContent = msg; t.className = 'toast'+(isError?' error':''); clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.add('hidden'), 3500); }
function showConfirm(message, onConfirm) { const msg = $('confirmMessage'), modal = $('confirmModal'), yes = $('confirmYesBtn'); if(!msg||!modal||!yes){ if(confirm(message)) onConfirm(); return; } msg.textContent = message; modal.classList.remove('hidden'); yes.onclick = () => { modal.classList.add('hidden'); onConfirm(); }; }
function centerFollowUps() { return state.followUps.filter(f => f.centerId === state.centerId); }
const isSent = f => f.type==='call' ? true : (f.sent !== undefined ? !!f.sent : !!f.dateSent);
const effMonth = f => { if (f.type==='call') return (f.dateSent||'').slice(0,7); return isSent(f) ? (f.dateSent||'').slice(0,7) : ''; };
const logMonth = f => (f.dateCreated || f.dateSent || '').slice(0,7);
function resolveCenterId() {
const keys = Object.keys(state.centerNames);
const pick = raw => (raw && keys.includes(raw)) ? raw : null;
const q = new URLSearchParams(location.search);
let cid = pick((q.get('center')||q.get('centerId')||'').trim());
if (!cid) cid = pick((sessionStorage.getItem('selectedCenter')||'').trim());
if (!cid) cid = pick((localStorage.getItem('selectedCenter')||'').trim());
if (!cid && keys.length) {
cid = keys.map(id => ({ id, n: state.allStudents.filter(s => s.centerId===id && ROSTER_STATUSES.includes(computeOverallStatus(s))).length })).sort((a,b)=>b.n-a.n)[0].id;
}
state.centerId = cid || ''; state.centerName = state.centerNames[cid] || '';
}
onAuthStateChanged(auth, async (user) => {
if (!user) { window.location.href='index.html'; return; }
let profile = null;
try {
const s = await get(ref(db, `users/${user.uid}`));
if (!s.exists()) { window.location.href='index.html'; return; }
profile = s.val();
} catch(e) { console.error('Auth/profile check failed:', e); window.location.href='index.html'; return; }
state.currentUser = { uid:user.uid, email:user.email||'', name:profile.englishName||profile.chineseName||user.email };
const ad = $('accessDenied'); if(ad) ad.classList.add('hidden');
const mc = $('mainContent');  if(mc) mc.classList.remove('hidden');
try { initializePage(); }
catch(e) {
console.error('Page init error:', e);
const pl = $('page-loader'); if(pl) pl.classList.add('hidden');
showToast('⚠️ Page failed to load — check console', true);
}
});
function initializePage() {
onValue(ref(db, 'centers'), snap => {
const students = [], fus = [];
state.centerNames = {};
if (snap.exists()) snap.forEach(cc => {
const cid = cc.key, val = cc.val() || {}, cname = val.name || val.centerName || cid;
state.centerNames[cid] = cname;
Object.entries(val.students || {}).forEach(([sid,v]) => {
const stu = { id:sid, centerId:cid, centerName:cname, ...(v||{}) };
stu._search = [stu.nameCn,stu.namePinyin,stu.nickname,stu.studentNumber,stu.school,stu.nameEn,stu.englishName,stu.name,stu.chineseName].filter(Boolean).join(' ').toLowerCase();
students.push(stu);
});
Object.entries(val.followUps || {}).forEach(([fid,v]) => fus.push({ id:fid, centerId:cid, centerName:cname, ...(v||{}) }));
});
students.sort((a,b)=>(a.namePinyin||a.nameCn||'').localeCompare(b.namePinyin||b.nameCn||''));
state.allStudents = students; state.followUps = fus;
state._fuByStudent = null;
state.dataLoaded = true; state.loadError = ''; state.rosterCache = {}; state.trendCache = {};
resolveCenterId(); renderAll();
}, err => { state.loadError = err.message; renderDataStatus(); });
loadTeachers();
try { bindEvents(); } catch(e) { console.error('bindEvents partial failure:', e); }
// VERSION M: old inline detail panel is replaced by the history modal
$('pshDetail')?.classList.add('hidden');
const preId = new URLSearchParams(location.search).get('student');
if (preId) {
switchTab('log');
let elapsed = 0;
const chk = setInterval(() => {
elapsed += 300;
const s = state.allStudents.find(x => x.id === preId);
if (s) { addLogStudent(s); clearInterval(chk); }
else if (state.dataLoaded || elapsed > PRESELECT_TIMEOUT_MS) { clearInterval(chk); if (!s) showToast('⚠️ Pre-selected student not found', true); }
}, 300);
} else {
let saved = null; try { saved = sessionStorage.getItem('fuLastTab'); } catch(_) {}
if (saved && document.querySelector(`.tab-btn[data-tab="${saved}"]`)) switchTab(saved);
}
renderAll();
}
async function loadTeachers() {
try {
const emp = await get(ref(db,'employees'));
if (emp.exists()) Object.entries(emp.val()).forEach(([uid,e]) => {
if (e.isDisabled) return;
const name = e.englishName||e.chineseName||'Unknown';
state.teachersMap[uid] = name; state.teacherOptions.push({uid,name});
});
state.teacherOptions.sort((a,b) => a.name.localeCompare(b.name));
} catch(e) { console.warn(e); }
fillTeacherSelect($('teacherSelect')); fillTeacherSelect($('editTeacherSelect'));
const sel = $('filterTeacher');
if (sel) sel.innerHTML = `<option value="">All Teachers</option>` + state.teacherOptions.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
const me = state.teacherOptions.find(t => t.uid === state.currentUser?.uid || t.name === state.currentUser?.name);
if (me) { const ts = $('teacherSelect'); if(ts) ts.value = me.uid; const es = $('editTeacherSelect'); if(es) es.value = me.uid; }
}
function fillTeacherSelect(sel) { if(!sel) return; sel.innerHTML = `<option value="">— ${esc(state.currentUser?.name||'Me')} —</option>` + state.teacherOptions.map(t => `<option value="${esc(t.uid)}">${esc(t.name)}</option>`).join(''); }
function renderDataStatus() {
const chip = $('dataStatus'); if(!chip) return;
chip.title = `Reports & stats cover: ${state.centerName||'—'}. Log search sees every student.`;
if (state.loadError) { chip.className='status-chip err'; chip.textContent='❌ Load failed — click to retry'; chip.onclick=()=>location.reload(); }
else if (!state.dataLoaded) { chip.className='status-chip loading'; chip.textContent='⏳ Loading students…'; chip.onclick=null; }
else {
const cur = state.allStudents.filter(s=>s.centerId===state.centerId && ROSTER_STATUSES.includes(computeOverallStatus(s))).length;
chip.className='status-chip ok';
chip.textContent=`🏫 ${state.centerName||'—'} · ${cur} current · search: ${state.allStudents.length} in DB`;
chip.onclick=null;
}
const cl = $('centerLabel'); if(cl) cl.textContent = state.centerName ? `Center: ${state.centerName}` : '';
}
function getSubjectsArray(subjects) { if(!subjects) return []; if(Array.isArray(subjects)) return subjects; if(typeof subjects==='object') return Object.values(subjects); return []; }
function computeOverallStatus(student) {
const subjects = getSubjectsArray(student?.subjects);
if(!subjects.length) return student?.overallStatus||'Drop';
const st = subjects.map(s => String(s?.status||'').toLowerCase());
if(st.includes('current')) return 'Current';
if(st.includes('inquiry')) return 'Inquiry';
if(st.every(x => x==='drop')) return 'Drop';
if(st.includes('completer') && st.every(x => x==='drop'||x==='completer')) return 'Completer';
return 'Pause';
}
function subjectStatusInMonth(sub,y,m) {
if(!sub||!sub.name) return null;
const status = String(sub.status||'current').toLowerCase();
if(isCurrentMonth(y,m)) { if(status==='current') return 'current'; if(status==='pause') return 'paused'; if(status==='inquiry') return 'inquiry'; return null; }
if(status==='inquiry'||status==='completer') return null;
if(sub.enrolDate) { const d = new Date(sub.enrolDate+'T00:00:00'); if(!isNaN(d.getTime()) && (d.getFullYear() >y || (d.getFullYear()===y && d.getMonth()+1 >m))) return null; }
const dropActive = (dm,dy) => { const MM = parseInt(dm), YY = parseInt(dy); if(!MM||!YY) return true; return YY >y || (YY===y && MM >m); };
if(status==='drop') return dropActive(sub.dropMonth,sub.dropYear) ? 'current' : null;
const pr = (sub.pendingRequest && !sub.pendingRequest.cancelled) ? sub.pendingRequest : null;
if(pr && pr.type==='drop' && !dropActive(pr.dropMonth,pr.dropYear)) return null;
if(status==='pause') {
const pfY = parseInt(sub.pauseFromYear), pfM = parseInt(sub.pauseFromMonth), ptY = parseInt(sub.pauseToYear), ptM = parseInt(sub.pauseToMonth);
const cur = y*12+m, from = (pfY&&pfM) ? pfY*12+pfM : 0, to = (ptY&&ptM) ? ptY*12+ptM : Infinity;
return (cur >=from && cur <=to) ? 'paused' : 'current';
}
return 'current';
}
function formatTimeslots(sub) { let ts = sub?.timeslots; if(ts && !Array.isArray(ts)) ts = Object.values(ts); if(!Array.isArray(ts)||!ts.length) return ''; return ts.filter(t => t && (t.day||t.time)).map(t => `${String(t.day||'').slice(0,3)} ${t.time||''}`.trim()).join(', '); }
function assignedTeacherNames(student,subjectName) { const at = student?.assignedTeachers?.[subjectName]; if(!Array.isArray(at)) return ''; return at.map(uid => state.teachersMap[uid]).filter(Boolean).join(', '); }
function getStudentMonthSubjects(student,y,m) { return getSubjectsArray(student.subjects).map(sub => ({sub, eff: subjectStatusInMonth(sub,y,m)})).filter(x => x.eff!==null); }
function buildRoster(y,m) {
const cacheKey = `${state.centerId}|${ymKey(y,m)}`;
if(state.rosterCache[cacheKey]) return state.rosterCache[cacheKey];
const key = ymKey(y,m);
const fuBy = {};
centerFollowUps().forEach(f => { if(f.studentId) (fuBy[f.studentId] = fuBy[f.studentId] || []).push(f); });
const roster = [];
state.allStudents.filter(s => s.centerId === state.centerId).forEach(student => {
const overall = computeOverallStatus(student);
if(!ROSTER_STATUSES.includes(overall)) return;
let subs = getStudentMonthSubjects(student,y,m);
if(!subs.length) subs = [{sub:{name:'General',currentLevel:'',startLevel:'',enrolDate:'',timeslots:[]},eff:'current'}];
const records = fuBy[student.id] || [];
const monthRecords = records.filter(f => effMonth(f) === key);
let lastDate = ''; records.forEach(f => { if(!effMonth(f)) return; const d = f.dateSent||''; if(d > lastDate) lastDate = d; });
let daysSince = null;
if(lastDate) { const d = new Date(lastDate+'T00:00:00'); const now = new Date(); now.setHours(0,0,0,0); if(!isNaN(d.getTime()))  daysSince = Math.round((now-d)/86400000); }
let status;
if(monthRecords.length > 0) status = 'followed';
else if(!lastDate) status = 'never';
else if(daysSince >= OVERDUE_SEVERE_DAYS) status = 'overdue60';
else if(daysSince >= OVERDUE_WARNING_DAYS) status = 'overdue30';
else status = 'recent';
roster.push({ student, id: student.id,
nameCn: student.nameCn||student.chineseName||student.name||'', namePinyin: student.namePinyin||student.pinyin||'',
nickname: student.nickname||'', grade: student.grade||'', school: student.school||'', centerName: student.centerName||'',
subjects: subs.map(({sub,eff}) => ({name:sub.name, level:sub.currentLevel||sub.startLevel||'-', effStatus:eff, enrolDate:sub.enrolDate||'', schedule:formatTimeslots(sub)})),
records, monthRecords, lastDate, daysSince, status });
});
state.rosterCache[cacheKey] = roster;
return roster;
}
function renderAll() {
try { renderDataStatus(); renderMonthTitle(); renderStats(); renderTracker(); renderRecentLogs(); renderReport();
if ($('tab-studentHistory')?.classList.contains('active')) renderStudentHistory();
if (!$('shmOverlay')?.classList.contains('hidden')) renderShm();
} catch(e) { console.error('Render error:', e); }
const pl = $('page-loader'); if(pl) pl.classList.add('hidden');
}
function renderMonthTitle() { const l = monthLabel(state.viewYear,state.viewMonth); const mt = $('monthTitle'); if(mt) mt.textContent = l; const rm = $('recentMonthLabel'); if(rm) rm.textContent = l; const rp = $('reportMonthLabel'); if(rp) rp.textContent = l; }
function changeMonth(d) { let m = state.viewMonth+d, y = state.viewYear; if(m<1){m=12;y--;} if(m>12){m=1;y++;} state.viewMonth = m; state.viewYear = y; state.selectedIds.clear(); renderAll(); }
function renderStats() {
const strip = $('statStrip'); if(!strip) return;
const r = buildRoster(state.viewYear,state.viewMonth); const total = r.length;
const followed = r.filter(x => x.status==='followed').length, not = total-followed;
const never = r.filter(x => x.status==='never').length, od = r.filter(x => x.status==='overdue60').length;
const pct = total ? Math.round(followed/total*100) : 0;
strip.innerHTML = [
`<div class="balance-card"><div class="bc-title">Current Students</div><div class="bc-num">${total}</div><div class="bc-sub">${esc(state.centerName||'—')}</div></div>`,
`<div class="balance-card bc-good clickable" data-status="followed"><div class="bc-title">Followed Up</div><div class="bc-num">${followed}</div><div class="bc-sub">this month</div></div>`,
`<div class="balance-card bc-warn clickable" data-status="not"><div class="bc-title">Not Followed</div><div class="bc-num">${not}</div><div class="bc-sub">need attention</div></div>`,
`<div class="balance-card bc-bad clickable" data-status="overdue60"><div class="bc-title">60+ Days</div><div class="bc-num">${od}</div><div class="bc-sub">no contact</div></div>`,
`<div class="balance-card bc-bad clickable" data-status="never"><div class="bc-title">Never Contacted</div><div class="bc-num">${never}</div><div class="bc-sub">all time</div></div>`,
`<div class="balance-card"><div class="bc-title">Coverage</div><div class="bc-num">${pct}%</div><div class="cov-bar"><div class="cov-fill" style="width:${pct}%"></div></div></div>`
].join('');
strip.querySelectorAll('.clickable').forEach(el => el.onclick = () => { const fs = $('filterStatus'); if(fs) fs.value = el.dataset.status; switchTab('tracker'); state.currentPage = 1; renderTracker(); });
}
function renderTracker() {
const tb = $('trackerBody'); if(!tb) return;
const r = buildRoster(state.viewYear,state.viewMonth); let f = [...r];
const term = ($('searchInput')?.value ||'').trim().toLowerCase();
const fs = $('filterSubject')?.value||'', ft = $('filterTeacher')?.value||'', fg = $('filterGrade')?.value||'', fst = $('filterStatus')?.value||'';
if(term) f = f.filter(x => searchHay(x.student).includes(term));
if(fs) f = f.filter(x => x.subjects.some(s => s.name===fs));
if(fg) f = f.filter(x => x.grade===fg);
if(ft) f = f.filter(x => x.subjects.some(s => assignedTeacherNames(x.student,s.name).includes(ft)));
if(fst) f = f.filter(x => { switch(fst) {
case 'followed': return x.status==='followed';
case 'not': return x.status!=='followed';
case 'overdue30': return x.daysSince!==null && x.daysSince >=OVERDUE_WARNING_DAYS;
case 'overdue60': return x.daysSince!==null && x.daysSince >=OVERDUE_SEVERE_DAYS;
case 'never': return x.status==='never';
default: return true; } });
const sk = $('sortBy')?.value||'longest'; const gi = g => { const i = GRADE_ORDER.indexOf(String(g)); return i===-1 ? 99 : i; };
f.sort((a,b) => { switch(sk) {
case 'name': return (a.namePinyin||a.nameCn).localeCompare(b.namePinyin||b.nameCn);
case 'grade': return gi(a.grade)-gi(b.grade);
case 'monthCount': return b.monthRecords.length-a.monthRecords.length;
default: { const av = a.daysSince===null ? Infinity : a.daysSince, bv = b.daysSince===null ? Infinity : b.daysSince; return bv-av; } } });
state.filteredRoster = f;
const tp = Math.max(1, Math.ceil(f.length/ITEMS_PER_PAGE)); if(state.currentPage > tp) state.currentPage = tp;
const start = (state.currentPage-1)*ITEMS_PER_PAGE, page = f.slice(start, start+ITEMS_PER_PAGE);
tb.innerHTML = page.length ? page.map(rowHtml).join(' ') :
`<tr><td colspan="9" class="hint-cell"><div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">${state.dataLoaded?'No students match your filters':'Loading…'}</div></div></td></tr>`;
renderPagination(f.length, tp); renderBulkBar();
tb.querySelectorAll('[data-action]').forEach(b => b.onclick = () => {
const e = state.filteredRoster.find(x => x.id===b.dataset.id) || buildRoster(state.viewYear,state.viewMonth).find(x => x.id===b.dataset.id);
if(!e) return;
if(b.dataset.action==='log') { switchTab('log'); addLogStudent(e.student); }
else if(b.dataset.action==='student') { selectStudentForHistory(e.id); }
else openHistory(e);
});
tb.querySelectorAll('.row-check').forEach(cb => cb.onchange = () => { cb.checked ? state.selectedIds.add(cb.dataset.id) : state.selectedIds.delete(cb.dataset.id); renderBulkBar(); });
}
function rowHtml(x) {
const ck = state.selectedIds.has(x.id) ? 'checked' : '';
const chips = x.subjects.map(s => `<span class="subj-chip ${subjClass(s.name)}" title="${esc(s.schedule||'')}">${esc(s.name)} · <b>${esc(s.level)}</b>${s.effStatus==='paused'?' ⏸':''}</span>`).join('');
const teachers = [...new Set(x.subjects.map(s => assignedTeacherNames(x.student,s.name)).filter(Boolean))].join(', ')||'-';
const msgs = x.monthRecords.filter(f => f.type==='message').length, calls = x.monthRecords.filter(f => f.type==='call').length;
const nm = esc(x.nameCn||x.namePinyin||'-');
const py = (x.nameCn && x.namePinyin) ? `<span class="sub">(${esc(x.namePinyin)})</span>` : '';
const nk = x.nickname ? `<span class="sub">“${esc(x.nickname)}”</span>` : '';
const mc = x.monthRecords.length ? `<b>${x.monthRecords.length}</b> <span class="sub">(${msgs}📩 ${calls}📞)</span>` : '<span class="sub">0</span>';
return `<tr class="fu-row st-${x.status}"> <td data-label="✓"><input type="checkbox" class="row-check" data-id="${x.id}" ${ck}></td> <td data-label="Student"><b>${nm}</b>${py}${nk}${centerTag(x.centerName)}<div class="sub">#${esc(x.student?.studentNumber||'-')}</div></td> <td data-label="Grade">${esc(x.grade||'-')}</td> <td data-label="School">${esc(x.school||'-')}</td> <td data-label="Subjects">${chips}</td> <td data-label="Teacher">${esc(teachers)}</td> <td data-label="Last Follow-Up">${lastContactBadge(x)}</td> <td data-label="This Month">${mc}</td> <td data-label="" class="actions-cell"> <button class="icon-btn" data-action="log" data-id="${x.id}" title="Log">📝</button> <button class="icon-btn" data-action="student" data-id="${x.id}" title="Per-student history">👤</button> <button class="icon-btn" data-action="history" data-id="${x.id}" title="History">🕓</button> </td></tr>`;
}
function lastContactBadge(x) {
if(!x.lastDate) return `<span class="fu-badge b-never">⛔ Never</span>`;
const d = fmtDate(x.lastDate);
if(x.status==='followed') return `<span class="fu-badge b-ok">✅ ${d}</span>`;
if(x.daysSince >= OVERDUE_SEVERE_DAYS) return `<span class="fu-badge b-bad">🚨 ${x.daysSince}d ago</span>`;
if(x.daysSince >= OVERDUE_WARNING_DAYS) return `<span class="fu-badge b-warn">⏳ ${x.daysSince}d ago</span>`;
return `<span class="fu-badge b-neutral">🕓 ${d}</span>`;
}
function subjClass(n) { return {'Math':'math','English ERP':'erp','English EFL':'efl','Chinese (Trad)':'chi','Chinese (Simp)':'chi'}[n]||''; }
function renderPagination(total, tp) {
const pi = $('pgInfo'); if(pi) pi.textContent = total===0 ? '0 students' : `${(state.currentPage-1)*ITEMS_PER_PAGE+1}–${Math.min(state.currentPage*ITEMS_PER_PAGE,total)} of ${total}`;
const pf = $('pgFirst'), pp = $('pgPrev'), pn = $('pgNext'), pl = $('pgLast');
if(pf) pf.disabled = state.currentPage===1; if(pp) pp.disabled = state.currentPage===1;
if(pn) pn.disabled = state.currentPage>=tp; if(pl) pl.disabled = state.currentPage>=tp;
const nums = $('pgNumbers'); if(!nums) return; nums.innerHTML = ''; let s = Math.max(1,state.currentPage-3), e = Math.min(tp,s+6); s = Math.max(1,e-6);
for(let i=s;i<=e;i++) { const b = document.createElement('button'); b.className = 'page-number'+(i===state.currentPage?' active':''); b.textContent = i; b.onclick = () => { state.currentPage = i; renderTracker(); }; nums.appendChild(b); }
}
function renderBulkBar() { const bar = $('bulkBar'); if(!bar) return; if(!state.selectedIds.size) { bar.classList.add('hidden'); return; } bar.classList.remove('hidden'); const bc = $('bulkCount'); if(bc) bc.textContent = `${state.selectedIds.size} selected`; }
function renderLogStudentDropdown() {
const input = $('logStudentSearch'), dd = $('logStudentDropdown'); if(!dd||!input) return;
const term = (input.value||'').trim().toLowerCase();
if(!state.dataLoaded) { dd.innerHTML = `<li class="dd-empty">${state.loadError?'❌ Load failed':'⏳ Loading students…'}</li>`; dd.classList.remove('hidden'); return; }
if(!state.allStudents.length) { dd.innerHTML = `<li class="dd-empty">⚠️ No students found.</li>`; dd.classList.remove('hidden'); return; }
const sel = new Set(state.logStudents.map(s => s.id));
const pool = state.allStudents.filter(s => !sel.has(s.id));
const matches = term ? pool.filter(s => searchHay(s).includes(term)).slice(0,PICKER_MAX_ROWS) : pool.slice(0,PICKER_MAX_ROWS);
if(matches.length) {
dd.innerHTML = `<li class="dd-empty">${term?`Pick a student:`:`Showing first ${matches.length}:`}</li>` +
matches.map(s => { const st = computeOverallStatus(s); const badge = st==='Current'?'b-ok':st==='Drop'?'b-never':'b-neutral';
return `<li data-id="${s.id}"><div class="dd-name">${esc(nameOf(s))} <span class="fu-badge ${badge}">${esc(st)}</span>${centerTag(s.centerName)}</div><div class="sub">${esc(s.namePinyin||'')} · Grade ${esc(s.grade||'-')} · #${esc(s.studentNumber||'-')}</div></li>`; }).join('');
} else {
dd.innerHTML = `<li class="dd-empty">No match for “${esc(term)}”.</li>`;
}
dd.classList.remove('hidden');
dd.querySelectorAll('li[data-id]').forEach(li => li.onclick = () => { const s = state.allStudents.find(x => x.id===li.dataset.id); if(s) addLogStudent(s); input.value = ''; dd.classList.add('hidden'); });
}
function addLogStudent(s) { if(state.logStudents.some(x => x.id===s.id)) return; state.logStudents.push(s); renderLogStudents(); }
function renderLogStudents() {
const wrap = $('selectedStudents'); const has = state.logStudents.length > 0;
const nm = $('noStudentMsg'); if(nm) nm.classList.toggle('hidden', has);
const fa = $('formArea'); if(fa) fa.classList.toggle('hidden', !has);
if(!wrap) return;
wrap.innerHTML = state.logStudents.map(s => `<div class="stu-chip"><span>${esc(nameOf(s))} <span class="sub">G${esc(s.grade||'-')}${s.centerName?' · '+esc(getCenterAbbr(s.centerName)):''}</span></span><button class="chip-x" data-id="${s.id}">×</button></div>`).join('');
wrap.querySelectorAll('.chip-x').forEach(b => b.onclick = () => { state.logStudents = state.logStudents.filter(s => s.id!==b.dataset.id); renderLogStudents(); });
renderSubjectChips();
}
function subjectsForLogging(s) {
let subs = getStudentMonthSubjects(s, state.viewYear, state.viewMonth).map(x => x.sub);
if(!subs.length) subs = getSubjectsArray(s.subjects).filter(x => ['current','pause','inquiry'].includes(String(x.status||'').toLowerCase()));
if(!subs.length) subs = getSubjectsArray(s.subjects).filter(x => x && x.name);
if(!subs.length) subs = [{name:'General',status:'current',currentLevel:'',startLevel:'',enrolDate:'',timeslots:[]}];
return subs;
}
function renderSubjectChips() {
const c = $('subjectChips'); if(!c) return; const counts = {};
state.logStudents.forEach(s => subjectsForLogging(s).forEach(sub => { counts[sub.name] = (counts[sub.name]||0)+1; }));
const prev = new Set([...c.querySelectorAll('input:checked')].map(i => i.value)); const names = Object.keys(counts);
c.innerHTML = names.length ? names.map(n => `<label class="chip-check"><input type="checkbox" value="${esc(n)}" ${prev.size===0||prev.has(n)?'checked':''}><span class="subj-chip ${subjClass(n)}">${esc(n)} (${counts[n]})</span></label>`).join('') : '<span class="hint-text">No subjects found.</span>';
}
function currentFuType() { const c = $('fuTypeCall'); return (c && c.checked) ? 'call' : 'message'; }
function toggleFuTypeFields() { const m = currentFuType()==='message'; const mf = $('messageFields'), cf = $('callFields'); if(mf) mf.classList.toggle('hidden', !m); if(cf) cf.classList.toggle('hidden', m); }
function applyTemplate() {
const ts = $('templateSelect'); if(!ts) return; const k = ts.value; if(!k||!TEMPLATES[k]) return;
const first = state.logStudents[0]; const sn = [...($('subjectChips')?.querySelectorAll('input:checked')||[])].map(i=>i.value)[0]||'the subject';
let lvl = '-'; if(first) { const sub = subjectsForLogging(first).find(s=>s.name===sn); if(sub) lvl = sub.currentLevel||sub.startLevel||'-'; }
const tu = $('teacherSelect')?.value||''; const teacher = tu ? (state.teachersMap[tu]||'') : (state.currentUser?.name||'');
const cn = first?.centerName||'';
const fill = str => str.split('{name}').join(first?nameOf(first):'').split('{subject}').join(sn).split('{level}').join(lvl).split('{teacher}').join(teacher).split('{center}').join(cn);
const en = $('msgEn'), zh = $('msgZh'); if(en) en.value = fill(TEMPLATES[k].en); if(zh) zh.value = fill(TEMPLATES[k].zh);
showToast('📄 Template applied');
}
async function saveFollowUp() {
if(!state.logStudents.length) return showToast('Select at least one student', true);
const cs = [...($('subjectChips')?.querySelectorAll('input:checked')||[])].map(i => i.value); if(!cs.length) return showToast('Select at least one subject', true);
const type = currentFuType();
let dateSent = '', month = '', sent = false;
if(type==='call') {
dateSent = $('callDate')?.value||'';
if(!dateSent) return showToast('Call date required', true);
month = dateSent.slice(0,7); sent = true;
} else {
if(!$('msgEn')?.value.trim() && !$('msgZh')?.value.trim()) return showToast('Enter the message', true);
sent = false; month = ''; dateSent = '';
}
const tu = $('teacherSelect')?.value||''; const tn = tu ? (state.teachersMap[tu]||'Unknown') : (state.currentUser?.name||'Unknown');
const now = new Date().toISOString(); const btn = $('saveFollowUpBtn');
if(btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
const formArea = $('formArea'); const formInputs = formArea ? [...formArea.querySelectorAll('input, select, textarea, button')] : [];
formInputs.forEach(el => el.disabled = true);
let count = 0;
try {
const jobs = [];
state.logStudents.forEach(student => {
const cid = student.centerId; const cname = student.centerName||'';
subjectsForLogging(student).forEach(sub => { if(!cs.includes(sub.name)) return;
jobs.push(push(ref(db, `centers/${cid}/followUps`), {
studentId: student.id, studentNumber: student.studentNumber||'', nameCn: student.nameCn||'', namePinyin: student.namePinyin||'',
nickname: student.nickname||'', grade: student.grade||'', school: student.school||'', centerId: cid, centerName: cname,
subject: sub.name, level: sub.currentLevel||sub.startLevel||'', startWS: sub.startWS ?? '', enrolDate: sub.enrolDate||'',
schedule: formatTimeslots(sub), assignedTeacher: assignedTeacherNames(student, sub.name), teacherUid: tu, teacherName: tn, type,
sent, messageType: type==='message' ? ($('messageTypeSelect')?.value||'') : '', messageEn: type==='message' ? ($('msgEn')?.value||'').trim() : '', messageZh: type==='message' ? ($('msgZh')?.value||'').trim() : '',
callNotes: type==='call' ? ($('callNotes')?.value||'').trim() : '', solution: type==='call' ? ($('solution')?.value||'').trim() : '',
dateCreated: type==='message' ? ($('dateCreated')?.value||'') : '', dateSent, month, createdBy: state.currentUser.uid, createdAt: now, updatedAt: now
})); count++;
});
});
if(!count) return showToast('No matching subjects', true);
const results = await Promise.allSettled(jobs);
const failed = results.filter(r => r.status==='rejected');
if(failed.length) showToast(`⚠️ ${failed.length} failed to save`, true);
else { showToast(type==='message' ? `✅ Saved ${count} as NOT SENT` : `✅ Saved ${count} records`); resetLogForm(false); }
} catch(err) { console.error(err); showToast('❌ '+err.message, true); }
finally {
formInputs.forEach(el => el.disabled = false);
if(btn) { btn.disabled = false; btn.textContent = '💾 Save Follow-Up'; }
}
}
function resetLogForm(clear=true) { if(clear) { state.logStudents = []; renderLogStudents(); } ['msgEn','msgZh','callNotes','solution'].forEach(id => { const el = $(id); if(el) el.value = ''; }); const ts = $('templateSelect'); if(ts) ts.value = ''; const t = todayISO(); ['dateCreated','callDate'].forEach(id => { const el = $(id); if(el) el.value = t; }); }
const logHay = f => [f.nameCn, f.namePinyin, f.nickname, f.studentNumber, f.school, f.teacherName, f.subject, f.level, f.messageType, f.messageEn, f.messageZh, f.callNotes, f.solution, f.centerName].filter(Boolean).join(' ').toLowerCase();
function renderRecentLogs() {
const tb = $('recentLogsBody'); if(!tb) return;
const key = ymKey(state.viewYear, state.viewMonth);
let all = centerFollowUps().filter(f => logMonth(f)===key).sort((a,b) => (b.dateCreated||b.dateSent||'').localeCompare(a.dateCreated||a.dateSent||'') || (b.createdAt||'').localeCompare(a.createdAt||''));
const monthTotal = all.length;
const term = (state.logSearch||'').trim().toLowerCase();
const subj = state.logSubject||'';
if(subj) all = all.filter(f => (f.subject||'')===subj);
if(term) all = all.filter(f => logHay(f).includes(term));
const isFiltered = !!(term || subj);
const ci = $('logsCountInfo');
if(ci) { ci.textContent = isFiltered ? `🔎 ${all.length} / ${monthTotal}` : `🗂️ ${monthTotal}`; }
const rows = all.slice(0, RECENT_LOGS_LIMIT);
if(!rows.length) { tb.innerHTML = `<tr><td colspan="12" class="hint-cell">No records found.</td></tr>`; return; }
tb.innerHTML = rows.map(f => {
let det; if(f.type==='message') { det = `<b>${esc(f.messageType||'')}</b>`; if(f.messageEn) det += `<br><span class="sub">EN: ${esc(truncate(f.messageEn))}</span>`; if(f.messageZh) det += `<br><span class="sub">中: ${esc(truncate(f.messageZh))}</span>`; }
else { det = esc(truncate(f.callNotes,80)); if(f.solution) det += `<br><span class="sub">✅ ${esc(truncate(f.solution,60))}</span>`; }
const badge = f.type==='message' ? `<span class="fu-badge b-msg">📩 Msg</span>` : `<span class="fu-badge b-call">📞 Call</span>`;
const dateLogged = f.dateCreated||f.dateSent||'';
const sentCell = f.type==='call' ? '<span class="sub">—</span>' : (isSent(f) ? `<span class="sent-wrap"><button class="sent-toggle yes" data-senttoggle="${f.id}" title="Mark NOT sent">Yes</button><button class="sent-dateview" data-sentedit="${f.id}">${fmtDate(f.dateSent)} 📅</button></span>` : `<button class="sent-toggle no" data-senttoggle="${f.id}" title="Mark sent">No</button>`);
return `<tr><td data-label="Type" class="nw">${badge}</td><td data-label="Date" class="nw">${fmtDate(dateLogged)}</td><td data-label="Sent" class="nw">${sentCell}</td><td data-label="Name"><b>${esc(f.nameCn||f.namePinyin||'-')}</b>${f.nickname?`<span class="sub">“${esc(f.nickname)}”</span>`:''}${centerTag(f.centerName)}</td><td data-label="Grade" class="nw">${esc(f.grade||'-')}</td><td data-label="School" class="school-cell">${esc(f.school||'-')}</td><td data-label="Teacher">${esc(f.teacherName||'-')}</td><td data-label="Subject" class="nw"><span class="subj-chip ${subjClass(f.subject)}">${esc(f.subject||'-')}</span> <span class="level-badge">${esc(f.level||'-')}</span></td><td data-label="Start" class="nw">${fmtDate(f.enrolDate)}</td><td data-label="Schedule"><span class="sub">${esc(f.schedule||'-')}</span></td><td data-label="Details" class="details-cell">${det}</td><td data-label="" class="actions-cell"><button class="icon-btn" data-edit="${f.id}">✏️</button><button class="icon-btn" data-del="${f.id}">🗑️</button></td></tr>`;
}).join('');
}
async function toggleSent(id) {
const f = state.followUps.find(x => x.id===id); if(!f) return;
const nowSent = !isSent(f);
const d = nowSent ? (f.dateSent||todayISO()) : '';
try { await update(ref(db, `centers/${f.centerId}/followUps/${id}`), { sent: nowSent, dateSent: d, month: d?d.slice(0,7):'', updatedAt: new Date().toISOString() }); showToast(nowSent ? `✅ Marked SENT` : '↩ Marked NOT sent'); }
catch(e) { console.error(e); showToast('❌ Update failed', true); }
}
async function saveSentDate(id, v) {
const f = state.followUps.find(x => x.id===id); if(!f||!v) return;
try { await update(ref(db, `centers/${f.centerId}/followUps/${id}`), { sent: true, dateSent: v, month: v.slice(0,7), updatedAt: new Date().toISOString() }); showToast(`✅ Sent date: ${fmtDate(v)}`); }
catch(e) { console.error(e); showToast('❌ Update failed', true); }
}
function enterSentEdit(id, btn) {
const f = state.followUps.find(x => x.id===id); if(!f) return;
const cell = btn.closest('td'); if(!cell) return;
cell.innerHTML = `<input type="date" class="sent-date" data-sentdate="${id}" value="${esc(f.dateSent||'')}">`;
const inp = cell.querySelector('input');
if(inp) { inp.focus(); try { if(inp.showPicker) inp.showPicker(); } catch(_){} }
}
async function deleteFollowUp(id) {
const rec = state.followUps.find(f => f.id===id); if(!rec) return;
showConfirm(`Delete this follow-up for ${rec.nameCn||rec.namePinyin||'student'}?`, async () => {
try { await remove(ref(db, `centers/${rec.centerId}/followUps/${id}`)); showToast('🗑️ Deleted'); $('editModal')?.classList.add('hidden'); $('historyModal')?.classList.add('hidden'); }
catch(e) { console.error(e); showToast('❌ Delete failed', true); }
});
}
// ---------------- 👤 PER-STUDENT HISTORY TAB ----------------
function timelineItemHtml(f, schoolName) {
const badge = f.type==='message' ? `<span class="fu-badge b-msg">📩</span>` : `<span class="fu-badge b-call">📞</span>`;
const sentInfo = f.type==='message' ? `<span class="fu-badge ${isSent(f)?'b-ok':'b-never'}">${isSent(f)?'Sent '+fmtDate(f.dateSent):'Not sent'}</span>` : '';
let body = '';
if(f.type==='message') {
if(f.messageEn) body += `<div class="tl-block"><b>EN:</b><br>${esc(f.messageEn).replace(/\n/g,'<br>')}</div>`;
if(f.messageZh) body += `<div class="tl-block"><b>中文:</b><br>${esc(f.messageZh).replace(/\n/g,'<br>')}</div>`;
} else {
body += `<div class="tl-block"><b>Notes:</b><br>${esc(f.callNotes||'').replace(/\n/g,'<br>')}</div>`;
if(f.solution) body += `<div class="tl-block"><b>Solution:</b><br>${esc(f.solution).replace(/\n/g,'<br>')}</div>`;
}
const copyBtn = (f.type==='message' && (f.messageEn||f.messageZh)) ? `<button class="icon-btn" data-copy="${f.id}" title="${t('pshCopy')}">📋</button>` : '';
return `<div class="tl-item"><div class="tl-head">${badge}${sentInfo}<span class="subj-chip ${subjClass(f.subject)}">${esc(f.subject||'')} · ${esc(f.level||'-')}</span>${f.messageType?`<span class="sub">${esc(f.messageType)}</span>`:''}<span class="tl-date">${fmtDate(f.dateCreated||f.dateSent)}</span><span class="tl-actions">${copyBtn}<button class="icon-btn" data-edit="${f.id}">✏️</button><button class="icon-btn" data-del="${f.id}">🗑️</button></span></div><div class="sub">Teacher: ${esc(f.teacherName||'-')} · School: ${esc(schoolName||'-')} · Started: ${fmtDate(f.enrolDate)} · Class: ${esc(f.schedule||'-')}</div>${body}</div>`;
}
function fuByStudentMap() {
if(state._fuByStudent) return state._fuByStudent;
const m = {};
state.followUps.forEach(f => { if(f.studentId) (m[f.studentId] = m[f.studentId] || []).push(f); });
Object.values(m).forEach(a => a.sort((x,y) => (y.dateSent||y.dateCreated||'').localeCompare(x.dateSent||x.dateCreated||'') || (y.createdAt||'').localeCompare(x.createdAt||'')));
state._fuByStudent = m; return m;
}
const historyFor = id => fuByStudentMap()[id] || [];
function selectStudentForHistory(id) { state.psh.selectedId = id; switchTab('studentHistory'); renderStudentHistory(); openStudentHistoryModal(id); }
function monthStripHtml(recs) {
const out = [], now = new Date();
for(let i=5;i>=0;i--) { const d = new Date(now.getFullYear(), now.getMonth()-i, 1); const k = ymKey(d.getFullYear(), d.getMonth()+1);
const hit = recs.some(f => effMonth(f)===k);
out.push(`<span class="m-dot ${hit?'on':''}" title="${monthLabel(d.getFullYear(), d.getMonth()+1)}">${d.toLocaleDateString('en-US',{month:'short'})}</span>`); }
return out.join('');
}
// ---------------- 🕓 STUDENT HISTORY MODAL (VERSION M) ----------------
function openStudentHistoryModal(id) {
state.shm.studentId = id; state.shm.expandedId = null;
state.psh.selectedId = id;
renderShm();
$('shmOverlay')?.classList.remove('hidden');
}
function closeStudentHistoryModal() { $('shmOverlay')?.classList.add('hidden'); }
function shmItemHtml(f, schoolName) {
const open = state.shm.expandedId === f.id;
const badge = f.type==='message' ? `<span class="fu-badge b-msg">📩 Msg</span>` : `<span class="fu-badge b-call">📞 Call</span>`;
const sentInfo = f.type==='message' ? `<span class="fu-badge ${isSent(f)?'b-ok':'b-never'}">${isSent(f)?'Sent '+fmtDate(f.dateSent):'Not sent'}</span>` : '';
const dotClass = f.type==='message' ? 'msg' : 'call';
let body = '';
if(f.type==='message') {
if(f.messageEn) body += `<div class="tl-block"><b>EN:</b><br>${esc(f.messageEn).replace(/\n/g,'<br>')}</div>`;
if(f.messageZh) body += `<div class="tl-block"><b>中文:</b><br>${esc(f.messageZh).replace(/\n/g,'<br>')}</div>`;
} else {
body += `<div class="tl-block"><b>Notes:</b><br>${esc(f.callNotes||'').replace(/\n/g,'<br>')}</div>`;
if(f.solution) body += `<div class="tl-block"><b>Solution:</b><br>${esc(f.solution).replace(/\n/g,'<br>')}</div>`;
}
const copyBtn = (f.type==='message' && (f.messageEn||f.messageZh)) ? `<button class="icon-btn" data-copy="${f.id}" title="${t('pshCopy')}">📋</button>` : '';
return `<div class="shm-item ${open?'open':''}" data-fuid="${f.id}">
<span class="shm-dot ${dotClass}"></span>
<div class="shm-card">
<button class="shm-head" data-toggle="${f.id}" type="button">
<span class="shm-date">${fmtDate(f.dateCreated||f.dateSent)}</span>
${badge}${sentInfo}
<span class="subj-chip ${subjClass(f.subject)}">${esc(f.subject||'')} · ${esc(f.level||'-')}</span>
${f.messageType?`<span class="sub">${esc(f.messageType)}</span>`:''}
<span class="shm-chev">▸</span>
</button>
<div class="shm-body">
<div class="sub shm-submeta">Teacher: ${esc(f.teacherName||'-')} · School: ${esc(schoolName||'-')} · Started: ${fmtDate(f.enrolDate)} · Class: ${esc(f.schedule||'-')}</div>
${body}
<div class="shm-actions">${copyBtn}<button class="icon-btn" data-edit="${f.id}">✏️ Edit</button><button class="icon-btn" data-del="${f.id}">🗑️ Delete</button></div>
</div>
</div>
</div>`;
}
function renderShm() {
const overlay = $('shmOverlay'); if(!overlay) return;
const s = state.allStudents.find(x => x.id === state.shm.studentId);
if(!s) { overlay.classList.add('hidden'); return; }
const title = $('shmTitle'); if(title) title.textContent = `🕓 ${nameOf(s)} — Follow-Up History`;
const meta = $('shmMeta');
if(meta) meta.innerHTML = `<span class="sub">#${esc(s.studentNumber||'-')}</span><span class="sub">·</span><span class="sub">${t('thGrade')} ${esc(s.grade||'-')}</span><span class="sub">·</span><span class="sub">${esc(s.school||'-')}</span>${centerTag(s.centerName)}<span class="sub">·</span><span class="sub">${esc(s.centerName||'')}</span><button class="primary" id="shmExportBtn" type="button">📤 ${esc(t('pshExport'))}</button>`;
const recs = historyFor(s.id);
const msgs = recs.filter(f=>f.type==='message').length, calls = recs.filter(f=>f.type==='call').length;
const sentN = recs.filter(f=>f.type==='message'&&isSent(f)).length;
let lastDate = ''; recs.forEach(f => { const d = f.dateSent||''; if(d > lastDate) lastDate = d; });
let daysSince = null;
if(lastDate) { const d = new Date(lastDate+'T00:00:00'); const now = new Date(); now.setHours(0,0,0,0); if(!isNaN(d.getTime())) daysSince = Math.round((now-d)/86400000); }
const tone = daysSince===null?'bc-bad':daysSince>=OVERDUE_SEVERE_DAYS?'bc-bad':daysSince>=OVERDUE_WARNING_DAYS?'bc-warn':'bc-good';
const stats = $('shmStats');
if(stats) stats.innerHTML = [sumCard(t('pshStatTotal'),recs.length,'',''),sumCard(t('pshStatMsgs'),msgs,`${sentN}/${msgs} ${t('thSent')}`,''),sumCard(t('pshStatCalls'),calls,'',''),sumCard(t('pshStatLast'), lastDate?fmtDate(lastDate):t('pshStatNever'), daysSince!==null?`${daysSince}d`:'', tone)].join('');
const months = $('shmMonths');
if(months) months.innerHTML = `<span class="sub">${t('pshMonths')}:</span> ${monthStripHtml(recs)}`;
const subs = getSubjectsArray(s.subjects);
const chips = subs.length ? `<div class="subject-chips" style="margin:0 0 .6rem">${subs.map(sub=>`<span class="subj-chip ${subjClass(sub.name)}">${esc(sub.name)} · <b>${esc(sub.currentLevel||sub.startLevel||'-')}</b></span>`).join('')}</div>` : '';
const tl = $('shmTimeline');
if(tl) tl.innerHTML = chips + (recs.length ? recs.map(f=>shmItemHtml(f, s.school)).join('') : `<p class="hint-cell">${t('pshNoRecords')}</p>`);
}
function pshRowHtml(r) {
const sel = r.s.id===state.psh.selectedId ? ' selected' : '';
const stB = r.status==='Current'?'b-ok':r.status==='Drop'?'b-never':'b-neutral';
const last =  !r.lastDate ? `<span class="fu-badge b-never">⛔ ${t('pshStatNever')}</span>`
: r.daysSince >=OVERDUE_SEVERE_DAYS ? `<span class="fu-badge b-bad">🚨 ${r.daysSince}d</span>`
: r.daysSince >=OVERDUE_WARNING_DAYS ? `<span class="fu-badge b-warn">⏳ ${r.daysSince}d</span>`
: `<span class="fu-badge b-ok">✅ ${fmtDate(r.lastDate)}</span>`;
return `<tr class="psh-row${sel}" data-sid="${r.s.id}"> <td data-label="${t('thStudent')}"><b>${esc(nameOf(r.s))}</b>${(r.s.nameCn&&r.s.namePinyin)?`<span class="sub">(${esc(r.s.namePinyin)})</span>`:''}${centerTag(r.s.centerName)}<div class="sub">#${esc(r.s.studentNumber||'-')}</div></td> <td data-label="${t('thGrade')}">${esc(r.s.grade||'-')}</td> <td data-label="${t('pshThStatus')}"><span class="fu-badge ${stB}">${esc(r.status)}</span></td> <td data-label="${t('pshThTotal')}">${r.total?`<b>${r.total}</b> <span class="sub">(${r.msgs}📩 ${r.calls}📞)</span>`:'<span class="sub">0</span>'}</td> <td data-label="${t('pshThLast')}">${last}</td></tr>`;
}
function renderStudentHistory() {
const listBody = $('pshListBody'); if(!listBody) return;
if(!state.dataLoaded) { listBody.innerHTML = `<tr><td colspan="5" class="hint-cell">${state.loadError?'❌ Load failed':t('pshLoading')}</td></tr>`; return; }
const term = (state.psh.search||'').trim().toLowerCase();
const note = $('pshScopeNote'); if(note) note.classList.toggle('hidden', !term);
let pool = term ? state.allStudents.filter(s => searchHay(s).includes(term)) : state.allStudents.filter(s => s.centerId === state.centerId);
if(state.psh.status) pool = pool.filter(s => computeOverallStatus(s)===state.psh.status);
const map = fuByStudentMap();
const rows = pool.map(s => {
const recs = map[s.id] || [];
let lastDate = ''; recs.forEach(f => { const d = f.dateSent||''; if(d > lastDate) lastDate = d; });
let daysSince = null;
if(lastDate) { const d = new Date(lastDate+'T00:00:00'); const now = new Date(); now.setHours(0,0,0,0); if(!isNaN(d.getTime())) daysSince = Math.round((now-d)/86400000); }
return { s, total: recs.length, msgs: recs.filter(f=>f.type==='message').length, calls: recs.filter(f=>f.type==='call').length, lastDate, daysSince, status: computeOverallStatus(s) };
});
let out = state.psh.onlyFu ? rows.filter(r => r.total > 0) : rows;
const byName = (a,b) => (a.s.namePinyin||a.s.nameCn||'').localeCompare(b.s.namePinyin||b.s.nameCn||'');
out.sort((a,b) => {
if(state.psh.sort==='name')  return byName(a,b);
if(state.psh.sort==='total') return b.total-a.total || byName(a,b);
if(state.psh.sort==='last'){ const av=a.daysSince===null?Infinity:a.daysSince, bv=b.daysSince===null?Infinity:b.daysSince; return bv-av || byName(a,b); }
const av=a.daysSince===null?Infinity:a.daysSince, bv=b.daysSince===null?Infinity:b.daysSince; // 'recent' (default)
return av-bv || byName(a,b);
});
const ci = $('pshCountInfo'); if(ci) ci.textContent = `${out.length}`;
listBody.innerHTML = out.slice(0,400).map(pshRowHtml).join('') || `<tr><td colspan="5" class="hint-cell"><div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">${t('pshEmptyList')}</div></div></td></tr>`;
}
function exportStudentHistory() {
if(!exportGuard()) return;
const id = state.shm.studentId || state.psh.selectedId; const recs = historyFor(id);
if(!recs.length) return showToast('No records for this student', true);
const s = state.allStudents.find(x=>x.id===id);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Kumon Student Follow-Up History'],['Name', nameOf(s)||''],['StudentNo', s?.studentNumber||''],['Centre', s?.centerName||''],[]]), 'Info');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logRows(recs)), 'History');
XLSX.writeFile(wb, `Kumon_Student_History_${String(s?.studentNumber||id).replace(/[^\w-]/g,'')}.xlsx`);
showToast('📤 Exported');
}
async function copyMessage(id) {
const f = state.followUps.find(x=>x.id===id); if(!f) return;
const parts = []; if(f.messageEn) parts.push(f.messageEn); if(f.messageZh) parts.push(f.messageZh);
const text = parts.join('\n\n');
try { await navigator.clipboard.writeText(text); showToast('📋 Copied'); }
catch(_) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
try { document.execCommand('copy'); showToast('📋 Copied'); } catch(e) { showToast('❌ Copy failed', true); } ta.remove(); }
}
function openHistory(entry) {
const ht = $('historyTitle'); if(ht) ht.textContent = `🕓 ${entry.nameCn||entry.namePinyin||'Student'} — History`;
const hb = $('historyBody'); if(!hb) return;
const recs = [...entry.records].sort((a,b) => (b.dateSent||b.dateCreated||'').localeCompare(a.dateSent||a.dateCreated||'') || (b.createdAt||'').localeCompare(a.createdAt||''));
const hm = $('historyModal'); if(hm) hm.dataset.studentId = entry.id;
hb.innerHTML = recs.length ? '<div class="timeline">' + recs.map(f => timelineItemHtml(f, entry.school)).join('') + '</div>' : '<p class="hint-cell">No follow-ups recorded yet.</p>';
hb.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEdit(b.dataset.edit));
hb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteFollowUp(b.dataset.del));
hb.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copyMessage(b.dataset.copy));
$('historyModal')?.classList.remove('hidden');
}
function syncSentSwitch() {
const stg = $('editSentToggle'), ds = $('editDateSent'), lbl = $('editSentLabel');
if(!stg) return;
const on = stg.checked;
if(ds) ds.disabled = !on;
if(on && ds && !ds.value) ds.value = todayISO();
if(lbl) lbl.textContent = on ? 'Sent' : 'Not sent';
}
function openEdit(id) {
const f = state.followUps.find(x => x.id===id); if(!f) return;
const set = (eid,val) => { const el = $(eid); if(el) el.value = val; };
set('editId', id);
const lbl = $('editStudentLabel'); if(lbl) lbl.textContent = `${f.nameCn||f.namePinyin||'-'} · ${f.subject||'-'} ${f.level||''} · ${fmtDate(f.dateCreated||f.dateSent)}`;
const etc = $('editTypeCall'), etm = $('editTypeMessage');
if(f.type==='call') { if(etc) etc.checked = true; } else { if(etm) etm.checked = true; }
toggleEditTypeFields();
set('editMessageType', f.messageType||'Progress Message'); set('editMsgEn', f.messageEn||''); set('editMsgZh', f.messageZh||'');
set('editCallNotes', f.callNotes||''); set('editSolution', f.solution||''); set('editDateCreated', f.dateCreated||'');
set('editDateSent', f.dateSent||''); set('editCallDate', f.dateSent||''); set('editTeacherSelect', f.teacherUid||'');
const stg = $('editSentToggle');
if(stg) { stg.checked = isSent(f); syncSentSwitch(); }
$('editModal')?.classList.remove('hidden');
}
function toggleEditTypeFields() { const etm = $('editTypeMessage'); const m = etm ? etm.checked : true; const emf = $('editMessageFields'), ecf = $('editCallFields'); if(emf) emf.classList.toggle('hidden', !m); if(ecf) ecf.classList.toggle('hidden', m); }
async function saveEdit() {
const id = $('editId')?.value; const f = state.followUps.find(x => x.id===id); const cid = f?.centerId; if(!cid) return showToast('Record has no center', true);
const etm = $('editTypeMessage'); const m = etm ? etm.checked : true;
let dateSent = '', month = '', sent = false;
if(m) {
if(!$('editMsgEn')?.value.trim() && !$('editMsgZh')?.value.trim()) return showToast('Enter the message', true);
sent = !!$('editSentToggle')?.checked;
if(sent) { dateSent = $('editDateSent')?.value||''; if(!dateSent) return showToast('Pick the sent date', true); month = dateSent.slice(0,7); }
} else {
if(!$('editCallNotes')?.value.trim()) return showToast('Call notes required', true);
dateSent = $('editCallDate')?.value||'';
if(!dateSent) return showToast('Date required', true);
month = dateSent.slice(0,7); sent = true;
}
const tu = $('editTeacherSelect')?.value||''; const tn = tu ? (state.teachersMap[tu]||'Unknown') : (state.currentUser?.name||'Unknown');
try {
await update(ref(db, `centers/${cid}/followUps/${id}`), {
type: m?'message':'call', sent, messageType: m?($('editMessageType')?.value||''):'', messageEn: m?($('editMsgEn')?.value||'').trim():'', messageZh: m?($('editMsgZh')?.value||'').trim():'',
callNotes: m?'':($('editCallNotes')?.value||'').trim(), solution: m?'':($('editSolution')?.value||'').trim(),
dateCreated: m?($('editDateCreated')?.value||''):'', dateSent, month, teacherUid: tu, teacherName: tn, updatedAt: new Date().toISOString()
});
showToast('✅ Saved'); $('editModal')?.classList.add('hidden'); $('historyModal')?.classList.add('hidden');
} catch(e) { console.error(e); showToast('❌ Save failed', true); }
}
const sumCard = (t,n,s,tone) => `<div class="balance-card ${tone}"><div class="bc-title">${t}</div><div class="bc-num">${n}</div>${s?`<div class="bc-sub">${s}</div>`:''}</div>`;
const barRow = (l,v,mx,c) => `<div class="bar-row"><span class="bar-label">${l}</span><div class="bar-track"><div class="bar-fill ${c}" style="width:${Math.round(v/mx*100)}%"></div></div><span class="bar-val">${v}</span></div>`;
function renderReport() {
const y = state.viewYear, m = state.viewMonth, key = ymKey(y,m); const roster = buildRoster(y,m);
const mf = centerFollowUps().filter(f => effMonth(f)===key);
const total = roster.length; const fids = new Set(mf.map(f => f.studentId)); const followed = roster.filter(r => fids.has(r.id)).length; const not = total-followed;
const msgs = mf.filter(f => f.type==='message').length, calls = mf.filter(f => f.type==='call').length; const pct = total ? Math.round(followed/total*100) : 0;
const sc = $('summaryCards'); if(sc) sc.innerHTML = [sumCard('Current Students',total,esc(state.centerName||'—'),''),sumCard('Followed Up',followed,pct+'% coverage','bc-good'),sumCard('Not Followed',not,'need attention',not?'bc-warn':'bc-good'),sumCard('Messages Sent',msgs,'',''),sumCard('Calls Made',calls,'',''),sumCard('Follow-Ups / Student',total?(mf.length/total).toFixed(2):'0','ratio','')].join('');
const bySubject = SUBJECTS.map(name => { const st = roster.filter(r => r.subjects.some(s => s.name===name)); const sf = mf.filter(f => f.subject===name); const fi = new Set(sf.map(f => f.studentId)); const fol = st.filter(r => fi.has(r.id)).length; return {name, students:st.length, followed:fol, notFollowed:st.length-fol, coverage:st.length?Math.round(fol/st.length*100):0, messages:sf.filter(f => f.type==='message').length, calls:sf.filter(f => f.type==='call').length}; }).filter(s => s.students >0||s.messages >0||s.calls >0);
const scb = $('subjectCoverageBody'); if(scb) scb.innerHTML = bySubject.length ? bySubject.map(s => { const tone = s.coverage >=70?'g':s.coverage >=40?'y':'r'; return `<tr><td data-label="Subject"><span class="subj-chip ${subjClass(s.name)}">${s.name}</span></td><td data-label="Students">${s.students}</td><td data-label="Followed">${s.followed}</td><td data-label="Not Followed">${s.notFollowed?`<span class="txt-bad">${s.notFollowed}</span>`:0}</td><td data-label="Coverage"><div class="cov-bar wide"><div class="cov-fill ${tone}" style="width:${s.coverage}%"></div></div> <span class="sub">${s.coverage}%</span></td><td data-label="Msgs">${s.messages}</td><td data-label="Calls">${s.calls}</td></tr>`; }).join('') : '<tr><td colspan="7" class="hint-cell">No data.</td></tr>';
const mx = Math.max(1, ...bySubject.flatMap(s => [s.students,s.messages,s.calls]));
const sca = $('subjectChartArea'); if(sca) sca.innerHTML = bySubject.length ? bySubject.map(s => `<div class="bar-group"><div class="bar-group-title">${esc(s.name)}</div>${barRow('Students',s.students,mx,'c-stu')}${barRow('Messages',s.messages,mx,'c-msg')}${barRow('Calls',s.calls,mx,'c-call')}</div>`).join('') : '<p class="hint-cell">No data.</p>';
const trendKey = `${state.centerId}|${key}`;
let trend = state.trendCache[trendKey];
if(!trend) {
trend = [];
for(let i=TREND_MONTHS-1;i>=0;i--) { const d = new Date(y,m-1-i,1); const ty = d.getFullYear(), tm = d.getMonth()+1, tk = ymKey(ty,tm); const tr = buildRoster(ty,tm); const tf = centerFollowUps().filter(f => effMonth(f)===tk); const fol = new Set(tf.map(f => f.studentId)).size; trend.push({label:d.toLocaleDateString('en-US',{month:'short'}), students:tr.length, fus:tf.length, coverage:tr.length?Math.round(fol/tr.length*100):0}); }
state.trendCache[trendKey] = trend;
}
const tmax = Math.max(1, ...trend.flatMap(t => [t.students,t.fus]));
const tc = $('trendChart'); if(tc) tc.innerHTML = trend.map(t => `<div class="trend-col"><div class="trend-bars"><div class="trend-bar tb-stu" style="height:${Math.round(t.students/tmax*100)}%"></div><div class="trend-bar tb-fu" style="height:${Math.round(t.fus/tmax*100)}%"></div></div><div class="trend-pct">${t.coverage}%</div><div class="trend-label">${t.label}</div></div>`).join('') + '<div class="trend-legend"><span><i class="lg lg-stu"></i>Students</span><span><i class="lg lg-fu"></i>Follow-ups</span></div>';
const bt = {}; mf.forEach(f => { const t = f.teacherName||'Unknown'; bt[t] ||= {messages:0,calls:0,students:new Set()}; if(f.type==='message') bt[t].messages++; else bt[t].calls++; bt[t].students.add(f.studentId); });
const tr = Object.entries(bt).sort((a,b) => (b[1].messages+b[1].calls)-(a[1].messages+a[1].calls));
const btb = $('byTeacherBody'); if(btb) btb.innerHTML = tr.length ? tr.map(([n,d]) => `<tr><td data-label="Teacher">${esc(n)}</td><td data-label="Msgs">${d.messages}</td><td data-label="Calls">${d.calls}</td><td data-label="Total"><b>${d.messages+d.calls}</b></td><td data-label="Students">${d.students.size}</td></tr>`).join('') : '<tr><td colspan="5" class="hint-cell">No data.</td></tr>';
const byType = {}; mf.filter(f => f.type==='message').forEach(f => { byType[f.messageType||'Other'] = (byType[f.messageType||'Other']||0)+1; });
const tyr = Object.entries(byType).sort((a,b) => b[1]-a[1]);
const bmt = $('byMsgTypeBody'); if(bmt) bmt.innerHTML = tyr.length ? tyr.map(([n,c]) => `<tr><td data-label="Type">${esc(n)}</td><td data-label="Count"><b>${c}</b></td><td data-label="Share">${msgs?Math.round(c/msgs*100):0}%</td></tr>`).join('') : '<tr><td colspan="3" class="hint-cell">No messages.</td></tr>';
}
function exportGuard() { if(typeof XLSX==='undefined') { showToast('❌ Excel library not loaded', true); return false; } return true; }
function logRows(fus) { return fus.map(f => ({
'Type': f.type==='message'?'Message':'Call', 'Date Logged': fmtDate(f.dateCreated||f.dateSent), 'Sent': f.type==='call'?'—':(isSent(f)?'Yes':'No'), 'Sent Date': (f.type==='message'&&isSent(f))?fmtDate(f.dateSent):'',
'Name (Chinese)': f.nameCn||'', 'Nickname': f.nickname||'', 'Pinyin': f.namePinyin||'', 'StudentNo': f.studentNumber||'', 'Centre': f.centerName||'', 'Grade': f.grade||'', 'School': f.school||'', 'Teacher': f.teacherName||'',
'Subject': f.subject||'', 'WS Level': f.level||'', 'Start Date': fmtDate(f.enrolDate), 'Schedule': f.schedule||'', 'Message Type': f.messageType||'', 'Message (EN)': f.messageEn||'', 'Message (中文)': f.messageZh||'', 'Call Notes': f.callNotes||'', 'Solution': f.solution||''
})); }
function exportMonthlyReport() { if(!exportGuard()) return; const y = state.viewYear, m = state.viewMonth, key = ymKey(y,m); const roster = buildRoster(y,m); const mf = centerFollowUps().filter(f => effMonth(f)===key); const wb = XLSX.utils.book_new(); const fids = new Set(mf.map(f => f.studentId)); const fol = roster.filter(r => fids.has(r.id)).length;
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Kumon Follow-Up Report',monthLabel(y,m)],['Center',state.centerName],[],['Current Students',roster.length],['Followed Up',fol],['Not Followed',roster.length-fol],['Coverage %',roster.length?Math.round(fol/roster.length*100):0],['Messages Sent',mf.filter(f => f.type==='message').length],['Calls Made',mf.filter(f => f.type==='call').length]]), 'Summary');
const sr = SUBJECTS.map(name => { const st = roster.filter(r => r.subjects.some(s => s.name===name)); const sf = mf.filter(f => f.subject===name); const fi = new Set(sf.map(f => f.studentId)); const fo = st.filter(r => fi.has(r.id)).length; return {'Subject':name,'Students':st.length,'Followed':fo,'Not Followed':st.length-fo,'Coverage %':st.length?Math.round(fo/st.length*100):0,'Messages':sf.filter(f => f.type==='message').length,'Calls':sf.filter(f => f.type==='call').length}; });
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sr), 'By Subject');
const stu = roster.map(r => ({'StudentNo':r.student?.studentNumber||'','Chinese Name':r.nameCn,'Pinyin':r.namePinyin,'Nickname':r.nickname,'Centre':r.centerName,'Grade':r.grade,'School':r.school,'Subjects': r.subjects.map(s => `${s.name} ${s.level}`).join(', '),'Followed This Month':r.monthRecords.length>0?'YES':'NO','Follow-Ups This Month':r.monthRecords.length,'Last Follow-Up':r.lastDate?fmtDate(r.lastDate):'NEVER','Days Since':r.daysSince??''}));
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stu), 'Students');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logRows(mf)), 'Follow-Up Log');
XLSX.writeFile(wb, `Kumon_${getCenterAbbr(state.centerName)||'All'}_FollowUp_Report_${key}.xlsx`); showToast('📤 Exported');
}
function exportNotFollowed() { if(!exportGuard()) return; const rows = buildRoster(state.viewYear,state.viewMonth).filter(r => r.monthRecords.length===0).map(r => ({'StudentNo':r.student?.studentNumber||'','Chinese Name':r.nameCn,'Pinyin':r.namePinyin,'Nickname':r.nickname,'Centre':r.centerName,'Grade':r.grade,'School':r.school,'Subjects': r.subjects.map(s => `${s.name} ${s.level}`).join(', '),'Phone (Mom)':maskPhone(r.student?.phone?.mom||''),'Phone (Dad)':maskPhone(r.student?.phone?.dad||''),'Last Follow-Up':r.lastDate?fmtDate(r.lastDate):'NEVER','Days Since':r.daysSince??''}));
if(!rows.length) return showToast('✅ Everyone followed up this month!'); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Not Followed'); XLSX.writeFile(wb, `Kumon_${getCenterAbbr(state.centerName)||'All'}_Not_Followed_${ymKey(state.viewYear,state.viewMonth)}.xlsx`); showToast('📤 Exported');
}
function exportMonthlyLog() { if(!exportGuard()) return; const key = ymKey(state.viewYear,state.viewMonth); const rows = logRows(centerFollowUps().filter(f => logMonth(f)===key)); if(!rows.length) return showToast('No records this month', true); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Follow-Up Log'); XLSX.writeFile(wb, `Kumon_${getCenterAbbr(state.centerName)||'All'}_FollowUp_Log_${key}.xlsx`); showToast('📤 Exported'); }
function switchTab(n) {
document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===n));
document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id===`tab-${n}`));
try { sessionStorage.setItem('fuLastTab', n); } catch(_) {}
if (n === 'studentHistory') renderStudentHistory();
}
function bindEvents() {
const set = (id, fn) => { const el = $(id); if(el) el.onclick = fn; };
const on = (id, evt, fn) => { const el = $(id); if(el) el.addEventListener(evt, fn); };
document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
set('monthPrev', () => changeMonth(-1));
set('monthNext', () => changeMonth(1));
set('monthToday', () => { const d = new Date(); state.viewYear = d.getFullYear(); state.viewMonth = d.getMonth()+1; state.selectedIds.clear(); renderAll(); });
set('backToDashboardBtn', () => window.location.href='dashboard.html');
const debouncedTracker = debounce(() => { state.currentPage = 1; renderTracker(); }, 250);
let comp = false; const si = $('searchInput');
if(si) {
si.addEventListener('compositionstart', () => comp = true);
si.addEventListener('compositionend', () => { comp = false; debouncedTracker(); });
si.addEventListener('input', () => { if(!comp) debouncedTracker(); });
}
['filterSubject','filterTeacher','filterGrade','filterStatus','sortBy'].forEach(id => on(id,'change', () => { state.currentPage = 1; renderTracker(); }));
set('clearFiltersBtn', () => { if(si) si.value = ''; ['filterSubject','filterTeacher','filterGrade','filterStatus'].forEach(id => { const el = $(id); if(el) el.value = ''; }); const sb = $('sortBy'); if(sb) sb.value = 'longest'; state.currentPage = 1; renderTracker(); showToast('Filters cleared'); });
set('pgFirst', () => { state.currentPage = 1; renderTracker(); });
set('pgPrev', () => { state.currentPage--; renderTracker(); });
set('pgNext', () => { state.currentPage++; renderTracker(); });
set('pgLast', () => { state.currentPage = Math.max(1, Math.ceil(state.filteredRoster.length/ITEMS_PER_PAGE)); renderTracker(); });
on('checkAll','change', e => { const s = (state.currentPage-1)*ITEMS_PER_PAGE; state.filteredRoster.slice(s, s+ITEMS_PER_PAGE).forEach(r => e.target.checked ? state.selectedIds.add(r.id) : state.selectedIds.delete(r.id)); renderTracker(); });
set('bulkClearBtn', () => { state.selectedIds.clear(); renderTracker(); });
set('bulkLogBtn', () => { state.filteredRoster.filter(r => state.selectedIds.has(r.id)).forEach(r => addLogStudent(r.student)); state.selectedIds.clear(); switchTab('log'); renderTracker(); showToast(`${state.logStudents.length} added`); });
const debouncedDropdown = debounce(renderLogStudentDropdown, 250);
let lc = false; const ls = $('logStudentSearch');
if(ls) {
ls.addEventListener('compositionstart', () => lc = true);
ls.addEventListener('compositionend', () => { lc = false; debouncedDropdown(); });
ls.addEventListener('input', () => { if(!lc) debouncedDropdown(); });
ls.addEventListener('blur', () => setTimeout(() => $('logStudentDropdown')?.classList.add('hidden'), 200));
ls.addEventListener('focus', renderLogStudentDropdown);
}
on('fuTypeMessage','change', toggleFuTypeFields);
on('fuTypeCall','change', toggleFuTypeFields);
on('templateSelect','change', applyTemplate);
set('saveFollowUpBtn', saveFollowUp);
set('clearFormBtn', () => resetLogForm(true));
on('editTypeMessage','change', toggleEditTypeFields);
on('editTypeCall','change', toggleEditTypeFields);
on('editSentToggle','change', syncSentSwitch);
set('saveEditBtn', saveEdit);
set('deleteEditBtn', () => deleteFollowUp($('editId')?.value));
set('cancelEditBtn', () => $('editModal')?.classList.add('hidden'));
set('closeEditBtn', () => $('editModal')?.classList.add('hidden'));
on('editModal','click', e => { if(e.target === $('editModal')) $('editModal')?.classList.add('hidden'); });
set('closeHistoryBtn', () => $('historyModal')?.classList.add('hidden'));
on('historyModal','click', e => { if(e.target === $('historyModal')) $('historyModal')?.classList.add('hidden'); });
set('confirmNoBtn', () => $('confirmModal')?.classList.add('hidden'));
set('exportReportBtn', exportMonthlyReport);
set('exportNotFollowedBtn', exportNotFollowed);
const logExportBtn = $('exportFullLogBtn') || $('exportMonthlyLogBtn');
if (logExportBtn) logExportBtn.onclick = exportMonthlyLog;
const ltb = $('recentLogsBody');
if (ltb) {
ltb.addEventListener('click', e => {
const b = e.target.closest('button'); if (!b) return;
if (b.dataset.edit) return openEdit(b.dataset.edit);
if (b.dataset.del) return deleteFollowUp(b.dataset.del);
if (b.dataset.senttoggle) return toggleSent(b.dataset.senttoggle);
if (b.dataset.sentedit) return enterSentEdit(b.dataset.sentedit, b);
});
ltb.addEventListener('change', e => {
const inp = e.target.closest('input[data-sentdate]'); if (!inp) return;
saveSentDate(inp.dataset.sentdate, inp.value);
});
ltb.addEventListener('focusout', e => {
const inp = e.target.closest('input[data-sentdate]'); if (!inp) return;
setTimeout(renderRecentLogs, 80);
});
}
const debouncedLogSearch = debounce(() => renderRecentLogs(), 250);
let logComp = false;
const lsi = $('logSearchInput');
if(lsi) {
lsi.addEventListener('compositionstart', () => logComp = true);
lsi.addEventListener('compositionend', () => { logComp = false; state.logSearch = lsi.value; debouncedLogSearch(); });
lsi.addEventListener('input', () => { if(!logComp) { state.logSearch = lsi.value; debouncedLogSearch(); } });
}
on('logFilterSubject','change', () => { state.logSubject = $('logFilterSubject')?.value||''; renderRecentLogs(); });
set('clearLogFiltersBtn', () => {
state.logSearch = ''; state.logSubject = '';
const i = $('logSearchInput'); if(i) i.value = '';
const s = $('logFilterSubject'); if(s) s.value = '';
renderRecentLogs(); showToast('Filters cleared');
});
// 👤 Per-student history tab
const debouncedPsh = debounce(() => renderStudentHistory(), 250);
let pshComp = false; const psi = $('pshSearch');
if(psi) {
psi.addEventListener('compositionstart', () => pshComp = true);
psi.addEventListener('compositionend', () => { pshComp = false; state.psh.search = psi.value; renderStudentHistory(); });
psi.addEventListener('input', () => { if(!pshComp) { state.psh.search = psi.value; debouncedPsh(); } });
}
on('pshStatus','change', () => { state.psh.status = $('pshStatus')?.value||''; renderStudentHistory(); });
on('pshSort','change', () => { state.psh.sort = $('pshSort')?.value||'recent'; renderStudentHistory(); });
on('pshOnlyWithFu','change', () => { state.psh.onlyFu = !!$('pshOnlyWithFu')?.checked; renderStudentHistory(); });
// boot-sync controls ↔ state (safe if HTML lacks the new controls)
const pshSortSel = $('pshSort');
if (pshSortSel) {
const has = [...pshSortSel.options].some(o => o.value === state.psh.sort);
if (has) pshSortSel.value = state.psh.sort; else state.psh.sort = pshSortSel.value || 'recent';
}
const pshStatusSel = $('pshStatus'); if (pshStatusSel) pshStatusSel.value = state.psh.status || '';
const pshOnly = $('pshOnlyWithFu'); if (pshOnly) pshOnly.checked = !!state.psh.onlyFu;
const plb = $('pshListBody');
if(plb) plb.addEventListener('click', e => { const tr = e.target.closest('tr[data-sid]'); if(!tr) return; openStudentHistoryModal(tr.dataset.sid); renderStudentHistory(); });
// 🕓 Student history modal (VERSION M) — one delegation for toggle/copy/edit/delete/export
set('shmCloseBtn', closeStudentHistoryModal);
on('shmOverlay','click', e => {
if (e.target === $('shmOverlay')) { closeStudentHistoryModal(); return; }
const b = e.target.closest('button'); if(!b) return;
if (b.dataset.toggle) { state.shm.expandedId = (state.shm.expandedId === b.dataset.toggle) ? null : b.dataset.toggle; renderShm(); return; }
if (b.dataset.copy) return copyMessage(b.dataset.copy);
if (b.dataset.edit) return openEdit(b.dataset.edit);
if (b.dataset.del) return deleteFollowUp(b.dataset.del);
if (b.id === 'shmExportBtn') return exportStudentHistory();
});
const hb2 = $('historyBody');
if(hb2) hb2.addEventListener('click', e => { const b = e.target.closest('button[data-copy]'); if(b) copyMessage(b.dataset.copy); });
set('historyOpenTabBtn', () => { const id = $('historyModal')?.dataset.studentId; if(!id) return; $('historyModal')?.classList.add('hidden'); selectStudentForHistory(id); });
const t = todayISO();
['dateCreated','callDate'].forEach(id => { const el = $(id); if(el) el.value = t; });
document.addEventListener('keydown', e => {
if(e.key==='Escape') {
const em = $('editModal'), hm = $('historyModal'), cm = $('confirmModal'), sm = $('shmOverlay');
if (em && !em.classList.contains('hidden')) em.classList.add('hidden');
else if (hm && !hm.classList.contains('hidden')) hm.classList.add('hidden');
else if (cm && !cm.classList.contains('hidden')) cm.classList.add('hidden');
else if (sm && !sm.classList.contains('hidden')) sm.classList.add('hidden');
$('logStudentDropdown')?.classList.add('hidden');
return;
}
const tag = document.activeElement?.tagName;
if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return;
if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f') { e.preventDefault(); switchTab('tracker'); $('searchInput')?.focus(); return; }
if(e.key==='ArrowLeft') changeMonth(-1);
else if(e.key==='ArrowRight') changeMonth(1);
});
}