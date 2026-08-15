/* =====================================================================
   Arquero's Mountain Resort — staff service board

   Same two rules as the customer app: every value from the database goes
   through the escaping template in safe-html.js, and no handler is ever
   built from a string of JavaScript. This screen displays customer names
   and phone numbers, so a name containing markup must stay text.
   ===================================================================== */

'use strict';

const $ = id => document.getElementById(id);
/* money() comes from money.js, loaded before this file. */

const REFRESH_MS = 20000;

let currentDate = null;   // YYYY-MM-DD
let serverToday = null;
let lastLoaded = null;
let refreshTimer = null;
let inFlight = false;

/* ---------------- dates (local, never UTC) ---------------- */

function localISO(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function shiftDate(iso, days) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return localISO(d);
}

function longDate(iso) {
  return parseISO(iso).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function relativeDay(iso) {
  if (!serverToday) return '';
  if (iso === serverToday) return 'Today';
  if (iso === shiftDate(serverToday, 1)) return 'Tomorrow';
  if (iso === shiftDate(serverToday, -1)) return 'Yesterday';
  const diff = Math.round((parseISO(iso) - parseISO(serverToday)) / 86400000);
  return diff > 0 ? `In ${diff} days` : `${Math.abs(diff)} days ago`;
}

/** '2026-08-14 14:32:07' -> '2:32 PM' */
function clockTime(stamp) {
  if (typeof stamp !== 'string') return '';
  const m = /(\d{2}):(\d{2})/.exec(stamp.slice(10));
  if (!m) return '';
  let h = Number(m[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${suffix}`;
}

function labelFor(status) {
  return { no_show: 'No-show', received: 'Received', preparing: 'Preparing',
           ready: 'Ready', collected: 'Collected', cancelled: 'Cancelled',
           confirmed: 'Booked', arrived: 'Arrived' }[status] || status;
}

/* ---------------- API ---------------- */

async function api(path, options) {
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
  }, options));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- Modals ---------------- */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openModals = [];
let focusBeforeModal = null;

function openSheet(id) {
  const overlay = $(id);
  if (!overlay || overlay.classList.contains('show')) return;
  if (!openModals.length) focusBeforeModal = document.activeElement;
  overlay.classList.add('show');
  openModals.push(id);
  const modal = overlay.querySelector('.modal');
  const first = modal.querySelector(FOCUSABLE);
  (first || modal).focus({ preventScroll: true });
}

function closeSheet(id) {
  const overlay = $(id);
  if (!overlay) return;
  overlay.classList.remove('show');
  const at = openModals.indexOf(id);
  if (at > -1) openModals.splice(at, 1);
  if (!openModals.length && focusBeforeModal && document.contains(focusBeforeModal)) {
    focusBeforeModal.focus({ preventScroll: true });
    focusBeforeModal = null;
  }
}

document.addEventListener('keydown', e => {
  if (!openModals.length) return;
  const top = openModals[openModals.length - 1];

  if (e.key === 'Escape') { e.preventDefault(); closeSheet(top); return; }

  // Keep Tab inside the dialog.
  if (e.key === 'Tab') {
    const modal = $(top).querySelector('.modal');
    const items = [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* ---------------- Login ---------------- */

function showLogin() {
  stopRefresh();
  $('loginView').style.display = 'flex';
  $('boardView').classList.remove('show');
  const pw = $('password');
  if (pw) { pw.value = ''; pw.focus(); }
}

function showBoard(user) {
  $('loginView').style.display = 'none';
  $('boardView').classList.add('show');
  $('staffName').textContent = user ? `Signed in as ${user}` : '';
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = $('loginBtn');
  const errBox = $('loginError');
  errBox.classList.remove('show');
  btn.disabled = true;
  btn.textContent = 'Checking…';

  try {
    const result = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('username').value.trim(),
        password: $('password').value,
      }),
    });
    showBoard(result.user);
    currentDate = null;
    await load();
    startRefresh();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
    $('password').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log in';
  }
}

async function handleLogout() {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) { /* log out regardless */ }
  showLogin();
}

/* ---------------- Rendering ---------------- */

function renderStats(s) {
  $('stats').innerHTML = html`
    <div class="stat accent"><div class="k">Open orders</div><div class="v">${String(s.openOrders)}</div></div>
    <div class="stat"><div class="k">Orders</div><div class="v">${String(s.orderCount)}</div></div>
    <div class="stat"><div class="k">Food takings</div><div class="v">${money(s.revenue)}</div></div>
    <div class="stat accent"><div class="k">Awaiting arrival</div><div class="v">${String(s.awaitingArrival)}</div></div>
    <div class="stat"><div class="k">Court bookings</div><div class="v">${String(s.bookingCount)}</div></div>
    <div class="stat"><div class="k">Court takings</div><div class="v">${money(s.courtRevenue)}</div></div>
  `;
}

function emptyState(message) {
  return html`<div class="empty">
    <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3 8-8"/><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>
    <p>${message}</p>
  </div>`;
}

/** Buttons shown for an order, based on where it is in the flow. */
function orderActions(order) {
  const next = { received: 'preparing', preparing: 'ready', ready: 'collected' }[order.status];
  const nextLabel = { preparing: 'Start preparing', ready: 'Mark ready', collected: 'Mark collected' }[next];
  const parts = [];

  if (next) {
    parts.push(html`<button class="btn btn-primary btn-sm" type="button"
      data-order="${String(order.id)}" data-status="${next}">${nextLabel}</button>`);
  }
  if (order.status === 'cancelled' || order.status === 'collected') {
    parts.push(html`<button class="btn btn-quiet btn-sm" type="button"
      data-order="${String(order.id)}" data-status="received">Reopen</button>`);
  }
  if (order.status !== 'cancelled' && order.status !== 'collected') {
    parts.push(html`<button class="btn btn-danger btn-sm" type="button"
      data-order="${String(order.id)}" data-status="cancelled">Cancel</button>`);
  }
  if (order.status !== 'cancelled') {
    parts.push(html`<button class="btn btn-quiet btn-sm" type="button"
      data-print="${String(order.id)}">Print ticket</button>`);
  }
  return parts.join('');
}

/* ---------------- Kitchen ticket ---------------- */

let lastDay = null;   // the most recent /api/admin/day response

/**
 * Renders one order as a paper ticket and opens the print dialog.
 * The ticket is built from data we already have, so this works even if
 * the network drops between the board loading and someone hitting print.
 */
function printTicket(orderId) {
  const order = lastDay && lastDay.orders.find(o => String(o.id) === String(orderId));
  if (!order) { setBanner('That order is no longer on the board — refresh and try again.'); return; }

  const rows = order.items.map(it => html`
    <tr>
      <td class="q">${String(it.qty)}&times;</td>
      <td class="n">${it.name}</td>
      <td class="p">${money(it.price * it.qty)}</td>
    </tr>
  `).join('');

  $('printArea').innerHTML = html`
    <div class="ticket">
      <div class="brand">Arquero's<small>Mountain Resort &middot; Kitchen</small></div>
      <div class="ref">${order.order_number}</div>
      <div class="when">${longDate(order.created_at.slice(0, 10))} &middot; ${clockTime(order.created_at)}</div>
      <div class="type">${order.order_type}</div>
      <div class="who">${order.customer_name}<span>${order.phone}</span></div>
      <table><tbody>${raw(rows)}</tbody></table>
      <div class="totals">
        <div><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
        <div><span>VAT</span><span>${money(order.tax)}</span></div>
        <div class="grand"><span>Total</span><span>${money(order.total)}</span></div>
      </div>
      <div class="foot">Printed ${clockTime(lastDay.now)} &middot; status: ${labelFor(order.status)}</div>
    </div>
  `;

  window.print();
}

// Don't leave a stale ticket sitting in the DOM after the dialog closes.
window.addEventListener('afterprint', () => { $('printArea').innerHTML = ''; });

function renderOrders(orders) {
  const el = $('ordersList');
  const open = orders.filter(o => o.status !== 'collected' && o.status !== 'cancelled').length;
  $('ordersCount').textContent = orders.length
    ? `${orders.length} order${orders.length === 1 ? '' : 's'} · ${open} open`
    : '';

  if (!orders.length) {
    el.innerHTML = emptyState('No food orders for this day yet.');
    return;
  }

  el.innerHTML = orders.map(o => {
    const lines = o.items.map(it => html`
      <div class="line">
        <span><span class="q">${String(it.qty)}&times;</span> ${it.name}</span>
        <span>${money(it.price * it.qty)}</span>
      </div>
    `).join('');

    return html`
      <article class="card is-${o.status}">
        <div class="card-top">
          <div class="who">
            <div class="name">${o.customer_name}</div>
            <div class="meta">${o.order_type} · ${clockTime(o.created_at)} · <a href="tel:${o.phone}">${o.phone}</a></div>
          </div>
          <div class="amount">
            <div class="n">${money(o.total)}</div>
            <div class="ref">${o.order_number}</div>
          </div>
        </div>
        <span class="chip chip-${o.status}">${labelFor(o.status)}</span>
        <div class="lines">${raw(lines)}</div>
        <div class="actions">${raw(orderActions(o))}</div>
      </article>
    `;
  }).join('');
}

function bookingActions(b) {
  const parts = [];
  if (b.status === 'confirmed') {
    parts.push(html`<button class="btn btn-primary btn-sm" type="button"
      data-booking="${String(b.id)}" data-status="arrived">Mark arrived</button>`);
    parts.push(html`<button class="btn btn-quiet btn-sm" type="button"
      data-booking="${String(b.id)}" data-status="no_show">No-show</button>`);
    parts.push(html`<button class="btn btn-danger btn-sm" type="button"
      data-booking="${String(b.id)}" data-status="cancelled" data-confirm="1">Cancel</button>`);
  } else {
    parts.push(html`<button class="btn btn-quiet btn-sm" type="button"
      data-booking="${String(b.id)}" data-status="confirmed">Undo</button>`);
  }
  return parts.join('');
}

function renderBookings(bookings) {
  const el = $('bookingsList');
  const waiting = bookings.filter(b => b.status === 'confirmed').length;
  $('courtsCount').textContent = bookings.length
    ? `${bookings.length} booking${bookings.length === 1 ? '' : 's'} · ${waiting} awaiting`
    : '';

  if (!bookings.length) {
    el.innerHTML = emptyState('No court bookings for this day.');
    return;
  }

  el.innerHTML = bookings.map(b => html`
    <article class="card is-${b.status}">
      <div class="card-top">
        <div class="who">
          <div class="slot-time">${b.booking_time}</div>
          <div class="slot-court">${b.court_name || b.court_id}</div>
        </div>
        <div class="amount">
          <div class="n">${money(b.rate)}</div>
          <div class="ref">${b.confirmation_number}</div>
        </div>
      </div>
      <div class="card-top" style="margin-bottom:6px;">
        <div class="who">
          <div class="name">${b.customer_name}</div>
          <div class="meta">${b.party_size} · <a href="tel:${b.phone}">${b.phone}</a></div>
        </div>
      </div>
      <span class="chip chip-${b.status}">${labelFor(b.status)}</span>
      <div class="actions">${raw(bookingActions(b))}</div>
    </article>
  `).join('');
}

/* ---------------- Loading ---------------- */

function setBanner(message) {
  const el = $('banner');
  if (message) { el.textContent = message; el.classList.add('show'); }
  else { el.classList.remove('show'); el.textContent = ''; }
}

async function load() {
  if (inFlight) return;
  inFlight = true;
  try {
    const query = currentDate ? '?date=' + encodeURIComponent(currentDate) : '';
    const data = await api('/api/admin/day' + query);
    lastDay = data;

    currentDate = data.date;
    serverToday = data.today;

    $('dateLabel').textContent = longDate(data.date);
    $('dateRel').textContent = relativeDay(data.date);
    $('datePick').value = data.date;

    renderStats(data.stats);
    renderOrders(data.orders);
    renderBookings(data.bookings);

    lastLoaded = new Date();
    updateRefreshNote();
    setBanner(null);
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    setBanner('Could not reach the server. Showing the last update — retrying shortly.');
  } finally {
    inFlight = false;
  }
}

function updateRefreshNote() {
  if (!lastLoaded) return;
  const secs = Math.round((Date.now() - lastLoaded.getTime()) / 1000);
  const when = secs < 10 ? 'just now'
    : secs < 60 ? `${secs} seconds ago`
    : `${Math.round(secs / 60)} min ago`;
  $('refreshNote').textContent = `Updated ${when} · refreshes every ${REFRESH_MS / 1000}s`;
}

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    // No point polling a tab nobody is looking at.
    if (document.visibilityState === 'visible') load();
    updateRefreshNote();
  }, REFRESH_MS);
}

function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/* ---------------- Actions ---------------- */

function announce(message) {
  const el = $('srStatus');
  el.textContent = '';
  // Clearing first makes screen readers re-announce an identical message.
  setTimeout(() => { el.textContent = message; }, 50);
}

async function updateStatus(kind, id, status, button) {
  const label = button.closest('.card').querySelector('.name');
  const who = label ? label.textContent.trim() : '';
  button.disabled = true;
  try {
    await api(`/api/admin/${kind}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await load();
    announce(`${kind === 'orders' ? 'Order' : 'Booking'} for ${who} marked ${labelFor(status)}.`);
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    setBanner(err.message);
    announce(err.message);
    button.disabled = false;
  }
}

function wireEvents() {
  $('loginForm').addEventListener('submit', handleLogin);
  $('logoutBtn').addEventListener('click', handleLogout);
  $('refreshBtn').addEventListener('click', load);

  $('prevDay').addEventListener('click', () => { currentDate = shiftDate(currentDate, -1); load(); });
  $('nextDay').addEventListener('click', () => { currentDate = shiftDate(currentDate, 1); load(); });
  $('todayBtn').addEventListener('click', () => { currentDate = serverToday; load(); });
  $('datePick').addEventListener('change', e => {
    if (e.target.value) { currentDate = e.target.value; load(); }
  });

  document.addEventListener('click', e => {
    const printBtn = e.target.closest('[data-print]');
    if (printBtn) { printTicket(printBtn.dataset.print); return; }

    const btn = e.target.closest('[data-order], [data-booking]');
    if (!btn) return;
    const status = btn.dataset.status;

    if (btn.dataset.confirm && !window.confirm(
      'Cancel this booking? The time slot will be released for someone else to book.')) return;

    if (btn.dataset.order) updateStatus('orders', btn.dataset.order, status, btn);
    else updateStatus('bookings', btn.dataset.booking, status, btn);
  });

  document.querySelectorAll('[data-backdrop-close]').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) closeSheet(overlay.id); });
  });
  document.addEventListener('click', e => {
    const closer = e.target.closest('[data-close]');
    if (closer) closeSheet(closer.dataset.close);
  });

  // Coming back to the tab should show current information, not a stale board.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('boardView').classList.contains('show')) load();
  });

  setInterval(updateRefreshNote, 10000);
}

/* ---------------- Init ---------------- */

async function init() {
  wireEvents();
  wireManagement();
  try {
    const me = await api('/api/admin/me');
    showBoard(me.user);
    await load();
    startRefresh();
  } catch (err) {
    showLogin();
  }
}

init();

/* =====================================================================
   Menu & court management
   =====================================================================
   Everything typed here ends up rendered in a customer's browser, so it
   goes through the same escaping as everything else — and the server
   validates it independently. Neither layer trusts the other.
   ===================================================================== */

let manage = { items: [], courts: [], recentChanges: [], limits: {} };
let editingDish = null;    // the dish being edited, or null when adding
let editingCourt = null;

function vatOf(gross) {
  const rate = 0.12;
  return gross * rate / (1 + rate);
}

function switchView(view) {
  const service = view !== 'manage';
  $('serviceView').hidden = !service;
  $('manageView').hidden = service;
  document.querySelectorAll('.viewtab').forEach(t =>
    t.setAttribute('aria-selected', String(t.dataset.view === view)));

  if (service) { startRefresh(); load(); }
  else { stopRefresh(); loadManage(); }   // no polling while someone is editing
}

async function loadManage() {
  try {
    manage = await api('/api/admin/menu');
    renderCourtRows();
    renderMenuRows();
    renderChangeLog();
    setManageBanner(null);
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    setManageBanner(err.message);
  }
}

function setManageBanner(message) {
  const el = $('manageBanner');
  if (message) { el.textContent = message; el.classList.add('show'); }
  else { el.classList.remove('show'); el.textContent = ''; }
}

function announceManage(message) {
  const el = $('manageStatus');
  el.textContent = '';
  setTimeout(() => { el.textContent = message; }, 50);
}

/* ---------------- courts ---------------- */

function renderCourtRows() {
  const el = $('courtRows');
  if (!manage.courts.length) {
    el.innerHTML = html`<p class="panel-note">No courts yet. Add one to start taking bookings.</p>`;
    return;
  }
  el.innerHTML = manage.courts.map(c => html`
    <div class="row ${c.active ? '' : 'inactive'}">
      <div class="grow">
        <div class="rname">${c.name} ${raw(c.active ? '' : '<span class="tag-off">Out of service</span>')}</div>
      </div>
      <div class="ractions">
        <button class="btn btn-quiet btn-sm" type="button" data-edit-court="${c.id}">Rename</button>
        ${raw(c.active
          ? html`<button class="btn btn-quiet btn-sm" type="button" data-court-active="${c.id}" data-to="0">Take out of service</button>`
          : html`<button class="btn btn-primary btn-sm" type="button" data-court-active="${c.id}" data-to="1">Put back in service</button>`)}
      </div>
    </div>
  `).join('');
}

/* ---------------- menu ---------------- */

function renderMenuRows() {
  const el = $('menuRows');
  if (!manage.items.length) {
    el.innerHTML = html`<p class="panel-note">Nothing on the menu yet.</p>`;
    return;
  }

  // Group by category, keeping the order the server sent.
  const groups = [];
  for (const item of manage.items) {
    let group = groups.find(g => g.name === item.category);
    if (!group) { group = { name: item.category, items: [] }; groups.push(group); }
    group.items.push(item);
  }

  el.innerHTML = groups.map(group => html`
    <div class="cat-head">${group.name}</div>
    ${raw(group.items.map((item, i) => html`
      <div class="row ${item.active ? '' : 'inactive'}">
        <div class="swatch" style="background:${item.thumb}" aria-hidden="true">${item.emoji}</div>
        <div class="grow">
          <div class="rname">${item.name} ${raw(item.active ? '' : '<span class="tag-off">Removed</span>')}</div>
          <div class="rdesc">${item.description}</div>
        </div>
        <div class="rprice">${money(item.price)}<small>incl. ${money(vatOf(item.price))} VAT</small></div>
        <div class="ractions">
          <button class="icon-sm" type="button" data-move="${item.id}" data-dir="up"
                  aria-label="Move ${item.name} up" ${raw(i === 0 ? 'disabled' : '')}>
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
          <button class="icon-sm" type="button" data-move="${item.id}" data-dir="down"
                  aria-label="Move ${item.name} down" ${raw(i === group.items.length - 1 ? 'disabled' : '')}>
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <button class="btn btn-quiet btn-sm" type="button" data-edit-dish="${item.id}">Edit</button>
          ${raw(item.active
            ? html`<button class="btn btn-danger btn-sm" type="button" data-dish-active="${item.id}" data-to="0">Remove</button>`
            : html`<button class="btn btn-primary btn-sm" type="button" data-dish-active="${item.id}" data-to="1">Restore</button>`)}
        </div>
      </div>
    `).join(''))}
  `).join('');
}

function renderChangeLog() {
  const el = $('changeLog');
  if (!manage.recentChanges.length) {
    el.innerHTML = html`<p class="panel-note">No changes yet.</p>`;
    return;
  }
  el.innerHTML = manage.recentChanges.map(c => html`
    <div class="change">
      <time>${clockTime(c.created_at)} ${c.created_at.slice(5, 10)}</time>
      <div class="what"><b>${c.action} ${c.entity}</b> <span>${c.detail}</span></div>
    </div>
  `).join('');
}

/* ---------------- editing ---------------- */

function openDishEditor(id) {
  editingDish = id ? manage.items.find(i => i.id === id) : null;
  $('dishTitle').textContent = editingDish ? 'Edit dish' : 'Add a dish';
  $('dishError').classList.remove('show');

  const categories = [...new Set(manage.items.map(i => i.category))];
  $('categoryList').innerHTML = categories.map(c => html`<option value="${c}"></option>`).join('');

  $('dishName').value = editingDish ? editingDish.name : '';
  $('dishCategory').value = editingDish ? editingDish.category : (categories[0] || '');
  $('dishDescription').value = editingDish ? (editingDish.description || '') : '';
  $('dishPrice').value = editingDish ? editingDish.price : '';
  $('dishEmoji').value = editingDish ? (editingDish.emoji || '') : '';
  $('dishThumb').value = editingDish ? (editingDish.thumb || '#f0e6d2') : '#f0e6d2';
  updateDishPreview();

  openSheet('dishOverlay');
}

function updateDishPreview() {
  const preview = $('dishPreview');
  preview.style.background = $('dishThumb').value;
  preview.textContent = $('dishEmoji').value || '🍽';
  const price = Number($('dishPrice').value);
  $('dishPriceHint').textContent = Number.isFinite(price) && price > 0
    ? `Customer pays ${money(price)}, of which ${money(vatOf(price))} is VAT`
    : 'What you type is what the customer pays.';
}

async function saveDish(e) {
  e.preventDefault();
  const btn = $('dishSaveBtn');
  const errBox = $('dishError');
  errBox.classList.remove('show');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const payload = {
    name: $('dishName').value,
    category: $('dishCategory').value,
    description: $('dishDescription').value,
    price: $('dishPrice').value,
    emoji: $('dishEmoji').value,
    thumb: $('dishThumb').value,
  };

  try {
    if (editingDish) {
      await api(`/api/admin/menu/${encodeURIComponent(editingDish.id)}`,
        { method: 'PATCH', body: JSON.stringify(payload) });
      announceManage(`${payload.name} saved.`);
    } else {
      await api('/api/admin/menu', { method: 'POST', body: JSON.stringify(payload) });
      announceManage(`${payload.name} added to the menu.`);
    }
    closeSheet('dishOverlay');
    await loadManage();
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    errBox.textContent = err.message;
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

function openCourtEditor(id) {
  editingCourt = id ? manage.courts.find(c => c.id === id) : null;
  $('courtTitle').textContent = editingCourt ? 'Rename court' : 'Add a court';
  $('courtError').classList.remove('show');
  $('courtName').value = editingCourt ? editingCourt.name : '';
  openSheet('courtOverlay');
}

async function saveCourt(e) {
  e.preventDefault();
  const btn = $('courtSaveBtn');
  const errBox = $('courtError');
  errBox.classList.remove('show');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const body = JSON.stringify({ name: $('courtName').value });
    if (editingCourt) await api(`/api/admin/courts/${encodeURIComponent(editingCourt.id)}`, { method: 'PATCH', body });
    else await api('/api/admin/courts', { method: 'POST', body });
    announceManage('Court saved.');
    closeSheet('courtOverlay');
    await loadManage();
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    errBox.textContent = err.message;
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function setDishActive(id, active) {
  const dish = manage.items.find(i => i.id === id);
  if (!active && !window.confirm(
    `Remove "${dish ? dish.name : 'this dish'}" from the menu?\n\nCustomers stop seeing it immediately. Past orders keep it, and you can restore it here.`)) return;

  try {
    if (active) await api(`/api/admin/menu/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
    else await api(`/api/admin/menu/${encodeURIComponent(id)}`, { method: 'DELETE' });
    announceManage(active ? 'Dish restored.' : 'Dish removed from the menu.');
    await loadManage();
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    setManageBanner(err.message);
  }
}

async function setCourtActive(id, active) {
  const court = manage.courts.find(c => c.id === id);
  if (!active && !window.confirm(
    `Take "${court ? court.name : 'this court'}" out of service?\n\nIt disappears from the booking screen. Any bookings already made still stand.`)) return;

  try {
    if (active) {
      await api(`/api/admin/courts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
      announceManage('Court back in service.');
    } else {
      const result = await api(`/api/admin/courts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (result.warning) setManageBanner(result.warning);
      announceManage('Court taken out of service.');
    }
    await loadManage();
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    setManageBanner(err.message);
  }
}

/** Moving a dish sends the whole category's new order, so the result is unambiguous. */
async function moveDish(id, direction) {
  const item = manage.items.find(i => i.id === id);
  if (!item) return;

  const siblings = manage.items.filter(i => i.category === item.category);
  const at = siblings.findIndex(i => i.id === id);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (to < 0 || to >= siblings.length) return;

  [siblings[at], siblings[to]] = [siblings[to], siblings[at]];

  // Rebuild the full list with this category's new internal order.
  const reordered = [];
  const seen = new Set();
  for (const existing of manage.items) {
    if (existing.category !== item.category) { reordered.push(existing); continue; }
    if (seen.has(item.category)) continue;
    seen.add(item.category);
    reordered.push(...siblings);
  }

  try {
    await api('/api/admin/menu/reorder', { method: 'POST', body: JSON.stringify({ ids: reordered.map(i => i.id) }) });
    await loadManage();
    const moved = document.querySelector(`[data-move="${CSS.escape(id)}"][data-dir="${direction}"]`);
    if (moved && !moved.disabled) moved.focus();
    announceManage(`${item.name} moved ${direction}.`);
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    setManageBanner(err.message);
  }
}

/* ---------------- wiring ---------------- */

function wireManagement() {
  document.querySelectorAll('.viewtab').forEach(tab =>
    tab.addEventListener('click', () => switchView(tab.dataset.view)));

  $('addDishBtn').addEventListener('click', () => openDishEditor(null));
  $('addCourtBtn').addEventListener('click', () => openCourtEditor(null));
  $('dishForm').addEventListener('submit', saveDish);
  $('courtForm').addEventListener('submit', saveCourt);

  ['dishThumb', 'dishEmoji', 'dishPrice'].forEach(id =>
    $(id).addEventListener('input', updateDishPreview));

  document.addEventListener('click', e => {
    const edit = e.target.closest('[data-edit-dish]');
    if (edit) { openDishEditor(edit.dataset.editDish); return; }

    const editCourt = e.target.closest('[data-edit-court]');
    if (editCourt) { openCourtEditor(editCourt.dataset.editCourt); return; }

    const dishActive = e.target.closest('[data-dish-active]');
    if (dishActive) { setDishActive(dishActive.dataset.dishActive, dishActive.dataset.to === '1'); return; }

    const courtActive = e.target.closest('[data-court-active]');
    if (courtActive) { setCourtActive(courtActive.dataset.courtActive, courtActive.dataset.to === '1'); return; }

    const move = e.target.closest('[data-move]');
    if (move) { moveDish(move.dataset.move, move.dataset.dir); return; }
  });
}
