/* =====================================================================
   Test fixtures
   =====================================================================
   Every check sets up the data it needs. Nothing here assumes a database
   left behind by a previous run — that's what made the suite fragile
   before, where a test passed only if it happened to run after another.
   ===================================================================== */

'use strict';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'test-secret-123';

/** Today, in the local calendar day — never UTC. */
function todayISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Writes the awkward content the escaping and apostrophe checks need:
 * a dish whose name is a script payload, and names containing an
 * apostrophe, a double quote and an ampersand.
 *
 * Goes straight to the database rather than through the API, because the
 * API deliberately won't let you create a dish at all — that's the point.
 * This simulates a compromised database or a future menu-editing screen.
 */
function plantAwkwardContent() {
  const db = require('../server/db');
  db.prepare('DELETE FROM menu_items WHERE id LIKE ?').run('xss%');
  db.prepare(`
    INSERT INTO menu_items (id, category, name, description, price, emoji, thumb, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    'xss1',
    "Chef's Picks",
    '<img src=x onerror="window.__XSS_NAME=1">Sneaky Dish',
    '<img src=y onerror="window.__XSS_DESC=1">A description that tries to run code',
    250, '🍲', '#e8d9bd', 99
  );
  db.prepare('UPDATE courts SET name = ? WHERE id = ?').run("Rey's Court", 'court-3');
  db.prepare('UPDATE courts SET name = ? WHERE id = ?').run('Court "4" & Co', 'court-4');
  return db;
}

async function post(path, body, headers) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Places a realistic day of service through the public API — real orders,
 * real bookings — then advances a few through the staff flow so the board
 * has something in every state to show.
 *
 * Picks time slots the server currently reports as free, so this works
 * whatever time of day the suite happens to run.
 */
async function seedDayOfService() {
  const date = todayISO();

  const menu = await fetch(BASE + '/api/menu').then(r => r.json());
  const dishes = Object.values(menu).flat().filter(d => !String(d.id).startsWith('xss'));

  const people = [
    ['Ana Reyes', '0917 555 0134', 'dine-in'],
    ["Marco O'Sullivan", '0918 555 0210', 'pickup'],
    ['Liza Bautista', '0920 555 0455', 'court'],
    ['Nico Tan', '0917 555 0988', 'dine-in'],
  ];

  const orderIds = [];
  for (let i = 0; i < people.length; i++) {
    const [name, phone, orderType] = people[i];
    const { body } = await post('/api/orders', {
      name, phone, orderType,
      items: [
        { id: dishes[i % dishes.length].id, qty: 1 + (i % 2) },
        { id: dishes[(i + 3) % dishes.length].id, qty: 1 },
      ],
    });
    if (body.id) orderIds.push(body.id);
  }

  // Ask the server which slots are actually free right now.
  const availability = await fetch(`${BASE}/api/availability?date=${date}`).then(r => r.json());
  const courts = await fetch(BASE + '/api/courts').then(r => r.json());
  const past = new Set(availability.past || []);
  const free = availability.slots.filter(t => !past.has(t));

  const guests = [
    ['Ana Reyes', '0917 555 0134', 'doubles'],
    ['Ben Cruz', '0915 555 7712', 'singles'],
    ['Cel Uy', '0916 555 3390', 'doubles'],
    ['Dara Lim', '0917 555 6621', 'doubles'],
    ['Elena Vega', '0919 555 2244', 'singles'],
  ];

  const bookingIds = [];
  for (let i = 0; i < guests.length && i < free.length * courts.length; i++) {
    const [name, phone, partySize] = guests[i];
    const court = courts[i % courts.length];
    const time = free[Math.floor(i / courts.length) % free.length];
    if (!time) break;
    const { body } = await post('/api/bookings', { courtId: court.id, date, time, name, phone, partySize });
    if (body.id) bookingIds.push(body.id);
  }

  // Log in as staff and move a few along, so the board shows mixed states.
  const login = await fetch(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USER || 'admin', password: ADMIN_PW }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  const patch = (path, status) => fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ status }),
  });

  if (orderIds[0]) await patch(`/api/admin/orders/${orderIds[0]}`, 'preparing');
  if (orderIds[1]) await patch(`/api/admin/orders/${orderIds[1]}`, 'ready');
  if (orderIds[3]) await patch(`/api/admin/orders/${orderIds[3]}`, 'collected');
  if (bookingIds[0]) await patch(`/api/admin/bookings/${bookingIds[0]}`, 'arrived');

  return { date, orderIds, bookingIds, cookie, bookingsPlaced: bookingIds.length };
}

module.exports = { BASE, ADMIN_PW, todayISO, plantAwkwardContent, seedDayOfService };
