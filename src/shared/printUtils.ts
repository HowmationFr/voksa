/**
 * Chrome-style page-range parsing for the print dialog (pure, testable).
 * Input like '1-5, 8, 11-13' → [{from:1,to:5},{from:8,to:8},{from:11,to:13}]
 * (1-based, inclusive). Invalid chunks are dropped; an empty/garbage input
 * yields [] which callers treat as "all pages".
 */

export type PageRange = { from: number; to: number };

export function parsePageRanges(input: string): PageRange[] {
  const out: PageRange[] = [];
  for (const chunk of input.split(',')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(trimmed);
    if (!m) continue;
    const from = parseInt(m[1], 10);
    const to = m[2] !== undefined ? parseInt(m[2], 10) : from;
    if (from < 1 || to < from) continue;
    out.push({ from, to });
  }
  return out;
}

/** Serialize back to the string form printToPDF expects ('1-5,8'). */
export function pageRangesToString(ranges: PageRange[]): string {
  return ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(',');
}
