const { chromium } = require('playwright');
const { BASE, ADMIN_PW, seedDayOfService } = require('./fixtures');
const AxeBuilder = require('@axe-core/playwright').default;
const TAGS = ['wcag2a','wcag2aa','wcag21a','wcag21aa'];

async function scan(page, label){
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  if (!r.violations.length){ console.log(`  ${label.padEnd(24)} clean`); return 0; }
  console.log(`  ${label.padEnd(24)} ${r.violations.length} violation type(s)`);
  r.violations.forEach(v=>{
    console.log(`     [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length})`);
    v.nodes.slice(0,3).forEach(n=>console.log(`        ${n.target.join(' ')}  ${(n.any[0]&&n.any[0].message||'').replace(/\s+/g,' ').slice(0,110)}`));
  });
  return r.violations.length;
}

(async () => {
  // Place real orders and bookings through the public API first, so the
  // board has a genuine day of service to display.
  const seeded = await seedDayOfService();
  console.log(`seeded ${seeded.orderIds.length} orders and ${seeded.bookingsPlaced} bookings for ${seeded.date}\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:1280,height:900} });
  const page = await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  // The board asks /api/admin/me on load and again after logging out; a 401
  // there is the correct answer, not a fault. Chrome logs every failed fetch
  // to the console regardless, so filter those out rather than counting them.
  const EXPECTED = /401 \(Unauthorized\)/;
  page.on('console',m=>{
    if (m.type()==='error' && !EXPECTED.test(m.text())) errs.push('console: '+m.text());
  });
  page.on('dialog', d => d.accept());
  let total = 0;

  await page.goto(BASE + '/admin',{waitUntil:'networkidle'});
  await page.waitForTimeout(700);

  console.log('LOGIN');
  console.log('  login screen shown:', await page.locator('#loginView').isVisible());
  console.log('  board hidden      :', !(await page.locator('#boardView').isVisible()));
  total += await scan(page,'login screen');

  await page.fill('#password','wrong-password');
  await page.click('#loginBtn'); await page.waitForTimeout(700);
  console.log('  wrong password    :', (await page.locator('#loginError').textContent()).trim());
  total += await scan(page,'login with error');

  await page.fill('#password',ADMIN_PW);
  await page.click('#loginBtn'); await page.waitForTimeout(1200);
  console.log('  logged in         :', await page.locator('#boardView').isVisible());
  console.log('  signed in as      :', (await page.locator('#staffName').textContent()).trim());

  console.log('\nBOARD');
  console.log('  date         :', (await page.locator('#dateLabel').textContent()).trim(), '|', (await page.locator('#dateRel').textContent()).trim());
  console.log('  stats        :', (await page.locator('#stats').allTextContents())[0].replace(/\s+/g,' ').trim());
  console.log('  order cards  :', await page.locator('#ordersList .card').count());
  console.log('  booking cards:', await page.locator('#bookingsList .card').count());
  console.log('  statuses     :', (await page.locator('.chip').allTextContents()).join(', '));
  total += await scan(page,'board with data');

  console.log('\nACTIONS');
  // Track one specific order by its reference, since advancing it re-sorts the queue.
  const fresh = page.locator('#ordersList .card').filter({ hasText: 'RECEIVED' }).first();
  const ref = (await fresh.locator('.ref').textContent()).trim();
  const card = () => page.locator('#ordersList .card').filter({ hasText: ref });
  for (const step of ['preparing','ready','collected']) {
    await card().locator('.btn-primary').click();
    await page.waitForTimeout(800);
    console.log(`  ${ref} -> ${(await card().locator('.chip').textContent()).trim()}`);
  }
  const positions = await page.locator('#ordersList .card .ref').allTextContents();
  console.log('  finished order sank to the bottom:', positions[positions.length-1].trim() === ref);
  console.log('  screen-reader announcement       :', (await page.locator('#srStatus').textContent()).trim());

  const firstBooking = page.locator('#bookingsList .card').filter({hasText:'Booked'}).first();
  console.log('  booking before    :', await firstBooking.locator('.chip').textContent());
  await firstBooking.locator('.btn-primary').click();
  await page.waitForTimeout(900);
  console.log('  bookings arrived  :', (await page.locator('#bookingsList .chip').allTextContents()).filter(t=>t==='Arrived').length);

  console.log('\nCANCEL A BOOKING (frees the slot)');
  const cancelBtn = page.locator('#bookingsList .card').filter({hasText:'Booked'}).first().locator('.btn-danger');
  const beforeCancel = await page.locator('#bookingsList .card').count();
  await cancelBtn.click(); await page.waitForTimeout(1000);
  console.log('  cards still listed:', await page.locator('#bookingsList .card').count(), '(cancelled stays as history)');
  console.log('  cancelled chips   :', (await page.locator('#bookingsList .chip').allTextContents()).filter(t=>t==='Cancelled').length);

  console.log('\nDATE NAVIGATION');
  await page.click('#prevDay'); await page.waitForTimeout(800);
  console.log('  previous day :', (await page.locator('#dateRel').textContent()).trim(), '|', (await page.locator('#ordersList').textContent()).replace(/\s+/g,' ').trim().slice(0,44));
  total += await scan(page,'empty day');
  await page.click('#todayBtn'); await page.waitForTimeout(800);
  console.log('  back to today:', (await page.locator('#dateRel').textContent()).trim());

  console.log('\nLOG OUT');
  await page.click('#logoutBtn'); await page.waitForTimeout(800);
  console.log('  login screen back:', await page.locator('#loginView').isVisible());
  await page.reload({waitUntil:'networkidle'}); await page.waitForTimeout(800);
  console.log('  still logged out after reload:', await page.locator('#loginView').isVisible());

  console.log('\nTOTAL axe violations:', total);
  console.log('JS errors:', errs.length?errs.join(' | '):'none');
  await browser.close();
})();
