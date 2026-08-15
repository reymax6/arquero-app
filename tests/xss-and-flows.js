const { chromium } = require('playwright');
const { BASE, plantAwkwardContent } = require('./fixtures');

// A dish named with a script payload, a court called "Rey's Court", and one
// called 'Court "4" & Co'. Planted straight into the database, because the
// API rightly refuses to let anyone create content like this.
plantAwkwardContent();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:414,height:860}, deviceScaleFactor:2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type()==='error') errors.push('CONSOLE: ' + m.text()); });
  page.on('dialog', async d => { errors.push('ALERT FIRED: ' + d.message()); await d.dismiss(); });

  await page.goto(BASE, { waitUntil:'networkidle' });
  await page.waitForTimeout(600);

  const R = {};

  // --- XSS ---
  R.xssNameFlag = await page.evaluate(() => window.__XSS_NAME || null);
  R.xssDescFlag = await page.evaluate(() => window.__XSS_DESC || null);
  R.injectedImgTags = await page.locator('#menuList img, .menu-item img').count();

  // --- apostrophe category tab ---
  await page.click('#screen-menu >> nothing').catch(()=>{});
  await page.click('[data-nav="menu"]');
  await page.waitForTimeout(300);
  R.tabLabels = await page.locator('#menuTabs .tab').allTextContents();
  const chefTab = page.locator('#menuTabs .tab', { hasText: "Chef's Picks" });
  R.chefTabFound = await chefTab.count();
  if (R.chefTabFound) {
    await chefTab.click();
    await page.waitForTimeout(250);
    R.chefTabSelected = await chefTab.getAttribute('aria-selected');
    R.dishesShown = await page.locator('#menuList h4').allTextContents();
  }

  // --- apostrophe court ---
  await page.click('[data-nav="courts"]');
  await page.waitForTimeout(500);
  R.courtTitles = await page.locator('.court-title').allTextContents();
  const reySlot = page.locator('.court-block', { hasText: "Rey's Court" }).locator('.slot:not([disabled])').first();
  R.reySlotText = await reySlot.textContent();
  await reySlot.click();
  await page.waitForTimeout(400);
  R.bookingSheetOpenedForApostropheCourt = await page.locator('#bookingOverlay.show').count() === 1;
  R.bookingPreview = (await page.locator('#bookingPreview').textContent()).replace(/\s+/g,' ').trim();

  // --- Escape closes the sheet ---
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  R.escapeClosedSheet = await page.locator('#bookingOverlay.show').count() === 0;

  // --- full booking flow on the apostrophe court ---
  await reySlot.click();
  await page.waitForTimeout(300);
  await page.fill('#bookName', "Rey O'Brien-Arquero");
  await page.fill('#bookPhone', '0917 555 0134');
  await page.click('#confirmBookingBtn');
  await page.waitForTimeout(900);
  R.bookingConfirmed = await page.locator('#bookingConfirmOverlay.show').count() === 1;
  R.bookingReceipt = (await page.locator('#bookingReceipt').textContent()).replace(/\s+/g,' ').trim();

  await page.click('#bookingConfirmOverlay [data-close-home]');
  await page.waitForTimeout(400);

  // --- order flow with the malicious dish ---
  await page.click('[data-nav="menu"]');
  await page.waitForTimeout(300);
  await chefTab.click();
  await page.waitForTimeout(250);
  await page.locator('#menuList .add-btn').first().click();
  await page.waitForTimeout(300);
  R.cartBadge = await page.locator('#cartBadge').textContent();
  await page.click('#cartBtn');
  await page.waitForTimeout(300);
  R.cartLineName = await page.locator('.cart-line h5').first().textContent();
  await page.click('#checkoutBtn');
  await page.waitForTimeout(300);

  // empty-name validation
  await page.click('#placeOrderBtn');
  await page.waitForTimeout(200);
  R.emptyNameBlocked = await page.locator('#orderNameField.invalid').count() === 1;
  R.emptyNameMsg = await page.locator('#orderNameErr').textContent();

  await page.fill('#orderName', '<script>window.__XSS_CUST=1</script>Maria Santos');
  await page.fill('#orderPhone', 'abc');
  await page.click('#placeOrderBtn');
  await page.waitForTimeout(200);
  R.badPhoneMsg = await page.locator('#orderPhoneErr').textContent();

  await page.fill('#orderPhone', '09171234567');
  await page.click('#placeOrderBtn');
  await page.waitForTimeout(900);
  R.orderConfirmed = await page.locator('#orderConfirmOverlay.show').count() === 1;
  R.orderReceipt = (await page.locator('#orderReceipt').textContent()).replace(/\s+/g,' ').trim();
  R.xssCustFlag = await page.evaluate(() => window.__XSS_CUST || null);

  R.errors = errors;
  console.log(JSON.stringify(R, null, 2));
  await browser.close();

  // Assert here rather than leaving the runner to interpret the JSON above.
  // A check that can only fail by someone reading its output isn't a check.
  const assertions = [
    ['no script ran from a dish name',        R.xssNameFlag === null],
    ['no script ran from a description',      R.xssDescFlag === null],
    ['no script ran from a customer name',    R.xssCustFlag === null],
    ['no injected tags reached the page',     R.injectedImgTags === 0],
    ['payload rendered as literal text',      /^<img src=x/.test(R.dishesShown[0] || '')],
    ["apostrophe category selects correctly", R.chefTabSelected === 'true'],
    ["apostrophe court can be booked",        R.bookingSheetOpenedForApostropheCourt && R.bookingConfirmed],
    ['Escape closes a sheet',                 R.escapeClosedSheet],
    ['empty name is blocked',                 R.emptyNameBlocked],
    ['an order completes',                    R.orderConfirmed],
    ['no unexpected JavaScript errors',       R.errors.length === 0],
  ];

  const failures = assertions.filter(([, ok]) => !ok).map(([label]) => label);
  if (failures.length) {
    console.error('\nFAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log(`\nAll ${assertions.length} assertions passed.`);
})();
