// Brightpearl — delete a PLACEHOLDER line from a sales order, through the real order screen.
//
// Why a browser: the public API refuses to delete a line from a PAID order (ORDC-053 "Order
// has payments"), and every plain-HTTP imitation of the order screen's save returns a happy
// status while changing nothing (tried five ways, Aug 2026). The screen itself works: hovering
// a line shows an × (td.col-tools a.delete) which removes it from the page, and "Save changes"
// then stores the order without it.
//
// WHAT IT WILL DELETE — and nothing else, whatever it is asked:
//   a line whose product is 1000 (the free-text "misc" product), whose description is exactly
//   "-", and whose price is 0.00. That is the placeholder add-variant-live leaves behind when it
//   moves a "NEEDS ADDING" line onto the real product. A request for any other line is refused
//   before anything is clicked.
//
// Contract (worker stage/place): lines: [{ orderId, rowId }] — one order per call; several rows
// of the same order may be listed. execute:false -> finds and checks the lines, deletes nothing.
// After saving, the order is reloaded and the lines must be GONE and the net total UNCHANGED,
// otherwise the result says so.

import { config as bpConfig, login as bpLogin } from './brightpearl.js';

export const config = { ...bpConfig };
export const login = bpLogin;

const orderUrl = (orderId) => `${config.base}/patt-op.php?scode=invoice&oID=${encodeURIComponent(orderId)}`;

// Everything we need to judge a line, read from the page itself.
async function readLines(page) {
  return page.evaluate(() => {
    const val = (root, sel) => { const e = root.querySelector(sel); return e ? e.value : null; };
    const rows = [...document.querySelectorAll('tr.detailsTr')].map((tr) => {
      const idBox = tr.querySelector('input[name^="ids["]');
      const rowId = idBox ? (idBox.name.match(/ids\[(\d+)\]/) || [])[1] : null;
      return {
        trId: tr.id, rowId,
        productId: val(tr, 'input[name="products_id[]"]'),
        details: val(tr, 'input[name="details[]"]'),
        itemnet: val(tr, 'input[name="itemnet[]"]'),
        qty: val(tr, 'input[name="qty[]"]'),
      };
    });
    const net = document.getElementById('total_net');
    return { rows, totalNet: net ? net.value : null, title: document.title };
  });
}

const isPlaceholder = (r) => r && String(r.productId) === '1000' && String(r.details || '').trim() === '-'
  && Number(String(r.itemnet || '0').replace(/[^\d.-]/g, '')) === 0;

export async function stage(page, { lines }) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('lines[] required');
  const orderId = lines[0].orderId;
  if (!orderId || lines.some((l) => String(l.orderId) !== String(orderId))) throw new Error('one order per call');
  const wanted = [...new Set(lines.map((l) => String(l.rowId)).filter(Boolean))];
  if (!wanted.length) throw new Error('lines[].rowId required');

  await page.goto(orderUrl(orderId), { waitUntil: 'domcontentloaded' });
  if (!(await page.$('#total_net'))) {
    const diag = await page.evaluate(() => ({ url: location.href, title: document.title }));
    throw new Error(`order ${orderId} page did not load an editable order — ${JSON.stringify(diag)}`);
  }
  const before = await readLines(page);
  const checks = wanted.map((rowId) => {
    const r = before.rows.find((x) => x.rowId === rowId);
    if (!r) return { rowId, ok: false, reason: 'line not on this order' };
    if (!isPlaceholder(r)) return { rowId, ok: false, reason: 'not a "-" £0 placeholder — refusing', line: { productId: r.productId, details: r.details, net: r.itemnet } };
    return { rowId, ok: true, trId: r.trId };
  });
  if (before.rows.length - checks.filter((c) => c.ok).length < 1) throw new Error('refusing: an order must keep at least one line');
  // Handed to place() on the page object — the worker passes place() only { ref }.
  page.__bprow = { orderId, targets: checks.filter((c) => c.ok), before };
  return {
    orderId, title: before.title, linesBefore: before.rows.length, totalNetBefore: before.totalNet,
    checks, ready: checks.length > 0 && checks.every((c) => c.ok),
  };
}

export async function place(page) {
  const st = page.__bprow;
  if (!st || !st.targets.length) throw new Error('stage() found nothing to delete');
  page.on('dialog', (d) => d.accept().catch(() => {}));   // "are you sure?" — we checked above

  for (const t of st.targets) {
    const row = page.locator(`tr#${t.trId}`);
    await row.hover();
    const del = row.locator('a.delete');
    if (!(await del.count())) throw new Error(`no delete control on line ${t.rowId}`);
    await del.first().click({ force: true });
    await page.waitForSelector(`input[name="ids[${t.rowId}]"]`, { state: 'detached', timeout: 10000 });
  }
  const mid = await readLines(page);
  if (mid.totalNet !== st.before.totalNet) {
    throw new Error(`net total moved on the page before saving (${st.before.totalNet} -> ${mid.totalNet}) — NOT saved`);
  }

  // Save — the same handler the delivery-mobile module uses.
  const btn = 'a[onclick*="saveInvoice"]';
  if (!(await page.$(btn))) throw new Error('Save changes button not found');
  await Promise.all([page.waitForLoadState('load').catch(() => {}), page.click(btn).catch(() => {})]);
  await page.waitForTimeout(3000);

  // Believe it only on a fresh load.
  await page.goto(orderUrl(st.orderId), { waitUntil: 'domcontentloaded' });
  const after = await readLines(page);
  const stillThere = st.targets.filter((t) => after.rows.some((r) => r.rowId === t.rowId)).map((t) => t.rowId);
  return {
    placed: stillThere.length === 0,
    deleted: st.targets.map((t) => t.rowId).filter((id) => !stillThere.includes(id)),
    stillThere,
    linesAfter: after.rows.length,
    totalNetBefore: st.before.totalNet, totalNetAfter: after.totalNet,
    totalUnchanged: after.totalNet === st.before.totalNet,
  };
}
