// ashr-display.js — audience / projector screen (read-only, realtime)
import { auth, db } from './auth.js';
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { mountStage, unlockAudio } from './ashr-stage.js';

const params = new URLSearchParams(location.search);
const eventId = params.get('e') || localStorage.getItem('ashr_eventId') || '2026';
const $ = id => document.getElementById(id);

onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.href = 'index.html'; return; }

  const stage = mountStage($('stageHost'));
  stage.apply({ mode: 'backdrop' }); // start clean until first state arrives

  onValue(ref(db, `ashrEvents/${eventId}/presentation`),
    snap => { stage.apply(snap.val() || { mode: 'backdrop' }); $('connDot').classList.add('on'); },
    err  => { console.error('Display listener error:', err); $('connDot').classList.remove('on'); });

  /* ---- Kiosk: hide cursor & UI after 3s idle ---- */
  let idleTimer;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  };
  ['mousemove', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, wake));
  wake();

  /* ---- Fullscreen: button, F key, or double-click anywhere ---- */
  const goFullscreen = () => document.documentElement.requestFullscreen?.().catch(() => {});
  $('fsBtn').addEventListener('click', goFullscreen);
  window.addEventListener('keydown', e => { if (e.key === 'f' || e.key === 'F') goFullscreen(); });
  document.addEventListener('dblclick', goFullscreen);

  /* ---- Sound unlock (browsers need one user gesture) ---- */
  $('soundBtn').addEventListener('click', () => {
    if (unlockAudio()) {
      const b = $('soundBtn');
      b.textContent = '🔊 Sound on';
      b.classList.add('armed');
    }
  });
});