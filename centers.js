// centers.js

import { db, logout } from './auth.js';

import {
  ref,
  get,
  push,
  set,
  update
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  i18nReady,
  t
} from './centers-i18n.js';

const auth = getAuth();

const centerGrid = document.getElementById('centerGrid');
const centersLoader = document.getElementById('centersLoader');
const userEmailEl = document.getElementById('userEmail');
const pageLoader = document.getElementById('page-loader');

/* =========================================
   HELPERS
========================================= */

function getEmpPositions(obj) {
  if (!obj) return [];

  if (Array.isArray(obj.positions)) {
    return obj.positions.filter(Boolean);
  }

  if (obj.position) {
    return [obj.position];
  }

  return [];
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function hasManagementPosition(positions) {
  return (
    positions.includes('manager') ||
    positions.includes('master admin') ||
    positions.includes('admin') ||
    positions.includes('administrator')
  );
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

async function isManagerUser(user, userData) {
  if (!user) return false;

  const email = user.email?.toLowerCase() || '';

  // Master admin email
  if (email === 'kumonchamps@gmail.com') return true;

  // Disabled users should not receive manager notifications
  if (userData?.isDisabled === true) return false;

  // Check positions inside users/{uid}
  const positions = getEmpPositions(userData).map(
    (p) => String(p).trim().toLowerCase()
  );

  if (hasManagementPosition(positions)) {
    return true;
  }

  try {
    // Fallback: check employees/{uid}
    const empUidSnap = await get(ref(db, `employees/${user.uid}`));

    if (empUidSnap.exists()) {
      const emp = empUidSnap.val();

      if (emp?.isDisabled !== true) {
        const empPositions = getEmpPositions(emp).map(
          (p) => String(p).trim().toLowerCase()
        );

        if (
          empPositions.includes('manager') ||
          empPositions.includes('master admin')
        ) {
          return true;
        }
      }
    }

    // Fallback: find employee record by email
    if (email) {
      const empSnap = await get(ref(db, 'employees'));

      if (empSnap.exists()) {
        const matchingEmp = Object.values(empSnap.val()).find(
          (e) => normalizeText(e.email) === email
        );

        if (matchingEmp && matchingEmp.isDisabled !== true) {
          const empPositions = getEmpPositions(matchingEmp).map(
            (p) => String(p).trim().toLowerCase()
          );

          if (
            empPositions.includes('manager') ||
            empPositions.includes('master admin')
          ) {
            return true;
          }
        }
      }
    }
  } catch (err) {
    console.error('Error checking manager role:', err);
  }

  return false;
}

/* =========================================
   PAGE INIT
========================================= */

function startCentersPage() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = 'index.html';
      return;
    }
    if (userEmailEl) userEmailEl.textContent = user.email;
    document.getElementById('logoutBtn')?.addEventListener('click', logout);

    try {
      // 1) Fast profile check (single read) — keeps existing redirects
      const userSnap = await get(ref(db, `users/${user.uid}`));
      if (!userSnap.exists()) {
        console.error("User profile not found");
        window.location.href = 'index.html';
        return;
      }
      const userData = userSnap.val();
      const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';

      // 🛡️ ROLE CHECK: Show admin-only cards only for managers/admins
      const isManagerOrAdmin = await isManagerUser(user, userData);
      if (isManagerOrAdmin) {
        document.body.classList.add('is-manager-or-admin');
      }

      const userPermissions = userData.permissions?.centers || {};

      // 2) ⚡ Page is interactive NOW — admin cards tappable immediately
      pageLoader?.classList.add('hidden');

      // 3) Centers load independently at the bottom (own spinner)
      const centersPromise = loadCentersGrid(user, userData, isAdmin);

      // 4) Missing clock-outs (does not need centers)
      const missingClockOutResult = await checkMissingClockOuts();

      // 5) Manager pending approvals (waits for centers list internally)
      const isManager = await isManagerUser(user, userData);
      if (isManager) {
        const accessibleCenters = await centersPromise;
        const openPendingApprovals = () => {
          checkPendingApprovals({ isAdmin, accessibleCenters, currentUser: user });
        };
        if (missingClockOutResult?.hasMissing && missingClockOutResult.onClose) {
          missingClockOutResult.onClose
            .then(openPendingApprovals)
            .catch(() => {});
        } else {
          openPendingApprovals();
        }
      }
    } catch (error) {
      console.error("Error loading centers page:", error);
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
   CENTERS GRID — independent loader at the bottom
   ========================================= */
async function loadCentersGrid(user, userData, isAdmin) {
  try {
    const userPermissions = userData.permissions?.centers || {};
    const centersSnap = await get(ref(db, 'centers'));

    if (!centersSnap.exists()) {
      centerGrid.innerHTML = `
        <p style="text-align:center; color:#666; grid-column: 1/-1;">
          ${escapeHtml(t('centers.noCenters'))}
        </p>
      `;
      centersLoader?.classList.add('hidden');
      return [];
    }

    const allCenters = centersSnap.val();
    centerGrid.innerHTML = '';
    let hasVisibleCenters = false;
    const accessibleCenters = [];

    Object.entries(allCenters).forEach(([centerId, centerData]) => {
      const hasAccess = isAdmin || userPermissions[centerId] === true;
      if (hasAccess) {
        hasVisibleCenters = true;
        accessibleCenters.push({ id: centerId, name: centerData.name || centerId });
        const card = document.createElement('div');
        card.className = 'center-card';
        card.style.cursor = 'pointer';
        card.innerHTML = `
          <div class="card-icon">🏢</div>
          <h3>${escapeHtml(centerData.name || centerId)}</h3>
          <p>${escapeHtml(t('centers.cardDescription'))}</p>
        `;
        card.addEventListener('click', () => {
          sessionStorage.setItem('selectedCenter', centerId);
          window.location.href = 'dashboard.html';
        });
        centerGrid.appendChild(card);
      }
    });

    if (!hasVisibleCenters) {
      centerGrid.innerHTML = `
        <div class="center-card" style="cursor: default; border-left: 4px solid #dc3545; grid-column: 1 / -1;">
          <div class="card-icon">🚫</div>
          <h3>${escapeHtml(t('centers.noAccessTitle'))}</h3>
          <p>${escapeHtml(t('centers.noAccessBody'))}</p>
        </div>
      `;
    }

    centersLoader?.classList.add('hidden');
    return accessibleCenters;
  } catch (err) {
    console.error("Error loading centers:", err);
    centerGrid.innerHTML = `
      <p style="text-align:center; color:#dc3545; grid-column: 1/-1;">
        ${escapeHtml(t('centers.errorLoading'))}
      </p>
    `;
    centersLoader?.classList.add('hidden');
    return [];
  }
}

/* =========================================
   EMPLOYEE / MANAGER MISSING CLOCK-OUT CHECK
========================================= */

async function checkMissingClockOuts() {
  const user = auth.currentUser;

  if (!user) {
    return {
      hasMissing: false
    };
  }

  const today = new Date().toISOString().split('T')[0];

  try {
    const [timecardsSnap, verificationsSnap] = await Promise.all([
      get(ref(db, 'timecards')),
      get(ref(db, 'timecardVerifications'))
    ]);

    if (!timecardsSnap.exists()) {
      console.log("No timecards found in database.");

      return {
        hasMissing: false
      };
    }

    const timecards = timecardsSnap.val();
    const verifications = verificationsSnap.exists()
      ? verificationsSnap.val()
      : {};

    // Exclude CONFIRMED and PENDING.
    // DENIED can appear again so employee can resubmit.
    const excludedVerificationKeys = new Set();

    Object.entries(verifications).forEach(([id, v]) => {
      if (
        v.empId === user.uid &&
        (v.status === 'confirmed' || v.status === 'pending')
      ) {
        excludedVerificationKeys.add(`${v.date}_${v.inTime}`);
      }
    });

    const missingRecords = [];

    Object.entries(timecards).forEach(([date, dayData]) => {
      if (date >= today) return; // Ignore today's records

      const empData = dayData[user.uid];

      if (!empData || !empData.logs) return;

      const rawLogs = Array.isArray(empData.logs)
        ? empData.logs
        : Object.values(empData.logs);

      const sortedLogs = [...rawLogs].sort((a, b) =>
        a.time.localeCompare(b.time)
      );

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
          if (currentIn && currentIn.location === log.location) {
            currentIn = null; // Valid pair found
          }
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

    console.log("Missing records detected for modal:", missingRecords);

    if (missingRecords.length > 0) {
      return {
        hasMissing: true,
        onClose: showMissingClockOutModal(missingRecords)
      };
    }

    return {
      hasMissing: false
    };
  } catch (err) {
    console.error("Error checking missing clock-outs:", err);

    return {
      hasMissing: false
    };
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

      if (modal) {
        modal.style.display = 'none';
      }

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

          <div
            id="missingRecordsList"
            style="max-height: 400px; overflow-y: auto; margin-bottom: 1rem;"
          ></div>

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
          <span style="font-weight:600; color:#4682B4;">
            📅 ${escapeHtml(rec.date)}
          </span>

          <span style="font-size:0.85rem; color:#666;">
            📍 ${escapeHtml(rec.center || t('common.unknown'))}
          </span>
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
              inTime: inTime,
              missingType: input.dataset.missingType,
              proposedTime: time
            });
          }
        });

        if (hasError) {
          alert(t('missing.fillAllMissing'));
          return;
        }

        if (timeError) {
          alert(t('missing.outAfterIn'));
          return;
        }

        newSubmitBtn.disabled = true;
        newSubmitBtn.textContent = t('missing.submitting');

        try {
          let userName = '';

          try {
            const storedUser = sessionStorage.getItem('kumonUser');

            if (storedUser) {
              userName = JSON.parse(storedUser)?.name || '';
            }
          } catch (parseErr) {
            console.error(
              'Error parsing kumonUser from sessionStorage:',
              parseErr
            );
          }

          for (const rec of recordsToSubmit) {
            const verificationsSnap = await get(ref(db, 'timecardVerifications'));

            let existingId = null;

            if (verificationsSnap.exists()) {
              const verifications = verificationsSnap.val();

              Object.entries(verifications).forEach(([id, v]) => {
                if (
                  v.empId === rec.empId &&
                  v.date === rec.date &&
                  v.inTime === rec.inTime
                ) {
                  existingId = id;
                }
              });
            }

            const verificationData = {
              empId: rec.empId,
              empName: userName,
              date: rec.date,
              center: rec.center,
              inTime: rec.inTime,
              missingType: rec.missingType,
              proposedOutTime:
                rec.missingType === 'out' ? rec.proposedTime : '',
              status: 'pending',
              requestedAt: new Date().toISOString(),
              resubmittedAt: existingId ? new Date().toISOString() : null
            };

            if (existingId) {
              await update(
                ref(db, `timecardVerifications/${existingId}`),
                verificationData
              );
            } else {
              const newRef = push(ref(db, 'timecardVerifications'));
              await set(newRef, verificationData);
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
========================================= */

async function checkPendingApprovals({
  isAdmin = false,
  accessibleCenters = [],
  currentUser = null
}) {
  try {
    const verificationsSnap = await get(ref(db, 'timecardVerifications'));

    if (!verificationsSnap.exists()) {
      return;
    }

    const verifications = verificationsSnap.val() || {};

    // Try to load employee names.
    // If database rules prevent this, fall back to empName saved in verification.
    let employees = {};

    try {
      const employeesSnap = await get(ref(db, 'employees'));

      if (employeesSnap.exists()) {
        employees = employeesSnap.val() || {};
      }
    } catch (employeeErr) {
      console.warn(
        'Could not load employee names for pending approvals:',
        employeeErr
      );
    }

    const accessibleCenterNames = new Set(
      accessibleCenters.map((c) => normalizeText(c.name))
    );

    const accessibleCenterIds = new Set(
      accessibleCenters.map((c) => c.id)
    );

    const pending = Object.entries(verifications)
      .map(([id, v]) => {
        const emp = employees[v.empId] || {};

        const displayName =
          v.empName ||
          emp.englishName ||
          emp.name ||
          v.empId ||
          t('common.unknown');

        return {
          id,
          ...v,
          displayName
        };
      })
      .filter((v) => String(v.status || '').toLowerCase() === 'pending')
      .filter(
        (v) =>
          String(v.missingType || '').toLowerCase() === 'out' &&
          v.proposedOutTime
      )
      .filter((v) => {
        // Admin sees all
        if (isAdmin) return true;

        // Manager can approve their own pending proposed clock-out,
        // even if center cannot be matched to a center permission.
        if (currentUser && v.empId === currentUser.uid) return true;

        // If future code saves centerId directly on verification
        const rawCenterId = String(v.centerId || '');

        if (rawCenterId && accessibleCenterIds.has(rawCenterId)) {
          return true;
        }

        // Sometimes center may be saved as center ID instead of center name
        const rawCenter = String(v.center || '');

        if (rawCenter && accessibleCenterIds.has(rawCenter)) {
          return true;
        }

        // Match by center name
        const centerName = normalizeText(rawCenter);

        return centerName && accessibleCenterNames.has(centerName);
      })
      .sort((a, b) => {
        const dateA = String(a.date || '');
        const dateB = String(b.date || '');

        if (dateA !== dateB) {
          return dateB.localeCompare(dateA);
        }

        const requestedA = String(a.requestedAt || a.resubmittedAt || '');
        const requestedB = String(b.requestedAt || b.resubmittedAt || '');

        if (requestedA !== requestedB) {
          return requestedB.localeCompare(requestedA);
        }

        return String(a.displayName || '').localeCompare(
          String(b.displayName || '')
        );
      });

    if (pending.length > 0) {
      showPendingApprovalsModal(pending);
    }
  } catch (err) {
    console.error('Error checking pending approvals:', err);
  }
}

/* =========================================
   MANAGER PENDING APPROVAL MODAL
========================================= */

function showPendingApprovalsModal(records) {
  const existing = document.getElementById('pendingApprovalsModal');

  if (existing) {
    existing.remove();
  }

  const modal = document.createElement('div');

  modal.id = 'pendingApprovalsModal';
  modal.className = 'modal';
  modal.style.zIndex = '10001';

  modal.innerHTML = `
    <div class="modal-content pending-approvals-modal">
      <button class="close-btn pending-close-btn" type="button">×</button>

      <h3 style="text-align:center; color:#4682B4; margin-bottom:1rem;">
        ${escapeHtml(t('pending.title'))}
      </h3>

      <p style="color:#666; margin-bottom:1rem; text-align:center;">
        ${escapeHtml(t('pending.intro'))}
      </p>

      <div class="pending-summary">
        <span id="pendingApprovalCount" class="pending-count"></span>
        <span class="pending-hint">${escapeHtml(t('pending.hint'))}</span>
      </div>

      <div class="pending-table-wrapper">
        <table class="pending-approvals-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  id="selectAllPending"
                  class="pending-checkbox"
                >
              </th>
              <th>${escapeHtml(t('pending.employee'))}</th>
              <th>${escapeHtml(t('pending.date'))}</th>
              <th>${escapeHtml(t('pending.center'))}</th>
              <th>${escapeHtml(t('pending.clockIn'))}</th>
              <th>${escapeHtml(t('pending.proposedOut'))}</th>
              <th>${escapeHtml(t('pending.requested'))}</th>
              <th>${escapeHtml(t('pending.actions'))}</th>
            </tr>
          </thead>

          <tbody id="pendingApprovalsTableBody"></tbody>
        </table>
      </div>

      <div class="pending-modal-actions">
        <button class="secondary pending-close-btn" type="button">
          ${escapeHtml(t('pending.close'))}
        </button>

        <button class="danger" id="denySelectedPendingBtn" type="button" disabled>
          ${escapeHtml(t('pending.denySelected'))}
        </button>

        <button class="primary" id="approveSelectedPendingBtn" type="button" disabled>
          ${escapeHtml(t('pending.approveSelected'))}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const tbody = modal.querySelector('#pendingApprovalsTableBody');
  const countEl = modal.querySelector('#pendingApprovalCount');
  const selectAll = modal.querySelector('#selectAllPending');
  const approveSelectedBtn = modal.querySelector('#approveSelectedPendingBtn');
  const denySelectedBtn = modal.querySelector('#denySelectedPendingBtn');

  function updateCount() {
    const remainingRows = tbody.querySelectorAll('tr.pending-row');
    const remaining = remainingRows.length;

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
    return Array.from(
      modal.querySelectorAll('.pending-select:checked')
    ).map((cb) => cb.value);
  }

  function updateBulkButtons() {
    const selected = getSelectedIds();

    approveSelectedBtn.disabled = selected.length === 0;
    denySelectedBtn.disabled = selected.length === 0;

    const boxes = Array.from(
      tbody.querySelectorAll('.pending-select:not(:disabled)')
    );

    selectAll.checked = boxes.length > 0 && boxes.every((cb) => cb.checked);

    selectAll.indeterminate =
      boxes.some((cb) => cb.checked) && !boxes.every((cb) => cb.checked);
  }

  // Populate table
  records.forEach((rec) => {
    const tr = document.createElement('tr');

    tr.className = 'pending-row';
    tr.dataset.id = rec.id;

    const requested = formatRequestedTimestamp(
      rec.requestedAt || rec.resubmittedAt
    );

    tr.innerHTML = `
      <td>
        <input
          type="checkbox"
          class="pending-select pending-checkbox"
          value="${escapeHtml(rec.id)}"
        >
      </td>

      <td>${escapeHtml(rec.displayName || t('common.unknown'))}</td>
      <td>${escapeHtml(rec.date || '-')}</td>
      <td>${escapeHtml(rec.center || '-')}</td>
      <td>${escapeHtml(rec.inTime || '-')}</td>
      <td><strong>${escapeHtml(rec.proposedOutTime || '-')}</strong></td>
      <td>${escapeHtml(requested)}</td>

      <td>
        <div class="pending-row-actions">
          <button class="primary btn-small pending-approve-btn" type="button">
            ${escapeHtml(t('pending.approve'))}
          </button>

          <button class="danger btn-small pending-deny-btn" type="button">
            ${escapeHtml(t('pending.deny'))}
          </button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  });

  updateCount();
  updateBulkButtons();

  // Close modal
  modal.querySelectorAll('.pending-close-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      modal.remove();
    });
  });

  // Close when clicking outside modal content
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });

  // Select all
  selectAll.addEventListener('change', () => {
    modal.querySelectorAll('.pending-select:not(:disabled)').forEach((cb) => {
      cb.checked = selectAll.checked;
    });

    updateBulkButtons();
  });

  // Individual checkbox change
  tbody.addEventListener('change', (e) => {
    if (e.target.classList.contains('pending-select')) {
      updateBulkButtons();
    }
  });

  // Bulk approve selected
  approveSelectedBtn.addEventListener('click', async () => {
    const ids = getSelectedIds();

    if (ids.length === 0) return;

    if (!confirm(t('pending.confirmApproveSelected', { count: ids.length }))) {
      return;
    }

    approveSelectedBtn.disabled = true;
    denySelectedBtn.disabled = true;
    selectAll.disabled = true;

    for (const id of ids) {
      await processPendingVerification(id, true, {
        tbody,
        updateCount
      });
    }

    selectAll.disabled =
      tbody.querySelectorAll('tr.pending-row').length === 0;

    updateBulkButtons();
  });

  // Bulk deny selected
  denySelectedBtn.addEventListener('click', async () => {
    const ids = getSelectedIds();

    if (ids.length === 0) return;

    if (!confirm(t('pending.confirmDenySelected', { count: ids.length }))) {
      return;
    }

    approveSelectedBtn.disabled = true;
    denySelectedBtn.disabled = true;
    selectAll.disabled = true;

    for (const id of ids) {
      await processPendingVerification(id, false, {
        tbody,
        updateCount
      });
    }

    selectAll.disabled =
      tbody.querySelectorAll('tr.pending-row').length === 0;

    updateBulkButtons();
  });

  // Single approve/deny buttons
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');

    if (!btn) return;

    const row = btn.closest('tr.pending-row');

    if (!row) return;

    const id = row.dataset.id;

    if (btn.classList.contains('pending-approve-btn')) {
      if (!confirm(t('pending.confirmApproveSingle'))) return;

      await processPendingVerification(id, true, {
        tbody,
        updateCount
      });

      updateBulkButtons();
    }

    if (btn.classList.contains('pending-deny-btn')) {
      if (!confirm(t('pending.confirmDenySingle'))) return;

      await processPendingVerification(id, false, {
        tbody,
        updateCount
      });

      updateBulkButtons();
    }
  });
}

/* =========================================
   APPROVE / DENY PENDING VERIFICATION
========================================= */

async function processPendingVerification(id, approve, ui) {
  const row = ui?.tbody
    ? Array.from(ui.tbody.querySelectorAll('tr.pending-row')).find(
        (r) => r.dataset.id === id
      )
    : null;

  const buttons = row ? Array.from(row.querySelectorAll('button')) : [];
  const checkbox = row ? row.querySelector('.pending-select') : null;

  try {
    buttons.forEach((b) => (b.disabled = true));

    if (checkbox) {
      checkbox.disabled = true;
    }

    const vSnap = await get(ref(db, `timecardVerifications/${id}`));

    if (!vSnap.exists()) {
      if (row) row.remove();

      if (ui?.updateCount) ui.updateCount();

      return;
    }

    const v = vSnap.val();

    // If it is no longer pending, remove it from the modal
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

      if (!Array.isArray(logs)) {
        logs = Object.values(logs);
      }

      const alreadyExists = logs.some(
        (log) =>
          log?.type === 'out' &&
          log?.time === proposedOutTime &&
          normalizeText(log?.location) === normalizeText(location)
      );

      if (!alreadyExists) {
        logs.push({
          type: 'out',
          time: proposedOutTime,
          location
        });

        logs.sort((a, b) =>
          String(a.time || '').localeCompare(String(b.time || ''))
        );

        await update(ref(db, `timecards/${v.date}/${v.empId}`), {
          logs
        });
      }
    } else {
      await update(ref(db, `timecardVerifications/${id}`), {
        status: 'denied',
        resolvedBy: auth.currentUser?.uid || '',
        resolvedAt: new Date().toISOString()
      });
    }

    if (row) row.remove();

    if (ui?.updateCount) {
      ui.updateCount();
    }
  } catch (err) {
    console.error('Error processing pending verification:', err);

    alert(t(approve ? 'pending.approveFailed' : 'pending.denyFailed'));

    buttons.forEach((b) => (b.disabled = false));

    if (checkbox) {
      checkbox.disabled = false;
    }
  }
}

/* =========================================
   START PAGE AFTER I18N READY
========================================= */

i18nReady
  .then(() => {
    startCentersPage();
  })
  .catch((err) => {
    console.error("i18n failed, starting centers page anyway:", err);
    startCentersPage();
  });