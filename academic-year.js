// academic-year.js
// Single source of truth for school-year math and the Aug 15 grade rollover.
// Every place that STAMPS a student's grade year and every place that
// COMPARES it imports from here, so the two can never disagree.

import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

import { OVER_F6 } from './grade-rollover.js';

export const GRADE_ORDER = ['K0', 'K1', 'K2', 'K3', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const TERMINAL_GRADES = new Set(['13', OVER_F6]);

// School year flips on Aug 15 (local time).
// Aug 15 2026 → Aug 14 2027 = academic year 2026.
export function getAcademicYearSafe(date = new Date()) {
    const y = date.getFullYear();
    const flipped = date.getMonth() > 7 || (date.getMonth() === 7 && date.getDate() >= 15);
    return flipped ? y : y - 1;
}

export function getAcademicYearStart(academicYear) {
    return new Date(academicYear, 7, 15, 0, 0, 0, 0); // Aug 15, local midnight
}

function nextGrade(grade) {
    const g = String(grade ?? '').trim();
    if (TERMINAL_GRADES.has(g)) return grade;   // 13 / Over F6 → stop
    if (g === '12') return OVER_F6;             // F6 → Over F6, then stop
    const idx = GRADE_ORDER.indexOf(g);
    return idx === -1 ? grade : GRADE_ORDER[idx + 1]; // custom "Other" grades untouched
}

// Safe, idempotent rollover. Rules:
// 1. A student is advanced at most ONE grade per academic year.
// 2. A student created on/after this school year's Aug 15 is NEVER
//    advanced — their grade was entered for THIS school year.
// 3. A student with no valid year stamp is stamped, never bumped —
//    the grade on file is assumed correct.
// 4. Runs at most once per day per center.
export async function runSafeGradeRollover(db, centerId) {
    const result = { bumped: 0, stamped: 0 };
    if (!db || !centerId) return result;

    const academicYear = getAcademicYearSafe();
    const yearStart = getAcademicYearStart(academicYear);
    const n = new Date();
    const todayKey = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    const guardKey = `kumonGradeRollover_${centerId}`;

    try {
        if (localStorage.getItem(guardKey) === todayKey) return result;
    } catch (_) { /* storage unavailable — still safe, just runs again */ }

    try {
        const studentsRef = ref(db, `centers/${centerId}/students`);
        const snap = await get(studentsRef);
        if (!snap.exists()) {
            try { localStorage.setItem(guardKey, todayKey); } catch (_) {}
            return result;
        }

        const updates = {};
        const nowIso = new Date().toISOString();

        snap.forEach(child => {
            const s = child.val() || {};
            const id = child.key;
            const stamp = Number(s.lastGradeUpdateYear);
            const hasStamp = Number.isFinite(stamp) && stamp > 0;
            const created = s.createdAt ? new Date(s.createdAt) : null;
            const createdThisYear = created && !isNaN(created.getTime()) && created >= yearStart;

            // Hard guard: entered during the current school year → never bump.
            if (createdThisYear) {
                if (!hasStamp || stamp !== academicYear) {
                    updates[`${id}/lastGradeUpdateYear`] = academicYear;
                    result.stamped++;
                }
                return;
            }

            // No trustworthy stamp → assume the grade is correct, stamp only.
            if (!hasStamp) {
                updates[`${id}/lastGradeUpdateYear`] = academicYear;
                result.stamped++;
                return;
            }

            // Genuine rollover: stamped in an earlier school year.
            if (stamp < academicYear) {
                const upgraded = nextGrade(s.grade);
                if (upgraded !== s.grade) {
                    updates[`${id}/grade`] = upgraded;
                    result.bumped++;
                }
                updates[`${id}/lastGradeUpdateYear`] = academicYear;
                updates[`${id}/updatedAt`] = nowIso;
            }
        });

        if (Object.keys(updates).length > 0) {
            await update(studentsRef, updates);
        }
        try { localStorage.setItem(guardKey, todayKey); } catch (_) {}

        if (result.bumped) console.log(`🍂 Grade rollover: advanced ${result.bumped} student(s) one grade for school year ${academicYear}.`);
        if (result.stamped) console.log(`🏷️ Grade rollover: stamped ${result.stamped} student(s) without changing their grade.`);
    } catch (err) {
        console.error('Grade rollover error:', err);
    }
    return result;
}