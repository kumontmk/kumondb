// ============================================================
// booth-kc-bridge.js
// Guarantees the booth KC No. lands in the student form's
// Basic Information #kcNo input — never in a DT row.
// Load on BOTH booth-games.html and student-form.html:
//   <script src="booth-kc-bridge.js" defer></script>
// ============================================================
(function () {
  'use strict';
  if (window.__boothKcBridge) return;
  window.__boothKcBridge = true;

  var KEY = 'boothKcHandoff';
  var MAX_AGE = 15 * 60000;

  // ---------- BOOTH SIDE ----------
  // Capture-phase: runs BEFORE any existing button handler,
  // so the KC is stashed even if an older bdtOpenNew runs.
  if (document.getElementById('drawerBody')) {
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('#bdtNewBtn') : null;
      if (!btn) return;
      var el = document.querySelector('#drawerBody [data-dt-kc]')
        || document.querySelector('#drawerBody [data-rec="kcNo"]');
      var kc = el ? String(el.value || '').trim() : '';
      if (!kc) {
        var code = document.querySelector('#bdtSummary .bdt-kc-line code');
        if (code) kc = String(code.textContent || '').trim();
      }
      if (!kc) return;
      try { sessionStorage.setItem(KEY, JSON.stringify({ kcNo: kc, ts: Date.now() })); } catch (err) {}
    }, true);
    return;
  }

  // ---------- STUDENT FORM SIDE ----------
  var kcInput = document.getElementById('kcNo');
  if (!kcInput) return;
  if (new URLSearchParams(window.location.search).get('id')) return;

  var kc = '';
  try {
    var params = new URLSearchParams(window.location.search);
    kc = String(params.get('kc') || '').trim();
    if (params.has('kc')) {
      params.delete('kc');
      var q = params.toString();
      history.replaceState({}, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash);
    }
  } catch (err) {}
  if (!kc) {
    try {
      var k = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (k && k.kcNo && (!k.ts || Date.now() - k.ts < MAX_AGE)) kc = String(k.kcNo).trim();
    } catch (err) {}
  }
  if (!kc) {
    try {
      var h = JSON.parse(sessionStorage.getItem('boothDtHandoff') || 'null');
      var v = h && (h.kcNo || (h.student && h.student.kcNo));
      if (v && (!h.ts || Date.now() - h.ts < MAX_AGE)) kc = String(v).trim();
    } catch (err) {}
  }
  try { sessionStorage.removeItem(KEY); } catch (err) {}
  if (!kc) return;

  var last = '';
  function apply() {
    var el = document.getElementById('kcNo');
    if (!el) return;
    if (document.activeElement === el && el.value && el.value !== last) return;
    if (!el.value || el.value === last) {
      el.value = kc;
      last = kc;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  [0, 150, 350, 700, 1200, 2000, 3000, 4000].forEach(function (ms) { setTimeout(apply, ms); });
})();