const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'test-secret-123';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:414,height:860} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil:'networkidle' });
  await page.waitForTimeout(700);

  const describe = () => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    return `${a.tagName.toLowerCase()}${a.className ? '.'+a.className.toString().split(' ')[0] : ''}` +
           (a.getAttribute('aria-label') ? ` [${a.getAttribute('aria-label')}]` : '') +
           (a.textContent && a.textContent.trim().length < 30 ? ` "${a.textContent.trim()}"` : '');
  });

  console.log('TAB ORDER FROM THE TOP');
  for (let i=0;i<8;i++){ await page.keyboard.press('Tab'); console.log('  ' + await describe()); }

  console.log('\nPROMO CAROUSEL WITH ARROW KEYS');
  await page.evaluate(() => document.querySelector('.scroll-row[data-hscroll]').focus());
  const before = await page.evaluate(() => document.querySelector('.scroll-row').scrollLeft);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(500);
  const after = await page.evaluate(() => document.querySelector('.scroll-row').scrollLeft);
  console.log(`  scrollLeft ${before} -> ${after}  ${after>before ? 'scrolls with the keyboard' : 'DID NOT SCROLL'}`);

  console.log('\nMENU TABS WITH ARROW KEYS');
  await page.click('[data-nav="menu"]'); await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#menuTabs .tab[aria-selected="true"]').focus());
  const t0 = await describe();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
  const t1 = await describe();
  await page.keyboard.press('End'); await page.waitForTimeout(300);
  const t2 = await describe();
  console.log(`  start: ${t0}\n  ArrowRight: ${t1}\n  End: ${t2}`);

  console.log('\nKEYBOARD-ONLY BOOKING (no mouse at all)');
  await page.click('[data-nav="courts"]'); await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('.slot:not([disabled])').focus());
  console.log('  focused: ' + await describe());
  await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  console.log('  sheet open: ' + (await page.locator('#bookingOverlay.show').count() === 1));
  console.log('  focus moved into sheet: ' + await describe());

  // Tab should stay inside the sheet
  const seen = [];
  for (let i=0;i<9;i++){ await page.keyboard.press('Tab'); seen.push(await page.evaluate(()=>!!document.activeElement.closest('#bookingOverlay'))); }
  console.log('  focus stayed inside the sheet through 9 tabs: ' + seen.every(Boolean));

  await page.evaluate(() => document.getElementById('bookName').focus());
  await page.keyboard.type('Keyboard Tester');
  await page.evaluate(() => document.getElementById('bookPhone').focus());
  await page.keyboard.type('09171234567');
  await page.evaluate(() => document.getElementById('confirmBookingBtn').focus());
  await page.keyboard.press('Enter'); await page.waitForTimeout(1000);
  console.log('  booked via keyboard: ' + (await page.locator('#bookingConfirmOverlay.show').count() === 1));

  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  console.log('  Escape closed it: ' + (await page.locator('#bookingConfirmOverlay.show').count() === 0));
  console.log('  focus returned to: ' + await describe());

  console.log('\nJS errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  await browser.close();
})();
