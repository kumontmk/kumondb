import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, 
  updatePassword, EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

export const firebaseConfig = {
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
const AUTO_LOGOUT_TIMEOUT = 480 * 60 * 1000; 
let logoutTimer;
let isAutoLogoutInitialized = false;
let pendingUser = null;
let isLoginMode = true;

function resetLogoutTimer() {
  clearTimeout(logoutTimer);
  logoutTimer = setTimeout(() => { performAutoLogout(); }, AUTO_LOGOUT_TIMEOUT);
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

// 🆕 GLOBAL FORCE PASSWORD CHANGE MODAL
function showForcePasswordChangeModal(user) {
  if (document.getElementById('forceChangePwModal')) return;
  const modal = document.createElement('div');
  modal.id = 'forceChangePwModal';
  modal.className = 'modal';
  modal.style.zIndex = '9999';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 400px; text-align: left;">
      <h3 style="text-align: center; color: #dc3545; margin-bottom: 1rem;">🔒 Security Requirement</h3>
      <p style="margin-bottom: 1rem; color: #666;">For your security, you must change your default password before accessing the system.</p>
      <div style="margin-bottom: 1rem;">
        <label style="font-size: 0.9rem; font-weight: 600; display: block; margin-bottom: 0.3rem;">New Password</label>
        <input type="password" id="newPwInput" placeholder="Min 6 characters" style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px;">
      </div>
      <div style="margin-bottom: 1.5rem;">
        <label style="font-size: 0.9rem; font-weight: 600; display: block; margin-bottom: 0.3rem;">Confirm New Password</label>
        <input type="password" id="confirmPwInput" placeholder="Re-enter password" style="width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px;">
      </div>
      <p id="forcePwError" style="color: #dc3545; font-size: 0.85rem; min-height: 1.2em; margin-bottom: 0.5rem;"></p>
      <button id="submitForcePwBtn" class="primary" style="width: 100%; padding: 0.75rem; font-weight: 600;">Update Password</button>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('submitForcePwBtn').addEventListener('click', async () => {
    const newPw = document.getElementById('newPwInput').value;
    const confirmPw = document.getElementById('confirmPwInput').value;
    const errEl = document.getElementById('forcePwError');
    errEl.textContent = '';

    if (newPw.length < 6) return errEl.textContent = 'Password must be at least 6 characters.';
    if (newPw !== confirmPw) return errEl.textContent = 'Passwords do not match.';

    try {
      document.getElementById('submitForcePwBtn').disabled = true;
      document.getElementById('submitForcePwBtn').textContent = 'Updating...';
      
      // Reauthenticate if needed
      const credential = EmailAuthProvider.credential(user.email, 'Kumon123');
      try {
        await reauthenticateWithCredential(user, credential);
      } catch (e) {
        // Ignore if reauth fails
      }

      await updatePassword(user, newPw);
      await update(ref(db, `users/${user.uid}`), { mustChangePassword: false });
      
      modal.remove();
      window.location.reload(); 
    } catch (error) {
      errEl.textContent = 'Failed to update password. Please contact admin.';
      document.getElementById('submitForcePwBtn').disabled = false;
      document.getElementById('submitForcePwBtn').textContent = 'Update Password';
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
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

  const profNatSelect = document.getElementById('profNationality');
  const profNatOther = document.getElementById('profNationalityOther');
  profNatSelect?.addEventListener('change', e => {
    profNatOther.classList.toggle('visible', e.target.value === 'Others');
    if (e.target.value !== 'Others') profNatOther.value = '';
  });

  const googleBtn = document.getElementById('googleSignInBtn');
  const emailForm = document.getElementById('emailAuthForm');
  const submitBtn = document.getElementById('submitBtn');
  const toggleBtn = document.getElementById('authToggleBtn');
  const errorMsg = document.getElementById('errorMsg');
  const emailInput = document.getElementById('email');
  const passInput = document.getElementById('password');
  const profileForm = document.getElementById('profileForm');
  const cancelProfileBtn = document.getElementById('cancelProfileBtn');

  // 🆕 FORGOT PASSWORD LOGIC
  const forgotPwLink = document.getElementById('forgotPasswordLink');
  const forgotPwForm = document.getElementById('forgotPasswordForm');
  const forgotPwEmail = document.getElementById('forgotPwEmail');
  const backToLoginBtn = document.getElementById('backToLoginBtn');
  const submitForgotPwBtn = document.getElementById('submitForgotPwBtn');

  forgotPwLink?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('authFormContainer').classList.add('hidden');
    forgotPwForm.classList.remove('hidden');
  });

  backToLoginBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    forgotPwForm.classList.add('hidden');
    document.getElementById('authFormContainer').classList.remove('hidden');
  });

  submitForgotPwBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = forgotPwEmail.value.trim();
    if (!email) return;
    try {
      submitForgotPwBtn.disabled = true;
      submitForgotPwBtn.textContent = 'Sending...';
      await sendPasswordResetEmail(auth, email);
      alert('✅ Password reset link sent to ' + email);
      forgotPwForm.classList.add('hidden');
      document.getElementById('authFormContainer').classList.remove('hidden');
      forgotPwEmail.value = '';
    } catch (err) {
      alert('❌ Error: ' + err.message);
    } finally {
      submitForgotPwBtn.disabled = false;
      submitForgotPwBtn.textContent = 'Send Reset Link';
    }
  });

  googleBtn?.addEventListener('click', async () => {
    try {
      setLoading(googleBtn, true, 'Connecting...');
      await signInWithPopup(auth, provider);
    } catch (error) {
      showError(error.message);
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
      if (isLoginMode) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        pendingUser = userCredential.user;
        document.getElementById('authFormContainer').classList.add('hidden');
        document.getElementById('profileFormContainer').classList.remove('hidden');
        const pageLoader = document.getElementById('page-loader');
        if (pageLoader) pageLoader.classList.add('hidden');
        setLoading(submitBtn, false, 'Sign Up', true);
        return; 
      }
    } catch (error) {
      let msg = error.message;
      if (msg.includes('auth/user-not-found') || msg.includes('auth/wrong-password') || msg.includes('auth/invalid-credential')) msg = 'Invalid email or password.';
      else if (msg.includes('auth/email-already-in-use')) msg = 'Email already registered.';
      else if (msg.includes('auth/invalid-email')) msg = 'Please enter a valid email.';
      else if (msg.includes('auth/weak-password')) msg = 'Password must be at least 6 characters.';
      showError(msg);
      setLoading(submitBtn, false, isLoginMode ? 'Sign In' : 'Sign Up', true); 
    }
  });

  profileForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pendingUser) return;
    const submitProfileBtn = document.getElementById('submitProfileBtn');
    setLoading(submitProfileBtn, true, 'Submitting...');
    const nationality = profNatSelect.value === 'Others' ? profNatOther.value.trim() : profNatSelect.value;
    
    // 🆕 Read checked positions from the new checkbox group
    const positions = [];
    document.querySelectorAll('#profPositionsGroup input:checked').forEach(cb => positions.push(cb.value));
    if (positions.length === 0) {
      alert('Please select at least one position.');
      setLoading(submitProfileBtn, false, 'Submit for Verification', true);
      return;
    }

    const userData = {
      email: pendingUser.email,
      englishName: document.getElementById('profEnglishName').value.trim(),
      chineseName: document.getElementById('profChineseName').value.trim(),
      nationality: nationality,
      positions: positions,       // 🆕 Save as array
      position: positions[0],     // 🔄 Keep first one as string for backward compatibility
      employmentDate: document.getElementById('profEmploymentDate').value,
      terms: document.getElementById('profTerms').value,
      isVerified: false, 
      mustChangePassword: true, 
      createdAt: new Date().toISOString()
    };
    try {
      await set(ref(db, `users/${pendingUser.uid}`), userData);
      await signOut(auth);
      pendingUser = null;
      showError('Account created successfully! Please wait for admin verification.');
      document.getElementById('profileFormContainer').classList.add('hidden');
      document.getElementById('authFormContainer').classList.remove('hidden');
      profileForm.reset();
      setLoading(submitProfileBtn, false, 'Submit for Verification', true);
    } catch (error) {
      showError('Failed to save profile: ' + error.message);
      setLoading(submitProfileBtn, false, 'Submit for Verification', true);
    }
  });

  cancelProfileBtn?.addEventListener('click', async () => {
    if (pendingUser) {
      await signOut(auth);
      pendingUser = null;
    }
    document.getElementById('profileFormContainer').classList.add('hidden');
    document.getElementById('authFormContainer').classList.remove('hidden');
    profileForm?.reset();
    showError('');
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
  const pageLoader = document.getElementById('page-loader');
  if (user) {
    const userRef = ref(db, `users/${user.uid}`);
    let snapshot = await get(userRef);

    if (!snapshot.exists() && user.email?.toLowerCase() === 'kumonchamps@gmail.com') {
      const adminData = {
        email: user.email,
        englishName: user.displayName || 'Kumon Admin',
        chineseName: '',
        nationality: 'Other',
        positions: ['Master Admin'], // 🆕 Added array format
        position: 'Master Admin',    // 🔄 Kept string format for backward compatibility
        employmentDate: new Date().toISOString().split('T')[0],
        terms: 'Full-time',
        isVerified: true, 
        mustChangePassword: false,
        isDisabled: false,
        permissions: {
          centers: { 'kumon-taipa-mei-keng': true, 'kumon-taipa-pac-tat': true },
          dashboardCards: { studentManagement: true, timetable: true, monthlyReports: true, progressCharts: true, attendance: true, parentOrientation: true, dropBook: true },
          centerAdminCards: { userManagement: true, centerSettings: true, financialReports: true }
        },
        createdAt: new Date().toISOString()
      };
      await set(userRef, adminData);
      snapshot = await get(userRef); 
    }

    if (!snapshot.exists()) {
      pendingUser = user;
      document.getElementById('authFormContainer')?.classList.add('hidden');
      const profileContainer = document.getElementById('profileFormContainer');
      if (profileContainer) {
        profileContainer.classList.remove('hidden');
        document.getElementById('profEnglishName')?.focus();
      }
      if (pageLoader) pageLoader.classList.add('hidden');
      return; 
    }

    const userData = snapshot.val();

    if (userData.isDisabled === true) {
      showError('❌ Your account has been disabled by the administrator. Please contact management.');
      await signOut(auth);
      if (pageLoader) pageLoader.classList.add('hidden');
      return;
    }

    if (!userData.isVerified) {
      showError('Your account is pending admin verification. Please contact kumonchamps@gmail.com.');
      await signOut(auth);
      if (pageLoader) pageLoader.classList.add('hidden');
      return;
    }

    // 🆕 CHECK FOR FORCED PASSWORD CHANGE
    if (userData.mustChangePassword === true) {
      if (pageLoader) pageLoader.classList.add('hidden');
      showForcePasswordChangeModal(user);
      return; 
    }

    sessionStorage.setItem('kumonUser', JSON.stringify({
      uid: user.uid, 
      email: user.email, 
      name: userData.englishName || user.email.split('@')[0], 
      photo: user.photoURL,
      permissions: userData.permissions || {}
    }));

    await initializeCenters();
    initAutoLogout();

    const path = window.location.pathname;
    if (path.endsWith('/') || path.endsWith('index.html')) {
      window.location.href = 'centers.html';
    } else {
      if (pageLoader) pageLoader.classList.add('hidden');
    }
  } else {
    sessionStorage.removeItem('kumonUser');
    clearTimeout(logoutTimer);
    isAutoLogoutInitialized = false;
    pendingUser = null;
    if (pageLoader) pageLoader.classList.add('hidden');
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

function setLoading(btn, isLoading, text, forceHideLoader = false) {
  btn.disabled = isLoading;
  btn.style.opacity = isLoading ? '0.7' : '1';
  if (!btn.querySelector('svg')) {
    btn.textContent = text;
  }
  const pageLoader = document.getElementById('page-loader');
  if (pageLoader) {
    if (isLoading) {
      pageLoader.classList.remove('hidden');
    } else if (forceHideLoader) {
      pageLoader.classList.add('hidden');
    }
  }
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  if (el) el.textContent = msg;
}