// PenCarrie website (pencarrie.com Order Centre) — READ-ONLY, for shipment tracking.
//
// Why the browser: PenCarrie's API (pclist/pcget) drops an order within days of invoicing,
// but the website's Order Centre keeps it — Current Orders first, then Order History — with
// its tracking. The site sits behind Cloudflare, which turns plain server requests away; a
// real browser gets through. Once signed in, the page's own data endpoint answers JSON:
//   GET /api/internal/orders/page?page=1&sort-by=date-desc&q=<ref>            (current orders)
//   GET /api/internal/orders/page?history=1&page=1&sort-by=date-desc&q=<ref>  (order history)
// Each order carries reference (our "TW<poId>"), number, despatched, shipped_by, shipped_at,
// tracking_url (a DPD link keyed on postcode + sender ref) and status.
//
// Nothing here orders, edits or cancels anything. Contract: opts.ordersList = true,
// lines = [{ po }] — one sign-in for the whole batch.

const BASE = 'https://www.pencarrie.com';

export const config = { envUser: 'PENCARRIE_WEB_EMAIL', envPass: 'PENCARRIE_WEB_PASSWORD' };

export async function login(page, { user, pass }) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  // Cloudflare may show its check first; give it time to clear itself.
  for (let i = 0; i < 20 && /Just a moment|cf-chl/i.test(await page.content()); i++) await page.waitForTimeout(1500);
  if (!(await page.$('input[name="email"]'))) {
    const diag = await page.evaluate(() => ({ url: location.href, title: document.title }));
    throw new Error(`PenCarrie login form not found — ${JSON.stringify(diag)}`);
  }
  await page.fill('input[name="email"]', user);
  await page.fill('input[name="password"]', pass);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.click('form[action*="/login"] button[type="submit"], form[action*="/login"] input[type="submit"]').catch(() => page.press('input[name="password"]', 'Enter')),
  ]);
  await page.waitForTimeout(1500);
  const ok = await page.evaluate(async () => {
    const r = await fetch('/api/internal/orders/page?page=1&sort-by=date-desc&q=TW', { headers: { Accept: 'application/json' } });
    return r.ok && /json/.test(r.headers.get('content-type') || '');
  }).catch(() => false);
  if (!ok) throw new Error(`PenCarrie sign-in did not take for ${(user || '').slice(0, 4)}***`);
  return { signedIn: true };
}

// The worker hands list jobs their opts, not lines — so the POs come in as opts.pos.
export async function ordersList(page, { pos: posIn = [], lines = [] } = {}) {
  const pos = [...new Set([...posIn, ...lines.map((l) => l.po)].map((p) => String(p || '').trim()).filter((p) => /^\d{5,7}$/.test(p)))];
  const results = await page.evaluate(async (list) => {
    const out = [];
    for (const po of list) {
      const ref = `TW${po}`;
      // EVERY order carrying this reference: a back-order release ships as its own order under
      // the original PO's TW number, so the caller needs them all to pick the right shipment.
      const hits = [];
      for (const hist of ['', 'history=1&']) {
        const r = await fetch(`/api/internal/orders/page?${hist}page=1&sort-by=date-desc&q=${encodeURIComponent(ref)}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) continue;
        const j = await r.json().catch(() => null);
        for (const o of (j && j.data) || []) {
          if (String(o.reference || '').trim().toUpperCase() !== ref || hits.some((h) => h.number === o.number)) continue;
          hits.push({
            where: hist ? 'history' : 'current', number: o.number, status: o.status_description || o.status,
            despatched: !!o.despatched, shippedBy: o.shipped_by || null, shippedAt: o.shipped_at || null,
            createdAt: o.created_at || null, trackingUrl: o.tracking_url || null,
          });
        }
      }
      out.push(hits.length ? { po, found: true, orders: hits } : { po, found: false });
      await new Promise((res) => setTimeout(res, 400));
    }
    return out;
  }, pos);
  return { results };
}

// The worker's contract expects these; this module never places anything.
export async function stage() { return { ready: false, note: 'read-only module — use opts.ordersList' }; }
export async function place() { throw new Error('pencarrieweb is read-only'); }
