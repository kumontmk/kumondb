// label-editor.js
import { auth, db, logout } from './auth.js';
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const centerId = sessionStorage.getItem('selectedCenter');

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
    const gradeSelect = document.getElementById('gradeSelect');
    const generateBtn = document.getElementById('generateBtn');
    const exportDocxBtn = document.getElementById('exportDocxBtn');
    const printArea = document.getElementById('print-area');
    const studentCountEl = document.getElementById('studentCount');

    let allStudents = [];

    try {
        const snap = await get(ref(db, `centers/${centerId}/students`));
        if (snap.exists()) {
            snap.forEach(child => {
                const val = child.val();
                const subjects = Array.isArray(val.subjects) ? val.subjects : Object.values(val.subjects || {});
                const hasActive = subjects.some(s => s.status === 'current');
                if (hasActive) allStudents.push({ id: child.key, ...val });
            });
        }
    } catch (err) { console.error("Error fetching students:", err); }

    const grades = [...new Set(allStudents.map(s => s.grade).filter(g => g))].sort();
    grades.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = `Grade ${g}`;
        gradeSelect.appendChild(opt);
    });

    generateBtn.addEventListener('click', () => {
        const selectedGrade = gradeSelect.value;
        let filtered = selectedGrade === 'all' 
            ? allStudents 
            : allStudents.filter(s => s.grade === selectedGrade);

        filtered.sort((a, b) => {
            if (a.grade !== b.grade) return (a.grade || '').localeCompare(b.grade || '');
            return (a.namePinyin || a.nameCn || '').localeCompare(b.namePinyin || b.nameCn || '');
        });

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
        printArea.scrollIntoView({ behavior: 'smooth' });
    });

    exportDocxBtn.addEventListener('click', () => {
        const selectedGrade = gradeSelect.value;
        let filtered = selectedGrade === 'all' 
            ? allStudents 
            : allStudents.filter(s => s.grade === selectedGrade);

        filtered.sort((a, b) => {
            if (a.grade !== b.grade) return (a.grade || '').localeCompare(b.grade || '');
            return (a.namePinyin || a.nameCn || '').localeCompare(b.namePinyin || b.nameCn || '');
        });

        exportToDOCX(filtered);
    });
}

function exportToDOCX(students) {
    // ✅ 1. Check libraries first
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

    students.forEach(student => {
        const subjects = Array.isArray(student.subjects) ? student.subjects : Object.values(student.subjects || {});
        
        const getEnrolDate = (subjName) => {
            const sub = subjects.find(s => s.name === subjName && s.status === 'current');
            if (sub && sub.enrolDate) {
                const d = new Date(sub.enrolDate);
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const yy = String(d.getFullYear()).slice(-2);
                return `${mm}/${yy}`;
            }
            return ' '; 
        };

        const chineseName = student.nameCn || '';
        const pinyinName = student.namePinyin || '';
        const dob = student.birthday || '';
        const studentNo = student.studentNumber || '';

        // Inner Grid Table
        const innerGridTable = new Table({
            width: { size: 100, type: WidthType.PERCENTAGE }, // ✅ Fill parent cell
            borders: {
                top: { style: BorderStyle.SINGLE, size: 4 }, bottom: { style: BorderStyle.SINGLE, size: 4 },
                left: { style: BorderStyle.SINGLE, size: 4 }, right: { style: BorderStyle.SINGLE, size: 4 },
                insideHorizontal: { style: BorderStyle.SINGLE, size: 4 }, insideVertical: { style: BorderStyle.SINGLE, size: 4 }
            },
            rows: [
                new TableRow({ children: [new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "上課:", bold: true, size: 18 })], alignment: AlignmentType.LEFT })], columnSpan: 4 })] }),
                new TableRow({ children: [
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "中", size: 16, bold: true })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "英", size: 16, bold: true })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "EFL", size: 16, bold: true })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "數", size: 16, bold: true })] })], width: { size: 25, type: WidthType.PERCENTAGE } })
                ]}),
                new TableRow({ children: [
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: getEnrolDate('Chinese (Trad)') || getEnrolDate('Chinese (Simp)'), size: 14 })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: getEnrolDate('English ERP'), size: 14 })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: getEnrolDate('English EFL'), size: 14 })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: getEnrolDate('Math'), size: 14 })] })], width: { size: 25, type: WidthType.PERCENTAGE } })
                ]}),
                new TableRow({ children: [
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "平", size: 16, bold: true })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "銅", size: 16, bold: true })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "銀", size: 16, bold: true })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "金", size: 16, bold: true })] })], width: { size: 25, type: WidthType.PERCENTAGE } })
                ]}),
                new TableRow({ children: [
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: " ", size: 16 })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: " ", size: 16 })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: " ", size: 16 })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: " ", size: 16 })] })], width: { size: 25, type: WidthType.PERCENTAGE } })
                ]})
            ]
        });

        // Main Label Table
        const labelTable = new Table({
            width: { size: 100, type: WidthType.PERCENTAGE }, // ✅ FIXED: 100% instead of 7000 DXA to prevent overflow warping
            borders: {
                top: { style: BorderStyle.SINGLE, size: 8 }, bottom: { style: BorderStyle.SINGLE, size: 8 },
                left: { style: BorderStyle.SINGLE, size: 8 }, right: { style: BorderStyle.SINGLE, size: 8 },
                insideHorizontal: { style: BorderStyle.SINGLE, size: 6 }, insideVertical: { style: BorderStyle.SINGLE, size: 6 }
            },
            rows: [
                new TableRow({
                    height: { value: 1750, rule: HeightRule.EXACT }, // ✅ FIXED: 1750 DXA (~3.1cm). 6 rows × 1750 = 10500 DXA (fits perfectly in A4 Landscape)
                    children: [
                        new TableCell({
                            width: { size: 55, type: WidthType.PERCENTAGE },
                            verticalAlign: VerticalAlign.CENTER, // ✅ FIXED: Use enum, not string "center"
                            children: [
                                new Paragraph({ children: [new TextRun({ text: "姓名: ", bold: true, size: 18 }), new TextRun({ text: chineseName, bold: true, size: 32 })] }),
                                new Paragraph({ children: [new TextRun({ text: "NAME: ", bold: true, size: 18 }), new TextRun({ text: pinyinName, size: 20 })] }),
                                new Paragraph({ children: [new TextRun({ text: "DOB: ", bold: true, size: 18 }), new TextRun({ text: dob, size: 20 })] }),
                                // ✅ FIXED: Split into two paragraphs to avoid "\n" corruption/weird spacing
                                new Paragraph({ children: [new TextRun({ text: "學生編號:", bold: true, size: 18 })] }),
                                new Paragraph({ children: [new TextRun({ text: studentNo, bold: true, size: 22 })] })
                            ]
                        }),
                        new TableCell({
                            width: { size: 45, type: WidthType.PERCENTAGE },
                            verticalAlign: VerticalAlign.CENTER,
                            children: [innerGridTable]
                        })
                    ]
                })
            ]
        });
        labelTables.push(labelTable);
    });

    // Arrange in grid (4x6 = 24 per page)
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
                height: { value: 1750, rule: HeightRule.EXACT } // ✅ Match the label height
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

        // ✅ FIXED: Proper page break instead of "\f"
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
                        orientation: PageOrientation.LANDSCAPE, // ✅ FORCE LANDSCAPE
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