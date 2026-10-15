// Brightpearl price list — delete a whole price list, as the Settings » Price lists page does.
//
// Why: the API cannot empty a price list. PUT .../product-price/{id}/price-list with an empty
// quantityPrice -> PRDC-031 "Price Break required"; a blank price -> PRDC-032. So a stale list
// (Cost (Snickers), id 10, used by nothing — 15 Oct 2026) can only go by deleting the list itself.
// The page's delete link calls deleteTableRow(id) -> DELETE ajaxData.php?op=deleteRow&table=price_lists&id=N.
//
// ONE LIST PER CALL. lines: [{ priceListId, expectName }]
//   opts.inspect  -> read the list's row (name, contacts/suppliers using it); changes nothing
//   execute:false -> same check, reports whether it WOULD delete
//   execute:true  -> deletes, reloads the page, and only counts it done if the row is gone
// Refuses unless the row's name equals expectName AND no contact or supplier uses the list.
import { config as bpConfig, login as bpLogin } from './brightpearl.js';

export const config = { ...bpConfig };
export const login = bpLogin;

const PAGE = () => `${config.base}/report.php?report_type=price_lists`;

async function readRow(page, id) {
  await page.goto(PAGE(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  return page.evaluate((id) => {
    const tr = document.getElementById(`row_${id}`)
      || [...document.querySelectorAll('tr')].find((t) => [...t.querySelectorAll('a')].some((a) => (a.getAttribute('onclick') || '').includes(`deleteTableRow(${id})`)));
    if (!tr) return null;
    const c = [...tr.cells].map((x) => x.innerText.trim());
    return { code: c[0], name: c[1], currency: c[3], isCost: c[4], contactsUsing: c[5], suppliersUsing: c[6] };
  }, id);
}

let pending = null;

function check(row, l) {
  if (!row) return 'price list row not found on the page';
  if (row.name !== l.expectName) return `row is "${row.name}", expected "${l.expectName}"`;
  if (row.contactsUsing || row.suppliersUsing) return `still in use (contacts ${row.contactsUsing || 0}, suppliers ${row.suppliersUsing || 0})`;
  return null;
}

export async function inspect(page, { lines }) {
  const l = lines[0];
  const row = await readRow(page, l.priceListId);
  return { priceListId: l.priceListId, row, refuse: check(row, l) };
}

export async function stage(page, { lines }) {
  if (!Array.isArray(lines) || lines.length !== 1) throw new Error('exactly one price list per call');
  const l = lines[0];
  if (!l.priceListId || !l.expectName) throw new Error('lines[0] needs priceListId and expectName');
  const row = await readRow(page, l.priceListId);
  const refuse = check(row, l);
  pending = refuse ? null : { id: l.priceListId, name: row.name };
  return { ready: !refuse, priceListId: l.priceListId, row, refuse };
}

export async function place(page) {
  if (!pending) throw new Error('stage() first');
  const resp = await page.evaluate(async (id) => {
    const extra = Object.entries(window.deleteParams || {}).map(([k, v]) => `&${k}=${v}`).join('');
    const r = await fetch(`ajaxData.php?op=deleteRow&table=price_lists&id=${id}${extra}`, { method: 'DELETE', credentials: 'include' });
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  }, pending.id);
  const after = await readRow(page, pending.id);
  return { placed: true, deleted: !after, priceListId: pending.id, name: pending.name, resp, rowAfter: after };
}
