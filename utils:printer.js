export function printElement(elementId) {
  const printContent = document.getElementById(elementId).innerHTML;
  const originalContent = document.body.innerHTML;
  
  document.body.innerHTML = `
    <div style="padding: 20px; font-family: sans-serif;">
      <h1 style="color: #87CEEB;">Kumon Center Report</h1>
      <p>Generated: ${new Date().toLocaleDateString()}</p>
      ${printContent}
    </div>
  `;
  
  window.print();
  document.body.innerHTML = originalContent;
  window.location.reload(); // Rebind events
}