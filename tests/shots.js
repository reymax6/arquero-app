const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'test-secret-123';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport:{width:414,height:860}, deviceScaleFactor:2 });
  const p = await ctx.newPage();
  await p.goto(BASE,{waitUntil:'networkidle'});
  await p.evaluate(()=>document.fonts.ready); await p.waitForTimeout(900);
  const shot = async (n) => { await p.evaluate(()=>{window.scrollTo(0,0);document.getElementById('screens').scrollTop=0;}); await p.waitForTimeout(350); await p.screenshot({path:`./shots/${n}.png`}); };

  await shot('01-home');
  await p.click('[data-nav="menu"]'); await p.waitForTimeout(500); await shot('02-menu');
  await p.click('[data-nav="courts"]'); await p.waitForTimeout(700);
  // jump to the day that has bookings
  const idx = await p.evaluate(()=>{const c=[...document.querySelectorAll('.date-chip')];return c.findIndex(x=>/16/.test(x.querySelector('.dnum').textContent))});
  if (idx>-1){ await p.locator('.date-chip').nth(idx).click(); await p.waitForTimeout(700); }
  await shot('03-courts');
  await p.locator('.slot:not([disabled])').first().click(); await p.waitForTimeout(500); await p.screenshot({path:'./shots/04-booking.png'});
  await p.fill('#bookName','Ana Reyes'); await p.fill('#bookPhone','0917 555 0134');
  await p.click('#confirmBookingBtn'); await p.waitForTimeout(1100);
  await p.screenshot({path:'./shots/05-booking-confirmed.png'});
  await p.click('#bookingConfirmOverlay [data-close-home]'); await p.waitForTimeout(500);

  await p.click('[data-nav="menu"]'); await p.waitForTimeout(400);
  for (let i=0;i<2;i++){ await p.locator('.add-btn').nth(i).click(); await p.waitForTimeout(250); }
  await p.click('#cartBtn'); await p.waitForTimeout(500); await p.screenshot({path:'./shots/06-cart.png'});
  await p.click('#checkoutBtn'); await p.waitForTimeout(400);
  await p.click('#placeOrderBtn'); await p.waitForTimeout(300);
  await p.screenshot({path:'./shots/07-checkout-errors.png'});
  await p.fill('#orderName','Ana Reyes'); await p.fill('#orderPhone','0917 555 0134');
  await p.click('#placeOrderBtn'); await p.waitForTimeout(1100);
  await p.screenshot({path:'./shots/08-order-confirmed.png'});
  await p.click('#orderConfirmOverlay [data-close-home]'); await p.waitForTimeout(400);

  await p.click('[data-nav="gallery"]'); await p.waitForTimeout(500); await shot('09-gallery');
  await p.click('[data-nav="contact"]'); await p.waitForTimeout(500); await shot('10-contact');

  // focus ring proof
  await p.click('[data-nav="courts"]'); await p.waitForTimeout(600);
  await p.evaluate(()=>document.querySelector('.slot:not([disabled])').focus());
  await p.waitForTimeout(300); await p.screenshot({path:'./shots/11-focus-ring.png'});
  await b.close();
})();
