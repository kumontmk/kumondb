// ============================================================
// 📣 STUDENT FOLLOW-UP REPORTS  (VERSION D — center-scoped reports, whole-DB picker)
//   • Picker (Log tab)  -> ALL students, ALL centers, ALL statuses   (never scoped)
//   • Stats/Tracker/Report/Logs/Exports -> the center you opened from (silent, no dropdown)
//   • ONE read of /centers builds everything; follow-ups saved under the STUDENT's center
// ============================================================
import { auth, db, syncPendingRequests } from './auth.js';
import { ref, get, push, update, remove, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const SUBJECTS = ['Math', 'English ERP', 'English EFL', 'Chinese (Trad)', 'Chinese (Simp)'];
const GRADE_ORDER = ['K0','K1','K2','K3','1','2','3','4','5','6','7','8','9','10','11','12','13'];
const ITEMS_PER_PAGE = 100;
const PICKER_MAX_ROWS = 50;
const ROSTER_STATUSES = ['Current'];   // reports = current only; add 'Inquiry' here if ever wanted

// Only consumed by getCenterAbbr below, so changing its shape is safe.
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
  if (rule) return rule.abbr;                       // explicit code wins, always
  const stripped = String(name).replace(/^kumon[\s.-]*/i, '').trim();
  return (stripped || String(name)).substring(0, 2).toUpperCase();  // unknown centers only
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

// ---------------- STATE ----------------
const state = {
  currentUser: null,
  centerId: '',          // 🆕 report scope (silent, no UI control)
  centerName: '',        // 🆕 display label for the scope
  centerNames: {},       // 🆕 cid -> name for EVERY center (even empty)
  allStudents: [],       // EVERY student in the DB  (picker + roster source)
  followUps: [],         // EVERY follow-up in the DB
  teachersMap: {}, teacherOptions: [],
  dataLoaded: false, loadError: '',
  viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth() + 1,
  currentPage: 1, filteredRoster: [], selectedIds: new Set(),
  logStudents: [], rosterCache: {}
};

const $ = id => document.getElementById(id);
const pad2 = n => String(n).padStart(2, '0');
const ymKey = (y, m) => `${y}-${pad2(m)}`;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; };
const monthLabel = (y, m) => new Date(y, m-1, 1).toLocaleDateString('en-US', { month:'long', year:'numeric' });
const isCurrentMonth = (y, m) => { const d = new Date(); return d.getFullYear()===y && d.getMonth()+1===m; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const truncate = (s, n=60) => { s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>n ? s.slice(0,n)+'…' : s; };
const nameOf = s => s.nameCn || s.namePinyin || s.nickname || s.name || s.englishName || '-';
const searchHay = s => [s.nameCn,s.namePinyin,s.nickname,s.studentNumber,s.school,s.nameEn,s.englishName,s.name,s.chineseName].filter(Boolean).join(' ').toLowerCase();
const centerTag = name => name ? ` <span class="fu-badge b-msg" title="${esc(name)}">🏫 ${esc(getCenterAbbr(name))}</span>` : '';

function showToast(msg, isError=false){ const t=$('toast'); if(!t)return; t.textContent=msg; t.className='toast'+(isError?' error':''); clearTimeout(t._timer); t._timer=setTimeout(()=>t.classList.add('hidden'),3500); }

// 🆕 follow-ups belonging to the report center only
function centerFollowUps(){ return state.followUps.filter(f => f.centerId === state.centerId); }

// 🆕 silent, validated center resolution — NEVER redirects, NEVER shows a dropdown.
//    Order: ?center= URL -> sessionStorage -> localStorage -> busiest center with students.
function resolveCenterId(){
  const keys = Object.keys(state.centerNames);
  const pick = raw => (raw && keys.includes(raw)) ? raw : null;
  const q = new URLSearchParams(location.search);
  let cid = pick((q.get('center')||q.get('centerId')||'').trim());
  if (!cid) cid = pick((sessionStorage.getItem('selectedCenter')||'').trim());
  if (!cid) cid = pick((localStorage.getItem('selectedCenter')||'').trim());
  if (!cid && keys.length){
    cid = keys
      .map(id => ({ id, n: state.allStudents.filter(s => s.centerId===id && ROSTER_STATUSES.includes(computeOverallStatus(s))).length }))
      .sort((a,b)=>b.n-a.n)[0].id;
  }
  state.centerId = cid || '';
  state.centerName = state.centerNames[cid] || '';
}

// ---------------- AUTH ----------------
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href='index.html'; return; }
  try {
    const s = await get(ref(db, `users/${user.uid}`));
    if (!s.exists()) { window.location.href='index.html'; return; }
    const u = s.val();
    state.currentUser = { uid:user.uid, email:user.email||'', name:u.englishName||u.chineseName||user.email };
    $('accessDenied')?.classList.add('hidden');
    $('mainContent')?.classList.remove('hidden');
    initializePage();
  } catch(e){ console.error(e); window.location.href='index.html'; }
});

// ---------------- INIT (ONE whole-DB listener) ----------------
function initializePage(){
  onValue(ref(db, 'centers'), snap => {
    const students = [], fus = [];
    state.centerNames = {};                                  // 🆕 rebuild each snapshot
    if (snap.exists()) snap.forEach(cc => {
      const cid = cc.key, val = cc.val() || {}, cname = val.name || val.centerName || cid;
      state.centerNames[cid] = cname;                        // 🆕 every center, even empty
      const st = val.students || {};
      Object.entries(st).forEach(([sid,v]) => students.push({ id:sid, centerId:cid, centerName:cname, ...(v||{}) }));
      const fu = val.followUps || {};
      Object.entries(fu).forEach(([fid,v]) => fus.push({ id:fid, centerId:cid, centerName:cname, ...(v||{}) }));
    });
    students.sort((a,b)=>(a.namePinyin||a.nameCn||'').localeCompare(b.namePinyin||b.nameCn||''));
    state.allStudents = students;
    state.followUps = fus;
    state.dataLoaded = true; state.loadError = ''; state.rosterCache = {};
    resolveCenterId();                                       // 🆕 scope reports to the opened center
    renderAll();
  }, err => { state.loadError = err.message; renderDataStatus(); });

  loadTeachers();
  bindEvents();

  const preId = new URLSearchParams(location.search).get('student');
  if (preId) {
    switchTab('log');
    const chk = setInterval(() => {
      const s = state.allStudents.find(x => x.id === preId);   // picker = whole DB
      if (s) { addLogStudent(s); clearInterval(chk); }
      else if (state.dataLoaded) clearInterval(chk);
    }, 300);
  }
  renderAll();
}

async function loadTeachers(){
  try {
    const emp = await get(ref(db,'employees'));
    if (emp.exists()) Object.entries(emp.val()).forEach(([uid,e])=>{
      if (e.isDisabled) return;
      const name = e.englishName||e.chineseName||'Unknown';
      state.teachersMap[uid]=name; state.teacherOptions.push({uid,name});
    });
    state.teacherOptions.sort((a,b)=>a.name.localeCompare(b.name));
  } catch(e){ console.warn(e); }
  fillTeacherSelect($('teacherSelect')); fillTeacherSelect($('editTeacherSelect'));
  const sel=$('filterTeacher');
  if (sel) sel.innerHTML='<option value="">All Teachers</option>'+state.teacherOptions.map(t=>`<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
  const me=state.teacherOptions.find(t=>t.uid===state.currentUser?.uid||t.name===state.currentUser?.name);
  if (me){ if($('teacherSelect'))$('teacherSelect').value=me.uid; if($('editTeacherSelect'))$('editTeacherSelect').value=me.uid; }
}
function fillTeacherSelect(sel){ if(!sel)return; sel.innerHTML=`<option value="">— ${esc(state.currentUser?.name||'Me')} —</option>`+state.teacherOptions.map(t=>`<option value="${esc(t.uid)}">${esc(t.name)}</option>`).join(''); }

// ---------------- STATUS CHIP (label only, no control) ----------------
function renderDataStatus(){
  const chip=$('dataStatus'); if(!chip)return; chip.onclick=null;
  chip.title = `Reports & stats cover: ${state.centerName||'—'} (the center you opened this page from). The Log-Follow-Up search still sees every student in every center.`;
  if (state.loadError){ chip.className='status-chip err'; chip.textContent='❌ Load failed — reload the page'; }
  else if (!state.dataLoaded){ chip.className='status-chip loading'; chip.textContent='⏳ Loading students…'; }
  else {
    const cur = state.allStudents.filter(s=>s.centerId===state.centerId && ROSTER_STATUSES.includes(computeOverallStatus(s))).length;
    chip.className='status-chip ok';
    chip.textContent=`🏫 ${state.centerName||'—'} · ${cur} current · search: ${state.allStudents.length} in DB`;
  }
}

// ---------------- ROSTER LOGIC ----------------
function getSubjectsArray(subjects){ if(!subjects)return[]; if(Array.isArray(subjects))return subjects; if(typeof subjects==='object')return Object.values(subjects); return []; }
function computeOverallStatus(student){
  const subjects=getSubjectsArray(student?.subjects);
  if(!subjects.length) return student?.overallStatus||'Drop';
  const st=subjects.map(s=>String(s?.status||'').toLowerCase());
  if(st.includes('current'))return'Current'; if(st.includes('inquiry'))return'Inquiry';
  if(st.every(x=>x==='drop'))return'Drop';
  if(st.includes('completer')&&st.every(x=>x==='drop'||x==='completer'))return'Completer';
  return'Pause';
}
function subjectStatusInMonth(sub,y,m){
  if(!sub||!sub.name)return null;
  const status=String(sub.status||'current').toLowerCase();
  if(isCurrentMonth(y,m)){ if(status==='current')return'current'; if(status==='pause')return'paused'; if(status==='inquiry')return'inquiry'; return null; }
  if(status==='inquiry'||status==='completer')return null;
  if(sub.enrolDate){ const d=new Date(sub.enrolDate+'T00:00:00'); if(!isNaN(d.getTime())&&(d.getFullYear()>y||(d.getFullYear()===y&&d.getMonth()+1>m)))return null; }
  const dropActive=(dm,dy)=>{ const MM=parseInt(dm),YY=parseInt(dy); if(!MM||!YY)return true; return YY>y||(YY===y&&MM>m); };
  if(status==='drop')return dropActive(sub.dropMonth,sub.dropYear)?'current':null;
  const pr=(sub.pendingRequest&&!sub.pendingRequest.cancelled)?sub.pendingRequest:null;
  if(pr&&pr.type==='drop'&&!dropActive(pr.dropMonth,pr.dropYear))return null;
  if(status==='pause'){ const pfY=parseInt(sub.pauseFromYear),pfM=parseInt(sub.pauseFromMonth),ptY=parseInt(sub.pauseToYear),ptM=parseInt(sub.pauseToMonth); const cur=y*12+m,from=(pfY&&pfM)?pfY*12+pfM:0,to=(ptY&&ptM)?ptY*12+ptM:Infinity; return(cur>=from&&cur<=to)?'paused':'current'; }
  return'current';
}
function formatTimeslots(sub){ let ts=sub?.timeslots; if(ts&&!Array.isArray(ts))ts=Object.values(ts); if(!Array.isArray(ts)||!ts.length)return''; return ts.filter(t=>t&&(t.day||t.time)).map(t=>`${String(t.day||'').slice(0,3)} ${t.time||''}`.trim()).join(', '); }
function assignedTeacherNames(student,subjectName){ const at=student?.assignedTeachers?.[subjectName]; if(!Array.isArray(at))return''; return at.map(uid=>state.teachersMap[uid]).filter(Boolean).join(', '); }
function fuMonth(f){ return f.month?String(f.month).slice(0,7):(f.dateSent||'').slice(0,7); }
function getStudentMonthSubjects(student,y,m){ return getSubjectsArray(student.subjects).map(sub=>({sub,eff:subjectStatusInMonth(sub,y,m)})).filter(x=>x.eff!==null); }

function buildRoster(y,m){
  const key=ymKey(y,m); if(state.rosterCache[key])return state.rosterCache[key];
  const fuBy={}; centerFollowUps().forEach(f=>{ if(f.studentId)(fuBy[f.studentId]||=[]).push(f); });   // 🆕 centered
  const roster=[];
  // 🆕 REPORTS/STATS = this center only.  (The picker below still uses state.allStudents = whole DB.)
  const scoped = state.allStudents.filter(s => s.centerId === state.centerId);
  scoped.forEach(student=>{
    const overall=computeOverallStatus(student);
    if(!ROSTER_STATUSES.includes(overall))return;            // current only
    let subs=getStudentMonthSubjects(student,y,m);
    if(!subs.length) subs=[{sub:{name:'General',currentLevel:'',startLevel:'',enrolDate:'',timeslots:[]},eff:'current'}];
    const records=fuBy[student.id]||[]; const monthRecords=records.filter(f=>fuMonth(f)===key);
    let lastDate=''; records.forEach(f=>{ const d=f.dateSent||''; if(d>lastDate)lastDate=d; });
    let daysSince=null; if(lastDate){ const d=new Date(lastDate+'T00:00:00'); const now=new Date(); now.setHours(0,0,0,0); if(!isNaN(d.getTime()))daysSince=Math.round((now-d)/86400000); }
    let status; if(monthRecords.length>0)status='followed'; else if(!lastDate)status='never'; else if(daysSince>=60)status='overdue60'; else if(daysSince>=30)status='overdue30'; else status='recent';
    roster.push({ student, id:student.id,
      nameCn:student.nameCn||student.chineseName||student.name||'', namePinyin:student.namePinyin||student.pinyin||'',
      nickname:student.nickname||'', grade:student.grade||'', school:student.school||'', centerName:student.centerName||'',
      subjects:subs.map(({sub,eff})=>({name:sub.name,level:sub.currentLevel||sub.startLevel||'-',effStatus:eff,enrolDate:sub.enrolDate||'',schedule:formatTimeslots(sub)})),
      records, monthRecords, lastDate, daysSince, status });
  });
  state.rosterCache[key]=roster; return roster;
}

// ---------------- RENDER ----------------
function renderAll(){ renderDataStatus(); renderMonthTitle(); renderStats(); renderTracker(); renderRecentLogs(); renderReport(); $('page-loader')?.classList.add('hidden'); }
function renderMonthTitle(){ const l=monthLabel(state.viewYear,state.viewMonth); $('monthTitle').textContent=l; $('recentMonthLabel').textContent=l; $('reportMonthLabel').textContent=l; }
function changeMonth(d){ let m=state.viewMonth+d,y=state.viewYear; if(m<1){m=12;y--;} if(m>12){m=1;y++;} state.viewMonth=m; state.viewYear=y; state.selectedIds.clear(); renderAll(); }
function renderStats(){
  const r=buildRoster(state.viewYear,state.viewMonth); const total=r.length;
  const followed=r.filter(x=>x.status==='followed').length, not=total-followed;
  const never=r.filter(x=>x.status==='never').length, od=r.filter(x=>x.status==='overdue60').length;
  const pct=total?Math.round(followed/total*100):0;
  $('statStrip').innerHTML=[
    `<div class="balance-card"><div class="bc-title">Current Students</div><div class="bc-num">${total}</div><div class="bc-sub">${esc(state.centerName||'—')}</div></div>`,   // 🆕 center label
    `<div class="balance-card bc-good clickable" data-status="followed"><div class="bc-title">Followed Up</div><div class="bc-num">${followed}</div><div class="bc-sub">this month</div></div>`,
    `<div class="balance-card bc-warn clickable" data-status="not"><div class="bc-title">Not Followed</div><div class="bc-num">${not}</div><div class="bc-sub">need attention</div></div>`,
    `<div class="balance-card bc-bad clickable" data-status="overdue60"><div class="bc-title">60+ Days</div><div class="bc-num">${od}</div><div class="bc-sub">no contact</div></div>`,
    `<div class="balance-card bc-bad clickable" data-status="never"><div class="bc-title">Never Contacted</div><div class="bc-num">${never}</div><div class="bc-sub">all time</div></div>`,
    `<div class="balance-card"><div class="bc-title">Coverage</div><div class="bc-num">${pct}%</div><div class="cov-bar"><div class="cov-fill" style="width:${pct}%"></div></div></div>`
  ].join('');
  $('statStrip').querySelectorAll('.clickable').forEach(el=>el.onclick=()=>{ $('filterStatus').value=el.dataset.status; switchTab('tracker'); state.currentPage=1; renderTracker(); });
}

function renderTracker(){
  const r=buildRoster(state.viewYear,state.viewMonth); let f=[...r];
  const term=($('searchInput')?.value||'').trim().toLowerCase();
  const fs=$('filterSubject')?.value||'', ft=$('filterTeacher')?.value||'', fg=$('filterGrade')?.value||'', fst=$('filterStatus')?.value||'';
  if(term)f=f.filter(x=>searchHay(x.student).includes(term));
  if(fs)f=f.filter(x=>x.subjects.some(s=>s.name===fs));
  if(fg)f=f.filter(x=>x.grade===fg);
  if(ft)f=f.filter(x=>x.subjects.some(s=>assignedTeacherNames(x.student,s.name).includes(ft)));
  if(fst)f=f.filter(x=>{ switch(fst){ case'followed':return x.status==='followed'; case'not':return x.status!=='followed'; case'overdue30':return x.daysSince!==null&&x.daysSince>=30; case'overdue60':return x.daysSince!==null&&x.daysSince>=60; case'never':return x.status==='never'; default:return true; } });
  const sk=$('sortBy')?.value||'longest'; const gi=g=>{const i=GRADE_ORDER.indexOf(String(g));return i===-1?99:i;};
  f.sort((a,b)=>{ switch(sk){ case'name':return(a.namePinyin||a.nameCn).localeCompare(b.namePinyin||b.nameCn); case'grade':return gi(a.grade)-gi(b.grade); case'monthCount':return b.monthRecords.length-a.monthRecords.length; default:{const av=a.daysSince===null?Infinity:a.daysSince,bv=b.daysSince===null?Infinity:b.daysSince;return bv-av;} } });
  state.filteredRoster=f;
  const tp=Math.max(1,Math.ceil(f.length/ITEMS_PER_PAGE)); if(state.currentPage>tp)state.currentPage=tp;
  const start=(state.currentPage-1)*ITEMS_PER_PAGE, page=f.slice(start,start+ITEMS_PER_PAGE);
  const tb=$('trackerBody');
  tb.innerHTML=page.length?page.map(rowHtml).join(''):`<tr><td colspan="9" class="hint-cell">${state.dataLoaded?`No CURRENT students in ${esc(state.centerName||'this center')} match the filters.`:'⏳ Loading…'}</td></tr>`;
  renderPagination(f.length,tp); renderBulkBar();
  tb.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{ const e=state.filteredRoster.find(x=>x.id===b.dataset.id)||buildRoster(state.viewYear,state.viewMonth).find(x=>x.id===b.dataset.id); if(!e)return; if(b.dataset.action==='log'){switchTab('log');addLogStudent(e.student);} else openHistory(e); });
  tb.querySelectorAll('.row-check').forEach(cb=>cb.onchange=()=>{ cb.checked?state.selectedIds.add(cb.dataset.id):state.selectedIds.delete(cb.dataset.id); renderBulkBar(); });
}
function rowHtml(x){
  const ck=state.selectedIds.has(x.id)?'checked':'';
  const chips=x.subjects.map(s=>`<span class="subj-chip ${subjClass(s.name)}" title="${esc(s.schedule||'')}">${esc(s.name)} · <b>${esc(s.level)}</b>${s.effStatus==='paused'?' ⏸':''}</span>`).join('');
  const teachers=[...new Set(x.subjects.map(s=>assignedTeacherNames(x.student,s.name)).filter(Boolean))].join(', ')||'-';
  const msgs=x.monthRecords.filter(f=>f.type==='message').length, calls=x.monthRecords.filter(f=>f.type==='call').length;
  const nm=esc(x.nameCn||x.namePinyin||'-');
  const py=(x.nameCn&&x.namePinyin)?`<span class="sub">(${esc(x.namePinyin)})</span>`:'';
  const nk=x.nickname?`<span class="sub">“${esc(x.nickname)}”</span>`:'';
  const mc=x.monthRecords.length?`<b>${x.monthRecords.length}</b> <span class="sub">(${msgs}📩 ${calls}📞)</span>`:'<span class="sub">0</span>';
  return `<tr class="fu-row st-${x.status}">
    <td data-label="✓"><input type="checkbox" class="row-check" data-id="${x.id}" ${ck}></td>
    <td data-label="Student"><b>${nm}</b>${py}${nk}${centerTag(x.centerName)}<div class="sub">#${esc(x.student?.studentNumber||'-')}</div></td>
    <td data-label="Grade">${esc(x.grade||'-')}</td><td data-label="School">${esc(x.school||'-')}</td>
    <td data-label="Subjects">${chips}</td><td data-label="Teacher">${esc(teachers)}</td>
    <td data-label="Last Follow-Up">${lastContactBadge(x)}</td><td data-label="This Month">${mc}</td>
    <td data-label="" class="actions-cell"><button class="icon-btn" data-action="log" data-id="${x.id}" title="Log">📝</button><button class="icon-btn" data-action="history" data-id="${x.id}" title="History">🕓</button></td>
  </tr>`;
}
function lastContactBadge(x){ if(!x.lastDate)return`<span class="fu-badge b-never">⛔ Never</span>`; const d=new Date(x.lastDate+'T00:00:00').toLocaleDateString('en-CA'); if(x.status==='followed')return`<span class="fu-badge b-ok">✅ ${d}</span>`; if(x.daysSince>=60)return`<span class="fu-badge b-bad">🚨 ${x.daysSince}d ago</span>`; if(x.daysSince>=30)return`<span class="fu-badge b-warn">⏳ ${x.daysSince}d ago</span>`; return`<span class="fu-badge b-neutral">🕓 ${d}</span>`; }
function subjClass(n){ return {'Math':'math','English ERP':'erp','English EFL':'efl','Chinese (Trad)':'chi','Chinese (Simp)':'chi'}[n]||''; }
function renderPagination(total,tp){
  $('pgInfo').textContent=total===0?'0 students':`${(state.currentPage-1)*ITEMS_PER_PAGE+1}–${Math.min(state.currentPage*ITEMS_PER_PAGE,total)} of ${total}`;
  $('pgFirst').disabled=$('pgPrev').disabled=state.currentPage===1; $('pgNext').disabled=$('pgLast').disabled=state.currentPage>=tp;
  const nums=$('pgNumbers'); nums.innerHTML=''; let s=Math.max(1,state.currentPage-3),e=Math.min(tp,s+6); s=Math.max(1,e-6);
  for(let i=s;i<=e;i++){ const b=document.createElement('button'); b.className='page-number'+(i===state.currentPage?' active':''); b.textContent=i; b.onclick=()=>{state.currentPage=i;renderTracker();}; nums.appendChild(b); }
}
function renderBulkBar(){ const bar=$('bulkBar'); if(!state.selectedIds.size){bar.classList.add('hidden');return;} bar.classList.remove('hidden'); $('bulkCount').textContent=`${state.selectedIds.size} selected`; }

// ---------------- LOG TAB (picker = WHOLE DB, never scoped) ----------------
function renderLogStudentDropdown(){
  const input=$('logStudentSearch'), dd=$('logStudentDropdown'); if(!dd)return;
  const term=(input.value||'').trim().toLowerCase();
  if(!state.dataLoaded){ dd.innerHTML=`<li class="dd-empty">${state.loadError?'❌ Load failed — reload':'⏳ Loading students…'}</li>`; dd.classList.remove('hidden'); return; }
  if(!state.allStudents.length){ dd.innerHTML=`<li class="dd-empty">⚠️ No students found in the database.</li>`; dd.classList.remove('hidden'); return; }
  const sel=new Set(state.logStudents.map(s=>s.id));
  const pool=state.allStudents.filter(s=>!sel.has(s.id));                 // ALL centers, ALL statuses
  const matches=term?pool.filter(s=>searchHay(s).includes(term)).slice(0,PICKER_MAX_ROWS):pool.slice(0,PICKER_MAX_ROWS);
  if(matches.length){
    dd.innerHTML=`<li class="dd-empty">${term?`Pick a student (${matches.length} match${matches.length>1?'es':''}):`:`Showing first ${matches.length} of ${pool.length} students (all centers):`}</li>`+
      matches.map(s=>{ const st=computeOverallStatus(s); const badge=st==='Current'?'b-ok':st==='Drop'?'b-never':'b-neutral';
        return `<li data-id="${s.id}"><div class="dd-name">${esc(nameOf(s))} <span class="fu-badge ${badge}">${esc(st)}</span>${centerTag(s.centerName)}</div><div class="sub">${esc(s.namePinyin||'')} · Grade ${esc(s.grade||'-')} · #${esc(s.studentNumber||'-')}</div></li>`; }).join('');
  } else {
    dd.innerHTML=`<li class="dd-empty">No match for “${esc(term)}” among ${pool.length} students.<br><span class="sub">Try Chinese name, pinyin, nickname or student number.</span></li>`;
  }
  dd.classList.remove('hidden');
  dd.querySelectorAll('li[data-id]').forEach(li=>li.onclick=()=>{ const s=state.allStudents.find(x=>x.id===li.dataset.id); if(s)addLogStudent(s); input.value=''; dd.classList.add('hidden'); });
}
function addLogStudent(s){ if(state.logStudents.some(x=>x.id===s.id))return; state.logStudents.push(s); renderLogStudents(); }
function renderLogStudents(){
  const wrap=$('selectedStudents'); const has=state.logStudents.length>0;
  $('noStudentMsg').classList.toggle('hidden',has); $('formArea').classList.toggle('hidden',!has);
  wrap.innerHTML=state.logStudents.map(s=>`<div class="stu-chip"><span>${esc(nameOf(s))} <span class="sub">G${esc(s.grade||'-')}${s.centerName?' · '+esc(getCenterAbbr(s.centerName)):''}</span></span><button class="chip-x" data-id="${s.id}">×</button></div>`).join('');
  wrap.querySelectorAll('.chip-x').forEach(b=>b.onclick=()=>{ state.logStudents=state.logStudents.filter(s=>s.id!==b.dataset.id); renderLogStudents(); });
  renderSubjectChips();
}
function subjectsForLogging(s){
  let subs=getStudentMonthSubjects(s,state.viewYear,state.viewMonth).map(x=>x.sub);
  if(!subs.length)subs=getSubjectsArray(s.subjects).filter(x=>['current','pause','inquiry'].includes(String(x.status||'').toLowerCase()));
  if(!subs.length)subs=getSubjectsArray(s.subjects).filter(x=>x&&x.name);
  if(!subs.length)subs=[{name:'General',status:'current',currentLevel:'',startLevel:'',enrolDate:'',timeslots:[]}];
  return subs;
}
function renderSubjectChips(){
  const c=$('subjectChips'); const counts={};
  state.logStudents.forEach(s=>subjectsForLogging(s).forEach(sub=>{counts[sub.name]=(counts[sub.name]||0)+1;}));
  const prev=new Set([...c.querySelectorAll('input:checked')].map(i=>i.value)); const names=Object.keys(counts);
  c.innerHTML=names.length?names.map(n=>`<label class="chip-check"><input type="checkbox" value="${esc(n)}" ${prev.size===0||prev.has(n)?'checked':''}><span class="subj-chip ${subjClass(n)}">${esc(n)} (${counts[n]})</span></label>`).join(''):'<span class="hint-text">No subjects found.</span>';
}
function currentFuType(){ return $('fuTypeCall').checked?'call':'message'; }
function toggleFuTypeFields(){ const m=currentFuType()==='message'; $('messageFields').classList.toggle('hidden',!m); $('callFields').classList.toggle('hidden',m); }
function applyTemplate(){
  const k=$('templateSelect').value; if(!k||!TEMPLATES[k])return;
  const first=state.logStudents[0]; const sn=[...$('subjectChips').querySelectorAll('input:checked')].map(i=>i.value)[0]||'the subject';
  let lvl='-'; if(first){ const sub=subjectsForLogging(first).find(s=>s.name===sn); if(sub)lvl=sub.currentLevel||sub.startLevel||'-'; }
  const tu=$('teacherSelect').value; const teacher=tu?(state.teachersMap[tu]||''):(state.currentUser?.name||'');
  const cn=first?.centerName||'';   // template uses the STUDENT's center, not the report scope
  const fill=str=>str.replaceAll('{name}',first?nameOf(first):'').replaceAll('{subject}',sn).replaceAll('{level}',lvl).replaceAll('{teacher}',teacher).replaceAll('{center}',cn);
  $('msgEn').value=fill(TEMPLATES[k].en); $('msgZh').value=fill(TEMPLATES[k].zh); showToast('📄 Template applied');
}
async function saveFollowUp(){
  if(!state.logStudents.length)return showToast('Select at least one student',true);
  const cs=[...$('subjectChips').querySelectorAll('input:checked')].map(i=>i.value); if(!cs.length)return showToast('Select at least one subject',true);
  const type=currentFuType(); const dateSent=type==='message'?$('dateSent').value:$('callDate').value; if(!dateSent)return showToast('Date required',true);
  if(type==='message'&&!$('msgEn').value.trim()&&!$('msgZh').value.trim())return showToast('Enter the message',true);
  if(type==='call'&&!$('callNotes').value.trim())return showToast('Call notes required',true);
  const tu=$('teacherSelect').value; const tn=tu?(state.teachersMap[tu]||'Unknown'):(state.currentUser?.name||'Unknown');
  const now=new Date().toISOString(); const btn=$('saveFollowUpBtn'); btn.disabled=true; btn.textContent='Saving...';
  let count=0;
  try{
    const jobs=[];
    state.logStudents.forEach(student=>{
      const cid=student.centerId; const cname=student.centerName||'';   // save under the STUDENT's center
      subjectsForLogging(student).forEach(sub=>{ if(!cs.includes(sub.name))return;
        jobs.push(push(ref(db,`centers/${cid}/followUps`),{
          studentId:student.id, studentNumber:student.studentNumber||'', nameCn:student.nameCn||'', namePinyin:student.namePinyin||'',
          nickname:student.nickname||'', grade:student.grade||'', school:student.school||'', centerId:cid, centerName:cname,
          subject:sub.name, level:sub.currentLevel||sub.startLevel||'', startWS:sub.startWS??'', enrolDate:sub.enrolDate||'',
          schedule:formatTimeslots(sub), assignedTeacher:assignedTeacherNames(student,sub.name), teacherUid:tu, teacherName:tn, type,
          messageType:type==='message'?$('messageTypeSelect').value:'', messageEn:type==='message'?$('msgEn').value.trim():'', messageZh:type==='message'?$('msgZh').value.trim():'',
          callNotes:type==='call'?$('callNotes').value.trim():'', solution:type==='call'?$('solution').value.trim():'',
          dateCreated:type==='message'?($('dateCreated').value||''):'', dateSent, month:dateSent.slice(0,7), createdBy:state.currentUser.uid, createdAt:now, updatedAt:now
        })); count++;
      });
    });
    if(!count)return showToast('No matching subjects',true);
    await Promise.all(jobs);
    showToast(`✅ Saved ${count} record${count>1?'s':''}`); resetLogForm(false);
  }catch(err){ console.error(err); showToast('❌ '+err.message,true); }
  finally{ btn.disabled=false; btn.textContent='💾 Save Follow-Up'; }
}
function resetLogForm(clear=true){ if(clear){state.logStudents=[];renderLogStudents();} $('msgEn').value='';$('msgZh').value='';$('callNotes').value='';$('solution').value='';$('templateSelect').value=''; const t=todayISO(); $('dateCreated').value=t;$('dateSent').value=t;$('callDate').value=t; }

function renderRecentLogs(){
  const key=ymKey(state.viewYear,state.viewMonth);
  const rows=centerFollowUps().filter(f=>fuMonth(f)===key).sort((a,b)=>(b.dateSent||'').localeCompare(a.dateSent||'')||(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,500);   // 🆕 centered
  const tb=$('recentLogsBody');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="7" class="hint-cell">No follow-ups logged for ${esc(state.centerName||'this center')} in ${monthLabel(state.viewYear,state.viewMonth)} yet.</td></tr>`; return; }
  tb.innerHTML=rows.map(f=>{
    let det; if(f.type==='message'){ det=`<b>${esc(f.messageType||'')}</b>`; if(f.messageEn)det+=`<br><span class="sub">EN: ${esc(truncate(f.messageEn))}</span>`; if(f.messageZh)det+=`<br><span class="sub">中: ${esc(truncate(f.messageZh))}</span>`; }
    else { det=esc(truncate(f.callNotes,80)); if(f.solution)det+=`<br><span class="sub">✅ ${esc(truncate(f.solution,60))}</span>`; }
    const badge=f.type==='message'?`<span class="fu-badge b-msg">📩 Msg</span>`:`<span class="fu-badge b-call">📞 Call</span>`;
    return `<tr><td data-label="Date">${esc(f.dateSent||'-')}</td>
      <td data-label="Student"><b>${esc(f.nameCn||f.namePinyin||'-')}</b> <span class="sub">G${esc(f.grade||'-')}</span>${centerTag(f.centerName)}</td>
      <td data-label="Subject"><span class="subj-chip ${subjClass(f.subject)}">${esc(f.subject||'-')}</span> <span class="level-badge">${esc(f.level||'-')}</span></td>
      <td data-label="Type">${badge}</td><td data-label="Details">${det}</td><td data-label="Teacher">${esc(f.teacherName||'-')}</td>
      <td data-label="" class="actions-cell"><button class="icon-btn" data-edit="${f.id}" title="Edit">✏️</button><button class="icon-btn" data-del="${f.id}" title="Delete">🗑️</button></td></tr>`;
  }).join('');
  tb.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEdit(b.dataset.edit));
  tb.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>deleteFollowUp(b.dataset.del));
}
async function deleteFollowUp(id){
  const rec=state.followUps.find(f=>f.id===id); if(!rec)return;
  if(!confirm(`Delete this follow-up for ${rec.nameCn||rec.namePinyin||'student'} (${rec.dateSent})?`))return;
  try{ await remove(ref(db,`centers/${rec.centerId}/followUps/${id}`)); showToast('🗑️ Deleted'); $('editModal')?.classList.add('hidden'); $('historyModal')?.classList.add('hidden'); }
  catch(e){ console.error(e); showToast('❌ Delete failed',true); }
}

function openHistory(entry){
  $('historyTitle').textContent=`🕓 ${entry.nameCn||entry.namePinyin||'Student'} — History`;
  const recs=[...entry.records].sort((a,b)=>(b.dateSent||'').localeCompare(a.dateSent||'')||(b.createdAt||'').localeCompare(a.createdAt||''));
  $('historyBody').innerHTML=recs.length?'<div class="timeline">'+recs.map(f=>{
    const badge=f.type==='message'?`<span class="fu-badge b-msg">📩</span>`:`<span class="fu-badge b-call">📞</span>`;
    let body=''; if(f.type==='message'){ if(f.messageEn)body+=`<div class="tl-block"><b>EN:</b><br>${esc(f.messageEn).replace(/\n/g,'<br>')}</div>`; if(f.messageZh)body+=`<div class="tl-block"><b>中文:</b><br>${esc(f.messageZh).replace(/\n/g,'<br>')}</div>`; }
    else { body+=`<div class="tl-block"><b>Notes:</b><br>${esc(f.callNotes||'').replace(/\n/g,'<br>')}</div>`; if(f.solution)body+=`<div class="tl-block"><b>Solution:</b><br>${esc(f.solution||'').replace(/\n/g,'<br>')}</div>`; }
    return `<div class="tl-item"><div class="tl-head">${badge}<span class="subj-chip ${subjClass(f.subject)}">${esc(f.subject||'')} · ${esc(f.level||'-')}</span>${f.messageType?`<span class="sub">${esc(f.messageType)}</span>`:''}<span class="tl-date">${esc(f.dateSent||'-')}</span><span class="tl-actions"><button class="icon-btn" data-edit="${f.id}">✏️</button><button class="icon-btn" data-del="${f.id}">🗑️</button></span></div><div class="sub">Teacher: ${esc(f.teacherName||'-')} · School: ${esc(entry.school||'-')} · Started: ${esc(f.enrolDate||'-')} · Class: ${esc(f.schedule||'-')}</div>${body}</div>`;
  }).join('')+'</div>':'<p class="hint-cell">No follow-ups recorded yet.</p>';
  $('historyBody').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEdit(b.dataset.edit));
  $('historyBody').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>deleteFollowUp(b.dataset.del));
  $('historyModal').classList.remove('hidden');
}
function openEdit(id){
  const f=state.followUps.find(x=>x.id===id); if(!f)return;
  $('editId').value=id; $('editStudentLabel').textContent=`${f.nameCn||f.namePinyin||'-'} · ${f.subject||'-'} ${f.level||''} · ${f.dateSent||''}`;
  if(f.type==='call')$('editTypeCall').checked=true; else $('editTypeMessage').checked=true; toggleEditTypeFields();
  $('editMessageType').value=f.messageType||'Progress Message'; $('editMsgEn').value=f.messageEn||''; $('editMsgZh').value=f.messageZh||'';
  $('editCallNotes').value=f.callNotes||''; $('editSolution').value=f.solution||''; $('editDateCreated').value=f.dateCreated||'';
  $('editDateSent').value=f.dateSent||''; $('editCallDate').value=f.dateSent||''; $('editTeacherSelect').value=f.teacherUid||'';
  $('editModal').classList.remove('hidden');
}
function toggleEditTypeFields(){ const m=$('editTypeMessage').checked; $('editMessageFields').classList.toggle('hidden',!m); $('editCallFields').classList.toggle('hidden',m); }
async function saveEdit(){
  const id=$('editId').value; const f=state.followUps.find(x=>x.id===id); const cid=f?.centerId; if(!cid)return showToast('Record has no center',true);
  const m=$('editTypeMessage').checked; const dateSent=m?$('editDateSent').value:$('editCallDate').value; if(!dateSent)return showToast('Date required',true);
  if(m&&!$('editMsgEn').value.trim()&&!$('editMsgZh').value.trim())return showToast('Enter the message',true);
  if(!m&&!$('editCallNotes').value.trim())return showToast('Call notes required',true);
  const tu=$('editTeacherSelect').value; const tn=tu?(state.teachersMap[tu]||'Unknown'):(state.currentUser?.name||'Unknown');
  try{ await update(ref(db,`centers/${cid}/followUps/${id}`),{ type:m?'message':'call', messageType:m?$('editMessageType').value:'', messageEn:m?$('editMsgEn').value.trim():'', messageZh:m?$('editMsgZh').value.trim():'', callNotes:m?'':$('editCallNotes').value.trim(), solution:m?'':$('editSolution').value.trim(), dateCreated:m?$('editDateCreated').value:'', dateSent, month:dateSent.slice(0,7), teacherUid:tu, teacherName:tn, updatedAt:new Date().toISOString() });
    showToast('✅ Saved'); $('editModal').classList.add('hidden'); $('historyModal').classList.add('hidden'); }
  catch(e){ console.error(e); showToast('❌ Save failed',true); }
}

const sumCard=(t,n,s,tone)=>`<div class="balance-card ${tone}"><div class="bc-title">${t}</div><div class="bc-num">${n}</div>${s?`<div class="bc-sub">${s}</div>`:''}</div>`;
const barRow=(l,v,mx,c)=>`<div class="bar-row"><span class="bar-label">${l}</span><div class="bar-track"><div class="bar-fill ${c}" style="width:${Math.round(v/mx*100)}%"></div></div><span class="bar-val">${v}</span></div>`;
function renderReport(){
  const y=state.viewYear,m=state.viewMonth,key=ymKey(y,m); const roster=buildRoster(y,m);
  const mf=centerFollowUps().filter(f=>fuMonth(f)===key);   // 🆕 centered
  const total=roster.length; const fids=new Set(mf.map(f=>f.studentId)); const followed=roster.filter(r=>fids.has(r.id)).length; const not=total-followed;
  const msgs=mf.filter(f=>f.type==='message').length, calls=mf.filter(f=>f.type==='call').length; const pct=total?Math.round(followed/total*100):0;
  $('summaryCards').innerHTML=[sumCard('Current Students',total,esc(state.centerName||'—'),''),sumCard('Followed Up',followed,pct+'% coverage','bc-good'),sumCard('Not Followed',not,'need attention',not?'bc-warn':'bc-good'),sumCard('Messages Sent',msgs,'',''),sumCard('Calls Made',calls,'',''),sumCard('Follow-Ups / Student',total?(mf.length/total).toFixed(2):'0','ratio','')].join('');
  const bySubject=SUBJECTS.map(name=>{ const st=roster.filter(r=>r.subjects.some(s=>s.name===name)); const sf=mf.filter(f=>f.subject===name); const fi=new Set(sf.map(f=>f.studentId)); const fol=st.filter(r=>fi.has(r.id)).length; return {name,students:st.length,followed:fol,notFollowed:st.length-fol,coverage:st.length?Math.round(fol/st.length*100):0,messages:sf.filter(f=>f.type==='message').length,calls:sf.filter(f=>f.type==='call').length}; }).filter(s=>s.students>0||s.messages>0||s.calls>0);
  $('subjectCoverageBody').innerHTML=bySubject.length?bySubject.map(s=>{ const tone=s.coverage>=70?'g':s.coverage>=40?'y':'r'; return `<tr><td data-label="Subject"><span class="subj-chip ${subjClass(s.name)}">${s.name}</span></td><td data-label="Students">${s.students}</td><td data-label="Followed">${s.followed}</td><td data-label="Not Followed">${s.notFollowed?`<span class="txt-bad">${s.notFollowed}</span>`:0}</td><td data-label="Coverage"><div class="cov-bar wide"><div class="cov-fill ${tone}" style="width:${s.coverage}%"></div></div> <span class="sub">${s.coverage}%</span></td><td data-label="Msgs">${s.messages}</td><td data-label="Calls">${s.calls}</td></tr>`; }).join(''):'<tr><td colspan="7" class="hint-cell">No data.</td></tr>';
  const mx=Math.max(1,...bySubject.flatMap(s=>[s.students,s.messages,s.calls]));
  $('subjectChartArea').innerHTML=bySubject.length?bySubject.map(s=>`<div class="bar-group"><div class="bar-group-title">${esc(s.name)}</div>${barRow('Students',s.students,mx,'c-stu')}${barRow('Messages',s.messages,mx,'c-msg')}${barRow('Calls',s.calls,mx,'c-call')}</div>`).join(''):'<p class="hint-cell">No data.</p>';
  const trend=[]; for(let i=5;i>=0;i--){ const d=new Date(y,m-1-i,1); const ty=d.getFullYear(),tm=d.getMonth()+1,tk=ymKey(ty,tm); const tr=buildRoster(ty,tm); const tf=centerFollowUps().filter(f=>fuMonth(f)===tk); const fol=new Set(tf.map(f=>f.studentId)).size; trend.push({label:d.toLocaleDateString('en-US',{month:'short'}),students:tr.length,fus:tf.length,coverage:tr.length?Math.round(fol/tr.length*100):0}); }
  const tmax=Math.max(1,...trend.flatMap(t=>[t.students,t.fus]));
  $('trendChart').innerHTML=trend.map(t=>`<div class="trend-col"><div class="trend-bars"><div class="trend-bar tb-stu" style="height:${Math.round(t.students/tmax*100)}%" title="Students: ${t.students}"></div><div class="trend-bar tb-fu" style="height:${Math.round(t.fus/tmax*100)}%" title="Follow-ups: ${t.fus}"></div></div><div class="trend-pct">${t.coverage}%</div><div class="trend-label">${t.label}</div></div>`).join('')+'<div class="trend-legend"><span><i class="lg lg-stu"></i>Students</span><span><i class="lg lg-fu"></i>Follow-ups</span><span class="sub">% = coverage</span></div>';
  const bt={}; mf.forEach(f=>{ const t=f.teacherName||'Unknown'; bt[t]||={messages:0,calls:0,students:new Set()}; if(f.type==='message')bt[t].messages++; else bt[t].calls++; bt[t].students.add(f.studentId); });
  const tr=Object.entries(bt).sort((a,b)=>(b[1].messages+b[1].calls)-(a[1].messages+a[1].calls));
  $('byTeacherBody').innerHTML=tr.length?tr.map(([n,d])=>`<tr><td data-label="Teacher">${esc(n)}</td><td data-label="Msgs">${d.messages}</td><td data-label="Calls">${d.calls}</td><td data-label="Total"><b>${d.messages+d.calls}</b></td><td data-label="Students">${d.students.size}</td></tr>`).join(''):'<tr><td colspan="5" class="hint-cell">No data.</td></tr>';
  const byType={}; mf.filter(f=>f.type==='message').forEach(f=>{ byType[f.messageType||'Other']=(byType[f.messageType||'Other']||0)+1; });
  const tyr=Object.entries(byType).sort((a,b)=>b[1]-a[1]);
  $('byMsgTypeBody').innerHTML=tyr.length?tyr.map(([n,c])=>`<tr><td data-label="Type">${esc(n)}</td><td data-label="Count"><b>${c}</b></td><td data-label="Share">${msgs?Math.round(c/msgs*100):0}%</td></tr>`).join(''):'<tr><td colspan="3" class="hint-cell">No messages.</td></tr>';
}

function exportGuard(){ if(typeof XLSX==='undefined'){ showToast('❌ Excel library not loaded',true); return false; } return true; }
function logRows(fus){ return fus.map(f=>({ 'Date Sent':f.dateSent||'','Date Created':f.dateCreated||'','Type':f.type==='message'?'Message':'Call','Message Type':f.messageType||'','Student Name':f.nameCn||'','Pinyin':f.namePinyin||'','StudentNo':f.studentNumber||'','Centre':f.centerName||'','Grade':f.grade||'','School':f.school||'','Teacher':f.teacherName||'','Subject':f.subject||'','WS Level':f.level||'','Start Date':f.enrolDate||'','Class Day & Time':f.schedule||'','Message (EN)':f.messageEn||'','Message (中文)':f.messageZh||'','Call Notes':f.callNotes||'','Solution':f.solution||'' })); }
function exportMonthlyReport(){ if(!exportGuard())return; const y=state.viewYear,m=state.viewMonth,key=ymKey(y,m); const roster=buildRoster(y,m); const mf=centerFollowUps().filter(f=>fuMonth(f)===key); const wb=XLSX.utils.book_new(); const fids=new Set(mf.map(f=>f.studentId)); const fol=roster.filter(r=>fids.has(r.id)).length;
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Kumon Follow-Up Report',monthLabel(y,m)],['Center',state.centerName],[],['Current Students',roster.length],['Followed Up',fol],['Not Followed',roster.length-fol],['Coverage %',roster.length?Math.round(fol/roster.length*100):0],['Messages Sent',mf.filter(f=>f.type==='message').length],['Calls Made',mf.filter(f=>f.type==='call').length]]),'Summary');
  const sr=SUBJECTS.map(name=>{ const st=roster.filter(r=>r.subjects.some(s=>s.name===name)); const sf=mf.filter(f=>f.subject===name); const fi=new Set(sf.map(f=>f.studentId)); const fo=st.filter(r=>fi.has(r.id)).length; return {'Subject':name,'Students':st.length,'Followed':fo,'Not Followed':st.length-fo,'Coverage %':st.length?Math.round(fo/st.length*100):0,'Messages':sf.filter(f=>f.type==='message').length,'Calls':sf.filter(f=>f.type==='call').length}; });
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(sr),'By Subject');
  const stu=roster.map(r=>({'StudentNo':r.student?.studentNumber||'','Chinese Name':r.nameCn,'Pinyin':r.namePinyin,'Nickname':r.nickname,'Centre':r.centerName,'Grade':r.grade,'School':r.school,'Subjects':r.subjects.map(s=>`${s.name} ${s.level}`).join(', '),'Followed This Month':r.monthRecords.length>0?'YES':'NO','Follow-Ups This Month':r.monthRecords.length,'Last Follow-Up':r.lastDate||'NEVER','Days Since':r.daysSince??''}));
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(stu),'Students');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(logRows(mf)),'Follow-Up Log');
  XLSX.writeFile(wb,`Kumon_${getCenterAbbr(state.centerName)||'All'}_FollowUp_Report_${key}.xlsx`); showToast('📤 Exported');
}
function exportNotFollowed(){ if(!exportGuard())return; const rows=buildRoster(state.viewYear,state.viewMonth).filter(r=>r.monthRecords.length===0).map(r=>({'StudentNo':r.student?.studentNumber||'','Chinese Name':r.nameCn,'Pinyin':r.namePinyin,'Nickname':r.nickname,'Centre':r.centerName,'Grade':r.grade,'School':r.school,'Subjects':r.subjects.map(s=>`${s.name} ${s.level}`).join(', '),'Phone (Mom)':r.student?.phone?.mom||'','Phone (Dad)':r.student?.phone?.dad||'','Last Follow-Up':r.lastDate||'NEVER','Days Since':r.daysSince??''}));
  if(!rows.length)return showToast('✅ Everyone followed up this month!'); const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Not Followed'); XLSX.writeFile(wb,`Kumon_${getCenterAbbr(state.centerName)||'All'}_Not_Followed_${ymKey(state.viewYear,state.viewMonth)}.xlsx`); showToast('📤 Exported');
}
function exportFullLog(){ if(!exportGuard())return; const key=ymKey(state.viewYear,state.viewMonth); const rows=logRows(centerFollowUps().filter(f=>fuMonth(f)===key)); if(!rows.length)return showToast('No records this month',true); const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Follow-Up Log'); XLSX.writeFile(wb,`Kumon_${getCenterAbbr(state.centerName)||'All'}_FollowUp_Log_${key}.xlsx`); showToast('📤 Exported'); }

function switchTab(n){ document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===n)); document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active',c.id===`tab-${n}`)); }
function bindEvents(){
  document.querySelectorAll('.tab-btn').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
  $('monthPrev').onclick=()=>changeMonth(-1); $('monthNext').onclick=()=>changeMonth(1);
  $('monthToday').onclick=()=>{ const d=new Date(); state.viewYear=d.getFullYear(); state.viewMonth=d.getMonth()+1; state.selectedIds.clear(); renderAll(); };
  $('backToDashboardBtn').onclick=()=>window.location.href='dashboard.html';
  let comp=false; const si=$('searchInput');
  si.addEventListener('compositionstart',()=>comp=true); si.addEventListener('compositionend',()=>{comp=false;state.currentPage=1;renderTracker();}); si.addEventListener('input',()=>{if(!comp){state.currentPage=1;renderTracker();}});
  ['filterSubject','filterTeacher','filterGrade','filterStatus','sortBy'].forEach(id=>$(id).addEventListener('change',()=>{state.currentPage=1;renderTracker();}));
  $('clearFiltersBtn').onclick=()=>{ si.value=''; ['filterSubject','filterTeacher','filterGrade','filterStatus'].forEach(id=>$(id).value=''); $('sortBy').value='longest'; state.currentPage=1; renderTracker(); };
  $('pgFirst').onclick=()=>{state.currentPage=1;renderTracker();}; $('pgPrev').onclick=()=>{state.currentPage--;renderTracker();}; $('pgNext').onclick=()=>{state.currentPage++;renderTracker();}; $('pgLast').onclick=()=>{state.currentPage=Math.max(1,Math.ceil(state.filteredRoster.length/ITEMS_PER_PAGE));renderTracker();};
  $('checkAll').onchange=e=>{ const s=(state.currentPage-1)*ITEMS_PER_PAGE; state.filteredRoster.slice(s,s+ITEMS_PER_PAGE).forEach(r=>e.target.checked?state.selectedIds.add(r.id):state.selectedIds.delete(r.id)); renderTracker(); };
  $('bulkClearBtn').onclick=()=>{state.selectedIds.clear();renderTracker();};
  $('bulkLogBtn').onclick=()=>{ buildRoster(state.viewYear,state.viewMonth).filter(r=>state.selectedIds.has(r.id)).forEach(r=>addLogStudent(r.student)); state.selectedIds.clear(); switchTab('log'); renderTracker(); showToast(`${state.logStudents.length} added`); };
  let lc=false; const ls=$('logStudentSearch');
  ls.addEventListener('compositionstart',()=>lc=true); ls.addEventListener('compositionend',()=>{lc=false;renderLogStudentDropdown();}); ls.addEventListener('input',()=>{if(!lc)renderLogStudentDropdown();});
  ls.addEventListener('blur',()=>setTimeout(()=>$('logStudentDropdown').classList.add('hidden'),200)); ls.addEventListener('focus',renderLogStudentDropdown);
  $('fuTypeMessage').onchange=toggleFuTypeFields; $('fuTypeCall').onchange=toggleFuTypeFields; $('templateSelect').onchange=applyTemplate;
  $('saveFollowUpBtn').onclick=saveFollowUp; $('clearFormBtn').onclick=()=>resetLogForm(true);
  $('editTypeMessage').onchange=toggleEditTypeFields; $('editTypeCall').onchange=toggleEditTypeFields; $('saveEditBtn').onclick=saveEdit; $('deleteEditBtn').onclick=()=>deleteFollowUp($('editId').value);
  $('cancelEditBtn').onclick=()=>$('editModal').classList.add('hidden'); $('closeEditBtn').onclick=()=>$('editModal').classList.add('hidden');
  $('editModal').addEventListener('click',e=>{if(e.target===$('editModal'))$('editModal').classList.add('hidden');});
  $('closeHistoryBtn').onclick=()=>$('historyModal').classList.add('hidden'); $('historyModal').addEventListener('click',e=>{if(e.target===$('historyModal'))$('historyModal').classList.add('hidden');});
  $('exportReportBtn').onclick=exportMonthlyReport; $('exportNotFollowedBtn').onclick=exportNotFollowed; $('exportFullLogBtn').onclick=exportFullLog;
  const t=todayISO(); $('dateCreated').value=t; $('dateSent').value=t; $('callDate').value=t;
}
window.__fu={ db, ref, get, state };   // debug handle, remove anytime