const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'test-secret-123';
const AxeBuilder = require('@axe-core/playwright').default;

const TAGS = ['wcag2a','wcag2aa','wcag21a','wcag21aa'];

async function scan(page, label) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const v = r.violations;
  if (!v.length) { console.log(`  ${label.padEnd(26)} clean`); return 0; }
  console.log(`  ${label.padEnd(26)} ${v.length} violation type(s)`);
  v.forEach(x => {
    console.log(`     [${x.impact}] ${x.id} — ${x.help} (${x.nodes.length} node${x.nodes.length>1?'s':''})`);
    x.nodes.slice(0,3).forEach(n => console.log(`        ${n.target.join(' ')}`));
    if (x.id === 'color-contrast') x.nodes.slice(0,4).forEach(n => console.log(`        ${(n.any[0]&&n.any[0].message||'').replace(/\s+/g,' ')}`));
  });
  return v.length;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:414,height:860} });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil:'networkidle' });
  await page.waitForTimeout(700);
  let total = 0;

  console.log('SCREENS');
  for (const s of ['home','menu','courts','gallery','contact']) {
    await page.click(`[data-nav="${s}"]`);
    await page.waitForTimeout(450);
    total += await scan(page, s);
  }

  console.log('\nSHEETS');
  await page.click('[data-nav="menu"]'); await page.waitForTimeout(300);
  await page.locator('.add-btn').first().click(); await page.waitForTimeout(300);
  await page.click('#cartBtn'); await page.waitForTimeout(400);
  total += await scan(page, 'cart (with an item)');

  await page.click('#checkoutBtn'); await page.waitForTimeout(400);
  total += await scan(page, 'checkout form');
  await page.click('#placeOrderBtn'); await page.waitForTimeout(300);
  total += await scan(page, 'checkout with errors');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);

  await page.click('[data-nav="courts"]'); await page.waitForTimeout(600);
  await page.locator('.slot:not([disabled])').first().click(); await page.waitForTimeout(400);
  total += await scan(page, 'booking form');
  await page.fill('#bookName','Ana Cruz'); await page.fill('#bookPhone','09171234567');
  await page.click('#confirmBookingBtn'); await page.waitForTimeout(900);
  total += await scan(page, 'booking confirmation');

  console.log('\nTOTAL violation types across all states:', total);

  // Touch targets
  console.log('\nTOUCH TARGETS (smallest interactive elements)');
  await page.click('#bookingConfirmOverlay [data-close-home]'); await page.waitForTimeout(500);
  const small = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('button, a, input, select, [tabindex="0"]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      if (r.width < 44 || r.height < 44) {
        out.push(`${el.tagName.toLowerCase()}.${(el.className||'').toString().split(' ')[0]} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    });
    return [...new Set(out)];
  });
  console.log(small.length ? small.map(s=>'  '+s).join('\n') : '  every visible control is at least 44x44');

  // Zoom
  const vp = await page.evaluate(() => document.querySelector('meta[name=viewport]').content);
  console.log('\nVIEWPORT:', vp);
  console.log('pinch-zoom blocked:', /maximum-scale|user-scalable\s*=\s*no/.test(vp));

  await browser.close();
})();
