// =====================================================
// payslip.js — Pay Slip Generator (Kumon DB)
// =====================================================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getDatabase, ref, get, set, remove, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { firebaseConfig } from './auth.js';

// ✅ Bulletproof Firebase initialization (prevents the no-app error)
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const AUTHORIZED_EMAIL = "kumonchamps@gmail.com";
const FIXED_POSITION = "Teacher Assistant";   // 👈 always Teacher Assistant per policy

// Mirrors EMPLOYER_CENTERS in employees.js (+ known contact numbers)
const EMPLOYER_CENTERS = {
  "Centro de Educação Kumon Champs":               { contact: "",         english: "Ave Do Conselheiro Ferreira, De Almeida No. 113B R/C, C, Edf Ho Lan Fa Un" },
  "Centro de Educação Kumon Taipa Pac Tat":        { contact: "28823866", english: "Rua De Viseu N˚ 120, Fast Garden, r/c, M, Taipa" },
  "Centro de Educação Kumon Tap Siac":             { contact: "",         english: "Rua Afonso de Albuquerque, No. 22B RC-ARC Edif. Choi Lai" },
  "Centro de Educação Kumon Taipa Mei Keng":       { contact: "",         english: "NA TAIPA, ESTRADA GOVERNADOR ALBANO DE OLIVEIRA N° 24, MEI KENG FA UN RÉ-DO-CHÃO AU" },
  "Centro de Educação Long Kei":                   { contact: "",         english: "" },
  "Centro de Educação Kei Hok Fong":               { contact: "",         english: "Estrada Governador Albano de Oliveira, n.º20, Mei Keng Fa Un, r/c, AO, Taipa" },
  "Centro de Educação Oi Hok Fong 2 (EL Taipa)":   { contact: "",         english: "Avenida De Guimaraes 47, Mei Keng Fa Un, Res-Do-Chao R, Taipa, Macau" },
  "Centro de Educação Delight Learning (EL Macau)":{ contact: "",         english: "Macau, Rua Do Padre Antonio Roliz Nos 14B-14C, Kei Cheong Res-Do-Chao A" },
  "Centro de Educação Wai Si (Wise Kids)":         { contact: "",         english: "" }
};

let employees = {};
let payslips = {};
let initialized = false;

const $ = (id) => document.getElementById(id);
const val = (id) => ($(id)?.value ?? '').trim();
const esc = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const sanitizeFile = (s) => String(s || '').replace(/[^a-z0-9_\-]+/gi, '_');

function getEmpPositions(emp) {
  if (!emp) return [];
  if (Array.isArray(emp.positions)) return emp.positions.filter(Boolean);
  if (emp.position) return [emp.position];
  return [];
}

/* ============ AUTH (same rules as employees.js) ============ */
function grantAccess() {
  $('accessDenied').classList.add('hidden');
  $('mainContent').classList.remove('hidden');
}
function showDenied(html) {
  $('mainContent').classList.add('hidden');
  $('accessDenied').classList.remove('hidden');
  $('accessDenied').querySelector('p').innerHTML = html;
}
async function checkAuthorization(user) {
  if (!user) { showDenied('No user session. Please log in first.'); return false; }
  if ((user.email || '').toLowerCase() === AUTHORIZED_EMAIL) { grantAccess(); return true; }
  try {
    const uSnap = await get(ref(db, `users/${user.uid}`));
    const pos = getEmpPositions(uSnap.val() || {}).map(p => p.trim().toLowerCase());
    if (pos.includes('manager') || pos.includes('master admin')) { grantAccess(); return true; }
    const eSnap = await get(ref(db, 'employees'));
    const match = Object.values(eSnap.val() || {}).find(e => (e.email || '').toLowerCase() === (user.email || '').toLowerCase());
    if (match) {
      const ep = getEmpPositions(match).map(p => p.trim().toLowerCase());
      if (ep.includes('manager') || ep.includes('master admin')) { grantAccess(); return true; }
    }
  } catch (err) { console.error('Auth check error:', err); }
  showDenied(`<strong>${esc(user.email)}</strong> is not authorized to access this page.`);
  return false;
}

onAuthStateChanged(auth, async (user) => {
  if (await checkAuthorization(user)) initApp();
});
$('backToDashboard').addEventListener('click', () => window.location.href = 'centers.html');

/* ============ DATE / MONEY HELPERS ============ */
function periodFromMonth(monthStr) {
  if (!monthStr) return { from: '', to: '', monthName: '' };
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const monthName = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' });
  return { from: `1/${m}/${y}`, to: `${last}/${m}/${y}`, monthName };
}
function dmy(iso) { // YYYY-MM-DD -> D/M/YYYY (like the official form)
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${+d}/${+m}/${+y}`;
}
function formatMoney(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '';
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

/* ============ FORM ROW BUILDERS ============ */
function remRowEl(r = {}) {
  const div = document.createElement('div');
  div.className = 'row-line' + (r.basic ? ' basic' : '');
  div.innerHTML = `
    <input type="text" class="r-label" value="${esc(r.label || '')}" placeholder="Item (e.g. Overtime, Allowance)" ${r.basic ? 'readonly' : ''}>
    <input type="number" class="r-amount" value="${esc(r.amount ?? '')}" min="0" step="any" placeholder="Amount">
    <button type="button" class="del-row danger" ${r.basic ? 'style="visibility:hidden"' : ''}>✕</button>`;
  return div;
}
function dedRowEl(r = {}) {
  const div = document.createElement('div');
  div.className = 'row-line';
  div.innerHTML = `
    <input type="text" class="r-label" value="${esc(r.label || '')}" placeholder="Deduction (e.g. Social Security, Absence)">
    <input type="number" class="r-amount" value="${esc(r.amount ?? '')}" min="0" step="any" placeholder="Amount">
    <button type="button" class="del-row danger">✕</button>`;
  return div;
}
function collectRows(containerId) {
  return [...$(containerId).querySelectorAll('.row-line')].map(div => ({
    basic: div.classList.contains('basic'),
    label: div.querySelector('.r-label').value.trim(),
    amount: div.querySelector('.r-amount').value
  }));
}
function sumRows(rows) {
  return rows.reduce((t, r) => t + (parseFloat(r.amount) || 0), 0);
}

/* ============ COLLECT FULL STATE FROM FORM ============ */
function collectState() {
  const period = periodFromMonth(val('payMonth'));
  return {
    employer: { name: val('employerName'), contact: val('employerContact'), address: val('employerAddress') },
    worker: {
      name: val('workerName'),
      position: FIXED_POSITION,
      docType: $('idDocType').value,
      docNo: val('idDocNo'),
      docIssueRaw: $('idDocIssue').value,
      docIssue: dmy($('idDocIssue').value),
      otherNumbers: val('otherNumbers')
    },
    period,
    remuneration: collectRows('remRows'),
    deductions: collectRows('dedRows')
  };
}

/* ============ PAYSLIP HTML (used for preview, Word & print) ============ */
function buildPayslipHTML(s) {
  const B  = 'border:1px solid #000;padding:6px 10px;font-size:13pt;';
  const G  = B + 'font-weight:bold;background:#DFDFDF;text-align:center;vertical-align:middle;';
  const H  = B + 'font-weight:bold;text-align:center;';
  const ul = (v, min = 110) => `<span style="display:inline-block;min-width:${min}px;border-bottom:1px solid #000;text-align:center;padding:0 8px;">${esc(v)}</span>`;
  const T  = '<table cellspacing="0" style="width:100%;border-collapse:collapse;font-family:\'Times New Roman\',Times,serif;margin-bottom:16px;">';

  const rem = [...s.remuneration]; while (rem.length < 3) rem.push({ label: '', amount: '' });
  const ded = [...s.deductions];   while (ded.length < 3) ded.push({ label: '', amount: '' });
  const remTotal = sumRows(rem), dedTotal = sumRows(ded);
  const net = remTotal - dedTotal;

  const remHtml = rem.map((r, i) => {
    const has = r.label || String(r.amount) !== '';
    return `<tr><td style="${B}">${has ? `(${i + 1}) ${esc(r.label)}` : ''}</td><td style="${B}width:26%;">${formatMoney(r.amount)}</td></tr>`;
  }).join('');
  const dedHtml = ded.map((r, i) =>
    `<tr><td style="${B}">(${i + 1}) ${esc(r.label)}</td><td style="${B}width:26%;">${formatMoney(r.amount)}</td></tr>`
  ).join('');

  return `
  <h2 style="text-align:center;font-family:'Times New Roman',Times,serif;font-size:17pt;font-weight:bold;letter-spacing:1px;margin:0 0 20px;">PAY SLIP</h2>

  ${T}
    <tr>
      <td rowspan="2" style="${G}width:23%;">Employer's Information</td>
      <td style="${B}width:42%;">Name: ${esc(s.employer.name)}</td>
      <td style="${B}">Contact No.: ${esc(s.employer.contact)}</td>
    </tr>
    <tr><td colspan="2" style="${B}">Office Address: ${esc(s.employer.address)}</td></tr>
    <tr>
      <td rowspan="3" style="${G}">Non-resident Worker's Information</td>
      <td style="${B}">Name: ${esc(s.worker.name)}</td>
      <td style="${B}">Position: ${esc(s.worker.position)}</td>
    </tr>
    <tr><td colspan="2" style="${B}">Type of Identity Document: ${esc(s.worker.docType)}<br>No. of Identity Document: ${esc(s.worker.docNo)}<br>Date of Issue: ${esc(s.worker.docIssue)}</td></tr>
    <tr><td colspan="2" style="${B}">Other Numbers Given to Non-resident Worker According to Law: ${ul(s.worker.otherNumbers, 180)}</td></tr>
    <tr>
      <td style="${G}">Period Corresponding to Remuneration Received</td>
      <td colspan="2" style="${B}height:58px;">From &nbsp;${ul(s.period.from, 100)}&nbsp; (Day/Month/Year) to &nbsp;${ul(s.period.to, 100)}&nbsp; (Day/Month/Year)</td>
    </tr>
  </table>

  ${T}
    <tr><td rowspan="${rem.length + 1}" style="${G}width:23%;">Remuneration</td><td style="${H}">Item</td><td style="${H}width:26%;">Amount</td></tr>
    ${remHtml}
  </table>
  <div style="text-align:center;font-family:'Times New Roman',serif;font-size:13pt;font-weight:bold;margin:-6px 0 16px;">Total Remunerations: ${formatMoney(remTotal) || '0'}</div>

  ${T}
    <tr><td rowspan="${ded.length + 1}" style="${G}width:23%;">Deduction</td><td style="${H}">Item</td><td style="${H}width:26%;">Amount</td></tr>
    ${dedHtml}
  </table>
  <div style="text-align:center;font-family:'Times New Roman',serif;font-size:13pt;font-weight:bold;margin:-6px 0 16px;">Total Deductions: ${formatMoney(dedTotal) || '0'}</div>

  ${T}
    <tr><td style="${H}background:#A6A6A6;width:33%;">Gross Income</td><td style="${H}background:#A6A6A6;width:34%;">Total Deductions</td><td style="${H}background:#A6A6A6;">Net Income</td></tr>
    <tr><td style="${B}">${formatMoney(remTotal) || '0'}</td><td style="${B}">${formatMoney(dedTotal) || '0'}</td><td style="${B}">${formatMoney(net) || '0'}</td></tr>
  </table>`;
}

/* ============ WORD EXPORT (A4) ============ */
function wordDocHTML(bodyInner, title) {
  return `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page WordSection1 { size:595.3pt 841.9pt; margin:1.8cm 1.8cm 1.8cm 1.8cm; mso-page-orientation:portrait; }
div.WordSection1 { page:WordSection1; }
body { font-family:"Times New Roman", Times, serif; }
table { border-collapse:collapse; }
</style></head>
<body><div class="WordSection1">${bodyInner}</div></body></html>`;
}
function downloadDoc(html, filename) {
  const blob = new Blob(['\ufeff' + html], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ============ AUTO-FILL FROM EMPLOYEE RECORD ============ */
function wageFor(empId) {
  const e = employees[empId] || {};
  return e.basicSalary ?? localStorage.getItem(`payslip_wage_${empId}`) ?? localStorage.getItem('payslip_wage_last') ?? '';
}
function stateForEmployee(empId, month) {
  const e = employees[empId] || {};
  const c = e.contract || {};
  const center = EMPLOYER_CENTERS[(c.employerName || '').trim()] || {};
  const period = periodFromMonth(month);
  return {
    employer: {
      name: (c.employerName || '').trim() || '',
      contact: c.employerContactNo || center.contact || '',
      address: c.employerAddress || center.english || ''
    },
    worker: {
      name: e.englishName || '', position: FIXED_POSITION,
      docType: c.identityDocType || "Non-Resident Worker's Identification Card",
      docNo: c.identityDocNo || '',
      docIssueRaw: c.identityDocIssueDate || '',
      docIssue: dmy(c.identityDocIssueDate),
      otherNumbers: ''
    },
    period,
    remuneration: [ { basic: true, label: `Basic Wage:  ${period.monthName}`, amount: wageFor(empId) }, { label: '', amount: '' }, { label: '', amount: '' } ],
    deductions: [ { label: '', amount: '' }, { label: '', amount: '' }, { label: '', amount: '' } ]
  };
}
function applyStateToForm(s, month) {
  if (month) $('payMonth').value = month;
  $('employerName').value = s.employer.name || '';
  $('employerContact').value = s.employer.contact || '';
  $('employerAddress').value = s.employer.address || '';
  $('workerName').value = s.worker.name || '';
  $('idDocType').value = s.worker.docType || "Non-Resident Worker's Identification Card";
  $('idDocNo').value = s.worker.docNo || '';
  $('idDocIssue').value = s.worker.docIssueRaw || '';
  $('otherNumbers').value = s.worker.otherNumbers || '';
  const remBox = $('remRows'); remBox.innerHTML = '';
  (s.remuneration || []).forEach(r => remBox.appendChild(remRowEl(r)));
  if (!remBox.children.length) defaultRemRows();
  const dedBox = $('dedRows'); dedBox.innerHTML = '';
  (s.deductions || []).forEach(r => dedBox.appendChild(dedRowEl(r)));
  if (!dedBox.children.length) defaultDedRows();
  updateBasicLabel();
  renderPreview();
}
function fillFromEmployee(empId) {
  applyStateToForm(stateForEmployee(empId, val('payMonth')), null);
}

/* ============ LIVE PREVIEW ============ */
function updateBasicLabel() {
  const basic = $('remRows').querySelector('.row-line.basic .r-label');
  if (basic) basic.value = `Basic Wage:  ${periodFromMonth(val('payMonth')).monthName}`;
}
function renderPreview() {
  const s = collectState();
  $('totalRem').textContent = formatMoney(sumRows(s.remuneration)) || '0';
  $('totalDed').textContent = formatMoney(sumRows(s.deductions)) || '0';
  $('netTotal').textContent = formatMoney(sumRows(s.remuneration) - sumRows(s.deductions)) || '0';
  $('payslipPreview').innerHTML = buildPayslipHTML(s);
}

/* ============ DEFAULTS / RESET ============ */
function defaultRemRows() {
  const box = $('remRows'); box.innerHTML = '';
  box.appendChild(remRowEl({ basic: true, label: '', amount: '' }));
  box.appendChild(remRowEl()); box.appendChild(remRowEl());
  updateBasicLabel();
}
function defaultDedRows() {
  const box = $('dedRows'); box.innerHTML = '';
  box.appendChild(dedRowEl()); box.appendChild(dedRowEl()); box.appendChild(dedRowEl());
}
function defaultMonth() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); // previous month (payroll runs after month end)
  $('payMonth').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function resetForm() {
  $('empSelect').value = '';
  defaultMonth();
  ['employerName','employerContact','employerAddress','workerName','idDocNo','idDocIssue','otherNumbers']
    .forEach(id => $(id).value = '');
  defaultRemRows(); defaultDedRows(); renderPreview();
}

/* ============ SAVE / LOAD / DELETE (Firebase /payslips) ============ */
async function savePayslip() {
  const month = val('payMonth');
  if (!month) return alert('⚠️ Please select the remuneration month first.');
  const empId = $('empSelect').value || 'manual';
  const key = `${empId}_${month}`;
  const state = collectState();
  rememberWage();
  try {
    await set(ref(db, `payslips/${key}`), {
      empId: $('empSelect').value || '', month, data: state,
      savedBy: auth.currentUser?.email || '', savedAt: new Date().toISOString()
    });
    alert('✅ Payslip saved.');
  } catch (err) { console.error(err); alert('❌ Failed to save: ' + err.message); }
}
function rememberWage() {
  const basic = $('remRows').querySelector('.row-line.basic .r-amount');
  const empId = $('empSelect').value;
  if (basic && basic.value) {
    if (empId) localStorage.setItem(`payslip_wage_${empId}`, basic.value);
    localStorage.setItem('payslip_wage_last', basic.value);
  }
}
function renderSavedSelect() {
  const sel = $('savedSelect');
  const entries = Object.entries(payslips || {})
    .sort((a, b) => String(b[1].savedAt || '').localeCompare(String(a[1].savedAt || '')));
  sel.innerHTML = '<option value="">— Select saved payslip —</option>' +
    entries.map(([k, p]) => `<option value="${esc(k)}">${esc(p.data?.worker?.name || p.empId || '?')} • ${esc(p.month)}</option>`).join('');
}

/* ============ EXPORT ACTIONS ============ */
function exportWord() {
  const month = val('payMonth');
  if (!month) return alert('⚠️ Please select the remuneration month first.');
  rememberWage();
  const s = collectState();
  downloadDoc(wordDocHTML(buildPayslipHTML(s), 'Pay Slip'), `Payslip_${sanitizeFile(s.worker.name) || 'Employee'}_${month}.doc`);
}
function batchExport() {
  const month = val('payMonth');
  if (!month) return alert('⚠️ Please select the remuneration month first.');
  const list = Object.entries(employees).filter(([_, e]) => e.residencyStatus === 'Non-Resident');
  if (!list.length) return alert('⚠️ No Non-Resident employees found.');
  const parts = list.map(([id]) => buildPayslipHTML(stateForEmployee(id, month)));
  const joined = parts.join('<p style="page-break-after:always;margin:0;"></p>');
  downloadDoc(wordDocHTML(joined, `Payslips ${month}`), `Payslips_All_NonResidents_${month}.doc`);
}
function printPayslip() {
  const s = collectState();
  const w = window.open('', '_blank');
  if (!w) return alert('⚠️ Pop-up blocked. Allow pop-ups to print.');
  w.document.write(`<html><head><title>Pay Slip</title><style>@page{size:A4;margin:15mm;}body{font-family:'Times New Roman',Times,serif;}</style></head><body>${buildPayslipHTML(s)}</body></html>`);
  w.document.close(); w.focus(); w.print();
}

/* ============ INIT ============ */
function initApp() {
  if (initialized) return; initialized = true;

  // Employer datalist
  $('employerList').innerHTML = Object.keys(EMPLOYER_CENTERS).map(n => `<option value="${esc(n)}">`).join('');

  defaultMonth();
  defaultRemRows();
  defaultDedRows();
  renderPreview();

  // Live data
  onValue(ref(db, 'employees'), (snap) => {
    employees = snap.val() || {};
    const sel = $('empSelect'); const prev = sel.value;
    const entries = Object.entries(employees).sort((a, b) => {
      const nr = x => x[1].residencyStatus === 'Non-Resident' ? 0 : 1;
      return nr(a) - nr(b) || (a[1].englishName || '').localeCompare(b[1].englishName || '');
    });
    sel.innerHTML = '<option value="">— Manual entry —</option>' +
      entries.map(([id, e]) => `<option value="${id}">${esc(e.englishName || id)}${e.residencyStatus === 'Non-Resident' ? ' (Non-Resident)' : ''}</option>`).join('');
    sel.value = prev;
  });
  onValue(ref(db, 'payslips'), (snap) => { payslips = snap.val() || {}; renderSavedSelect(); });

  // Listeners
  $('empSelect').addEventListener('change', (e) => { if (e.target.value) fillFromEmployee(e.target.value); });
  $('payMonth').addEventListener('change', () => { updateBasicLabel(); renderPreview(); });
  $('employerName').addEventListener('change', (e) => {
    const c = EMPLOYER_CENTERS[e.target.value.trim()];
    if (c) { $('employerContact').value = c.contact; $('employerAddress').value = c.english; renderPreview(); }
  });
  $('addRemBtn').addEventListener('click', () => { $('remRows').appendChild(remRowEl()); renderPreview(); });
  $('addDedBtn').addEventListener('click', () => { $('dedRows').appendChild(dedRowEl()); renderPreview(); });
  $('mainContent').addEventListener('click', (e) => {
    if (e.target.classList.contains('del-row')) { e.target.closest('.row-line').remove(); renderPreview(); }
  });
  $('mainContent').addEventListener('input', renderPreview); // live preview on every keystroke

  $('exportWordBtn').addEventListener('click', exportWord);
  $('batchExportBtn').addEventListener('click', batchExport);
  $('printBtn').addEventListener('click', printPayslip);
  $('resetBtn').addEventListener('click', resetForm);
  $('savePayslipBtn').addEventListener('click', savePayslip);
  $('loadSavedBtn').addEventListener('click', () => {
    const key = $('savedSelect').value;
    if (!key || !payslips[key]) return alert('⚠️ Select a saved payslip first.');
    $('empSelect').value = payslips[key].empId || '';
    applyStateToForm(payslips[key].data, payslips[key].month);
  });
  $('deleteSavedBtn').addEventListener('click', async () => {
    const key = $('savedSelect').value;
    if (!key) return alert('⚠️ Select a saved payslip first.');
    if (!confirm('Delete this saved payslip?')) return;
    await remove(ref(db, `payslips/${key}`));
  });
}