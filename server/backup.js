/* =====================================================================
   Database backup
   =====================================================================
   Run with:  npm run backup
              npm run backup -- /path/to/somewhere/else

   This uses SQLite's own online backup API rather than copying the file.
   That matters: the database runs in WAL mode, so at any moment the real
   state is split between arquero.db and arquero.db-wal. A plain `cp` of
   just the .db file during service can produce a backup that's missing
   the most recent orders — or, worse, one that looks fine and isn't.

   The backup API takes a consistent snapshot while the server keeps
   serving, so this is safe to run mid-shift or from a cron job.
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const KEEP = 14;  // roughly two weeks of daily backups

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function human(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function main() {
  const dir = process.argv[2] || process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const target = path.join(dir, `arquero-${stamp()}.db`);
  await db.backup(target);

  const size = fs.statSync(target).size;
  const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const bookings = db.prepare('SELECT COUNT(*) c FROM bookings').get().c;

  console.log(`Backed up to ${target}`);
  console.log(`  ${human(size)} · ${orders} orders · ${bookings} bookings`);

  // Prune old backups so this can run daily forever without filling the disk.
  const old = fs.readdirSync(dir)
    .filter(f => /^arquero-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .slice(0, -KEEP);

  for (const f of old) {
    fs.unlinkSync(path.join(dir, f));
  }
  if (old.length) console.log(`  removed ${old.length} backup(s) older than the last ${KEEP}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Backup failed:', err.message);
    process.exit(1);
  });
