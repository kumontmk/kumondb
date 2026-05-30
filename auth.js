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

let isLoginMode = true;

window.addEventListener('DOMContentLoaded', () => {
  const loader = document.getElementById('page-loader');
  if (loader) setTimeout(() => loader.classList.add('hidden'), 300);

  const googleBtn = document.getElementById('googleSignInBtn');
  const emailForm = document.getElementById('emailAuthForm');
  const submitBtn = document.getElementById('submitBtn');
  const toggleBtn = document.getElementById('authToggleBtn');
  const errorMsg = document.getElementById('errorMsg');
  const emailInput = document.getElementById('email');
  const passInput = document.getElementById('password');

  googleBtn?.addEventListener('click', async () => {
    try { setLoading(googleBtn, true, 'Connecting...'); await signInWithPopup(auth, provider); } 
    catch (error) { showError(error.message); } 
    finally { setLoading(googleBtn, false, 'Continue with Google'); }
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
    } catch (error) {
      let msg = error.message;
      if (msg.includes('auth/user-not-found') || msg.includes('auth/wrong-password') || msg.includes('auth/invalid-credential')) msg = 'Invalid email or password.';
      else if (msg.includes('auth/email-already-in-use')) msg = 'Email already registered.';
      else if (msg.includes('auth/invalid-email')) msg = 'Please enter a valid email.';
      else if (msg.includes('auth/weak-password')) msg = 'Password must be at least 6 characters.';
      showError(msg);
    } finally { setLoading(submitBtn, false, isLoginMode ? 'Sign In' : 'Sign Up'); }
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
    if (window.location.pathname.includes('index.html') || window.location.pathname === '/') {
      window.location.href = 'centers.html';
    }
  } else {
    sessionStorage.removeItem('kumonUser');
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

function setLoading(btn, isLoading, text) {
  btn.disabled = isLoading;
  btn.style.opacity = isLoading ? '0.7' : '1';
  if (!btn.querySelector('svg')) btn.textContent = text;
}
function showError(msg) {
  const el = document.getElementById('errorMsg');
  if (el) el.textContent = msg;
}