/**
 * Small CSV parser (RFC 4180: quoted fields, "" escapes, newlines in quotes).
 * Works on a string or incrementally on a stream.
 */
class CsvParser {
  constructor(onRow) {
    this.onRow = onRow;
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.quotePending = false; // saw a quote inside quotes; next char decides
  }

  push(chunk) {
    const s = String(chunk);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (c === '"') { this.field += '"'; continue; }
          this.inQuotes = false; // closing quote; fall through to handle c
        } else if (c === '"') { this.quotePending = true; continue; }
        else { this.field += c; continue; }
      }
      if (c === '"' && this.field === '') { this.inQuotes = true; continue; }
      if (c === ',') { this.row.push(this.field); this.field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { this._endRow(); continue; }
      this.field += c;
    }
  }

  end() {
    if (this.quotePending) { this.quotePending = false; this.inQuotes = false; }
    if (this.field !== '' || this.row.length) this._endRow();
  }

  _endRow() {
    this.row.push(this.field);
    this.field = '';
    const r = this.row;
    this.row = [];
    if (r.length === 1 && r[0] === '') return;
    this.onRow(r);
  }
}

function parseCsv(text) {
  const rows = [];
  const p = new CsvParser(r => rows.push(r));
  p.push(text);
  p.end();
  return rows;
}

// Rows as objects keyed by the header row.
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  const header = rows.shift() || [];
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function toCsv(rows) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n') + '\n';
}

module.exports = { CsvParser, parseCsv, parseCsvObjects, toCsv };
