// =====================================================
// payslip.js — Pay Slip Generator (Kumon DB)
// Employee's Information edition: Name / Position /
// Social Security Fund Beneficiary No. / Taxpayer No.
// Amount columns shown as Amount(MOP$)
// Pay period From/To editable per employee (defaults to full month)
// =====================================================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getDatabase, ref, get, set, remove, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { firebaseConfig } from './auth.js';

// Bulletproof Firebase initialization (prevents the no-app error)
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const AUTHORIZED_EMAIL = "kumonchamps@gmail.com";
const DEFAULT_POSITION = "Teacher Assistant"; // editable default, no longer fixed

// Mirrors EMPLOYER_CENTERS in employees.js (+ known contact numbers)
const EMPLOYER_CENTERS = {
  "Centro de Educação Kumon Champs":                { contact: "28519919", english: "Ave Do Conselheiro Ferreira, De Almeida No. 113B R/C, C, Edf Ho Lan Fa Un" },
  "Centro de Educação Kumon Taipa Pac Tat":         { contact: "28823866", english: "Rua De Viseu N˚ 120, Fast Garden, r/c, M, Taipa" },
  "Centro de Educação Kumon Tap Siac":              { contact: "28823866", english: "Rua Afonso de Albuquerque, No. 22B RC-ARC Edif. Choi Lai" },
  "Centro de Educação Kumon Taipa Mei Keng":        { contact: "28831773", english: "NA TAIPA, ESTRADA GOVERNADOR ALBANO DE OLIVEIRA N° 24, MEI KENG FA UN RÉ-DO-CHÃO AU" },
  "Centro de Educação Long Kei":                    { contact: "",         english: "" },
  "Centro de Educação Kei Hok Fong":                { contact: "",         english: "Estrada Governador Albano de Oliveira, n.º20, Mei Keng Fa Un, r/c, AO, Taipa" },
  "Centro de Educação Oi Hok Fong 2 (EL Taipa)":    { contact: "",         english: "Avenida De Guimaraes 47, Mei Keng Fa Un, Res-Do-Chao R, Taipa, Macau" },
  "Centro de Educação Delight Learning (EL Macau)": { contact: "",         english: "Macau, Rua Do Padre Antonio Roliz Nos 14B-14C, Kei Cheong Res-Do-Chao A" },
  "Centro de Educação Wai Si (Wise Kids)":          { contact: "",         english: "" }
};

let employees = {};
let payslips = {};
let initialized = false;
let pendingSavedKey = null;

/* ============ SMALL HELPERS ============ */
const $ = (id) => document.getElementById(id);
const val = (id) => ($(id)?.value ?? '').trim();
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const sanitizeFile = (s) => String(s || '').replace(/[^a-z0-9_-]+/gi, '_');
const pick = (...vals) => {
  for (const v of vals) { const s = String(v ?? '').trim(); if (s) return s; }
  return '';
};

function getEmpPositions(emp) {
  if (!emp) return [];
  if (Array.isArray(emp.positions)) return emp.positions.filter(Boolean);
  if (emp.position) return [emp.position];
  return [];
}

/* ============ TOASTS & SAVE STATUS ============ */
function toast(msg, type = 'info', action = null, ms = 4500) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = msg;
  el.appendChild(span);
  let timer;
  const dismiss = () => { clearTimeout(timer); el.classList.remove('show'); setTimeout(() => el.remove(), 260); };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label;
    b.addEventListener('click', () => { dismiss(); action.fn(); });
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'toast-close'; x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss');
  x.addEventListener('click', dismiss);
  el.appendChild(x);
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  timer = setTimeout(dismiss, ms);
}

function setSaveStatus(state, text) {
  const el = $('saveStatus');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}
function markDirty() { setSaveStatus('dirty', '● Unsaved changes'); }

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
const pad2 = (n) => String(n).padStart(2, '0');

function periodFromMonth(monthStr) {
  if (!monthStr) return { from: '', to: '', fromRaw: '', toRaw: '', monthName: '' };
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const monthName = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' });
  return {
    from: `1/${m}/${y}`,
    to: `${last}/${m}/${y}`,
    fromRaw: `${y}-${pad2(m)}-01`,
    toRaw: `${y}-${pad2(m)}-${pad2(last)}`,
    monthName
  };
}
function dmy(iso) { // YYYY-MM-DD -> D/M/YYYY (like the official form)
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  if (!y || !m || !d) return '';
  return `${+d}/${+m}/${+y}`;
}
function isoFromDmy(s) { // D/M/YYYY -> YYYY-MM-DD (for loading older saved payslips)
  if (!s) return '';
  const parts = String(s).split('/');
  if (parts.length !== 3) return '';
  const [d, m, y] = parts.map(Number);
  if (!y || !m || !d) return '';
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function syncPeriodToMonth() {
  const p = periodFromMonth(val('payMonth'));
  $('periodFrom').value = p.fromRaw;
  $('periodTo').value = p.toRaw;
}
function validatePeriod() {
  const f = $('periodFrom').value, t = $('periodTo').value;
  const bad = !!(f && t && f > t); // ISO strings compare correctly
  $('periodWarning').classList.toggle('hidden', !bad);
  $('periodFrom').classList.toggle('invalid', bad);
  $('periodTo').classList.toggle('invalid', bad);
  return !bad;
}
function formatMoney(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '';
  return Number.isInteger(num)
    ? num.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ============ FORM ROW BUILDERS ============ */
function remRowEl(r = {}) {
  const div = document.createElement('div');
  div.className = 'row-line' + (r.basic ? ' basic' : '');
  div.innerHTML =
    `<input type="text" class="r-label" value="${esc(r.label || '')}" placeholder="Item (e.g. Overtime, Allowance)" ${r.basic ? 'readonly' : ''}>` +
    `<input type="number" class="r-amount" value="${esc(r.amount ?? '')}" min="0" step="any" placeholder="MOP$">` +
    `<button type="button" class="del-row danger" ${r.basic ? 'style="visibility:hidden"' : ''}>✕</button>`;
  return div;
}
function dedRowEl(r = {}) {
  const div = document.createElement('div');
  div.className = 'row-line';
  div.innerHTML =
    `<input type="text" class="r-label" value="${esc(r.label || '')}" placeholder="Deduction (e.g. Social Security, Absence)">` +
    `<input type="number" class="r-amount" value="${esc(r.amount ?? '')}" min="0" step="any" placeholder="MOP$">` +
    `<button type="button" class="del-row danger">✕</button>`;
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
  const monthPeriod = periodFromMonth(val('payMonth'));
  const fromRaw = $('periodFrom').value;
  const toRaw = $('periodTo').value;
  return {
    employer: { name: val('employerName'), contact: val('employerContact'), address: val('employerAddress') },
    worker: {
      name: val('workerName'),
      position: val('workerPosition'),
      ssfNo: val('ssfNo'),
      taxpayerNo: val('taxpayerNo')
    },
    period: {
      from: dmy(fromRaw),
      to: dmy(toRaw),
      fromRaw,
      toRaw,
      monthName: monthPeriod.monthName
    },
    remuneration: collectRows('remRows'),
    deductions: collectRows('dedRows')
  };
}

/* ============ PAYSLIP HTML (preview, Word & print) ============ */
function buildPayslipHTML(s) {
  const emp = s.employer || {}, w = s.worker || {}, p = s.period || {};
  const B = 'border:1px solid #000;padding:6px 10px;font-size:13pt;';
  const G = B + 'font-weight:bold;background:#DFDFDF;text-align:center;vertical-align:middle;';
  const H = B + 'font-weight:bold;text-align:center;';
  const ul = (v, min = 110) => `<span style="display:inline-block;min-width:${min}px;border-bottom:1px solid #000;text-align:center;padding:0 8px;">${esc(v)}</span>`;
  const T = '<table cellspacing="0" style="width:100%;border-collapse:collapse;font-family:\'Times New Roman\',Times,serif;margin-bottom:16px;">';

  const rem = [...(s.remuneration || [])]; while (rem.length < 3) rem.push({ label: '', amount: '' });
  const ded = [...(s.deductions || [])];   while (ded.length < 3) ded.push({ label: '', amount: '' });
  const remTotal = sumRows(rem), dedTotal = sumRows(ded);
  const net = remTotal - dedTotal;

  const lineHtml = (r, i) => {
    const has = r.label || String(r.amount ?? '') !== '';
    return `<tr><td style="${B}">${has ? `(${i + 1}) ${esc(r.label)}` : ''}</td><td style="${B}width:26%;">${formatMoney(r.amount)}</td></tr>`;
  };
  const remHtml = rem.map(lineHtml).join('');
  const dedHtml = ded.map(lineHtml).join('');

  return `
<h2 style="text-align:center;font-family:'Times New Roman',Times,serif;font-size:17pt;font-weight:bold;letter-spacing:1px;margin:0 0 20px;">PAY SLIP</h2>
${T}
<tr>
<td rowspan="2" style="${G}width:23%;">Employer's Information</td>
<td style="${B}width:42%;">Name: ${esc(emp.name)}</td>
<td style="${B}">Contact No.: ${esc(emp.contact)}</td>
</tr>
<tr><td colspan="2" style="${B}">Office Address: ${esc(emp.address)}</td></tr>
<tr>
<td rowspan="3" style="${G}">Employee's Information</td>
<td style="${B}">Name: ${esc(w.name)}</td>
<td style="${B}">Position: ${esc(w.position)}</td>
</tr>
<tr><td colspan="2" style="${B}">Social Security Fund Beneficiary No.: ${ul(w.ssfNo, 220)}</td></tr>
<tr><td colspan="2" style="${B}">Taxpayer No.: ${ul(w.taxpayerNo, 220)}</td></tr>
<tr>
<td style="${G}">Period Corresponding to Remuneration Received</td>
<td colspan="2" style="${B}height:58px;">From ${ul(p.from, 100)} (Day/Month/Year) to ${ul(p.to, 100)} (Day/Month/Year)</td>
</tr>
</table>
${T}
<tr><td rowspan="${rem.length + 1}" style="${G}width:23%;">Remuneration</td><td style="${H}">Item</td><td style="${H}width:26%;">Amount(MOP$)</td></tr>
${remHtml}
</table>
<div style="text-align:center;font-family:'Times New Roman',serif;font-size:13pt;font-weight:bold;margin:-6px 0 16px;">Total Remunerations: ${formatMoney(remTotal) || '0'}</div>
${T}
<tr><td rowspan="${ded.length + 1}" style="${G}width:23%;">Deduction</td><td style="${H}">Item</td><td style="${H}width:26%;">Amount(MOP$)</td></tr>
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
body { font-family:"Times New Roman",Times,serif; }
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
      name: (c.employerName || '').trim(),
      contact: pick(c.employerContactNo, center.contact),
      address: pick(c.employerAddress, center.english)
    },
    worker: {
      name: e.englishName || '',
      position: getEmpPositions(e)[0] || DEFAULT_POSITION,
      ssfNo: pick(c.ssfNo, c.ssfBeneficiaryNo, c.socialSecurityNo, c.socialSecurityFundNo,
                  e.ssfNo, e.ssfBeneficiaryNo, e.socialSecurityNo, e.socialSecurityFundNo),
      taxpayerNo: pick(c.taxpayerNo, c.taxNo, c.taxId, e.taxpayerNo, e.taxNo, e.taxId)
    },
    period,
    remuneration: [
      { basic: true, label: `Basic Wage: ${period.monthName}`, amount: wageFor(empId) },
      { label: '', amount: '' }, { label: '', amount: '' }
    ],
    deductions: [ { label: '', amount: '' }, { label: '', amount: '' }, { label: '', amount: '' } ]
  };
}
function applyStateToForm(s, month) {
  if (month) $('payMonth').value = month;
  $('employerName').value = s.employer?.name || '';
  $('employerContact').value = s.employer?.contact || '';
  $('employerAddress').value = s.employer?.address || '';
  $('workerName').value = s.worker?.name || '';
  $('workerPosition').value = s.worker?.position || DEFAULT_POSITION;
  $('ssfNo').value = s.worker?.ssfNo || '';
  $('taxpayerNo').value = s.worker?.taxpayerNo || '';
  // Pay period: prefer raw ISO dates; fall back to parsing D/M/YYYY (older saves), then month defaults
  const p = s.period || {};
  const fb = periodFromMonth(month || val('payMonth'));
  $('periodFrom').value = p.fromRaw || isoFromDmy(p.from) || fb.fromRaw;
  $('periodTo').value = p.toRaw || isoFromDmy(p.to) || fb.toRaw;
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
  if (basic) basic.value = `Basic Wage: ${periodFromMonth(val('payMonth')).monthName}`;
}
function renderPreview() {
  validatePeriod();
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
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); // payroll runs after month end
  $('payMonth').value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  syncPeriodToMonth();
}
function hasContent() {
  if (val('workerName') || val('ssfNo') || val('taxpayerNo') || val('employerName')) return true;
  const mp = periodFromMonth(val('payMonth'));
  if ($('periodFrom').value !== mp.fromRaw || $('periodTo').value !== mp.toRaw) return true;
  return [...collectRows('remRows'), ...collectRows('dedRows')]
    .some(r => String(r.amount).trim() !== '' || (!r.basic && r.label));
}
function resetForm() {
  $('empSelect').value = '';
  defaultMonth(); // also resets pay period to full month
  ['employerName', 'employerContact', 'employerAddress', 'workerName', 'ssfNo', 'taxpayerNo']
    .forEach(id => $(id).value = '');
  $('workerPosition').value = DEFAULT_POSITION;
  defaultRemRows(); defaultDedRows(); renderPreview();
  setSaveStatus('idle', 'Not saved yet');
}

/* ============ SAVE / LOAD / DELETE (Firebase /payslips) ============ */
async function savePayslip() {
  const month = val('payMonth');
  if (!month) { toast('Please select the remuneration month first.', 'warn'); $('payMonth').focus(); return; }
  if (!validatePeriod()) { toast('Pay period “From” is after “To”. Please fix the dates.', 'warn'); $('periodFrom').focus(); return; }
  const empId = $('empSelect').value || 'manual';
  const key = `${empId}_${month}`;
  if (payslips[key]) {
    const who = payslips[key].data?.worker?.name || 'this employee';
    if (!confirm(`A payslip for ${who} (${month}) already exists. Overwrite it?`)) return;
  }
  const state = collectState();
  rememberWage();
  const btn = $('savePayslipBtn');
  btn.disabled = true;
  pendingSavedKey = key;
  try {
    await set(ref(db, `payslips/${key}`), {
      empId: $('empSelect').value || '', month, data: state,
      savedBy: auth.currentUser?.email || '', savedAt: new Date().toISOString()
    });
    setSaveStatus('saved', `✓ Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    toast('Payslip saved.', 'success');
  } catch (err) {
    console.error(err);
    pendingSavedKey = null;
    toast('Failed to save: ' + err.message, 'danger');
  } finally { btn.disabled = false; }
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
  const prev = sel.value;
  const entries = Object.entries(payslips || {})
    .sort((a, b) => String(b[1].savedAt || '').localeCompare(String(a[1].savedAt || '')));
  sel.innerHTML = '<option value="">— Select saved payslip —</option>' +
    entries.map(([k, p]) => `<option value="${esc(k)}">${esc(p.data?.worker?.name || p.empId || 'Manual')} • ${esc(p.month || '')}</option>`).join('');
  if (pendingSavedKey && payslips[pendingSavedKey]) { sel.value = pendingSavedKey; pendingSavedKey = null; }
  else if (prev && payslips[prev]) { sel.value = prev; }
  const c = $('savedCount'); if (c) c.textContent = String(entries.length);
}
function loadSaved() {
  const key = $('savedSelect').value;
  if (!key || !payslips[key]) { toast('Select a saved payslip first.', 'warn'); return; }
  $('empSelect').value = payslips[key].empId || '';
  applyStateToForm(payslips[key].data || {}, payslips[key].month);
  setSaveStatus('saved', '✓ Loaded from database');
  toast('Payslip loaded.', 'success');
}
async function deleteSaved() {
  const key = $('savedSelect').value;
  if (!key || !payslips[key]) { toast('Select a saved payslip first.', 'warn'); return; }
  const rec = payslips[key];
  const label = `${rec.data?.worker?.name || rec.empId || 'Manual'} • ${rec.month}`;
  if (!confirm(`Delete saved payslip "${label}"?`)) return;
  try {
    await remove(ref(db, `payslips/${key}`));
    toast('Payslip deleted.', 'danger', {
      label: 'Undo',
      fn: async () => {
        try { await set(ref(db, `payslips/${key}`), rec); toast('Payslip restored.', 'success'); }
        catch (e) { toast('Restore failed: ' + e.message, 'danger'); }
      }
    }, 6000);
  } catch (err) { toast('Delete failed: ' + err.message, 'danger'); }
}

/* ============ EXPORT ACTIONS ============ */
function exportWord() {
  const month = val('payMonth');
  if (!month) { toast('Please select the remuneration month first.', 'warn'); return; }
  if (!validatePeriod()) { toast('Pay period “From” is after “To”. Please fix the dates.', 'warn'); return; }
  rememberWage();
  const s = collectState();
  downloadDoc(wordDocHTML(buildPayslipHTML(s), 'Pay Slip'),
    `Payslip_${sanitizeFile(s.worker.name) || 'Employee'}_${month}.doc`);
  toast('Word file downloaded.', 'success');
}
function batchExport() {
  const month = val('payMonth');
  if (!month) { toast('Please select the remuneration month first.', 'warn'); return; }
  const list = Object.entries(employees)
    .sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
  if (!list.length) { toast('No employees found in the database.', 'warn'); return; }
  const parts = list.map(([id]) => buildPayslipHTML(stateForEmployee(id, month)));
  const joined = parts.join('<p style="page-break-after:always;margin:0;"></p>');
  downloadDoc(wordDocHTML(joined, `Payslips ${month}`), `Payslips_All_Employees_${month}.doc`);
  toast(`Batch exported: ${list.length} payslips in one file.`, 'success');
}
function printPayslip() {
  if (!validatePeriod()) { toast('Pay period “From” is after “To”. Please fix the dates.', 'warn'); return; }
  const s = collectState();
  const w = window.open('', '_blank');
  if (!w) { toast('Pop-up blocked. Allow pop-ups to print.', 'warn'); return; }
  w.document.write(`<html><head><meta charset="utf-8"><title>Pay Slip</title><style>@page{size:A4;margin:15mm;}body{font-family:'Times New Roman',Times,serif;}</style></head><body>${buildPayslipHTML(s)}</body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 300);
}

/* ============ INIT ============ */
function initApp() {
  if (initialized) return; initialized = true;

  $('employerList').innerHTML = Object.keys(EMPLOYER_CENTERS).map(n => `<option value="${esc(n)}">`).join('');
  defaultMonth(); // sets month + full-month pay period
  defaultRemRows();
  defaultDedRows();
  renderPreview();
  setSaveStatus('idle', 'Not saved yet');

  // Live data
  onValue(ref(db, 'employees'), (snap) => {
    employees = snap.val() || {};
    const sel = $('empSelect'); const prev = sel.value;
    const entries = Object.entries(employees)
      .sort((a, b) => (a[1].englishName || '').localeCompare(b[1].englishName || ''));
    sel.innerHTML = '<option value="">— Manual entry —</option>' +
      entries.map(([id, e]) => `<option value="${esc(id)}">${esc(e.englishName || id)}</option>`).join('');
    if (prev && employees[prev]) sel.value = prev;
  }, (err) => console.error('employees listener:', err));

  onValue(ref(db, 'payslips'), (snap) => { payslips = snap.val() || {}; renderSavedSelect(); },
    (err) => console.error('payslips listener:', err));

  // Listeners
  $('empSelect').addEventListener('change', (e) => { if (e.target.value) { fillFromEmployee(e.target.value); markDirty(); } });
  $('payMonth').addEventListener('change', () => { syncPeriodToMonth(); updateBasicLabel(); renderPreview(); markDirty(); });
  $('periodResetBtn').addEventListener('click', () => { syncPeriodToMonth(); renderPreview(); markDirty(); });
  $('employerName').addEventListener('change', (e) => {
    const c = EMPLOYER_CENTERS[e.target.value.trim()];
    if (c) { $('employerContact').value = c.contact; $('employerAddress').value = c.english; renderPreview(); }
    markDirty();
  });
  $('addRemBtn').addEventListener('click', () => { $('remRows').appendChild(remRowEl()); renderPreview(); markDirty(); });
  $('addDedBtn').addEventListener('click', () => { $('dedRows').appendChild(dedRowEl()); renderPreview(); markDirty(); });
  $('mainContent').addEventListener('click', (e) => {
    if (e.target.classList.contains('del-row')) { e.target.closest('.row-line').remove(); renderPreview(); markDirty(); }
  });
  $('mainContent').addEventListener('input', () => { renderPreview(); markDirty(); });

  $('exportWordBtn').addEventListener('click', exportWord);
  $('batchExportBtn').addEventListener('click', batchExport);
  $('printBtn').addEventListener('click', printPayslip);
  $('resetBtn').addEventListener('click', () => {
    if (hasContent() && !confirm('Reset the form? Unsaved changes will be lost.')) return;
    resetForm();
    toast('Form reset.', 'info');
  });
  $('savePayslipBtn').addEventListener('click', savePayslip);
  $('loadSavedBtn').addEventListener('click', loadSaved);
  $('deleteSavedBtn').addEventListener('click', deleteSaved);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (initialized) savePayslip();
    }
  });
}