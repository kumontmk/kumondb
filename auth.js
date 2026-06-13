import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

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
export const db = getDatabase(app);
export const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// ============================================
// AUTO-LOGOUT AFTER INACTIVITY
// ============================================
const AUTO_LOGOUT_TIMEOUT = 20 * 60 * 1000; // 20 minutes
let logoutTimer;
let isAutoLogoutInitialized = false;

function resetLogoutTimer() {
  clearTimeout(logoutTimer);
  logoutTimer = setTimeout(() => {
    performAutoLogout();
  }, AUTO_LOGOUT_TIMEOUT);
}

function performAutoLogout() {
  sessionStorage.removeItem('kumonUser');
  signOut(auth).catch(err => console.log('Sign out error:', err));
  window.location.href = 'index.html?reason=inactive';
}

function initAutoLogout() {
  if (isAutoLogoutInitialized) return;
  const user = auth.currentUser;
  const stored = sessionStorage.getItem('kumonUser');
  if (!user && !stored) return;

  isAutoLogoutInitialized = true;
  const activityEvents = ['mousedown', 'keypress', 'scroll', 'touchstart', 'click'];
  activityEvents.forEach(event => {
    document.addEventListener(event, resetLogoutTimer, { passive: true, capture: true });
  });
  resetLogoutTimer();
}

// ============================================
// SHOW INACTIVITY MESSAGE ON LOGIN PAGE
// ============================================
window.addEventListener('DOMContentLoaded', () => {
  // ✅ FIX: Only hide the loader automatically if we are on the login page!
  // This prevents it from hiding prematurely on centers.html or dashboard.html
  const isLoginPage = document.getElementById('emailAuthForm') || document.getElementById('googleSignInBtn');
  const loader = document.getElementById('page-loader');
  
  if (loader && isLoginPage) {
    setTimeout(() => loader.classList.add('hidden'), 300);
  }

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('reason') === 'inactive') {
    const errorMsg = document.getElementById('errorMsg');
    if (errorMsg) {
      errorMsg.textContent = 'You have been logged out due to inactivity.';
      errorMsg.style.color = '#dc3545';
      errorMsg.style.fontWeight = '500';
    }
    window.history.replaceState({}, document.title, window.location.pathname);
  }
});

let isLoginMode = true;

window.addEventListener('DOMContentLoaded', () => {
  const googleBtn = document.getElementById('googleSignInBtn');
  const emailForm = document.getElementById('emailAuthForm');
  const submitBtn = document.getElementById('submitBtn');
  const toggleBtn = document.getElementById('authToggleBtn');
  const errorMsg = document.getElementById('errorMsg');
  const emailInput = document.getElementById('email');
  const passInput = document.getElementById('password');

  googleBtn?.addEventListener('click', async () => {
    try {
      setLoading(googleBtn, true, 'Connecting...');
      await signInWithPopup(auth, provider);
      // ✅ SUCCESS: Do NOT hide loader. Let the redirect happen seamlessly.
    } catch (error) {
      showError(error.message);
      // ✅ ERROR: Hide loader so user can try again
      setLoading(googleBtn, false, 'Continue with Google', true);
    }
  });

  emailForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorMsg.textContent = '';
    const email = emailInput.value.trim();
    const password = passInput.value;

    try {
      setLoading(submitBtn, true, isLoginMode ? 'Signing in...' : 'Creating account...');
      if (isLoginMode) await signInWithEmailAndPassword(auth, email, password);
      else await createUserWithEmailAndPassword(auth, email, password);
      // ✅ SUCCESS: Do NOT hide loader. Let the redirect happen seamlessly.
    } catch (error) {
      let msg = error.message;
      if (msg.includes('auth/user-not-found') || msg.includes('auth/wrong-password') || msg.includes('auth/invalid-credential')) msg = 'Invalid email or password.';
      else if (msg.includes('auth/email-already-in-use')) msg = 'Email already registered.';
      else if (msg.includes('auth/invalid-email')) msg = 'Please enter a valid email.';
      else if (msg.includes('auth/weak-password')) msg = 'Password must be at least 6 characters.';
      
      showError(msg);
      // ✅ ERROR: Hide loader so user can try again
      setLoading(submitBtn, false, isLoginMode ? 'Sign In' : 'Sign Up', true); 
    }
  });

  toggleBtn?.addEventListener('click', () => {
    isLoginMode = !isLoginMode;
    submitBtn.textContent = isLoginMode ? 'Sign In' : 'Sign Up';
    toggleBtn.textContent = isLoginMode ? "Don't have an account? Sign Up" : "Already have an account? Sign In";
    errorMsg.textContent = '';
    emailForm?.reset();
  });
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    sessionStorage.setItem('kumonUser', JSON.stringify({
      uid: user.uid, email: user.email, name: user.displayName || user.email.split('@')[0], photo: user.photoURL
    }));
    
    await initializeCenters();
    initAutoLogout();
    
    const path = window.location.pathname;
    if (path.endsWith('/') || path.endsWith('index.html')) {
      window.location.href = 'centers.html'; // Redirects while loader is still visible!
    }
  } else {
    sessionStorage.removeItem('kumonUser');
    clearTimeout(logoutTimer);
    isAutoLogoutInitialized = false;
  }
});

async function initializeCenters() {
  const centersRef = ref(db, 'centers');
  const snapshot = await get(centersRef);
  if (!snapshot.exists()) {
    await set(centersRef, {
      'kumon-taipa-mei-keng': { id: 'kumon-taipa-mei-keng', name: 'Kumon Taipa Mei Keng', createdAt: new Date().toISOString() },
      'kumon-taipa-pac-tat': { id: 'kumon-taipa-pac-tat', name: 'Kumon Taipa Pac Tat', createdAt: new Date().toISOString() }
    });
  }
}

export async function logout() {
  clearTimeout(logoutTimer);
  isAutoLogoutInitialized = false;
  await signOut(auth);
  sessionStorage.removeItem('kumonUser');
  window.location.href = 'index.html';
}

export function requireAuth() {
  const user = auth.currentUser;
  const stored = sessionStorage.getItem('kumonUser');
  if (!user && !stored) {
    window.location.href = 'index.html';
    return false;
  }
  return true;
}

// ✅ UPDATED: Added 'forceHideLoader' parameter
function setLoading(btn, isLoading, text, forceHideLoader = false) {
  btn.disabled = isLoading;
  btn.style.opacity = isLoading ? '0.7' : '1';
  if (!btn.querySelector('svg')) {
    btn.textContent = text;
  }

  const pageLoader = document.getElementById('page-loader');
  if (pageLoader) {
    if (isLoading) {
      pageLoader.classList.remove('hidden'); // Show spinner & block clicks
    } else if (forceHideLoader) {
      pageLoader.classList.add('hidden'); // Only hide spinner on ERROR, not on success
    }
  }
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  if (el) el.textContent = msg;
}