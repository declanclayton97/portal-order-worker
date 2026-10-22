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


export async function place() { throw new Error('supertouch worker module is a login probe only'); }

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

async function quickAdd(page, lines) {
  const form = page.locator('form.bulk-add-to-basket').first();
  await form.waitFor({ state: 'attached', timeout: 15000 });
  // The form may be inside a hidden Quick Order panel; drive its fields directly by index.
  for (let i = 0; i < lines.length; i++) {
    let rows = await form.locator('input[name="identifier[]"]').count();
    while (rows <= i) { await form.locator('button.add-new-row').first().evaluate((b) => b.click()); await page.waitForTimeout(150); rows = await form.locator('input[name="identifier[]"]').count(); }
    await form.locator('input[name="identifier[]"]').nth(i).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(lines[i].code));
    await form.locator('input[name="quantity[]"]').nth(i).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(lines[i].qty));
  }
  const responses = [];
  const onResp = async (r) => { if (/basket|bulk/i.test(r.url()) && r.request().method() !== 'GET') responses.push({ url: r.url(), status: r.status(), body: (await r.text().catch(() => '')).slice(0, 800) }); };
  page.on('response', onResp);
  await form.locator('button.bulk-add-to-basket-submit').first().evaluate((b) => b.click());
  await page.waitForTimeout(6000);
  page.off('response', onResp);
  return { responses, pageSaid: await text(page, 600) };
}

// lines: [{ stockCode|sku, qty }]. Rehearsal-safe: adds to the basket only; checkout is place().
export async function stage(page, { lines = [] } = {}) {
  const want = lines.map((l) => ({ code: String(l.stockCode || l.sku || '').trim(), qty: Number(l.qty || l.quantity || 0) })).filter((l) => l.code && l.qty > 0);
  if (!want.length) throw new Error('no lines with a code and a quantity');
  const before = await basketState(page);
  if (!(before.empty || before.items === 0)) {
    return { ready: false, refused: 'basket-not-empty', note: 'The Supertouch basket already holds items (a staff member may be mid-order). Not touching it.', before: { items: before.items, rows: before.rows } };
  }
  const add = await quickAdd(page, want);
  const after = await basketState(page);
  page.__supertouchStaged = true;
  return { ready: false, want, add, basket: after };
}

// Rehearsal only: open the checkout page, record its fields, submit NOTHING.
export async function checkoutProbe(page) {
  await page.goto(`${BASE}/basket`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.locator('a:has-text("Continue to checkout"), button:has-text("Continue to checkout")').first().click({ timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const checkout = await page.evaluate(() => ({
    url: location.href,
    fields: [...document.querySelectorAll('input,select,textarea,button')].filter((i) => i.type !== 'hidden' || /po|ref|order/i.test(i.name || ''))
      .map((i) => `${i.tagName.toLowerCase()} name=${i.name || ''} id=${i.id || ''} type=${i.type || ''} val=${(i.value || '').slice(0, 40)} txt=${(i.innerText || '').trim().slice(0, 30)}`)
      .filter((s) => !/newsletter|search|Request-an-Account|cookie|g-recaptcha/i.test(s)).slice(0, 80),
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 2500),
  })).catch((e) => ({ error: String(e.message || e) }));
  const emptied = await emptyBasket(page);
  return { checkout, emptied };
}

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
