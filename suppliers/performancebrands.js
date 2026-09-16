// Performance Brands trade shop (performance-brands.co.uk — WordPress + WooCommerce, trade-gated).
//
// WHY A BROWSER. This supplier was driven by plain server HTTP until it stopped working somewhere
// between 2026-08-21 (order #24454 placed by hand, £416.73) and 2026-08-28. Six explanations were
// tested against the live site and every one was wrong:
//   · encoding            — urlencoded and multipart fail identically
//   · a missing add-to-cart parameter — their button carries no name/value, so a browser sends none
//   · a cookie lost on a 302 — there is no redirect at all (200, no Location, no Set-Cookie)
//   · the session being logged out — /my-account/ shows Log out links and no login form
//   · the variation being unorderable — 20025 reports is_purchasable:true with 243 in stock
//   · a page cache eating Set-Cookie — responses are no-cache, no-store, private
// What is left: the site accepts the request and REFUSES the add. wc-ajax add_to_cart returns
// {"error":true} for a purchasable, in-stock variation, with and without its attributes, while the
// form POST returns 200 and says nothing at all. No wp_woocommerce_session_* cookie is ever issued.
// Whatever the site wants — session state, plugin JS, or a trade rule — it is satisfied by a real
// browser and not by us reconstructing the request. So stop reconstructing it.
//
// WHAT THIS MODULE IS NOT. It does not resolve SKUs. The existing Alt-Items resolver is healthy and
// stays: it maps PB271-BRN-06/06.5/09 to variations 20025/20026/20029 with live prices matching
// Brightpearl. The backend passes lines already resolved to { url, pid, qty }; this only drives the
// basket and the checkout.
//
// The grid is the "WooCommerce Bulk Variations" plugin (wcbvp). Every cell carries
//   <input name="input_quantity" data-product_id="<variationId>" min_qty max_qty …>
// and the plugin's own JS turns those into hidden quantity[<variationId>] fields when the form is
// submitted. Typing into the cell and clicking Add is exactly what a buyer does, so that is what
// this does — no synthesised fields, nothing that depends on the plugin's internals staying put.

export const config = {
  base: process.env.PERFORMANCE_BRANDS_BASE || 'https://performance-brands.co.uk',
  envUser: 'PERFORMANCE_BRANDS_USER',
  envPass: 'PERFORMANCE_BRANDS_PASS',
};

const BASE = config.base;
const txt = async (page) => (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';

export async function login(page, { user, pass }) {
  await page.goto(`${BASE}/my-account/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Already signed in? The account page shows the logout link instead of the form.
  if (await page.$('a[href*="customer-logout"]')) return { alreadyIn: true };
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.click('button[name="login"], input[name="login"]'),
  ]);
  await page.waitForTimeout(1500);
  const ok = !!(await page.$('a[href*="customer-logout"]'));
  if (!ok) {
    const t = (await txt(page)).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`login did not complete — no logout link on /my-account/. Page said: ${t}`);
  }
  return { alreadyIn: false };
}

// Basket rows, so "did it land" is answered by reading the basket rather than trusting a response.
async function basket(page) {
  await page.goto(`${BASE}/basket/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.woocommerce-cart-form__cart-item, tr.cart_item')];
    const money = (s) => { const m = String(s || '').match(/([\d,]+\.\d{2})/); return m ? Number(m[1].replace(/,/g, '')) : null; };
    return {
      count: rows.length,
      units: rows.reduce((a, r) => a + (Number((r.querySelector('input.qty') || {}).value) || 0), 0),
      lines: rows.map((r) => ({
        name: (r.querySelector('.product-name') || {}).innerText?.replace(/\s+/g, ' ').trim().slice(0, 80) || null,
        qty: Number((r.querySelector('input.qty') || {}).value) || null,
        total: money((r.querySelector('.product-subtotal') || {}).innerText),
      })),
      empty: /your basket is currently empty|cart is empty/i.test(document.body.innerText || ''),
    };
  });
}

// Never order on top of whatever a previous run left behind. Same rule as Sterling: the basket must
// be OURS and only ours before anything is submitted.
async function emptyBasket(page) {
  let removed = 0;
  for (let pass = 0; pass < 12; pass++) {
    const b = await basket(page);
    if (!b.count) return { removed, empty: true };
    const link = await page.$('a.remove');
    if (!link) return { removed, empty: false, stuck: b.count };
    await link.click().catch(() => {});
    await page.waitForTimeout(1200);
    removed++;
  }
  const b = await basket(page);
  return { removed, empty: !b.count, stuck: b.count || 0 };
}

// lines: [{ url, pid, qty, sku }] — already resolved by the backend.
export async function stage(page, { lines = [] } = {}) {
  if (!lines.length) return { added: 0, expected: 0, cartCount: 0, units: 0, ready: false, note: 'no lines' };

  const cleared = await emptyBasket(page);
  if (!cleared.empty) {
    return { added: 0, expected: lines.length, cartCount: cleared.stuck, units: 0, ready: false, cleared,
      note: `basket still holds ${cleared.stuck} line(s) — refusing to add on top of them` };
  }

  // One page visit per product, all that product's sizes typed in before a single Add — which is
  // how the grid is meant to be used and what the plugin's own JS expects.
  const byUrl = new Map();
  for (const l of lines) {
    if (!l.url || !l.pid) continue;
    if (!byUrl.has(l.url)) byUrl.set(l.url, []);
    byUrl.get(l.url).push(l);
  }

  const results = [];
  for (const [url, group] of byUrl) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      const before = await page.evaluate(() => document.querySelectorAll('.woocommerce-message, .woocommerce-error').length);
      const typed = [];
      for (const l of group) {
        const sel = `input[name="input_quantity"][data-product_id="${l.pid}"]`;
        const box = await page.$(sel);
        if (!box) { results.push({ sku: l.sku, pid: l.pid, ok: false, reason: 'no quantity box for that variation on the page' }); continue; }
        const max = Number(await box.getAttribute('max_qty')) || Number(await box.getAttribute('max')) || null;
        const min = Number(await box.getAttribute('min_qty')) || Number(await box.getAttribute('min')) || null;
        const step = Number(await box.getAttribute('step')) || null;
        if (max != null && Number(l.qty) > max) {
          results.push({ sku: l.sku, pid: l.pid, ok: false, reason: `only ${max} available, need ${l.qty}` });
          continue;
        }
        // Some products carry a MINIMUM order quantity and a step, and the grid enforces both by
        // simply leaving the Add button disabled — no message, no error. The Y-Shield OR7 helmet
        // (BP 191339) is min 20, step 20 at £5.38, so the 2 that low-inventory keeps asking for
        // can never be bought however the request is shaped. Say that plainly here instead of
        // reporting the symptom ("Add button never enabled"), which sends whoever reads it looking
        // for a fault that is really a supplier term.
        if (min != null && Number(l.qty) < min) {
          results.push({ sku: l.sku, pid: l.pid, ok: false, minQty: min, step,
            reason: `supplier minimum is ${min}${step && step > 1 ? ` (in steps of ${step})` : ''}, this line wants ${l.qty}` });
          continue;
        }
        if (step && step > 1 && Number(l.qty) % step !== 0) {
          results.push({ sku: l.sku, pid: l.pid, ok: false, step,
            reason: `must be ordered in steps of ${step}, this line wants ${l.qty}` });
          continue;
        }
        await box.fill(String(l.qty));
        await box.dispatchEvent('input').catch(() => {});
        await box.dispatchEvent('change').catch(() => {});
        typed.push({ sku: l.sku, pid: l.pid, qty: l.qty, max });
      }
      if (!typed.length) continue;

      // The Add button stays disabled until the grid registers a quantity — waiting for it to
      // enable is the page telling us it accepted what we typed.
      const btn = 'form.wcbvp-cart button.single_add_to_cart_button, button.single_add_to_cart_button';
      await page.waitForFunction(
        (s) => { const b = document.querySelector(s); return b && !b.disabled; }, btn, { timeout: 15000 },
      ).catch(() => {});
      const enabled = await page.evaluate((s) => { const b = document.querySelector(s); return !!b && !b.disabled; }, btn);
      if (!enabled) {
        for (const t of typed) results.push({ ...t, ok: false, reason: 'Add button never enabled after typing the quantity' });
        continue;
      }
      await page.click(btn);
      await page.waitForTimeout(2500);
      const notice = await page.evaluate(() => {
        const n = document.querySelector('.woocommerce-message, .woocommerce-error, .wc-block-components-notice-banner');
        return n ? n.innerText.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
      });
      for (const t of typed) results.push({ ...t, ok: true, notice });
      void before;
    } catch (e) {
      for (const l of group) results.push({ sku: l.sku, pid: l.pid, ok: false, reason: e.message });
    }
  }

  const b = await basket(page);
  const wantUnits = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
  const okLines = results.filter((r) => r.ok).length;
  return {
    added: okLines,
    expected: lines.length,
    cartCount: b.count,
    units: b.units,
    wantUnits,
    basket: b.lines,
    results,
    cleared,
    // Both tests, deliberately. Line count alone would pass a basket holding the right number of
    // rows at the wrong quantities.
    ready: okLines === lines.length && b.count === byUrlLineCount(lines) && b.units === wantUnits,
  };
}

// The basket groups by variation, so the row count to expect is the number of distinct variations.
function byUrlLineCount(lines) {
  return new Set(lines.map((l) => String(l.pid))).size;
}

// Selecting the payment method fires WooCommerce's update_checkout AJAX, which blocks the form
// behind a .blockUI overlay and — on this theme — completely REPLACES the #payment box (terms
// checkbox included) once the response lands. Error 285/343: a fixed 1500ms sleep here raced that
// replace — on a full cart (9 lines, 47 units) the AJAX call outlasted it, so the terms element
// handle grabbed right after was the PRE-refresh node, and Playwright's own click-retry loop
// watched it get torn out from under the click mid-attempt ("Element is not attached to the DOM").
// checkoutProbe's own dump confirmed it: the blockOverlay div was intercepting pointer events right
// before the element went stale. Wait for the overlay to actually clear instead of guessing how
// long that takes — same principle as stage()'s wait for the Add button to enable.
async function waitForCheckoutSettled(page, { timeout = 20000 } = {}) {
  await page.waitForSelector('.blockUI.blockOverlay', { state: 'attached', timeout: 2000 }).catch(() => {});
  await page.waitForSelector('.blockUI.blockOverlay', { state: 'detached', timeout }).catch(() => {});
}

// Diagnostic: reach the checkout screen and watch the terms checkbox over time, WITHOUT filling
// the PO field or clicking place_order. Never stages — call with lines:[] (stage() no-ops on an
// empty array, see above) so this runs against whatever the basket already holds; safe to use on a
// basket left stuck by a failed run.
export async function checkoutProbe(page) {
  await page.goto(`${BASE}/checkout/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const dump = async (label) => ({
    label,
    ...(await page.evaluate(() => {
      const t = document.querySelector('input#terms, input[name="terms"]');
      if (!t) return { exists: false };
      const r = t.getBoundingClientRect();
      const s = getComputedStyle(t);
      const wrap = t.closest('label, .woocommerce-form__label-for-checkbox, p');
      return {
        exists: true, checked: t.checked, disabled: t.disabled,
        display: s.display, visibility: s.visibility, opacity: s.opacity,
        w: Math.round(r.width), h: Math.round(r.height),
        outerHTML: t.outerHTML.slice(0, 300),
        wrapTag: wrap ? wrap.tagName : null,
      };
    }).catch(() => ({ evalError: true }))),
  });

  const radio = await page.$('input[name="payment_method"][value="b2b_credit_limit"]');
  const before = await dump('before-payment-method');
  if (radio) { await radio.check().catch(() => {}); await waitForCheckoutSettled(page); }
  const afterRadio = await dump('after-payment-method-settled');

  const terms = await page.$('input#terms, input[name="terms"]');
  let checkError = null;
  if (terms) {
    try { await terms.check(); } catch (e) { checkError = e.message; }
  }
  const immediatelyAfterCheck = await dump('immediately-after-check');
  await page.waitForTimeout(2500);
  const settled = await dump('2500ms-after-check');

  return { url: page.url(), before, afterRadio, checkError, immediatelyAfterCheck, settled };
}

// Checkout. po_field carries OUR Brightpearl PO number and the site rejects an empty one; it only
// renders while payment_method=b2b_credit_limit is selected. b2b_credit_limit is a trade CREDIT
// account — no card details are involved at any point.
export async function place(page, { ref } = {}) {
  if (!ref) throw new Error('ref (PO number) required — the site rejects an empty PO Number');
  await page.goto(`${BASE}/checkout/`, { waitUntil: 'domcontentloaded', timeout: 90000 });

  const radio = await page.$('input[name="payment_method"][value="b2b_credit_limit"]');
  if (radio) { await radio.check().catch(() => {}); await waitForCheckoutSettled(page); }

  const po = await page.$('#po_field, input[name="po_field"]');
  if (!po) {
    const t = (await txt(page)).replace(/\s+/g, ' ').slice(0, 300);
    const e = new Error('PO Number field not on the checkout — is b2b_credit_limit still the payment method?');
    e.checkoutView = { url: page.url(), text: t };
    throw e;
  }
  await po.fill(String(ref));

  // Their checkout carries a terms-and-conditions checkbox and refuses without it:
  // "Please read and accept the terms and conditions to proceed with your order." Ticking it is
  // part of placing the trade order that was asked for — the same box a buyer ticks by hand — and
  // it is checked for explicitly rather than blind-clicked, so if the box ever moves this fails
  // loudly instead of placing an order that skipped it.
  // Ticking the payment radio fires WooCommerce's update_order_review AJAX, which blocks the form
  // and REPLACES the checkout markup. A handle taken before that is stale, so check() and click()
  // both fail against a detached node and the box is still unticked when we look — which is exactly
  // what "could not tick the terms checkbox" has been reporting (PO 489405, 2026-09-16, and the
  // 14:30 run before it). Wait for the form to settle, then re-query on EVERY attempt.
  //
  // Woo themes also hide the real input behind a styled label, and Playwright refuses to act on a
  // non-visible element — so the label is tried before falling back to setting the property and
  // firing `change`, which is what the theme's own handler listens for.
  const termsIdle = async () => {
    await page.waitForFunction(() => !document.querySelector('.blockUI, .blockOverlay')
      && !document.querySelector('form.checkout.processing'), { timeout: 20000 }).catch(() => {});
  };
  const termsTicked = () => page.evaluate(() => {
    const t = document.querySelector('input#terms, input[name="terms"]');
    return !!t && t.checked;
  });
  const termsPresent = () => page.evaluate(() => !!document.querySelector('input#terms, input[name="terms"]'));

  await termsIdle();
  if (await termsPresent()) {
    const attempts = [
      async () => { const t = await page.$('input#terms, input[name="terms"]'); if (t) await t.check({ timeout: 5000 }); },
      async () => { const l = await page.$('label[for="terms"], .woocommerce-terms-and-conditions-checkbox-text'); if (l) await l.click({ timeout: 5000 }); },
      async () => { const t = await page.$('input#terms, input[name="terms"]'); if (t) await t.click({ timeout: 5000, force: true }); },
      async () => {
        await page.evaluate(() => {
          const t = document.querySelector('input#terms, input[name="terms"]');
          if (!t) return;
          t.checked = true;
          t.dispatchEvent(new Event('change', { bubbles: true }));
          t.dispatchEvent(new Event('click', { bubbles: true }));
        });
      },
    ];
    let ticked = await termsTicked();
    const tried = [];
    for (let i = 0; i < attempts.length && !ticked; i++) {
      try { await attempts[i](); } catch (e) { tried.push(`${i}:${String(e.message).split('\n')[0].slice(0, 60)}`); }
      await termsIdle();
      ticked = await termsTicked();
      if (!ticked) tried.push(`${i}:still unticked`);
    }
    if (!ticked) {
      const e = new Error('could not tick the terms checkbox — refusing to attempt the order');
      e.termsAttempts = tried;   // WHICH routes were tried and how each failed, so this is diagnosable
      throw e;
    }
  }

  const totalBefore = await page.evaluate(() => {
    const el = document.querySelector('.order-total .amount, .order-total bdi');
    const m = el && el.innerText.match(/([\d,]+\.\d{2})/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  });

  await page.click('#place_order, button[name="woocommerce_checkout_place_order"]');
  // The order-received page is the only proof. Poll for it rather than trusting a timeout.
  let placed = false, orderNo = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(2000);
    const url = page.url();
    if (/order-received|order-confirmation|thank[-_]?you/i.test(url)) { placed = true; break; }
    const t = await txt(page);
    if (/thank you\.? your order|order (has been )?received/i.test(t)) { placed = true; break; }
    const err = await page.evaluate(() => {
      const n = document.querySelector('.woocommerce-error');
      return n ? n.innerText.replace(/\s+/g, ' ').trim().slice(0, 250) : null;
    });
    if (err) { const e = new Error(`checkout refused: ${err}`); e.checkoutView = { url, total: totalBefore }; throw e; }
  }
  if (placed) {
    orderNo = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const m = t.match(/order\s*(?:number|#)\s*[:#]?\s*(\d{3,})/i) || (location.href.match(/order-received\/(\d+)/) || []);
      return m ? m[1] : null;
    }).catch(() => null);
  }
  const screenshot = placed ? null : `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
  return { placed, orderNo, url: page.url(), total: totalBefore, screenshot };
}

// Read-only: what does the site return for a search term? For working out why a line will not
// resolve, without touching the basket.
//
// Uses the site's OWN search API (/wp-json/ysm/v1/search) — the same one the backend resolver
// uses — rather than scraping the results page. The first version of this scraped
// a.woocommerce-LoopProduct-link and returned zero hits for EVERYTHING, including PB271 and
// "Brandon", products we had staged into a basket minutes earlier. On this Elementor build those
// selectors match nothing, so it reported "not found" for things that plainly exist. A probe that
// cannot tell absent from unmatched is worse than no probe: it makes a live product look
// discontinued.
//
// The search itself is not trustworthy for VARIATIONS — asked for "PB56C-BRN-10.5" it returns a
// suggestion captioned "…- 10.5" whether or not that size exists, because it decorates the caption
// from the query. It is reliable only for finding a product PAGE, which is all this reports.
export async function diagnose(page, { codes = [] } = {}) {
  const out = [];
  for (const c of codes.slice(0, 10)) {
    try {
      const j = await page.evaluate(async (q) => {
        const r = await fetch(`/wp-json/ysm/v1/search?id=1&query=${encodeURIComponent(q)}`, { credentials: 'include' });
        if (!r.ok) return { status: r.status, suggestions: [] };
        const body = await r.json().catch(() => ({}));
        return { status: r.status, suggestions: body.suggestions || [] };
      }, c);
      const hits = (j.suggestions || []).map((s) => {
        const href = (/href="([^"]+)"/.exec(s.data || '') || [])[1] || null;
        const label = String(s.value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return { label: label.slice(0, 90), url: href ? href.split('?')[0] : null };
      }).slice(0, 6);
      out.push({ code: c, status: j.status, hits });
    } catch (e) { out.push({ code: c, error: e.message }); }
  }
  return { searched: out };
}
