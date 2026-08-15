const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'test-secret-123';
const desc = p => p.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'BODY (bad)';
  return a.tagName.toLowerCase() + (a.id?'#'+a.id:'') + (a.getAttribute('aria-label')?` [${a.getAttribute('aria-label')}]`:'');
});
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({viewport:{width:414,height:860}})).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(BASE,{waitUntil:'networkidle'}); await p.waitForTimeout(700);

  console.log('A. Cancel a booking with Escape');
  await p.click('[data-nav="courts"]'); await p.waitForTimeout(600);
  await p.locator('.slot:not([disabled])').first().click(); await p.waitForTimeout(400);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  console.log('   focus ->', await desc(p));

  console.log('B. Complete a booking, then Escape the confirmation');
  await p.locator('.slot:not([disabled])').first().click(); await p.waitForTimeout(400);
  await p.fill('#bookName','Focus Two'); await p.fill('#bookPhone','09171234567');
  await p.click('#confirmBookingBtn'); await p.waitForTimeout(1100);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  console.log('   focus ->', await desc(p));

  console.log('C. Open cart, Escape');
  await p.click('[data-nav="menu"]'); await p.waitForTimeout(400);
  await p.locator('.add-btn').first().click(); await p.waitForTimeout(300);
  await p.click('#cartBtn'); await p.waitForTimeout(400);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  console.log('   focus ->', await desc(p));

  console.log('D. Cart -> checkout -> Escape');
  await p.click('#cartBtn'); await p.waitForTimeout(300);
  await p.click('#checkoutBtn'); await p.waitForTimeout(400);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  console.log('   focus ->', await desc(p));

  console.log('E. Complete an order, Back to Home');
  await p.click('#cartBtn'); await p.waitForTimeout(300);
  await p.click('#checkoutBtn'); await p.waitForTimeout(300);
  await p.fill('#orderName','Focus Three'); await p.fill('#orderPhone','09171234567');
  await p.click('#placeOrderBtn'); await p.waitForTimeout(1000);
  console.log('   confirmed:', await p.locator('#orderConfirmOverlay.show').count()===1);
  await p.click('#orderConfirmOverlay [data-close-home]'); await p.waitForTimeout(500);
  console.log('   on home:', await p.locator('#screen-home.active').count()===1, '| focus ->', await desc(p));
  console.log('\nJS errors:', errs.length?errs.join(' | '):'none');
  await b.close();
})();
