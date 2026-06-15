import { db, logout } from './auth.js';
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const auth = getAuth();
const centerGrid = document.getElementById('centerGrid');
const userEmailEl = document.getElementById('userEmail');
const pageLoader = document.getElementById('page-loader');

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }

  userEmailEl.textContent = user.email;
  document.getElementById('logoutBtn').addEventListener('click', logout);

  try {
    const userSnap = await get(ref(db, `users/${user.uid}`));
    if (!userSnap.exists()) {
      console.error("User profile not found");
      window.location.href = 'index.html';
      return;
    }

    const userData = userSnap.val();
    const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
    const userPermissions = userData.permissions?.centers || {};

    const centersSnap = await get(ref(db, 'centers'));
    if (!centersSnap.exists()) {
      centerGrid.innerHTML = '<p style="text-align:center; color:#666; grid-column: 1/-1;">No centers found in database. Please contact admin.</p>';
      pageLoader.classList.add('hidden');
      return;
    }

    const allCenters = centersSnap.val();
    centerGrid.innerHTML = '';

    let hasVisibleCenters = false;

    // ✅ FIX: Iterate through centers and handle clicks manually
    Object.entries(allCenters).forEach(([centerId, centerData]) => {
      const hasAccess = isAdmin || userPermissions[centerId] === true;

      if (hasAccess) {
        hasVisibleCenters = true;
        
        // Create a div instead of an 'a' tag so we can control the click event
        const card = document.createElement('div');
        card.className = 'center-card';
        card.style.cursor = 'pointer';
        card.innerHTML = `
          <div class="card-icon">🏢</div>
          <h3>${centerData.name || centerId}</h3>
          <p>Manage students, reports, and daily operations</p>
        `;
        
        // ✅ CRITICAL FIX: Save centerId to sessionStorage on click, THEN navigate
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
          <h3>No Centers Assigned</h3>
          <p>You do not have permission to access any centers. Please contact the administrator to update your permissions.</p>
        </div>
      `;
    }

    pageLoader.classList.add('hidden');
  } catch (error) {
    console.error("Error loading centers:", error);
    centerGrid.innerHTML = '<p style="text-align:center; color:#dc3545; grid-column: 1/-1;">Error loading centers. Please refresh.</p>';
    pageLoader.classList.add('hidden');
  }
});