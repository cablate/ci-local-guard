// Failed-test lists that never come as TAP: the Playwright summary block at
// the end of a log and Vitest/Jest FAIL lines. Pure functions over untrusted
// log text; no network, no filesystem, no state.
const MAX_TESTS = 20;
const NAME_LIMIT = 300;
// GitHub prefixes every job-log line with a timestamp; tolerate it so raw logs
// parse the same way as stripped text.
const LOG_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;
const SUMMARY = /^(\s*)(\d+) (failed|flaky|passed|skipped|did not run)\b/;
const ENTRY = /^\s+(\S+):(\d+):(\d+) › (.+)$/;
const FAIL_LINE = /^\s*FAIL\s+(\S.*)$/;

export function extractFailedTests(text) {
  const tests = [];
  const seen = new Set();
  const add = entry => {
    const key = `${entry.name}\0${entry.location ? `${entry.location.file}:${entry.location.line}` : ''}`;
    if (seen.has(key) || tests.length >= MAX_TESTS) return;
    seen.add(key);
    tests.push(entry);
  };
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const body = lines[i].replace(LOG_STAMP, '');
    const fail = FAIL_LINE.exec(body);
    if (fail) { add({ name: fail[1].trim(), location: null, source: 'vitest' }); continue; }
    // "N failed" opens a block of deeper-indented "file:line:column › title"
    // entries; a blank line, a shallower line or any other summary line ends it.
    const summary = SUMMARY.exec(body);
    if (!summary || summary[2] === '0' || summary[3] !== 'failed') continue;
    const indent = summary[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const entryLine = lines[j].replace(LOG_STAMP, '');
      if (!entryLine.trim() || SUMMARY.test(entryLine)) break;
      if (/^ */.exec(entryLine)[0].length <= indent) break;
      const entry = ENTRY.exec(entryLine);
      if (entry) add({ name: entry[4].trim(), location: { file: entry[1], line: Number(entry[2]), column: Number(entry[3]) }, source: 'playwright' });
    }
  }
  return tests;
}

export function formatFailedTest(entry) {
  if (!entry) return '';
  const title = String(entry.name ?? '');
  return (entry.location?.file ? `${entry.location.file}:${entry.location.line} › ${title}` : title).slice(0, NAME_LIMIT);
}
