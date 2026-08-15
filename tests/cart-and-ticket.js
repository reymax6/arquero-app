/* =====================================================================
   Two things that only show up in the details:

   1. A half-composed order survives a refresh. Resort wi-fi drops, people
      lock their phones, links get tapped by accident.
   2. The kitchen ticket prints as a ticket — not as a screenshot of the
      dashboard with the buttons still on it.
   ===================================================================== */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { BASE, ADMIN_PW, seedDayOfService } = require('./fixtures');

const results = [];
const check = (label, ok, note) => {
  results.push({ label, ok, note });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${note ? '  ' + note : ''}`);
};

(async () => {
  const browser = await chromium.launch();

  /* ---------------- the cart survives a refresh ---------------- */
  console.log('\nCART PERSISTENCE');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    await page.click('[data-nav="menu"]');
    await page.waitForTimeout(300);
    await page.locator('.add-btn').first().click();
    await page.waitForTimeout(200);
    await page.locator('.add-btn').first().click();   // same dish twice
    await page.waitForTimeout(200);
    await page.locator('.add-btn').nth(1).click();
    await page.waitForTimeout(300);

    const before = await page.locator('#cartBadge').textContent();
    await page.click('#cartBtn');
    await page.waitForTimeout(300);
    const totalBefore = (await page.locator('.summary-row.total').textContent()).trim();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);

    const after = await page.locator('#cartBadge').textContent();
    await page.click('#cartBtn');
    await page.waitForTimeout(400);
    const totalAfter = (await page.locator('.summary-row.total').textContent()).trim();
    const linesAfter = await page.locator('.cart-line').count();

    check('cart count survives a refresh', before === after, `${before} → ${after}`);
    check('cart total survives a refresh', totalBefore === totalAfter, totalAfter);
    check('quantities are kept, not flattened', linesAfter === 2, `${linesAfter} lines`);

    // Placing the order should clear it, so a refresh afterwards starts fresh.
    await page.click('#checkoutBtn');
    await page.waitForTimeout(300);
    await page.fill('#orderName', 'Persistence Test');
    await page.fill('#orderPhone', '09171234567');
    await page.click('#placeOrderBtn');
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const badgeHidden = await page.locator('#cartBadge').isHidden();
    check('cart is empty after the order is placed', badgeHidden);

    // A dish that comes off the menu shouldn't resurrect from storage.
    await page.evaluate(() => sessionStorage.setItem('arquero.cart.v1',
      JSON.stringify([{ id: 'no-such-dish', qty: 3 }, { id: 'm1', qty: 999 }])));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const restored = await page.evaluate(() => Number(document.getElementById('cartBadge').textContent));
    check('a delisted dish is dropped, and quantity is capped', restored === 20, `badge shows ${restored}`);

    check('no JavaScript errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ---------------- the gallery uses real photos ---------------- */
  console.log('\nGALLERY PHOTOS');
  {
    const imagesDir = path.join(__dirname, '..', 'public', 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const photo = path.join(imagesDir, 'sunrise-deck.jpg');
    const planted = !fs.existsSync(photo);
    if (planted) {
      // A 2x2 JPEG is enough to prove the wiring works.
      fs.writeFileSync(photo, Buffer.from(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
        'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAA' +
        'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'));
    }

    const ctx = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await ctx.newPage();
    const notFound = [];
    page.on('response', r => { if (r.status() === 404) notFound.push(r.url()); });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.click('[data-nav="gallery"]');
    await page.waitForTimeout(600);

    const imgs = await page.locator('.g-photo img').count();
    const tiles = await page.locator('.g-photo').count();
    const alt = await page.locator('.g-photo img').first().getAttribute('alt');

    check('the photo that exists is shown', imgs === 1, `${imgs} of ${tiles} tiles`);
    check('the rest stay as colour tiles', tiles === 6);
    check('the photo has a real alt description', /Sunrise Deck/.test(alt || ''), alt);
    check('no 404s for missing photos', notFound.filter(u => /\/images\//.test(u)).length === 0,
      notFound.length ? notFound.join(' ') : '');

    if (planted) fs.unlinkSync(photo);
    await ctx.close();
  }

  /* ---------------- the kitchen ticket ---------------- */
  console.log('\nKITCHEN TICKET');
  {
    await seedDayOfService();

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.fill('#password', ADMIN_PW);
    await page.click('#loginBtn');
    await page.waitForTimeout(1400);

    // window.print() blocks headless Chromium, so stub it and inspect what
    // the ticket contains at the moment printing would have started.
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });

    const card = page.locator('#ordersList .card').first();
    const ref = (await card.locator('.ref').textContent()).trim();
    const customer = (await card.locator('.name').textContent()).trim();
    await card.locator('[data-print]').click();
    await page.waitForTimeout(400);

    const printed = await page.evaluate(() => window.__printed);
    const ticket = (await page.locator('#printArea').textContent()).replace(/\s+/g, ' ').trim();

    check('the print dialog is opened', printed === 1);
    check('the ticket carries the order number', ticket.includes(ref), ref);
    check('the ticket carries the customer name', ticket.includes(customer), customer);
    check('the ticket shows a total in pesos', /₱[\d,]+\.\d{2}/.test(ticket));
    check('the ticket names the kitchen', /Kitchen/.test(ticket));

    // In print, the working board must be hidden and only the ticket visible.
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(200);
    const boardVisible = await page.locator('#boardView').isVisible();
    const ticketVisible = await page.locator('#printArea').isVisible();
    const buttonsVisible = await page.locator('#ordersList .btn-primary').first().isVisible().catch(() => false);
    await page.emulateMedia({ media: 'screen' });

    check('the board is hidden when printing', !boardVisible);
    check('the ticket is what prints', ticketVisible);
    check('no interface buttons on the paper', !buttonsVisible);

    // The ticket shouldn't linger in the DOM afterwards.
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.waitForTimeout(200);
    const cleared = (await page.locator('#printArea').innerHTML()).trim() === '';
    check('the ticket is cleared after printing', cleared);

    check('no JavaScript errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error('FAILED:\n  ' + failed.map(f => f.label).join('\n  '));
    process.exit(1);
  }
})();
