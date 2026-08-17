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
  if (await page.$(passSel).catch(() => null)) {
    await page.fill(userSel, user).catch(() => {});
    await page.fill(passSel, pass).catch(() => {});
    await dismissConsent(page);          // re-clear in case it re-appeared after fill
    // Prefer the form's submit button; fall back to Enter in the password field.
    const btn = await page.$('#loginform button[type=submit], #loginform input[type=submit], button:has-text("Log in"), input[type=submit][value*="Log" i]').catch(() => null);
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      btn ? btn.click().catch(() => {}) : page.press(passSel, 'Enter').catch(() => {}),
    ]);
    // Wait out the post-login redirect BEFORE reading the page, else page.$ throws
    // "Execution context was destroyed" mid-navigation.
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2500);
  }
  // Logged in = the login form is gone (redirected to the portal home/dashboard).
  if (await page.$('#loginform').catch(() => null)) {
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
    // Per-line prices + the cart's total COST, for the backend's price check (BP cost vs what
    // Hultafors will actually invoice). Parsed defensively: anything unrecognised comes back
    // null/[] and NEVER feeds `ready` — the unit-count gate stays the only placement guard.
    const money = (s) => { const m = String(s || '').match(/(\d[\d,]*\.\d{2})/); return m ? Number(m[1].replace(/,/g, '')) : null; };
    const bodyTxt = (document.body && document.body.innerText || '').replace(/ /g, ' ');
    const tm = bodyTxt.match(/Total cost:\s*([\d,]+\.\d{2})/i) || bodyTxt.match(/TOTAL:\s*([\d,]+\.\d{2})/i);
    const totalCost = tm ? Number(tm[1].replace(/,/g, '')) : null;
    // Grid row = any <tr> carrying a qty input. Column order is code · description · del.date ·
    // unit price · list price less discount · qty · line sum, so the first money value on the row
    // is the unit price we pay and the last is the line total (the date has no decimals, so it
    // can't be mistaken for money).
    const lines = [...document.querySelectorAll('tr')].map((tr) => {
      const q = tr.querySelector('input[name*="Quantity" i], input[id*="qty" i], input.qty');
      if (!q || tr.offsetParent === null) return null;
      const txt = (tr.innerText || '').replace(/ /g, ' ');
      const code = (txt.match(/\b[A-Z0-9][A-Z0-9-]{4,}\b/) || [])[0] || null;
      const ms = [...txt.matchAll(/(\d[\d,]*\.\d{2})/g)].map((m) => Number(m[1].replace(/,/g, '')));
      return { code, qty: Number(q.value) || 0, unit: ms.length ? ms[0] : null, sum: ms.length ? ms[ms.length - 1] : null };
    }).filter(Boolean);
    return { qtyBoxes: qtyBoxes.length, qtySum, rows, totalText: num(totalTxt), totalCost, lines };
  }).catch(() => ({}));
}

// Set the PO-number field (required at checkout) if present.
async function setPO(page, ref) {
  if (!ref) return { poSet: false, reason: 'no ref' };
  const sel = '#poNumber, input[name="BasketHead.CustomerPurchaseOrderNo"]';
  const el = await page.$(sel).catch(() => null);
  if (!el) return { poSet: false, reason: 'poNumber field not on page' };
  await el.fill(String(ref).slice(0, 50)).catch(async () => {
    await page.evaluate((v) => { const e = document.querySelector('#poNumber, input[name="BasketHead.CustomerPurchaseOrderNo"]'); if (e) { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); e.dispatchEvent(new Event('blur', { bubbles: true })); } }, String(ref).slice(0, 50));
  });
  const val = await page.inputValue(sel).catch(() => '');
  return { poSet: !!val, value: val };
}

// Select the invoice/account payment option if the radio is present.
async function selectInvoicePayment(page) {
  const r = await page.$('.paymentOption[data-code="invoice"], input[name="paymentOption"][data-code="invoice"]').catch(() => null);
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

  // Go to the checkout page so the PO/payment controls render. The cart page can
  // client-side re-render right after load, which destroys the execution context mid-read
  // ("Execution context was destroyed") — so settle, then read with a retry.
  await page.goto(`${config.base}/en/Checkout`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await dismissConsent(page);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2500);
  let cart = {}, pay = {}, poRes = {};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      cart = await basketInfo(page);
      pay = await selectInvoicePayment(page);
      poRes = await setPO(page, po);
      break;
    } catch (e) { poRes = { poSet: false, reason: 'read retry: ' + e.message }; await page.waitForTimeout(2500); }
  }

  const cartUnits = cart.qtySum || cart.totalText || null;
  const ready = importOk && !hasInvalid && expectedUnits > 0 && (cartUnits == null || cartUnits === expectedUnits);
  const screenshot = ready ? null : `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
  return {
    imported: importOk, hasInvalidLines: hasInvalid, importSteps: imp.steps,
    expectedUnits, cart, payment: pay, po: poRes, checkoutUrl: page.url(), ready, screenshot,
  };
}

// The Hultafors checkout is a fixed accordion, each step advanced by a STABLE button id
// (mapped live 2026-08-13):
//   cart --#btnCheckout--> step1 (address; PO here) --#btnDelivery--> delivery
//   --#btnPayment--> payment (invoice) --#btnSummary("NEXT")--> summary
//   --#btnConfirm("Confirm")--> PLACED.  #btnConfirm is the only irreversible click.
const WIZARD_ADVANCE = ['#btnDelivery', '#btnPayment', '#btnSummary'];
const CONFIRM_SEL = '#btnConfirm';

// Click a button by id if it's visible; JS-click fallback. Returns whether it clicked.
async function clickId(page, sel, waitMs = 3500) {
  const el = await page.$(sel).catch(() => null);
  if (!el || !(await el.isVisible().catch(() => false))) return false;
  await el.click({ timeout: 6000 }).catch(async () => { await page.evaluate((s) => document.querySelector(s)?.click(), sel).catch(() => {}); });
  await page.waitForTimeout(waitMs);
  return true;
}

// A snapshot of the current wizard step: url + visible buttons + PO field + payment options.
async function snapStep(page, label) {
  const s = await page.evaluate(() => ({
    url: location.href,
    buttons: [...document.querySelectorAll('button, a, input[type=submit], input[type=button]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map((e) => ({ id: e.id || '', txt: (e.innerText || e.value || '').trim().slice(0, 28) })).filter((b) => b.txt || b.id).slice(0, 24),
    hasPO: !!document.querySelector('#poNumber'),
    payOptions: [...document.querySelectorAll('.paymentOption')].map((e) => e.getAttribute('data-code')),
  })).catch(() => ({}));
  return { label, ...s };
}

// Walk cart → summary: CHECKOUT, set PO, then click each advance button in turn (selecting
// invoice along the way). STOPS at the summary step, before #btnConfirm. Returns the trail.
async function walkToConfirm(page, ref) {
  const trail = [];
  trail.push((await clickId(page, '#btnCheckout')) ? 'checkout' : 'checkout(missing)');
  const poRes = await setPO(page, ref);
  for (const sel of WIZARD_ADVANCE) {
    const ok = await clickId(page, sel);
    trail.push(sel + (ok ? '' : '(missing)'));
    await selectInvoicePayment(page).catch(() => {});
  }
  const atConfirm = !!(await page.$(CONFIRM_SEL));
  return { trail, poRes, atConfirm };
}

// Diagnostic: walk the wizard to the SUMMARY step and dump it — STOPPING before #btnConfirm.
// Sets the PO along the way. Never places.
export async function checkoutProbe(page, { ref } = {}) {
  const cart = await snapStep(page, 'cart');
  const w = await walkToConfirm(page, ref || 'PROBE-PO');
  const summary = await snapStep(page, 'summary');
  const screenshot = `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
  return { cart, trail: w.trail, poSet: w.poRes, atConfirm: w.atConfirm, summary, screenshot };
}

// GATED placement. Walks the wizard to the summary, then clicks #btnConfirm — the single
// irreversible step. Only runs on execute:true; fire exactly once (index.js never retries).
export async function place(page, { ref } = {}) {
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const w = await walkToConfirm(page, ref);
  if (!w.atConfirm) {
    const shot = `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
    return { placed: false, error: 'did not reach the Confirm step', trail: w.trail, poSet: w.poRes.value || null, url: page.url(), screenshot: shot };
  }
  // FINAL, irreversible: click Confirm.
  await clickId(page, CONFIRM_SEL, 2500);
  // Verify: order confirmation surfaced (text or URL), or the Confirm button is gone.
  let placed = false, statusText = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 4000), url: location.href, confirmGone: !document.querySelector('#btnConfirm') })).catch(() => ({}));
    statusText = s.text || statusText;
    if (/order\s*confirmation|thank you|your order (has been|is) (placed|received|confirmed)|order (number|complete|received|placed)|orderconfirm|receipt/i.test(statusText) || /confirmation|receipt|thankyou|orderplaced|ordercomplete/i.test(s.url || '')) { placed = true; break; }
  }
  const orderNo = (String(statusText).match(/order\s*(?:no|number|confirmation)[^0-9]{0,12}(\d{4,})/i) || [])[1] || null;
  const screenshot = placed ? null : `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
  return { placed, orderNo, trail: w.trail, url: page.url(), poSet: w.poRes.value || null, statusText: String(statusText).replace(/\s+/g, ' ').slice(0, 400), screenshot };
}
