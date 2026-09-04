export default {
  common: {
    loading: "Loading...",
    logout: "Logout",
    backToDashboard: "← Dashboard",
    accessDenied: "Access Denied",
    noPermission: "You do not have permission to view this page.",
    cancel: "Cancel",
    confirm: "Confirm",
    close: "Close",
    saving: "Saving...",
    yes: "Yes",
    no: "No"
  },
  cc: {
    // Stats
    statsTotal: "Total Records",
    statsScheduled: "Scheduled",
    statsCompleted: "Completed",
    statsMissed: "Missed",
    statsCancelled: "Cancelled",
    statsPU: "Picked Up",

    // Filters
    filterAll: "All",
    filterScheduled: "Scheduled",
    filterCompleted: "Completed",
    filterMissed: "Missed",
    filterCancelled: "Cancelled",
    searchPlaceholder: "Search student, subject...",
    from: "From",
    to: "To",
    typeAll: "All Types",
    subjectAll: "All Subjects",
    export: "Export",
    addNew: "+ Add Change Class",

    // Table columns
    colStudent: "Student",
    colSubject: "Subject",
    colType: "Type",
    colAbsence: "Absence Date",
    colReplacement: "Replacement",
    colStatus: "Status",
    colPU: "PU",
    colActions: "Actions",

    // Status
    statusScheduled: "Scheduled",
    statusCompleted: "Completed",
    statusMissed: "Missed",
    statusCancelled: "Cancelled",

    // Empty / misc
    emptyState: "No change class records found.",
    view: "View",
    edit: "Edit",
    markComplete: "Complete",
    cancel: "Cancel",
    delete: "Delete",
    selectedCount: "{{count}} selected",

    // Add/Edit modal
    addTitle: "Add Change Class",
    editTitle: "Edit Change Class",
    student: "Student *",
    searchStudent: "Search student by name, pinyin, number...",
    changeStudent: "Change",
    noStudentsFound: "No students found",
    subject: "Subject *",
    selectSubject: "Select subject",
    type: "Type *",
    absenceDate: "Absence Date *",
    originalTime: "Original Time",
    replacementDate: "Replacement Date *",
    replacementTime: "Replacement Time *",
    status: "Status",
    homeworkPU: "Homework Picked Up",
    note: "Note",
    notePlaceholder: "Optional note about this change class...",
    save: "Save",

    // Validation
    selectStudentFirst: "⚠️ Please select a student first.",
    selectSubjectFirst: "⚠️ Please select a subject.",
    selectAbsenceDate: "⚠️ Please select an absence date.",
    selectReplacement: "⚠️ Please select replacement date and time.",

    // Success / error
    addSuccess: "✅ Change class added successfully!",
    editSuccess: "✅ Change class updated successfully!",
    saveFailed: "❌ Failed to save. Please try again.",
    completedSuccess: "✅ Marked as completed.",
    cancelledSuccess: "✅ Cancelled successfully.",
    updateFailed: "❌ Update failed.",

    // Confirmations
    completeTitle: "Mark as Completed?",
    completeMsg: "Mark {{name}}'s replacement class as completed?",
    cancelTitle: "Cancel Change Class?",
    cancelMsg: "Cancel this change class for {{name}}?",
    deleteTitle: "Delete Record?",
    deleteMsg: "Are you sure you want to permanently delete this record? This cannot be undone.",
    deleteSuccess: "✅ Record deleted.",
    deleteFailed: "❌ Delete failed.",

    // Bulk
    bulkCompleteTitle: "Mark Selected as Completed?",
    bulkCompleteMsg: "Mark {{count}} selected record(s) as completed?",
    bulkCancelTitle: "Cancel Selected?",
    bulkCancelMsg: "Cancel {{count}} selected record(s)?",
    bulkSuccess: "✅ {{count}} record(s) updated.",
    bulkFailed: "❌ Bulk update failed.",

    // Detail modal
    detailTitle: "Change Class Details",
    detailStudent: "Student Information",
    detailChangeClass: "Change Class Details",
    name: "Name",
    pinyin: "Pinyin",
    grade: "Grade",
    studentNumber: "Student #",
    school: "School",
    homeCenter: "Home Center",
    historyTimeline: "History Timeline",
    noHistory: "No history recorded.",

    // Export
    nothingToExport: "No records to export.",
    exportSuccess: "✅ Exported successfully."
  }
};