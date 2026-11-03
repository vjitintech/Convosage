// Best-effort redaction before text leaves for external AI providers. Never claimed to be perfect.
const RULES: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ID]"],
  [/\b(?:sk|pk|rk|api|key|token|rzp)_(?:live|test)?_?[A-Za-z0-9]{12,}\b/g, "[SECRET]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[SECRET]"],
  [/\b(?:password|passwd|pwd|passcode)\s*[:=]\s*\S+/gi, "[SECRET]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[NUMBER]"],
  [/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3}\)?[\s-]?)\d{3}[\s-]?\d{4}\b/g, "[PHONE]"],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "[ID]"],
];
export function redact(s: string): string { return RULES.reduce((a, [re, r]) => a.replace(re, r), String(s ?? "")); }
