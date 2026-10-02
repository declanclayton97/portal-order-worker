// BeeSwift (beeswiftonline.com) — LOGIN ONLY. Hands back a fresh session token; the basket and the
// checkout stay in Alt-Items (beeswiftPortal.js), which drives them over plain HTTP once it has one.
//
// WHY A BROWSER. The login is gated below HTTP (TLS / HTTP-2 fingerprint): a byte-identical POST from
// Node is refused while Chrome succeeds. Everything AFTER login works from Node with the token, so
// this is the only step that needs Chromium.
//
// WHY AT ORDER TIME. BeeSwift allows ONE session per account — each login kills the previous token.
// The VM's 06:20/18:20 refresh was killed by any staff login in between, so the 13:40 run failed at
// the basket. Logging in seconds before the basket closes that gap. It also logs out anyone on
// BeeSwift at that moment, which is why the run only asks for a token when it has something to order.
//
// The session is the `user=<TOKEN>` query param on dashboard.html (no Set-Cookie on login).

export const config = {
  base: process.env.BEESWIFT_BASE || 'https://www.beeswiftonline.com/web/ukonline',
  envUser: 'BEESWIFT_USER',
  envPass: 'BEESWIFT_PASS',
};

const BASE = config.base;
const tokenFrom = (url) => { try { return new URL(url).searchParams.get('user') || null; } catch { return null; } };

export async function login(page, { user, pass }) {
  await page.goto(`${BASE}/weblogin.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('input[name="vUserID"]', user);
  await page.fill('input[name="vPassword"]', pass);
  await Promise.all([
    page.waitForURL(/dashboard\.html\?[^#]*user=/i, { timeout: 45000 }).catch(() => {}),
    page.click('[name="SubmitLogin"]'),
  ]);
  const token = tokenFrom(page.url());
  if (!token) {
    const t = ((await page.evaluate(() => document.body.innerText).catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`BeeSwift login did not reach the dashboard (at ${page.url().split('?')[0]}). Page said: ${t}`);
  }
  page.__beeswiftToken = token;
  return { token };
}

// opts.sessionToken — log in and return the token. Touches nothing else.
export async function sessionToken(page) {
  const token = page.__beeswiftToken || tokenFrom(page.url());
  if (!token) throw new Error('no BeeSwift token after login');
  return { token, tokenTail: token.slice(-6) };
}

export async function stage() { throw new Error('beeswift worker module is login-only — basket/checkout run in Alt-Items'); }
export async function place() { throw new Error('beeswift worker module is login-only'); }
