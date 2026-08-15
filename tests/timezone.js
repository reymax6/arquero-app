const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'test-secret-123';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport:{width:414,height:860},
    timezoneId: 'Asia/Manila',           // UTC+8 — the exact case that broke before
    locale: 'en-PH',
  });
  // 00:30 on 15 August, Manila time. In UTC that is still 14 August.
  await ctx.clock.install({ time: new Date('2026-08-15T00:30:00+08:00') });

  const page = await ctx.newPage();
  let sentBody = null;
  await page.route('**/api/bookings', async route => {
    if (route.request().method() === 'POST') sentBody = route.request().postDataJSON();
    await route.continue();
  });

  await page.goto(BASE, { waitUntil:'networkidle' });
  await page.waitForTimeout(600);
  await page.click('[data-nav="courts"]');
  await page.waitForTimeout(500);

  const browserClock = await page.evaluate(() => new Date().toString());
  const firstChip = page.locator('.date-chip').first();
  const chipLabel  = await firstChip.getAttribute('aria-label');
  const chipDow    = await firstChip.locator('.dow').textContent();
  const chipNum    = await firstChip.locator('.dnum').textContent();

  const slot = page.locator('.court-block').first().locator('.slot:not([disabled])').first();
  await slot.click();
  await page.waitForTimeout(400);
  const previewDate = await page.locator('#bookingPreview .r-row').nth(1).textContent();

  await page.fill('#bookName', 'Midnight Booker');
  await page.fill('#bookPhone', '09171234567');
  await page.click('#confirmBookingBtn');
  await page.waitForTimeout(1000);

  const confirmed = await page.locator('#bookingConfirmOverlay.show').count() === 1;
  const receipt = confirmed ? (await page.locator('#bookingReceipt').textContent()).replace(/\s+/g,' ').trim() : null;

  console.log('Browser clock            :', browserClock);
  console.log('Date chip shown          :', chipDow.trim(), chipNum.trim(), '/', chipLabel);
  console.log('Booking preview says     :', previewDate.replace(/\s+/g,' ').trim());
  console.log('Date sent to the server  :', sentBody && sentBody.date);
  console.log('Booking succeeded        :', confirmed);
  console.log('Receipt                  :', receipt);

  await browser.close();
})();
