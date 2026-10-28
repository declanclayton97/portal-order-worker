// Brightpearl Product list — permanently DELETE archived products, as a person would.
//
// The public API has no product DELETE (27 Oct 2026: DELETE /product-service/product/{id} answers
// CMNC-404 "Cannot find the resource" and the product stays). The UI does it: Products > List,
// tick rows, then the "Delete" button beside "Batch update". BP refuses any product with
// transactions; those rows simply survive and the caller's API re-read reports them as kept.
//
// lines: [{ productId, expectSku }, ...]
//   opts.inspect  -> open the list (opts.url, or a quick search for lines[0].expectSku) and report
//                    its filter form, row checkboxes, paging and Delete control; changes nothing
//   execute:false -> find each product's row and report what WOULD be ticked
//   execute:true  -> tick exactly those rows, click Delete, accept the confirm, reload and report
//                    which rows are gone. Only the caller's API re-read counts as proof.
// SAFETY: a row is ticked only when BOTH its product id and its SKU match a line. Nothing is ever
// ticked by "select all".
import { config as bpConfig, login as bpLogin } from './brightpearl.js';

export const config = { ...bpConfig };
export const login = bpLogin;

// The quick search only lists Live + Discontinued (28 Oct 2026: a whole night of "row not found");
// the filter form's own params with ARCHIVED alone list only archived products.
const searchUrl = (q) => `${config.base}/report.php?report_type=product_list&report_submit=1&search_products=${encodeURIComponent(q)}&productStatusId%5B%5D=ARCHIVED&multiselect_productStatusId=ARCHIVED&limit=50&results_from=1&output=screen`;

// Every row on the list: its checkbox, the product id shown under the SKU, and the SKU text.
const readRows = (page) => page.evaluate(() => {
  const out = [];
  for (const tr of document.querySelectorAll('tr')) {
    const cb = tr.querySelector('input[type=checkbox]');
    if (!cb) continue;
    // product rows carry checkbox name/id "checkBox_<productId>" (seen 27 Oct 2026); filter widgets don't
    const idm = String(cb.name || '').match(/^checkBox_(\d+)$/);
    if (!idm) continue;
    const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
    out.push({ cbName: cb.name, cbValue: cb.value, cbId: cb.id, sku: (cells[1] || '').split('\n')[0].replace(/[ \s]+/g, ' ').trim(), productId: Number(idm[1]), name: (cells[2] || '').split('\n')[0].trim() });
  }
  return out;
});

export async function inspect(page, { lines }) {
  const url = (lines[0] && lines[0].url) || searchUrl((lines[0] && lines[0].expectSku) || '');
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  const info = await page.evaluate(() => {
    const ctl = (e) => ({ tag: e.tagName, type: e.type, name: e.name, id: e.id, value: String(e.value || '').slice(0, 40), text: (e.innerText || e.value || '').trim().slice(0, 40), onclick: (e.getAttribute('onclick') || '').slice(0, 160), href: (e.getAttribute('href') || '').slice(0, 160), visible: !!(e.offsetWidth || e.offsetHeight) });
    const forms = [...document.forms].map((f) => ({ name: f.name, id: f.id, action: f.action, method: f.method, fields: [...f.elements].filter((e) => e.name).map((e) => ({ name: e.name, type: e.type, value: String(e.value).slice(0, 30), options: e.options ? [...e.options].slice(0, 12).map((o) => o.value + '=' + o.text.trim()) : undefined })).slice(0, 60) }));
    const deletes = [...document.querySelectorAll('a,button,input')].filter((e) => /delete/i.test((e.innerText || e.value || '') + ' ' + (e.getAttribute('onclick') || '') + ' ' + (e.id || ''))).map(ctl).slice(0, 10);
    const paging = [...document.querySelectorAll('a,select')].filter((e) => /page|limit|per|results|start|offset/i.test((e.name || '') + ' ' + (e.getAttribute('href') || '') + ' ' + (e.className || ''))).map(ctl).slice(0, 15);
    const scripts = [...document.querySelectorAll('script:not([src])')].map((s) => s.textContent).filter((t) => /delete/i.test(t)).map((t) => { const i = t.search(/delete/i); return t.slice(Math.max(0, i - 300), i + 600); }).slice(0, 3);
    const fn = (n) => (typeof window[n] === 'function' ? String(window[n]).slice(0, 2500) : null);
    return { title: document.title, url: location.href, forms, deletes, paging, scripts, deleteFn: fn('deleteSelectedProducts'), batchFn: fn('batchAction') || fn('doBatchAction') };
  });
  const rows = await readRows(page);
  const shot = 'data:image/png;base64,' + (await page.screenshot({ fullPage: false })).toString('base64');
  return { ...info, rows: rows.slice(0, 20), rowCount: rows.length, shot };
}

let plan = [];

export async function stage(page, { lines }) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('lines[] required');
  const bad = lines.filter((l) => !l.productId || !l.expectSku);
  if (bad.length) throw new Error(`${bad.length} line(s) missing productId/expectSku`);
  // place() finds and checks each row itself; searching here too would double the page loads.
  plan = lines.map((l) => ({ productId: Number(l.productId), sku: String(l.expectSku).trim() }));
  const todo = plan.filter((p) => !p.skip);
  return { ready: todo.length > 0, toDelete: todo.length, skipped: plan.length - todo.length, plan };
}

// One product per search page, so a tick can never land on a neighbour: search, tick the one row
// that matches id+SKU, Delete, accept the confirm, search again and see if the row is gone.
export async function place(page) {
  const done = [];
  let dialogText = null;
  // BP's delete asks via confirm() or a prompt() that wants DELETE typed in capitals.
  page.on('dialog', async (d) => { dialogText = `${d.type()}: ${d.message()}`; await (d.type() === 'prompt' ? d.accept('DELETE') : d.accept()).catch(() => {}); });
  for (const p of plan.filter((x) => !x.skip)) {
    try {
      dialogText = null;
      await page.goto(searchUrl(p.sku), { waitUntil: 'networkidle', timeout: 90000 });
      const rows = await readRows(page);
      const hit = rows.filter((r) => r.productId === Number(p.productId) && r.sku.toUpperCase() === String(p.sku).toUpperCase());
      if (hit.length !== 1) { done.push({ productId: p.productId, skip: 'row not found at delete time' }); continue; }
      // Product rows are the checkBox_<id> boxes; the page's filter widgets are checkboxes too and
      // some are ticked by default, so only product boxes are touched or counted.
      await page.$$eval('input[type=checkbox][name^="checkBox_"]', (cbs) => cbs.forEach((c) => { if (c.checked) c.click(); }));
      await page.check(`input[type=checkbox][name="checkBox_${p.productId}"]`);
      const ticked = await page.$$eval('input[type=checkbox][name^="checkBox_"]:checked', (cbs) => cbs.map((c) => c.name));
      if (ticked.length !== 1 || ticked[0] !== `checkBox_${p.productId}`) { done.push({ productId: p.productId, error: `ticked ${ticked.join(',') || 'nothing'}, expected only checkBox_${p.productId} - not deleted` }); continue; }
      const del = page.locator('a,button,input').filter({ hasText: /^\s*Delete\s*$/ }).first();
      const delCount = await del.count();
      const btn = delCount ? del : page.locator('input[value="Delete"]').first();
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {}), btn.click({ timeout: 15000 })]);
      await page.waitForTimeout(2500);
      // a BP-styled (non-native) confirm box: press its OK/Yes/Delete if one is showing
      const modalOk = page.locator('.modal:visible button, .ui-dialog:visible button, [role=dialog]:visible button').filter({ hasText: /^(ok|yes|delete|confirm)$/i }).first();
      let modalText = null;
      if (await modalOk.count().catch(() => 0)) { modalText = await page.locator('.modal:visible, .ui-dialog:visible, [role=dialog]:visible').first().innerText().catch(() => null); await modalOk.click().catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {}); await page.waitForTimeout(2000); }
      const notice = await page.evaluate(() => [...document.querySelectorAll('.alert,.error,.message,.notice,.success,#messageStack,.messageStack')].map((e) => e.innerText.trim()).filter(Boolean).join(' | ').slice(0, 300));
      // The post-delete page is the same search; the row being absent there is a hint only - the
      // caller's API re-read is the proof.
      const still = (await readRows(page)).some((r) => r.productId === Number(p.productId));
      done.push({ productId: p.productId, sku: p.sku, gone: !still, dialog: dialogText, modal: modalText && modalText.slice(0, 200), notice });
    } catch (e) { done.push({ productId: p.productId, sku: p.sku, error: e.message.slice(0, 200) }); }
  }
  return { placed: true, gone: done.filter((d) => d.gone).length, kept: done.filter((d) => !d.gone).length, done };
}
