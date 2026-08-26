// Blåkläder — the ONE hop that cannot be done server-to-server.
//
// Everything else about Blaklader already works over plain HTTP from Alternate-Items: the stock
// feed, SKU resolution, cart creation and the product batch-add all run against api.blaklader.com
// with a Bearer token. Only the final submit fails, and on 2026-08-24 seven theories were tested
// and killed before the cause was pinned down:
//
//   POST https://www.blaklader.uk/api/orders/send
//   403 {"StatusCode":403,"Message":"Cart with id: <guid> is not allowed to be fetched."}
//
// Dead ends, so nobody repeats them: WAF/IP block, a consumed cart, browser-fingerprint headers,
// cart "ownership", the Bearer token (their client does send one — the HAR just redacted it), and
// carrying the login's cookie jar. The last of those is the informative one. The storefront
// authenticates with a signed HttpOnly `Blk._Auth` cookie on www.blaklader.uk, and a second OIDC
// flow that hands the auth code to the storefront still never receives it: three redirect hops,
// a clean 200, no cookie. `/auth/login` is a CLIENT-SIDE route — fetching it server-side returns
// the HTML shell and the code-for-session exchange happens in JavaScript we never execute.
//
// Hence a real browser. But ONLY for the session — this module deliberately does NOT drive the
// checkout UI. The order body is already built server-side by blakladerBuildOrder (buyer,
// addresses, paymentMethodId 175, delivery method 35, metadata.OrderNumber = our PO) and is proven
// correct: it is byte-identical to the body of two orders that returned 200. Re-implementing that
// by clicking through checkout would replace a known-good payload with a pile of brittle selectors.
// So `place()` posts that exact body from inside the page's own origin, where the browser attaches
// Blk._Auth automatically. One fetch, no scraping, and the storefront can never tell it apart from
// its own client.

export const config = {
  base: process.env.BLAKLADER_BASE || 'https://www.blaklader.uk',
  envUser: 'BLAKLADER_USER',
  envPass: 'BLAKLADER_PASS',
};

// The order body is prepared by the backend and arrives in stage()'s opts; place() only receives
// { ref } from the generic runner, so park it per-page rather than in a module-level variable that
// two concurrent jobs would trample.
const prepared = new WeakMap();

const AUTH_COOKIE = /^Blk\._Auth$/i;
const CART_COOKIE = /^Blk\.Cart\./i;

async function cookieMap(page) {
  const jar = await page.context().cookies();
  const out = {};
  for (const c of jar) out[c.name] = c.value;
  return out;
}

const hasAuth = (jar) => Object.keys(jar).some((k) => AUTH_COOKIE.test(k));
const cartCookie = (jar) => {
  const k = Object.keys(jar).find((n) => CART_COOKIE.test(n));
  return k ? { name: k, value: jar[k] } : null;
};

// The consent banner is a MODAL over the whole page on a cold context, and it swallows every click
// underneath — the first inspect run died at www.blaklader.uk/en with it still up. It is not
// OneTrust (the screenshot shows a third-party "Cookie Banner powered by …"), and it may live in an
// IFRAME, which is why a plain page.$ found nothing. So search every frame, not just the main one.
const CONSENT_SELS = [
  '#onetrust-accept-btn-handler',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("Save + Exit")',
  '[aria-label*="Accept" i]',
  'button[title*="Accept" i]',
];
// Selector-based dismissal FAILED twice: the CMP is consentmanager.net (the __cmpconsent93117 /
// __cmpcccu93117 cookies give it away) and it renders into a SHADOW ROOT, which CSS selectors do
// not reliably reach. Both runs clicked SIGN IN with the modal still covering it — and because
// click errors are swallowed, it looked like the click happened. Nothing underneath is reachable
// until the banner goes.
//
// So do it INSIDE the page: walk the DOM and every open shadow root, match on the button's own
// text, and click it directly. Frames too, since a CMP is often iframed. Falls back to removing
// the overlay outright — an un-dismissable banner must not be the thing that stops an order.
async function dismissConsent(page) {
  const clickByText = async (frame) => frame.evaluate(() => {
    // A CHAIN of modals, not one. Clearing consent revealed a second "SHOW PRICE / INCL. VAT"
    // dialog behind it, blocking clicks identically — so this list covers both and the caller
    // loops until nothing more is found. "close" is generic, but it only ever runs while a
    // blocking overlay is up, and the loop stops as soon as clicks land on the page again.
    const WANTED = ['accept all', 'accept all cookies', 'alle akzeptieren', 'save + exit', 'accept', 'close'];
    const seen = new Set();
    const walk = (root) => {
      if (!root || seen.has(root)) return false;
      seen.add(root);
      for (const el of root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
        const t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (WANTED.includes(t)) { el.click(); return true; }
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot && walk(el.shadowRoot)) return true;
      return false;
    };
    return walk(document);
  }).catch(() => false);

  // Keep clearing until nothing is left — dismissing one modal reveals the next.
  let cleared = 0;
  for (let pass = 0; pass < 6; pass++) {
    let hit = false;
    for (const frame of page.frames()) {
      if (await clickByText(frame)) { hit = true; cleared++; await page.waitForTimeout(800); break; }
    }
    if (hit) continue;
    if (cleared) return true;         // cleared everything we could find
    await page.waitForTimeout(900);   // it mounts a beat after domcontentloaded
  }
  if (cleared) return true;

  // Last resort: strip it. Consent is not what we are here for, and a modal we cannot click is
  // otherwise a hard stop.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[id*="cmp" i],[class*="cmp" i],[id*="consent" i],[class*="consent" i],[id*="usercentrics" i]')) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'absolute' || Number(cs.zIndex) > 100) el.remove();
    }
    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';
  }).catch(() => {});
  return false;
}

// Anything that opens the login. The live page uses a "SIGN IN" button top-right and a "LOGIN"
// link in the footer — neither matched the first attempt's selectors, which only knew "Log in".
const LOGIN_ENTRY = [
  'button:has-text("Sign in")', 'a:has-text("Sign in")',
  'button:has-text("Sign In")', 'a:has-text("Sign In")',
  'a:has-text("Login")', 'button:has-text("Login")',
  'button:has-text("Log in")', 'a:has-text("Log in")',
  'a[href*="/auth/login"]',
];
const PASS_SEL = 'input[name="Password"], input[type="password"]';

// LOG IN. The storefront bounces to login.blaklader.com (IdentityServer + an ASP.NET form) and
// back again, and it is the RETURN leg that sets Blk._Auth — the thing no server-side flow gets.
//
// The form's field names are not guessed: they are the ones the server-side OIDC flow in
// Alternate-Items/blakladerStock.js already posts successfully (Email / Password /
// __RequestVerificationToken). Entry points ARE guessed, so several are tried and success is
// judged by the password field appearing, never by a URL matching.
export async function login(page, { user, pass }) {
  const entries = [`${config.base}/en`, `${config.base}/en/checkout`, `${config.base}/auth/login`];
  let onForm = false;
  const tried = [];
  for (const url of entries) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // Clear the modal FIRST — it covers the SIGN IN button, so every click below is a no-op
    // until it is gone. That is what stalled the first run.
    await dismissConsent(page);
    await page.waitForTimeout(500);
    if (await page.$(PASS_SEL).catch(() => null)) { onForm = true; break; }
    for (const sel of LOGIN_ENTRY) {
      const el = await page.$(sel).catch(() => null);
      if (!el) continue;
      tried.push(sel);
      await el.click({ timeout: 5000 }).catch(() => {});
      // Poll rather than sleep once: this click usually redirects to login.blaklader.com, and a
      // fixed 3s wait was declaring failure before IdentityServer had even answered.
      for (let w = 0; w < 12 && !onForm; w++) {
        await page.waitForTimeout(1000);
        if (await page.$(PASS_SEL).catch(() => null)) onForm = true;
      }
      if (!onForm) await dismissConsent(page);
      if (await page.$(PASS_SEL).catch(() => null)) onForm = true;
      if (onForm) break;
    }
    if (onForm) break;
    if (hasAuth(await cookieMap(page))) return { alreadyAuthed: true, url: page.url() };
  }
  if (!onForm) {
    const jar = await cookieMap(page);
    if (hasAuth(jar)) return { alreadyAuthed: true, url: page.url() };
    throw new Error(`could not reach the Blaklader login form (last url ${page.url()}; entries clicked: ${tried.join(" | ") || "none matched"})`);
  }

  await page.fill('input[name="Email"]', user).catch(async () => { await page.fill('input[type="email"]', user); });
  await page.fill(PASS_SEL, pass);
  await dismissConsent(page);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.click('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")').catch(() => page.press(PASS_SEL, 'Enter')),
  ]);
  // The OIDC bounce back through /auth/login is what mints the cookie, and it finishes in JS —
  // so wait for the cookie itself rather than for any particular URL to settle.
  for (let i = 0; i < 30; i++) {
    if (hasAuth(await cookieMap(page))) break;
    await page.waitForTimeout(1000);
  }
  const jar = await cookieMap(page);
  if (!hasAuth(jar)) throw new Error(`logged in but no Blk._Auth cookie (url ${page.url()}, cookies: ${Object.keys(jar).join(",")})`);
  return { authed: true, url: page.url() };
}

// READ-ONLY. Reports what the session looks like without staging or placing anything — use it to
// prove the login works before any real order is on the line.
export async function inspect(page) {
  const jar = await cookieMap(page);
  const cart = cartCookie(jar);
  return {
    url: page.url(),
    hasStorefrontAuth: hasAuth(jar),
    cartCookie: cart ? { name: cart.name, cartId: cart.value } : null,
    cookies: Object.keys(jar),
  };
}

// STAGE. The cart is built by the backend over the API, so there is nothing to add here — this
// only checks the browser session is looking at the SAME cart we are about to submit, and refuses
// otherwise. `ready` gates place() in the generic runner.
//
// opts.body    — the order body from blakladerBuildOrder (required to place)
// opts.cartId  — the cart the backend built and verified
export async function stage(page, { lines = [], body = null, cartId = null } = {}) {
  const jar = await cookieMap(page);
  const cart = cartCookie(jar);
  const seen = cart ? cart.value : null;
  const wanted = cartId || (body && (body.cartId || (body.metadata && body.metadata.CartId))) || null;

  // A mismatch means the browser session would submit a DIFFERENT basket to the one that was
  // reconciled against the PO. Refuse rather than guess — ordering the wrong basket is exactly the
  // failure this whole flow exists to avoid.
  const cartMatches = !!(wanted && seen && String(seen).toLowerCase() === String(wanted).toLowerCase());
  if (body) prepared.set(page, body);

  return {
    added: 0,
    cartCount: lines.length,
    units: lines.reduce((a, l) => a + (Number(l.qty) || 0), 0),
    cartId: wanted,
    browserCartId: seen,
    cartMatches,
    hasStorefrontAuth: hasAuth(jar),
    ready: !!(body && hasAuth(jar) && (cartMatches || !seen)),
    note: !body ? 'no order body supplied — backend must pass opts.body from blakladerBuildOrder'
      : !hasAuth(jar) ? 'no Blk._Auth cookie — login did not complete'
        : cartMatches ? 'browser session is on the same cart'
          : !seen ? 'no cart cookie in this session; submitting by cartId in the body'
            : `browser cart ${seen} != backend cart ${wanted}`,
  };
}

// PLACE. Runs the submit from inside the page so the browser attaches Blk._Auth itself — we never
// see or handle that cookie, which is the entire point.
//
// Fire ONCE. On an ambiguous result (timeout, transport error) do NOT retry: read the cart back
// through the backend instead. A consumed cart means the order went through, and a blind retry is
// how a live order gets placed twice.
export async function place(page, { ref } = {}) {
  const body = prepared.get(page);
  if (!body) throw new Error('place() called without a staged order body');
  if (ref != null && body.metadata) {
    // Keep the PO ref authoritative even if the body was built earlier in the run.
    body.metadata.OrderNumber = String(ref);
    if (body.metadata.SalesRef != null) body.metadata.SalesRef = String(ref);
  }

  const out = await page.evaluate(async (payload) => {
    try {
      const r = await fetch('/api/orders/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',      // Blk._Auth rides along; that is the whole trick
      });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* keep the text */ }
      return { status: r.status, ok: r.ok, json, text: text.slice(0, 1000) };
    } catch (e) { return { status: 0, ok: false, error: String(e && e.message || e) }; }
  }, body);

  const internalId = (out.json && (out.json.internalOrderId || out.json.internalId)) || null;
  const placed = !!(out.ok && internalId);
  if (!placed) {
    const detail = (out.json && (out.json.message || (out.json.error && (out.json.error.Message || out.json.error.message)))) || out.text || out.error || '';
    throw new Error(`orders/send ${out.status}: ${String(detail).slice(0, 400)}`);
  }
  return {
    orderNo: internalId,
    internalId,
    orderId: (out.json && out.json.orderId) || null,
    paymentStatus: (out.json && out.json.paymentStatus) || null,
    cartId: (out.json && out.json.cartId) || null,
    status: out.status,
  };
}

// Stage, then report what the submit WOULD carry, without sending it.
export async function checkoutProbe(page) {
  const body = prepared.get(page);
  const jar = await cookieMap(page);
  return {
    wouldPost: `${config.base}/api/orders/send`,
    hasStorefrontAuth: hasAuth(jar),
    bodyKeys: body ? Object.keys(body) : null,
    orderNumber: body && body.metadata ? body.metadata.OrderNumber : null,
    cartId: body ? body.cartId : null,
  };
}

// ── Does the STOREFRONT session actually see our cart? ────────────────────────
// The cart is built server-side against api.blaklader.com; the worker's browser is a SEPARATE
// storefront session. If the two are not bound, the header shows NO CART ICON and
// POST /api/orders/send cannot resolve the cart — which is a naked 500 with the body
// "Internal Server Error", not a validation error naming a field.
//
// Reported by the owner 2026-08-26: opening the cart in a normal browser returned repeated errors,
// and after several refreshes a notice appeared saying the prices had been adjusted to the correct
// price list — after which the cart rendered. So the storefront REPRICES on view, and a cart that
// has never been viewed may be in a state the order endpoint refuses. Their own screenshot of our
// failing session shows the header with search / location / favourites / flag / MY ACCOUNT and NO
// cart icon at all.
//
// READ-ONLY. Navigates and reads. Never posts orders/send.
export async function cartProbe(page, { tries = 4 } = {}) {
  const attempts = [];
  for (let i = 0; i < tries; i++) {
    const url = `${config.base}/en/checkout`;
    let httpStatus = null;
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    if (resp) httpStatus = resp.status();
    await dismissConsent(page);
    await page.waitForTimeout(3000);
    const seen = await page.evaluate(() => {
      const txt = (document.body && document.body.innerText || '').replace(/\s+/g, ' ');
      return {
        url: location.href,
        title: document.title,
        // The reprice notice the owner saw — the thing that made the cart appear.
        repriced: /price list|prices have been (adjusted|updated)|adjusted to the correct/i.test(txt),
        errorPage: /internal server error|something went wrong|error 5\d\d|unexpected error/i.test(txt),
        empty: /your (cart|basket) is empty|no items/i.test(txt),
        // A cart icon / count in the header is the visible proof the session owns a cart.
        cartIndicator: !!document.querySelector('[class*="cart" i],[id*="cart" i],[data-testid*="cart" i],a[href*="/cart" i],a[href*="/checkout" i]'),
        // The cart total, so a reprice is visible as a NUMBER even if the wording changes.
        cartTotal: (txt.match(/£s?([d,]+.d{2})/) || [])[1] || null,
        text: txt.slice(0, 1500),
      };
    }).catch(() => ({}));
    attempts.push({ attempt: i + 1, httpStatus, ...seen });
    // STOP ONLY ON THE REPRICE. The first version broke as soon as a cart was VISIBLE, and that is
    // not the event that matters: the owner's cart rendered too, and still would not order. What
    // unblocked theirs was the notice that prices had been adjusted to the correct price list,
    // which arrives only after several refreshes. Breaking on cartIndicator ended the experiment
    // one step before the interesting part (2026-08-26).
    // The price gap says the same thing: the storefront showed GBP1,273.79 against our PO net of
    // GBP1,255.91, so the cart is priced on the wrong list until it is corrected.
    if (seen && seen.repriced) break;
    await page.waitForTimeout(2500);
  }
  const shot = `data:image/png;base64,${(await page.screenshot({ fullPage: false }).catch(() => Buffer.from(''))).toString('base64')}`;
  return { attempts, finalUrl: page.url(), screenshot: shot };
}
