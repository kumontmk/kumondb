// center-stats.js — Center Statistics, aligned with student-form / dropbook / reports / follow-ups data.
import { auth, requireAuth, db } from './auth.js';
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { OVER_F6 } from './grade-rollover.js';

const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const centerId = sessionStorage.getItem('selectedCenter');

const SUBJECTS = ['Math', 'English EFL', 'English ERP', 'Chinese (Trad)', 'Chinese (Simp)'];
const SUBJ_COLOR = { 'Math':'#2563eb', 'English EFL':'#ea580c', 'English ERP':'#dc2626', 'Chinese (Trad)':'#16a34a', 'Chinese (Simp)':'#16a34a' };
const SUBJ_SHORT = { 'Math':'Math', 'English EFL':'EFL', 'English ERP':'ERP', 'Chinese (Trad)':'Chi(T)', 'Chinese (Simp)':'Chi(S)' };
const STATUS_META = [['current','Current','#16a34a'],['inquiry','Inquiry','#0284c7'],['pause','Pause','#d97706'],['drop','Drop','#dc2626'],['completer','Completer','#6d28d9']];
const GRADE_ORDER = ['K0','K1','K2','K3','1','2','3','4','5','6','7','8','9','10','11','12','13', OVER_F6];
const GRADE_IDX = new Map(GRADE_ORDER.map((g,i)=>[String(g),i]));
// Covers Math (6A–O), EFL (7A–O), ERP/Chinese (7A–HII, II, III, J–L)
const LEVEL_ORDER = ['7A','6A','5A','4A','3A','2A','A','AI','AII','B','BI','BII','C','CI','CII','D','DI','DII','E','EI','EII','F','FI','FII','G','GI','GII','H','HI','HII','I','II','III','J','K','L','M','N','O'];
const AGE_BANDS = ['≤4','5–6','7–8','9–10','11–12','13–14','15–16','17+'];
const CYCLE = ['#2563eb','#7c3aed','#db2777','#dc2626','#ea580c','#16a34a','#0d9488','#ca8a04'];
const GENDER_COLORS = ['#2563eb','#db2777','#94a3b8'];
const TENURE_BUCKETS = ['0–3','4–6','7–12','13–24','25+'];

const state = { range:12, subject:'all', dropMode:'drop', scope:'current', trendMode:'lines', demo:false, convMonth:'all' };
let RAW = [], RAW_COUNT = 0, FU = [];
let CENTER_NAME = 'Center';
let M = null, C = {};
let schoolSort = { key:'current', dir:-1 };
let schoolQuery = '';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- utils ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const arr = v => Array.isArray(v) ? v.filter(Boolean) : (v && typeof v === 'object' ? Object.values(v).filter(Boolean) : []);
const pad2 = n => String(n).padStart(2,'0');
const isoLocal = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const shiftISO = (iso, days) => { const d = new Date(iso+'T00:00:00'); d.setDate(d.getDate()+days); return isoLocal(d); };
const miNow = () => { const n = new Date(); return n.getFullYear()*12 + n.getMonth(); };
const miOf = (y,m) => y*12 + (m-1);
const miFromISO = s => { if(!s) return null; const p = String(s).slice(0,10).split('-'); const y=+p[0], m=+p[1]; return (y && m) ? miOf(y,m) : null; };
const miISO = mi => `${Math.floor(mi/12)}-${pad2(mi%12+1)}-01`;
const miLabel = mi => new Date(Math.floor(mi/12), mi%12, 1).toLocaleDateString('en-US',{month:'short'}) + ' ’' + String(Math.floor(mi/12)).slice(2);
const miLabelLong = mi => new Date(Math.floor(mi/12), mi%12, 1).toLocaleDateString('en-US',{month:'short', year:'numeric'});
const diffDays = (a,b) => Math.round((new Date(b+'T00:00:00') - new Date(a+'T00:00:00')) / 86400000);
const median = a => { if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
const pct = (n,d) => d > 0 ? (n/d*100) : 0;
const hexRgba = (hex,a) => { const h=String(hex || '#94a3b8').replace('#',''); return `rgba(${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)},${a})`; };
const ageAt = (dob, refISO) => { if(!dob) return null; const t = (new Date(refISO+'T00:00:00') - new Date(String(dob).slice(0,10)+'T00:00:00')) / 86400000 / 365.2425; return t >= 0 && t < 120 ? t : null; };
const ageBand = a => a==null ? -1 : a<5?0 : a<7?1 : a<9?2 : a<11?3 : a<13?4 : a<15?5 : a<17?6 : 7;
const normLevel = l => String(l||'').trim().toUpperCase();
const normKey = l => String(l||'').trim().toUpperCase().replace(/\s+/g,'');
const displayName = s => s.nameCn ? `${s.nameCn}${s.namePinyin ? ' ('+s.namePinyin+')' : ''}` : (s.namePinyin || s.nickname || 'Unknown');
const hasCurrent = s => s.subjects.some(x => x.status === 'current');
const everEnrolled = s => s.subjects.some(x => x.enrolDate);
const hasDrop = s => s.subjects.some(x => x.status === 'drop');
const firstEnrolMi = s => { let m=null; s.subjects.forEach(x=>{ const e=miFromISO(x.enrolDate); if(e!=null && (m==null||e<m)) m=e; }); return m; };
const dtHasResults = dt => !!(String(dt.test||'').trim() || String(dt.score||'').trim() || String(dt.time||'').trim());
const dropMiOf = sub => { const y=parseInt(sub.dropYear), m=parseInt(sub.dropMonth); return (y&&m)?miOf(y,m):null; };
const pauseMiOf = sub => { const y=parseInt(sub.pauseFromYear), m=parseInt(sub.pauseFromMonth); return (y&&m)?miOf(y,m):null; };
const completerMiOf = sub => { const y=parseInt(sub.completerYear), m=parseInt(sub.completerMonth); return (y&&m)?miOf(y,m):null; };

function toast(msg, isErr=false){
  const t = $('csToast'); if(!t) return;
  t.textContent = msg; t.className = 'cs-toast' + (isErr ? ' error' : '');
  clearTimeout(t._tm); t._tm = setTimeout(()=>t.classList.add('hidden'), 3200);
}
function downloadCSV(name, rows){
  const cell = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; };
  const blob = new Blob(['\ufeff' + rows.map(r=>r.map(cell).join(',')).join('\n')], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  toast('⬇ ' + name + ' downloaded');
}
function animateNumber(el, to, {dec=0, suffix=''}={}){
  if(!el) return;
  const from = parseFloat(el.dataset.v || '0') || 0;
  el.dataset.v = to;
  if(reducedMotion || from === to){ el.textContent = to.toFixed(dec) + suffix; return; }
  const t0 = performance.now(), dur = 550;
  const step = t => { const k = Math.min(1,(t-t0)/dur), e = 1-Math.pow(1-k,3);
    el.textContent = (from+(to-from)*e).toFixed(dec) + suffix;
    if(k<1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function setDelta(el, diff, invert=false){
  if(!el) return;
  if(diff === 0){ el.className='kpi-delta flat'; el.textContent='– same as last month'; return; }
  const good = invert ? diff < 0 : diff > 0;
  el.className = 'kpi-delta ' + (good ? 'up' : 'down');
  el.textContent = (diff > 0 ? '▲ +' : '▼ ') + diff + ' vs last month';
}

/* ---------------- permission gate ---------------- */
async function checkPermission(){
  try{
    const stored = sessionStorage.getItem('kumonUser');
    const user = stored ? JSON.parse(stored) : {};
    const email = String(user.email || auth.currentUser?.email || '').toLowerCase();
    if(email === 'kumonchamps@gmail.com') return true;
    const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const aliases = { centerstatistics:'centerStatistics', centerstatistic:'centerStatistics', centerstats:'centerStatistics', statistics:'centerStatistics', stats:'centerStatistics', stat:'centerStatistics' };
    let uid = user.uid || auth.currentUser?.uid || null;
    let userData = null, empData = null;
    if(uid){ const s = await get(ref(db, `users/${uid}`)); if(s.exists()) userData = s.val(); }
    if(!userData && email){
      const s = await get(ref(db, 'users')); const all = s.val() || {};
      const k = Object.keys(all).find(u => String(all[u].email||'').toLowerCase() === email);
      if(k){ uid = k; userData = all[k]; }
    }
    if(uid){ const s = await get(ref(db, `employees/${uid}`)); if(s.exists()) empData = s.val(); }
    if(!empData && email){
      const s = await get(ref(db, 'employees')); const all = s.val() || {};
      empData = Object.values(all).find(e => String(e.email||'').toLowerCase() === email) || null;
    }
    const merged = { ...(userData?.permissions?.dashboardCards||{}), ...(empData?.permissions?.dashboardCards||{}) };
    const granted = new Set();
    Object.entries(merged).forEach(([k,v]) => { if(v === true) granted.add(aliases[norm(k)] || k); });
    return granted.has('centerStatistics');
  }catch(err){ console.error('Stats permission check failed:', err); return false; }
}

/* ---------------- data ---------------- */
function normalizeStudents(rawObj){
  const out = [];
  Object.entries(rawObj || {}).forEach(([id, v]) => {
    if(!v) return;
    const subjects = arr(v.subjects).filter(s => s && s.name);
    if(subjects.length === 0) return; // disregard records with no subjects
    out.push({ ...v, id, subjects, diagnosticTests: arr(v.diagnosticTests).filter(d => d && d.date && d.subject) });
  });
  return out;
}
function normalizeFollowUps(rawObj){
  return Object.values(rawObj || {}).filter(Boolean).map(f => ({
    studentId:String(f.studentId||''), subject:f.subject||'',
    date:String(f.dateSent || f.dateCreated || '').slice(0,10), type:f.type||'message'
  })).filter(f => f.studentId && f.date);
}
async function fetchReal(){
  const [nameSnap, altSnap, stuSnap, fuSnap] = await Promise.all([
    get(ref(db, `centers/${centerId}/name`)),
    get(ref(db, `centers/${centerId}/centerName`)),
    get(ref(db, `centers/${centerId}/students`)),
    get(ref(db, `centers/${centerId}/followUps`)).catch(() => null)
  ]);
  CENTER_NAME = nameSnap.val() || altSnap.val() || 'Center';
  const raw = stuSnap.val() || {};
  RAW_COUNT = Object.keys(raw).length;
  RAW = normalizeStudents(raw);
  FU = normalizeFollowUps(fuSnap && fuSnap.exists() ? fuSnap.val() : {});
}

/* ---------------- demo data (preview only) ---------------- */
function mulberry32(a){ return () => { a|=0; a = a+0x6D2B79F5|0; let t = Math.imul(a^a>>>15, 1|a); t = t+Math.imul(t^t>>>7, 61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function genDemo(){
  const r = mulberry32(20261128);
  const schools = ['Pui Ching Middle School','Sacred Heart Canossian College','St. Paul School','Hou Kong Middle School','Kwong Tai Catholic Primary','Lou Hau High School','Tong Sin School','Chan Sui Ki College'];
  const cn = ['陳大文','李小明','黃志強','張美玲','何俊傑','梁詠詩','吳家輝','鄭雅文','馮浩賢','許靜怡','鄧穎欣','蔡俊軒','盧芷晴','曾憲梓','彭嘉欣','蕭正楠','蘇恩磁','鍾嘉寶','唐文龍','袁詠儀','錢嘉樂','湯盈盈','鞏俐','龔慈恩'];
  const py = ['Chan Tai Man','Li Siu Ming','Wong Chi Keung','Cheung Mei Ling','Ho Chun Kit','Leung Wing Sze','Ng Ka Fai','Cheng Nga Man','Fung Ho Yin','Hui Ching Yi','Tang Wing Yan','Choi Chun Hin','Lo Tsz Ching','Tsang Hin Chi','Pang Ka Yan','Siu Ching Nam','So Yan Chi','Chung Ka Po','Tong Man Lung','Yuen Wing Yi','Chin Ka Lok','Tong Ying Ying','Gong Li','Kung Chi Yan'];
  const nick = ['Bobby','Kiki','Ah Bao','Mimi','Leo','Coco','Dodo','Ken'];
  const dropR = ['Moved away','School workload','Lost interest','Tuition cost','No time for homework','Transferred center','Schedule conflict','Finished program'];
  const pauseR = ['Exam period','Family travel','Health reasons','School activities','Temporary break'];
  const now = miNow(); const today = isoLocal();
  const isoFromMi = (mi, day=10) => `${Math.floor(mi/12)}-${pad2(mi%12+1)}-${pad2(day)}`;
  const nextLvl = i => LEVEL_ORDER[Math.min(LEVEL_ORDER.length-1, i+1)];
  const students = {}; const fus = [];
  let resumeReqPlaced = false;
  for(let i=0;i<96;i++){
    const gIdx = 1 + Math.floor((r()+r())/2 * 12);
    const grade = GRADE_ORDER[Math.min(gIdx, GRADE_ORDER.length-1)];
    const age = 3 + gIdx + Math.floor(r()*2);
    const by = new Date().getFullYear() - age;
    const birthday = `${by}-${pad2(1+Math.floor(r()*12))}-${pad2(1+Math.floor(r()*28))}`;
    const gender = r()<.03 ? '' : (r()<.53 ? 'Male' : 'Female');
    const school = schools[Math.floor(r()*schools.length)];
    const sid = 'demo'+i;
    const nSubs = 1 + (r()<.5?1:0) + (r()<.2?1:0);
    const pool = ['Math','Math','English EFL','English EFL','English ERP','Chinese (Trad)','Chinese (Simp)'];
    const picked = new Set(); while(picked.size < nSubs) picked.add(pool[Math.floor(r()*pool.length)]);
    const subjects = []; const dts = [];
    picked.forEach(name => {
      const roll = r();
      const isChi = name.includes('Chinese') || name==='English ERP';
      const startIdx = isChi ? Math.floor(r()*7) : Math.floor(r()*8);
      const startLevel = LEVEL_ORDER[startIdx];
      const lvlStep = isChi ? 3 : 1;
      const wsMode = r()<.3 ? 'Kumon Connect' : 'Paper';
      const mkDropBook = () => ({ callStatus:r()<.65, calledBy:'Ms Chan', notes:'Discussed with parent; offered schedule change.', confirmed:true, confirmedAt:today+'T09:00:00.000Z', exitFormAutopay:r()<.5, accounts:'Cleared', updatedAt:today+'T09:00:00.000Z' });
      const addProgress = (sub, enrolMi, curIdx) => {
        const prog = []; const months = Math.min(6, now - enrolMi);
        for(let k=months; k>=1; k--){
          const pIdx = Math.min(curIdx, startIdx + Math.max(0, Math.floor((months-k)/2))*lvlStep);
          const cIdx = Math.min(curIdx, pIdx + (k<months && r()<.4 ? lvlStep : 0));
          const mi = now - k;
          const entry = { month:isoFromMi(mi).slice(0,7), prevLevel:LEVEL_ORDER[pIdx], currLevel:LEVEL_ORDER[cIdx], currWS:10+Math.floor(r()*18)*10, tests:[] };
          if(cIdx!==pIdx && r()<.7) entry.tests.push({ date:isoFromMi(mi,20), level:LEVEL_ORDER[pIdx], score:String(70+Math.floor(r()*30)), time:`${10+Math.floor(r()*10)}/20`, group:'A' });
          prog.push(entry);
        }
        sub.progress = prog;
      };
      if(roll < .60){ // current
        const ago = 1 + Math.floor(r()*30);
        const enrolMi = now - ago;
        const enrolDate = isoFromMi(enrolMi, 1+Math.floor(r()*27));
        const curIdx = Math.min(LEVEL_ORDER.length-1, startIdx + Math.min(7, Math.floor(ago/3))*lvlStep);
        const sub = { name, status:'current', startLevel, currentLevel:LEVEL_ORDER[curIdx], enrolDate, inquiryDate:isoFromMi(enrolMi-(r()<.5?1:0),15), timeslots:[], worksheetType:wsMode };
        addProgress(sub, enrolMi, curIdx);
        const prRoll = r();
        if(prRoll < .07){ const m = now + 1 + Math.floor(r()*2);
          sub.pendingRequest = { type:'drop', dropMonth:pad2(m%12+1), dropYear:String(Math.floor(m/12)), reason:dropR[Math.floor(r()*dropR.length)] };
          sub.dropBook = { callStatus:r()<.5, calledBy:'Ms Chan', notes:'Retention call planned.', updatedAt:today+'T09:00:00.000Z' };
        } else if(prRoll < .13){ const f = now + 1, t = f + 2 + Math.floor(r()*2);
          sub.pendingRequest = { type:'pause', pauseFromMonth:pad2(f%12+1), pauseFromYear:String(Math.floor(f/12)), pauseToMonth:pad2(t%12+1), pauseToYear:String(Math.floor(t/12)), reason:pauseR[Math.floor(r()*pauseR.length)] };
        } else if(prRoll < .17){ sub.pendingRequest = { cancelled:true, cancelledAt:today+'T09:00:00.000Z' }; }
        subjects.push(sub);
        if(r()<.85) dts.push({ subject:name, date:shiftISO(enrolDate, -(2+Math.floor(r()*20))), DTtimeslot:'16:00', test:'DT', score:String(60+Math.floor(r()*40)), time:`${8+Math.floor(r()*10)}/20`, suggestedStart:startLevel, actualStart:r()<.8?startLevel:nextLvl(startIdx) });
        if(r()<.5) fus.push({ studentId:sid, subject:name, type:r()<.5?'message':'call', dateSent:isoFromMi(now-Math.floor(r()*4), 12), dateCreated:isoFromMi(now-Math.floor(r()*4), 12) });
      } else if(roll < .80){ // drop
        const ago = 6 + Math.floor(r()*30);
        const enrolMi = now - ago;
        let tenure = 2 + Math.floor((r()+r())/2 * 16);
        tenure = Math.max(1, Math.min(tenure, ago));
        const dropMi = enrolMi + tenure;
        const curIdx = Math.min(LEVEL_ORDER.length-1, startIdx + Math.floor(tenure/3)*lvlStep);
        const sub = { name, status:'drop', startLevel, currentLevel:LEVEL_ORDER[curIdx],
          enrolDate:isoFromMi(enrolMi,12), inquiryDate:isoFromMi(enrolMi,5),
          dropYear:String(Math.floor(dropMi/12)), dropMonth:pad2(dropMi%12+1),
          dropReason: r()<.1 ? '' : dropR[Math.floor(r()*dropR.length)], timeslots:[], worksheetType:wsMode, dropBook:mkDropBook() };
        if(r()<.8) dts.push({ subject:name, date:shiftISO(isoFromMi(enrolMi,12), -7), DTtimeslot:'17:00', test:'DT', score:String(60+Math.floor(r()*40)), time:'12/20', suggestedStart:startLevel, actualStart:startLevel });
        if(r()<.6) fus.push({ studentId:sid, subject:name, type:'call', dateSent:shiftISO(miISO(dropMi), -(5+Math.floor(r()*60))), dateCreated:'' });
        if(r()<.22 && dropMi < now-2){
          const backMi = Math.min(now, dropMi + 1 + Math.floor(r()*3));
          sub.status = 'current'; sub.resumed = true; sub.resumedAt = isoFromMi(backMi,5)+'T09:00:00.000Z';
          sub.currentLevel = LEVEL_ORDER[Math.min(LEVEL_ORDER.length-1, curIdx+lvlStep)];
          sub.timeslots = [];
        } else if(!resumeReqPlaced && dropMi <= now){
          resumeReqPlaced = true;
          const rm = now + 1;
          sub.resumeRequest = { returnMonth:pad2(rm%12+1), returnYear:String(Math.floor(rm/12)), requestedAt:today+'T09:00:00.000Z', processed:false };
        }
        subjects.push(sub);
      } else if(roll < .90){ // pause
        const ago = 4 + Math.floor(r()*26);
        const enrolMi = now - ago;
        const fromMi = now - (1 + Math.floor(r()*5));
        const hasTo = r() < .6;
        const toMi = fromMi + 2 + Math.floor(r()*3);
        subjects.push({ name, status:'pause', startLevel, currentLevel:LEVEL_ORDER[Math.min(LEVEL_ORDER.length-1,startIdx+2*lvlStep)],
          enrolDate:isoFromMi(enrolMi,8), inquiryDate:isoFromMi(enrolMi,2),
          pauseFromYear:String(Math.floor(fromMi/12)), pauseFromMonth:pad2(fromMi%12+1),
          pauseToYear:hasTo?String(Math.floor(toMi/12)):'', pauseToMonth:hasTo?pad2(toMi%12+1):'',
          pauseReason:pauseR[Math.floor(r()*pauseR.length)], timeslots:[], worksheetType:wsMode, dropBook:mkDropBook() });
        dts.push({ subject:name, date:shiftISO(isoFromMi(enrolMi,8), -10), DTtimeslot:'15:30', test:'DT', score:'78', time:'11/20', suggestedStart:startLevel, actualStart:startLevel });
        if(r()<.5) fus.push({ studentId:sid, subject:name, type:'message', dateSent:shiftISO(miISO(fromMi), -10), dateCreated:'' });
      } else if(roll < .95){ // completer
        const ago = 18 + Math.floor(r()*20);
        const enrolMi = now - ago;
        const cMi = now - Math.floor(r()*6);
        subjects.push({ name, status:'completer', startLevel, currentLevel:isChi?'L':'O',
          enrolDate:isoFromMi(enrolMi,8), inquiryDate:isoFromMi(enrolMi,2),
          completerYear:String(Math.floor(cMi/12)), completerMonth:pad2(cMi%12+1),
          completerForStudent:true, completerForTeacher:r()<.5, completerTestDate:isoFromMi(cMi,18), completerTestTime:'16:00',
          timeslots:[], worksheetType:wsMode });
      } else { // inquiry
        const inqMi = now - Math.floor(r()*3);
        const mode = r();
        subjects.push({ name, status:'inquiry', startLevel:'', currentLevel:'', enrolDate:'', inquiryDate:isoFromMi(inqMi,14), timeslots:[], worksheetType:'Paper' });
        if(mode < .45) dts.push({ subject:name, date:shiftISO(today, -(5+Math.floor(r()*50))), DTtimeslot:'16:30', test:'DT', score:String(55+Math.floor(r()*40)), time:'13/20', suggestedStart:startLevel, actualStart:'' });
        else if(mode < .7) dts.push({ subject:name, date:shiftISO(today, -(4+Math.floor(r()*30))), DTtimeslot:'16:30', test:'', score:'', time:'', suggestedStart:'', actualStart:'' });
        else dts.push({ subject:name, date:shiftISO(today, 2+Math.floor(r()*10)), DTtimeslot:'16:30', test:'', score:'', time:'', suggestedStart:'', actualStart:'' });
      }
    });
    const fe = subjects.map(s=>s.enrolDate).filter(Boolean).sort()[0] || subjects[0].inquiryDate || today;
    students[sid] = {
      nameCn:cn[i%cn.length], namePinyin:py[i%py.length], nickname:r()<.4?nick[Math.floor(r()*nick.length)]:'',
      studentNumber:'S'+(1000+i), gender, grade, school, birthday, phone:{mom:'6'+String(60000000+Math.floor(r()*9999999))},
      subjects, diagnosticTests:dts, createdAt:fe+'T09:00:00.000Z', updatedAt:today+'T09:00:00.000Z'
    };
  }
  for(let j=0;j<3;j++) students['ghost'+j] = { nameCn:'(no subjects)', subjects:[], diagnosticTests:[] };
  RAW_COUNT = Object.keys(students).length;
  RAW = normalizeStudents(students);
  FU = normalizeFollowUps(fus);
  CENTER_NAME = 'Sample Center (demo)';
}

/* ---------------- subject month state (mirrors form/dropbook/timetable rules) ---------------- */
function subjectStateInMonth(sub, mi){
  const start = miFromISO(sub.enrolDate);
  if(start == null || mi < start) return 'none';
  const pr = (sub.pendingRequest && !sub.pendingRequest.cancelled && sub.pendingRequest.type) ? sub.pendingRequest : null;
  const rr = (sub.resumeRequest && !sub.resumeRequest.processed) ? sub.resumeRequest : null;
  const resumeMi = sub.resumedAt ? miFromISO(sub.resumedAt)
    : (rr && parseInt(rr.returnYear) && parseInt(rr.returnMonth) ? miOf(parseInt(rr.returnYear), parseInt(rr.returnMonth)) : null);
  const resumedBy = m => resumeMi != null && m >= resumeMi;
  const cMi = completerMiOf(sub);
  if(sub.status === 'completer' && cMi != null && mi >= cMi) return 'completed';
  const dMi = dropMiOf(sub);
  if(dMi != null && mi >= dMi && (sub.status === 'drop' || sub.resumed === true) && !resumedBy(mi)) return 'dropped';
  if(pr && pr.type === 'drop' && sub.status !== 'drop'){
    const y = parseInt(pr.dropYear), m = parseInt(pr.dropMonth);
    if(y && m && mi >= miOf(y,m) && !resumedBy(mi)) return 'dropped';
  }
  const inWin = (fY,fM,tY,tM) => { if(!(fY&&fM)) return false; const from = miOf(fY,fM); const to = (tY&&tM) ? miOf(tY,tM) : Infinity; return mi >= from && mi <= to; };
  let pA = inWin(parseInt(sub.pauseFromYear), parseInt(sub.pauseFromMonth), parseInt(sub.pauseToYear), parseInt(sub.pauseToMonth));
  if(sub.status === 'pause' && !(parseInt(sub.pauseFromYear) && parseInt(sub.pauseFromMonth))){
    const f = miFromISO(sub.updatedAt) ?? miNow(); pA = mi >= f;
  }
  const pP = pr && pr.type === 'pause' && inWin(parseInt(pr.pauseFromYear), parseInt(pr.pauseFromMonth), parseInt(pr.pauseToYear), parseInt(pr.pauseToMonth));
  if((pA || pP) && !resumedBy(mi)) return 'paused';
  return 'current';
}

/* ---------------- model ---------------- */
function computeModel(){
  const S = RAW, end = miNow(), start = end - state.range + 1, today = isoLocal();
  const labels = []; for(let mi=start; mi<=end; mi++) labels.push(miLabel(mi));
  const sf = state.subject;
  const inSubj = name => sf === 'all' || name === sf;

  const fuBy = new Map();
  FU.forEach(f => { if(!fuBy.has(f.studentId)) fuBy.set(f.studentId, []); fuBy.get(f.studentId).push(f); });
  const contactBefore = (st, subName, eventISO) => {
    const list = fuBy.get(st.id) || [];
    const from = shiftISO(eventISO, -90);
    return list.some(f => (!f.subject || f.subject === subName) && f.date >= from && f.date <= eventISO);
  };

  // monthly series
  const total=[], totalSubs=[], pausedArr=[], newArr=[], dropArr=[], pauseStartArr=[], completesArr=[], newStudentsArr=[], levelUps=[], atsArr=[];
  const perSubj = {}; SUBJECTS.forEach(s => perSubj[s]=[]);
  const firstMi = new Map(S.map(s => [s.id, firstEnrolMi(s)]));
  const enrolMis=[], dropMis=[], pauseMis=[], compMis=[];
  const progEvents = [];
  S.forEach(st => st.subjects.forEach(sub => {
    const e = miFromISO(sub.enrolDate); if(e!=null) enrolMis.push(e);
    if(sub.status==='drop'){ const d=dropMiOf(sub); if(d!=null) dropMis.push(d); }
    const p = pauseMiOf(sub); if(p!=null) pauseMis.push(p);
    if(sub.status==='completer'){ const c=completerMiOf(sub); if(c!=null) compMis.push(c); }
    arr(sub.progress).forEach(pe => {
      const mi = miFromISO((pe.month||'') + '-01'); if(mi==null) return;
      const up = !!(pe.prevLevel && pe.currLevel && normKey(pe.prevLevel) !== normKey(pe.currLevel));
      let at = 0;
      arr(pe.tests).forEach(tst => { const tm = miFromISO(tst.date); if(tm===mi) at++; });
      progEvents.push({ mi, up, at });
    });
  }));
  for(let mi=start; mi<=end; mi++){
    let act=0, subs=0, pau=0;
    const cnt = Object.fromEntries(SUBJECTS.map(s=>[s,0]));
    S.forEach(st => {
      let cur=false;
      st.subjects.forEach(sub => {
        const stt = subjectStateInMonth(sub, mi);
        if(stt==='current'){ cnt[sub.name]=(cnt[sub.name]||0)+1; subs++; cur=true; }
        else if(stt==='paused') pau++;
      });
      if(cur) act++;
    });
    total.push(act); totalSubs.push(subs); pausedArr.push(pau);
    SUBJECTS.forEach(s => perSubj[s].push(cnt[s]));
    newArr.push(enrolMis.filter(x=>x===mi).length);
    dropArr.push(dropMis.filter(x=>x===mi).length);
    pauseStartArr.push(pauseMis.filter(x=>x===mi).length);
    completesArr.push(compMis.filter(x=>x===mi).length);
    newStudentsArr.push([...firstMi.values()].filter(x=>x===mi).length);
    const pe = progEvents.filter(x=>x.mi===mi);
    levelUps.push(pe.filter(x=>x.up).length);
    atsArr.push(pe.reduce((n,x)=>n+x.at,0));
  }

  // status + current subject mix + worksheet mode
  const statusCounts = Object.fromEntries(STATUS_META.map(([k])=>[k,0]));
  const currentSubj = Object.fromEntries(SUBJECTS.map(s=>[s,0]));
  const modeCounts = { 'Paper':0, 'Kumon Connect':0 };
  S.forEach(st => st.subjects.forEach(sub => {
    statusCounts[sub.status] = (statusCounts[sub.status]||0)+1;
    if(sub.status==='current'){
      currentSubj[sub.name]=(currentSubj[sub.name]||0)+1;
      modeCounts[sub.worksheetType === 'Kumon Connect' ? 'Kumon Connect' : 'Paper']++;
    }
  }));
    // ---- progress health (active subjects, last recorded level-up) ----
    const progressHealth = { new:0, onPace:0, slowing:0, stalled:0, noReports:0 };
    S.forEach(st => st.subjects.forEach(sub => {
    if(sub.status !== 'current' || !inSubj(sub.name)) return;
    const eMi = miFromISO(sub.enrolDate);
    const age = eMi != null ? end - eMi : 99;
    if(age < 2){ progressHealth.new++; return; }
    const prog = arr(sub.progress).filter(pe => miFromISO((pe.month||'') + '-01') != null);
    if(!prog.length){ progressHealth.noReports++; return; }
    let lastUp = null;
    prog.forEach(pe => {
    if(pe.prevLevel && pe.currLevel && normKey(pe.prevLevel) !== normKey(pe.currLevel)){
    const mi = miFromISO(pe.month + '-01');
    if(lastUp == null || mi > lastUp) lastUp = mi;
    }
    });
    const since = lastUp != null ? end - lastUp : age;
    if(since <= 2) progressHealth.onPace++;
    else if(since <= 5) progressHealth.slowing++;
    else progressHealth.stalled++;
    }));

  // ---- DT → enrollment ----
  const dtMonthly = labels.map(()=>({dt:0, enr:0, pairs:0, conv:0}));
  const idx = mi => mi - start;
  let conducted=0, upcoming=0, noResults=0;
  let sugN=0, sugMatch=0;
  const pairs = new Map();
  S.forEach(st => {
    st.diagnosticTests.forEach(dt => {
      if(!inSubj(dt.subject)) return;
      const mi = miFromISO(dt.date);
      if(dt.date > today){ upcoming++; return; }
      const results = dtHasResults(dt);
      if(results){
        conducted++;
        const sug = normKey(dt.suggestedStart);
        const sub = st.subjects.find(x => x.name === dt.subject);
        const basis = normKey(dt.actualStart || sub?.startLevel);
        if(sug && basis){ sugN++; if(sug === basis) sugMatch++; }
      } else noResults++;
      if(mi!=null && mi>=start && mi<=end) dtMonthly[idx(mi)].dt++;
      const key = st.id+'|'+dt.subject;
      const p = pairs.get(key) || { student:st, subject:dt.subject, firstDT:dt.date, lastDT:dt.date, hasResults:false };
      if(dt.date < p.firstDT) p.firstDT = dt.date;
      if(dt.date > p.lastDT) p.lastDT = dt.date;
      if(results) p.hasResults = true;
      pairs.set(key, p);
    });
    st.subjects.forEach(sub => {
      if(!inSubj(sub.name)) return;
      const mi = miFromISO(sub.enrolDate);
      if(mi!=null && mi>=start && mi<=end) dtMonthly[idx(mi)].enr++;
    });
  });
  let converted=0; const daysList=[]; const pending=[]; const monthMap=new Map();
  const bySubjDT = {}; SUBJECTS.forEach(s => bySubjDT[s]={pairs:0, conv:0});
  pairs.forEach(p => {
    const sub = p.student.subjects.find(x => x.name === p.subject);
    p.enrolDate = sub?.enrolDate || '';
    p.converted = !!p.enrolDate;
    const b = bySubjDT[p.subject]; if(b){ b.pairs++; if(p.converted) b.conv++; }
    const mi = miFromISO(p.firstDT);
    if(mi!=null){ const mm=monthMap.get(mi)||{pairs:0,conv:0}; mm.pairs++; if(p.converted) mm.conv++; monthMap.set(mi,mm); }
    if(mi!=null && mi>=start && mi<=end){ dtMonthly[idx(mi)].pairs++; if(p.converted) dtMonthly[idx(mi)].conv++; }
    if(p.converted){ converted++; daysList.push(Math.max(0, diffDays(p.firstDT, p.enrolDate))); }
    else {
      const wait = diffDays(p.lastDT, today);
      if((p.hasResults && wait >= 14) || (!p.hasResults && wait >= 3)) pending.push({ ...p, wait });
    }
  });
  pending.sort((a,b)=>b.wait-a.wait);
  const inquiriesEver = S.reduce((n,st)=>n + st.subjects.filter(sub =>
    inSubj(sub.name) && (sub.inquiryDate || sub.status==='inquiry' || st.diagnosticTests.some(d=>d.subject===sub.name))
  ).length, 0);
  const monthKeys = [];
  if(monthMap.size){ const minMi=Math.min(...monthMap.keys()); for(let mi=end; mi>=minMi; mi--) monthKeys.push(mi); }
  const dt = { conducted, upcoming, noResults, converted, pairs:pairs.size, inquiriesEver,
    rate:pct(converted, pairs.size), medianDays:median(daysList), bySubj:bySubjDT,
    suggest:{ n:sugN, match:sugMatch, pct:pct(sugMatch, sugN) },
    monthly:dtMonthly, convMonthly:dtMonthly.map(x=>Math.round(pct(x.conv,x.pairs))), pending,
    monthMap, monthKeys };

  // ---- drop / pause events (Drop Book aware) ----
  const mode = state.dropMode;
  const events = [];
  S.forEach(st => st.subjects.forEach(sub => {
    if(!inSubj(sub.name)) return;
    if(mode==='drop'){
      const dMi = dropMiOf(sub);
      const isDrop = sub.status==='drop';
      const isWinback = sub.resumed===true && !isDrop && dMi!=null;
      if(!isDrop && !isWinback) return;
      events.push({ st, sub, mi:dMi, reason:String(sub.dropReason||'').trim(),
        level:normLevel(sub.currentLevel||sub.startLevel), winback:isWinback,
        activeExit:isDrop });
    } else {
      const pMi = pauseMiOf(sub);
      if(pMi==null) return;
      events.push({ st, sub, mi:pMi, reason:String(sub.pauseReason||'').trim(),
        level:normLevel(sub.currentLevel||sub.startLevel), winback:sub.resumed===true && sub.status!=='pause',
        activeExit:sub.status==='pause' });
    }
  }));
  const everSubjects = S.reduce((n,st)=>n+st.subjects.filter(s=>s.enrolDate&&inSubj(s.name)).length,0);
  const evBySubj = Object.fromEntries(SUBJECTS.map(s=>[s,0]));
  const evByLevel = {}; const evByMonth = labels.map(()=>0); const reasons = {}; const tenures = [];
  let calledN=0, confirmedN=0, autopayN=0, contactN=0, datedN=0;
  events.forEach(e => {
    evBySubj[e.sub.name]=(evBySubj[e.sub.name]||0)+1;
    if(e.level) evByLevel[e.level]=(evByLevel[e.level]||0)+1;
    if(e.mi!=null && e.mi>=start && e.mi<=end) evByMonth[e.mi-start]++;
    const rk = e.reason || 'Not recorded';
    const key = rk.toLowerCase();
    reasons[key] = reasons[key] || { label:rk, count:0 };
    reasons[key].count++;
    const em = miFromISO(e.sub.enrolDate);
    if(em!=null && e.mi!=null) tenures.push(Math.max(0, e.mi-em));
    const dbk = e.sub.dropBook || {};
    if(dbk.callStatus === true) calledN++;
    if(dbk.confirmed === true) confirmedN++;
    if(dbk.exitFormAutopay === true) autopayN++;
    if(e.mi!=null){ datedN++; if(contactBefore(e.st, e.sub.name, miISO(e.mi))) contactN++; }
  });
  const knownLevels = LEVEL_ORDER.filter(l => evByLevel[l]);
  const unknown = Object.keys(evByLevel).filter(l => !LEVEL_ORDER.includes(l)).sort((a,b)=>evByLevel[b]-evByLevel[a]);
  const levelLabels = [...knownLevels, ...unknown.slice(0,5)];
  const levelVals = levelLabels.map(l=>evByLevel[l]);
  const otherN = unknown.slice(5).reduce((n,l)=>n+evByLevel[l],0);
  if(otherN>0){ levelLabels.push('Other'); levelVals.push(otherN); }
  const reasonRows = Object.values(reasons).sort((a,b)=>b.count-a.count);
  const bucketVals = TENURE_BUCKETS.map(()=>0);
  tenures.forEach(t => { bucketVals[t<=3?0:t<=6?1:t<=12?2:t<=24?3:4]++; });
  const topLevel = Object.entries(evByLevel).sort((a,b)=>b[1]-a[1])[0] || null;

  let saved=0, winbacks=0;
  S.forEach(st => st.subjects.forEach(sub => {
    if(!inSubj(sub.name)) return;
    if(sub.pendingRequest && sub.pendingRequest.cancelled) saved++;
    if(sub.resumed === true) winbacks++;
  }));

  const cohort = S.filter(everEnrolled);
  const evStudents = new Set(events.map(e=>e.st.id));
  const rateBy = (keyFn, keys) => keys.map(k => {
    const c = cohort.filter(s => keyFn(s) === k);
    const d = c.filter(s => evStudents.has(s.id));
    return { n:c.length, d:d.length, rate:pct(d.length, c.length) };
  });
  const genderRate = rateBy(s => s.gender || 'Not set', ['Male','Female']).slice(0,2);
  const gradeRateKeys = GRADE_ORDER.filter(g => cohort.filter(s=>String(s.grade)===g).length >= 2);
  const gradeRate = rateBy(s => String(s.grade), gradeRateKeys);
  const ageRate = AGE_BANDS.map((_,i) => {
    const c = cohort.filter(s => ageBand(ageAt(s.birthday, today)) === i);
    const d = c.filter(s => evStudents.has(s.id));
    return { n:c.length, d:d.length, rate:pct(d.length, c.length) };
  });
  const monthAgg = Array(12).fill(0);
  events.forEach(e => { if(e.mi!=null && e.mi>end-24) monthAgg[e.mi%12]++; });
  const peakMi = monthAgg.indexOf(Math.max(...monthAgg));
  const drops = { mode, total:events.length, rate:pct(events.length, everSubjects),
    bySubj:evBySubj, levelLabels, levelVals, monthly:evByMonth, reasons:reasonRows,
    tenureBuckets:bucketVals, medianTenure:median(tenures), topLevel,
    genderRate, gradeRateKeys, gradeRate, ageRate,
    exit:{ called:calledN, confirmed:confirmedN, autopay:autopayN, contact:contactN, dated:datedN },
    saved, winbacks,
    peakMonth: Math.max(...monthAgg)>0 ? new Date(2000,peakMi,1).toLocaleDateString('en-US',{month:'long'}) : null };

  // ---- demographics ----
  const scopeCohort = state.scope==='current' ? S.filter(hasCurrent)
    : state.scope==='dropped' ? S.filter(hasDrop) : S.filter(everEnrolled);
  const refFor = st => {
    if(state.scope!=='dropped') return today;
    let best = null;
    st.subjects.forEach(sub => { if(sub.status==='drop'){ const d=dropMiOf(sub); if(d!=null){ const iso=miISO(d); if(!best||iso<best) best=iso; } } });
    return best || today;
  };
  const ages = []; const gCounts = {Male:0, Female:0, 'Not set':0}; const gradeCounts = GRADE_ORDER.map(()=>0);
  let gIdxSum=0, gIdxN=0;
  scopeCohort.forEach(st => {
    const a = ageAt(st.birthday, refFor(st)); if(a!=null) ages.push(a);
    gCounts[st.gender==='Male'||st.gender==='Female' ? st.gender : 'Not set']++;
    const gi = GRADE_IDX.get(String(st.grade));
    if(gi!=null){ gradeCounts[gi]++; gIdxSum+=gi; gIdxN++; }
  });
  const mCount=gCounts.Male, fCount=gCounts.Female, gf=mCount+fCount;
  const demo = { count:scopeCohort.length, ages, gCounts, gradeCounts,
    avgAge: ages.length ? ages.reduce((a,b)=>a+b,0)/ages.length : null,
    medAge: median(ages),
    avgGrade: gIdxN ? GRADE_ORDER[Math.max(0,Math.min(GRADE_ORDER.length-1,Math.round(gIdxSum/gIdxN)))] : null,
    split: gf ? `${Math.round(pct(mCount,gf))}% M · ${Math.round(pct(fCount,gf))}% F` : '—' };

  // ---- schools ----
  const schoolMap = new Map();
  S.forEach(st => {
    const key = String(st.school||'').trim() || 'Not recorded';
    const row = schoolMap.get(key) || { school:key, current:0, ever:0, dropped:0, rate:0, math:0, efl:0, erp:0, cht:0, chis:0 };
    if(hasCurrent(st)) row.current++;
    if(everEnrolled(st)) row.ever++;
    if(hasDrop(st)) row.dropped++;
    st.subjects.forEach(sub => { if(sub.status!=='current') return;
      if(sub.name==='Math') row.math++; else if(sub.name==='English EFL') row.efl++;
      else if(sub.name==='English ERP') row.erp++; else if(sub.name==='Chinese (Trad)') row.cht++;
      else if(sub.name==='Chinese (Simp)') row.chis++; });
    schoolMap.set(key, row);
  });
  const schools = [...schoolMap.values()];
  schools.forEach(r => r.rate = pct(r.dropped, r.ever));

  // ---- grade table ----
  const gradeEver = GRADE_ORDER.map(()=>0), gradeDrop = GRADE_ORDER.map(()=>0), gradeCur = GRADE_ORDER.map(()=>0);
  S.forEach(st => { const gi = GRADE_IDX.get(String(st.grade)); if(gi==null) return;
    if(everEnrolled(st)) gradeEver[gi]++;
    if(hasDrop(st)) gradeDrop[gi]++;
    if(hasCurrent(st)) gradeCur[gi]++; });
  const gradeModel = { cur:gradeCur, ever:gradeEver, drop:gradeDrop, rate:gradeEver.map((n,i)=>pct(gradeDrop[i],n)) };

  // ---- action lists ----
  const returning=[], stalled=[], uncalled=[], upcomingReq=[];
  S.forEach(st => st.subjects.forEach(sub => {
    if(sub.status==='pause'){
      const ty=parseInt(sub.pauseToYear), tm=parseInt(sub.pauseToMonth);
      const pMi = pauseMiOf(sub);
      if(ty&&tm){ const to=miOf(ty,tm); if(to>=end && to<=end+2) returning.push({st,sub,to}); }
      else if(pMi!=null && pMi <= end-3) stalled.push({st,sub,months:end-pMi});
    }
    if((sub.status==='drop' || sub.status==='pause') && !(sub.dropBook && sub.dropBook.callStatus===true)){
      const mi = sub.status==='drop' ? dropMiOf(sub) : pauseMiOf(sub);
      uncalled.push({ st, sub, mi, type:sub.status, reason:sub.status==='drop' ? sub.dropReason : sub.pauseReason });
    }
    const pr = sub.pendingRequest;
    if(pr && !pr.cancelled && pr.type){
      const y = parseInt(pr.type==='drop' ? pr.dropYear : pr.pauseFromYear);
      const m = parseInt(pr.type==='drop' ? pr.dropMonth : pr.pauseFromMonth);
      if(y&&m){
        const mi = miOf(y,m);
        const due = mi <= end && (sub.status==='current' || sub.status==='inquiry');
        if(mi >= end || due) upcomingReq.push({ st, sub, mi, type:pr.type, reason:pr.reason||'', due,
          called: !!(sub.dropBook && sub.dropBook.callStatus===true) });
      }
    }
  }));
  returning.sort((a,b)=>a.to-b.to);
  stalled.sort((a,b)=>b.months-a.months);
  uncalled.sort((a,b)=>(b.mi??-1)-(a.mi??-1));
  upcomingReq.sort((a,b)=>a.mi-b.mi);

  // ---- KPIs ----
  const last = a => a[a.length-1] ?? 0, prev = a => a[a.length-2] ?? 0;
  const kpi = {
    active:last(total), activeD:last(total)-prev(total),
    subjects:last(totalSubs), subjectsD:last(totalSubs)-prev(totalSubs),
    newM:last(newStudentsArr), newD:last(newStudentsArr)-prev(newStudentsArr),
    dropsM:last(dropArr), dropsD:last(dropArr)-prev(dropArr),
    paused:last(pausedArr), pausedD:last(pausedArr)-prev(pausedArr)
  };

  // ---- insights ----
  const insights = [];
  if(drops.topLevel && drops.total>0){
    const topSub = Object.entries(drops.bySubj).sort((a,b)=>b[1]-a[1])[0];
    insights.push({ ico:'🎯', txt:`Most ${mode==='drop'?'drops':'pauses'} cluster at level ${drops.topLevel[0]} (${drops.topLevel[1]} records)${topSub && topSub[1]>0 ? `, led by ${topSub[0]}` : ''}.`, go:'drops' });
  }
  if(drops.medianTenure!=null){
    const peakN = Math.max(...drops.tenureBuckets);
    const peakBand = TENURE_BUCKETS[drops.tenureBuckets.indexOf(peakN)];
    insights.push({ ico:'⏱', txt:`The median student ${mode==='drop'?'leaves':'pauses'} after ${drops.medianTenure} month${drops.medianTenure===1?'':'s'} enrolled${peakN>0 ? ` — most ${mode} events (${peakN}) happen in the ${peakBand} month band` : ''}.`, go:'drops' });
  }
  if(drops.exit.dated >= 5){
    const cp = Math.round(pct(drops.exit.contact, drops.exit.dated));
    insights.push({ ico: cp < 50 ? '📵' : '📞', txt:`${cp}% of ${mode} events had a follow-up logged within 90 days before them${cp<50?' — earlier contact could save some of these':''}.`, go:'drops' });
  }
  if(drops.exit.dated > 0 && drops.exit.called < drops.total){
    const un = uncalled.length;
    if(un>0) insights.push({ ico:'🗂', txt:`${un} current drop/pause record${un===1?'':'s'} still have no parent call in the Drop Book.`, go:'actions' });
  }
  if(drops.peakMonth) insights.push({ ico:'📅', txt:`${drops.peakMonth} is the peak ${mode} month in the last two years — plan retention outreach before it.`, go:'drops' });
  if(dt.pairs>0) insights.push({ ico:'🧪', txt:`${Math.round(dt.rate)}% of tested students enroll${dt.medianDays!=null ? `, typically within ${Math.round(dt.medianDays)} days of the DT` : ''}. ${dt.pending.length} need a follow-up${dt.noResults>0 ? `; ${dt.noResults} past DTs have no results recorded` : ''}.`, go:'dt' });
  if(dt.suggest.n >= 5) insights.push({ ico:'🎯', txt:`Suggested start level matched the actual start in ${Math.round(dt.suggest.pct)}% of ${dt.suggest.n} assessed DTs.`, go:'dt' });
  if(drops.saved + drops.winbacks > 0) insights.push({ ico:'🛟', txt:`Retention wins: ${drops.saved} request${drops.saved===1?'':'s'} cancelled and ${drops.winbacks} student${drops.winbacks===1?'':'s'} resumed after leaving.`, go:'drops' });
  const topSchool = [...schools].sort((a,b)=>b.current-a.current)[0];
  if(topSchool && kpi.active>0) insights.push({ ico:'🏫', txt:`${topSchool.school} supplies ${Math.round(pct(topSchool.current,kpi.active))}% of current students (${topSchool.current}).`, go:'schools' });
  if(returning.length>0) insights.push({ ico:'🔜', txt:`${returning.length} paused subject${returning.length===1?'':'s'} return within 2 months — confirm schedules with parents now.`, go:'actions' });
  const net = newArr.reduce((a,b)=>a+b,0) - dropArr.reduce((a,b)=>a+b,0);
  insights.push({ ico: net>=0?'📈':'📉', txt:`Net subject change over ${state.range} months: ${net>=0?'+':''}${net} (${newArr.reduce((a,b)=>a+b,0)} enrolled, ${dropArr.reduce((a,b)=>a+b,0)} dropped, ${completesArr.reduce((a,b)=>a+b,0)} completed).`, go:'growth' });

  return { labels, start, end, total, totalSubs, perSubj, pausedArr, newArr, dropArr, pauseStartArr, completesArr, newStudentsArr,
    levelUps, atsArr, statusCounts, currentSubj, modeCounts, progressHealth, dt, drops, demo, schools, gradeModel,
    returning, stalled, uncalled, upcomingReq, kpi, insights, recordCount:S.length };
}

/* ---------------- charts ---------------- */
function ensureChartLib(){
  return new Promise(res => {
    if(window.Chart) return res();
    const s = $('chartjsLib'); if(!s) return res();
    let done=false; const fin=()=>{ if(!done){done=true;res();} };
    s.addEventListener('load', fin, {once:true});
    s.addEventListener('error', fin, {once:true});
    setTimeout(fin, 5000);
  });
}
const areaFill = (hex, a=.28) => ctx => {
  const ch = ctx.chart, area = ch.chartArea;
  if(!area) return hexRgba(hex, a);
  const g = ch.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, hexRgba(hex, a)); g.addColorStop(1, hexRgba(hex, .02));
  return g;
};
const barValuesPlugin = { id:'barValues', afterDatasetsDraw(c){
  const o = c.options.plugins.barValues; if(!o || !o.display) return;
  const ctx = c.ctx, horiz = c.options.indexAxis === 'y';
  ctx.save(); ctx.font = '700 10px -apple-system, Segoe UI, Roboto, sans-serif'; ctx.fillStyle = '#475569';
  c.data.datasets.forEach((ds, di) => {
    const meta = c.getDatasetMeta(di);
    if(meta.type !== 'bar' || !c.isDatasetVisible(di)) return;
    meta.data.forEach((el, i) => {
      const v = ds.data[i]; if(!v) return;
      const t = o.suffix ? Number(v).toFixed(0)+o.suffix : String(v);
      if(horiz){ ctx.textAlign='left'; ctx.textBaseline='middle';
        ctx.fillText(t, Math.min(el.x+5, c.chartArea.right - ctx.measureText(t).width - 2), el.y); }
      else { ctx.textAlign='center'; ctx.textBaseline='bottom';
        ctx.fillText(t, el.x, Math.max(el.y-4, c.chartArea.top+10)); }
    });
  });
  ctx.restore();
}};
const centerTextPlugin = { id:'centerText', afterDraw(c){
  const o = c.options.plugins.centerText; if(!o || !o.display) return;
  const m = c.getDatasetMeta(0); if(!m.data.length) return;
  const {x,y} = m.data[0]; const ctx = c.ctx;
  ctx.save(); ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.font='800 22px -apple-system, Segoe UI, Roboto, sans-serif'; ctx.fillStyle='#0f2740';
  ctx.fillText(String(o.text ?? ''), x, y-8);
  ctx.font='600 10px -apple-system, Segoe UI, Roboto, sans-serif'; ctx.fillStyle='#64748b';
  ctx.fillText(String(o.sub ?? ''), x, y+13); ctx.restore();
}};
function baseOpts(extra={}){
  return {
    responsive:true, maintainAspectRatio:false,
    plugins:{ legend:{display:false}, tooltip:{
      backgroundColor:'#0f2740', titleColor:'#e2e8f0', bodyColor:'#cbd5e1',
      padding:10, cornerRadius:8, boxPadding:4,
      callbacks: extra.afterLabel ? { afterLabel: extra.afterLabel } : {}
    }},
    scales:{ x:{grid:{display:false}, ticks:{color:'#64748b', font:{size:10}}},
             y:{beginAtZero:true, grid:{color:'rgba(148,163,184,.18)'}, border:{display:false}, ticks:{color:'#64748b', font:{size:10}, precision:0}} },
    animation:{duration: reducedMotion ? 0 : 500},
    ...extra.opts
  };
}
const rateAfterLabel = ctx => { const e = ctx.chart.$extra?.[ctx.dataIndex]; return e ? `${e.d} of ${e.n} students` : ''; };
function mkBar(id, labels, color, opts={}){
  const el = $(id); if(!el || !window.Chart) return null;
  const horiz = !!opts.horizontal;
  const o = baseOpts({ afterLabel: opts.rate ? rateAfterLabel : null });
  o.indexAxis = horiz ? 'y' : 'x';
  o.plugins.barValues = { display:true, suffix: opts.suffix || '' };
  if(opts.suffix === '%'){ (horiz ? o.scales.x : o.scales.y).max = 100; }
  if(horiz){ o.scales.y.grid = {display:false}; o.scales.x.grid = {color:'rgba(148,163,184,.18)'}; o.scales.x.beginAtZero = true; }
  return new Chart(el, { type:'bar',
    data:{ labels, datasets:[{ data:labels.map(()=>0), backgroundColor:color, borderRadius:6, maxBarThickness:34 }] },
    options:o });
}
function mkDoughnut(id, labels, colors, sub){
  const el = $(id); if(!el || !window.Chart) return null;
  return new Chart(el, { type:'doughnut',
    data:{ labels, datasets:[{ data:labels.map(()=>0), backgroundColor:colors, borderWidth:2, borderColor:'#fff', hoverOffset:8 }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'68%',
      plugins:{ legend:{display:true, position:'bottom', labels:{usePointStyle:true, boxWidth:8, padding:12, font:{size:11}, color:'#475569'}},
        centerText:{display:true, text:'0', sub},
        tooltip:{backgroundColor:'#0f2740', padding:10, cornerRadius:8} },
      animation:{duration: reducedMotion ? 0 : 600} } });
}
function mkSpark(id, hex){
  const el = $(id); if(!el || !window.Chart) return null;
  return new Chart(el, { type:'line',
    data:{ labels:[], datasets:[{ data:[], borderColor:hex, borderWidth:2, pointRadius:0, tension:.45, fill:true, backgroundColor:areaFill(hex,.25) }] },
    options:{ responsive:true, maintainAspectRatio:false, events:[],
      plugins:{legend:{display:false}, tooltip:{enabled:false}},
      scales:{x:{display:false}, y:{display:false}}, animation:{duration: reducedMotion ? 0 : 400} } });
}
const legendBottom = () => ({display:true, position:'bottom', labels:{usePointStyle:true, boxWidth:8, padding:12, font:{size:11}}});
function createCharts(){
  if(!window.Chart){
    document.querySelectorAll('.chart-box').forEach(b => b.innerHTML = '<div class="chart-fallback">📉 Charts could not load (offline?). All numbers, tables and insights still work.</div>');
    document.querySelectorAll('.spark-box').forEach(b => b.style.display='none');
    return;
  }
  Chart.register(barValuesPlugin, centerTextPlugin);
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.color = '#64748b';

  C.progress = mkDoughnut('statusChart',
    ['New <2 mo','On pace ≤2 mo','Slowing 3–5 mo','Stalled 6+ mo','No reports'],
    ['#2563eb','#16a34a','#d97706','#dc2626','#94a3b8'], 'on pace');
    if(C.progress) C.progress.options.plugins.tooltip.callbacks = {
    label: ctx => {
    const tot = ctx.dataset.data.reduce((a,b)=>a+(+b||0),0);
    return ` ${ctx.label}: ${ctx.parsed} subject${ctx.parsed===1?'':'s'} · ${tot>0?Math.round(pct(ctx.parsed,tot)):0}%`;
    }
    };
  C.subject = mkDoughnut('subjectChart', SUBJECTS.map(s=>SUBJ_SHORT[s]), SUBJECTS.map(s=>SUBJ_COLOR[s]), 'active');
  C.mode = mkDoughnut('modeChart', ['Paper','Kumon Connect'], ['#4682B4','#0d9488'], 'active');

  const hc = $('headcountChart');
  if(hc) C.headcount = new Chart(hc, { type:'line',
    data:{ labels:[], datasets:[
      { label:'Total', data:[], borderColor:'#0f2740', borderWidth:3, pointRadius:2, tension:.35, fill:true, backgroundColor:areaFill('#0f2740',.16) },
      ...SUBJECTS.map(s => ({ label:s, data:[], borderColor:SUBJ_COLOR[s], borderWidth:2, pointRadius:0, tension:.35, fill:false, backgroundColor:areaFill(SUBJ_COLOR[s],.25) }))
    ]},
    options:(()=>{ const o = baseOpts(); o.plugins.legend = legendBottom();
      o.interaction = {mode:'index', intersect:false}; return o; })() });

  const ik = $('intakeChart');
  if(ik) C.intake = new Chart(ik, { type:'bar',
    data:{ labels:[], datasets:[
      { label:'New subjects', data:[], backgroundColor:'#16a34a', borderRadius:5, maxBarThickness:18 },
      { label:'Drops', data:[], backgroundColor:'#dc2626', borderRadius:5, maxBarThickness:18 },
      { label:'Pause starts', data:[], backgroundColor:'#d97706', borderRadius:5, maxBarThickness:18 },
      { label:'Completes', data:[], backgroundColor:'#6d28d9', borderRadius:5, maxBarThickness:18 },
      { label:'Net (new − drops)', data:[], type:'line', borderColor:'#0f2740', borderWidth:2, pointRadius:2, tension:.35 }
    ]},
    options:(()=>{ const o = baseOpts(); o.plugins.legend = legendBottom();
      o.interaction = {mode:'index', intersect:false}; o.scales.y.beginAtZero = false; return o; })() });

  const lu = $('levelUpChart');
  if(lu) C.levelUp = new Chart(lu, { type:'bar',
    data:{ labels:[], datasets:[
      { label:'Level-ups', data:[], backgroundColor:'#0d9488', borderRadius:5, maxBarThickness:22 },
      { label:'ATs recorded', data:[], type:'line', borderColor:'#2563eb', borderWidth:2.5, pointRadius:2, tension:.35, fill:true, backgroundColor:areaFill('#2563eb',.15) }
    ]},
    options:(()=>{ const o = baseOpts(); o.plugins.legend = legendBottom();
      o.interaction = {mode:'index', intersect:false}; return o; })() });

  C.dtSubject = mkBar('dtSubjectChart', SUBJECTS.map(s=>SUBJ_SHORT[s]), SUBJECTS.map(s=>SUBJ_COLOR[s]), {horizontal:true, suffix:'%'});
  if(C.dtSubject) C.dtSubject.options.plugins.tooltip.callbacks.afterLabel = ctx => {
    const e = C.dtSubject.$extra?.[ctx.dataIndex]; return e ? `${e.conv} of ${e.pairs} tested enrolled` : ''; };

  const dm = $('dtMonthlyChart');
  if(dm) C.dtMonthly = new Chart(dm, { type:'bar',
    data:{ labels:[], datasets:[
      { label:'Past DTs', data:[], backgroundColor:'#2563eb', borderRadius:5, maxBarThickness:22 },
      { label:'New enrollments', data:[], type:'line', borderColor:'#16a34a', borderWidth:2.5, pointRadius:2, tension:.35, fill:true, backgroundColor:areaFill('#16a34a',.18) }
    ]},
    options:(()=>{ const o = baseOpts(); o.plugins.legend = legendBottom();
      o.interaction = {mode:'index', intersect:false}; return o; })() });

  C.dropSubject = mkBar('dropSubjectChart', SUBJECTS.map(s=>SUBJ_SHORT[s]), SUBJECTS.map(s=>SUBJ_COLOR[s]));
  C.dropLevel = mkBar('dropLevelChart', [], '#dc2626');
  C.dropTrend = mkBar('dropTrendChart', [], '#dc2626');
  C.dropReason = mkBar('dropReasonChart', [], '#be185d', {horizontal:true});
  C.dropTenure = mkBar('dropTenureChart', TENURE_BUCKETS, '#0d9488');
  C.dropGender = mkBar('dropGenderChart', ['Male','Female'], GENDER_COLORS.slice(0,2), {suffix:'%', rate:true});
  C.dropGrade = mkBar('dropGradeChart', [], '#4682B4', {suffix:'%', rate:true});
  C.dropAge = mkBar('dropAgeChart', AGE_BANDS, '#7c3aed', {suffix:'%', rate:true});

  C.gender = mkDoughnut('genderChart', ['Male','Female','Not set'], GENDER_COLORS, 'students');
  C.age = mkBar('ageChart', AGE_BANDS, '#0d9488');
  C.grade = mkBar('gradeChart', GRADE_ORDER, '#2563eb');
  C.school = mkBar('schoolChart', [], CYCLE[0], {horizontal:true});

  const gr = $('gradeRateChart');
  if(gr) C.gradeRate = new Chart(gr, { type:'bar',
    data:{ labels:GRADE_ORDER, datasets:[
      { label:'Current students', data:[], backgroundColor:'#2563eb', borderRadius:5, maxBarThickness:26, yAxisID:'y' },
      { label:'Drop rate %', data:[], type:'line', borderColor:'#dc2626', borderWidth:2.5, pointRadius:3, pointBackgroundColor:'#dc2626', tension:.3, yAxisID:'y2' }
    ]},
    options:(()=>{ const o = baseOpts(); o.plugins.legend = legendBottom();
      o.interaction = {mode:'index', intersect:false};
      o.scales.y2 = {position:'right', min:0, max:100, grid:{display:false}, border:{display:false}, ticks:{color:'#dc2626', font:{size:10}, callback:v=>v+'%'}};
      return o; })() });

  C.sparkActive = mkSpark('kActiveSpark', '#2563eb');
  C.sparkNew = mkSpark('kNewSpark', '#16a34a');
  C.sparkDrops = mkSpark('kDropsSpark', '#dc2626');
  C.sparkConv = mkSpark('kConvSpark', '#7c3aed');
}
function setBar(chart, labels, values, colors){
  if(!chart) return;
  chart.data.labels = labels;
  chart.data.datasets[0].data = values;
  if(colors) chart.data.datasets[0].backgroundColor = colors;
  chart.update();
}
function setDoughnut(chart, values, total){
  if(!chart) return;
  chart.data.datasets[0].data = values;
  chart.options.plugins.centerText.text = String(total);
  chart.update();
}
function setSpark(chart, values){
  if(!chart) return;
  chart.data.labels = values.map((_,i)=>i);
  chart.data.datasets[0].data = values;
  chart.update('none');
}

/* ---------------- render ---------------- */
function renderAll(){
  if(!M) return;
  const m = M;
  $('csCenterName').textContent = CENTER_NAME;

  animateNumber($('kActive'), m.kpi.active); setDelta($('kActiveD'), m.kpi.activeD);
  animateNumber($('kSubjects'), m.kpi.subjects); setDelta($('kSubjectsD'), m.kpi.subjectsD);
  animateNumber($('kNew'), m.kpi.newM); setDelta($('kNewD'), m.kpi.newD);
  animateNumber($('kDrops'), m.kpi.dropsM); setDelta($('kDropsD'), m.kpi.dropsD, true);
  animateNumber($('kPaused'), m.kpi.paused); setDelta($('kPausedD'), m.kpi.pausedD, true);
  renderConvCard();
  setSpark(C.sparkActive, m.total); setSpark(C.sparkNew, m.newStudentsArr);
  setSpark(C.sparkDrops, m.dropArr);

    const ph = m.progressHealth;
    const phVals = [ph.new, ph.onPace, ph.slowing, ph.stalled, ph.noReports];
    const phJudged = ph.onPace + ph.slowing + ph.stalled;
    if(C.progress){
    C.progress.options.plugins.centerText.sub = phJudged > 0 ? 'on pace' : 'subjects';
    setDoughnut(C.progress, phVals, phJudged > 0 ? Math.round(pct(ph.onPace, phJudged)) + '%' : String(phVals.reduce((a,b)=>a+b,0)));
    }
    const phNote = $('progressNote');
    if(phNote) phNote.textContent = ph.stalled > 0
    ? `⚠️ ${ph.stalled} subject${ph.stalled===1?'':'s'} stalled 6+ months — review pace or workload with parents.`
    : ph.slowing > 0
    ? `👀 ${ph.slowing} subject${ph.slowing===1?'':'s'} slowing — 3–5 months since their last level-up.`
    : phJudged > 0
    ? '🎉 Every established subject levelled up within the last 2 months.'
    : 'Log monthly reports on the student form to unlock progress tracking.';
  setDoughnut(C.subject, SUBJECTS.map(s=>m.currentSubj[s]), Object.values(m.currentSubj).reduce((a,b)=>a+b,0));
  setDoughnut(C.mode, [m.modeCounts['Paper'], m.modeCounts['Kumon Connect']], m.modeCounts['Paper']+m.modeCounts['Kumon Connect']);

  $('insightsList').innerHTML = m.insights.slice(0,7).map(i =>
    `<li><button data-go="${i.go}"><span class="ins-ico">${i.ico}</span><span>${esc(i.txt)}</span></button></li>`).join('');

  if(C.headcount){
    const stacked = state.trendMode === 'stacked';
    C.headcount.data.labels = m.labels;
    C.headcount.data.datasets.forEach(ds => {
      if(ds.label === 'Total'){ ds.data = m.total; ds.hidden = stacked; }
      else {
        ds.data = m.perSubj[ds.label];
        ds.hidden = state.subject !== 'all' && ds.label !== state.subject;
        ds.fill = stacked ? 'origin' : false;
        ds.backgroundColor = stacked ? hexRgba(SUBJ_COLOR[ds.label], .55) : areaFill(SUBJ_COLOR[ds.label], .25);
      }
    });
    C.headcount.options.scales.y.stacked = stacked;
    C.headcount.update();
  }
  if(C.intake){
    C.intake.data.labels = m.labels;
    C.intake.data.datasets[0].data = m.newArr;
    C.intake.data.datasets[1].data = m.dropArr;
    C.intake.data.datasets[2].data = m.pauseStartArr;
    C.intake.data.datasets[3].data = m.completesArr;
    C.intake.data.datasets[4].data = m.newArr.map((v,i)=>v - m.dropArr[i]);
    C.intake.update();
  }
  if(C.levelUp){
    C.levelUp.data.labels = m.labels;
    C.levelUp.data.datasets[0].data = m.levelUps;
    C.levelUp.data.datasets[1].data = m.atsArr;
    C.levelUp.update();
  }
  renderMonthlyTable();

  // DT
  const fMax = Math.max(m.dt.inquiriesEver, 1);
  const steps = [
    ['f1','Inquiries / interest', m.dt.inquiriesEver],
    ['f2','DT taken (unique student·subject)', m.dt.pairs],
    ['f3','Enrolled after DT', m.dt.converted]
  ];
  let fh = '';
  steps.forEach(([cls,label,val],i) => {
    if(i>0){ const prev = steps[i-1][2]; fh += `<div class="funnel-arrow">↳ ${prev>0?Math.round(pct(val,prev)):0}% proceed</div>`; }
    fh += `<div class="funnel-step ${cls}" style="width:${Math.max(22, pct(val,fMax))}%"><span>${label}</span><b>${val}</b></div>`;
  });
  $('dtFunnel').innerHTML = fh;
  animateNumber($('dtTotal'), m.dt.conducted);
  animateNumber($('dtUpcoming'), m.dt.upcoming);
  animateNumber($('dtNoResults'), m.dt.noResults);
  animateNumber($('dtConverted'), m.dt.converted);
  $('dtConvRate').textContent = Math.round(m.dt.rate) + '%';
  $('dtMedianDays').textContent = m.dt.medianDays != null ? Math.round(m.dt.medianDays) + 'd' : '—';
  $('dtSuggest').textContent = m.dt.suggest.n > 0 ? Math.round(m.dt.suggest.pct) + '%' : '—';
  if(C.dtSubject){
    C.dtSubject.$extra = SUBJECTS.map(s => ({ pairs:m.dt.bySubj[s].pairs, conv:m.dt.bySubj[s].conv }));
    setBar(C.dtSubject, SUBJECTS.map(s=>SUBJ_SHORT[s]), SUBJECTS.map(s=>Math.round(pct(m.dt.bySubj[s].conv, m.dt.bySubj[s].pairs))));
  }
  if(C.dtMonthly){
    C.dtMonthly.data.labels = m.labels;
    C.dtMonthly.data.datasets[0].data = m.dt.monthly.map(x=>x.dt);
    C.dtMonthly.data.datasets[1].data = m.dt.monthly.map(x=>x.enr);
    C.dtMonthly.update();
  }
  renderPending();

  // drops
  const d = m.drops, modeColor = d.mode==='drop' ? '#dc2626' : '#d97706';
  $('dTotalLbl').textContent = d.mode==='drop' ? 'Dropped subjects' : 'Pause events';
  animateNumber($('dTotal'), d.total);
  $('dRate').textContent = Math.round(d.rate) + '%';
  $('dTenure').textContent = d.medianTenure != null ? d.medianTenure + ' mo' : '—';
  $('dTopLevel').textContent = d.topLevel ? `${d.topLevel[0]} (${d.topLevel[1]})` : '—';
  $('dCalled').textContent = d.total > 0 ? Math.round(pct(d.exit.called, d.total)) + '%' : '—';
  $('dContact').textContent = d.exit.dated > 0 ? Math.round(pct(d.exit.contact, d.exit.dated)) + '%' : '—';
  const topReason = d.reasons[0];
  $('dropInsight').innerHTML = d.total === 0
    ? `No ${d.mode} records in this filter yet.`
    : `📌 <span>${d.total} ${d.mode} record${d.total===1?'':'s'}${state.subject!=='all' ? ' for '+esc(state.subject) : ''}. ${d.topLevel ? `Level <span class="level-badge">${esc(d.topLevel[0])}</span> leads with ${d.topLevel[1]}.` : ''} ${topReason ? `Top reason: “${esc(topReason.label)}” (${topReason.count}).` : ''} ${d.peakMonth ? `Peak month: ${d.peakMonth}.` : ''}</span>`;
  setBar(C.dropSubject, SUBJECTS.map(s=>SUBJ_SHORT[s]), SUBJECTS.map(s=>d.bySubj[s]||0));
  setBar(C.dropLevel, d.levelLabels, d.levelVals, modeColor);
  setBar(C.dropTrend, m.labels, d.monthly, modeColor);
  const top8 = d.reasons.slice(0,8);
  setBar(C.dropReason, top8.map(r=>r.label.length>26 ? r.label.slice(0,25)+'…' : r.label), top8.map(r=>r.count));
  setBar(C.dropTenure, TENURE_BUCKETS, d.tenureBuckets);
  if(C.dropGender){ C.dropGender.$extra = d.genderRate; setBar(C.dropGender, ['Male','Female'], d.genderRate.map(x=>+x.rate.toFixed(1))); }
  if(C.dropGrade){ C.dropGrade.$extra = d.gradeRate; setBar(C.dropGrade, d.gradeRateKeys, d.gradeRate.map(x=>+x.rate.toFixed(1))); }
  if(C.dropAge){ C.dropAge.$extra = d.ageRate; setBar(C.dropAge, AGE_BANDS, d.ageRate.map(x=>+x.rate.toFixed(1))); }
  $('reasonList').innerHTML = d.reasons.length
    ? d.reasons.map(r=>`<li><span>${esc(r.label)}</span><span>${r.count} · ${Math.round(pct(r.count,d.total))}%</span></li>`).join('')
    : '<li><span>No reasons recorded</span><span>0</span></li>';
  renderExitBars();

  // demographics
  const g = m.demo;
  $('demoNote').textContent = state.scope==='current' ? 'Averages across current students (at least one active subject).'
    : state.scope==='dropped' ? 'Dropped students only — age is measured at their earliest drop month.'
    : 'All students ever enrolled, including those who later dropped (subject records required).';
  $('gAvgAge').textContent = g.avgAge != null ? g.avgAge.toFixed(1) : '—';
  $('gMedAge').textContent = g.medAge != null ? g.medAge.toFixed(1) : '—';
  $('gAvgGrade').textContent = g.avgGrade ?? '—';
  $('gSplit').textContent = g.split;
  setDoughnut(C.gender, [g.gCounts.Male, g.gCounts.Female, g.gCounts['Not set']], g.count);
  const bandVals = AGE_BANDS.map(()=>0);
  g.ages.forEach(a => bandVals[ageBand(a)]++);
  setBar(C.age, AGE_BANDS, bandVals);
  setBar(C.grade, GRADE_ORDER, g.gradeCounts);

  // schools & grades
  if(C.school){
    const top = [...m.schools].sort((a,b)=>b.current-a.current).slice(0,10);
    setBar(C.school, top.map(r=>r.school.length>30 ? r.school.slice(0,29)+'…' : r.school), top.map(r=>r.current), top.map((_,i)=>CYCLE[i%CYCLE.length]));
  }
  renderHeatmap(); renderSchoolTable();
  if(C.gradeRate){
    C.gradeRate.data.datasets[0].data = m.gradeModel.cur;
    C.gradeRate.data.datasets[1].data = m.gradeModel.rate.map(v=>+v.toFixed(1));
    C.gradeRate.update();
  }

  renderActions();

  $('dataNote').textContent = `Source: centers/${centerId || '(none)'}/students + followUps · ${RAW_COUNT} records, ${m.recordCount} with subjects${state.demo ? ' · SAMPLE DATA' : ''}`;
  $('genTime').textContent = 'Generated ' + new Date().toLocaleString();
}
function renderMonthlyTable(){
  const m = M; if(!m) return;
  let h = '<thead><tr><th>Month</th><th class="num">Total</th>' +
    SUBJECTS.map(s=>`<th class="num">${SUBJ_SHORT[s]}</th>`).join('') +
    '<th class="num">Paused</th><th class="num">New</th><th class="num">Drops</th><th class="num">Completes</th></tr></thead><tbody>';
  for(let i=m.labels.length-1; i>=0; i--){
    h += `<tr><td>${m.labels[i]}</td><td class="num">${m.total[i]}</td>` +
      SUBJECTS.map(s=>`<td class="num">${m.perSubj[s][i]}</td>`).join('') +
      `<td class="num">${m.pausedArr[i]}</td><td class="num">${m.newArr[i]}</td><td class="num">${m.dropArr[i]}</td><td class="num">${m.completesArr[i]}</td></tr>`;
  }
  $('monthlyTable').innerHTML = h + '</tbody>';
}
function renderConvCard(){
  const m = M; if(!m) return;
  const sel = $('convMonthSelect');
  const keys = m.dt.monthKeys;
  if(sel){
    const html = '<option value="all">All time</option>' + keys.map(mi=>`<option value="${mi}">${miLabel(mi)}</option>`).join('');
    if(sel.innerHTML !== html) sel.innerHTML = html;
    if(state.convMonth !== 'all' && !keys.includes(+state.convMonth)) state.convMonth = 'all';
    sel.value = state.convMonth;
  }
  const isAll = state.convMonth === 'all';
  const mi = +state.convMonth;
  const bucket = isAll ? { pairs:m.dt.pairs, conv:m.dt.converted } : (m.dt.monthMap.get(mi) || { pairs:0, conv:0 });
  const valEl = $('kConv');
  if(bucket.pairs > 0){ animateNumber(valEl, Math.round(pct(bucket.conv, bucket.pairs)), {suffix:'%'}); }
  else { valEl.dataset.v = '0'; valEl.textContent = '—'; }
  $('kConvSub').textContent = `${bucket.conv}/${bucket.pairs} tested · ${isAll ? 'all time' : miLabelLong(mi)}`;
  const order = ['all', ...keys];
  const pos = order.indexOf(isAll ? 'all' : mi);
  const prev = $('convPrevBtn'), next = $('convNextBtn');
  if(prev) prev.disabled = pos >= order.length - 1;
  if(next) next.disabled = pos <= 0;
  const chart = C.sparkConv;
  if(chart){
    const data = m.dt.convMonthly;
    const ds = chart.data.datasets[0];
    chart.data.labels = data.map((_,i)=>i);
    ds.data = data;
    const selIdx = !isAll ? (mi - m.start) : -1;
    ds.pointRadius = data.map((_,i)=> i === selIdx ? 3 : 0);
    ds.pointBackgroundColor = '#7c3aed';
    chart.update('none');
  }
}
function stepConvMonth(dir){
  if(!M) return;
  const order = ['all', ...M.dt.monthKeys];
  const cur = state.convMonth === 'all' ? 'all' : +state.convMonth;
  let pos = order.indexOf(cur); if(pos < 0) pos = 0;
  const np = Math.min(order.length - 1, Math.max(0, pos + dir));
  state.convMonth = String(order[np]);
  renderConvCard();
}
function renderPending(){
  const rows = M.dt.pending, body = $('dtPendingBody');
  $('dtPendingEmpty').classList.toggle('hidden', rows.length>0);
  body.innerHTML = rows.slice(0,12).map(p => {
    const link = state.demo ? '' : `<a class="a-link" href="student-form.html?id=${encodeURIComponent(p.student.id)}&returnUrl=center-stats.html">Open →</a>`;
    const chip = p.hasResults ? '<span class="type-chip tested">🧪 Tested</span>' : '<span class="type-chip noresults">📝 No results</span>';
    return `<tr><td>${esc(displayName(p.student))}</td><td><span class="subject-chip">${esc(SUBJ_SHORT[p.subject]||p.subject)}</span></td><td>${p.lastDT}</td><td>${chip}</td><td class="num">${p.wait}d</td><td>${link}</td></tr>`;
  }).join('');
  $('dtPendingMore').textContent = rows.length>12 ? `+ ${rows.length-12} more waiting inquiries not shown.` : '';
}
function renderExitBars(){
  const d = M.drops, n = d.total;
  const rows = [
    ['Parents called', d.exit.called, 'called'],
    ['Confirmed in Drop Book', d.exit.confirmed, 'confirmed'],
    ['Autopay exit form', d.exit.autopay, 'autopay']
  ];
  $('exitBars').innerHTML = rows.map(([label, v, cls]) => {
    const p = n > 0 ? Math.round(pct(v, n)) : 0;
    return `<div class="exit-row"><span class="ex-label">${label}</span><span class="exit-track"><span class="exit-fill ${cls}" style="width:${p}%"></span></span><span class="ex-val">${v}/${n} · ${p}%</span></div>`;
  }).join('');
  $('retentionWins').innerHTML = `🛟 Retention wins: <b>${d.saved}</b> cancelled request${d.saved===1?'':'s'} (saved) · <b>${d.winbacks}</b> resumed student${d.winbacks===1?'':'s'} (win-backs)`;
}
function renderHeatmap(){
  const top = [...M.schools].sort((a,b)=>b.current-a.current).slice(0,12);
  const keys = ['math','efl','erp','cht','chis'];
  const max = Math.max(1, ...top.flatMap(r=>keys.map(k=>r[k])));
  let h = '<table class="heat"><thead><tr><th>School</th>' + SUBJECTS.map(s=>`<th>${SUBJ_SHORT[s]}</th>`).join('') + '</tr></thead><tbody>';
  top.forEach(r => {
    h += `<tr><td title="${esc(r.school)}">${esc(r.school)}</td>` + keys.map((k,i) => {
      const v = r[k], a = v/max;
      const bg = hexRgba(SUBJ_COLOR[SUBJECTS[i]], .06 + .8*a);
      const col = a > .55 ? '#fff' : '#0f2740';
      return `<td style="background:${bg};color:${col}" title="${esc(r.school)} — ${SUBJECTS[i]}: ${v}">${v||'·'}</td>`;
    }).join('') + '</tr>';
  });
  $('schoolHeatmap').innerHTML = h + '</tbody></table>';
}
function renderSchoolTable(){
  const q = schoolQuery.toLowerCase();
  let rows = M.schools.filter(r => !q || r.school.toLowerCase().includes(q));
  const {key, dir} = schoolSort;
  rows.sort((a,b) => key==='school' ? dir*a.school.localeCompare(b.school) : dir*((a[key]||0)-(b[key]||0)));
  $('schoolTableBody').innerHTML = rows.map(r =>
    `<tr><td>${esc(r.school)}</td><td class="num">${r.current}</td><td class="num">${r.ever}</td><td class="num">${r.dropped}</td>` +
    `<td class="num"><span class="rate-cell"><span class="rate-bar"><i style="width:${Math.min(100,r.rate)}%"></i></span>${Math.round(r.rate)}%</span></td>` +
    `<td class="num">${r.math}</td><td class="num">${r.efl}</td><td class="num">${r.erp}</td><td class="num">${r.cht}</td><td class="num">${r.chis}</td></tr>`).join('')
    || '<tr><td colspan="10" style="text-align:center;color:#64748b;padding:1rem">No schools match your search.</td></tr>';
  document.querySelectorAll('#schoolTable th[data-key]').forEach(th => {
    const base = th.textContent.replace(/ [▲▼]$/,'');
    th.textContent = base + (th.dataset.key===key ? (dir<0?' ▼':' ▲') : '');
  });
}
function renderActions(){
  const linkFor = st => state.demo ? '' : `<a class="a-link" href="student-form.html?id=${encodeURIComponent(st.id)}&returnUrl=center-stats.html">Open →</a>`;
  const chip = sub => `<span class="subject-chip">${esc(SUBJ_SHORT[sub.name]||sub.name)}</span><span class="level-badge">${esc(sub.currentLevel||sub.startLevel||'—')}</span>`;
  const mk = (items, whenFn) => items.slice(0,12).map(x =>
    `<li><span class="a-name">${esc(displayName(x.st))}</span>${chip(x.sub)}<span class="a-when">${whenFn(x)}</span>${linkFor(x.st)}</li>`).join('');
  $('returningList').innerHTML = mk(M.returning, x=>miLabelLong(x.to));
  $('returningEmpty').classList.toggle('hidden', M.returning.length>0);
  $('stalledList').innerHTML = mk(M.stalled, x=>x.months+' mo paused');
  $('stalledEmpty').classList.toggle('hidden', M.stalled.length>0);
  $('uncalledList').innerHTML = M.uncalled.slice(0,12).map(x =>
    `<li><span class="a-name">${esc(displayName(x.st))}</span>${chip(x.sub)}
      <span class="type-chip ${x.type}">${x.type==='drop'?'Drop':'Pause'}</span>
      <span class="a-reason" title="${esc(x.reason||'')}">${esc(x.reason||'No reason')}</span>
      <span class="a-when bad">${x.mi!=null?miLabelLong(x.mi):'Undated'}</span>${linkFor(x.st)}</li>`).join('');
  $('uncalledEmpty').classList.toggle('hidden', M.uncalled.length>0);
  $('upcomingList').innerHTML = M.upcomingReq.slice(0,12).map(x =>
    `<li><span class="a-name">${esc(displayName(x.st))}</span>${chip(x.sub)}
      <span class="type-chip ${x.due?'due':x.type}">${x.due?'Due now':x.type==='drop'?'Drop':'Pause'}</span>
      <span class="a-reason" title="${esc(x.reason)}">${esc(x.reason||'No reason')}</span>
      <span class="a-when ${x.called?'ok':''}">${miLabelLong(x.mi)} · ${x.called?'📞 called':'✖ not called'}</span>${linkFor(x.st)}</li>`).join('');
  $('upcomingEmpty').classList.toggle('hidden', M.upcomingReq.length>0);
}

/* ---------------- load / refresh ---------------- */
async function loadAndRender(){
  try{
    if(state.demo) genDemo();
    else {
      if(!centerId){ showEmpty('No center selected','Pick a center from the Centers page first, or preview with sample data.'); return; }
      await fetchReal();
    }
    if(RAW.length === 0){ showEmpty('No student records yet','Add or import students on the Students page, or preview this dashboard with sample data.'); return; }
    $('emptyState').classList.add('hidden');
    $('csMain').classList.remove('hidden');
    $('csToolbar').classList.remove('hidden');
    $('demoBanner').classList.toggle('hidden', !state.demo);
    M = computeModel();
    renderAll();
    measureStack();
    $('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const first = $('overview'); if(first) first.classList.add('in');
  }catch(err){
    console.error('Center Statistics load failed:', err);
    toast('❌ Could not load data: ' + (err.message || err), true);
    showEmpty('Could not load data','Check your connection and press ⟳ to retry, or preview with sample data.');
  }
}
function showEmpty(title, text){
  $('csMain').classList.add('hidden');
  $('csToolbar').classList.add('hidden');
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
  $('emptyState').classList.remove('hidden');
  $('demoBanner').classList.toggle('hidden', !state.demo);
}
function rerender(){ if(RAW.length){ M = computeModel(); renderAll(); } }

/* ---------------- layout helpers ---------------- */
function measureStack(){
  const h = $('csHeader'), t = $('csToolbar');
  const hh = h ? h.offsetHeight : 64;
  const th = t && !t.classList.contains('hidden') ? t.offsetHeight : 0;
  document.documentElement.style.setProperty('--header-h', hh + 'px');
  document.documentElement.style.setProperty('--stack-h', (hh + th) + 'px');
}
function initScrollSpy(){
  const pills = [...document.querySelectorAll('#navPills .pill')];
  const setActive = id => pills.forEach(p => p.classList.toggle('active', p.dataset.target === id));
  pills.forEach(p => p.addEventListener('click', () => {
    setActive(p.dataset.target);
    document.getElementById(p.dataset.target)?.scrollIntoView({behavior: reducedMotion ? 'auto' : 'smooth'});
  }));
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if(e.isIntersecting) setActive(e.target.id); });
  }, {rootMargin:'-40% 0px -55% 0px'});
  document.querySelectorAll('#csMain section[id]').forEach(s => io.observe(s));
}
function initReveal(){
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
  }, {threshold:.08});
  document.querySelectorAll('.reveal').forEach(s => io.observe(s));
}

/* ---------------- events ---------------- */
function wireEvents(){
  on('rangeSelect','change', e => { state.range = +e.target.value; rerender(); });
  on('subjectSelect','change', e => { state.subject = e.target.value; rerender(); });
  on('convMonthSelect','change', e => { state.convMonth = e.target.value; renderConvCard(); });
  on('convPrevBtn','click', () => stepConvMonth(1));
  on('convNextBtn','click', () => stepConvMonth(-1));
  const seg = (id, attr, fn) => { const el = $(id); if(!el) return;
    el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); fn(b.dataset[attr]);
    })); };
  seg('trendModeSeg','mode', v => { state.trendMode = v; rerender(); });
  seg('dropModeSeg','mode', v => { state.dropMode = v; rerender(); });
  seg('scopeSeg','scope', v => { state.scope = v; rerender(); });
  on('schoolSearch','input', e => { schoolQuery = e.target.value.trim(); if(M) renderSchoolTable(); });
  document.querySelectorAll('#schoolTable th[data-key]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.key;
    if(schoolSort.key === k) schoolSort.dir *= -1;
    else schoolSort = { key:k, dir: k==='school' ? 1 : -1 };
    if(M) renderSchoolTable();
  }));
  const flipDemo = () => {
    state.demo = !state.demo;
    $('demoToggle').setAttribute('aria-pressed', String(state.demo));
    loadAndRender();
    toast(state.demo ? '🧪 Sample data on' : '📡 Back to live data');
  };
  on('demoToggle','click', flipDemo);
  on('emptyDemoBtn','click', () => { if(!state.demo) flipDemo(); });
  on('refreshBtn','click', async () => {
    const b = $('refreshBtn'); b.classList.add('spinning');
    await loadAndRender();
    setTimeout(()=>b.classList.remove('spinning'), 700);
    toast('⟳ Data refreshed');
  });
  on('printBtn','click', () => window.print());
  document.addEventListener('click', e => {
    const go = e.target.closest('[data-go]');
    if(go) document.getElementById(go.dataset.go)?.scrollIntoView({behavior: reducedMotion ? 'auto' : 'smooth'});
  });
  on('growthCsv','click', () => { if(!M) return;
    const rows = [['Month','Total students',...SUBJECTS,'Paused subjects','New subjects','Drops','Completes','Level-ups','ATs']];
    M.labels.forEach((l,i) => rows.push([l, M.total[i], ...SUBJECTS.map(s=>M.perSubj[s][i]), M.pausedArr[i], M.newArr[i], M.dropArr[i], M.completesArr[i], M.levelUps[i], M.atsArr[i]]));
    downloadCSV('center-monthly-headcount.csv', rows); });
  on('schoolCsv','click', () => { if(!M) return;
    const rows = [['School','Current','Ever enrolled','Dropped','Drop rate %','Math','EFL','ERP','Chinese (Trad)','Chinese (Simp)']];
    [...M.schools].sort((a,b)=>b.current-a.current).forEach(r => rows.push([r.school,r.current,r.ever,r.dropped,r.rate.toFixed(1),r.math,r.efl,r.erp,r.cht,r.chis]));
    downloadCSV('center-schools.csv', rows); });
  on('gradeCsv','click', () => { if(!M) return;
    const rows = [['Grade','Current','Ever enrolled','Dropped','Drop rate %']];
    GRADE_ORDER.forEach((g,i) => rows.push([g, M.gradeModel.cur[i], M.gradeModel.ever[i], M.gradeModel.drop[i], M.gradeModel.rate[i].toFixed(1)]));
    downloadCSV('center-grades.csv', rows); });
  on('reasonCsv','click', () => { if(!M) return;
    const rows = [[state.dropMode==='drop'?'Drop reason':'Pause reason','Count','Share %']];
    M.drops.reasons.forEach(r => rows.push([r.label, r.count, pct(r.count, M.drops.total).toFixed(1)]));
    downloadCSV(`center-${state.dropMode}-reasons.csv`, rows); });
  window.addEventListener('resize', measureStack);
}

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  const authed = requireAuth();
  if(!authed) return;
  wireEvents();
  const allowed = await checkPermission();
  if(!allowed){
    $('page-loader').classList.add('hidden');
    $('accessDenied').classList.remove('hidden');
    return;
  }
  await ensureChartLib();
  createCharts();
  await loadAndRender();
  measureStack();
  initScrollSpy();
  initReveal();
  $('page-loader').classList.add('hidden');
});