// CSV + AI onboarding importer (#15). Migrating an existing portfolio is the
// usual go-live blocker: an operator arrives with spreadsheets of units and
// residents in whatever column order a previous system emitted. This module is
// a PURE, zero-dep pipeline: parse the CSV (RFC-4180-ish — quotes, escaped
// quotes, CRLF), map arbitrary source headers to canonical fields, then plan the
// import with per-row validation. The "AI migration" seam is exactly the column
// MAPPING — an LLM can propose (or correct) which source header feeds which
// canonical field; suggestMapping() is the deterministic fallback. Nothing is
// written here: planImport is a dry-run preview; the App applies the ok rows to
// master data through the same authenticated surface as everything else.

export type ImportTarget = 'units' | 'guests';

export interface FieldSpec { field: string; required: boolean; aliases: string[]; }

// Canonical fields per target, with the header aliases the heuristic recognises.
export const TARGET_FIELDS: Record<ImportTarget, FieldSpec[]> = {
  units: [
    { field: 'code', required: true, aliases: ['code', 'unit', 'unit code', 'ref', 'reference', 'id', 'number', 'no'] },
    { field: 'label', required: false, aliases: ['label', 'name', 'description', 'title', 'unit name'] },
  ],
  guests: [
    { field: 'code', required: true, aliases: ['code', 'ref', 'reference', 'id', 'cpf', 'document', 'doc'] },
    { field: 'fullName', required: true, aliases: ['fullname', 'full name', 'name', 'guest', 'resident', 'tenant', 'contact'] },
    { field: 'email', required: false, aliases: ['email', 'e-mail', 'mail', 'email address'] },
  ],
};

export class OnboardingError extends Error {}

/** Pure RFC-4180-ish CSV parse. Handles quoted fields, "" escaped quotes, and
 *  CRLF/LF line endings. Returns the header row separately from the data rows. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; sawAny = true; continue; }
    if (c === ',') { row.push(field); field = ''; sawAny = true; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); records.push(row); field = ''; row = []; sawAny = false; continue; }
    field += c; sawAny = true;
  }
  if (sawAny || field.length || row.length) { row.push(field); records.push(row); }

  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0]!.map((h) => h.trim());
  return { headers, rows: nonEmpty.slice(1) };
}

export type ColumnMapping = Record<string, number>; // canonical field → source column index

const norm = (s: string): string => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/** Deterministic header→field guess (the fallback under the AI mapping seam):
 *  exact alias match first, then substring, first header wins. */
export function suggestMapping(target: ImportTarget, headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const normed = headers.map(norm);
  for (const spec of TARGET_FIELDS[target]) {
    let idx = normed.findIndex((h) => spec.aliases.includes(h));
    if (idx < 0) idx = normed.findIndex((h) => spec.aliases.some((a) => h.includes(a)));
    if (idx >= 0) mapping[spec.field] = idx;
  }
  return mapping;
}

export interface ImportRowResult {
  index: number; // 0-based data-row index
  status: 'ok' | 'error';
  record?: Record<string, string>;
  errors: string[];
}

export interface ImportPlan {
  target: ImportTarget;
  mapping: ColumnMapping;
  rows: ImportRowResult[];
  okCount: number;
  errorCount: number;
}

/** Pure dry-run: apply the mapping to each row, validate required fields, and
 *  flag in-batch duplicate codes. Writes nothing. */
export function planImport(target: ImportTarget, headers: string[], rows: string[][], mapping: ColumnMapping): ImportPlan {
  const specs = TARGET_FIELDS[target];
  for (const spec of specs) {
    if (spec.required && mapping[spec.field] === undefined) {
      throw new OnboardingError(`required field '${spec.field}' is not mapped to any column`);
    }
  }
  const seenCodes = new Set<string>();
  const results: ImportRowResult[] = rows.map((cells, index) => {
    const record: Record<string, string> = {};
    const errors: string[] = [];
    for (const spec of specs) {
      const col = mapping[spec.field];
      const raw = col === undefined ? '' : (cells[col] ?? '').trim();
      if (raw) record[spec.field] = raw;
      else if (spec.required) errors.push(`missing ${spec.field}`);
    }
    if (!record['label'] && target === 'units' && record['code']) record['label'] = record['code'];
    const code = record['code'];
    if (code) {
      if (seenCodes.has(code)) errors.push(`duplicate code '${code}' in file`);
      else seenCodes.add(code);
    }
    return { index, status: errors.length ? 'error' : 'ok', record: errors.length ? undefined : record, errors };
  });
  const okCount = results.filter((r) => r.status === 'ok').length;
  return { target, mapping, rows: results, okCount, errorCount: results.length - okCount };
}
