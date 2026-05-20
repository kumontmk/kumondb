import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getDatabase, ref, set, get } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBo0DXOWKztyMXUXfPhNyoFo9P_Fu-MEn4",
  authDomain: "kumon-library.firebaseapp.com",
  databaseURL: "https://kumon-library-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "kumon-library",
  storageBucket: "kumon-library.firebasestorage.app",
  messagingSenderId: "479472870788",
  appId: "1:479472870788:web:5eeea594b1e48d9cac29d1",
  measurementId: "G-VTBSRV5GZG"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Simple password auth (for demo - use Firebase Auth in production)
const CORRECT_PASSWORD = "Tpfg6800!";

document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('password').value;
  const errorMsg = document.getElementById('errorMsg');
  
  if (password === CORRECT_PASSWORD) {
    sessionStorage.setItem('kumonAuth', 'true');
    // Initialize centers if not exists
    await initializeCenters();
    window.location.href = 'dashboard.html';
  } else {
    errorMsg.textContent = 'Incorrect password. Please try again.';
  }
});

async function initializeCenters() {
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
  }
}

// Auth guard for protected pages
export function requireAuth() {
  if (sessionStorage.getItem('kumonAuth') !== 'true') {
    window.location.href = 'index.html';
    return false;
  }
  return true;
}

export { db };