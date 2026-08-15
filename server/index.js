const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Don't advertise the server framework to attackers.
app.disable('x-powered-by');
app.set('trust proxy', 1); // so req.ip is the real client behind a host's proxy

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const TIME_SLOTS = ['6:00 AM','7:00 AM','8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM','7:00 PM','8:00 PM'];

const COURT_RATE = 1000.0;   // per hour, in pesos — VAT inclusive
const TAX_RATE = 0.12;       // Philippine VAT

/**
 * Prices are VAT-inclusive: the number on the menu is the number the
 * customer pays. So VAT isn't added on top, it's *extracted* from the
 * price for the receipt — gross × 12/112, not gross × 12%.
 * Getting this backwards overcharges every customer by 12%.
 */
function vatPortion(gross) {
  return round2(gross * TAX_RATE / (1 + TAX_RATE));
}

const MAX_DAYS_AHEAD = 60;      // how far in advance a court can be booked
const MAX_QTY_PER_LINE = 20;    // portions of a single dish
const MAX_LINES_PER_ORDER = 40; // distinct dishes in one order
const NAME_MAX = 80;
const PHONE_MAX = 25;
const PHONE_MIN_DIGITS = 7;

// The client sends a short key, never free text. Anything else is rejected.
const ORDER_TYPES = {
  'dine-in': 'Dine-in — Table for guests',
  'pickup':  'Pickup at Front Desk',
  'court':   'Deliver to Court',
};
const PARTY_SIZES = {
  'singles': '2 players (Singles)',
  'doubles': '4 players (Doubles)',
};

/* ------------------------------------------------------------------ *
 * Admin credentials
 * ------------------------------------------------------------------ */

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
let passwordWasGenerated = false;

if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  passwordWasGenerated = true;
}

// Signs the staff session cookie. Left unset, it's random per boot, which
// means restarting the server logs everyone out — safe, and fine for one
// machine. Set SESSION_SECRET in production so a restart mid-service
// doesn't sign staff out of their tablets.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'arq_staff';
const SESSION_HOURS = 12;

/** Constant-time string compare, so an attacker can't guess the password one character at a time. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still do a comparison so the timing doesn't leak the length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ---- session cookie ---- */

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function signSession(user) {
  const payload = b64url(JSON.stringify({
    u: user,
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  }));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function readSession(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;   // tampered or forged
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function getCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function isSecureRequest(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https';
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',                                   // JavaScript can't read it
    'SameSite=Strict',                            // not sent from other sites
    `Max-Age=${SESSION_HOURS * 3600}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');  // HTTPS only, once deployed
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/* ---- the gate ---- */

function checkBasicAuth(req) {
  const header = req.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  // Evaluate both so a wrong username and a wrong password cost the same time.
  const userOk = safeEqual(decoded.slice(0, sep), ADMIN_USER);
  const passOk = safeEqual(decoded.slice(sep + 1), ADMIN_PASSWORD);
  return userOk && passOk;
}

/** Accepts either a staff session cookie (the dashboard) or Basic auth (curl). */
function requireAdmin(req, res, next) {
  const session = readSession(getCookie(req, SESSION_COOKIE));
  if (session) { req.staff = session.u; return next(); }
  if (checkBasicAuth(req)) { req.staff = ADMIN_USER; return next(); }

  // Only prompt the browser for Basic credentials on the raw data endpoints.
  // The dashboard wants its own login screen, not the grey browser box.
  if (!req.path.startsWith('/api/admin')) {
    res.set('WWW-Authenticate', 'Basic realm="Arquero Admin", charset="UTF-8"');
  }
  return res.status(401).json({ error: 'Please log in.' });
}

/* ------------------------------------------------------------------ *
 * Security headers
 * ------------------------------------------------------------------ */

app.use((req, res, next) => {
  // All scripts come from our own files — no inline <script>, no CDNs.
  // This is the backstop that stops an injected <script> from ever running.
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // the stylesheet is inline in index.html
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '32kb' }));

// Turn malformed JSON into a clean message instead of a stack trace that
// reveals our directory layout and library versions.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed request.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large.' });
  }
  return next(err);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

/* ------------------------------------------------------------------ *
 * Rate limiting (simple in-memory sliding window)
 * ------------------------------------------------------------------ */

// Generous enough that a table of guests all ordering over the resort's
// shared wi-fi won't trip it, tight enough to stop scripted flooding.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 60;
const rateHits = new Map();

function rateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const hits = (rateHits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    res.set('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
  }
  hits.push(now);
  rateHits.set(key, hits);
  next();
}

// Much tighter limit on login attempts, so nobody can sit there guessing
// the staff password.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;
const loginHits = new Map();

function loginLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const hits = (loginHits.get(key) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  if (hits.length >= LOGIN_MAX) {
    return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes.' });
  }
  hits.push(now);
  loginHits.set(key, hits);
  req.clearLoginAttempts = () => loginHits.delete(key);
  next();
}

// Stop the map growing forever on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateHits) {
    const fresh = hits.filter(t => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) rateHits.delete(key);
    else rateHits.set(key, fresh);
  }
}, RATE_WINDOW_MS).unref();

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

function round2(n) { return Math.round(n * 100) / 100; }

/** Today's date in the server's own timezone, as YYYY-MM-DD. Never uses UTC. */
function todayLocalISO() {
  const d = new Date();
  return localISO(d);
}
function localISO(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD HH:MM:SS' in the server's own timezone, so the dashboard's
 *  idea of "today" matches the kitchen's. */
function localTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${localISO(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Returns null if valid, otherwise a human-readable reason.
 * Rejects nonsense strings, impossible dates, past dates, and dates
 * beyond the booking window.
 */
function validateBookingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 'Date must be in YYYY-MM-DD format.';
  }
  const [y, m, d] = value.split('-').map(Number);
  const parsed = new Date(y, m - 1, d);
  // Catches things like 2026-02-31, which JS would silently roll over to March.
  if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
    return 'That date does not exist.';
  }
  const today = todayLocalISO();
  if (value < today) return 'That date has already passed.';

  const limit = new Date();
  limit.setDate(limit.getDate() + MAX_DAYS_AHEAD);
  if (value > localISO(limit)) {
    return `Courts can only be booked up to ${MAX_DAYS_AHEAD} days ahead.`;
  }
  return null;
}

/** '6:00 AM' -> 6, '12:00 PM' -> 12, '1:00 PM' -> 13 */
function slotToHour(slot) {
  const match = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(slot);
  if (!match) return null;
  let hour = parseInt(match[1], 10) % 12;
  if (match[3] === 'PM') hour += 12;
  return hour;
}

/** True if the slot is on today's date and its start time is already behind us. */
function slotHasPassed(dateIso, time) {
  if (dateIso !== todayLocalISO()) return false;
  const hour = slotToHour(time);
  if (hour === null) return false;
  const now = new Date();
  return hour < now.getHours() || (hour === now.getHours() && now.getMinutes() > 0);
}

function validateName(value) {
  if (typeof value !== 'string') return 'Please enter your name.';
  const trimmed = value.trim();
  if (trimmed.length < 2) return 'Please enter your name (at least 2 characters).';
  if (trimmed.length > NAME_MAX) return `Name must be ${NAME_MAX} characters or fewer.`;
  return null;
}

function validatePhone(value) {
  if (typeof value !== 'string') return 'Please enter a phone number.';
  const trimmed = value.trim();
  if (trimmed.length > PHONE_MAX) return `Phone number must be ${PHONE_MAX} characters or fewer.`;
  if (!/^[0-9+()\-.\s]+$/.test(trimmed)) return 'Phone number contains invalid characters.';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < PHONE_MIN_DIGITS) return 'That phone number looks too short.';
  return null;
}

function genCode(prefix) {
  // crypto (not Math.random) so confirmation numbers can't be guessed or
  // enumerated by someone fishing for other people's reservations.
  const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${prefix}-${raw}`;
}

/* ------------------------------------------------------------------ *
 * Public read endpoints
 * ------------------------------------------------------------------ */

// Hosting platforms poll this to decide whether the app is alive. It touches
// the database on purpose: a server that's running but can't read its own
// data is not healthy, and we'd rather the platform restart it than keep
// sending customers to it.
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, time: localTimestamp() });
  } catch (err) {
    console.error('[health] database unreachable', err);
    res.status(503).json({ ok: false });
  }
});

app.get('/api/menu', (req, res) => {
  const rows = db.prepare('SELECT * FROM menu_items WHERE active = 1 ORDER BY sort_order').all();
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category].push({
      id: row.id, name: row.name, desc: row.description,
      price: row.price, emoji: row.emoji, thumb: row.thumb,
    });
  }
  res.json(grouped);
});

/**
 * Which gallery photos actually exist.
 *
 * The app could just try to load each one and cope with the misses, but
 * that fills every visitor's console with 404s and wastes a request per
 * missing photo. Asking the server first means Rey drops a file into
 * public/images/ and it appears — no code change, no failed requests.
 */
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|avif)$/i;

app.get('/api/gallery', (req, res) => {
  const dir = path.join(__dirname, '..', 'public', 'images');
  let files = [];
  try {
    files = require('fs').readdirSync(dir).filter(f => IMAGE_EXTENSIONS.test(f));
  } catch (err) {
    // No images folder yet — that's fine, the app falls back to its tiles.
  }
  res.json({ images: files });
});

app.get('/api/courts', (req, res) => {
  const rows = db.prepare('SELECT id, name FROM courts WHERE active = 1 ORDER BY sort_order').all();
  res.json(rows);
});

app.get('/api/config', (req, res) => {
  res.json({
    slots: TIME_SLOTS,
    rate: COURT_RATE,
    rateVat: vatPortion(COURT_RATE),
    taxRate: TAX_RATE,
    vatInclusive: true,
    maxDaysAhead: MAX_DAYS_AHEAD,
    maxQtyPerLine: MAX_QTY_PER_LINE,
    orderTypes: Object.entries(ORDER_TYPES).map(([key, label]) => ({ key, label })),
    partySizes: Object.entries(PARTY_SIZES).map(([key, label]) => ({ key, label })),
  });
});

app.get('/api/availability', (req, res) => {
  const { date } = req.query;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
  }
  const rows = db.prepare(
    `SELECT court_id, booking_time FROM bookings WHERE booking_date = ? AND status = 'confirmed'`
  ).all(date);

  const byCourt = {};
  for (const row of rows) {
    if (!byCourt[row.court_id]) byCourt[row.court_id] = [];
    byCourt[row.court_id].push(row.booking_time);
  }
  // Times that have already gone by today are unavailable for everyone.
  const past = TIME_SLOTS.filter(t => slotHasPassed(date, t));
  res.json({ date, slots: TIME_SLOTS, booked: byCourt, past });
});

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

app.post('/api/orders', rateLimit, (req, res) => {
  const { name, phone, orderType, items } = req.body || {};

  const nameErr = validateName(name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  const phoneErr = validatePhone(phone);
  if (phoneErr) return res.status(400).json({ error: phoneErr });

  const typeLabel = ORDER_TYPES[orderType];
  if (!typeLabel) return res.status(400).json({ error: 'Please choose a valid order type.' });

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Your order is empty.' });
  }
  if (items.length > MAX_LINES_PER_ORDER) {
    return res.status(400).json({ error: `An order can contain at most ${MAX_LINES_PER_ORDER} different dishes.` });
  }

  const menuMap = new Map(
    db.prepare('SELECT * FROM menu_items WHERE active = 1').all().map(m => [m.id, m])
  );

  let subtotal = 0;
  const lineItems = [];
  const seen = new Set();

  for (const it of items) {
    const menuItem = menuMap.get(it && it.id);
    if (!menuItem) return res.status(400).json({ error: 'That dish is no longer on the menu.' });
    if (seen.has(menuItem.id)) {
      return res.status(400).json({ error: 'Each dish should appear only once in an order.' });
    }
    seen.add(menuItem.id);

    const qty = parseInt(it.qty, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      return res.status(400).json({ error: `Quantity must be between 1 and ${MAX_QTY_PER_LINE} per dish.` });
    }

    // Price always comes from our database, never from the request body.
    subtotal += menuItem.price * qty;
    lineItems.push({ menu_item_id: menuItem.id, name: menuItem.name, price: menuItem.price, qty });
  }

  // The line prices already include VAT, so their sum is the total.
  const total = round2(subtotal);
  const tax = vatPortion(total);
  const netOfVat = round2(total - tax);
  const orderNumber = genCode('ARQ');

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, customer_name, phone, order_type, subtotal, tax, total, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const info = insertOrder.run(
      orderNumber, name.trim(), phone.trim(), typeLabel, netOfVat, tax, total, localTimestamp()
    );
    for (const li of lineItems) {
      insertItem.run(info.lastInsertRowid, li.menu_item_id, li.name, li.price, li.qty);
    }
    return info.lastInsertRowid;
  });

  const orderId = tx();
  res.status(201).json({
    id: orderId, orderNumber, name: name.trim(), orderType: typeLabel,
    items: lineItems, subtotal: netOfVat, tax, total, vatInclusive: true,
  });
});

app.get('/api/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 100').all();
  const itemStmt = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ?');
  res.json(orders.map(o => ({ ...o, items: itemStmt.all(o.id) })));
});

/* ------------------------------------------------------------------ *
 * Bookings
 * ------------------------------------------------------------------ */

app.post('/api/bookings', rateLimit, (req, res) => {
  const { courtId, date, time, name, phone, partySize } = req.body || {};

  const nameErr = validateName(name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  const phoneErr = validatePhone(phone);
  if (phoneErr) return res.status(400).json({ error: phoneErr });

  const partyLabel = PARTY_SIZES[partySize];
  if (!partyLabel) return res.status(400).json({ error: 'Please choose a valid party size.' });

  const court = db.prepare('SELECT * FROM courts WHERE id = ? AND active = 1').get(courtId);
  if (!court) return res.status(400).json({ error: 'That court is not available.' });

  const dateErr = validateBookingDate(date);
  if (dateErr) return res.status(400).json({ error: dateErr });

  if (!TIME_SLOTS.includes(time)) return res.status(400).json({ error: 'Please choose a valid time slot.' });
  if (slotHasPassed(date, time)) return res.status(400).json({ error: 'That time has already passed today.' });

  const confirmationNumber = genCode('PBK');
  try {
    const info = db.prepare(`
      INSERT INTO bookings (confirmation_number, court_id, booking_date, booking_time, customer_name, phone, party_size, rate, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(confirmationNumber, courtId, date, time, name.trim(), phone.trim(), partyLabel, COURT_RATE, localTimestamp());

    res.status(201).json({
      id: info.lastInsertRowid, confirmationNumber, courtId, courtName: court.name,
      date, time, name: name.trim(), partySize: partyLabel,
      rate: COURT_RATE, vat: vatPortion(COURT_RATE), vatInclusive: true,
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'That slot was just booked by someone else. Please pick another.' });
    }
    throw err;
  }
});

app.get('/api/bookings', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM bookings ORDER BY id DESC LIMIT 100').all());
});

/* ------------------------------------------------------------------ *
 * Staff dashboard
 * ------------------------------------------------------------------ */

// What an order or booking is allowed to become. Anything not on this list
// is rejected, so a stray request can't invent a status the app can't render.
const ORDER_STATUSES = ['received', 'preparing', 'ready', 'collected', 'cancelled'];
const BOOKING_STATUSES = ['confirmed', 'arrived', 'no_show', 'cancelled'];

app.post('/api/admin/login', loginLimit, (req, res) => {
  const { username, password } = req.body || {};
  const userOk = safeEqual(typeof username === 'string' ? username : '', ADMIN_USER);
  const passOk = safeEqual(typeof password === 'string' ? password : '', ADMIN_PASSWORD);

  if (!userOk || !passOk) {
    // Deliberately vague: don't reveal which half was wrong.
    return res.status(401).json({ error: 'Those details did not match. Please try again.' });
  }
  if (req.clearLoginAttempts) req.clearLoginAttempts();
  setSessionCookie(req, res, signSession(ADMIN_USER));
  res.json({ ok: true, user: ADMIN_USER });
});

app.post('/api/admin/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  const session = readSession(getCookie(req, SESSION_COOKIE));
  if (!session) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: session.u, expiresAt: session.exp });
});

/** Everything staff need for one day's service, in a single request. */
app.get('/api/admin/day', requireAdmin, (req, res) => {
  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : todayLocalISO();

  const orders = db.prepare(`
    SELECT * FROM orders
    WHERE substr(created_at, 1, 10) = ?
  `).all(date);

  // A kitchen works a queue: whatever came in first is cooked first, so
  // outstanding orders go oldest-first. Finished and cancelled ones drop to
  // the bottom, most recent first, where they're out of the way but still
  // findable if a customer comes back to ask.
  const DONE = new Set(['collected', 'cancelled']);
  orders.sort((a, b) => {
    const aDone = DONE.has(a.status);
    const bDone = DONE.has(b.status);
    if (aDone !== bDone) return aDone ? 1 : -1;
    return aDone ? b.id - a.id : a.id - b.id;
  });

  const itemStmt = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ? ORDER BY id');
  const ordersWithItems = orders.map(o => ({ ...o, items: itemStmt.all(o.id) }));

  const bookings = db.prepare(`
    SELECT b.*, c.name AS court_name
    FROM bookings b
    LEFT JOIN courts c ON c.id = b.court_id
    WHERE b.booking_date = ?
  `).all(date);

  // Sort by actual clock time, not the string, so 9:00 AM comes before 12:00 PM.
  bookings.sort((a, b) => {
    const ha = slotToHour(a.booking_time), hb = slotToHour(b.booking_time);
    if (ha !== hb) return (ha ?? 0) - (hb ?? 0);
    return String(a.court_id).localeCompare(String(b.court_id));
  });

  const liveOrders = ordersWithItems.filter(o => o.status !== 'cancelled');
  const liveBookings = bookings.filter(b => b.status !== 'cancelled');

  res.json({
    date,
    today: todayLocalISO(),
    now: localTimestamp(),
    orders: ordersWithItems,
    bookings,
    orderStatuses: ORDER_STATUSES,
    bookingStatuses: BOOKING_STATUSES,
    stats: {
      orderCount: liveOrders.length,
      openOrders: liveOrders.filter(o => o.status !== 'collected').length,
      revenue: round2(liveOrders.reduce((s, o) => s + o.total, 0)),
      bookingCount: liveBookings.length,
      courtRevenue: round2(liveBookings.reduce((s, b) => s + b.rate, 0)),
      awaitingArrival: liveBookings.filter(b => b.status === 'confirmed').length,
    },
  });
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown order.' });
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });

  const info = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Unknown order.' });

  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
});

app.patch('/api/admin/bookings/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown booking.' });
  if (!BOOKING_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });

  const existing = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Unknown booking.' });

  try {
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, id);
  } catch (err) {
    // Re-confirming a booking whose slot someone else has since taken.
    if (String(err.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'That slot has already been given to someone else.' });
    }
    throw err;
  }

  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
});

/* ------------------------------------------------------------------ *
 * Menu and court management
 * ------------------------------------------------------------------ *
 * This is the most dangerous surface in the app. Everything written here
 * is rendered in every customer's browser, so it gets the strictest
 * validation of anything — and the front end still escapes it on the way
 * out, because defence that depends on one layer isn't defence.
 *
 * Nothing is ever hard-deleted. Removing a dish deactivates it, which
 * keeps past orders readable and makes every destructive action
 * reversible by someone having a bad day mid-service.
 */

const DISH_NAME_MAX = 60;
const DISH_DESC_MAX = 200;
const CATEGORY_MAX = 40;
const EMOJI_MAX = 8;
const PRICE_MAX = 100000;
const COURT_NAME_MAX = 40;

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
// Control characters have no place in a dish name and are a classic way to
// smuggle something past a careless reader. Newlines included.
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029]/;

/**
 * Angle brackets are rejected outright in menu text.
 *
 * The front end escapes everything, and that's tested — but a dish name
 * doesn't stay in the browser. It goes onto printed kitchen tickets, and
 * sooner or later into an SMS confirmation, a CSV export or a PDF receipt,
 * none of which this escaping reaches. No real dish is called
 * "Burger <b>Deluxe</b>", so refusing the characters costs nothing and
 * removes the whole class of problem wherever the text ends up next.
 */
const MARKUP_CHARS = /[<>]/;

function cleanText(value, { field, min, max, required = true }) {
  if (value === undefined || value === null || value === '') {
    if (required) return { error: `${field} is required.` };
    return { value: '' };
  }
  if (typeof value !== 'string') return { error: `${field} must be text.` };

  const trimmed = value.trim();
  if (CONTROL_CHARS.test(trimmed)) return { error: `${field} contains characters that aren't allowed.` };
  if (MARKUP_CHARS.test(trimmed)) return { error: `${field} can't contain < or > characters.` };
  if (required && trimmed.length < min) return { error: `${field} must be at least ${min} characters.` };
  if (trimmed.length > max) return { error: `${field} must be ${max} characters or fewer.` };
  return { value: trimmed };
}

function cleanPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: 'Price must be a number.' };
  if (n < 0) return { error: "Price can't be negative." };
  if (n > PRICE_MAX) return { error: `Price must be ${PRICE_MAX} or less.` };
  return { value: round2(n) };
}

/** Builds a stable, readable id from a name — 'Wood-Fired Trout' -> 'wood-fired-trout'. */
function makeId(name, table) {
  const base = name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';

  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
  if (!exists.get(base)) return base;
  for (let n = 2; n < 500; n++) {
    if (!exists.get(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

function audit(req, action, entity, entityId, detail) {
  try {
    db.prepare(`INSERT INTO audit_log (staff, action, entity, entity_id, detail, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.staff || 'unknown', action, entity, String(entityId), detail || '', localTimestamp());
  } catch (err) {
    console.error('[audit] could not record', action, entity, err);
  }
}

/** Validates a dish. `partial` allows an edit that only touches some fields. */
function validateDish(body, { partial = false } = {}) {
  const out = {};
  const has = key => Object.prototype.hasOwnProperty.call(body, key);

  if (!partial || has('name')) {
    const r = cleanText(body.name, { field: 'Name', min: 2, max: DISH_NAME_MAX });
    if (r.error) return { error: r.error };
    out.name = r.value;
  }
  if (!partial || has('category')) {
    const r = cleanText(body.category, { field: 'Category', min: 2, max: CATEGORY_MAX });
    if (r.error) return { error: r.error };
    out.category = r.value;
  }
  if (!partial || has('description')) {
    const r = cleanText(body.description, { field: 'Description', min: 0, max: DISH_DESC_MAX, required: false });
    if (r.error) return { error: r.error };
    out.description = r.value;
  }
  if (!partial || has('price')) {
    const r = cleanPrice(body.price);
    if (r.error) return { error: r.error };
    out.price = r.value;
  }
  if (!partial || has('emoji')) {
    const r = cleanText(body.emoji, { field: 'Emoji', min: 0, max: EMOJI_MAX, required: false });
    if (r.error) return { error: r.error };
    out.emoji = r.value;
  }
  if (!partial || has('thumb')) {
    const thumb = body.thumb === undefined || body.thumb === '' ? '#f0e6d2' : body.thumb;
    if (typeof thumb !== 'string' || !HEX_COLOUR.test(thumb)) {
      return { error: 'Tile colour must be a hex value like #f0e6d2.' };
    }
    out.thumb = thumb.toLowerCase();
  }
  if (has('active')) out.active = body.active ? 1 : 0;

  return { value: out };
}

app.get('/api/admin/menu', requireAdmin, (req, res) => {
  res.json({
    items: db.prepare('SELECT * FROM menu_items ORDER BY sort_order, name').all(),
    courts: db.prepare('SELECT * FROM courts ORDER BY sort_order, name').all(),
    limits: {
      nameMax: DISH_NAME_MAX, descriptionMax: DISH_DESC_MAX,
      categoryMax: CATEGORY_MAX, priceMax: PRICE_MAX, courtNameMax: COURT_NAME_MAX,
    },
    recentChanges: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 20').all(),
  });
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
  const { error, value } = validateDish(req.body || {});
  if (error) return res.status(400).json({ error });

  const id = makeId(value.name, 'menu_items');
  const last = db.prepare('SELECT MAX(sort_order) m FROM menu_items').get().m || 0;

  db.prepare(`
    INSERT INTO menu_items (id, category, name, description, price, emoji, thumb, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, value.category, value.name, value.description, value.price, value.emoji, value.thumb, last + 1);

  audit(req, 'created', 'dish', id, `${value.name} at ${value.price}`);
  res.status(201).json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
});

app.patch('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'That dish is not on the menu.' });

  const { error, value } = validateDish(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });

  const fields = Object.keys(value);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });

  db.prepare(`UPDATE menu_items SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...fields.map(f => value[f]), existing.id);

  const changes = fields
    .filter(f => String(existing[f]) !== String(value[f]))
    .map(f => `${f}: ${existing[f]} → ${value[f]}`)
    .join(', ');
  if (changes) audit(req, 'edited', 'dish', existing.id, changes);

  res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(existing.id));
});

app.delete('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'That dish is not on the menu.' });

  // Deactivate, never delete — past orders still reference this dish, and
  // "I removed the wrong one" should be a one-click recovery.
  db.prepare('UPDATE menu_items SET active = 0 WHERE id = ?').run(existing.id);
  audit(req, 'removed', 'dish', existing.id, existing.name);
  res.json({ ok: true, id: existing.id });
});

app.post('/api/admin/menu/reorder', requireAdmin, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
    return res.status(400).json({ error: 'Send the dish ids in their new order.' });
  }
  const update = db.prepare('UPDATE menu_items SET sort_order = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => update.run(i + 1, String(id))))();
  audit(req, 'reordered', 'menu', 'all', `${ids.length} dishes`);
  res.json({ ok: true });
});

/* ---- courts ---- */

app.post('/api/admin/courts', requireAdmin, (req, res) => {
  const r = cleanText((req.body || {}).name, { field: 'Court name', min: 2, max: COURT_NAME_MAX });
  if (r.error) return res.status(400).json({ error: r.error });

  const id = makeId(r.value, 'courts');
  const last = db.prepare('SELECT MAX(sort_order) m FROM courts').get().m || 0;
  db.prepare('INSERT INTO courts (id, name, sort_order, active) VALUES (?, ?, ?, 1)')
    .run(id, r.value, last + 1);

  audit(req, 'created', 'court', id, r.value);
  res.status(201).json(db.prepare('SELECT * FROM courts WHERE id = ?').get(id));
});

app.patch('/api/admin/courts/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM courts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such court.' });

  const body = req.body || {};
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const r = cleanText(body.name, { field: 'Court name', min: 2, max: COURT_NAME_MAX });
    if (r.error) return res.status(400).json({ error: r.error });
    updates.name = r.value;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'active')) updates.active = body.active ? 1 : 0;

  const fields = Object.keys(updates);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });

  db.prepare(`UPDATE courts SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...fields.map(f => updates[f]), existing.id);

  audit(req, 'edited', 'court', existing.id,
    fields.map(f => `${f}: ${existing[f]} → ${updates[f]}`).join(', '));
  res.json(db.prepare('SELECT * FROM courts WHERE id = ?').get(existing.id));
});

app.delete('/api/admin/courts/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM courts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such court.' });

  // Taking a court out of service shouldn't silently strand people who have
  // already booked it. Say so, and let staff decide.
  const upcoming = db.prepare(`
    SELECT COUNT(*) c FROM bookings
    WHERE court_id = ? AND status = 'confirmed' AND booking_date >= ?
  `).get(existing.id, todayLocalISO()).c;

  db.prepare('UPDATE courts SET active = 0 WHERE id = ?').run(existing.id);
  audit(req, 'removed', 'court', existing.id, `${existing.name}${upcoming ? ` (${upcoming} upcoming bookings)` : ''}`);

  res.json({
    ok: true,
    id: existing.id,
    upcomingBookings: upcoming,
    warning: upcoming
      ? `${upcoming} confirmed booking${upcoming === 1 ? '' : 's'} on this court still ${upcoming === 1 ? 'stands' : 'stand'}. Ring ${upcoming === 1 ? 'that customer' : 'those customers'}, or restore the court.`
      : null,
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

/* ------------------------------------------------------------------ *
 * Fallbacks
 * ------------------------------------------------------------------ */

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// A mistyped URL should look like part of the resort, not like the site is broken.
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

// Anything unhandled: log the detail for us, return nothing useful to a stranger.
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

const server = app.listen(PORT, () => {
  console.log(`\nArquero's Resort server running at http://localhost:${PORT}`);
  console.log(`Staff dashboard at              http://localhost:${PORT}/admin`);
  if (passwordWasGenerated) {
    console.log('\n  ─────────────────────────────────────────────────────────');
    console.log('  Staff login:');
    console.log(`    username: ${ADMIN_USER}`);
    console.log(`    password: ${ADMIN_PASSWORD}`);
    console.log('  This password is new every restart. To set your own, run:');
    console.log('    ADMIN_PASSWORD=your-secret npm start');
    console.log('  ─────────────────────────────────────────────────────────\n');
  } else {
    console.log(`  Staff login username: ${ADMIN_USER}\n`);
  }
});

/* ------------------------------------------------------------------ *
 * Shutting down cleanly
 * ------------------------------------------------------------------ *
 * Hosting platforms restart apps routinely — a deploy, a config change,
 * a machine move. Each one sends SIGTERM. If we're mid-write to SQLite
 * when the process dies, the write-ahead log can be left needing
 * recovery. Finishing in-flight requests and closing the database first
 * turns a restart into a non-event.
 */

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] finishing open requests…`);

  server.close(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');  // fold the WAL back into the database file
      db.close();
      console.log('[shutdown] database closed cleanly');
    } catch (err) {
      console.error('[shutdown] could not close the database', err);
    }
    process.exit(0);
  });

  // Don't hang forever on a stuck connection.
  setTimeout(() => {
    console.error('[shutdown] took too long — exiting anyway');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
