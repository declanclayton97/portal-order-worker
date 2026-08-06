// Sterling Safetywear — sterling.famlive.net (server-side ASP.NET WebForms shop; NOT
// the sterlingsafetywear.famlive.net localStorage app). Playwright drives it: login →
// per line: search the style name → open the matching result → set qty in the right
// size box → Submit (add) → then Checkout → place. The backend resolves each line's EAN
// (via sterlingProducts.json) to { search, colour, size, qty } before calling us.
//
// Selectors verified on the live site 2026-08-06; the result-click + size-box mapping
// are refined during dry-runs (stage() returns matched/unmatched + a screenshot).

export const config = {
  base: process.env.STERLING_BASE || 'https://sterling.famlive.net',
  envUser: 'STERLING_USER',
  envPass: 'STERLING_PASS',
};

export async function login(page, { user, pass }) {
  await page.goto(`${config.base}/styles.aspx?f=0`, { waitUntil: 'domcontentloaded' });
  // locate the login fields (email + password) even if IDs differ on the dedicated page
  const emailSel = (await page.$('#ctl00_Login1_UserName')) ? '#ctl00_Login1_UserName' : 'input[type=text][name*="UserName"], input[id*="UserName"], input[type=email]';
  const passSel = (await page.$('#ctl00_Login1_Password')) ? '#ctl00_Login1_Password' : 'input[type=password]';
  const btnSel = (await page.$('#ctl00_Login1_LoginButton')) ? '#ctl00_Login1_LoginButton' : 'input[type=submit][value*="Log" i], input[value="Log In"]';
  let attempted = false;
  if (await page.$(passSel)) {
    attempted = true;
    await page.fill(emailSel, user).catch(() => {});
    await page.fill(passSel, pass).catch(() => {});
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click(btnSel).catch(() => {})]);
    await page.waitForTimeout(500);
  }
  if (!(await page.$('#ctl00_btnLogout'))) {
    const diag = await page.evaluate(() => ({
      url: location.href,
      hasError: /invalid|incorrect|not recognised|failed|try again/i.test(document.body.innerText),
      inputs: [...document.querySelectorAll('input')].filter((e) => !/^__|VIEWSTATE/i.test(e.name || e.id || '')).map((e) => `${e.type}:${e.id || e.name}`).slice(0, 12),
    }));
    throw new Error(`Sterling login failed (attempted=${attempted}, user=${(user || '').slice(0, 3)}***) — ${JSON.stringify(diag)}`);
  }
}

// Derive a good search term from the resolved style name: drop a leading/trailing colour
// word and trailing size digits, so "Brown Challenger 3" -> "Challenger", "APKHTBlack" ->
// "APKHT". Falls back to the whole string.
function searchTerm(search, colour) {
  let s = String(search || '').trim();
  if (colour) { const c = String(colour).split('/')[0]; s = s.replace(new RegExp(`\\b${c}\\b`, 'ig'), '').trim(); s = s.replace(new RegExp(c, 'ig'), '').trim(); }
  s = s.replace(/\b\d+\b\s*$/,'').trim();          // trailing size number
  return s || String(search || '').trim();
}

async function cartCount(page) {
  const t = await page.textContent('#cart').catch(() => '');
  const m = String(t || '').match(/(\d+)/); return m ? Number(m[1]) : 0;
}

// Add ONE line to the basket. Returns { ok, reason }.
async function addLine(page, line) {
  const q = searchTerm(line.search, line.colour);
  // search
  await page.fill('#ctl00_txtsearch', q);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('#ctl00_btnsearch')]);
  await page.waitForTimeout(400);
  if (await page.$('text=/no results matching/i')) return { ok: false, reason: `no results for "${q}"` };
  // open the matching result — prefer one whose text includes the colour, else the first
  const results = await page.$$('a[href*="createorder"], [id*="rpStyle"] a, .style a');
  let target = null;
  for (const a of results) { const txt = ((await a.textContent()) || '').toLowerCase(); if (line.colour && txt.includes(String(line.colour).split('/')[0].toLowerCase())) { target = a; break; } }
  if (!target && results.length) target = results[0];
  if (!target) { // some results are image tiles with an onclick postback
    const tile = await page.$(`text=/${q}/i`);
    if (tile) target = tile;
  }
  if (!target) return { ok: false, reason: `result not clickable for "${q}"` };
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), target.click()]);
  await page.waitForTimeout(400);
  // size grid: find the size column, then the qty box in the matching colour block
  const set = await page.evaluate(({ size, colour, qty }) => {
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '');
    // header sizes: the row of size labels above the qty boxes
    const qboxes = [...document.querySelectorAll('input[id*="txtqty"]')];
    if (!qboxes.length) return { ok: false, reason: 'no size grid' };
    // build size -> index from the nearest header row cells
    const tbl = qboxes[0].closest('table');
    const headerCells = tbl ? [...tbl.querySelectorAll('th, td')].map((c) => c.innerText.trim()).filter(Boolean) : [];
    const wantS = norm(size).replace(/uk$/,'');
    // match a qty box whose column header equals our size
    let idx = headerCells.findIndex((h) => norm(h) === wantS);
    if (idx < 0) idx = headerCells.findIndex((h) => norm(h).includes(wantS) || wantS.includes(norm(h)));
    // map header index to the qty box of the same visual column (best-effort: same index)
    const box = qboxes[idx] || null;
    if (!box) return { ok: false, reason: `size ${size} not found (headers: ${headerCells.slice(0, 20).join(',')})` };
    box.value = String(qty);
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, boxId: box.id };
  }, { size: line.size, colour: line.colour, qty: line.qty });
  if (!set.ok) return set;
  // Submit adds the style to the basket
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('#ctl00_ContentPlaceHolder1_SubmitOrder')]);
  await page.waitForTimeout(400);
  return { ok: true, boxId: set.boxId };
}

export async function stage(page, { lines }) {
  const results = [];
  for (const line of lines) {
    try { results.push({ line: line.search, size: line.size, qty: line.qty, ...(await addLine(page, line)) }); }
    catch (e) { results.push({ line: line.search, size: line.size, qty: line.qty, ok: false, reason: e.message }); }
  }
  const added = results.filter((r) => r.ok).length;
  const cart = await cartCount(page);
  const screenshot = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
  return { cartCount: cart, added, expected: lines.length, ready: added === lines.length, results, screenshot };
}

export async function place(page) {
  // Checkout → Accept Order (delivery defaults to Invoice Address = correct) → place
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('#ctl00_btnbasket')]);
  await page.waitForTimeout(500);
  if (!(await page.$('#ctl00_ContentPlaceHolder1_btnconfirmorder'))) throw new Error('confirm-order button not found on accept-order screen');
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('#ctl00_ContentPlaceHolder1_btnconfirmorder')]);
  await page.waitForTimeout(800);
  const body = await page.content();
  const orderNo = (body.match(/order\s*(?:no|number|ref)[^0-9]{0,15}(\d{3,})/i) || [])[1] || null;
  const placed = /thank|confirm(ed|ation)|received|success|order number/i.test(body);
  return { placed, orderNo, url: page.url() };
}
