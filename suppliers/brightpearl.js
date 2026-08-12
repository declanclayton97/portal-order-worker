// Brightpearl — NOT a supplier portal. This module exists because Brightpearl's own order
// screen is the ONLY thing that can write certain order fields.
//
// Why a browser at all: the delivery mobile on an order cannot be set any other way.
//   PATCH /order-service/order/{id}  /parties/delivery/mobileTelephone -> CMNC-043 "not supported"
//   order party sub-resources (/party, /parties, /party/delivery)      -> 404, do not exist
//   pageLock -> ajaxData.php?op=order:validateOrder with delivery_mobile -> 200s, changes NOTHING
//   contact-service/postal-address/{id}                                 -> holds no phone fields
// The order keeps its own phone snapshot, taken at import and independent of the contact,
// and Brightpearl silently discards every HTTP attempt to change it. A real browser works
// because it IS the UI rather than an imitation of it.
//
// eBay is the case that matters: it fills `telephone` on all three parties and leaves every
// mobile empty, so delivery notifications reach nobody.
//
// ONE ORDER PER CALL. The worker's contract is stage() then place(), so lines[0] is used and
// any extra entries are rejected rather than silently skipped.
//   lines: [{ orderId, mobile? }]   mobile omitted -> derived from the order's own telephone
//   execute:false -> fills the field and reports, saves nothing (the field is left dirty in a
//                    throwaway browser, so nothing persists)

export const config = {
  base: process.env.BP_WEB_HOST || 'https://euw1.brightpearlapp.com',
  client: process.env.BP_WEB_CLIENT_ID || 'tuffworkwear',
  envUser: 'BP_WEB_EMAIL',
  envPass: 'BP_WEB_PASSWORD',
};

// Which order fields may be written. Defaults to delivery only — that is the one the
// delivery notifications read; filling the other two would be noise on the order.
const FIELDS = { delivery: 'delivery_mobile', customer: 'customer_mobile', billing: 'billing_mobile' };

/**
 * A clean UK mobile (07xxxxxxxxx) from whatever a human typed, or null.
 * Letters and "/,;&|" start a NEW candidate; spaces and hyphens do NOT, because they occur
 * inside single numbers ("07580 876717"). Landlines and non-UK numbers return null and are
 * never written — a landline in a mobile field makes a record look fixed while the text
 * still silently fails. Mirrors shipUkMobile_ in the eBay Apps Script.
 */
export function ukMobile(raw) {
  if (raw == null) return null;
  for (const seg of String(raw).split(/[A-Za-z]+|[/,;&|]+/)) {
    let d = seg.replace(/[^\d+]/g, '').replace(/^\+/, '');
    if (!d) continue;
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('44')) {
      d = d.slice(2);
      if (d.startsWith('0')) d = d.slice(1); // "+44 (0)7123..." leaves a trunk 0 behind
      d = '0' + d;
    } else if (d[0] === '7' && d.length === 10) {
      d = '0' + d;
    }
    if (/^07\d{9}$/.test(d)) return d;
  }
  return null;
}

const orderUrl = (orderId) => `${config.base}/patt-op.php?scode=invoice&oID=${encodeURIComponent(orderId)}`;

/**
 * The phone fields live on the "Addresses" jQuery-UI tab, which starts collapsed
 * (div#invoice-addresses carries ui-tabs-hide, display:none). The inputs are in the DOM
 * the whole time — which is why reading them works without this — but Playwright rightly
 * refuses to type into a hidden field, so the tab has to be opened first, exactly as a
 * person would.
 */
async function openAddressesTab(page) {
  const tab = 'a[href="#invoice-addresses"]';
  if (!(await page.$(tab))) {
    const diag = await page.evaluate(() => ({ tabs: [...document.querySelectorAll('#invoice-tabs-wrapper a[href^="#"]')].map((a) => a.getAttribute('href')).slice(0, 10) }));
    throw new Error(`Addresses tab not found — ${JSON.stringify(diag)}`);
  }
  await page.click(tab);
  // wait for the panel to actually be shown rather than assuming the click landed
  await page.waitForSelector('#delivery_mobile', { state: 'visible', timeout: 10000 });
}

export async function login(page, { user, pass }) {
  // The legacy form, not the Sage SPA. Landing on admin_login.php directly keeps us on the
  // old login; the SPA at "/" is a React app that this flow cannot drive.
  await page.goto(`${config.base}/admin_login.php?clients_id=${encodeURIComponent(config.client)}`, { waitUntil: 'domcontentloaded' });

  const emailSel = 'input[name="email_address"]';
  const passSel = 'input[name="password"]';
  if (!(await page.$(passSel))) {
    const diag = await page.evaluate(() => ({ url: location.href, title: document.title,
      inputs: [...document.querySelectorAll('input')].map((e) => `${e.type}:${e.name || e.id}`).slice(0, 12) }));
    throw new Error(`Brightpearl legacy login form not found — ${JSON.stringify(diag)}`);
  }
  await page.fill(emailSel, user);
  await page.fill(passSel, pass);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.click('input[type=submit], button[type=submit]').catch(() => {}),
  ]);
  await page.waitForTimeout(800);

  // #profile-user-name is the signed-in user in the header nav; its absence means the
  // credentials failed or we were bounced to the SPA login.
  const who = await page.$eval('#profile-user-name', (e) => e.textContent.trim()).catch(() => null);
  if (!who) {
    const diag = await page.evaluate(() => ({ url: location.href, title: document.title,
      err: /invalid|incorrect|failed|try again/i.test(document.body.innerText) }));
    throw new Error(`Brightpearl login failed for ${(user || '').slice(0, 4)}*** — ${JSON.stringify(diag)}`);
  }
  return { signedInAs: who };
}

/** Read an order's phone fields without changing anything. */
export async function inspect(page, { lines }) {
  const orderId = (lines && lines[0] && lines[0].orderId) || null;
  if (!orderId) throw new Error('lines[0].orderId required');
  await page.goto(orderUrl(orderId), { waitUntil: 'domcontentloaded' });
  const found = await page.evaluate((F) => {
    const val = (n) => { const e = document.querySelector(`input[name="${n}"]`); return e ? e.value : null; };
    return {
      title: document.title,
      status: (() => { const s = document.getElementById('titleOrderStatus'); return s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : null; })(),
      customer: { telephone: val('customer_telephone'), mobile: val(F.customer) },
      billing: { telephone: val('billing_telephone'), mobile: val(F.billing) },
      delivery: { telephone: val('delivery_telephone'), mobile: val(F.delivery) },
    };
  }, FIELDS);
  return { orderId, ...found };
}

/**
 * Open the order and type the mobile in. Saves nothing — place() does that.
 * opts.parties: which of delivery|customer|billing to fill (default delivery).
 */
export async function stage(page, { lines, parties }) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('lines[] required');
  if (lines.length > 1) throw new Error(`one order per call — got ${lines.length} lines`);
  const { orderId } = lines[0];
  if (!orderId) throw new Error('lines[0].orderId required');
  const want = (typeof parties === 'string' ? parties.split(',') : parties || ['delivery'])
    .map((s) => String(s).trim()).filter((p) => FIELDS[p]);
  if (!want.length) throw new Error('no valid parties requested');

  await page.goto(orderUrl(orderId), { waitUntil: 'domcontentloaded' });
  if (!(await page.$('#total_net'))) {
    const diag = await page.evaluate(() => ({ url: location.href, title: document.title }));
    throw new Error(`order ${orderId} page did not load an editable order — ${JSON.stringify(diag)}`);
  }
  await openAddressesTab(page);

  const before = await inspectCurrent(page);
  const filled = [];
  for (const p of want) {
    const name = FIELDS[p];
    const current = before[p] ? before[p].mobile : null;
    // an explicit mobile wins; otherwise take this party's OWN telephone
    const target = ukMobile(lines[0].mobile) || ukMobile(current) || ukMobile(before[p] && before[p].telephone);
    if (!target) { filled.push({ party: p, field: name, skipped: 'no UK mobile available (landline/non-UK/blank)' }); continue; }
    if (ukMobile(current) === target) { filled.push({ party: p, field: name, skipped: 'already correct', value: current }); continue; }
    const ok = await page.$(`input[name="${name}"]`);
    if (!ok) { filled.push({ party: p, field: name, skipped: 'field not on this page' }); continue; }
    await page.fill(`input[name="${name}"]`, target);
    filled.push({ party: p, field: name, from: current || '', set: target });
  }
  const ready = filled.some((f) => f.set);
  return { orderId, status: before.status, before, filled, ready,
    note: ready ? undefined : 'nothing to change — place() will not run' };
}

async function inspectCurrent(page) {
  return page.evaluate((F) => {
    const val = (n) => { const e = document.querySelector(`input[name="${n}"]`); return e ? e.value : null; };
    return {
      status: (() => { const s = document.getElementById('titleOrderStatus'); return s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : null; })(),
      customer: { telephone: val('customer_telephone'), mobile: val(F.customer) },
      billing: { telephone: val('billing_telephone'), mobile: val(F.billing) },
      delivery: { telephone: val('delivery_telephone'), mobile: val(F.delivery) },
    };
  }, FIELDS);
}

/**
 * Click Save changes and confirm it stuck.
 *
 * The button is an <a> running saveInvoice(), which fires a credit-limit XHR and then
 * submits the form — so match on the handler, not on a button id (those differ between
 * pages) or the label. Afterwards the page is RELOADED and the field re-read: every
 * HTTP attempt at this returned a happy status while changing nothing, so a save is only
 * believed once the value is still there on a fresh load.
 */
export async function place(page) {
  const btn = 'a[onclick*="saveInvoice"]';
  if (!(await page.$(btn))) {
    const diag = await page.evaluate(() => ({ url: location.href,
      btns: [...document.querySelectorAll('a.btn')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()).slice(0, 10) }));
    throw new Error(`Save changes button not found — ${JSON.stringify(diag)}`);
  }
  const url = page.url();
  await Promise.all([
    page.waitForLoadState('load').catch(() => {}),
    page.click(btn).catch(() => {}),
  ]);
  await page.waitForTimeout(2500);        // the save posts after an async validation call

  await page.goto(url, { waitUntil: 'domcontentloaded' });   // fresh read, no cached DOM
  const after = await inspectCurrent(page);
  return { placed: true, after };
}
