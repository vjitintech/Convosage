import { jsPDF } from "jspdf";
export async function markdownToPdf(md: string): Promise<Blob> {
  const doc = new jsPDF({ unit: "pt", format: "a4" }); const W = 595, M = 46; let y = 56;
  const ascii = (t: string) => t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[—–]/g, "-").replace(/[•·]/g, "-").replace(/…/g, "...").replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  const write = (t: string, size: number, bold = false, indent = 0, color: [number, number, number] = [28, 36, 32]) => {
    doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(...color);
    for (const line of doc.splitTextToSize(ascii(t), W - 2 * M - indent)) { if (y > 800) { doc.addPage(); y = 50; } doc.text(line, M + indent, y); y += size * 1.35; }
  };
  for (const l of md.split("\n")) {
    const c = l.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/`/g, "");
    if (/^# /.test(l)) { write(c.slice(2), 18, true); y += 4; } else if (/^## /.test(l)) { y += 8; write(c.slice(3), 13, true, 0, [43, 79, 62]); }
    else if (/^\s*- /.test(l)) write("- " + c.replace(/^\s*- /, ""), 10, false, /^\s{2,}/.test(l) ? 18 : 8);
    else if (/^> /.test(l)) write(c.slice(2), 9.5, false, 0, [90, 98, 92]); else if (l.trim()) write(c, 10);
  }
  return doc.output("blob");
}
