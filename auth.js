import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getDatabase, ref, set, get } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

// ✅ CORRECT Firebase Config
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

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const CORRECT_PASSWORD = "1111";

// ✅ FIX: ID changed to 'page-loader' to match your CSS
window.addEventListener('DOMContentLoaded', () => {
  const loader = document.getElementById('page-loader');
  if (loader) setTimeout(() => loader.classList.add('hidden'), 300);
});

// Login handler
document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('password').value;
  const errorMsg = document.getElementById('errorMsg');
  
  if (password === CORRECT_PASSWORD) {
    sessionStorage.setItem('kumonAuth', 'true');
    await initializeCenters();
    window.location.href = 'centers.html';
  } else {
    if (errorMsg) errorMsg.textContent = 'Incorrect password. Please try again.';
  }
});

// Initialize centers
async function initializeCenters() {
  try {
    const centersRef = ref(db, 'centers');
    const snapshot = await get(centersRef);
    if (!snapshot.exists()) {
      await set(centersRef, {
        'kumon-taipa-mei-keng': { id: 'kumon-taipa-mei-keng', name: 'Kumon Taipa Mei Keng', createdAt: new Date().toISOString() },
        'kumon-taipa-pac-tat': { id: 'kumon-taipa-pac-tat', name: 'Kumon Taipa Pac Tat', createdAt: new Date().toISOString() }
      });
      console.log('✅ Centers initialized');
    }
  } catch (err) {
    console.error('❌ Center init error:', err);
  }
}

// Auth guard
export function requireAuth() {
  if (sessionStorage.getItem('kumonAuth') !== 'true') {
    window.location.href = 'index.html';
    return false;
  }
  return true;
}

export { db };