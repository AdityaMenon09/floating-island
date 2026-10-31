// Calendar files for Floating Island: parsing iCalendar text into upcoming events, and importing a
// Google Calendar export (a .zip of .ics files, or a single .ics) into the app's data folder.
// A live "secret address" link and imported files can be used together; main.js merges them.
//
// Command line (from the island folder):
//   node src/calendar-files.js import <export.zip | file.ics>   copy into %APPDATA%\Floating Island\calendar
//   node src/calendar-files.js check                            count the coming week's events (no titles)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ICAL = require('ical.js');

const META = 'import.json';

// Expands recurring events (with their exceptions and EXDATEs) into concrete occurrences in [from, to).
function parseCalendar(text, from, to) {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(tz); } catch { /* already known */ }
  }
  const all = root.getAllSubcomponents('vevent').map((c) => new ICAL.Event(c));
  const masters = new Map();
  for (const e of all) if (!e.isRecurrenceException()) masters.set(e.uid, e);
  for (const e of all) if (e.isRecurrenceException() && masters.has(e.uid)) masters.get(e.uid).relateException(e);

  const out = [];
  const add = (item, start, end) => {
    const status = String(item.component.getFirstPropertyValue('status') || '').toUpperCase();
    if (status === 'CANCELLED') return;
    const s = start.toJSDate();
    const e = (end || start).toJSDate();
    if (e <= from || s >= to) return;
    out.push({
      id: `${item.uid}|${s.getTime()}`,
      title: item.summary || '(No title)',
      start: s.getTime(),
      end: e.getTime(),
      allDay: start.isDate,
      location: item.location || ''
    });
  };

  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      add(event, event.startDate, event.endDate);
      continue;
    }
    const it = event.iterator();
    // Rules can start years back (birthdays!); walking them is cheap, but stop once past the window.
    for (let next = it.next(), n = 0; next && n < 50000; next = it.next(), n++) {
      if (next.toJSDate() >= to) break;
      const occ = event.getOccurrenceDetails(next);
      add(occ.item, occ.startDate, occ.endDate);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

// Copies the export's .ics files into `destDir`. A zip replaces the previous import; a single .ics
// is added (or replaces the file of the same name).
function importExport(source, destDir) {
  const ext = path.extname(source).toLowerCase();
  if (ext !== '.zip' && ext !== '.ics') throw new Error('Choose a Google Calendar export (.zip) or an .ics file.');
  fs.mkdirSync(destDir, { recursive: true });
  let files;
  let tmp = null;
  try {
    if (ext === '.zip') {
      // Unpack into a fresh temporary folder with Windows' own tar (bsdtar), which refuses
      // absolute and ../ paths, then take only the .ics files out of it.
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-island-cal-'));
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      execFileSync(tar, ['-xf', source, '-C', tmp], { windowsHide: true, stdio: 'ignore' });
      files = walk(tmp).filter((f) => f.toLowerCase().endsWith('.ics'));
      if (!files.length) throw new Error('That zip has no .ics calendar files in it.');
      for (const old of fs.readdirSync(destDir)) {
        if (old.toLowerCase().endsWith('.ics')) fs.rmSync(path.join(destDir, old));
      }
    } else {
      files = [source];
    }
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error(`${path.basename(f)} isn't an iCalendar file.`);
      fs.writeFileSync(path.join(destDir, path.basename(f)), text);
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  const names = files.map((f) => path.basename(f));
  fs.writeFileSync(path.join(destDir, META), JSON.stringify({ importedAt: Date.now(), from: path.basename(source), files: names }, null, 2));
  return { files: names };
}

function listImported(destDir) {
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(destDir, META), 'utf8')); } catch { /* none yet */ }
  let files = [];
  try { files = fs.readdirSync(destDir).filter((f) => f.toLowerCase().endsWith('.ics')).map((f) => path.join(destDir, f)); } catch { /* none yet */ }
  return { files, importedAt: meta.importedAt || null };
}

module.exports = { parseCalendar, importExport, listImported };

if (require.main === module) {
  const dir = path.join(process.env.APPDATA, 'Floating Island', 'calendar');
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'import' && arg) {
    const { files } = importExport(path.resolve(arg), dir);
    console.log(`imported ${files.length} calendar file(s) into ${dir}`);
  } else if (cmd !== 'check') {
    console.log('usage: node src/calendar-files.js import <export.zip|file.ics> | check');
    process.exit(1);
  }
  const now = Date.now();
  const { files } = listImported(dir);
  for (const f of files) {
    const t0 = Date.now();
    const text = fs.readFileSync(f, 'utf8');
    const all = (text.match(/BEGIN:VEVENT/g) || []).length;
    const events = parseCalendar(text, new Date(now - 12 * 3600e3), new Date(now + 8 * 86400e3));
    const timed = events.filter((e) => !e.allDay).length;
    console.log(`${path.basename(f)}: ${all} events in the file; next 8 days: ${events.length} (${timed} timed, ${events.length - timed} all-day); parsed in ${Date.now() - t0} ms`);
  }
}
