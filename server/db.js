const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(dataDir, 'arquero.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  emoji TEXT,
  thumb TEXT,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS courts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  order_type TEXT NOT NULL,
  subtotal REAL NOT NULL,
  tax REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT DEFAULT 'received',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  confirmation_number TEXT UNIQUE NOT NULL,
  court_id TEXT NOT NULL,
  booking_date TEXT NOT NULL,
  booking_time TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  party_size TEXT NOT NULL,
  rate REAL NOT NULL DEFAULT 1000.0,
  status TEXT DEFAULT 'confirmed',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

/* ---------------------------------------------------------------------
 * Migration: the double-booking guard must ignore cancelled bookings.
 *
 * The first version put UNIQUE(court_id, booking_date, booking_time)
 * directly on the table. That stops two people holding the same slot —
 * which is the whole point — but it also means once a booking exists,
 * that slot can never be used again, even after staff cancel it. A
 * cancellation would free the slot in the customer's view and then fail
 * when someone tried to take it.
 *
 * A *partial* unique index fixes this: the rule applies only to rows
 * that are still confirmed. Cancelled rows stay in the table as history
 * but no longer reserve anything.
 * ------------------------------------------------------------------- */

const bookingsSql = db.prepare(
  `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bookings'`
).get();

const hasOldConstraint = bookingsSql && /UNIQUE\s*\(\s*court_id/i.test(bookingsSql.sql);

if (hasOldConstraint) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE bookings_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        confirmation_number TEXT UNIQUE NOT NULL,
        court_id TEXT NOT NULL,
        booking_date TEXT NOT NULL,
        booking_time TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        party_size TEXT NOT NULL,
        rate REAL NOT NULL DEFAULT 1000.0,
        status TEXT DEFAULT 'confirmed',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO bookings_migrated
        SELECT id, confirmation_number, court_id, booking_date, booking_time,
               customer_name, phone, party_size, rate, status, created_at
        FROM bookings;
      DROP TABLE bookings;
      ALTER TABLE bookings_migrated RENAME TO bookings;
      CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date);
    `);
  })();
  db.pragma('foreign_keys = ON');
  console.log('[db] migrated bookings: cancelled slots can now be re-booked');
}

// This index is what actually prevents double-booking, including when two
// requests arrive at the same instant.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_slot_confirmed
    ON bookings(court_id, booking_date, booking_time)
    WHERE status = 'confirmed';
`);

module.exports = db;
