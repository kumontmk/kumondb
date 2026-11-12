// centers.js — performance-optimized drop-in replacement
import { db, logout } from './auth.js';
import {
  ref,
  get,
  push,
  set,
  update,
  onValue,
  query,
  orderByChild,
  equalTo
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t, currentLanguage } from './centers-i18n.js';

const auth = getAuth();
const centerGrid = document.getElementById('centerGrid');
const centersLoader = document.getElementById('centersLoader');
const userEmailEl = document.getElementById('userEmail');
const pageLoader = document.getElementById('page-loader');

const MASTER_ADMIN_EMAIL = 'kumonchamps@gmail.com';

const PERF = {
  // How many past days to scan for missing clock-outs.
  // The old code scanned ALL history every load. Raise if needed.
  MISSING_CLOCKOUT_LOOKBACK_DAYS: 30,
  CACHE_TTL_MS: 10 * 60 * 1000,
  BACKGROUND_DELAY_MS: 250
};

// Open the database socket immediately so the DNS + TLS + WebSocket
// handshake overlaps the auth check instead of waiting for the first read.
try {
  onValue(ref(db, '.info/serverTimeOffset'), () => {}, { onlyOnce: true });
} catch (e) { /* non-fatal */ }

/* =========================================
SHARED READ CACHE (dedupes identical reads)
========================================= */
const onceCache = new Map();
const queryCache = new Map();

function getOnce(path) {
  if (!onceCache.has(path)) {
    onceCache.set(
      path,
      get(ref(db, path))
        .then((s) => (s.exists() ? s.val() : null))
        .catch((err) => {
          onceCache.delete(path);
          throw err;
        })
    );
  }
  return onceCache.get(path);
}

function getQueryOnce(key, q) {
  if (!queryCache.has(key)) {
    queryCache.set(
      key,
      get(q)
        .then((s) => (s.exists() ? s.val() : null))
        .catch((err) => {
          queryCache.delete(key);
          throw err;
        })
    );
  }
  return queryCache.get(key);
}

/* =========================================
SESSION CACHE (instant paint on revisit)
========================================= */
function readCache(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.ts || Date.now() - parsed.ts > PERF.CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...data, ts: Date.now() }));
  } catch { /* storage full/blocked — non-fatal */ }
}

/* =========================================
HELPERS
========================================= */
function getStoredUserName() {
  try {
    const storedUser = sessionStorage.getItem('kumonUser');
    if (storedUser) return JSON.parse(storedUser)?.name || '';
  } catch (err) {
    console.error('Error parsing kumonUser from sessionStorage:', err);
  }
  return '';
}

function getEmpPositions(obj) {
  if (!obj) return [];
  if (Array.isArray(obj.positions)) return obj.positions.filter(Boolean);
  if (obj.position) return [obj.position];
  return [];
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function hasManagementPosition(positions) {
  return positions.includes('manager') || positions.includes('master admin');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (s) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[s]));
}

function formatRequestedTimestamp(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function timestampMs(value) {
  const date = new Date(value);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}

function recentDateKeys(days) {
  const keys = [];
  const d = new Date();
  d.setDate(d.getDate() - 1); // start at yesterday, today is excluded
  for (let i = 0; i < days; i++) {
    keys.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() - 1);
  }
  return keys;
}

/* =========================================
GLOBAL STATE
========================================= */
let currentEmployeeId = null;
let isCurrentUserManager = false;
let currentUserIsAdmin = false;
let currentDisplayName = '';
let activeUid = null;

/* =========================================
IDENTITY — resolved ONCE, in parallel
========================================= */
async function findEmployeeByEmail(rawEmail) {
  const normalized = normalizeText(rawEmail);
  const variants = [...new Set([String(rawEmail || ''), normalized])].filter(Boolean);

  // Indexed lookup first (requires ".indexOn": ["email"] on employees).
  // Without the index Firebase still works, it just filters client-side.
  for (const v of variants) {
    try {
      const res = await getQueryOnce(
        `employees:email:${v}`,
        query(ref(db, 'employees'), orderByChild('email'), equalTo(v))
      );
      if (res) {
        const entry = Object.entries(res)[0];
        if (entry) return { id: entry[0], record: entry[1] };
      }
    } catch (err) {
      console.warn('Employee email lookup failed, trying fallback:', err);
    }
  }

  // Fallback preserves old behavior for emails stored with odd casing/spacing.
  try {
    const all = await getOnce('employees');
    if (all) {
      const found = Object.entries(all).find(
        ([, e]) => normalizeText(e?.email) === normalized
      );
      if (found) return { id: found[0], record: found[1] };
    }
  } catch (err) {
    console.warn('Employee fallback read failed:', err);
  }
  return null;
}

async function resolveIdentity(user, userData, empPromise) {
  const email = String(user.email || '').toLowerCase();
  const isAdmin = email === MASTER_ADMIN_EMAIL;

  let employeeId = user.uid;
  let empRecord = await empPromise;

  if (!empRecord && email) {
    const found = await findEmployeeByEmail(user.email);
    if (found) {
      employeeId = found.id;
      empRecord = found.record;
    }
  }

  let isManager = isAdmin;
  if (!isManager && userData?.isDisabled !== true) {
    const userPositions = getEmpPositions(userData).map((p) =>
      String(p).trim().toLowerCase()
    );
    if (hasManagementPosition(userPositions)) {
      isManager = true;
    } else if (empRecord && empRecord.isDisabled !== true) {
      const empPositions = getEmpPositions(empRecord).map((p) =>
        String(p).trim().toLowerCase()
      );
      if (hasManagementPosition(empPositions)) isManager = true;
    }
  }

  return { isAdmin, isManager, employeeId, empRecord };
}

/* =========================================
CENTERS GRID — live listener + cached paint
========================================= */
let centersSubscribed = false;
let centersResolved = false;
let centersFirstResolve;
const centersReady = new Promise((resolve) => { centersFirstResolve = resolve; });

const centersState = {
  snapshot: null,
  permissions: null,
  isAdmin: false
};
let accessibleCenters = [];

function renderCenterCards(list) {
  centerGrid.innerHTML = '';
  list.forEach(({ id, name }) => {
    const card = document.createElement('div');
    card.className = 'center-card';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      <div class="card-icon">🏢</div>
      <h3>${escapeHtml(name)}</h3>
      <p>${escapeHtml(t('centers.cardDescription'))}</p>
    `;
    card.addEventListener('click', () => {
      sessionStorage.setItem('selectedCenter', id);
      sessionStorage.setItem('selectedCenterName', name);
      window.location.href = 'dashboard.html';
    });
    centerGrid.appendChild(card);
  });
}

function saveCentersCache() {
  if (!activeUid || !centersResolved) return;
  writeCache(`kumonCentersCache:${activeUid}`, {
    name: currentDisplayName,
    isAdmin: currentUserIsAdmin,
    isManager: isCurrentUserManager,
    centers: accessibleCenters
  });
}

function renderCentersGrid() {
  if (!centersState.snapshot || !centersState.permissions) return;

  const list = [];
  Object.entries(centersState.snapshot).forEach(([centerId, centerData]) => {
    if (centerData?.isDisabled === true) return;
    if (centersState.isAdmin || centersState.permissions[centerId] === true) {
      list.push({ id: centerId, name: centerData?.name || centerId });
    }
  });

  accessibleCenters = list;

  if (list.length) {
    renderCenterCards(list);
  } else {
    centerGrid.innerHTML = `
      <div class="center-card" style="cursor: default; border-left: 4px solid #dc3545; grid-column: 1 / -1;">
        <div class="card-icon">🚫</div>
        <h3>${escapeHtml(t('centers.noAccessTitle'))}</h3>
        <p>${escapeHtml(t('centers.noAccessBody'))}</p>
      </div>
    `;
  }

  centersLoader?.classList.add('hidden');
  saveCentersCache();

  if (!centersResolved) {
    centersResolved = true;
    centersFirstResolve(list);
  }
}

function subscribeCenters() {
  if (centersSubscribed) return;
  centersSubscribed = true;
  onValue(
    ref(db, 'centers'),
    (snapshot) => {
      centersState.snapshot = snapshot.val() || {};
      renderCentersGrid();
    },
    (error) => {
      console.error('Error loading centers:', error);
      centersLoader?.classList.add('hidden');
      centerGrid.innerHTML = `
        <p style="text-align:center; color:#dc3545; grid-column: 1/-1;">
          ${escapeHtml(t('centers.errorLoading'))}
        </p>
      `;
      if (!centersResolved) {
        centersResolved = true;
        centersFirstResolve([]);
      }
    }
  );
}

function paintFromCache(user) {
  const c = readCache(`kumonCentersCache:${user.uid}`);
  if (c) {
    currentDisplayName = c.name || getStoredUserName() || user.email;
    if (userEmailEl) {
      userEmailEl.textContent = currentDisplayName;
      userEmailEl.title = user.email || '';
    }
    isCurrentUserManager = !!c.isManager;
    currentUserIsAdmin = !!c.isAdmin;
    document.body.classList.toggle('is-manager-or-admin', !!c.isManager);
    if (Array.isArray(c.centers) && c.centers.length) {
      renderCenterCards(c.centers);
      centersLoader?.classList.add('hidden');
    }
    pageLoader?.classList.add('hidden');
  }
  const b = readCache('kumonBulletinCache');
  if (b?.items?.length) renderBulletinItems(b.items);
}

/* =========================================
📢 BULLETIN + ANNOUNCEMENTS — ONE shared listener
========================================= */
let announcementsSubscribed = false;
let bulletinAnnouncements = {};

function getLang() {
  const l = typeof currentLanguage === 'function' ? currentLanguage() : currentLanguage;
  return l === 'zh-TW' ? 'zh-TW' : 'en';
}

function bulletinHtmlToPlainText(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = String(html || '').replace(/<[^>]*>/g, ' ');
  return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
}

function makeBulletinExcerpt(text, maxLen = 110) {
  if (!text) return '';
  return text.length <= maxLen ? text : text.slice(0, maxLen).trimEnd() + '…';
}

function formatBulletinDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  const locale = getLang() === 'zh-TW' ? 'zh-TW' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function normalizeTag(raw) {
  return String(raw || '').replace(/#/g, '').trim();
}

function hashTag(tag) {
  const s = String(tag || '').toLowerCase().trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function tagColorClass(tag) {
  return 'tag-color-' + (hashTag(tag) % 10);
}

function renderBulletinTagPills(tags) {
  if (!Array.isArray(tags)) return '';
  return tags
    .map(normalizeTag)
    .filter(Boolean)
    .map((tag) => `<span class="tag-pill ${tagColorClass(tag)}">#${escapeHtml(tag)}</span>`)
    .join('');
}

function bulletinCardTemplate(id, a) {
  const excerpt = a.excerpt ?? makeBulletinExcerpt(bulletinHtmlToPlainText(a.html));
  const tagsHtml = renderBulletinTagPills(a.hashtags);
  return `<a class="bulletin-card" href="announcements.html#announcement/${encodeURIComponent(id)}"> <div class="bulletin-card-top"> <span class="bulletin-card-title">${escapeHtml(a.title || '')}</span> <span class="bulletin-card-date">${escapeHtml(formatBulletinDate(a.createdAt))}</span> </div> ${tagsHtml ? `<div class="bulletin-card-tags">${tagsHtml}</div>` : ''} <p class="bulletin-card-excerpt">${escapeHtml(excerpt)}</p> <div class="bulletin-card-footer"> <span class="bulletin-card-author">👤 ${escapeHtml(a.createdByName || t('common.unknown'))}</span> <span class="bulletin-card-cta">${escapeHtml(t('bulletin.readMore'))}</span> </div> </a>`;
}

function renderBulletinItems(items) {
  const grid = document.getElementById('bulletinPreviewGrid');
  if (!grid) return;
  if (!items.length) {
    grid.innerHTML = `<div class="bulletin-empty">${escapeHtml(t('bulletin.empty'))}</div>`;
    return;
  }
  grid.innerHTML = items.map((i) => bulletinCardTemplate(i.id, i)).join('');
}

function renderBulletinSkeleton() {
  const grid = document.getElementById('bulletinPreviewGrid');
  if (!grid || grid.innerHTML.trim()) return;
  grid.innerHTML = Array(3).fill(`
    <div class="bulletin-card bulletin-skeleton">
      <div class="sk-line sk-title"></div>
      <div class="sk-line"></div>
      <div class="sk-line sk-short"></div>
    </div>
  `).join('');
}

function renderBulletinPreview() {
  const grid = document.getElementById('bulletinPreviewGrid');
  if (!grid) return;

  const latest = Object.entries(bulletinAnnouncements || {})
    .sort((a, b) => timestampMs(b[1]?.createdAt) - timestampMs(a[1]?.createdAt))
    .slice(0, 3);

  const items = latest.map(([id, a]) => ({
    id,
    title: a?.title || '',
    createdAt: a?.createdAt,
    createdByName: a?.createdByName,
    hashtags: a?.hashtags,
    excerpt: makeBulletinExcerpt(bulletinHtmlToPlainText(a?.html))
  }));

  renderBulletinItems(items);
  writeCache('kumonBulletinCache', { items });
}

function subscribeAnnouncements() {
  if (announcementsSubscribed) return;
  announcementsSubscribed = true;
  onValue(
    ref(db, 'announcements'),
    (snapshot) => {
      const data = snapshot.val() || {};
      bulletinAnnouncements = data;
      unifiedAnnouncementsCache = data;
      renderBulletinPreview();
      if (unifiedCurrentUserUid) processUnifiedNotifications();
    },
    (error) => {
      console.error('Error loading announcements:', error);
      const grid = document.getElementById('bulletinPreviewGrid');
      if (grid) {
        grid.innerHTML = `<div class="bulletin-empty">${escapeHtml(t('bulletin.loadFailed'))}</div>`;
      }
    }
  );
}

/* =========================================
EMPLOYEE MISSING CLOCK-OUT CHECK
Reads ONLY this user's last N days, not all history.
========================================= */
async function checkMissingClockOuts() {
  const user = auth.currentUser;
  if (!user) return { hasMissing: false };

  try {
    const dates = recentDateKeys(PERF.MISSING_CLOCKOUT_LOOKBACK_DAYS);

    const [dayValues, myVerifs] = await Promise.all([
      Promise.all(
        dates.map((date) =>
          getOnce(`timecards/${date}/${user.uid}`).catch(() => null)
        )
      ),
      getQueryOnce(
        `verifs:emp:${user.uid}`,
        query(ref(db, 'timecardVerifications'), orderByChild('empId'), equalTo(user.uid))
      ).catch(() => null)
    ]);

    const excludedVerificationKeys = new Set();
    Object.values(myVerifs || {}).forEach((v) => {
      if (v && (v.status === 'confirmed' || v.status === 'pending')) {
        excludedVerificationKeys.add(`${v.date}_${v.inTime}`);
      }
    });

    const missingRecords = [];
    dates.forEach((date, i) => {
      const empData = dayValues[i];
      if (!empData || !empData.logs) return;

      const rawLogs = Array.isArray(empData.logs) ? empData.logs : Object.values(empData.logs);
      const sortedLogs = [...rawLogs].sort((a, b) => String(a.time).localeCompare(String(b.time)));

      let currentIn = null;
      for (const log of sortedLogs) {
        if (log.type === 'in') {
          if (currentIn) {
            const recordKey = `${date}_${currentIn.time}`;
            if (!excludedVerificationKeys.has(recordKey)) {
              missingRecords.push({
                date,
                center: currentIn.location,
                inTime: currentIn.time,
                missingType: 'out'
              });
            }
          }
          currentIn = log;
        } else if (log.type === 'out') {
          // PAIRING v2: any clock-out closes the open clock-in,
          // even if recorded off-site or at a different center.
          if (currentIn) currentIn = null;
        }
      }
      if (currentIn) {
        const recordKey = `${date}_${currentIn.time}`;
        if (!excludedVerificationKeys.has(recordKey)) {
          missingRecords.push({
            date,
            center: currentIn.location,
            inTime: currentIn.time,
            missingType: 'out'
          });
        }
      }
    });

    if (missingRecords.length > 0) {
      return { hasMissing: true, onClose: showMissingClockOutModal(missingRecords) };
    }
    return { hasMissing: false };
  } catch (err) {
    console.error('Error checking missing clock-outs:', err);
    return { hasMissing: false };
  }
}

/* =========================================
MISSING CLOCK-OUT MODAL
========================================= */
function showMissingClockOutModal(records) {
  return new Promise((resolve) => {
    let modal = document.getElementById('missingClockOutModal');
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (modal) modal.style.display = 'none';
      resolve();
    };

    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'missingClockOutModal';
      modal.className = 'modal';
      modal.style.zIndex = '10000';
      modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px; text-align: left;">
          <button class="close-btn" id="closeMissingModalBtn" type="button">&times;</button>
          <h3 style="text-align: center; color: #dc3545; margin-bottom: 1rem;">
            ${escapeHtml(t('missing.title'))}
          </h3>
          <p style="color: #666; margin-bottom: 1.5rem; text-align: center;">
            ${escapeHtml(t('missing.intro'))}
          </p>
          <div id="missingRecordsList" style="max-height: 400px; overflow-y: auto; margin-bottom: 1rem;"></div>
          <div style="display:flex; gap:1rem; justify-content:flex-end;">
            <button class="secondary" id="remindLaterBtn" type="button">
              ${escapeHtml(t('missing.remindLater'))}
            </button>
            <button class="primary" id="submitMissingClockOutsBtn" type="button">
              ${escapeHtml(t('missing.submitForReview'))}
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    const closeBtn = document.getElementById('closeMissingModalBtn');
    const remindBtn = document.getElementById('remindLaterBtn');
    if (closeBtn) closeBtn.onclick = finish;
    if (remindBtn) remindBtn.onclick = finish;

    const list = document.getElementById('missingRecordsList');
    list.innerHTML = '';
    records.forEach((rec) => {
      const item = document.createElement('div');
      item.style.cssText = `
        padding: 0.75rem;
        background: #f8f9fa;
        border-radius: 6px;
        margin-bottom: 0.5rem;
        border: 1px solid #e2e8f0;
      `;
      item.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <span style="font-weight:600; color:#4682B4;">📅 ${escapeHtml(rec.date)}</span>
          <span style="font-size:0.85rem; color:#666;">📍 ${escapeHtml(rec.center || t('common.unknown'))}</span>
        </div>
        <div style="font-size:0.9rem; margin-bottom:0.5rem;">
          ${escapeHtml(t('missing.clockIn'))}: <strong>${escapeHtml(rec.inTime)}</strong> |
          ${escapeHtml(t('missing.missing'))}: <strong style="color:#dc3545;">${escapeHtml(t('missing.clockOut'))}</strong>
        </div>
        <label style="font-size:0.85rem; font-weight:500; display:block; margin-bottom:0.25rem;">
          ${escapeHtml(t('missing.proposedClockOut'))}
        </label>
        <input
          type="time"
          class="missing-time-input"
          data-emp-id="${escapeHtml(auth.currentUser.uid)}"
          data-date="${escapeHtml(rec.date)}"
          data-center="${escapeHtml(rec.center || '')}"
          data-in-time="${escapeHtml(rec.inTime)}"
          data-missing-type="${escapeHtml(rec.missingType)}"
          style="width:100%; padding:0.5rem; border:1px solid #cbd5e1; border-radius:4px;"
        >
      `;
      list.appendChild(item);
    });

    modal.style.display = 'flex';

    const submitBtn = document.getElementById('submitMissingClockOutsBtn');
    if (submitBtn) {
      const newSubmitBtn = submitBtn.cloneNode(true);
      submitBtn.parentNode.replaceChild(newSubmitBtn, submitBtn);
      newSubmitBtn.disabled = false;
      newSubmitBtn.textContent = t('missing.submitForReview');

      newSubmitBtn.addEventListener('click', async () => {
        const inputs = document.querySelectorAll('.missing-time-input');
        const recordsToSubmit = [];
        let hasError = false;
        let timeError = false;

        inputs.forEach((input) => {
          const time = input.value;
          const inTime = input.dataset.inTime;
          if (!time) {
            hasError = true;
            input.style.borderColor = '#dc3545';
          } else if (time <= inTime) {
            timeError = true;
            input.style.borderColor = '#dc3545';
          } else {
            input.style.borderColor = '#cbd5e1';
            recordsToSubmit.push({
              empId: input.dataset.empId,
              date: input.dataset.date,
              center: input.dataset.center,
              inTime,
              missingType: input.dataset.missingType,
              proposedTime: time
            });
          }
        });

        if (hasError) { alert(t('missing.fillAllMissing')); return; }
        if (timeError) { alert(t('missing.outAfterIn')); return; }

        newSubmitBtn.disabled = true;
        newSubmitBtn.textContent = t('missing.submitting');

        try {
          const userName = getStoredUserName();

          // ONE scoped read instead of one full-node read per record.
          const existingSnap = await get(
            query(
              ref(db, 'timecardVerifications'),
              orderByChild('empId'),
              equalTo(auth.currentUser.uid)
            )
          ).catch(() => null);

          const existingByKey = new Map();
          if (existingSnap?.exists()) {
            Object.entries(existingSnap.val()).forEach(([id, v]) => {
              if (v?.date && v?.inTime) existingByKey.set(`${v.date}_${v.inTime}`, id);
            });
          }

          for (const rec of recordsToSubmit) {
            const existingId = existingByKey.get(`${rec.date}_${rec.inTime}`) || null;
            const verificationData = {
              empId: rec.empId,
              empName: userName,
              date: rec.date,
              center: rec.center,
              inTime: rec.inTime,
              missingType: rec.missingType,
              proposedOutTime: rec.missingType === 'out' ? rec.proposedTime : '',
              status: 'pending',
              requestedAt: new Date().toISOString(),
              resubmittedAt: existingId ? new Date().toISOString() : null
            };
            if (existingId) {
              await update(ref(db, `timecardVerifications/${existingId}`), verificationData);
            } else {
              await set(push(ref(db, 'timecardVerifications')), verificationData);
            }
          }

          alert(t('missing.submittedSuccess'));
          finish();
        } catch (err) {
          console.error(err);
          alert(t('missing.submitFailed'));
        } finally {
          newSubmitBtn.disabled = false;
          newSubmitBtn.textContent = t('missing.submitForReview');
        }
      });
    }
  });
}

/* =========================================
MANAGER PENDING APPROVAL CHECK
Downloads only status=pending, names per-id.
========================================= */
async function checkPendingApprovals({ isAdmin = false, accessibleCenters = [], currentUser = null }) {
  try {
    const pendingMap = await getQueryOnce(
      'verifs:pending',
      query(ref(db, 'timecardVerifications'), orderByChild('status'), equalTo('pending'))
    ).catch(() => null);

    if (!pendingMap) return;

    // Resolve names with small per-employee reads instead of the full node.
    const uniqueEmpIds = [...new Set(Object.values(pendingMap).map((v) => v?.empId).filter(Boolean))];
    const employees = {};
    await Promise.all(
      uniqueEmpIds.map(async (id) => {
        try {
          const e = await getOnce(`employees/${id}`);
          if (e) employees[id] = e;
        } catch { /* fall back to empName saved on the verification */ }
      })
    );

    const accessibleCenterNames = new Set(accessibleCenters.map((c) => normalizeText(c.name)));
    const accessibleCenterIds = new Set(accessibleCenters.map((c) => c.id));

    const pending = Object.entries(pendingMap)
      .map(([id, v]) => {
        const emp = employees[v.empId] || {};
        const displayName = v.empName || emp.englishName || emp.name || v.empId || t('common.unknown');
        return { id, ...v, displayName };
      })
      .filter((v) => String(v.status || '').toLowerCase() === 'pending')
      .filter((v) => String(v.missingType || '').toLowerCase() === 'out' && v.proposedOutTime)
      .filter((v) => {
        if (isAdmin) return true;
        if (currentUser && v.empId === currentUser.uid) return true;
        const rawCenterId = String(v.centerId || '');
        if (rawCenterId && accessibleCenterIds.has(rawCenterId)) return true;
        const rawCenter = String(v.center || '');
        if (rawCenter && accessibleCenterIds.has(rawCenter)) return true;
        const centerName = normalizeText(rawCenter);
        return centerName && accessibleCenterNames.has(centerName);
      })
      .sort((a, b) => {
        const dateA = String(a.date || '');
        const dateB = String(b.date || '');
        if (dateA !== dateB) return dateB.localeCompare(dateA);
        const requestedA = String(a.requestedAt || a.resubmittedAt || '');
        const requestedB = String(b.requestedAt || b.resubmittedAt || '');
        if (requestedA !== requestedB) return requestedB.localeCompare(requestedA);
        return String(a.displayName || '').localeCompare(String(b.displayName || ''));
      });

    if (pending.length > 0) showPendingApprovalsModal(pending);
  } catch (err) {
    console.error('Error checking pending approvals:', err);
  }
}

/* =========================================
MANAGER PENDING APPROVAL MODAL
========================================= */
function showPendingApprovalsModal(records) {
  const existing = document.getElementById('pendingApprovalsModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'pendingApprovalsModal';
  modal.className = 'modal';
  modal.style.zIndex = '10001';
  modal.innerHTML = `<div class="modal-content pending-approvals-modal"> <button class="close-btn pending-close-btn" type="button">×</button> <h3 style="text-align:center; color:#4682B4; margin-bottom:1rem;"> ${escapeHtml(t('pending.title'))} </h3> <p style="color:#666; margin-bottom:1rem; text-align:center;"> ${escapeHtml(t('pending.intro'))} </p> <div class="pending-summary"> <span id="pendingApprovalCount" class="pending-count"></span> <span class="pending-hint">${escapeHtml(t('pending.hint'))}</span> </div> <div class="pending-table-wrapper"> <table class="pending-approvals-table"> <thead> <tr> <th> <input type="checkbox" id="selectAllPending" class="pending-checkbox"> </th> <th>${escapeHtml(t('pending.employee'))}</th> <th>${escapeHtml(t('pending.date'))}</th> <th>${escapeHtml(t('pending.center'))}</th> <th>${escapeHtml(t('pending.clockIn'))}</th> <th>${escapeHtml(t('pending.proposedOut'))}</th> <th>${escapeHtml(t('pending.requested'))}</th> <th>${escapeHtml(t('pending.actions'))}</th> </tr> </thead> <tbody id="pendingApprovalsTableBody"></tbody> </table> </div> <div class="pending-modal-actions"> <button class="secondary pending-close-btn" type="button"> ${escapeHtml(t('pending.close'))} </button> <button class="danger" id="denySelectedPendingBtn" type="button" disabled> ${escapeHtml(t('pending.denySelected'))} </button> <button class="primary" id="approveSelectedPendingBtn" type="button" disabled> ${escapeHtml(t('pending.approveSelected'))} </button> </div> </div>`;
  document.body.appendChild(modal);

  const tbody = modal.querySelector('#pendingApprovalsTableBody');
  const countEl = modal.querySelector('#pendingApprovalCount');
  const selectAll = modal.querySelector('#selectAllPending');
  const approveSelectedBtn = modal.querySelector('#approveSelectedPendingBtn');
  const denySelectedBtn = modal.querySelector('#denySelectedPendingBtn');

  function updateCount() {
    const remaining = tbody.querySelectorAll('tr.pending-row').length;
    countEl.textContent = `${remaining} ${t('pending.approvalLabel')}`;
    if (remaining === 0) {
      tbody.innerHTML = `
        <tr class="pending-empty-row">
          <td colspan="8">${escapeHtml(t('pending.noPending'))}</td>
        </tr>
      `;
      selectAll.checked = false;
      selectAll.indeterminate = false;
      selectAll.disabled = true;
      approveSelectedBtn.disabled = true;
      denySelectedBtn.disabled = true;
    } else {
      selectAll.disabled = false;
    }
  }

  function getSelectedIds() {
    return Array.from(modal.querySelectorAll('.pending-select:checked')).map((cb) => cb.value);
  }

  function updateBulkButtons() {
    const selected = getSelectedIds();
    approveSelectedBtn.disabled = selected.length === 0;
    denySelectedBtn.disabled = selected.length === 0;
    const boxes = Array.from(tbody.querySelectorAll('.pending-select:not(:disabled)'));
    selectAll.checked = boxes.length > 0 && boxes.every((cb) => cb.checked);
    selectAll.indeterminate = boxes.some((cb) => cb.checked) && !boxes.every((cb) => cb.checked);
  }

  records.forEach((rec) => {
    const tr = document.createElement('tr');
    tr.className = 'pending-row';
    tr.dataset.id = rec.id;
    const requested = formatRequestedTimestamp(rec.requestedAt || rec.resubmittedAt);
    tr.innerHTML = `
      <td><input type="checkbox" class="pending-select pending-checkbox" value="${escapeHtml(rec.id)}"></td>
      <td>${escapeHtml(rec.displayName || t('common.unknown'))}</td>
      <td>${escapeHtml(rec.date || '-')}</td>
      <td>${escapeHtml(rec.center || '-')}</td>
      <td>${escapeHtml(rec.inTime || '-')}</td>
      <td><strong>${escapeHtml(rec.proposedOutTime || '-')}</strong></td>
      <td>${escapeHtml(requested)}</td>
      <td>
        <div class="pending-row-actions">
          <button class="primary btn-small pending-approve-btn" type="button">${escapeHtml(t('pending.approve'))}</button>
          <button class="danger btn-small pending-deny-btn" type="button">${escapeHtml(t('pending.deny'))}</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  updateCount();
  updateBulkButtons();

  modal.querySelectorAll('.pending-close-btn').forEach((btn) => {
    btn.addEventListener('click', () => modal.remove());
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  selectAll.addEventListener('change', () => {
    modal.querySelectorAll('.pending-select:not(:disabled)').forEach((cb) => {
      cb.checked = selectAll.checked;
    });
    updateBulkButtons();
  });

  tbody.addEventListener('change', (e) => {
    if (e.target.classList.contains('pending-select')) updateBulkButtons();
  });

  approveSelectedBtn.addEventListener('click', async () => {
    const ids = getSelectedIds();
    if (ids.length === 0) return;
    if (!confirm(t('pending.confirmApproveSelected', { count: ids.length }))) return;
    approveSelectedBtn.disabled = true;
    denySelectedBtn.disabled = true;
    selectAll.disabled = true;
    for (const id of ids) {
      await processPendingVerification(id, true, { tbody, updateCount });
    }
    selectAll.disabled = tbody.querySelectorAll('tr.pending-row').length === 0;
    updateBulkButtons();
  });

  denySelectedBtn.addEventListener('click', async () => {
    const ids = getSelectedIds();
    if (ids.length === 0) return;
    if (!confirm(t('pending.confirmDenySelected', { count: ids.length }))) return;
    approveSelectedBtn.disabled = true;
    denySelectedBtn.disabled = true;
    selectAll.disabled = true;
    for (const id of ids) {
      await processPendingVerification(id, false, { tbody, updateCount });
    }
    selectAll.disabled = tbody.querySelectorAll('tr.pending-row').length === 0;
    updateBulkButtons();
  });

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const row = btn.closest('tr.pending-row');
    if (!row) return;
    const id = row.dataset.id;
    if (btn.classList.contains('pending-approve-btn')) {
      if (!confirm(t('pending.confirmApproveSingle'))) return;
      await processPendingVerification(id, true, { tbody, updateCount });
      updateBulkButtons();
    }
    if (btn.classList.contains('pending-deny-btn')) {
      if (!confirm(t('pending.confirmDenySingle'))) return;
      await processPendingVerification(id, false, { tbody, updateCount });
      updateBulkButtons();
    }
  });
}

/* =========================================
APPROVE / DENY PENDING VERIFICATION
========================================= */
async function processPendingVerification(id, approve, ui) {
  const row = ui?.tbody
    ? Array.from(ui.tbody.querySelectorAll('tr.pending-row')).find((r) => r.dataset.id === id)
    : null;
  const buttons = row ? Array.from(row.querySelectorAll('button')) : [];
  const checkbox = row ? row.querySelector('.pending-select') : null;

  try {
    buttons.forEach((b) => (b.disabled = true));
    if (checkbox) checkbox.disabled = true;

    const vSnap = await get(ref(db, `timecardVerifications/${id}`));
    if (!vSnap.exists()) {
      if (row) row.remove();
      if (ui?.updateCount) ui.updateCount();
      return;
    }

    const v = vSnap.val();
    if (String(v.status || '').toLowerCase() !== 'pending') {
      if (row) row.remove();
      if (ui?.updateCount) ui.updateCount();
      return;
    }

    if (approve) {
      const proposedOutTime = v.proposedOutTime;
      if (!v.date || !v.empId || !proposedOutTime) {
        throw new Error('Missing required verification data.');
      }
      const location = v.center || 'Manual Fix';

      await update(ref(db, `timecardVerifications/${id}`), {
        status: 'confirmed',
        resolvedBy: auth.currentUser?.uid || '',
        resolvedAt: new Date().toISOString(),
        actualOutTime: proposedOutTime
      });

      const daySnap = await get(ref(db, `timecards/${v.date}/${v.empId}`));
      let logs = daySnap.val()?.logs || [];
      if (!Array.isArray(logs)) logs = Object.values(logs);

      const alreadyExists = logs.some(
        (log) =>
          log?.type === 'out' &&
          log?.time === proposedOutTime &&
          normalizeText(log?.location) === normalizeText(location)
      );

      if (!alreadyExists) {
        logs.push({ type: 'out', time: proposedOutTime, location });
        logs.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
        await update(ref(db, `timecards/${v.date}/${v.empId}`), { logs });
      }
    } else {
      await update(ref(db, `timecardVerifications/${id}`), {
        status: 'denied',
        resolvedBy: auth.currentUser?.uid || '',
        resolvedAt: new Date().toISOString()
      });
    }

    if (row) row.remove();
    if (ui?.updateCount) ui.updateCount();
  } catch (err) {
    console.error('Error processing pending verification:', err);
    alert(t(approve ? 'pending.approveFailed' : 'pending.denyFailed'));
    buttons.forEach((b) => (b.disabled = false));
    if (checkbox) checkbox.disabled = false;
  }
}

/* =========================================
🔔 UNIFIED NOTIFICATIONS
========================================= */
let unifiedNotifications = [];
let unifiedLeavesCache = {};
let unifiedAnnouncementsCache = {};
let unifiedNotificationState = {};
let unifiedCurrentUserUid = null;
let unifiedNotifSubscribed = false;
let unifiedNotifUiBound = false;

function notifText(key, fallback) {
  try {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  } catch {
    return fallback;
  }
}

function escapeNotificationHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeNotificationKey(key) {
  // Firebase keys cannot contain . # $ [ ] /
  return String(key || '').replace(/[.#$/[\]]/g, '_');
}

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getNotificationReadAllAt(category) {
  return Number(unifiedNotificationState?.[`readAllAt_${category}`] || 0);
}

function getNotificationClearedAt() {
  return Number(unifiedNotificationState?.clearedAt || 0);
}

function isNotificationRead(id, time, category) {
  if (time <= getNotificationReadAllAt(category)) return true;
  const reads = unifiedNotificationState?.read || {};
  return reads[safeNotificationKey(id)] === true;
}

function isNotificationCleared(time) {
  return time <= getNotificationClearedAt();
}

function buildLeaveNotificationItems() {
  const items = [];
  Object.entries(unifiedLeavesCache || {}).forEach(([leaveId, leave]) => {
    if (!leave || !leave.status || !leave.empId) return;
    const status = normalizeText(leave.status);
    if (!['pending', 'approved', 'rejected'].includes(status)) return;

    if (!isCurrentUserManager) {
      if (leave.empId !== currentEmployeeId) return;
      if (status !== 'approved' && status !== 'rejected') return;
    }

    const appliedAt = timestampMs(leave.appliedAt);
    const reviewedAt = timestampMs(leave.reviewedAt);
    const eventTime = status === 'pending' ? (appliedAt || reviewedAt) : (reviewedAt || appliedAt);
    if (!eventTime) return;
    if (isNotificationCleared(eventTime)) return;

    const notificationId = `leave:${leaveId}:${status}`;
    let icon = '📝';
    let statusLabel = notifText('notifications.newApplication', 'New Application');
    if (status === 'approved') {
      icon = '✅';
      statusLabel = notifText('notifications.approved', 'Approved');
    }
    if (status === 'rejected') {
      icon = '❌';
      statusLabel = notifText('notifications.rejected', 'Rejected');
    }

    const leaveTypeLabel = leave.typeLabel || leave.type || notifText('notifications.leave', 'Leave');
    const title = isCurrentUserManager
      ? (leave.empName || notifText('common.unknown', 'Unknown'))
      : notifText('notifications.yourLeave', 'Your leave');

    let desc;
    if (!isCurrentUserManager) {
      desc = status === 'approved'
        ? notifText('notifications.yourLeaveApproved', 'Your leave was approved')
        : notifText('notifications.yourLeaveRejected', 'Your leave was rejected');
    } else {
      desc = `${statusLabel} · ${leaveTypeLabel}`;
    }

    items.push({
      id: notificationId,
      category: 'leave',
      time: eventTime,
      isUnread: !isNotificationRead(notificationId, eventTime, 'leave'),
      icon,
      title,
      desc,
      meta: `${leave.dateFrom || '?'} → ${leave.dateTo || '?'} · ${getTimeAgo(eventTime)}`,
      route: 'leave.html'
    });
  });
  return items;
}

function buildAnnouncementNotificationItems() {
  const items = [];
  Object.entries(unifiedAnnouncementsCache || {}).forEach(([announcementId, announcement]) => {
    if (!announcement) return;
    const time = timestampMs(announcement.createdAt);
    if (!time) return;
    if (isNotificationCleared(time)) return;

    const notificationId = `announcement:${announcementId}`;
    const excerpt = makeBulletinExcerpt(bulletinHtmlToPlainText(announcement.html), 120);
    const author = announcement.createdByName ? `${announcement.createdByName} · ` : '';

    items.push({
      id: notificationId,
      category: 'announcement',
      time,
      isUnread: !isNotificationRead(notificationId, time, 'announcement'),
      icon: '📣',
      title: announcement.title || notifText('notifications.announcement', 'Announcement'),
      desc: excerpt || notifText('notifications.newAnnouncement', 'New announcement'),
      meta: `${author}${getTimeAgo(time)}`,
      route: `announcements.html#announcement/${encodeURIComponent(announcementId)}`
    });
  });
  return items;
}

function processUnifiedNotifications() {
  const items = [...buildLeaveNotificationItems(), ...buildAnnouncementNotificationItems()]
    .sort((a, b) => b.time - a.time);
  unifiedNotifications = items;

  const unreadCount = items.filter((item) => item.isUnread).length;
  const badge = document.getElementById('leaveNotifBadge');
  if (badge) {
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  }
  renderUnifiedNotifications();
}

function renderUnifiedNotifications() {
  const list = document.getElementById('leaveNotifList');
  if (!list) return;
  list.innerHTML = '';

  if (!unifiedNotifications.length) {
    list.innerHTML = `<div class="notif-empty">${escapeNotificationHtml(notifText('notifications.empty', 'No notifications'))}</div>`;
    return;
  }

  unifiedNotifications.forEach((notification) => {
    const item = document.createElement('div');
    item.className = `notif-item ${notification.isUnread ? 'unread' : ''} ${notification.category}`;
    item.innerHTML = `
      <div class="notif-icon">${notification.icon}</div>
      <div class="notif-content">
        <div class="notif-title">${escapeNotificationHtml(notification.title)}</div>
        <div class="notif-desc">${escapeNotificationHtml(notification.desc)}</div>
        <div class="notif-meta">${escapeNotificationHtml(notification.meta)}</div>
      </div>
    `;
    item.addEventListener('click', () => handleNotificationClick(notification));
    list.appendChild(item);
  });
}

async function handleNotificationClick(notification) {
  if (notification.isUnread) {
    await markSingleNotificationRead(notification.id, notification.time, notification.category);
  }
  if (notification.route) window.location.href = notification.route;
}

async function markSingleNotificationRead(notificationId, notificationTime, category) {
  const key = safeNotificationKey(notificationId);
  if (notificationTime <= getNotificationReadAllAt(category)) return;

  unifiedNotificationState = {
    ...unifiedNotificationState,
    read: { ...(unifiedNotificationState?.read || {}), [key]: true }
  };
  processUnifiedNotifications();

  if (!unifiedCurrentUserUid) return;
  try {
    await update(ref(db, `users/${unifiedCurrentUserUid}/notificationState`), {
      [`read/${key}`]: true
    });
  } catch (err) {
    console.error('Error marking notification as read:', err);
  }
}

async function markAllNotificationsRead() {
  const now = Date.now();
  const updates = { readAllAt_leave: now, readAllAt_announcement: now };
  unifiedNotificationState = { ...unifiedNotificationState, ...updates };
  processUnifiedNotifications();

  if (!unifiedCurrentUserUid) return;
  try {
    await update(ref(db, `users/${unifiedCurrentUserUid}/notificationState`), updates);
  } catch (err) {
    console.error('Error marking all notifications as read:', err);
  }
}

async function clearAllNotifications() {
  const now = Date.now();
  const updates = {
    clearedAt: now,
    readAllAt_leave: now,
    readAllAt_announcement: now,
    read: null
  };
  unifiedNotificationState = {
    ...unifiedNotificationState,
    clearedAt: now,
    readAllAt_leave: now,
    readAllAt_announcement: now,
    read: {}
  };
  processUnifiedNotifications();

  if (!unifiedCurrentUserUid) return;
  try {
    await update(ref(db, `users/${unifiedCurrentUserUid}/notificationState`), updates);
  } catch (err) {
    console.error('Error clearing notifications:', err);
  }
}

function setupUnifiedNotifUI() {
  if (unifiedNotifUiBound) return;
  const btn = document.getElementById('leaveNotifBtn');
  const dropdown = document.getElementById('leaveNotifDropdown');
  if (!btn || !dropdown) return;

  const titleEl = document.getElementById('unifiedNotifTitle') || dropdown.querySelector('.notif-header h4');
  if (titleEl) titleEl.textContent = notifText('notifications.title', 'Notifications');

  const markAllBtn = document.getElementById('markAllReadBtn');
  let clearAllBtn = document.getElementById('clearAllNotifsBtn');

  if (markAllBtn) {
    let actionsWrap = markAllBtn.closest('.notif-header-actions');
    if (!actionsWrap) {
      actionsWrap = document.createElement('div');
      actionsWrap.className = 'notif-header-actions';
      markAllBtn.insertAdjacentElement('beforebegin', actionsWrap);
      actionsWrap.appendChild(markAllBtn);
    }
    if (!clearAllBtn) {
      clearAllBtn = document.createElement('button');
      clearAllBtn.id = 'clearAllNotifsBtn';
      clearAllBtn.type = 'button';
      clearAllBtn.className = 'mark-read-btn';
      actionsWrap.appendChild(clearAllBtn);
    }
    markAllBtn.textContent = notifText('notifications.markAllRead', 'Mark all read');
    markAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      markAllNotificationsRead();
    });
  }

  if (clearAllBtn) {
    clearAllBtn.textContent = notifText('notifications.clearAll', 'Clear all');
    clearAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearAllNotifications();
    });
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });

  unifiedNotifUiBound = true;
}

function initUnifiedNotifications(user) {
  if (!user) return;
  unifiedCurrentUserUid = user.uid;
  setupUnifiedNotifUI();
  processUnifiedNotifications();

  if (unifiedNotifSubscribed) return;
  unifiedNotifSubscribed = true;

  // Employees only download their own leaves; managers keep the full view.
  const leavesSource = isCurrentUserManager
    ? ref(db, 'leaves')
    : query(ref(db, 'leaves'), orderByChild('empId'), equalTo(currentEmployeeId || user.uid));

  onValue(
    leavesSource,
    (snapshot) => {
      unifiedLeavesCache = snapshot.val() || {};
      processUnifiedNotifications();
    },
    (error) => console.error('Error loading leaves for notifications:', error)
  );

  // Announcements arrive through the shared listener in subscribeAnnouncements().

  onValue(
    ref(db, `users/${user.uid}/notificationState`),
    (snapshot) => {
      const existing = snapshot.val() || {};
      const now = Date.now();
      const updates = {};

      if (!snapshot.exists()) {
        const oldLeaveLastSeen = parseInt(localStorage.getItem('leaveNotifLastSeen') || '0', 10);
        updates.readAllAt_leave = oldLeaveLastSeen || now;
        updates.readAllAt_announcement = now;
      } else {
        if (typeof existing.readAllAt_leave !== 'number') {
          const oldLeaveLastSeen = parseInt(localStorage.getItem('leaveNotifLastSeen') || '0', 10);
          updates.readAllAt_leave = oldLeaveLastSeen || now;
        }
        if (typeof existing.readAllAt_announcement !== 'number') {
          updates.readAllAt_announcement = now;
        }
      }

      if (Object.keys(updates).length > 0) {
        unifiedNotificationState = { ...existing, ...updates };
        processUnifiedNotifications();
        update(ref(db, `users/${user.uid}/notificationState`), updates)
          .then(() => localStorage.removeItem('leaveNotifLastSeen'))
          .catch((err) => console.error('Error bootstrapping notification state:', err));
      } else {
        unifiedNotificationState = existing;
        processUnifiedNotifications();
      }
    },
    (error) => console.error('Error loading notification state:', error)
  );
}

/* =========================================
BACKGROUND WORK — runs after first paint
========================================= */
function scheduleBackground(fn) {
  const run = () => setTimeout(fn, PERF.BACKGROUND_DELAY_MS);
  if ('requestIdleCallback' in window) {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 300);
  }
}

async function runBackgroundChecks(user, identity) {
  const missing = await checkMissingClockOuts();
  if (identity.isManager) {
    const centers = await centersReady;
    const openPendingApprovals = () =>
      checkPendingApprovals({
        isAdmin: identity.isAdmin,
        accessibleCenters: centers,
        currentUser: user
      });
    if (missing?.hasMissing && missing.onClose) {
      missing.onClose.then(openPendingApprovals).catch(() => {});
    } else {
      openPendingApprovals();
    }
  }
}

/* =========================================
PAGE INIT — parallel, cached, non-blocking
========================================= */
function startCentersPage() {
  document.querySelector('.language-switch')?.addEventListener('change', () => {
    setTimeout(() => {
      renderBulletinPreview();
      renderUnifiedNotifications();
    }, 0);
  });

  renderBulletinSkeleton();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = 'index.html';
      return;
    }
    activeUid = user.uid;

    // 1) Fire independent reads and listeners in parallel — no waiting chain.
    const userP = getOnce(`users/${user.uid}`);
    const empP = getOnce(`employees/${user.uid}`).catch(() => null);
    subscribeCenters();
    subscribeAnnouncements();

    // 2) Instant paint from session cache while the network responds.
    paintFromCache(user);

    document.getElementById('logoutBtn')?.addEventListener('click', logout);

    try {
      const userData = await userP;
      if (userData === null) {
        console.error('User profile not found');
        window.location.href = 'index.html';
        return;
      }

      currentDisplayName =
        userData?.name || userData?.englishName || getStoredUserName() || user.email;
      if (userEmailEl) {
        userEmailEl.textContent = currentDisplayName;
        userEmailEl.title = user.email || '';
      }

      // 3) Grid access only needs the profile + email — render immediately.
      currentUserIsAdmin = String(user.email || '').toLowerCase() === MASTER_ADMIN_EMAIL;
      centersState.isAdmin = currentUserIsAdmin;
      centersState.permissions = userData.permissions?.centers || {};
      renderCentersGrid();
      pageLoader?.classList.add('hidden');

      // 4) Role + employee ID resolved once (reuses the parallel employee read).
      const identity = await resolveIdentity(user, userData, empP);
      currentEmployeeId = identity.employeeId;
      isCurrentUserManager = identity.isManager;
      currentUserIsAdmin = identity.isAdmin;
      document.body.classList.toggle('is-manager-or-admin', identity.isManager);
      saveCentersCache();

      // 5) Notifications for everyone.
      initUnifiedNotifications(user);

      // 6) Heavy checks run after the page is already usable.
      scheduleBackground(() => runBackgroundChecks(user, identity));
    } catch (error) {
      console.error('Error loading centers page:', error);
      pageLoader?.classList.add('hidden');
      centersLoader?.classList.add('hidden');
      centerGrid.innerHTML = `
        <p style="text-align:center; color:#dc3545; grid-column: 1/-1;">
          ${escapeHtml(t('centers.errorLoading'))}
        </p>
      `;
    }
  });
}

/* =========================================
START PAGE AFTER I18N READY
========================================= */
i18nReady
  .then(() => startCentersPage())
  .catch((err) => {
    console.error('i18n failed, starting centers page anyway:', err);
    startCentersPage();
  });