/* =====================================================================
   Menu & court management — the app's most dangerous surface.

   Anything saved here is rendered in every customer's browser, so this
   check does two jobs: prove a manager can actually run their menu from
   the screen, and prove the screen can't be used as an injection vector.
   ===================================================================== */

'use strict';

const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const { BASE, ADMIN_PW } = require('./fixtures');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const results = [];
const check = (label, ok, note) => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${note ? '  ' + note : ''}`);
};

async function scan(page, label) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  check(`${label}: no accessibility violations`, r.violations.length === 0,
    r.violations.map(v => `${v.id} (${v.nodes.length})`).join(', '));
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    // 401s (the pre-login check) and 400s (the rejections we deliberately
    // trigger further down) are the app behaving correctly. Chrome logs every
    // failed fetch regardless.
    if (m.type() === 'error' && !/40[01] \((Unauthorized|Bad Request)\)/.test(m.text())) {
      errors.push('console: ' + m.text());
    }
  });
  page.on('dialog', d => d.accept());   // confirm() prompts

  await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.fill('#password', ADMIN_PW);
  await page.click('#loginBtn');
  await page.waitForTimeout(1400);

  console.log('\nREACHING THE SCREEN');
  await page.click('[data-view="manage"]');
  await page.waitForTimeout(900);

  check('the management tab opens', await page.locator('#manageView').isVisible());
  check('the service board is put away', !(await page.locator('#serviceView').isVisible()));
  check('the menu is listed', (await page.locator('#menuRows .row').count()) >= 12);
  check('the courts are listed', (await page.locator('#courtRows .row').count()) >= 4);
  await scan(page, 'management screen');

  console.log('\nADDING A DISH');
  await page.click('#addDishBtn');
  await page.waitForTimeout(500);
  await scan(page, 'dish editor');

  await page.fill('#dishName', "Chef's Sisig & Rice");
  await page.fill('#dishCategory', 'Mains');
  await page.fill('#dishDescription', 'Crackling pork, calamansi, chilli');
  await page.fill('#dishPrice', '420');
  await page.fill('#dishEmoji', '🔥');
  await page.waitForTimeout(200);

  const hint = await page.locator('#dishPriceHint').textContent();
  check('the VAT inside the price is shown while typing',
    /₱420\.00/.test(hint) && /₱45\.00/.test(hint), hint.trim());

  await page.click('#dishSaveBtn');
  await page.waitForTimeout(1200);

  const added = page.locator('#menuRows .row').filter({ hasText: "Chef's Sisig & Rice" });
  check('the dish appears on the board', (await added.count()) === 1);
  check('an apostrophe and ampersand survive intact',
    (await added.locator('.rname').textContent()).includes("Chef's Sisig & Rice"));

  console.log('\nTHE CUSTOMER APP SEES IT');
  {
    const shop = await ctx.newPage();
    await shop.goto(BASE, { waitUntil: 'networkidle' });
    await shop.waitForTimeout(800);
    await shop.click('[data-nav="menu"]');
    await shop.waitForTimeout(400);
    // The app opens on the first category; the new dish is under Mains.
    await shop.locator('#menuTabs .tab', { hasText: 'Mains' }).click();
    await shop.waitForTimeout(400);
    const names = await shop.locator('#menuList h4').allTextContents();
    const prices = await shop.locator('#menuList .price').allTextContents();
    check('the new dish is on the customer menu', names.some(n => n.includes("Chef's Sisig & Rice")), names.join(' | '));
    check('at the price that was typed', prices.some(p => p.includes('₱420.00')), prices.join(' '));
    await shop.close();
  }

  console.log('\nCHANGING A PRICE');
  await added.locator('[data-edit-dish]').click();
  await page.waitForTimeout(500);
  await page.fill('#dishPrice', '455');
  await page.click('#dishSaveBtn');
  await page.waitForTimeout(1200);
  check('the new price shows on the board',
    (await page.locator('#menuRows .row').filter({ hasText: "Chef's Sisig & Rice" }).locator('.rprice').textContent()).includes('₱455.00'));

  const log = await page.locator('#changeLog').textContent();
  check('the change is recorded in the log', /price: 420 . 455/.test(log.replace(/\s+/g, ' ')));

  console.log('\nREORDERING');
  const firstMainsBefore = await page.locator('#menuRows .row').nth(0).locator('.rname').textContent();
  await page.locator('#menuRows .row').nth(1).locator('[data-move][data-dir="up"]').click();
  await page.waitForTimeout(1000);
  const firstMainsAfter = await page.locator('#menuRows .row').nth(0).locator('.rname').textContent();
  check('moving a dish up changes the order', firstMainsBefore.trim() !== firstMainsAfter.trim(),
    `${firstMainsBefore.trim()} → ${firstMainsAfter.trim()}`);

  console.log('\nREMOVING AND RESTORING');
  await added.locator('[data-dish-active][data-to="0"]').click();
  await page.waitForTimeout(1200);
  check('the dish is marked removed', (await added.textContent()).includes('Removed'));

  {
    const shop = await ctx.newPage();
    await shop.goto(BASE, { waitUntil: 'networkidle' });
    await shop.waitForTimeout(800);
    await shop.click('[data-nav="menu"]');
    await shop.waitForTimeout(400);
    // Check every category, not just the one showing.
    const tabs = await shop.locator('#menuTabs .tab').count();
    const seen = [];
    for (let t = 0; t < tabs; t++) {
      await shop.locator('#menuTabs .tab').nth(t).click();
      await shop.waitForTimeout(250);
      seen.push(...await shop.locator('#menuList h4').allTextContents());
    }
    check('customers stop seeing it immediately', !seen.some(n => n.includes('Sisig')));
    await shop.close();
  }

  await added.locator('[data-dish-active][data-to="1"]').click();
  await page.waitForTimeout(1200);
  check('restoring brings it back', !(await added.textContent()).includes('Removed'));

  console.log('\nWHAT THE SCREEN REFUSES');
  const rejects = [
    ['a script tag in the name', '<script>alert(1)</script>', 'Mains', '100'],
    ['an empty name', '', 'Mains', '100'],
    ['a negative price', 'Free Lunch', 'Mains', '-50'],
  ];
  for (const [label, name, category, price] of rejects) {
    await page.click('#addDishBtn');
    await page.waitForTimeout(400);
    await page.fill('#dishName', name);
    await page.fill('#dishCategory', category);
    await page.fill('#dishPrice', price);
    await page.click('#dishSaveBtn');
    await page.waitForTimeout(700);
    const shown = await page.locator('#dishError').isVisible();
    check(`refuses ${label}`, shown, shown ? (await page.locator('#dishError').textContent()).trim() : 'IT WAS ACCEPTED');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  console.log('\nCOURTS');
  await page.click('#addCourtBtn');
  await page.waitForTimeout(500);
  await page.fill('#courtName', "Rey's Court");
  await page.click('#courtSaveBtn');
  await page.waitForTimeout(1100);
  const reyCourt = page.locator('#courtRows .row').filter({ hasText: "Rey's Court" });
  check('a court with an apostrophe can be added', (await reyCourt.count()) === 1);

  await reyCourt.locator('[data-court-active][data-to="0"]').click();
  await page.waitForTimeout(1100);
  check('taking it out of service marks it', (await reyCourt.textContent()).includes('Out of service'));

  {
    const shop = await ctx.newPage();
    await shop.goto(BASE, { waitUntil: 'networkidle' });
    await shop.waitForTimeout(900);
    await shop.click('[data-nav="courts"]');
    await shop.waitForTimeout(700);
    const courts = await shop.locator('.court-title').allTextContents();
    check('customers stop seeing that court', !courts.some(c => c.includes("Rey's Court")), courts.join(' | '));
    await shop.close();
  }

  console.log('\nKEYBOARD AND FOCUS');
  await page.click('#addDishBtn');
  await page.waitForTimeout(500);
  const focused = await page.evaluate(() => document.activeElement.id || document.activeElement.className);
  check('focus moves into the dialog', /close-x|dishName/.test(focused), focused);

  const trapped = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    trapped.push(await page.evaluate(() => !!document.activeElement.closest('#dishOverlay')));
  }
  check('Tab stays inside the dialog', trapped.every(Boolean));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Escape closes the dialog', !(await page.locator('#dishOverlay').isVisible()));
  const back = await page.evaluate(() => document.activeElement.id);
  check('focus returns to the button that opened it', back === 'addDishBtn', back);

  console.log('\nSWITCHING BACK');
  await page.click('[data-view="service"]');
  await page.waitForTimeout(900);
  check('the service board comes back', await page.locator('#serviceView').isVisible());
  check('the management screen is put away', !(await page.locator('#manageView').isVisible()));

  check('no JavaScript errors anywhere', errors.length === 0, errors.join(' | '));

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error('FAILED:\n  ' + failed.map(f => f.label).join('\n  '));
    process.exit(1);
  }
})();
