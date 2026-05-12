'use strict';

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, '..', 'data', 'results');

function csvCell(v) {
  if (v == null) return '""';
  const s = String(v).replace(/[\r\n]+/g, ' ');
  return `"${s.replace(/"/g, '""')}"`;
}
function csvRow(values) { return values.map(csvCell).join(',') + '\n'; }

/**
 * Append-only CSV writer, one file per job at data/results/<jobId>.csv.
 * Header row is written once on creation; subsequent re-opens append rows.
 */
class JobCsvAppender {
  constructor(jobId, columns) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    this.path = path.join(RESULTS_DIR, `${jobId}.csv`);
    this.columns = columns;
    const isNew = !fs.existsSync(this.path) || fs.statSync(this.path).size === 0;
    this.stream = fs.createWriteStream(this.path, { flags: 'a' });
    if (isNew) this.stream.write(csvRow(columns));
    this.count = 0;
  }

  append(obj) {
    if (!this.stream) return;
    this.stream.write(csvRow(this.columns.map((c) => obj[c])));
    this.count++;
  }

  close() {
    if (this.stream) {
      try { this.stream.end(); } catch {}
      this.stream = null;
    }
  }
}

module.exports = { JobCsvAppender, RESULTS_DIR, csvRow, csvCell };
