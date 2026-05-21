// js/auth.js
// ✅ Use CDN imports for browser modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getDatabase, ref, set, get } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

// ✅ Your Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyB1VhQwGotEI8BHt8wp8FvtPpUY5FsI0qA",
  authDomain: "kumondb-f4377.firebaseapp.com",
  databaseURL: "https://kumondb-f4377-default-rtdb.firebaseio.com",
  projectId: "kumondb-f4377",
  storageBucket: "kumondb-f4377.firebasestorage.app",
  messagingSenderId: "838725994916",
  appId: "1:838725994916:web:87326ba7bec87a0e6b5931",
  measurementId: "G-EY7L54FTS1"
};

// ✅ Initialize Firebase at module scope
const app = initializeApp(firebaseConfig);
const db = getDatabase(app); // ✅ Defined at top level for export

// ✅ Testing password
const CORRECT_PASSWORD = "1111";

// ✅ Login handler - only attach if form exists on page
const loginForm = document.getElementById('loginForm');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('password')?.value;
    const errorMsg = document.getElementById('errorMsg');
    
    if (password === CORRECT_PASSWORD) {
      sessionStorage.setItem('kumonAuth', 'true');
      await initializeCenters();
      window.location.href = 'dashboard.html';
    } else {
      if (errorMsg) errorMsg.textContent = 'Incorrect password. Please try again.';
    }
  });
}

// ✅ Initialize default centers if they don't exist
async function initializeCenters() {
  try {
    const centersRef = ref(db, 'centers');
    const snapshot = await get(centersRef);
    if (!snapshot.exists()) {
      await set(centersRef, {
        'kumon-taipa-mei-keng': {
          id: 'kumon-taipa-mei-keng',
          name: 'Kumon Taipa Mei Keng',
          createdAt: new Date().toISOString()
        },
        'kumon-taipa-pac-tat': {
          id: 'kumon-taipa-pac-tat',
          name: 'Kumon Taipa Pac Tat',
          createdAt: new Date().toISOString()
        }
      });
      console.log('✅ Default centers initialized');
    }
  } catch (error) {
    console.error('❌ Error initializing centers:', error);
  }
}

// ✅ Auth guard - redirects to login if not authenticated
export function requireAuth() {
  if (sessionStorage.getItem('kumonAuth') !== 'true') {
    window.location.href = 'index.html';
    return false;
  }
  return true;
}

// ✅ Export db for use in other modules
export { db };

// ✅ Debug log (remove in production)
console.log('🔐 auth.js loaded | db:', db ? 'ready' : 'error');
