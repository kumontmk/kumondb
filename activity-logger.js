// activity-logger.js
import { db } from './auth.js';
import {
  ref,
  push,
  set,
  get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const SENSITIVE_KEYS = [
  'password',
  'passcode',
  'token',
  'secret',
  'authorization',
  'creditcard',
  'ssn',
  'otp'
];

let userProfilePromise = null;

/* =========================================
HELPERS
========================================= */

function getStoredUserName() {
  try {
    const storedUser = sessionStorage.getItem('kumonUser');
    if (storedUser) {
      return JSON.parse(storedUser)?.name || '';
    }
  } catch (err) {
    console.error('Error parsing kumonUser from sessionStorage:', err);
  }
  return '';
}

function getCenterContext() {
  return {
    centerId: sessionStorage.getItem('selectedCenter') || '',
    centerName: sessionStorage.getItem('selectedCenterName') || ''
  };
}

function getPageName() {
  const path = window.location.pathname.split('/').pop() || 'unknown';
  return document.title || path;
}

function sanitizeDetails(input) {
  if (!input) return {};

  if (typeof input !== 'object') {
    return {
      value: String(input).slice(0, 500)
    };
  }

  const output = {};

  for (const [key, value] of Object.entries(input)) {
    const lowerKey = String(key || '').toLowerCase();

    const isSensitive = SENSITIVE_KEYS.some((word) => lowerKey.includes(word));

    if (isSensitive) {
      output[key] = '[redacted]';
      continue;
    }

    if (value === null || value === undefined) {
      output[key] = '';
    } else if (typeof value === 'object') {
      try {
        output[key] = JSON.stringify(value).slice(0, 500);
      } catch {
        output[key] = '[unserializable]';
      }
    } else {
      output[key] = String(value).slice(0, 500);
    }
  }

  return output;
}

function getUserProfileOnce(uid) {
  if (!userProfilePromise) {
    userProfilePromise = get(ref(db, `users/${uid}`))
      .then((snapshot) => {
        if (!snapshot.exists()) return null;
        return snapshot.val();
      })
      .catch((err) => {
        console.error('Error loading user profile for activity logger:', err);
        return null;
      });
  }

  return userProfilePromise;
}

function getElementLabel(el) {
  if (!el) return '';

  const label =
    el.dataset?.activityLabel ||
    el.getAttribute?.('aria-label') ||
    el.textContent ||
    el.value ||
    el.id ||
    '';

  return String(label)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

/* =========================================
MAIN LOG FUNCTION
========================================= */

export async function logActivity(action, details = {}, meta = {}) {
  try {
    if (!action) return;

    const auth = getAuth();
    const user = auth.currentUser;

    if (!user) return;

    const profile = await getUserProfileOnce(user.uid);
    const { centerId, centerName } = getCenterContext();

    const now = new Date();

    const payload = {
      uid: user.uid,
      userName:
        meta.userName ||
        profile?.name ||
        profile?.englishName ||
        getStoredUserName() ||
        user.email ||
        '',
      userEmail: user.email || '',
      timestamp: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      time: now.toTimeString().slice(0, 8),
      centerId: meta.centerId || centerId || '',
      centerName: meta.centerName || centerName || '',
      page: meta.page || getPageName(),
      path: window.location.pathname,
      url: `${window.location.origin}${window.location.pathname}`,
      referrer: document.referrer || '',
      action: String(action),
      details: sanitizeDetails(details)
    };

    const newLogRef = push(ref(db, 'activityLogs'));
    await set(newLogRef, payload);
  } catch (err) {
    // Logging should never break the app.
    console.error('Activity logging failed:', err);
  }
}

/* =========================================
AUTO INITIALIZATION
========================================= */

export function initActivityLogger(options = {}) {
  const settings = {
    pageViews: true,
    explicitClicks: true,
    allClicks: false,
    formSubmits: true,
    ...options
  };

  const auth = getAuth();
  let pageViewSent = false;

  // Expose globally so future pages can call it easily.
  window.trackActivity = logActivity;

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    if (settings.pageViews && !pageViewSent) {
      pageViewSent = true;

      await logActivity('page_view', {
        title: document.title,
        referrer: document.referrer
      });
    }
  });

  // Track clicks.
  if (settings.explicitClicks || settings.allClicks) {
    document.addEventListener(
      'click',
      (event) => {
        try {
          const target = event.target;

          // Never log password areas or explicitly excluded areas.
          if (target.closest('input[type="password"], [data-no-activity]')) {
            return;
          }

          const el = target.closest(
            '[data-activity], button, a, input[type="submit"]'
          );

          if (!el) return;

          const explicitAction = el.dataset?.activity;

          // If allClicks is false, only log elements with data-activity.
          if (!explicitAction && !settings.allClicks) return;

          const action = explicitAction || 'click';
          const label = getElementLabel(el);

          // Avoid useless empty click logs.
          if (action === 'click' && !label) return;

          logActivity(action, {
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            id: el.id || '',
            label
          });
        } catch (err) {
          console.error('Activity click logger failed:', err);
        }
      },
      true
    );
  }

  // Track form submissions.
  if (settings.formSubmits) {
    document.addEventListener(
      'submit',
      (event) => {
        try {
          const form = event.target;

          if (!form) return;

          if (form.closest('[data-no-activity]')) return;

          const action = form.dataset?.activity || 'form_submit';

          logActivity(action, {
            formId: form.id || '',
            formName: form.getAttribute?.('name') || '',
            formAction: form.getAttribute?.('action') || '',
            method: form.method || ''
          });
        } catch (err) {
          console.error('Activity form logger failed:', err);
        }
      },
      true
    );
  }
}