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

// READ-ONLY look at the Back Orders page (/orders/backorders). PenCarrie do not ship a back order
// when it lands: it becomes "available to add to the current order" there, and someone has to add
// it (user, 2026-09-30). Before automating that, record what the page shows and — more usefully —
// the page's OWN data calls (/api/internal/…), so the release can be driven the way the site does
// it. Clicks nothing. Returns the calls with their bodies, the table text, and every button/link.
export async function backorders(page, { pcGet = [] } = {}) {
  const calls = [];
  const onResp = async (res) => {
    const url = res.url();
    if (!/\/api\/internal\//.test(url)) return;
    let body = null;
    try { body = (await res.text()).slice(0, 6000); } catch { /* body gone */ }
    calls.push({ url: url.replace(BASE, ''), method: res.request().method(), status: res.status(), body });
  };
  page.on('response', onResp);
  await page.goto(`${BASE}/orders/backorders`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(2500);
  page.off('response', onResp);
  const view = await page.evaluate(() => ({
    url: location.href, title: document.title,
    rows: [...document.querySelectorAll('table tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 60),
    controls: [...document.querySelectorAll('button, a.btn, input[type=submit], input[type=checkbox], a[href*="backorder"], [data-action]')]
      .map((e) => ({ tag: e.tagName, text: (e.innerText || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 60), name: e.name || null,
        href: e.getAttribute('href'), action: e.getAttribute('data-action') || e.getAttribute('formaction') || null, disabled: !!e.disabled }))
      .filter((c) => c.text || c.href || c.name).slice(0, 60),
    forms: [...document.querySelectorAll('form')].map((f) => ({ action: f.getAttribute('action'), method: f.getAttribute('method') })).slice(0, 10),
    text: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 3000),
  }));
  // Extra READ-ONLY lookups (GET only, /api/internal/ only) — e.g. an order's full record, to see
  // whether an API-placed order is still editable and so can take a back order.
  const gets = await page.evaluate(async (paths) => {
    const out = [];
    for (const p of paths) {
      if (!/^\/api\/internal\//.test(p)) { out.push({ path: p, error: 'not an /api/internal/ path' }); continue; }
      const r = await fetch(p, { headers: { Accept: 'application/json' } }).catch((e) => ({ status: 0, text: async () => String(e) }));
      out.push({ path: p, status: r.status, body: (await r.text()).slice(0, 400000) });
    }
    return out;
  }, (Array.isArray(pcGet) ? pcGet : []).slice(0, 10));
  const shot = `data:image/png;base64,${(await page.screenshot({ fullPage: true })).toString('base64')}`;
  return { ...view, calls, gets, screenshot: shot };
}

// RELEASE available back orders onto an existing PenCarrie order (user, 2026-09-30: back orders
// don't ship on their own — they become "available to add to the current order"). This is the
// site's own "Add to order" button: POST /api/internal/backorders/{id}/ship/{orderCode}, one per
// line (read from the page's JS bundle, shipBackorders). Only lines PenCarrie marks available now,
// shippable and not special-order are sent. execute=false only LISTS what would go.
// After sending, the order is read back and each released SKU must appear on it with stock
// allocated — the POST's own 2xx is not taken as proof.
export async function shipBackorders(page, { orderCode, ids = null, execute = false } = {}) {
  if (!/^[A-Z0-9_]+$/i.test(String(orderCode || ''))) throw new Error('shipBackorders: orderCode required (e.g. TUWO_TW492805)');
  await page.goto(`${BASE}/orders/backorders`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  return page.evaluate(async ({ orderCode, ids, execute }) => {
    const csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
    const hdr = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-TOKEN': csrf };
    const getJ = async (p) => { const r = await fetch(p, { headers: hdr }); return { status: r.status, j: await r.json().catch(() => null) }; };
    const bo = await getJ('/api/internal/backorders?detail=false');
    if (bo.status !== 200 || !Array.isArray(bo.j)) return { ok: false, error: `backorders list HTTP ${bo.status}` };
    const target = await getJ(`/api/internal/orders/${orderCode}`);
    if (target.status !== 200 || !target.j) return { ok: false, error: `order ${orderCode} not readable (HTTP ${target.status})` };
    const t = target.j;
    if (!t.can_edit || t.despatched || t.cancelled) return { ok: false, error: `order ${orderCode} cannot take lines (status ${t.status}, can_edit ${t.can_edit}, despatched ${t.despatched})` };
    const want = bo.j.filter((b) => b.is_available && b.can_ship && !b.is_special_order && !b.locked
      && (!ids || ids.map(Number).includes(Number(b.id))));
    const lines = want.map((b) => ({ id: b.id, sku: b.sku, qty: (b.available || []).filter((a) => a.available_now).reduce((s, a) => s + (a.quantity || 0), 0) || b.backorder,
      fromOrder: b.order && b.order.code, fromRef: String((b.order && b.order.reference) || b.reference || '').trim(), lineRef: String(b.reference || '').trim() }));
    const notYet = bo.j.filter((b) => !want.includes(b)).map((b) => ({ id: b.id, sku: b.sku, fromRef: String((b.order && b.order.reference) || '').trim(), available: !!b.is_available, part: !!b.is_part_available }));
    if (!execute) return { ok: true, dryRun: true, orderCode, orderStatus: t.status, wouldShip: lines, notYet, csrf: !!csrf };
    const before = new Map((t.items || []).map((i) => [i.sku, i.quantity || 0]));
    const sent = [];
    for (const l of lines) {
      const r = await fetch(`/api/internal/backorders/${l.id}/ship/${orderCode}`, { method: 'POST', headers: hdr, body: '{}' });
      sent.push({ ...l, status: r.status, body: (await r.text().catch(() => '')).slice(0, 300) });
      await new Promise((res) => setTimeout(res, 500));
    }
    await new Promise((res) => setTimeout(res, 2500));
    const after = await getJ(`/api/internal/orders/${orderCode}`);
    const items = (after.j && after.j.items) || [];
    for (const s of sent) {
      const onOrder = items.filter((i) => i.sku === s.sku).reduce((a, i) => a + (i.quantity || 0), 0);
      s.verified = s.status < 300 && onOrder >= (before.get(s.sku) || 0) + s.qty;
      s.onOrderQty = onOrder;
    }
    const left = await getJ('/api/internal/backorders?detail=false');
    for (const s of sent) s.stillBackordered = Array.isArray(left.j) && left.j.some((b) => b.id === s.id);
    return { ok: sent.every((s) => s.verified), orderCode, orderStatus: after.j && after.j.status, net: after.j && after.j.net, sent, notYet };
  }, { orderCode, ids, execute: !!execute });
}

// The worker's contract expects these; this module never places anything.
export async function stage() { return { ready: false, note: 'read-only module — use opts.ordersList' }; }
export async function place() { throw new Error('pencarrieweb is read-only'); }
