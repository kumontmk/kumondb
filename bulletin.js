import { auth, requireAuth, logout, db } from './auth.js';
import { ref, get, set, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

let centerId = sessionStorage.getItem('selectedCenter');
let centerName = "";
let centerNameCn = "";
let calendarEventsMap = {};
let windowLastSelection = null; 

const centerSchedules = {
    'mei keng': { 1: '14:30 - 19:00', 2: '14:30 - 19:00', 3: '14:30 - 19:00', 4: '14:30 - 19:00', 5: '14:30 - 19:00', 6: '10:00 - 16:30' },
    'pac tat': { 1: '14:30 - 19:00', 2: '14:30 - 19:00', 3: '14:30 - 19:00', 4: '14:30 - 19:00', 5: '14:30 - 17:30' },
    'champs': { 1: '15:00 - 19:30', 2: '15:00 - 19:30', 3: '15:00 - 19:30', 4: '15:00 - 19:30', 5: '15:00 - 19:30', 6: '10:00 - 16:30' },
    'tap siac': { 1: '15:00 - 19:00', 3: '15:00 - 19:00', 4: '15:00 - 19:00', 5: '15:00 - 19:00', 6: '10:00 - 16:00', 0: '15:00 - 17:00' }
};

const centerClosedDays = { 'mei keng': [0], 'pac tat': [0, 6], 'champs': [0], 'tap siac': [2] };

const centerChineseNames = {
    'mei keng': '公文式氹仔美景教育中心',
    'pac tat': '公文式氹仔百達教育中心',
    'champs': '公文式卓思教育中心',
    'tap siac': '公文式塔石教育中心'
};

function getScheduleKey(name) {
    if (!name) return null;
    const lowerName = name.toLowerCase();
    if (lowerName.includes('mei keng')) return 'mei keng';
    if (lowerName.includes('pac tat')) return 'pac tat';
    if (lowerName.includes('champs')) return 'champs';
    if (lowerName.includes('tap siac')) return 'tap siac';
    return null;
}

const dayNames = ['日 Sun', '一 M', '二 T', '三 W', '四 Th', '五 F', '六 Sat'];
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthNamesCn = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

document.addEventListener('DOMContentLoaded', async () => {
    const isAuth = requireAuth();
    if (!isAuth) return;

    if (!centerId) {
        alert("No center selected.");
        window.location.href = "centers.html";
        return;
    }

    await loadCenterDetails();
    await loadSavedContent();
    setupEventListeners();
    setupRichTextToolbar();
    
    const now = new Date();
    document.getElementById('bulletinMonth').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    onValue(ref(db, `centers/${centerId}/calendar`), (snapshot) => {
        calendarEventsMap = snapshot.exists() ? snapshot.val() : {};
        renderBulletin();
    });
});

async function loadCenterDetails() {
    const snap = await get(ref(db, `centers/${centerId}`));
    if (snap.exists()) {
        const data = snap.val();
        centerName = data.name || data.centerName || "Center";
        const key = getScheduleKey(centerName);
        centerNameCn = centerChineseNames[key] || "公文式教育中心";
        
        document.getElementById('headerNameCn').textContent = centerNameCn;
        document.getElementById('headerNameEn').textContent = `Kumon ${centerName} Education Centre`;
    }
}

async function loadSavedContent() {
    const snap = await get(ref(db, `centers/${centerId}/bulletinText`));
    if (snap.exists()) {
        const data = snap.val();
        if (data.leftBox) document.getElementById('leftBox').innerHTML = data.leftBox;
        if (data.rightBox) document.getElementById('rightBox').innerHTML = data.rightBox;
        if (data.calendarTitle) document.getElementById('calendarTitle').innerHTML = data.calendarTitle;
        if (data.bulletinTitle) document.getElementById('bulletinTitle').innerHTML = data.bulletinTitle;
        if (data.bulletinSubtitle) document.getElementById('bulletinSubtitle').innerHTML = data.bulletinSubtitle;
    }
}

function setupEventListeners() {
    document.getElementById('bulletinMonth').addEventListener('change', renderBulletin);
    setupImageUpload('bgUpload', 'bulletin-canvas', 'backgroundImage');
    setupImageUpload('img1Upload', 'previewImg1', 'src');
    setupImageUpload('img2Upload', 'previewImg2', 'src');
    document.getElementById('saveContentBtn').addEventListener('click', saveTextContent);
    document.getElementById('downloadBtn').addEventListener('click', downloadPNG);
}

// ✅ IMAGE UPLOAD WITH DRAG & RESIZE (FIXED)
function setupImageUpload(inputId, targetId, styleProp) {
    document.getElementById(inputId).addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const target = document.getElementById(targetId);

            if (styleProp === 'backgroundImage') {
                target.style.backgroundImage = `url(${event.target.result})`;
            } else {
                target.classList.remove('hidden');
                target.src = event.target.result;

                const container = target.closest('.img-container');
                if (!container) return;

                // Ensure resize handle exists
                if (!container.querySelector('.resize-handle')) {
                    const handle = document.createElement('div');
                    handle.className = 'resize-handle';
                    container.appendChild(handle);
                }

                // Reset container flags so we can re-init
                container.dataset.init = '';
                container.dataset.dragInit = '';
                container.dataset.resizeInit = '';

                const initImage = () => {
                    if (container.dataset.init === 'true') return;

                    let w = target.naturalWidth || 150;
                    let h = target.naturalHeight || 150;

                    // Scale down if too large
                    const maxSize = 250;
                    if (w > maxSize || h > maxSize) {
                        const scale = Math.min(maxSize / w, maxSize / h);
                        w *= scale;
                        h *= scale;
                    }

                    container.style.width = w + 'px';
                    container.style.height = h + 'px';

                    // Set default positions using left/top (more reliable for dragging)
                    if (targetId === 'previewImg1') {
                        container.style.top = '0px';
                        container.style.left = 'auto';
                        container.style.right = '0px';
                    } else {
                        container.style.top = '20px';
                        container.style.left = 'auto';
                        container.style.right = '40px';
                    }

                    // Initialize drag and resize
                    makeDraggable(container);
                    makeResizable(container);
                    container.dataset.init = 'true';
                };

                if (target.complete && target.naturalWidth !== 0) {
                    initImage();
                } else {
                    target.onload = initImage;
                }
            }
        };
        reader.readAsDataURL(file);
    });
}

// ✅ DRAG FUNCTIONALITY (FIXED)
function makeDraggable(elmnt) {
    if (elmnt.dataset.dragInit === 'true') return;
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    elmnt.addEventListener('mousedown', dragMouseDown);
    elmnt.dataset.dragInit = 'true';

    function dragMouseDown(e) {
        if (e.target.classList.contains('resize-handle')) return;
        e.preventDefault();
        e.stopPropagation();

        pos3 = e.clientX;
        pos4 = e.clientY;

        // Ensure we're using left/top positioning (not right/bottom)
        if (elmnt.style.right && elmnt.style.right !== 'auto' && !elmnt.style.left) {
            const rect = elmnt.getBoundingClientRect();
            const parentRect = elmnt.offsetParent.getBoundingClientRect();
            elmnt.style.left = (rect.left - parentRect.left) + 'px';
            elmnt.style.top = (rect.top - parentRect.top) + 'px';
            elmnt.style.right = 'auto';
            elmnt.style.bottom = 'auto';
        }

        // If no position set yet, initialize from current offset
        if (!elmnt.style.left) {
            elmnt.style.left = elmnt.offsetLeft + 'px';
            elmnt.style.top = elmnt.offsetTop + 'px';
            elmnt.style.right = 'auto';
            elmnt.style.bottom = 'auto';
        }

        document.addEventListener('mouseup', closeDragElement);
        document.addEventListener('mousemove', elementDrag);
    }

    function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;

        elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
        elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
    }

    function closeDragElement() {
        document.removeEventListener('mouseup', closeDragElement);
        document.removeEventListener('mousemove', elementDrag);
    }
}

// ✅ RESIZE FUNCTIONALITY (FIXED)
function makeResizable(container) {
    if (container.dataset.resizeInit === 'true') return;
    const handle = container.querySelector('.resize-handle');
    if (!handle) return;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = container.offsetWidth;
        const startHeight = container.offsetHeight;
        const aspectRatio = startWidth / startHeight;

        function doDrag(e) {
            const deltaX = e.clientX - startX;
            const newWidth = Math.max(50, startWidth + deltaX);
            const newHeight = newWidth / aspectRatio;

            container.style.width = newWidth + 'px';
            container.style.height = newHeight + 'px';
        }

        function stopDrag() {
            document.removeEventListener('mousemove', doDrag);
            document.removeEventListener('mouseup', stopDrag);
        }

        document.addEventListener('mousemove', doDrag);
        document.addEventListener('mouseup', stopDrag);
    });

    container.dataset.resizeInit = 'true';
}
// ✅ RICH TEXT TOOLBAR
function setupRichTextToolbar() {
    const toolbar = document.getElementById('richTextToolbar');
    const buttons = toolbar.querySelectorAll('button');
    const selects = toolbar.querySelectorAll('select');
    const colorInputs = toolbar.querySelectorAll('input[type="color"]');
    
    document.querySelectorAll('.editable').forEach(el => {
        el.addEventListener('mouseup', saveSelection);
        el.addEventListener('keyup', saveSelection);
    });

    buttons.forEach(btn => {
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); });
        btn.addEventListener('click', (e) => {
            applyRichTextCommand(btn.dataset.cmd, null);
        });
    });

    selects.forEach(select => {
        select.addEventListener('mousedown', () => { saveSelection(); });
        select.addEventListener('change', (e) => {
            applyRichTextCommand(select.dataset.cmd, select.value);
        });
    });

    colorInputs.forEach(input => {
        input.addEventListener('mousedown', () => { saveSelection(); });
        input.addEventListener('input', (e) => {
            applyRichTextCommand(input.dataset.cmd, input.value);
        });
    });
}

function applyRichTextCommand(cmd, value) {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        document.execCommand(cmd, false, value);
    } else if (windowLastSelection) {
        selection.removeAllRanges();
        selection.addRange(windowLastSelection);
        document.execCommand(cmd, false, value);
    }
}

function saveSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        windowLastSelection = sel.getRangeAt(0);
    }
}

async function saveTextContent() {
    const btn = document.getElementById('saveContentBtn');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    try {
        await set(ref(db, `centers/${centerId}/bulletinText`), {
            leftBox: document.getElementById('leftBox').innerHTML,
            rightBox: document.getElementById('rightBox').innerHTML,
            calendarTitle: document.getElementById('calendarTitle').innerHTML,
            bulletinTitle: document.getElementById('bulletinTitle').innerHTML,
            bulletinSubtitle: document.getElementById('bulletinSubtitle').innerHTML,
            updatedAt: new Date().toISOString()
        });
        alert("Content saved successfully!");
    } catch (err) {
        console.error("Error saving content:", err);
        alert("Failed to save content.");
    } finally {
        btn.innerHTML = '<i class="fas fa-save"></i> Save Text Content';
    }
}

// ✅ CALENDAR RENDERING
function renderBulletin() {
    const monthInput = document.getElementById('bulletinMonth').value;
    if (!monthInput) return;

    const [year, month] = monthInput.split('-').map(Number);
    const key = getScheduleKey(centerName);
    if (!key) return;
    
    const schedule = centerSchedules[key] || {};
    const closedDays = centerClosedDays[key] || [];

    const titleEl = document.getElementById('bulletinTitle');
    if (!titleEl.dataset.edited) titleEl.textContent = `${year} 年 ${monthNamesCn[month-1]} 月教室通訊`;
    const subtitleEl = document.getElementById('bulletinSubtitle');
    if (!subtitleEl.dataset.edited) subtitleEl.textContent = `${monthNames[month-1]} ${year} Centre Bulletin`;
    const calTitleEl = document.getElementById('calendarTitle');
    if (!calTitleEl.dataset.edited) calTitleEl.textContent = `${monthNamesCn[month-1]} 月份教室上課時段 ${monthNames[month-1]} Class Schedule`;

    document.querySelectorAll('.editable').forEach(el => {
        el.addEventListener('input', () => { el.dataset.edited = 'true'; });
    });

    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = '';

    dayNames.forEach(day => {
        const div = document.createElement('div');
        div.className = 'day-header';
        div.textContent = day;
        grid.appendChild(div);
    });

    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
        const div = document.createElement('div');
        div.className = 'day-cell empty';
        grid.appendChild(div);
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayOfWeek = new Date(year, month - 1, day).getDay();
        const event = calendarEventsMap[dateStr];
        const isHoliday = event && !event.muc;
        const isClosed = closedDays.includes(dayOfWeek);

        const cell = document.createElement('div');
        cell.className = 'day-cell';

        if (isHoliday) {
            cell.classList.add('holiday');
            cell.innerHTML = `
                <span class="day-number editable" contenteditable="true">${day}</span>
                <span class="holiday-name editable" contenteditable="true">${event.name || 'Holiday / 假期'}</span>
            `;
        } else if (isClosed) {
            cell.classList.add('closed');
            cell.innerHTML = `<span class="day-number editable" contenteditable="true">${day}</span>`;
        } else if (schedule[dayOfWeek]) {
            cell.innerHTML = `
                <span class="day-number editable" contenteditable="true">${day}</span>
                <span class="day-time editable" contenteditable="true">${schedule[dayOfWeek]}</span>
            `;
        } else {
            cell.classList.add('closed');
            cell.innerHTML = `<span class="day-number editable" contenteditable="true">${day}</span>`;
        }

        grid.appendChild(cell);
    }
}

// ✅ DOWNLOAD FUNCTIONALITY
async function downloadPNG() {
    const canvas = document.getElementById('bulletin-canvas');
    const btn = document.getElementById('downloadBtn');
    
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
    btn.disabled = true;

    const editables = canvas.querySelectorAll('[contenteditable="true"]');
    editables.forEach(el => el.setAttribute('contenteditable', 'false'));

    const originalStyles = {
        position: canvas.style.position,
        top: canvas.style.top,
        left: canvas.style.left,
        transform: canvas.style.transform,
        marginBottom: canvas.style.marginBottom,
        zIndex: canvas.style.zIndex,
        boxShadow: canvas.style.boxShadow
    };

    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.transform = 'none';
    canvas.style.marginBottom = '0';
    canvas.style.zIndex = '-9999';
    canvas.style.boxShadow = 'none';

    try {
        await new Promise(resolve => setTimeout(resolve, 100));

        const canvasImg = await html2canvas(canvas, {
            scale: 1,
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#ffffff',
            width: 1600,
            height: 2260,
            windowWidth: 1600,
            windowHeight: 2260,
            scrollX: 0,
            scrollY: 0,
            logging: false
        });

        const dataUrl = canvasImg.toDataURL('image/jpeg', 1.0);
        const link = document.createElement('a');
        link.download = `Bulletin_${centerName}_${document.getElementById('bulletinMonth').value}.jpg`;
        link.href = dataUrl;
        link.click();
    } catch (err) {
        console.error("Error generating image:", err);
        alert("Failed to generate image: " + err.message);
    } finally {
        canvas.style.position = originalStyles.position;
        canvas.style.top = originalStyles.top;
        canvas.style.left = originalStyles.left;
        canvas.style.transform = originalStyles.transform;
        canvas.style.marginBottom = originalStyles.marginBottom;
        canvas.style.zIndex = originalStyles.zIndex;
        canvas.style.boxShadow = originalStyles.boxShadow;
        
        editables.forEach(el => el.setAttribute('contenteditable', 'true'));
        btn.innerHTML = '<i class="fas fa-download"></i> Download as JPEG (A2 Poster)';
        btn.disabled = false;
    }
}