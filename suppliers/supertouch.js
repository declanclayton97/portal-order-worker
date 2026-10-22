// Supertouch (supertouch.com) — LOGIN PROBE ONLY, for now. Supertouch told Dec on 2026-10-22 that
// ordering through a headless browser is fine by them (they do not take emailed POs).
//
// The site moved off Magento (July's attempt died on an invisible reCAPTCHA at login) onto
// Shopblocks / Symphony Commerce. On the new login form the only captcha widgets belong to the
// contact and newsletter forms; the Login button carries a `requires-captcha-modal` class with no
// handler wired to it. So this tries a plain login. If Supertouch's captcha ever stops it, the fix is
// on their side (exempt our account or the worker's IPs) — this module never tries to get round one.
//
// The form has two honeypot fields (`686f6e6579706f74`, `contact_me_by_fax_only`); a person never
// fills them and neither do we.

export const config = {
  base: process.env.SUPERTOUCH_BASE || 'https://www.supertouch.com',
  envUser: 'SUPERTOUCH_USER',
  envPass: 'SUPERTOUCH_PASS',
};

const BASE = config.base;
const text = async (page, n = 400) => ((await page.evaluate(() => document.body.innerText).catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, n);

// Logged in = the page offers a way out (logout link) or the account area, and the password box is gone.
async function loggedIn(page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '');
    const out = links.some((h) => /logout|log-out|sign-out/i.test(h));
    const pw = !!document.querySelector('#customerPassword');
    return { logoutLink: out, passwordBoxShown: pw };
  }).catch(() => ({ logoutLink: false, passwordBoxShown: true }));
}

export async function login(page, { user, pass }) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // The cookie banner covers the Login button. Answer it the privacy-preserving way: "Let me choose",
  // leave the optional boxes unticked (only strictly-necessary is pre-ticked), "Confirm my choices".
  // The banner is drawn by script after DOMContentLoaded, so wait for it rather than glance once.
  await page.locator('.cookie-pop-up-wrapper').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  if (await page.locator('#let-me-choose').isVisible().catch(() => false)) {
    await page.click('#let-me-choose').catch(() => {});
    for (const n of ['performance_and_analytics', 'functional', 'advertising']) await page.uncheck(`input.cookie-checkbox[name="${n}"]`).catch(() => {});
    await page.click('#cookie-confirm-choices').catch(() => {});
    await page.locator('.cookie-pop-up-wrapper').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
  // "Welcome to Our New Portal" notice (popup-modal on-page-load) shows on every visit and covers the
  // form. Close it with its ×; never follow its Recreate Password button.
  const notice = page.locator('.popup-modal.on-page-load');
  await notice.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await notice.first().isVisible().catch(() => false)) {
    const closeBtn = notice.locator('.popup-modal__close-btn').first();
    await closeBtn.click({ timeout: 5000 }).catch(() => page.keyboard.press('Escape').catch(() => {}));
    await notice.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
  await page.check('#returning_customer').catch(() => {});
  await page.fill('#customerEmail', user);
  await page.fill('#customerPassword', pass);
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {}),
    page.click('#login-form button[name="login"]'),
  ]);
  await page.waitForTimeout(3000);
  const state = await loggedIn(page);
  const captchaShown = await page.evaluate(() => !!document.querySelector('iframe[src*="recaptcha"][title*="challenge"], .modal.in iframe[src*="recaptcha"]')).catch(() => false);
  page.__supertouchLogin = { ...state, captchaShown, url: page.url() };
  if (!state.logoutLink) {
    throw new Error(`Supertouch login did not complete (at ${page.url()}; captcha shown: ${captchaShown}). Page said: ${await text(page, 300)}`);
  }
  return page.__supertouchLogin;
}

// opts.inspect — after login, report what the account sees: where we landed, and whether the
// basket and bulk/quick-order tools exist. Read-only: opens pages, submits nothing.
export async function inspect(page) {
  const landed = page.__supertouchLogin || {};
  const tools = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].map((a) => ({ t: (a.innerText || '').trim().slice(0, 40), h: a.getAttribute('href') }));
    const pick = (re) => links.filter((l) => re.test(l.h || '') || re.test(l.t)).slice(0, 6);
    return {
      basket: pick(/basket|cart/i),
      quickOrder: pick(/quick|bulk|upload|csv|order pad|fast order/i),
      account: pick(/account|orders|order history/i),
    };
  }).catch(() => ({}));
  return { landed, tools, pageSaid: await text(page, 500) };
}



// opts.explore — READ-ONLY map of the pages the order flow will need: the Quick Order control, the
// basket, a search for one code, and the Sales Orders list. Returns trimmed form/input/button markup.
// Adds nothing to the basket and submits no form.
export async function explore(page, { codes = [] } = {}) {
  const grab = async (label) => page.evaluate((label) => {
    const pick = (sel, n) => [...document.querySelectorAll(sel)].slice(0, n).map((e) => e.outerHTML.replace(/\s+/g, ' ').slice(0, 400));
    return {
      label, url: location.href, title: document.title,
      forms: [...document.querySelectorAll('form')].map((f) => ({ id: f.id, action: f.getAttribute('action'), method: f.method, cls: f.className.slice(0, 80),
        inputs: [...f.querySelectorAll('input,select,textarea,button')].slice(0, 25).map((i) => `${i.tagName.toLowerCase()} name=${i.name || ''} id=${i.id || ''} type=${i.type || ''} cls=${(i.className || '').slice(0, 50)} val=${(i.value || '').slice(0, 30)}`) })).slice(0, 12),
      quick: pick('[class*="quick" i], [id*="quick" i], [data-target*="quick" i]', 8),
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
    };
  }, label).catch((e) => ({ label, error: String(e.message || e) }));
  const out = [];
  out.push(await grab('dashboard'));
  await page.goto(`${BASE}/basket`, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500);
  out.push(await grab('basket'));
  for (const c of codes.slice(0, 2)) {
    await page.goto(`${BASE}/search?q=${encodeURIComponent(c)}`, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500);
    const s = await grab(`search ${c}`);
    s.productLinks = await page.evaluate(() => [...document.querySelectorAll('a[href*="/product"]')].slice(0, 6).map((a) => a.getAttribute('href'))).catch(() => []);
    out.push(s);
    if (s.productLinks && s.productLinks[0]) {
      await page.goto(new URL(s.productLinks[0], BASE).href, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500);
      out.push(await grab(`product ${c}`));
    }
  }
  await page.goto(`${BASE}/account/pages/sales-orders`, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(3000);
  out.push(await grab('sales-orders'));
  return { pages: out };
}

// ── Basket (Quick Order = the bulk-add form: rows of identifier[] + quantity[]) ─────────────────
// SAFETY: the basket belongs to the account, and staff use the same login. stage() refuses to touch a
// basket that already holds anything, so "empty the basket" afterwards can only ever remove our lines.
async function basketState(page) {
  await page.goto(`${BASE}/basket`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
    const m = txt.match(/Your Basket\s+(\d+)\s+Items?/i);
    const rows = [...document.querySelectorAll('tr, .basket-item, [class*="basket-row" i], [class*="basket__item" i]')]
      .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()).filter((t) => t && /£/.test(t)).slice(0, 60);
    const money = (re) => { const x = txt.match(re); return x ? Number(x[1].replace(/,/g, '')) : null; };
    return {
      items: m ? Number(m[1]) : null, empty: /Your basket is empty/i.test(txt), rows,
      subtotal: money(/Subtotal\s+£([\d,.]+)/i), delivery: money(/Delivery\s+£([\d,.]+)/i), total: money(/Total\s+£([\d,.]+)/i),
      html: (document.querySelector('form') ? '' : '') + ([...document.querySelectorAll('table')].map((t) => t.outerHTML.replace(/\s+/g, ' ')).join('\n').slice(0, 6000)),
    };
  });
}

async function quickAdd(page, lines, opts = {}) {
  const form = page.locator('form.bulk-add-to-basket').first();
  await form.waitFor({ state: 'attached', timeout: 15000 });
  const block = page.locator('.bulk-add-to-basket-row');
  // Fill each row, then BLUR it: the site's own validateRow (on blur) looks the code up for an EXACT
  // sku match and checks stock, and only rows it marks .valid are sent by its submit().
  for (let i = 0; i < lines.length; i++) {
    let rows = await form.locator('input[name="identifier[]"]').count();
    while (rows <= i) { await form.locator('button.add-new-row').first().evaluate((b) => b.click()); await page.waitForTimeout(200); rows = await form.locator('input[name="identifier[]"]').count(); }
    await form.locator('input[name="quantity[]"]').nth(i).evaluate((el, v) => { el.value = v; }, String(lines[i].qty));
    await form.locator('input[name="identifier[]"]').nth(i).evaluate((el, v) => { el.value = v; window.jQuery(el).trigger('blur'); }, String(lines[i].code));
  }
  // Wait for every row to settle (valid, or showing a reason), up to 20s.
  const t0 = Date.now(); let status = [];
  while (Date.now() - t0 < 20000) {
    status = await page.evaluate(() => [...document.querySelectorAll('form.bulk-add-to-basket .bulk-add-to-basket-row')].map((r) => ({
      code: (r.querySelector('input[name="identifier[]"], select') || {}).value || '', valid: r.classList.contains('valid'),
      sku: r.dataset.sku || null, skuKeyword: r.dataset.skuKeyword || null, qty: r.dataset.qty || null,
      msg: ((r.querySelector('.bulk-add-to-basket-status-box') || {}).innerText || '').trim().slice(0, 120),
      busy: !!r.querySelector('.fa-spin'), multiple: !!r.querySelector('.bulk-add-to-basket-multiple-options'),
    })).filter((x) => x.code));
    if (status.length >= lines.length && status.every((x) => !x.busy)) break;
    await page.waitForTimeout(500);
  }
  const notValid = status.filter((x) => !x.valid);
  let skipped = [];
  if (notValid.length) {
    if (!opts.skipInvalid) return { submitted: false, status, refused: 'rows-not-valid' };
    // Remove the rejected rows (their reason is in status[].msg), keep the valid ones.
    skipped = notValid.map((x) => ({ code: x.code, reason: x.msg || 'not accepted by Supertouch (no stock / not found)' }));
    for (const x of notValid) {
      await page.evaluate((code) => { const r = [...document.querySelectorAll('form.bulk-add-to-basket .bulk-add-to-basket-row')].find((row) => ((row.querySelector('input[name="identifier[]"]') || {}).value || '') === code); const b = r && r.querySelector('button.remove-row'); if (b) b.click(); else if (r) r.remove(); }, x.code);
      await page.waitForTimeout(300);
    }
    if (!status.some((x) => x.valid)) return { submitted: false, status, skipped, refused: 'no-valid-rows' };
  }
  const responses = [];
  const onResp = async (r) => { if (/bulk_add_to_basket/i.test(r.url())) responses.push({ url: r.url(), status: r.status(), body: (await r.text().catch(() => '')).slice(0, 800) }); };
  page.on('response', onResp);
  await form.evaluate((f) => window.jQuery(f).trigger('submit'));
  await page.waitForTimeout(6000);
  page.off('response', onResp);
  return { submitted: true, status, skipped, responses };
}

// lines: [{ stockCode|sku, qty }]. Rehearsal-safe: adds to the basket only; checkout is place().
export async function stage(page, { lines = [], skipInvalid = false } = {}) {
  const want = lines.map((l) => ({ code: String(l.stockCode || l.sku || '').trim(), qty: Number(l.qty || l.quantity || 0) })).filter((l) => l.code && l.qty > 0);
  if (!want.length) throw new Error('no lines with a code and a quantity');
  const before = await basketState(page);
  if (!(before.empty || before.items === 0)) {
    return { ready: false, refused: 'basket-not-empty', note: 'The Supertouch basket already holds items (a staff member may be mid-order). Not touching it.', before: { items: before.items, rows: before.rows } };
  }
  const add = await quickAdd(page, want, { skipInvalid });
  if (!add.submitted) return { ready: false, want, add, refused: add.refused };
  const after = await basketState(page);
  page.__supertouchStaged = true;
  page.__supertouchStage = { want, add, basket: after };
  // Ready only if the basket now holds exactly the units we sent minus the skipped lines.
  const skippedCodes = new Set((add.skipped || []).map((x) => x.code));
  const expectUnits = want.filter((l) => !skippedCodes.has(l.code)).reduce((n, l) => n + l.qty, 0);
  const ready = after.items === expectUnits && expectUnits > 0;
  return { ready, want, skipped: add.skipped || [], expectUnits, basket: { items: after.items, subtotal: after.subtotal }, add };
}

// Rehearsal only: open the checkout page, record its fields, submit NOTHING.
export async function checkoutProbe(page, opts = {}) { return checkoutRehearsal(page, { ref: (opts && opts.ref) || 'REHEARSAL' }); }

// Only ever called on a basket stage() found empty, so everything in it is ours.
async function emptyBasket(page) {
  await page.goto(`${BASE}/basket`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  const accept = (d) => d.accept().catch(() => {});
  page.on('dialog', accept);
  await page.locator('button[name="empty_basket"]').first().click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // Some themes confirm in a modal rather than window.confirm.
  await page.locator('.modal.in button:has-text("Yes"), .modal.in button:has-text("Empty"), .modal.in button:has-text("Confirm"), .swal2-confirm').first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2500);
  page.off('dialog', accept);
  const s = await basketState(page);
  return { empty: s.empty || s.items === 0, items: s.items };
}

// ── Checkout ───────────────────────────────────────────────────────────────────────────────────
// Deliver to our CURRENT address, typed in. The only saved address on the account (4 Midland,
// LS26 8SW) is our OLD one (Dec, 22 Oct 2026) and must never be selected.
const DELIVERY = {
  delivery_firstname: 'Tuff', delivery_lastname: 'Workwear', delivery_company: 'Tuff Workwear Ltd',
  delivery_address_1: '144-146 Aberford Road', delivery_address_2: 'Woodlesford', delivery_city: 'Leeds',
  delivery_area: 'West Yorkshire', delivery_postcode: 'LS26 8LG',
};

// Fill everything up to (not including) "Continue to Payment". Returns what the page shows.
async function fillCheckout(page, { ref }) {
  await page.goto(`${BASE}/basket`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.locator('a:has-text("Continue to checkout"), button:has-text("Continue to checkout")').first().click({ timeout: 15000 });
  await page.waitForURL(/\/pay/, { timeout: 45000 });
  await page.waitForTimeout(3000);
  const set = (name, v) => page.evaluate(({ name, v }) => {
    const el = document.querySelector(`[name="${name}"]`); if (!el) return false;
    el.value = v; window.jQuery ? window.jQuery(el).trigger('input').trigger('change') : el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { name, v });
  const filled = {};
  // Never the saved (old) address: leave the dropdown on "Select Address" and type ours.
  await page.evaluate(() => { const s = document.querySelector('select[name="delivery_addresses"]'); if (s) { s.value = ''; window.jQuery && window.jQuery(s).trigger('change'); } });
  await page.waitForTimeout(800);
  filled.country = await page.selectOption('select[name="delivery_country"]', 'GB').then(() => true).catch(() => false);
  // Type for real: the site's validator only unlocks CONTINUE on genuine input/keyup/blur events.
  const type = async (name, v) => { const el = page.locator(`[name="${name}"]`).first(); if (!(await el.count())) return false; await el.scrollIntoViewIfNeeded().catch(() => {}); await el.fill('').catch(() => {}); await el.pressSequentially(String(v), { delay: 15 }).catch(() => {}); await el.blur().catch(() => {}); return (await el.inputValue().catch(() => '')) === String(v); };
  for (const [k, v] of Object.entries(DELIVERY)) filled[k] = await type(k, v);
  filled.po = await type('custom_fields[cf_po_number]', String(ref));
  // Delivery: Standard (1-3 working days), £7.50 — Dec's carriage rule (22 Oct 2026). Chosen by its
  // LABEL, never by position/value, so a reordered list cannot pick next-day or collection.
  const delivery = await page.evaluate(() => [...document.querySelectorAll('input[name="pay_delivery_option"]')].map((r) => {
    const row = r.closest('tr') || r.closest('label') || r.parentElement;
    return { value: r.value, label: ((row && row.innerText) || '').replace(/s+/g, ' ').trim().slice(0, 140) };
  }));
  const standard = delivery.filter((d) => /^Standard Delivery/i.test(d.label));
  if (standard.length !== 1) return { filled, delivery, refused: 'standard-delivery-not-found-exactly-once' };
  // The radios are styled; a plain check() does not move them. Click the row, then set it directly.
  // The site's pay bundle binds clicks on .pay-delivery-option-row; that posts delivery.set and, on
  // success, enables the CONTINUE buttons. Let the address save settle first (it re-renders the rows).
  await page.waitForTimeout(3500);
  const rowSel = `.pay-delivery-option-row:has(input[name="pay_delivery_option"][value="${standard[0].value}"])`;
  const setResp = page.waitForResponse((r) => /delivery/i.test(r.url()) && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null);
  await page.locator(rowSel).first().scrollIntoViewIfNeeded().catch(() => {});
  await page.locator(rowSel).first().click({ timeout: 8000 }).catch(() => {});
  const resp = await setResp;
  await page.waitForTimeout(2000);
  const deliverySet = resp ? { url: new URL(resp.url()).pathname, status: resp.status() } : null;
  const deliveryChecked = await page.evaluate((v) => !!(document.querySelector(`input[name="pay_delivery_option"][value="${v}"]`) || {}).checked, standard[0].value);
  if (!deliveryChecked) return { filled, delivery, refused: 'standard-delivery-would-not-select' };
  await page.waitForTimeout(2500);
  // The section "CONTINUE »" buttons only move between sections of the same page (they place nothing).
  // Click the delivery section's one (inside the form column, not the order-summary sidebar), then record
  // what a person would SEE: visible error messages and whether Payment opened.
  const validator = await page.evaluate(() => {
    const $ = window.jQuery; const out = { scripts: [...document.querySelectorAll('script[src]')].map((x) => x.src).filter((u) => !/google|gtag|facebook|hotjar|clarity|stripe/i.test(u)).slice(0, 30) };
    try { const fv = $ && ($('#form_pay').data('formValidation') || $('#form_pay').data('bootstrapValidator')); if (fv) { out.kind = fv.getInvalidFields ? 'fv' : 'bv'; out.invalid = (fv.getInvalidFields ? fv.getInvalidFields() : $()).map(function () { return this.name || this.id; }).get().slice(0, 30); } } catch (e) { out.fvError = String(e.message || e); }
    out.inline = [...document.querySelectorAll('script:not([src])')].map((x) => x.textContent).filter((t) => /btn-continue|disabled/i.test(t)).map((t) => t.replace(/s+/g, ' ').slice(0, 1500)).slice(0, 4);
    out.requiredEmpty = [...document.querySelectorAll('#form_pay [required], #form_pay [data-fv-notempty], #form_pay [data-bv-notempty]')].filter((e) => !e.value).map((e) => `${e.name}${e.offsetParent ? '' : '(hidden)'}`).slice(0, 30);
    return out;
  }).catch((e) => ({ error: String(e.message || e) }));
  const continued = [];
  const buttonsBefore = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /CONTINUE/i.test(b.innerText || '') && b.offsetParent !== null).map((b) => ({ txt: b.innerText.trim(), disabled: b.disabled, cls: b.className.slice(0, 80) })));
  for (const b of await page.locator('button:has-text("CONTINUE »")').all()) {
    if (!(await b.isVisible().catch(() => false))) continue;
    const box = await b.boundingBox().catch(() => null);
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await b.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
    continued.push({ x: box && Math.round(box.x), y: box && Math.round(box.y) });
  }
  const visibleErrors = await page.evaluate(() => [...document.querySelectorAll('.has-error, .error, .alert-danger, .help-block, .invalid-feedback, [class*="error" i]')]
    .filter((e) => e.offsetParent !== null && (e.innerText || '').trim()).map((e) => (e.innerText || '').trim().slice(0, 120)).slice(0, 15));
  const paymentOpen = await page.evaluate(() => { const r = document.querySelector('input[name="pay_method"]'); return !!(r && (r.offsetParent !== null || (r.closest('label') && r.closest('label').offsetParent !== null))); });
  const pay = await page.evaluate(() => { const r = document.querySelector('input[name="pay_method"][value="sb_credit_account"]'); if (!r) return false; const row = r.closest('label') || r.parentElement; if (row) row.click(); if (!r.checked) { r.checked = true; window.jQuery && window.jQuery(r).trigger('click').trigger('change'); } return r.checked; }).catch(() => false);
  await page.waitForTimeout(1500);
  const terms = await page.evaluate(() => { const r = document.querySelector('#agree-terms'); if (!r) return false; if (!r.checked) { r.checked = true; window.jQuery && window.jQuery(r).trigger('change'); } return r.checked; }).catch(() => false);
  const state = await page.evaluate(() => {
    const v = (n) => (document.querySelector(`[name="${n}"]`) || {}).value;
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
    const money = (re) => { const x = txt.match(re); return x ? Number(x[1].replace(/,/g, '')) : null; };
    return {
      po: v('custom_fields[cf_po_number]'), postcode: v('delivery_postcode'), address1: v('delivery_address_1'), savedAddress: v('delivery_addresses'),
      payMethod: (document.querySelector('input[name="pay_method"]:checked') || {}).value || null,
      subtotal: money(/Subtotal\s+£([\d,.]+)/i), delivery: money(/Delivery\s+£([\d,.]+)/i), vat: money(/VAT\s+£([\d,.]+)/i), total: money(/Total\s+£([\d,.]+)/i),
      errors: [...document.querySelectorAll('.has-error, .error, .alert-danger, .help-block')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 10),
    };
  });
  return { filled, delivery, chosenDelivery: standard[0], deliverySet, validator, buttonsBefore, continued, visibleErrors, paymentOpen, creditAccount: pay, terms, state };
}

// Rehearsal: stage → fill the whole checkout → screenshot → empty our basket. Never clicks
// "Continue to Payment".
export async function checkoutRehearsal(page, { ref = 'REHEARSAL' } = {}) {
  if (!page.__supertouchStaged) return { stageDetail: null, refused: 'stage did not stage (basket not empty?) - checkout not touched' };
  let co, err = null, shot = null;
  try { co = await fillCheckout(page, { ref }); } catch (e) { err = String(e.message || e).slice(0, 600); }
  shot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 55 }).then((b) => `data:image/jpeg;base64,${b.toString('base64')}`).catch(() => null);
  const emptied = await emptyBasket(page);
  return { stageDetail: page.__supertouchStage || null, checkout: co || null, fillError: err, shot, emptied };
}

// One-off clean-up after a failed rehearsal: empties the basket ONLY if it holds exactly the lines given
// (count, subtotal and codes all match), so a staff member's basket can never be cleared by this.
export async function clearOurRehearsal(page, { expect = [], subtotal = null } = {}) {
  const b = await basketState(page);
  const body = await page.evaluate(() => (document.body.innerText || '').replace(/s+/g, ' '));
  const units = expect.reduce((n, l) => n + Number(l.qty || 0), 0);
  const codesOk = expect.every((l) => body.includes(`Code: ${l.code}`) || body.includes(l.code));
  const match = b.items === units && (subtotal == null || Math.abs((b.subtotal || 0) - subtotal) < 0.005) && codesOk;
  if (!match) return { cleared: false, reason: 'basket does not hold exactly our rehearsal lines - left alone', items: b.items, subtotal: b.subtotal };
  const e = await emptyBasket(page);
  return { cleared: e.empty, after: e };
}

// ── Place (execute:true only) ───────────────────────────────────────────────────────────────────
// Fills the checkout, re-verifies every value, then clicks "Continue to Payment" EXACTLY ONCE. The
// account pays by credit account, so that click is the order. Never retried here: a caller must
// check ordersList for our ref before any second attempt.
export async function place(page, { ref } = {}) {
  if (!ref) throw new Error('place needs our PO number as ref');
  const co = await fillCheckout(page, { ref });
  const st = co.state || {};
  const problems = [];
  if (co.refused) problems.push(co.refused);
  if (st.po !== String(ref)) problems.push(`PO field reads "${st.po}"`);
  if (st.postcode !== 'LS26 8LG' || st.address1 !== '144-146 Aberford Road') problems.push(`delivery address reads "${st.address1} ${st.postcode}"`);
  if (st.payMethod !== 'sb_credit_account') problems.push(`pay method "${st.payMethod}"`);
  if (!co.chosenDelivery || !/^Standard Delivery/i.test(co.chosenDelivery.label)) problems.push('delivery is not Standard Delivery');
  if (!co.paymentOpen) problems.push('payment section did not open');
  if (!co.terms) problems.push('terms box not ticked');
  if (problems.length) {
    await emptyBasket(page).catch(() => {});
    return { placed: false, refused: 'checkout-check-failed', problems, checkout: co };
  }
  const btn = page.locator('button:has-text("Continue to Payment")').filter({ hasNot: page.locator('[disabled]') });
  const visible = [];
  for (const b of await btn.all()) if (await b.isVisible().catch(() => false)) visible.push(b);
  if (!visible.length) { await emptyBasket(page).catch(() => {}); return { placed: false, refused: 'no-enabled-continue-to-payment', checkout: co }; }
  await visible[0].click({ timeout: 10000 });
  await page.waitForURL(/thank|complete|success|confirmation/i, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({ url: location.href, text: (document.body.innerText || '').replace(/s+/g, ' ').slice(0, 2500) }));
  const m = after.text.match(/orders*(?:number|no.?|ref(?:erence)?|#)s*[:#]?s*([A-Z0-9][A-Z0-9-]{3,})/i);
  const thanked = /thank you/i.test(after.text) && /thank|complete|success|confirmation/i.test(after.url);
  const shot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 55 }).then((b) => `data:image/jpeg;base64,${b.toString('base64')}`).catch(() => null);
  let listed = null;
  try { listed = await ordersList(page, { ref }); } catch (e) { listed = { error: String(e.message || e) }; }
  const orderRef = (m && m[1]) || (listed && listed.matches && listed.matches[0] && listed.matches[0].ourRef) || null;
  return { placed: !!(thanked || (listed && listed.matches && listed.matches.length)), orderRef, thanked, after: { url: after.url, text: after.text.slice(0, 800) }, listed, shot, checkout: { chosenDelivery: co.chosenDelivery, state: st } };
}

// Sales Orders: rows whose "Your Ref" is our PO. The table is drawn by script after load.
export async function ordersList(page, { ref = null } = {}) {
  await page.goto(`${BASE}/account/pages/sales-orders`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length > 0 || /no orders/i.test(document.body.innerText || ''), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const rows = await page.evaluate(() => {
    const t = [...document.querySelectorAll('table')].find((x) => /Your Ref/i.test(x.innerText || ''));
    if (!t) return [];
    const head = [...t.querySelectorAll('thead th, tr:first-child th')].map((h) => (h.innerText || '').trim());
    return [...t.querySelectorAll('tbody tr')].map((tr) => { const c = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim()); const o = {}; head.forEach((h, i) => { o[h] = c[i]; }); return o; }).slice(0, 40);
  });
  const pick = (o, re) => { const k = Object.keys(o).find((x) => re.test(x)); return k ? o[k] : null; };
  const norm = rows.map((o) => ({ ourRef: pick(o, /Our Ref/i), date: pick(o, /Date/i), yourRef: pick(o, /Your Ref/i), status: pick(o, /Status/i), net: pick(o, /NET/i) }));
  const matches = ref ? norm.filter((r) => String(r.yourRef || '').trim().toUpperCase() === String(ref).trim().toUpperCase()) : [];
  return { rows: norm.slice(0, 15), matches };
}
