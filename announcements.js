import { db } from './auth.js';
import {
  ref,
  get,
  push,
  set,
  update,
  onValue
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { i18nReady, t, currentLanguage } from './announcements-i18n.js';

// Wait for i18n before first render
await i18nReady.catch(() => {});

/* =========================================
   ELEMENTS
========================================= */
const auth = getAuth();
const pageLoader = document.getElementById('page-loader');
const backBtn = document.getElementById('backBtn');

// List view
const listView = document.getElementById('listView');
const newAnnouncementBtn = document.getElementById('newAnnouncementBtn');
const announcementList = document.getElementById('announcementList');

// Detail view
const detailView = document.getElementById('detailView');
const backToListBtn = document.getElementById('backToListBtn');
const detailActions = document.getElementById('detailActions');
const editAnnouncementBtn = document.getElementById('editAnnouncementBtn');
const deleteAnnouncementBtn = document.getElementById('deleteAnnouncementBtn');
const detailTitle = document.getElementById('detailTitle');
const detailMeta = document.getElementById('detailMeta');
const detailContent = document.getElementById('detailContent');
const commentsHeading = document.getElementById('commentsHeading');
const commentList = document.getElementById('commentList');
const commentForm = document.getElementById('commentForm');

// Modal
const announcementModal = document.getElementById('announcementModal');
const announcementModalTitle = document.getElementById('announcementModalTitle');
const announcementForm = document.getElementById('announcementForm');
const announcementTitleInput = document.getElementById('announcementTitle');
const saveAnnouncementBtn = document.getElementById('saveAnnouncementBtn');
const cancelAnnouncementBtn = document.getElementById('cancelAnnouncementBtn');
const closeAnnouncementModalBtn = document.getElementById('closeAnnouncementModalBtn');

/* =========================================
   STATE
========================================= */
let currentUser = null;
let currentUserData = null;
let displayName = '';
let canManage = false;
let announcements = {};
let comments = {};
let quill = null;
let editingAnnouncementId = null;
let dataSubscribed = false;
let currentViewId = null;
let initialRouteApplied = false;

/* =========================================
   I18N SPECIFIC HOOKS (For Quill & HTML Lang)
========================================= */
function applyAnnouncementSpecificI18n() {
  document.documentElement.lang = currentLanguage;
  document.title = t('documentTitle');
  if (quill) {
    quill.root.dataset.placeholder = t('announcementDetails');
  }
}
i18nReady.then(applyAnnouncementSpecificI18n).catch(() => {});

/* =========================================
   HELPERS
========================================= */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (s) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[s]));
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

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

function hasManagementPosition(positions) {
  return (
    positions.includes('manager') ||
    positions.includes('master admin') ||
    positions.includes('admin') ||
    positions.includes('administrator')
  );
}

function timestampMs(value) {
  const date = new Date(value);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  // Use global currentLanguage instead of local variable
  const locale = currentLanguage === 'zh-TW' ? 'zh-TW' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function htmlToPlainText(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = window.DOMPurify
    ? sanitizeAnnouncementHtml(html || '')
    : String(html || '').replace(/<[^>]*>/g, ' ');
  return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
}

function makeExcerpt(text, maxLen = 130) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '…';
}

/* =========================================
   SANITIZE RICH TEXT
========================================= */
if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'style') {
      const value = String(data.attrValue || '');
      if (/javascript|expression|url\s*\(|behavior|@import|-moz-binding/i.test(value)) {
        data.keepAttr = false;
      }
    }
    if (data.attrName === 'href') {
      const value = String(data.attrValue || '');
      if (/^\s*javascript:/i.test(value)) {
        data.keepAttr = false;
      }
    }
  });
}

function sanitizeAnnouncementHtml(html) {
  if (!window.DOMPurify) {
    return escapeHtml(html);
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li',
      'blockquote', 'a', 'span', 'div', 'pre', 'code',
      'sub', 'sup', 'hr',
      'table', 'thead', 'tbody', 'tr', 'td', 'th'
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
    ALLOW_DATA_ATTR: false
  });
}

/* =========================================
   ROLE CHECK
========================================= */
async function canManageBulletin(user, userData) {
  if (!user) return false;
  const email = (user.email || '').toLowerCase();
  if (email === 'kumonchamps@gmail.com') return true;
  if (userData?.isDisabled === true) return false;
  
  const positions = getEmpPositions(userData).map((p) => normalizeText(p));
  if (hasManagementPosition(positions)) return true;

  try {
    const empUidSnap = await get(ref(db, `employees/${user.uid}`));
    if (empUidSnap.exists()) {
      const emp = empUidSnap.val();
      if (emp?.isDisabled !== true) {
        const empPositions = getEmpPositions(emp).map((p) => normalizeText(p));
        if (hasManagementPosition(empPositions)) return true;
      }
    }
    if (email) {
      const empSnap = await get(ref(db, 'employees'));
      if (empSnap.exists()) {
        const allEmployees = empSnap.val();
        const matchingEmp = Object.values(allEmployees).find((e) => e && normalizeText(e.email) === email);
        if (matchingEmp && matchingEmp.isDisabled !== true) {
          const empPositions = getEmpPositions(matchingEmp).map((p) => normalizeText(p));
          if (hasManagementPosition(empPositions)) return true;
        }
      }
    }
  } catch (err) {
    console.error('Error checking bulletin management permission:', err);
  }
  return false;
}

/* =========================================
   RICH TEXT EDITOR
========================================= */
function ensureEditor() {
  if (quill) return true;
  if (!window.Quill) {
    alert('Rich text editor failed to load.');
    return false;
  }
  quill = new Quill('#editor', {
    theme: 'snow',
    placeholder: t('announcementDetails'),
    modules: {
      toolbar: [
        ['bold', 'italic', 'underline', 'strike'],
        ['blockquote', 'code-block'],
        [{ header: 1 }, { header: 2 }, { header: 3 }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        [{ script: 'sub' }, { script: 'super' }],
        [{ indent: '-1' }, { indent: '+1' }],
        [{ color: [] }, { background: [] }],
        [{ font: [] }],
        [{ align: [] }],
        ['link', 'clean']
      ]
    }
  });
  return true;
}

/* =========================================
   MODAL (new / edit)
========================================= */
function openAnnouncementModal() {
  if (!ensureEditor()) return false;
  announcementModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  return true;
}

function closeAnnouncementModal() {
  announcementModal.classList.add('hidden');
  document.body.style.overflow = '';
}

function openNewAnnouncement() {
  if (!canManage) return;
  editingAnnouncementId = null;
  announcementModalTitle.textContent = t('newAnnouncement');
  if (!openAnnouncementModal()) return;
  announcementForm.reset();
  quill.setContents([]);
  announcementTitleInput.focus();
}

function openEditAnnouncement(id) {
  if (!canManage) return;
  const announcement = announcements?.[id];
  if (!announcement) return;
  editingAnnouncementId = id;
  announcementModalTitle.textContent = t('editAnnouncement');
  if (!openAnnouncementModal()) return;
  announcementTitleInput.value = announcement.title || '';
  quill.root.innerHTML = sanitizeAnnouncementHtml(announcement.html || '');
}

/* =========================================
   VIEW ROUTING (list <-> detail)
========================================= */
function showListView() {
  currentViewId = null;
  detailView.classList.add('hidden');
  listView.classList.remove('hidden');
}

function showDetailView(id) {
  const announcement = announcements?.[id];
  if (!announcement) {
    showListView();
    return;
  }
  currentViewId = id;
  listView.classList.add('hidden');
  detailView.classList.remove('hidden');
  renderDetail();
  window.scrollTo({ top: 0 });
}

function handleHashChange() {
  const match = window.location.hash.match(/^#announcement\/(.+)$/);
  const id = match ? decodeURIComponent(match[1]) : null;
  if (id && announcements?.[id]) {
    showDetailView(id);
  } else {
    showListView();
  }
}

function clearHashSilently() {
  if (window.location.hash) {
    history.pushState('', document.title, window.location.pathname + window.location.search);
  }
}

function openAnnouncementById(id) {
  if (!announcements?.[id]) return;
  const target = `#announcement/${encodeURIComponent(id)}`;
  if (window.location.hash === target) {
    showDetailView(id);
  } else {
    window.location.hash = target;
  }
}

/* =========================================
   RENDER — LIST (cards)
========================================= */
function cardTemplate(id, announcement) {
  const commentCount = Object.keys(comments?.[id] || {}).length;
  const excerpt = makeExcerpt(htmlToPlainText(announcement.html));
  return `
    <article class="announcement-card" data-id="${escapeHtml(id)}" tabindex="0" role="button" aria-label="${escapeHtml(announcement.title || '')}">
      <h3 class="announcement-card-title">${escapeHtml(announcement.title || '')}</h3>
      <p class="announcement-excerpt">${escapeHtml(excerpt)}</p>
      <div class="announcement-card-meta">
        ${escapeHtml(announcement.createdByName || t('unknown'))} • ${escapeHtml(formatDate(announcement.createdAt))}
      </div>
      <div class="announcement-card-footer">
        <span class="read-more">${escapeHtml(t('readMore'))}</span>
        <span class="comment-badge" title="${escapeHtml(t('comments'))}">💬 ${commentCount}</span>
      </div>
    </article>
  `;
}

function renderCards() {
  if (!announcementList) return;
  const entries = Object.entries(announcements || {}).sort((a, b) => {
    const aTime = timestampMs(a[1]?.createdAt);
    const bTime = timestampMs(b[1]?.createdAt);
    if (bTime !== aTime) return bTime - aTime;
    return String(b[0]).localeCompare(String(a[0]));
  });

  if (!entries.length) {
    announcementList.innerHTML = `<div class="empty-state">${escapeHtml(t('noAnnouncements'))}</div>`;
    return;
  }
  announcementList.innerHTML = entries.map(([id, announcement]) => cardTemplate(id, announcement)).join('');
}

/* =========================================
   RENDER — DETAIL
========================================= */
function commentTemplate(announcementId, commentId, comment) {
  const deleteBtn = canManage
    ? `<button class="danger btn-small" type="button" data-action="delete-comment" data-announcement-id="${escapeHtml(announcementId)}" data-comment-id="${escapeHtml(commentId)}">${escapeHtml(t('delete'))}</button>`
    : '';
  return `
    <div class="comment-card">
      <div class="comment-header">
        <div class="comment-meta">
          <strong>${escapeHtml(comment.createdByName || t('unknown'))}</strong>
          <span>• ${escapeHtml(formatDate(comment.createdAt))}</span>
        </div>
        ${deleteBtn}
      </div>
      <div class="comment-text">${escapeHtml(comment.text || '')}</div>
    </div>
  `;
}

function renderComments() {
  if (!commentList || !currentViewId) return;
  const announcementComments = comments?.[currentViewId] || {};
  const sorted = Object.entries(announcementComments).sort((a, b) => timestampMs(a[1]?.createdAt) - timestampMs(b[1]?.createdAt));
  
  if (commentsHeading) {
    commentsHeading.textContent = `${t('comments')} (${sorted.length})`;
  }
  commentList.innerHTML = sorted.length
    ? sorted.map(([commentId, comment]) => commentTemplate(currentViewId, commentId, comment)).join('')
    : `<p class="no-comments">${escapeHtml(t('noComments'))}</p>`;
}

function renderDetail() {
  const announcement = announcements?.[currentViewId];
  if (!announcement) return;
  detailTitle.textContent = announcement.title || '';
  let meta = `${announcement.createdByName || t('unknown')} • ${formatDate(announcement.createdAt)}`;
  if (announcement.updatedAt) {
    meta += ` • ${t('edited')} ${formatDate(announcement.updatedAt)}`;
  }
  detailMeta.textContent = meta;
  detailContent.innerHTML = sanitizeAnnouncementHtml(announcement.html || '');
  detailActions?.classList.toggle('hidden', !canManage);
  renderComments();
}

/* =========================================
   CRUD ACTIONS
========================================= */
async function saveAnnouncement(e) {
  e.preventDefault();
  if (!canManage || !quill) return;
  const title = announcementTitleInput.value.trim();
  const html = sanitizeAnnouncementHtml(quill.root.innerHTML);
  const plainText = quill.getText().trim();
  if (!title || !plainText) {
    alert(t('requiredFields'));
    return;
  }
  saveAnnouncementBtn.disabled = true;
  saveAnnouncementBtn.textContent = t('saving');
  try {
    if (editingAnnouncementId) {
      await update(ref(db, `announcements/${editingAnnouncementId}`), {
        title, html,
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser.uid,
        updatedByName: displayName
      });
    } else {
      const newRef = push(ref(db, 'announcements'));
      await set(newRef, {
        title, html,
        createdBy: currentUser.uid,
        createdByName: displayName,
        createdAt: new Date().toISOString()
      });
    }
    closeAnnouncementModal();
  } catch (err) {
    console.error('Error saving announcement:', err);
    alert(t('saveFailed'));
  } finally {
    saveAnnouncementBtn.disabled = false;
    saveAnnouncementBtn.textContent = t('save');
  }
}

async function deleteAnnouncement(id) {
  if (!canManage) return;
  if (!confirm(t('confirmDeleteAnnouncement'))) return;
  try {
    await set(ref(db, `announcementComments/${id}`), null);
    await set(ref(db, `announcements/${id}`), null);
  } catch (err) {
    console.error('Error deleting announcement:', err);
    alert(t('deleteFailed'));
  }
}

async function deleteComment(announcementId, commentId) {
  if (!canManage) return;
  if (!confirm(t('confirmDeleteComment'))) return;
  try {
    await set(ref(db, `announcementComments/${announcementId}/${commentId}`), null);
  } catch (err) {
    console.error('Error deleting comment:', err);
    alert(t('deleteFailed'));
  }
}

async function addComment(announcementId, text) {
  const newCommentRef = push(ref(db, `announcementComments/${announcementId}`));
  await set(newCommentRef, {
    text,
    createdBy: currentUser.uid,
    createdByName: displayName,
    createdAt: new Date().toISOString()
  });
}

/* =========================================
   EVENT HANDLERS
========================================= */
async function handleCommentSubmit(e) {
  e.preventDefault();
  const announcementId = currentViewId;
  if (!announcementId) return;
  const input = commentForm.querySelector('input[name="commentText"]');
  const button = commentForm.querySelector('button[type="submit"]');
  const text = (input?.value || '').trim();
  if (!text) {
    alert(t('commentRequired'));
    return;
  }
  button.disabled = true;
  try {
    await addComment(announcementId, text);
    input.value = '';
  } catch (err) {
    console.error('Error adding comment:', err);
    alert(t('commentFailed'));
  } finally {
    button.disabled = false;
  }
}

/* =========================================
   REALTIME DATA
========================================= */
function subscribeBulletinData() {
  if (dataSubscribed) return;
  dataSubscribed = true;
  onValue(ref(db, 'announcements'), (snapshot) => {
    announcements = snapshot.val() || {};
    renderCards();
    if (currentViewId) {
      if (announcements[currentViewId]) renderDetail();
      else { clearHashSilently(); showListView(); }
    }
    if (!initialRouteApplied) {
      initialRouteApplied = true;
      handleHashChange();
    }
  }, (error) => {
    console.error('Error loading announcements:', error);
    if (announcementList) announcementList.innerHTML = `<div class="error-message">${escapeHtml(t('loadFailed'))}</div>`;
    pageLoader?.classList.add('hidden');
  });

  onValue(ref(db, 'announcementComments'), (snapshot) => {
    comments = snapshot.val() || {};
    renderCards();
    if (currentViewId) renderComments();
  }, (error) => {
    console.error('Error loading comments:', error);
  });
}

/* =========================================
   PAGE INIT
========================================= */
function startBulletinPage() {
  applyAnnouncementSpecificI18n();

  backBtn?.addEventListener('click', () => { window.location.href = 'centers.html'; });
  newAnnouncementBtn?.addEventListener('click', openNewAnnouncement);
  
  announcementList?.addEventListener('click', (e) => {
    const card = e.target.closest('.announcement-card');
    if (card) openAnnouncementById(card.dataset.id);
  });
  announcementList?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.announcement-card');
    if (!card) return;
    e.preventDefault();
    openAnnouncementById(card.dataset.id);
  });

  backToListBtn?.addEventListener('click', () => { clearHashSilently(); showListView(); });
  editAnnouncementBtn?.addEventListener('click', () => { if (currentViewId) openEditAnnouncement(currentViewId); });
  deleteAnnouncementBtn?.addEventListener('click', () => { if (currentViewId) deleteAnnouncement(currentViewId); });
  
  commentList?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="delete-comment"]');
    if (!btn || btn.disabled) return;
    deleteComment(btn.dataset.announcementId, btn.dataset.commentId);
  });
  commentForm?.addEventListener('submit', handleCommentSubmit);

  cancelAnnouncementBtn?.addEventListener('click', closeAnnouncementModal);
  closeAnnouncementModalBtn?.addEventListener('click', closeAnnouncementModal);
  announcementModal?.addEventListener('click', (e) => { if (e.target === announcementModal) closeAnnouncementModal(); });
  announcementForm?.addEventListener('submit', saveAnnouncement);

  window.addEventListener('hashchange', handleHashChange);

  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'index.html'; return; }
    currentUser = user;
    try {
      const userSnap = await get(ref(db, `users/${user.uid}`));
      if (!userSnap.exists()) { window.location.href = 'index.html'; return; }
      currentUserData = userSnap.val();
      displayName = currentUserData?.name || currentUserData?.englishName || user.email || '';
      canManage = await canManageBulletin(user, currentUserData);
      newAnnouncementBtn?.classList.toggle('hidden', !canManage);
      subscribeBulletinData();
      pageLoader?.classList.add('hidden');
    } catch (error) {
      console.error('Error loading bulletin page:', error);
      pageLoader?.classList.add('hidden');
      if (announcementList) announcementList.innerHTML = `<div class="error-message">${escapeHtml(t('loadFailed'))}</div>`;
    }
  });
}

startBulletinPage();