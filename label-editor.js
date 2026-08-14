// label-editor.js
import { auth, db, logout } from './auth.js';
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const centerId = sessionStorage.getItem('selectedCenter');
const GRADE_9_PLUS_VALUE = '9+';

function getSubjectsArray(student) {
    if (!student) return [];
    return Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
}

function isActiveStudent(student) {
    return getSubjectsArray(student).some(subject => subject?.status === 'current');
}

function getGradeNumber(grade) {
    const gradeText = String(grade ?? '').trim();
    const match = gradeText.match(/\d+/);
    return match ? Number.parseInt(match[0], 10) : null;
}

function isGrade9OrAbove(grade) {
    const gradeNumber = getGradeNumber(grade);
    return gradeNumber !== null && gradeNumber >= 9;
}

function compareGrades(aGrade, bGrade) {
    const aNumber = getGradeNumber(aGrade);
    const bNumber = getGradeNumber(bGrade);
    if (aNumber !== null && bNumber !== null) return aNumber - bNumber;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return String(aGrade ?? '').localeCompare(String(bGrade ?? ''));
}

function buildGradeFilterOptions(students, gradeSelect) {
    gradeSelect.innerHTML = '<option value="all">All Grades</option>';
    const optionsByKey = new Map();

    students.filter(isActiveStudent).forEach(student => {
        const rawGrade = String(student.grade ?? '').trim();
        if (!rawGrade) return;

        if (isGrade9OrAbove(rawGrade)) {
            if (!optionsByKey.has(GRADE_9_PLUS_VALUE)) {
                optionsByKey.set(GRADE_9_PLUS_VALUE, { value: GRADE_9_PLUS_VALUE, label: 'Grade 9 & Above', sort: 9 });
            }
            return;
        }

        if (!optionsByKey.has(rawGrade)) {
            const gradeNumber = getGradeNumber(rawGrade);
            optionsByKey.set(rawGrade, { value: rawGrade, label: `Grade ${rawGrade}`, sort: gradeNumber === null ? 999 : gradeNumber });
        }
    });

    [...optionsByKey.values()]
        .sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))
        .forEach(option => {
            const opt = document.createElement('option');
            opt.value = option.value;
            opt.textContent = option.label;
            gradeSelect.appendChild(opt);
        });
}

function getFilteredActiveStudents(students, selectedGrade) {
    let filtered = students.filter(isActiveStudent);

    if (selectedGrade && selectedGrade !== 'all') {
        if (selectedGrade === GRADE_9_PLUS_VALUE) {
            filtered = filtered.filter(student => isGrade9OrAbove(student.grade));
        } else {
            filtered = filtered.filter(student => String(student.grade ?? '').trim() === selectedGrade);
        }
    }

    filtered.sort((a, b) => {
        const gradeComparison = compareGrades(a.grade, b.grade);
        if (gradeComparison !== 0) return gradeComparison;
        const aName = a.namePinyin || a.nameCn || '';
        const bName = b.namePinyin || b.nameCn || '';
        return aName.localeCompare(bName);
    });

    return filtered;
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    const isAdmin = user.email?.toLowerCase() === 'kumonchamps@gmail.com';
    let hasAccess = isAdmin;

    if (!hasAccess) {
        try {
            const userSnap = await get(ref(db, `users/${user.uid}`));
            if (userSnap.exists()) {
                const perms = userSnap.val().permissions?.dashboardCards || {};
                hasAccess = perms['labelEditor'] === true;
            }
        } catch (err) { console.error(err); }
    }

    if (!hasAccess) {
        document.getElementById('accessDenied').style.display = 'flex';
        document.getElementById('mainContent').classList.add('hidden');
        return;
    }

    document.getElementById('mainContent').classList.remove('hidden');
    initApp();
});

document.getElementById('logoutBtn')?.addEventListener('click', logout);

async function initApp() {
  // ✅ Safety check for missing center ID
  if (!centerId) {
    alert('No center selected. Please go back to the dashboard and select a center first.');
    window.location.href = 'dashboard.html';
    return;
  }

  const gradeSelect = document.getElementById('gradeSelect');
  const generateBtn = document.getElementById('generateBtn');
  const exportDocxBtn = document.getElementById('exportDocxBtn');
  const printArea = document.getElementById('print-area');
  const studentCountEl = document.getElementById('studentCount');
  const loadingEl = document.getElementById('studentsLoadingIndicator');

  function setLoading(isLoading, message = 'Loading students…') {
    if (loadingEl) {
      loadingEl.hidden = !isLoading;

      const textEl = loadingEl.querySelector('.loading-text');
      if (textEl) {
        textEl.textContent = message;
      }
    }

    gradeSelect.disabled = isLoading;
    generateBtn.disabled = isLoading;

    // Keep export disabled until a preview is generated.
    exportDocxBtn.disabled = true;

    if (isLoading) {
      gradeSelect.innerHTML = '<option value="">Loading students…</option>';
      if (studentCountEl) {
        studentCountEl.textContent = message;
      }
    }
  }

  // ✅ Show visible loading state immediately
  setLoading(true);

  let allStudents = [];

  try {
    const snap = await get(ref(db, `centers/${centerId}/students`));

    if (snap.exists()) {
      snap.forEach(child => {
        const val = child.val();
        const subjects = Array.isArray(val.subjects)
          ? val.subjects
          : Object.values(val.subjects || {});

        const hasActive = subjects.some(s => s.status === 'current');

        if (hasActive) {
          allStudents.push({ id: child.key, ...val });
        }
      });
    }
  } catch (err) {
    console.error('Error fetching students:', err);

    if (loadingEl) {
      loadingEl.hidden = true;
    }

    gradeSelect.disabled = true;
    generateBtn.disabled = true;
    exportDocxBtn.disabled = true;

    if (studentCountEl) {
      studentCountEl.textContent =
        '❌ Unable to load students. Please refresh the page and try again.';
    }

    return;
  }

  // ✅ Build dropdown options after students are loaded
  buildGradeFilterOptions(allStudents, gradeSelect);

  // ✅ Hide loading state and enable dropdown
  setLoading(false);

  if (studentCountEl) {
    studentCountEl.textContent = allStudents.length
      ? `Loaded ${allStudents.length} active students. Select a grade and generate preview.`
      : 'No active students found for this center.';
  }

  generateBtn.addEventListener('click', () => {
    const filtered = getFilteredActiveStudents(allStudents, gradeSelect.value);

    studentCountEl.textContent = `Found ${filtered.length} active students.`;
    printArea.innerHTML = '';

    const chunkSize = 24;

    for (let i = 0; i < filtered.length; i += chunkSize) {
      const chunk = filtered.slice(i, i + chunkSize);

      const pageDiv = document.createElement('div');
      pageDiv.className = 'print-page';

      const gridDiv = document.createElement('div');
      gridDiv.className = 'label-grid';

      for (let j = 0; j < chunkSize; j++) {
        const student = chunk[j];
        gridDiv.innerHTML += generateLabelHTML(student);
      }

      pageDiv.appendChild(gridDiv);
      printArea.appendChild(pageDiv);
    }

    exportDocxBtn.style.display = 'inline-block';
    exportDocxBtn.disabled = filtered.length === 0;

    printArea.scrollIntoView({ behavior: 'smooth' });
  });

  exportDocxBtn.addEventListener('click', () => {
    const filtered = getFilteredActiveStudents(allStudents, gradeSelect.value);
    exportToDOCX(filtered);
  });
}

function exportToDOCX(students) {
    if (typeof window.docx === 'undefined') {
        alert('❌ DOCX library not loaded. Please check your internet connection.');
        return;
    }
    if (typeof window.saveAs === 'undefined') {
        alert('❌ FileSaver library not loaded.');
        return;
    }

    const { 
        Document, Table, TableRow, TableCell, Paragraph, TextRun, 
        WidthType, AlignmentType, BorderStyle, Packer, HeightRule, VerticalAlign, PageOrientation
    } = window.docx;

    const labelTables = [];

// Helper to build a grid cell
const gridCell = (text, { bold = false, size = 16 } = {}) => new TableCell({
    width: { size: 11.25, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: [new TextRun({ text: text || ' ', bold, size })] })]
});

students.forEach(student => {
    const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
    const getEnrolDate = (subjName) => {
        const sub = subjects.find(s => s.name === subjName && s.status === 'current');
        if (sub && sub.enrolDate) {
            const d = new Date(sub.enrolDate);
            return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}`;
        }
        return ' ';
    };

    const chineseName = student.nameCn || '';
    const pinyinName = student.namePinyin || '';
    const dob = student.birthday || '';
    const studentNo = student.studentNumber || '';

    // ✅ ONE single flat table per label — no nested tables
    const labelTable = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
            top: { style: BorderStyle.SINGLE, size: 8 }, bottom: { style: BorderStyle.SINGLE, size: 8 },
            left: { style: BorderStyle.SINGLE, size: 8 }, right: { style: BorderStyle.SINGLE, size: 8 },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 4 }, insideVertical: { style: BorderStyle.SINGLE, size: 4 }
        },
        rows: [
            // Row 1: student info (rowSpan 5) + "上課:" header (columnSpan 4)
            new TableRow({
                height: { value: 350, rule: HeightRule.EXACT },
                children: [
                    new TableCell({
                        width: { size: 55, type: WidthType.PERCENTAGE },
                        rowSpan: 5,
                        verticalAlign: VerticalAlign.CENTER,
                        children: [
                            new Paragraph({ children: [new TextRun({ text: "姓名: ", bold: true, size: 18 }), new TextRun({ text: chineseName, bold: true, size: 32 })] }),
                            new Paragraph({ children: [new TextRun({ text: "NAME: ", bold: true, size: 18 }), new TextRun({ text: pinyinName, size: 20 })] }),
                            new Paragraph({ children: [new TextRun({ text: "DOB: ", bold: true, size: 18 }), new TextRun({ text: dob, size: 20 })] }),
                            new Paragraph({ children: [new TextRun({ text: "學生編號:", bold: true, size: 18 })] }),
                            new Paragraph({ children: [new TextRun({ text: studentNo, bold: true, size: 22 })] })
                        ]
                    }),
                    new TableCell({
                        width: { size: 45, type: WidthType.PERCENTAGE },
                        columnSpan: 4,
                        verticalAlign: VerticalAlign.CENTER,
                        children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: "上課:", bold: true, size: 18 })] })]
                    })
                ]
            }),
            // Row 2: subject headers
            new TableRow({
                height: { value: 350, rule: HeightRule.EXACT },
                children: [gridCell("中", { bold: true }), gridCell("英", { bold: true }), gridCell("EFL", { bold: true }), gridCell("數", { bold: true })]
            }),
            // Row 3: enrolment dates
            new TableRow({
                height: { value: 350, rule: HeightRule.EXACT },
                children: [
                    gridCell(getEnrolDate('Chinese (Trad)') || getEnrolDate('Chinese (Simp)'), { size: 14 }),
                    gridCell(getEnrolDate('English ERP'), { size: 14 }),
                    gridCell(getEnrolDate('English EFL'), { size: 14 }),
                    gridCell(getEnrolDate('Math'), { size: 14 })
                ]
            }),
            // Row 4: award headers
            new TableRow({
                height: { value: 350, rule: HeightRule.EXACT },
                children: [gridCell("平", { bold: true }), gridCell("銅", { bold: true }), gridCell("銀", { bold: true }), gridCell("金", { bold: true })]
            }),
            // Row 5: empty row
            new TableRow({
                height: { value: 350, rule: HeightRule.EXACT },
                children: [gridCell(' '), gridCell(' '), gridCell(' '), gridCell(' ')]
            })
        ]
    });

    labelTables.push(labelTable);
});

    const docChildren = [];
    const labelsPerPage = 24;

    for (let pageIndex = 0; pageIndex < labelTables.length; pageIndex += labelsPerPage) {
        const pageLabels = labelTables.slice(pageIndex, pageIndex + labelsPerPage);
        const pageRows = [];

        for (let rowIndex = 0; rowIndex < 6; rowIndex++) {
            const rowCells = [];
            for (let colIndex = 0; colIndex < 4; colIndex++) {
                const labelIndex = rowIndex * 4 + colIndex;
                if (pageLabels[labelIndex]) {
                    rowCells.push(new TableCell({ 
                        children: [pageLabels[labelIndex]], 
                        width: { size: 25, type: WidthType.PERCENTAGE } 
                    }));
                } else {
                    rowCells.push(new TableCell({ 
                        children: [new Paragraph({ children: [new TextRun({ text: " " })] })], 
                        width: { size: 25, type: WidthType.PERCENTAGE } 
                    }));
                }
            }
            pageRows.push(new TableRow({ 
                children: rowCells,
                height: { value: 1750, rule: HeightRule.EXACT }
            }));
        }

        const pageTable = new Table({
            rows: pageRows,
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
                top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
                left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
                insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE }
            }
        });
        docChildren.push(pageTable);

        if (pageIndex + labelsPerPage < labelTables.length) {
            docChildren.push(new Paragraph({
                pageBreakBefore: true,
                children: [new TextRun({ text: "" })]
            }));
        }
    }

    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    size: { 
                        orientation: PageOrientation.LANDSCAPE,
                        width: 16838, 
                        height: 11906 
                    },
                    margin: { top: 567, right: 567, bottom: 567, left: 567 }
                }
            },
            children: docChildren
        }]
    });

    Packer.toBlob(doc).then(blob => {
        const fileName = `Student_Labels_${new Date().toISOString().split('T')[0]}.docx`;
        window.saveAs(blob, fileName);
        alert('✅ DOCX file downloaded successfully!');
    }).catch(err => {
        console.error('Error generating DOCX:', err);
        alert('❌ Error generating DOCX file: ' + err.message);
    });
}

function generateLabelHTML(student) {
    if (!student) {
        return '<div class="label-cell" style="border: 1px dashed #ccc;"></div>';
    }

    const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
    const getEnrolDate = function(subjName) {
        const sub = subjects.find(function(s) { return s.name === subjName && s.status === 'current'; });
        if (sub && sub.enrolDate) {
            const d = new Date(sub.enrolDate);
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yy = String(d.getFullYear()).slice(-2);
            return mm + '/' + yy;
        }
        return '';
    };

    const chineseName = student.nameCn || '';
    const pinyinName = student.namePinyin || '';
    const dob = student.birthday || '';
    const studentNo = student.studentNumber || '';

    const enrolChinese = getEnrolDate('Chinese (Trad)') || getEnrolDate('Chinese (Simp)');
    const enrolEnglish = getEnrolDate('English ERP');
    const enrolEFL = getEnrolDate('English EFL');
    const enrolMath = getEnrolDate('Math');

    return '<div class="label-cell">' +
        '<div class="label-left">' +
            '<div class="info-row">' +
                '<span class="info-label">姓名:</span>' +
                '<span class="info-value">' + chineseName + '</span>' +
            '</div>' +
            '<div class="info-row">' +
                '<span class="info-label">NAME:</span>' +
                '<span class="info-value">' + pinyinName + '</span>' +
            '</div>' +
            '<div class="info-row">' +
                '<span class="info-label">DOB:</span>' +
                '<span class="info-value">' + dob + '</span>' +
            '</div>' +
            '<div class="info-row">' +
                '<span class="info-label">學生編號:</span>' +
                '<span class="info-value">' + studentNo + '</span>' +
            '</div>' +
        '</div>' +
        '<div class="label-right">' +
            '<div class="unified-grid">' +
                '<div class="grid-header">上課:</div>' +
                '<div>中</div><div>英</div><div>EFL</div><div>數</div>' +
                '<div>' + enrolChinese + '</div>' +
                '<div>' + enrolEnglish + '</div>' +
                '<div>' + enrolEFL + '</div>' +
                '<div>' + enrolMath + '</div>' +
                '<div>平</div><div>銅</div><div>銀</div><div>金</div>' +
                '<div>&nbsp;</div><div>&nbsp;</div><div>&nbsp;</div><div>&nbsp;</div>' +
            '</div>' +
        '</div>' +
    '</div>';
}