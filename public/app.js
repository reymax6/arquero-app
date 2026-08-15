/* =====================================================================
   Arquero's Mountain Resort — front end
   =====================================================================
   Two rules this file follows without exception:

   1. Text that came from the database or from a person is NEVER dropped
      into HTML raw. The html`` tagged template (from safe-html.js)
      escapes every interpolated value automatically, so a dish called
      <img src=x onerror=...> renders as those literal characters
      instead of running as code.

   2. No handler is ever built as a string of JavaScript. Everything is
      wired with addEventListener and data-* attributes carrying IDs
      only — never display names. That means a court called "Rey's Court"
      behaves exactly like any other.
   ===================================================================== */

'use strict';

/* esc(), html`` and raw() come from safe-html.js, loaded before this file. */

/* ---------------- API ---------------- */

const API = ''; // same origin

async function apiGet(path) {
  const res = await fetch(API + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error('Request failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- State ---------------- */

let MENU = {};                 // { category: [ {id,name,desc,price,emoji,thumb} ] }
let CATEGORIES = [];           // ordered category names
let COURTS = [];               // [ {id, name} ]
let CONFIG = {
  slots: [], rate: 1000, taxRate: 0.12, vatInclusive: true, maxQtyPerLine: 20,
  orderTypes: [], partySizes: [],
};

let cart = [];                 // [ {id, name, price, thumb, emoji, qty} ]
let selectedDateIdx = 0;
let pendingSlot = null;        // {courtId, time, dateIso}
let activeCatIdx = 0;
let bookedByCourt = {};        // { courtId: [times] } for the selected date
let pastTimes = [];            // times already gone by, if the selected date is today

/* ---------------- Dates (always local, never UTC) ---------------- */

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * Formats a Date as YYYY-MM-DD using the *browser's own* calendar day.
 * toISOString() would convert to UTC first, which in Manila (UTC+8) rolls
 * the date back to yesterday for anyone using the app before 8am.
 */
function localISO(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getDates() {
  const out = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    out.push({
      iso: localISO(d),
      dow: DOW[d.getDay()],
      dnum: d.getDate(),
      label: d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    });
  }
  return out;
}

function selectedDate() { return getDates()[selectedDateIdx]; }

/* ---------------- Small helpers ---------------- */

const $ = id => document.getElementById(id);
/* money() comes from money.js, loaded before this file. */

let toastTimer;
function showToast(msg) {
  const t = $('toast');
  $('toastMsg').textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ---------------- Navigation ---------------- */

function navigate(name) {
  const target = $('screen-' + name);
  if (!target) return;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  target.classList.add('active');
  document.querySelectorAll('.navbtn').forEach(b => {
    if (b.dataset.nav === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  // Reset scroll on whichever element is actually scrolling: the inner
  // container on wide screens, the window itself on a phone.
  $('screens').scrollTop = 0;
  window.scrollTo(0, 0);
}

/* ---------------- Sheets / dialogs ---------------- */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openSheets = [];
let focusBeforeSheet = null;
let returnFocusTo = null; // optional function that finds where focus should land on close

/**
 * @param {string} id            overlay element id
 * @param {Function} [resolver]  called on close to find the element to focus.
 *   Needed when the thing that opened the sheet gets re-rendered while the
 *   sheet is open (a time slot, for instance) and so can't just be held onto.
 */
function openSheet(id, resolver) {
  const overlay = $(id);
  if (!overlay || overlay.classList.contains('show')) return;
  if (openSheets.length === 0) {
    const active = document.activeElement;
    focusBeforeSheet = active && active !== document.body ? active : null;
    returnFocusTo = resolver || null;
  }
  // A toast floating over an open sheet just looks like a mistake.
  clearTimeout(toastTimer);
  $('toast').classList.remove('show');
  overlay.classList.add('show');
  openSheets.push(id);
  const sheet = overlay.querySelector('.sheet');
  const first = sheet.querySelector(FOCUSABLE);
  (first || sheet).focus({ preventScroll: true });
}

function closeSheet(id) {
  const overlay = $(id);
  if (!overlay) return;
  overlay.classList.remove('show');
  const at = openSheets.indexOf(id);
  if (at > -1) openSheets.splice(at, 1);
  if (openSheets.length === 0) {
    // Put focus back on the control that opened this sheet. If that control
    // has since been re-rendered or disabled, land on the main region — never
    // dump a keyboard user back at the top of the document.
    let target = null;
    if (returnFocusTo) { try { target = returnFocusTo(); } catch (e) { target = null; } }
    if (target && (target.disabled || !document.contains(target))) target = null;
    if (!target && focusBeforeSheet && document.contains(focusBeforeSheet)) target = focusBeforeSheet;
    (target || $('screens')).focus({ preventScroll: true });
    focusBeforeSheet = null;
    returnFocusTo = null;
  }
}

function closeAllAndHome() {
  [...openSheets].forEach(closeSheet);
  navigate('home');
}

document.addEventListener('keydown', e => {
  if (!openSheets.length) return;
  const topId = openSheets[openSheets.length - 1];

  if (e.key === 'Escape') {
    e.preventDefault();
    closeSheet(topId);
    return;
  }
  // Keep Tab inside the open sheet so keyboard users can't wander behind it.
  if (e.key === 'Tab') {
    const sheet = $(topId).querySelector('.sheet');
    const items = [...sheet.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* ---------------- Menu ---------------- */

function renderMenuTabs() {
  const el = $('menuTabs');
  el.innerHTML = CATEGORIES.map((cat, i) => html`
    <button class="tab" type="button" role="tab"
            id="tab-${String(i)}"
            data-cat="${String(i)}"
            aria-controls="menuList"
            aria-selected="${i === activeCatIdx ? 'true' : 'false'}"
            tabindex="${i === activeCatIdx ? '0' : '-1'}">${cat}</button>
  `).join('');
}

function renderMenuList() {
  const el = $('menuList');
  const cat = CATEGORIES[activeCatIdx];
  const items = (cat && MENU[cat]) || [];

  el.setAttribute('role', 'tabpanel');
  if (cat) el.setAttribute('aria-labelledby', 'tab-' + activeCatIdx);

  if (!items.length) {
    el.innerHTML = html`<div class="empty-state"><p>Nothing on this part of the menu just yet.</p></div>`;
    return;
  }

  el.innerHTML = items.map(item => html`
    <div class="card menu-item">
      <div class="thumb" style="background:${item.thumb}" aria-hidden="true">${item.emoji}</div>
      <div class="info">
        <h4>${item.name}</h4>
        <p>${item.desc}</p>
        <div class="row">
          <span class="price">${money(item.price)}</span>
          <button class="add-btn" type="button" data-add="${item.id}"
                  aria-label="Add ${item.name} to your order">
            <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      </div>
    </div>
  `).join('');
}

function setMenuCat(index) {
  if (index < 0 || index >= CATEGORIES.length) return;
  activeCatIdx = index;
  renderMenuTabs();
  renderMenuList();
  const tab = $('tab-' + index);
  if (tab) { tab.focus({ preventScroll: true }); tab.scrollIntoView({ block: 'nearest', inline: 'center' }); }
}

function findMenuItem(id) {
  for (const cat of CATEGORIES) {
    const found = (MENU[cat] || []).find(i => i.id === id);
    if (found) return found;
  }
  return null;
}

/* ---------------- Cart ---------------- */

function addToCart(id) {
  const item = findMenuItem(id);
  if (!item) return;
  const existing = cart.find(c => c.id === id);
  if (existing) {
    if (existing.qty >= CONFIG.maxQtyPerLine) {
      showToast(`That's the most we can do in one order (${CONFIG.maxQtyPerLine}).`);
      return;
    }
    existing.qty++;
  } else {
    cart.push({ id: item.id, name: item.name, price: item.price, thumb: item.thumb, emoji: item.emoji, qty: 1 });
  }
  saveCart();
  updateCartBadge();
  showToast(item.name + ' added to your order');
}

function changeQty(id, delta) {
  const line = cart.find(c => c.id === id);
  if (!line) return;
  const next = line.qty + delta;
  if (next > CONFIG.maxQtyPerLine) {
    showToast(`Maximum ${CONFIG.maxQtyPerLine} per dish.`);
    return;
  }
  if (next <= 0) cart = cart.filter(c => c.id !== id);
  else line.qty = next;
  saveCart();
  updateCartBadge();
  renderCart();
}

/* ---- keeping the cart across a refresh ----------------------------
   Half-composed orders are easy to lose: a customer taps a link, the
   connection drops on resort wi-fi, or they lock their phone. The cart
   lives in sessionStorage so it survives that, and clears itself when
   they close the tab — nobody wants yesterday's half-order waiting for
   them. Only ids and quantities are trusted on the way back in; names
   and prices are re-read from the menu the server just sent us.
   ------------------------------------------------------------------ */

const CART_KEY = 'arquero.cart.v1';

function saveCart() {
  try {
    sessionStorage.setItem(CART_KEY, JSON.stringify(cart.map(c => ({ id: c.id, qty: c.qty }))));
  } catch (e) { /* private browsing, or storage full — not worth interrupting anyone over */ }
}

function restoreCart() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(CART_KEY) || '[]');
  } catch (e) { return; }
  if (!Array.isArray(saved)) return;

  cart = [];
  for (const entry of saved) {
    const item = findMenuItem(entry && entry.id);
    if (!item) continue;  // dish has since come off the menu
    const qty = Math.min(Math.max(parseInt(entry.qty, 10) || 1, 1), CONFIG.maxQtyPerLine);
    cart.push({ id: item.id, name: item.name, price: item.price, thumb: item.thumb, emoji: item.emoji, qty });
  }
  if (cart.length) {
    updateCartBadge();
    renderCart();
  }
}

function clearCart() {
  cart = [];
  try { sessionStorage.removeItem(CART_KEY); } catch (e) { /* ignore */ }
  updateCartBadge();
}

function updateCartBadge() {
  const count = cart.reduce((s, c) => s + c.qty, 0);
  const badge = $('cartBadge');
  badge.textContent = String(count);
  badge.hidden = count === 0;
  $('cartBtn').setAttribute('aria-label',
    count === 0 ? 'Your order, empty' : `Your order, ${count} item${count === 1 ? '' : 's'}`);
}

function cartTotal() {
  // Menu prices already include VAT, so the sum IS the total. The VAT line
  // is informational — it's the portion of that total, not an addition.
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const tax = total * CONFIG.taxRate / (1 + CONFIG.taxRate);
  return { total, tax, subtotal: total - tax };
}

function renderCart() {
  const itemsEl = $('cartItems');
  const summaryEl = $('cartSummary');
  const checkoutBtn = $('checkoutBtn');

  if (cart.length === 0) {
    itemsEl.innerHTML = html`<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
      <p>Your order is empty.<br>Add something tasty from the menu.</p>
    </div>`;
    summaryEl.innerHTML = '';
    checkoutBtn.disabled = true;
    return;
  }

  checkoutBtn.disabled = false;
  itemsEl.innerHTML = cart.map(c => html`
    <div class="cart-line">
      <div class="ci-thumb" style="background:${c.thumb}" aria-hidden="true">${c.emoji}</div>
      <div class="ci-info">
        <h5>${c.name}</h5>
        <div class="ci-price">${money(c.price)} each</div>
      </div>
      <div class="qty-ctrl">
        <button type="button" data-qty="-1" data-id="${c.id}" aria-label="Remove one ${c.name}"><span aria-hidden="true">&minus;</span></button>
        <span class="qty-val" aria-label="${c.qty} in your order">${String(c.qty)}</span>
        <button type="button" data-qty="1" data-id="${c.id}" aria-label="Add one more ${c.name}"
          ${raw(c.qty >= CONFIG.maxQtyPerLine ? 'disabled' : '')}><span aria-hidden="true">+</span></button>
      </div>
    </div>
  `).join('');

  const { tax, total } = cartTotal();
  const taxPct = Math.round(CONFIG.taxRate * 100);
  summaryEl.innerHTML = html`
    <div class="summary-row total"><span>Total</span><span>${money(total)}</span></div>
    <div class="summary-row"><span>Includes VAT (${String(taxPct)}%)</span><span>${money(tax)}</span></div>
  `;
}

/* ---------------- Field validation (mirrors the server) ---------------- */

function setFieldError(fieldId, errId, message) {
  const field = $(fieldId);
  const err = $(errId);
  const input = field.querySelector('input, select');
  if (message) {
    field.classList.add('invalid');
    err.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', errId);
  } else {
    field.classList.remove('invalid');
    err.textContent = '';
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
  return !message;
}

function checkName(value) {
  const t = value.trim();
  if (t.length < 2) return 'Please enter your name.';
  if (t.length > 80) return 'That name is too long.';
  return null;
}

function checkPhone(value) {
  const t = value.trim();
  if (!t) return 'Please enter a phone number.';
  if (t.length > 25) return 'That phone number is too long.';
  if (!/^[0-9+()\-.\s]+$/.test(t)) return 'Use only numbers, spaces, and + ( ) -';
  if (t.replace(/\D/g, '').length < 7) return 'That phone number looks too short.';
  return null;
}

/* ---------------- Orders ---------------- */

async function submitOrder(e) {
  e.preventDefault();
  const nameEl = $('orderName');
  const phoneEl = $('orderPhone');

  const okName = setFieldError('orderNameField', 'orderNameErr', checkName(nameEl.value));
  const okPhone = setFieldError('orderPhoneField', 'orderPhoneErr', checkPhone(phoneEl.value));
  if (!okName) { nameEl.focus(); return; }
  if (!okPhone) { phoneEl.focus(); return; }
  if (cart.length === 0) { showToast('Your order is empty.'); return; }

  const btn = $('placeOrderBtn');
  btn.disabled = true;
  btn.textContent = 'Placing order…';

  try {
    const order = await apiPost('/api/orders', {
      name: nameEl.value.trim(),
      phone: phoneEl.value.trim(),
      orderType: $('orderType').value,
      items: cart.map(c => ({ id: c.id, qty: c.qty })),
    });

    const lines = order.items.map(c => html`
      <div class="r-row"><span>${String(c.qty)}&times; ${c.name}</span><span>${money(c.price * c.qty)}</span></div>
    `).join('');

    $('orderReceipt').innerHTML = html`
      <div class="r-row"><span>Order #</span><span>${order.orderNumber}</span></div>
      <div class="r-row"><span>Name</span><span>${order.name}</span></div>
      <div class="r-row"><span>Type</span><span>${order.orderType}</span></div>
      <div class="dashed"></div>
      ${raw(lines)}
      <div class="dashed"></div>
      <div class="r-row" style="font-weight:700;"><span>Total paid</span><span>${money(order.total)}</span></div>
      <div class="r-row"><span>Net of VAT</span><span>${money(order.subtotal)}</span></div>
      <div class="r-row"><span>VAT (${String(Math.round(CONFIG.taxRate * 100))}%)</span><span>${money(order.tax)}</span></div>
    `;

    clearCart();
    $('orderForm').reset();
    closeSheet('checkoutOverlay');
    openSheet('orderConfirmOverlay');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Place Order';
  }
}

/* ---------------- Courts ---------------- */

function renderDateStrip() {
  const el = $('dateStrip');
  el.innerHTML = getDates().map((d, i) => html`
    <button class="date-chip" type="button" data-date-idx="${String(i)}"
            aria-pressed="${i === selectedDateIdx ? 'true' : 'false'}"
            aria-label="${d.label}">
      <div class="dow" aria-hidden="true">${d.dow}</div>
      <div class="dnum" aria-hidden="true">${String(d.dnum)}</div>
    </button>
  `).join('');
}

async function loadAvailability() {
  const date = selectedDate();
  try {
    const data = await apiGet('/api/availability?date=' + encodeURIComponent(date.iso));
    bookedByCourt = data.booked || {};
    pastTimes = data.past || [];
  } catch (err) {
    bookedByCourt = {};
    pastTimes = [];
    showToast('Could not load court availability.');
  }
}

function renderCourts() {
  const date = selectedDate();
  const el = $('courtList');

  if (!COURTS.length) {
    el.innerHTML = html`<div class="empty-state"><p>No courts are set up yet.</p></div>`;
    return;
  }

  el.innerHTML = COURTS.map(court => {
    const booked = bookedByCourt[court.id] || [];
    const slots = CONFIG.slots.map(time => {
      const isPast = pastTimes.includes(time);
      const isBooked = booked.includes(time);
      const unavailable = isPast || isBooked;
      const isSelected = !!pendingSlot && pendingSlot.courtId === court.id
        && pendingSlot.time === time && pendingSlot.dateIso === date.iso;
      const status = isPast ? 'already passed' : isBooked ? 'already booked' : 'available';

      return html`<button class="slot" type="button"
        data-court="${court.id}" data-time="${time}"
        ${raw(unavailable ? 'disabled' : '')}
        aria-pressed="${isSelected ? 'true' : 'false'}"
        aria-label="${court.name}, ${time}, ${status}">${time}</button>`;
    }).join('');

    const allGone = CONFIG.slots.every(t => pastTimes.includes(t) || booked.includes(t));

    return html`
      <div class="court-block">
        <div class="court-title">${court.name} <span class="sub">Outdoor &middot; Lit</span></div>
        <div class="slot-grid">${raw(slots)}</div>
        ${raw(allGone ? '<p class="court-empty">Fully booked for this day.</p>' : '')}
      </div>
    `;
  }).join('');
}

async function selectDate(i) {
  selectedDateIdx = i;
  pendingSlot = null;
  renderDateStrip();
  await loadAvailability();
  renderCourts();
}

function selectSlot(courtId, time) {
  const court = COURTS.find(c => c.id === courtId);
  const date = selectedDate();
  if (!court) return;

  pendingSlot = { courtId, time, dateIso: date.iso };
  renderCourts();

  $('bookingPreview').innerHTML = html`
    <div class="r-row"><span>Court</span><span>${court.name}</span></div>
    <div class="r-row"><span>Date</span><span>${date.label}</span></div>
    <div class="r-row"><span>Time</span><span>${time} (1 hr)</span></div>
    <div class="r-row"><span>Rate</span><span>${money(CONFIG.rate)} <span style="color:var(--muted);font-weight:400;">incl. VAT</span></span></div>
  `;
  // renderCourts() above replaced the button that was just clicked, so tell
  // the sheet how to find its replacement when it closes.
  openSheet('bookingOverlay', () => document.querySelector(
    `.slot[data-court="${CSS.escape(courtId)}"][data-time="${CSS.escape(time)}"]`
  ));
}

async function submitBooking(e) {
  e.preventDefault();
  if (!pendingSlot) { showToast('Please pick a time slot first.'); return; }

  const nameEl = $('bookName');
  const phoneEl = $('bookPhone');
  const okName = setFieldError('bookNameField', 'bookNameErr', checkName(nameEl.value));
  const okPhone = setFieldError('bookPhoneField', 'bookPhoneErr', checkPhone(phoneEl.value));
  if (!okName) { nameEl.focus(); return; }
  if (!okPhone) { phoneEl.focus(); return; }

  const btn = $('confirmBookingBtn');
  btn.disabled = true;
  btn.textContent = 'Booking…';

  const date = selectedDate();
  try {
    const booking = await apiPost('/api/bookings', {
      courtId: pendingSlot.courtId,
      date: pendingSlot.dateIso,
      time: pendingSlot.time,
      name: nameEl.value.trim(),
      phone: phoneEl.value.trim(),
      partySize: $('bookParty').value,
    });

    $('bookingReceipt').innerHTML = html`
      <div class="r-row"><span>Confirmation #</span><span>${booking.confirmationNumber}</span></div>
      <div class="r-row"><span>Name</span><span>${booking.name}</span></div>
      <div class="r-row"><span>Party</span><span>${booking.partySize}</span></div>
      <div class="dashed"></div>
      <div class="r-row"><span>Court</span><span>${booking.courtName}</span></div>
      <div class="r-row"><span>Date</span><span>${date.label}</span></div>
      <div class="r-row"><span>Time</span><span>${booking.time} (1 hr)</span></div>
      <div class="dashed"></div>
      <div class="r-row" style="font-weight:700;"><span>Total paid</span><span>${money(booking.rate)}</span></div>
      <div class="r-row"><span>Includes VAT (${String(Math.round(CONFIG.taxRate * 100))}%)</span><span>${money(booking.vat != null ? booking.vat : booking.rate * CONFIG.taxRate / (1 + CONFIG.taxRate))}</span></div>
    `;

    pendingSlot = null;
    $('bookingForm').reset();
    closeSheet('bookingOverlay');
    openSheet('bookingConfirmOverlay');
    await loadAvailability();
    renderCourts();
  } catch (err) {
    showToast(err.message);
    if (err.status === 409 || err.status === 400) {
      pendingSlot = null;
      closeSheet('bookingOverlay');
      await loadAvailability();
      renderCourts();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm Booking';
  }
}

/* ---------------- Gallery ---------------- */

/* Drop a real photo into public/images/ using the `file` name below and it
   replaces the coloured tile automatically. Nothing else to change. If the
   file isn't there, the tile stays as it is — so the app never shows a
   broken image icon, and Rey can add photos one at a time. */
const GALLERY = [
  { label: 'Sunrise Deck',     file: 'sunrise-deck.jpg',   grad: 'linear-gradient(135deg,#3a6d59,#173129)' },
  { label: 'Court 1 at Dusk',  file: 'court-dusk.jpg',     grad: 'linear-gradient(135deg,#a3502c,#5c2c17)' },
  { label: 'Wood-Fired Pizza', file: 'wood-fired.jpg',     grad: 'linear-gradient(135deg,#c99542,#8a4222)' },
  { label: 'Ridge Trail View', file: 'ridge-trail.jpg',    grad: 'linear-gradient(135deg,#24463a,#3a6d59)' },
  { label: 'Doubles Match',    file: 'doubles-match.jpg',  grad: 'linear-gradient(135deg,#586760,#24463a)' },
  { label: 'Terrace Dining',   file: 'terrace-dining.jpg', grad: 'linear-gradient(135deg,#8a4222,#c99542)' },
];

let availablePhotos = [];   // filenames the server confirmed are on disk

function renderGallery() {
  const grid = $('galleryGrid');

  grid.innerHTML = GALLERY.map(g => {
    const hasPhoto = availablePhotos.includes(g.file);
    const photo = hasPhoto
      ? html`<img class="g-img" src="images/${g.file}" alt="${g.label} at Arquero's Mountain Resort" loading="lazy">`
      : html`<svg class="g-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;

    return html`
      <figure class="g-photo ${hasPhoto ? 'has-photo' : ''}" style="background:${g.grad}">
        ${raw(photo)}
        <figcaption class="cap">${g.label}</figcaption>
      </figure>
    `;
  }).join('');
}

/* ---------------- Event wiring ---------------- */

function wireEvents() {
  // Bottom nav + any button that asks to navigate
  document.addEventListener('click', e => {
    const nav = e.target.closest('[data-nav], [data-nav-to]');
    if (nav) {
      navigate(nav.dataset.nav || nav.dataset.navTo);
      return;
    }

    const closer = e.target.closest('[data-close]');
    if (closer) { closeSheet(closer.dataset.close); return; }

    if (e.target.closest('[data-close-home]')) { closeAllAndHome(); return; }

    const tab = e.target.closest('[data-cat]');
    if (tab) { setMenuCat(Number(tab.dataset.cat)); return; }

    const add = e.target.closest('[data-add]');
    if (add) { addToCart(add.dataset.add); return; }

    const qty = e.target.closest('[data-qty]');
    if (qty) { changeQty(qty.dataset.id, Number(qty.dataset.qty)); return; }

    const dateChip = e.target.closest('[data-date-idx]');
    if (dateChip) { selectDate(Number(dateChip.dataset.dateIdx)); return; }

    const slot = e.target.closest('[data-court][data-time]');
    if (slot) { selectSlot(slot.dataset.court, slot.dataset.time); return; }
  });

  // Tapping the dark area behind a sheet closes it
  document.querySelectorAll('[data-backdrop-close]').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeSheet(overlay.id);
    });
  });

  $('cartBtn').addEventListener('click', () => { renderCart(); openSheet('cartOverlay'); });

  $('checkoutBtn').addEventListener('click', () => {
    if (cart.length === 0) return;
    closeSheet('cartOverlay');
    openSheet('checkoutOverlay');
  });

  $('orderForm').addEventListener('submit', submitOrder);
  $('bookingForm').addEventListener('submit', submitBooking);

  $('contactBtn').addEventListener('click', () => {
    showToast("Thanks! We'll be in touch shortly.");
  });

  // Clear a field's error as soon as the person fixes it
  [['orderName', 'orderNameField', 'orderNameErr', checkName],
   ['orderPhone', 'orderPhoneField', 'orderPhoneErr', checkPhone],
   ['bookName', 'bookNameField', 'bookNameErr', checkName],
   ['bookPhone', 'bookPhoneField', 'bookPhoneErr', checkPhone]].forEach(([id, field, err, check]) => {
    $(id).addEventListener('input', () => {
      if ($(field).classList.contains('invalid') && !check($(id).value)) {
        setFieldError(field, err, null);
      }
    });
  });

  // Horizontal rows: scrollable with arrow keys, not just a mouse or finger
  document.querySelectorAll('[data-hscroll]').forEach(row => {
    row.addEventListener('keydown', e => {
      if (e.target !== row) return; // let child buttons handle their own keys
      if (e.key === 'ArrowRight') { e.preventDefault(); row.scrollBy({ left: 160, behavior: 'smooth' }); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); row.scrollBy({ left: -160, behavior: 'smooth' }); }
    });
  });

  // Arrow keys move between menu category tabs, as a tablist should
  $('menuTabs').addEventListener('keydown', e => {
    if (!e.target.matches('[data-cat]')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); setMenuCat((activeCatIdx + 1) % CATEGORIES.length); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setMenuCat((activeCatIdx - 1 + CATEGORIES.length) % CATEGORIES.length); }
    if (e.key === 'Home') { e.preventDefault(); setMenuCat(0); }
    if (e.key === 'End') { e.preventDefault(); setMenuCat(CATEGORIES.length - 1); }
  });
}

function fillSelect(id, options) {
  $(id).innerHTML = options.map(o => html`<option value="${o.key}">${o.label}</option>`).join('');
}

/* ---------------- Init ---------------- */

async function init() {
  wireEvents();
  renderGallery();
  renderCart();
  updateCartBadge();
  renderDateStrip();

  try {
    const [menu, courts, config, gallery] = await Promise.all([
      apiGet('/api/menu'),
      apiGet('/api/courts'),
      apiGet('/api/config'),
      apiGet('/api/gallery').catch(() => ({ images: [] })),
    ]);

    MENU = menu || {};
    CATEGORIES = Object.keys(MENU);
    COURTS = Array.isArray(courts) ? courts : [];
    CONFIG = Object.assign(CONFIG, config || {});
    availablePhotos = (gallery && gallery.images) || [];
    renderGallery();      // redraw now that we know which photos exist

    fillSelect('orderType', CONFIG.orderTypes);
    fillSelect('bookParty', CONFIG.partySizes);
    const doubles = CONFIG.partySizes.findIndex(p => p.key === 'doubles');
    if (doubles > -1) $('bookParty').selectedIndex = doubles;

    renderMenuTabs();
    renderMenuList();
    restoreCart();          // only now that we know what's on the menu
    await loadAvailability();
    renderCourts();
  } catch (err) {
    showToast('Could not reach the server. Is it running?');
    console.error(err);
  }
}

init();
