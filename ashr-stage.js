// ashr-stage.js — shared 16:9 stage renderer
// Used by ashr-display.html (audience screen) and ashr-present.html (live preview)

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function medalFor(tier) { return tier === 'Gold' ? '🥇' : tier === 'Silver' ? '🥈' : tier === 'Bronze' ? '🥉' : ''; }
export const starsFor = n => '★'.repeat(Math.max(0, Math.min(5, Number(n) || 0)));

// ✅ Same short-code algorithm as ashr.js so printed barcodes match
export function shortScanCode(value) {
  let h = 5381;
  const v = String(value || '');
  for (let i = 0; i < v.length; i++) h = ((h << 5) + h + v.charCodeAt(i)) >>> 0;
  return 'K' + h.toString(36).toUpperCase().padStart(7, '0');
}

// ✅ Exact match: long barcode, short code, honoree key, studentId, student number
export function matchScan(honorees, value, eventId) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  for (const [key, h] of Object.entries(honorees || {})) {
    const bv = h.barcodeValue || `ASHR${eventId}_${key}`;
    if (bv === v || shortScanCode(bv) === v || key === v ||
        h.studentId === v || String(h.studentNumber || '') === v) {
      return { key, ...h };
    }
  }
  return null;
}

// ✅ Fuzzy name/center search for typed input
export function searchHonorees(honorees, q, limit = 10) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  const score = h => [(h.nameCn || '').toLowerCase(), (h.nameEn || '').toLowerCase()]
    .some(n => n.startsWith(s)) ? 0 : 1;
  return Object.entries(honorees || {})
    .map(([key, h]) => ({ key, ...h }))
    .filter(h => [h.nameCn, h.nameEn, h.studentNumber, h.centerName]
      .filter(Boolean).join(' ').toLowerCase().includes(s))
    .sort((a, b) => score(a) - score(b) ||
      String(a.nameCn || a.nameEn).localeCompare(String(b.nameCn || b.nameEn)))
    .slice(0, limit);
}

/* ============================================
   🎉 CONFETTI (dependency-free canvas engine)
   ============================================ */
export function burstConfetti(canvas, { count = 120 } = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
    canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
  }
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;
  const colors = ['#FFD700', '#fde047', '#87CEEB', '#4682B4', '#ffffff', '#fb923c'];
  const parts = canvas._parts = canvas._parts || [];
  const cannons = [
    { x: W * 0.05, y: H * 0.99, ang: -Math.PI / 3.1 },
    { x: W * 0.95, y: H * 0.99, ang: -Math.PI + Math.PI / 3.1 }
  ];
  for (let i = 0; i < count; i++) {
    const c = cannons[i % cannons.length];
    const speed = H * (0.013 + Math.random() * 0.016);
    const spread = (Math.random() - 0.5) * 0.6;
    parts.push({
      x: c.x, y: c.y,
      vx: Math.cos(c.ang + spread) * speed,
      vy: Math.sin(c.ang + spread) * speed,
      g: H * 0.00048,
      size: Math.max(3, W * 0.006) * (0.6 + Math.random() * 0.8),
      color: colors[(Math.random() * colors.length) | 0],
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      shape: Math.random() < 0.25 ? 'circle' : 'rect',
      life: 1, decay: 0.006 + Math.random() * 0.006
    });
  }
  if (canvas._raf) return; // loop already running — new particles just join it
  const step = () => {
    ctx.clearRect(0, 0, W, H);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= p.decay;
      if (p.life <= 0 || p.y > H + 40) { parts.splice(i, 1); continue; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color;
      if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, 7); ctx.fill(); }
      else ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
      ctx.restore();
    }
    if (parts.length) canvas._raf = requestAnimationFrame(step);
    else { canvas._raf = null; ctx.clearRect(0, 0, W, H); }
  };
  canvas._raf = requestAnimationFrame(step);
}

/* ============================================
   🔊 SOUND (WebAudio fanfare, no audio files)
   Display must call unlockAudio() once via a click.
   ============================================ */
let audioCtx = null;
export function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx.state === 'running';
  } catch (e) { return false; }
}
export function playFanfare(tier) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const base = [523.25, 659.25, 783.99];
  const notes = tier === 'Gold' ? [...base, 1046.5, 1318.51]
              : tier === 'Silver' ? [...base, 1046.5] : base;
  const t0 = audioCtx.currentTime + 0.03;
  notes.forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    const st = t0 + i * 0.1;
    g.gain.setValueAtTime(0.0001, st);
    g.gain.exponentialRampToValueAtTime(0.13, st + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, st + 0.55);
    o.connect(g).connect(audioCtx.destination);
    o.start(st); o.stop(st + 0.6);
  });
}

/* ============================================
   🖼 STAGE CONTROLLER
   ============================================ */
export function mountStage(host, opts = {}) {
  host.innerHTML = `
    <div class="stage${opts.mini ? ' stage-mini' : ''}">
      <div class="stage-backdrop"></div>
      <div class="stage-scrim"></div>
      <div class="stage-content">
        <div class="st-block">
          <div class="st-name-cn"></div>
          <div class="st-name-en"></div>
          <div class="st-awards"></div>
        </div>
      </div>
      <canvas class="stage-confetti"></canvas>
      <div class="stage-black"></div>
    </div>`;
  const root = host.querySelector('.stage');
  const ctrl = new StageController(root, opts);
  const fit = () => root.style.setProperty('--sw', root.clientWidth + 'px');
  if (window.ResizeObserver) new ResizeObserver(fit).observe(root);
  window.addEventListener('resize', fit);
  fit(); requestAnimationFrame(fit);
  return ctrl;
}

class StageController {
  constructor(root, opts) { this.root = root; this.opts = opts; this.seq = null; }

  apply(state = {}) {
    const mode = (state.mode === 'student' && state.student) ? 'student'
               : state.mode === 'blank' ? 'blank' : 'backdrop';
    this.root.classList.toggle('is-blank', mode === 'blank');
    this.root.classList.toggle('has-student', mode === 'student');
    const content = this.root.querySelector('.stage-content');
    if (mode !== 'student') { content.classList.add('is-hidden'); this.seq = null; return; }

    const isNew = state.seq !== this.seq;
    this._fill(state);
    content.classList.remove('is-hidden');
    if (isNew) {
      this.seq = state.seq;
      this.root.classList.remove('anim-in');
      void this.root.offsetWidth; // restart CSS animations
      this.root.classList.add('anim-in');
      if (state.effects !== false) {
        const gold = (state.student.awards || []).some(a => a.tier === 'Gold');
        burstConfetti(this.root.querySelector('.stage-confetti'),
          { count: this.opts.mini ? 40 : (gold ? 170 : 110) });
      }
      if (state.sound && !this.opts.silent) playFanfare(state.student.tier || 'Bronze');
    }
  }

  _fill(state) {
    const s = state.student || {};
    const q = sel => this.root.querySelector(sel);
    q('.st-name-cn').textContent = s.nameCn || s.nameEn || '';
    q('.st-name-en').textContent = (s.nameCn && s.nameEn) ? s.nameEn : '';
    const awards = s.awards || [];
    // ✅ 4+ awards → compact mode so the stack always fits the 16:9 frame
    this.root.classList.toggle('awards-many', awards.length >= 4);
    q('.st-awards').innerHTML = awards.map((a, i) =>
      `<div class="st-award tier-${String(a.tier || 'bronze').toLowerCase()}" style="animation-delay:${(0.3 + i * 0.16).toFixed(2)}s">
        <span class="st-medal">${medalFor(a.tier)}</span>
        <span class="st-subj">${escapeHtml(a.subject || '')}</span>
        <span class="st-stars">${starsFor(a.stars)}</span>
      </div>`).join('');
  }
}