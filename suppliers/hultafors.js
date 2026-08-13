// Hultafors Group partner portal (partnerportal.hultaforsgroup.co.uk) — Snickers /
// Solid Gear / Hellberg. ASP.NET MVC where the CHECKOUT is a stateful, JS-button-driven
// flow that plain HTTP can't drive cleanly (antiforgery tokens + a paymentId→placeOrder
// handoff), so Playwright drives it: login → import the basket via the CSV import
// endpoints (in-page fetch on the authenticated session) → go to Checkout → set the PO
// number + invoice payment → (gated) proceed → place.
//
// Place-order chain (decoded from a real checkout HAR + the checkout JS 2026-08-13):
//   "Proceed to payment"  → POST Checkout/Summary → SummaryPayment   (summary, NOT a place)
//   #btnCheckout (frmPOS) → POST Checkout/CashOrCheckPaymentAsync    → returns a paymentId
//   checkPayment(id)      → GET  Payment/CheckPayment?paymentId=     → {BasketMsgAutoNo,TransNumber}
//   #btnPlaceOrder_<t>    → GET  Payment/ForceOrder?basketMsgAutoNo=&transactionId= → PLACES
// PO number field = #poNumber (name BasketHead.CustomerPurchaseOrderNo); payment = invoice.
//
// SAFETY: places ONLY via place() (execute:true). stage()/checkoutProbe() never submit.
// Lines: [{ stockCode|sku, qty }] — StockCode IS our BP Snickers SKU (e.g. 62189504100).

export const config = {
  base: process.env.HULTAFORS_BASE || 'https://partnerportal.hultaforsgroup.co.uk',
  envUser: 'HULTAFORS_USER',
  envPass: 'HULTAFORS_PASS',
};

// Some hops keep the same URL and churn through AJAX with no settling navigation, so
// waitForSelector couples to a never-ending load. Poll with page.$ instead.
async function pollFor(page, sel, { tries = 40, gap = 1500 } = {}) {
  for (let i = 0; i < tries; i++) { const el = await page.$(sel).catch(() => null); if (el) return el; await page.waitForTimeout(gap); }
  return null;
}

// Dismiss the cookie/consent modal if one is covering the page (it eats clicks).
// The widget is JS-injected and lives in an IFRAME on the login page, so a plain
// page.evaluate(document.querySelectorAll) can't reach it — use Playwright locators,
// which pierce iframes AND shadow DOM. Prefer the privacy-preserving choice (Decline
// all / Reject); fall back to Accept only if there's no decline. Last resort: hide any
// full-screen fixed overlay so the login button is clickable (grants no consent).
async function dismissConsent(page) {
  const names = [/decline all/i, /reject all/i, /only necessary/i, /^decline$/i, /accept all/i, /allow all/i];
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const frame of page.frames()) {
      for (const re of names) {
        // role=button covers <button>; the locator fallback covers <a>/<input> styled as buttons.
        const locs = [frame.getByRole('button', { name: re }), frame.locator('button, a, input[type=button], input[type=submit]').filter({ hasText: re })];
        for (const loc of locs) {
          const n = await loc.count().catch(() => 0);
          for (let i = 0; i < n; i++) {
            const b = loc.nth(i);
            if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 2500 }).catch(() => {}); await page.waitForTimeout(800); return re.source; }
          }
        }
      }
    }
    await page.waitForTimeout(1000);
  }
  // Fallback: remove any large fixed/absolute high-z overlay covering the page so clicks
  // land on the login form. This hides the banner without accepting cookies.
  await page.evaluate(() => {
    for (const e of document.querySelectorAll('body *')) {
      const s = getComputedStyle(e);
      if ((s.position === 'fixed' || s.position === 'absolute') && Number(s.zIndex) >= 1000) {
        const r = e.getBoundingClientRect();
        if (r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.3) e.style.display = 'none';
      }
    }
  }).catch(() => {});
  return 'overlay-hidden-fallback';
}

export async function login(page, { user, pass }) {
  await page.goto(`${config.base}/User/Login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await dismissConsent(page);           // banner covers the LOGIN button — must clear it first
  const userSel = 'input[name="User.UserName"]';
  const passSel = 'input[name="User.Password"]';
  if (await page.$(passSel)) {
    await page.fill(userSel, user).catch(() => {});
    await page.fill(passSel, pass).catch(() => {});
    await dismissConsent(page);          // re-clear in case it re-appeared after fill
    // Prefer the form's submit button; fall back to Enter in the password field.
    const btn = await page.$('#loginform button[type=submit], #loginform input[type=submit], button:has-text("Log in"), input[type=submit][value*="Log" i]');
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      btn ? btn.click().catch(() => {}) : page.press(passSel, 'Enter').catch(() => {}),
    ]);
    await page.waitForTimeout(1200);
  }
  // Logged in = the login form is gone (redirected to the portal home/dashboard).
  if (await page.$('#loginform')) {
    const diag = await page.evaluate(() => ({
      url: location.href,
      err: /invalid|incorrect|not recognised|failed|try again|locked/i.test(document.body.innerText),
      inputs: [...document.querySelectorAll('input')].filter((e) => !/^__/i.test(e.name || '')).map((e) => `${e.type}:${e.name || e.id}`).slice(0, 10),
    })).catch(() => ({}));
    throw new Error(`Hultafors login failed (user=${(user || '').slice(0, 3)}***) — ${JSON.stringify(diag)}`);
  }
}

// Import the order lines into the basket via the portal's CSV import endpoints, run
// INSIDE the authenticated page (cookies + same-origin auto). REPLACES the basket.
// Mirrors the proven HTTP sequence: EmptyBasket → BasketProductImport (multipart) →
// ValidateBasketProductImport → ProcessBasketProductImport (loop while HasMoreProcessing).
async function importBasket(page, lines, { clearFirst = true } = {}) {
  const csv = 'StockCode,Qty\n' + lines.map((l) => `${l.stockCode || l.sku},${l.qty}`).join('\n') + '\n';
  return page.evaluate(async ({ base, csv, clearFirst }) => {
    const flags = (t) => ({
      HasMoreProcessing: (String(t).match(/HasMoreProcessing"\s+value="(\w+)"/i) || [])[1] || 'False',
      HasInvalidLines: (String(t).match(/HasInvalidLines"\s+value="(\w+)"/i) || [])[1] || 'False',
      IsDone: (String(t).match(/IsDone"\s+value="(\w+)"/i) || [])[1] || 'False',
    });
    const steps = [];
    if (clearFirst) { try { await fetch(base + '/en/Checkout/EmptyBasket', { credentials: 'include' }).then((r) => r.text()); } catch (e) {} }
    const force = 'false';
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'order.csv');
    fd.append('forceUpload', force);
    let r = await fetch(base + '/en/cart/BasketProductImport', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: fd });
    let t = await r.text();
    let f = flags(t); steps.push({ name: 'upload', status: r.status, flags: f });
    const postForm = async (path, fl) => {
      const rr = await fetch(base + path, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ forceUpload: force, ...fl }).toString() });
      const tt = await rr.text(); return { status: rr.status, flags: flags(tt) };
    };
    let v = await postForm('/en/cart/ValidateBasketProductImport', f); steps.push({ name: 'validate', ...v }); f = v.flags;
    let guard = 0;
    do { const p = await postForm('/en/cart/ProcessBasketProductImport', f); steps.push({ name: 'process' + guard, ...p }); f = p.flags; guard++; }
    while (guard < 6 && /true/i.test(f.HasMoreProcessing) && !/true/i.test(f.IsDone));
    return { steps, finalFlags: f };
  }, { base: config.base, csv, clearFirst });
}

// Best-effort basket read from the Checkout DOM: line count + total quantity.
async function basketInfo(page) {
  return page.evaluate(() => {
    const num = (s) => { const m = String(s || '').match(/(\d[\d,]*)/); return m ? Number(m[1].replace(/,/g, '')) : null; };
    // qty inputs on the basket/checkout grid
    const qtyBoxes = [...document.querySelectorAll('input[name*="Quantity" i], input[id*="qty" i], input.qty')].filter((e) => e.offsetParent !== null);
    const qtySum = qtyBoxes.reduce((a, e) => a + (Number(e.value) || 0), 0);
    const rows = document.querySelectorAll('.basket-row, tr[class*="line" i], .cart-line, [class*="basketRow" i]').length;
    const totalTxt = (document.querySelector('[class*="totalQuantity" i], [id*="totalQuantity" i], .cart-count, #cart-count') || {}).textContent;
    return { qtyBoxes: qtyBoxes.length, qtySum, rows, totalText: num(totalTxt) };
  }).catch(() => ({}));
}

// Set the PO-number field (required at checkout) if present.
async function setPO(page, ref) {
  if (!ref) return { poSet: false, reason: 'no ref' };
  const sel = '#poNumber, input[name="BasketHead.CustomerPurchaseOrderNo"]';
  const el = await page.$(sel);
  if (!el) return { poSet: false, reason: 'poNumber field not on page' };
  await el.fill(String(ref).slice(0, 50)).catch(async () => {
    await page.evaluate((v) => { const e = document.querySelector('#poNumber, input[name="BasketHead.CustomerPurchaseOrderNo"]'); if (e) { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); e.dispatchEvent(new Event('blur', { bubbles: true })); } }, String(ref).slice(0, 50));
  });
  const val = await page.inputValue(sel).catch(() => '');
  return { poSet: !!val, value: val };
}

// Select the invoice/account payment option if the radio is present.
async function selectInvoicePayment(page) {
  const r = await page.$('.paymentOption[data-code="invoice"], input[name="paymentOption"][data-code="invoice"]');
  if (!r) return { paymentSelected: false, reason: 'invoice option not found' };
  await r.check().catch(() => r.click().catch(() => {}));
  await page.waitForTimeout(500);
  return { paymentSelected: true };
}

// stage: import the basket and get to a ready-to-place Checkout page (imports + PO + payment
// selected). NEVER places. Returns readiness + diagnostics.
export async function stage(page, { lines, keepBasket, purchaseOrder, ref } = {}) {
  const po = purchaseOrder || ref || null;
  const expectedUnits = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
  const imp = await importBasket(page, lines, { clearFirst: !keepBasket });
  const f = imp.finalFlags || {};
  const importOk = /true/i.test(f.IsDone) || !/true/i.test(f.HasMoreProcessing);
  const hasInvalid = /true/i.test(f.HasInvalidLines);

  // Go to the checkout page so the PO/payment controls render.
  await page.goto(`${config.base}/en/Checkout`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await dismissConsent(page);
  await page.waitForTimeout(1500);
  const cart = await basketInfo(page);
  const pay = await selectInvoicePayment(page);
  const poRes = await setPO(page, po);

  const cartUnits = cart.qtySum || cart.totalText || null;
  const ready = importOk && !hasInvalid && expectedUnits > 0 && (cartUnits == null || cartUnits === expectedUnits);
  const screenshot = ready ? null : `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
  return {
    imported: importOk, hasInvalidLines: hasInvalid, importSteps: imp.steps,
    expectedUnits, cart, payment: pay, po: poRes, checkoutUrl: page.url(), ready, screenshot,
  };
}

// Diagnostic: after staging, reveal the payment-step controls WITHOUT placing. Clicks
// "Proceed to payment" and dumps the buttons/ids that appear (so place() targets the right
// ones), then stops. Mirrors Sterling's checkoutProbe.
export async function checkoutProbe(page) {
  const dump = async (label) => ({
    label, url: page.url(), title: await page.title().catch(() => ''),
    buttons: await page.evaluate(() => [...document.querySelectorAll('button, input[type=submit], input[type=button], a.btn')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || '', name: e.name || '', txt: (e.value || e.innerText || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((c) => (c.txt || c.id) && c.w > 0).slice(0, 40)).catch(() => []),
  });
  const before = await dump('cart');
  // `/en/Checkout` is the CART page; advancing = CHECKOUT (#btnCheckout, text "CHECKOUT").
  // Click it once to reach the delivery/checkout page and map that — STOP there (no payment,
  // no place). This is plain navigation, well before any order-creating call.
  const co = await page.$('#btnCheckout');
  if (co) { await co.click().catch(() => {}); await page.waitForTimeout(4000); await page.waitForLoadState('domcontentloaded').catch(() => {}); }
  const after = await dump('after-checkout');
  const checkoutControls = await page.evaluate(() => ({
    url: location.href,
    hasPoNumber: !!document.querySelector('#poNumber, input[name="BasketHead.CustomerPurchaseOrderNo"]'),
    paymentOptions: [...document.querySelectorAll('.paymentOption')].map((e) => e.getAttribute('data-code')),
    proceedButtons: [...document.querySelectorAll('button, a, input[type=submit], input[type=button]')].map((e) => (e.innerText || e.value || '').trim()).filter((t) => /proceed|payment|continue|next|confirm|place order|submit/i.test(t)).slice(0, 12),
    btnCheckoutPresent: !!document.querySelector('#btnCheckout'),
    btnPlaceOrder: [...document.querySelectorAll('[id^="btnPlaceOrder_"]')].map((e) => e.id),
    deliverySelects: [...document.querySelectorAll('select')].map((e) => ({ id: e.id || '', name: e.name || '' })).filter((s) => /addr|deliv|ship/i.test(s.id + s.name)).slice(0, 6),
  })).catch(() => ({}));
  const screenshot = `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
  return { before, after, checkoutControls, screenshot };
}

// GATED placement. Runs the full chain: proceed → CashOrCheckPayment (#btnCheckout) →
// the site's JS polls CheckPayment and reveals #btnPlaceOrder → click it → ForceOrder.
// Only called by the worker when execute:true. Fire exactly once (index.js never retries).
export async function place(page, { ref } = {}) {
  page.on('dialog', (d) => d.accept().catch(() => {}));
  // Re-assert the PO (required) before proceeding.
  const poRes = await setPO(page, ref);

  // 1. Proceed to payment (summary → payment step). NOT a placement.
  const proceed = await page.$('button:has-text("Proceed to payment"), a:has-text("Proceed to payment"), input[value*="Proceed" i], #btnProceedToPayment');
  if (!proceed) throw new Error('"Proceed to payment" control not found on checkout');
  await proceed.click().catch(() => {});
  // 2. The payment step exposes #btnCheckout (submits frmPOS → CashOrCheckPaymentAsync).
  const checkoutBtn = await pollFor(page, '#btnCheckout', { tries: 30, gap: 1500 });
  if (!checkoutBtn) throw new Error('payment step (#btnCheckout) did not appear after Proceed to payment');
  await checkoutBtn.click().catch(() => {});
  // 3. The site's JS runs CashOrCheckPaymentAsync → CheckPayment → reveals #btnPlaceOrder_<t>.
  const placeBtn = await pollFor(page, '[id^="btnPlaceOrder_"]', { tries: 45, gap: 2000 });
  if (!placeBtn) {
    const status = await page.evaluate(() => [...document.querySelectorAll('[id^="statusText_"]')].map((e) => e.innerText).join(' | ')).catch(() => '');
    throw new Error(`Place Order button never appeared (payment check may have failed). status="${status}"`);
  }
  await page.waitForTimeout(500);
  // 4. Place — click #btnPlaceOrder → Payment/ForceOrder → status goes green ("3" / ok).
  await placeBtn.click().catch(() => {});
  let placed = false, statusText = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => {
      const st = [...document.querySelectorAll('[id^="statusText_"]')];
      const greens = st.filter((e) => /rgb\(0,\s*128,\s*0\)|green/i.test(getComputedStyle(e).color));
      const hid = [...document.querySelectorAll('[class*="hidStatus_"]')].map((e) => e.value);
      return { text: st.map((e) => e.innerText).join(' | '), green: greens.length, hid, gone: !document.querySelector('[id^="btnPlaceOrder_"]:not([style*="display: none"])') };
    }).catch(() => ({}));
    statusText = s.text || statusText;
    if ((s.green > 0) || (s.hid || []).some((v) => String(v) === '3') || /thank|placed|success|confirmed|received/i.test(statusText)) { placed = true; break; }
  }
  // Order number if the confirmation surfaces one.
  const orderNo = await page.evaluate(() => (document.body.innerText.match(/order\s*(?:no|number|confirmation)[^0-9]{0,12}(\d{4,})/i) || [])[1] || null).catch(() => null);
  const screenshot = placed ? null : `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
  return { placed, orderNo, url: page.url(), poSet: poRes.value || null, statusText: String(statusText).slice(0, 400), screenshot };
}
