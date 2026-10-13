// Brightpearl product screen — clear a product's `barcode` field, as a person would.
//
// Nothing else can: the API writes `ean` and silently ignores `barcode`, and Data Manager map 19
// SKIPS a blank Barcode cell (a single space too) rather than clearing it — tested 13 Oct 2026.
// Used to strip barcodes off archived/discontinued duplicates that clash with live products.
//
// lines: [{ productId, expectBarcode? }, ...]   (several products per call, done one by one)
//   opts.inspect  -> open lines[0]'s product page and report its identity fields; changes nothing
//   execute:false -> open each page and report what WOULD be cleared
//   execute:true  -> empty the barcode field, save, RELOAD and re-read it; only a reload that
//                    shows an empty field counts as done
// expectBarcode guards against clearing a number that has changed since the plan was made.
import { config as bpConfig, login as bpLogin } from './brightpearl.js';

export const config = { ...bpConfig };
export const login = bpLogin;

// The legacy product editor. Tried in order until one shows a barcode input.
const URLS = [
  (id) => `${config.base}/patt-op.php?scode=product&pID=${id}`,
  (id) => `${config.base}/patt-op.php?scode=product&product_id=${id}`,
  (id) => `${config.base}/patt-op.php?scode=product&action=edit&pID=${id}`,
];

const fields = (page) => page.evaluate(() => [...document.querySelectorAll('input,select,textarea')]
  .filter((e) => e.name && /barcode|ean|upc|isbn|mpn|sku/i.test(e.name + ' ' + e.id))
  .map((e) => ({ name: e.name, id: e.id, type: e.type, value: e.value, visible: !!(e.offsetWidth || e.offsetHeight) })));

async function openProduct(page, id) {
  const tried = [];
  for (const u of URLS) {
    const url = u(id);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const f = await fields(page);
    const bc = f.find((x) => /^barcode$|products_barcode|\bbarcode\b/i.test(x.name));
    tried.push({ url, title: await page.title(), fieldCount: f.length });
    if (bc) return { url, fields: f, barcodeField: bc };
  }
  return { url: null, tried };
}

export async function inspect(page, { lines }) {
  const id = lines && lines[0] && lines[0].productId;
  if (!id) throw new Error('lines[0].productId required');
  const o = await openProduct(page, id);
  const saves = await page.evaluate(() => [...document.querySelectorAll('a,button,input[type=submit]')]
    .filter((b) => /save|update/i.test((b.textContent || b.value || '') + ' ' + (b.getAttribute('onclick') || '')))
    .map((b) => ({ tag: b.tagName, text: (b.textContent || b.value || '').trim().slice(0, 40), onclick: (b.getAttribute('onclick') || '').slice(0, 80), id: b.id })).slice(0, 12));
  return { productId: id, ...o, saves };
}

async function clickSave(page) {
  const sel = ['a[onclick*="saveProduct"]', 'input[type=submit][value*="Save" i]', 'button:has-text("Save")', 'a.btn:has-text("Save")', 'input[type=submit]'];
  for (const s of sel) {
    const el = await page.$(s);
    if (el && (await el.isVisible().catch(() => false))) {
      await Promise.all([page.waitForLoadState('load', { timeout: 60000 }).catch(() => {}), el.click()]);
      await page.waitForTimeout(2000);
      return s;
    }
  }
  throw new Error('no Save control found on the product page');
}

let plan = [];

export async function stage(page, { lines }) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('lines[] required');
  plan = [];
  for (const l of lines) {
    const o = await openProduct(page, l.productId);
    if (!o.barcodeField) { plan.push({ productId: l.productId, skip: 'no barcode field found', tried: o.tried }); continue; }
    const cur = o.barcodeField.value;
    if (!cur) plan.push({ productId: l.productId, skip: 'already blank', url: o.url });
    else if (l.expectBarcode != null && String(l.expectBarcode).replace(/^0+/, '') !== String(cur).replace(/^0+/, '')) plan.push({ productId: l.productId, skip: `barcode is ${cur}, expected ${l.expectBarcode}`, url: o.url });
    else plan.push({ productId: l.productId, url: o.url, field: o.barcodeField.name, from: cur });
  }
  const todo = plan.filter((p) => !p.skip);
  return { ready: todo.length > 0, toClear: todo.length, skipped: plan.length - todo.length, plan };
}

export async function place(page) {
  const done = [];
  for (const p of plan.filter((x) => !x.skip)) {
    try {
      await page.goto(p.url, { waitUntil: 'domcontentloaded' });
      await page.fill(`[name="${p.field}"]`, '');
      const via = await clickSave(page);
      await page.goto(p.url, { waitUntil: 'domcontentloaded' });            // fresh read
      const after = await page.$eval(`[name="${p.field}"]`, (e) => e.value).catch(() => null);
      done.push({ productId: p.productId, from: p.from, after, cleared: after === '', via });
    } catch (e) { done.push({ productId: p.productId, from: p.from, error: e.message }); }
  }
  return { placed: true, cleared: done.filter((d) => d.cleared).length, failed: done.filter((d) => !d.cleared).length, done };
}
