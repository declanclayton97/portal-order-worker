// Brightpearl product screen — blank ONE price list on each product, as a person would:
// Prices tab, pick the list in the dropdown, empty its boxes, Save.
//
// Why: the API cannot empty a price list entry. PUT .../product-price/{id}/price-list with an empty
// quantityPrice -> PRDC-031 "Price Break required"; a blank price -> PRDC-032. Dec wants the stale
// Cost (Snickers) list (id 10, select code CostSnickers) cleared per product, not the list deleted
// (16 Oct 2026). Proved by hand on product 358642: blank prices[10][0], saveAndStay(), the API then
// showed list 10 empty and lists 3/13/20 untouched.
//
// lines: [{ productId, expectSku, expectPrice }]   opts: { priceListId, listCode }
//   opts.inspect  -> open lines[0] (listId/listCode on the line) and report the page; changes nothing
//   execute:false -> checks the lines are well formed; opens nothing
//   execute:true  -> clear, save, reload and re-read; only an empty box after the reload counts
//
// SAFETY: saving the editor posts the WHOLE form. A form the script has not filled would save blanks
// over the product, so nothing is saved unless the page shows this product's own SKU in
// products_model AND the chosen list's first box holds expectPrice (to the penny). Anything else is
// skipped and reported, never "fixed".
import { config as bpConfig, login as bpLogin } from './brightpearl.js';

export const config = { ...bpConfig };
export const login = bpLogin;

const editor = (id) => `${config.base}/patt-op.php?scode=product&pID=${id}&action=new_product`;

async function open(page, id, listId, listCode) {
  // The editor fills itself by script and is sometimes not there on the first load: one reload.
  let o = await openOnce(page, id, listId, listCode);
  if (o.error === 'no price list dropdown') o = await openOnce(page, id, listId, listCode);
  return o;
}

async function openOnce(page, id, listId, listCode) {
  await page.goto(editor(id), { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('price_group_code') && document.getElementsByName('products_model')[0], null, { timeout: 30000 }).catch(() => {});
  return page.evaluate(async ({ listId, listCode }) => {
    const sku = (document.getElementsByName('products_model')[0] || {}).value;
    const sel = document.getElementById('price_group_code');
    if (!sel) return { sku, error: 'no price list dropdown', url: location.pathname + location.search, title: document.title };
    if (![...sel.options].some((o) => o.value === listCode)) return { sku, error: `dropdown has no ${listCode}` };
    sel.value = listCode;
    if (window.jQuery) window.jQuery(sel).trigger('change'); else sel.dispatchEvent(new Event('change', { bubbles: true }));
    let box = null;
    for (let i = 0; i < 40 && !(box = document.getElementsByName(`prices[${listId}][0]`)[0]); i++) await new Promise((r) => setTimeout(r, 250));
    if (!box) return { sku, error: `prices[${listId}] boxes never appeared` };
    const vals = [...document.querySelectorAll(`[name^="prices[${listId}]["]`)].map((e) => e.value);
    return { sku, vals, title: document.title };
  }, { listId, listCode });
}

const samePrice = (a, b) => a !== '' && a != null && Math.abs(Number(a) - Number(b)) < 0.005;

function verdict(l, o) {
  if (o.error) return o.error;
  if (String(o.sku || '').trim().toUpperCase() !== String(l.expectSku).trim().toUpperCase()) return `page SKU "${o.sku}" is not ${l.expectSku}`;
  if (!o.vals.some((v) => v !== '')) return 'already blank';
  if (!samePrice(o.vals[0], l.expectPrice)) return `price is ${o.vals[0]}, expected ${l.expectPrice}`;
  return null;
}

let job = null;

export async function inspect(page, { lines }) {
  const l = lines[0];
  const o = await open(page, l.productId, l.listId || 10, l.listCode || 'CostSnickers');
  return { productId: l.productId, page: o, refuse: verdict(l, o) };
}

export async function stage(page, { lines, priceListId, listCode }) {
  if (!priceListId || !listCode) throw new Error('opts.priceListId and opts.listCode required');
  if (!Array.isArray(lines) || !lines.length) throw new Error('lines[] required');
  const bad = lines.filter((l) => !l.productId || !l.expectSku || l.expectPrice == null);
  if (bad.length) throw new Error(`${bad.length} line(s) missing productId/expectSku/expectPrice`);
  job = { listId: priceListId, listCode, lines };
  // Every page check happens in place(), product by product, right before its save.
  return { ready: true, count: lines.length, listId: priceListId, listCode };
}

export async function place(page) {
  if (!job) throw new Error('stage() first');
  const { listId, listCode } = job;
  const done = [];
  for (const l of job.lines) {
    try {
      const o = await open(page, l.productId, listId, listCode);
      const why = verdict(l, o);
      if (why) { done.push({ productId: l.productId, skip: why }); continue; }
      await page.evaluate((listId) => { for (const e of document.querySelectorAll(`[name^="prices[${listId}]["]`)) e.value = ''; }, listId);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => {}),
        page.evaluate(() => setTimeout(() => window.saveAndStay(), 50)),
      ]);
      const after = await open(page, l.productId, listId, listCode);
      const cleared = !after.error && String(after.sku || '').toUpperCase() === String(l.expectSku).toUpperCase() && after.vals.every((v) => v === '');
      done.push({ productId: l.productId, from: o.vals[0], cleared, after: after.error || after.vals[0] });
    } catch (e) { done.push({ productId: l.productId, error: e.message }); }
  }
  return {
    placed: true,
    cleared: done.filter((d) => d.cleared).length,
    skipped: done.filter((d) => d.skip).length,
    failed: done.filter((d) => !d.cleared && !d.skip).length,
    done,
  };
}
