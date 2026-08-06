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

// Empty the basket so the order is exactly our lines (dry-runs leave items behind).
// Go to Checkout (the order-lines screen) and click each Delete until none remain.
async function clearBasket(page) {
  if (!(await cartCount(page))) return { cleared: 0 };
  await page.goto(`${config.base}/styles.aspx?f=0`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const chk = await page.$('#ctl00_btnbasket');
  if (chk) { await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), chk.click()]); await page.waitForTimeout(500); }
  let n = 0;
  for (let i = 0; i < 40; i++) {
    const del = await page.$('a[id*="Delete"]:visible, a[id*="delete"]:visible, input[id*="Delete"]:visible');
    if (!del) break;
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), del.click().catch(() => {})]);
    await page.waitForTimeout(400); n++;
  }
  return { cleared: n, remaining: await cartCount(page) };
}

// Add ONE line to the basket. Returns { ok, reason }.
async function addLine(page, line) {
  const q = searchTerm(line.search, line.colour);
  // search
  await page.fill('#ctl00_txtsearch', q);
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('#ctl00_btnsearch')]);
  await page.waitForTimeout(400);
  if (await page.$('text=/no results matching/i')) return { ok: false, reason: `no results for "${q}"` };
  // Results link to styleinfo.aspx?styleid=<STYLE NAME>. Each product has several links
  // (image + title), some hidden — consider only VISIBLE ones, and pick the styleid that
  // best matches our resolved item (disambiguates e.g. APKHT trouser vs APKHT short).
  const allLinks = await page.$$('a[href*="styleinfo"]');
  const links = [];
  for (const a of allLinks) { if (await a.isVisible().catch(() => false)) links.push(a); }
  if (!links.length) return { ok: false, reason: `no visible styleinfo results for "${q}"` };
  const want = String(line.search || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let target = links[0], best = -1;
  for (const a of links) {
    const href = ((await a.getAttribute('href')) || '').toLowerCase();
    const sid = (href.split('styleid=')[1] || '').replace(/[^a-z0-9]/g, '');
    let score = 0; if (sid === want) score = 100; else if (sid.includes(want) || want.includes(sid)) score = sid.length;
    if (score > best) { best = score; target = a; }
  }
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), target.click()]);
  await page.waitForTimeout(500);
  // Size grid layout is "size / price / qty box" stacked per column. So for each qty box,
  // the size is the leaf label horizontally centred on it and directly above it. Match by
  // geometry (robust vs index — skips stray "0" cart badges; column-accurate for multi-colour).
  const set = await page.evaluate(({ size, qty }) => {
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '').replace(/uk$/, '').replace(/^0+(?=\d)/, '');
    const sizeRe = /^(XXS|XS|S|M|L|XL|XXL|3XL|XXXL|4XL|[1-9]\d?(\.5)?)$/i;   // note: excludes "0"
    const boxes = [...document.querySelectorAll('input[id*="txtqty"]')];
    if (!boxes.length) return { ok: false, reason: 'no size grid' };
    const labels = [...document.querySelectorAll('div,span,td,th,b,strong,p')].filter((e) => e.children.length === 0 && sizeRe.test((e.innerText || '').trim()));
    // Trouser sizes come through as "W32" / "L31W34" but the grid columns are the waist
    // number (30,32,34…). Use the waist number when present; else the normalised size.
    const wm = String(size).match(/w\s*(\d{2})/i);
    const want = wm ? wm[1] : norm(size);
    for (const box of boxes) {
      const br = box.getBoundingClientRect();
      let lbl = null, bestDy = 1e9;
      for (const e of labels) { const er = e.getBoundingClientRect(); const dx = Math.abs((er.left + er.right) / 2 - (br.left + br.right) / 2); const dy = br.top - er.top; if (dx < 25 && dy > 0 && dy < bestDy) { bestDy = dy; lbl = e; } }
      if (lbl && norm(lbl.innerText.trim()) === want) { box.value = String(qty); box.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, boxId: box.id, matchedSize: lbl.innerText.trim() }; }
    }
    return { ok: false, reason: `size ${size} not found`, diag: { boxCount: boxes.length, labels: labels.map((e) => e.innerText.trim()).slice(0, 24) } };
  }, { size: line.size, qty: line.qty });
  if (!set.ok) return set;
  // "Add to Order" (on styleinfo.aspx) puts the style in the basket
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('#ctl00_ContentPlaceHolder1_cmdadd')]);
  await page.waitForTimeout(500);
  return { ok: true, boxId: set.boxId, matchedSize: set.matchedSize };
}

export async function stage(page, { lines, keepBasket }) {
  const cleared = keepBasket ? null : await clearBasket(page);
  const results = [];
  for (const line of lines) {
    try { results.push({ line: line.search, size: line.size, qty: line.qty, ...(await addLine(page, line)) }); }
    catch (e) { results.push({ line: line.search, size: line.size, qty: line.qty, ok: false, reason: e.message }); }
  }
  const added = results.filter((r) => r.ok).length;
  const cart = await cartCount(page);
  const screenshot = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
  return { cartCount: cart, added, expected: lines.length, ready: added === lines.length && cart === added, cleared, results, screenshot };
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
