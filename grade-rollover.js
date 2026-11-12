// ============================================
// 🍂 GRADE ROLLOVER — shared logic
// ============================================
// Confirmed rules:
// 1. Grades advance ONLY on August 15 (that exact day), run from the dashboard.
// 2. New students are stamped with the current academic year at creation
//    (student-form.js), so adding a student NEVER changes the grade.
// 3. Legacy students with no stamp: stamp only, never bump.
// 4. All statuses are included (current / inquiry / pause / drop / completer).
// 5. Grade 12 (F6) advances to the label "Over F6" and stops there.
//    "13" and "Over F6" are terminal and never change.
// ============================================
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

export const OVER_F6 = 'Over F6';

const GRADE_ORDER = ['K0', 'K1', 'K2', 'K3', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const TERMINAL_GRADES = new Set(['13', OVER_F6]);

// Academic year flips on Aug 15: Aug 15 2026 – Aug 14 2027 → 2026
export function getAcademicYear(now = new Date()) {
    const pastAug15 = now.getMonth() > 7 || (now.getMonth() === 7 && now.getDate() >= 15);
    return pastAug15 ? now.getFullYear() : now.getFullYear() - 1;
}

// Strict trigger: August 15 only — not Aug 16, not "any time after Aug 15"
export function isRolloverDay(now = new Date()) {
    return now.getMonth() === 7 && now.getDate() === 15;
}

export function getNextGrade(grade) {
    const g = String(grade ?? '').trim();
    if (TERMINAL_GRADES.has(g)) return g;          // already past F6 → stop
    if (g === '12') return OVER_F6;                // F6 → label, then stop
    const idx = GRADE_ORDER.indexOf(g);
    return idx === -1 ? g : GRADE_ORDER[idx + 1];  // custom "Other" grades left untouched
}

function showRolloverToast(text) {
    if (typeof document === 'undefined' || !document.body) return;
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:2rem', 'transform:translateX(-50%)',
        'background:#15803d', 'color:#fff', 'padding:0.75rem 1.5rem',
        'border-radius:999px', 'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
        'z-index:10001', 'font:600 0.92rem -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        'max-width:90vw', 'text-align:center'
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 7000);
}

// Call once when the dashboard loads. Safe to call on every load:
// - a sessionStorage guard runs it at most once per day per tab
// - the year stamps themselves make repeat runs no-ops
// Options: { force: true } simulates Aug 15 for testing,
//          { centerId: '...' } limits to one center,
//          { silent: true } suppresses the toast,
//          { toastText: '...' } overrides the toast message (for zh-TW).
export async function runGradeRollover(db, options = {}) {
    const { force = false, centerId = null, silent = false, toastText = '' } = options;
    const now = new Date();
    const academicYear = getAcademicYear(now);
    const rolloverActive = force || isRolloverDay(now);
    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const guardKey = `gradeRolloverChecked_${dayKey}${centerId ? '_' + centerId : '_all'}`;

    if (!force) {
        try {
            if (sessionStorage.getItem(guardKey)) {
                return { ok: true, skipped: true, advanced: 0, capped: 0, stamped: 0, changes: [] };
            }
        } catch (e) { /* storage unavailable → just run */ }
    }

    try {
        const snap = await get(ref(db, centerId ? `centers/${centerId}` : 'centers'));
        const centers = [];
        if (snap.exists()) {
            if (centerId) centers.push([centerId, snap.val() || {}]);
            else snap.forEach(c => centers.push([c.key, c.val() || {}]));
        }

        const updates = {};
        const changes = [];
        let advanced = 0, capped = 0, stamped = 0;

        centers.forEach(([cid, center]) => {
            const students = center.students || {};
            Object.entries(students).forEach(([sid, s]) => {
                if (!s || typeof s !== 'object') return;
                const path = `centers/${cid}/students/${sid}`;
                const stamp = parseInt(s.lastGradeUpdateYear, 10);

                // Rule 3: legacy record with no stamp → assume the stored grade
                // is already correct for this school year. Stamp only, never bump.
                if (!stamp) {
                    updates[`${path}/lastGradeUpdateYear`] = academicYear;
                    stamped++;
                    return;
                }

                // Rules 1 + 2: bump only on Aug 15, and only if the stamp
                // is from a previous academic year.
                if (!rolloverActive || stamp >= academicYear) return;

                const oldGrade = String(s.grade ?? '').trim();
                const newGrade = getNextGrade(oldGrade);
                updates[`${path}/lastGradeUpdateYear`] = academicYear;
                updates[`${path}/updatedAt`] = now.toISOString();
                if (newGrade !== oldGrade) {
                    updates[`${path}/grade`] = newGrade;
                    if (newGrade === OVER_F6) capped++; else advanced++;
                    changes.push({
                        centerId: cid,
                        studentId: sid,
                        name: s.nameCn || s.namePinyin || sid,
                        from: oldGrade,
                        to: newGrade
                    });
                }
            });
        });

        if (Object.keys(updates).length) {
            await update(ref(db), updates); // one atomic multi-path write
        }

        try { sessionStorage.setItem(guardKey, '1'); } catch (e) {}

        if (changes.length) {
            console.log(`🍂 Grade rollover (${dayKey}):`, changes);
            if (!silent) {
                showRolloverToast(toastText ||
                    `🍂 August 15 rollover: ${advanced} grade${advanced === 1 ? '' : 's'} advanced${capped ? `, ${capped} labeled ${OVER_F6}` : ''}.`);
            }
        }
        return { ok: true, skipped: false, rolloverActive, academicYear, advanced, capped, stamped, changes };
    } catch (err) {
        console.error('Grade rollover check failed:', err);
        return { ok: false, error: err };
    }
}