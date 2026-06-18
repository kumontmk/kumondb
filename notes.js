import { auth, requireAuth, logout, db } from './auth.js';
import { ref, update, remove, onValue, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

document.addEventListener('DOMContentLoaded', () => {
    const isAuth = requireAuth();
    if (!isAuth) return;

    const storedUser = sessionStorage.getItem('kumonUser');
    let currentUserUid = auth.currentUser?.uid;
    
    if (!currentUserUid && storedUser) {
        try { currentUserUid = JSON.parse(storedUser).uid; } catch(e) {}
    }

    if (storedUser) {
        const user = JSON.parse(storedUser);
        document.getElementById('userInfo').textContent = `${user.name || user.email} Notes`;
    }

    document.getElementById('logoutBtn')?.addEventListener('click', logout);

    if (currentUserUid) {
        initNotesPage(currentUserUid);
    } else {
        document.getElementById('notesGrid').innerHTML = '<div class="empty-state">⚠️ Could not load user session. Please refresh or log in again.</div>';
    }
});

function initNotesPage(uid) {
    const notesGrid = document.getElementById('notesGrid');
    const modal = document.getElementById('noteModal');
    const form = document.getElementById('noteForm');
    const addBtn = document.getElementById('addNoteBtn');
    const cancelBtn = document.getElementById('cancelModal');
    
    // View Modal Elements
    const viewModal = document.getElementById('viewNoteModal');
    const closeViewBtn = document.getElementById('closeViewModal');
    const viewTitle = document.getElementById('viewNoteTitle');
    const viewMeta = document.getElementById('viewNoteMeta');
    const viewBody = document.getElementById('viewNoteBody');
    const viewEditBtn = document.getElementById('viewEditBtn');
    const viewDeleteBtn = document.getElementById('viewDeleteBtn');
    
    let currentViewNoteId = null;
    let currentNotesArray = []; // Keep track of notes for the view modal

    // Modal Controls
    const openModal = () => { modal.classList.remove('hidden'); };
    const closeModal = () => { modal.classList.add('hidden'); };
    const openViewModal = () => { viewModal.classList.remove('hidden'); };
    const closeViewModal = () => { viewModal.classList.add('hidden'); };

    // Rich Text Toolbar Listeners
    document.getElementById('boldBtn').addEventListener('click', () => document.execCommand('bold'));
    document.getElementById('italicBtn').addEventListener('click', () => document.execCommand('italic'));

    addBtn.addEventListener('click', () => {
        form.reset();
        document.getElementById('noteId').value = '';
        document.getElementById('noteBodyInput').innerHTML = ''; // Clear rich text
        document.getElementById('modalTitle').textContent = 'Add New Note';
        openModal();
    });

    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    
    closeViewBtn.addEventListener('click', closeViewModal);
    viewModal.addEventListener('click', (e) => { if (e.target === viewModal) closeViewModal(); });

    // View Modal Actions
    viewEditBtn.addEventListener('click', () => {
        const note = currentNotesArray.find(n => n.id === currentViewNoteId);
        if (note) {
            document.getElementById('noteId').value = note.id;
            document.getElementById('noteTitleInput').value = note.title;
            document.getElementById('noteBodyInput').innerHTML = note.body; // Load HTML
            document.getElementById('modalTitle').textContent = 'Edit Note';
            closeViewModal();
            openModal();
        }
    });

    viewDeleteBtn.addEventListener('click', async () => {
        if (confirm('Are you sure you want to delete this note?')) {
            try { 
                await remove(ref(db, `notes/${uid}/${currentViewNoteId}`)); 
                closeViewModal();
            } catch (err) { alert('Failed to delete note.'); }
        }
    });

    // Save / Update Note
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const noteId = document.getElementById('noteId').value;
        const title = document.getElementById('noteTitleInput').value.trim();
        
        // Get HTML from contenteditable div
        const bodyEl = document.getElementById('noteBodyInput');
        const body = bodyEl.innerHTML.trim();

        // Check if body is actually empty (contenteditable might leave <br> tags)
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = body;
        const isBodyEmpty = !tempDiv.textContent.trim();

        if (!title || isBodyEmpty) return alert('Please fill in both Title and Body.');

        const saveBtn = document.getElementById('saveNoteBtn');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        const noteData = { title, body, updatedAt: new Date().toISOString() };

        try {
            if (noteId) {
                await update(ref(db, `notes/${uid}/${noteId}`), noteData);
            } else {
                noteData.createdAt = new Date().toISOString();
                await push(ref(db, `notes/${uid}`), noteData);
            }
            closeModal();
        } catch (err) {
            console.error('Error saving note:', err);
            alert('Failed to save note.');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Note';
        }
    });

    // Real-time Listener
    onValue(ref(db, `notes/${uid}`), (snapshot) => {
        renderNotes(snapshot.val() || {});
    });

    function renderNotes(notesObj) {
        notesGrid.innerHTML = '';
        currentNotesArray = Object.entries(notesObj).map(([id, data]) => ({ id, ...data }));
        currentNotesArray.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

        if (currentNotesArray.length === 0) {
            notesGrid.innerHTML = '<div class="empty-state">📭 No notes yet. Click "Add New Note" to create your first one!</div>';
            return;
        }

        currentNotesArray.forEach(note => {
            const card = document.createElement('div');
            card.className = 'note-card';
            const updatedDate = new Date(note.updatedAt || note.createdAt).toLocaleString();

            // Note: We DO NOT escape note.body here because it contains HTML tags from the rich text editor
            card.innerHTML = `
                <div class="note-title">${escapeHtml(note.title)}</div>
                <div class="note-body">${note.body}</div>
                <div class="note-meta">Last updated: ${escapeHtml(updatedDate)}</div>
                <div class="note-actions">
                    <button class="secondary edit-btn" data-id="${note.id}">✏️ Edit</button>
                    <button class="danger delete-btn" data-id="${note.id}">🗑️ Delete</button>
                </div>
            `;
            
            // Click anywhere on the card to open the View Modal
            card.addEventListener('click', (e) => {
                // Ignore if the user clicked the Edit or Delete buttons
                if (e.target.closest('.note-actions')) return; 
                
                currentViewNoteId = note.id;
                viewTitle.textContent = note.title;
                viewMeta.textContent = `Last updated: ${updatedDate}`;
                viewBody.innerHTML = note.body; // Render full HTML
                openViewModal();
            });

            notesGrid.appendChild(card);
        });

        // Attach listeners to Edit/Delete buttons (with stopPropagation to prevent triggering the card click)
        document.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const note = currentNotesArray.find(n => n.id === btn.dataset.id);
                if (note) {
                    document.getElementById('noteId').value = note.id;
                    document.getElementById('noteTitleInput').value = note.title;
                    document.getElementById('noteBodyInput').innerHTML = note.body;
                    document.getElementById('modalTitle').textContent = 'Edit Note';
                    openModal();
                }
            });
        });

        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm('Are you sure you want to delete this note?')) {
                    try { await remove(ref(db, `notes/${uid}/${btn.dataset.id}`)); } 
                    catch (err) { alert('Failed to delete note.'); }
                }
            });
        });
    }

    // Basic XSS prevention for Titles and Dates (NOT for the note body)
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}