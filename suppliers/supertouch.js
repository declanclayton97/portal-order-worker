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

export async function stage() { throw new Error('supertouch worker module is a login probe only — basket/checkout not built yet'); }
export async function place() { throw new Error('supertouch worker module is a login probe only'); }
