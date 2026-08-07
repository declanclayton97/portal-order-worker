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
async function addLine(page, line, creds) {
  const q = searchTerm(line.search, line.colour);
  const wantQty = Number(line.qty) || 1;
  const cartBefore = await cartCount(page);
  // Recover the session/page if it dropped: without the search box (e.g. bounced to
  // login after many ops), go back to Styles and re-login. Prevents one bad line from
  // cascading fill-timeouts through the rest of the order.
  if (!(await page.$('#ctl00_txtsearch'))) {
    await page.goto(`${config.base}/styles.aspx?f=0`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (creds && (!(await page.$('#ctl00_btnLogout')) || await page.$('#ctl00_Login1_Password'))) { try { await login(page, creds); } catch {} }
    if (!(await page.$('#ctl00_txtsearch'))) return { ok: false, reason: 'search box unavailable (session recovery failed)' };
  }
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
  const set = await page.evaluate(({ size, qty, legIndex, legCount, waist }) => {
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '').replace(/uk$/, '').replace(/^0+(?=\d)/, '');
    const sizeRe = /^(XXS|XS|S|M|L|XL|XXL|3XL|XXXL|4XL|[1-9]\d?(\.5)?)$/i;   // note: excludes "0"
    const boxes = [...document.querySelectorAll('input[id*="txtqty"]')];
    if (!boxes.length) return { ok: false, reason: 'no size grid' };
    // "One size" products have a single box (no real size column) — just use it.
    const setQty = (box, qty) => { box.value = String(qty); box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new Event('change', { bubbles: true })); };
    if (/one\s*size/i.test(size) && boxes.length === 1) { setQty(boxes[0], qty); return { ok: true, boxId: boxes[0].id, matchedSize: 'One size' }; }
    // Leg×waist trouser grid: one ROW per leg (ascending, but UNLABELLED — target by the
    // leg's ordinal), one labelled COLUMN per waist. Rows can't be matched by text, so we
    // guard that the grid's row count equals the style's leg count and refuse to guess if not.
    if (legIndex != null && legCount) {
      const top = (b) => Math.round(b.getBoundingClientRect().top);
      const ys = [...new Set(boxes.map(top))].sort((a, b) => a - b);
      if (ys.length !== legCount) return { ok: false, reason: `leg-grid rows ${ys.length} != expected legs ${legCount} (won't guess leg)`, diag: { ys, boxCount: boxes.length } };
      const rowBoxes = boxes.filter((b) => top(b) === ys[legIndex]).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const minY = Math.min(...boxes.map((b) => b.getBoundingClientRect().top));
      const heads = [...document.querySelectorAll('div,span,td,th,b,strong,p,label')].filter((e) => e.children.length === 0 && /^\d{2}$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().top < minY);
      let target = null;
      const wh = heads.find((h) => h.innerText.trim() === String(waist));
      if (wh) { const hx = (wh.getBoundingClientRect().left + wh.getBoundingClientRect().right) / 2; let bd = 1e9; for (const b of rowBoxes) { const r = b.getBoundingClientRect(); const dx = Math.abs((r.left + r.right) / 2 - hx); if (dx < bd) { bd = dx; target = b; } } if (bd > 30) target = null; }
      if (!target) { const ws = [...new Set(heads.map((h) => Number(h.innerText.trim())))].sort((a, b) => a - b); const ci = ws.indexOf(Number(waist)); if (ci >= 0 && ci < rowBoxes.length) target = rowBoxes[ci]; }
      if (!target) return { ok: false, reason: `waist ${waist} column not found in leg grid`, diag: { cols: rowBoxes.length, heads: heads.map((h) => h.innerText.trim()) } };
      setQty(target, qty);
      return { ok: true, boxId: target.id, matchedSize: `leg[${legIndex}/${legCount}] W${waist}` };
    }
    const labels = [...document.querySelectorAll('div,span,td,th,b,strong,p')].filter((e) => e.children.length === 0 && sizeRe.test((e.innerText || '').trim()));
    // Trouser sizes come through as "W32" / "L31W34" but the grid columns are the waist
    // number (30,32,34…). Use the waist number when present; else the normalised size.
    const wm = String(size).match(/w\s*(\d{2})/i);
    const want = wm ? wm[1] : norm(size);
    for (const box of boxes) {
      const br = box.getBoundingClientRect();
      let lbl = null, bestDy = 1e9;
      for (const e of labels) { const er = e.getBoundingClientRect(); const dx = Math.abs((er.left + er.right) / 2 - (br.left + br.right) / 2); const dy = br.top - er.top; if (dx < 25 && dy > 0 && dy < bestDy) { bestDy = dy; lbl = e; } }
      if (lbl && norm(lbl.innerText.trim()) === want) { setQty(box, qty); return { ok: true, boxId: box.id, matchedSize: lbl.innerText.trim() }; }
    }
    return { ok: false, reason: `size ${size} not found`, diag: { boxCount: boxes.length, labels: labels.map((e) => e.innerText.trim()).slice(0, 24) } };
  }, { size: line.size, qty: line.qty, legIndex: line.legIndex ?? null, legCount: line.legCount ?? null, waist: line.waist ?? null });
  if (!set.ok) return set;
  // "Add to Order" (on styleinfo.aspx) puts the style in the basket
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('#ctl00_ContentPlaceHolder1_cmdadd')]);
  await page.waitForTimeout(500);
  // Verify the basket actually grew by the full requested qty. A qty box that silently
  // capped (stock limit / validation) leaves the line looking "added" but short — catch it
  // here so a partial line fails the line (added<lines) and the order won't place.
  const cartAfter = await cartCount(page);
  const delta = cartAfter - cartBefore;
  if (delta !== wantQty) return { ok: false, reason: `qty short: basket +${delta}, wanted ${wantQty}`, boxId: set.boxId, matchedSize: set.matchedSize, cartBefore, cartAfter };
  return { ok: true, boxId: set.boxId, matchedSize: set.matchedSize };
}

// Diagnostic: for each line, search + open the best result, then dump the size grid's
// boxes (id + geometry) and every candidate leaf label (text + geometry) WITHOUT adding.
// Lets us see how a leg×waist trouser grid is laid out so the matcher can target leg+waist.
export async function inspect(page, { lines, creds }) {
  const out = [];
  for (const line of lines) {
    const q = searchTerm(line.search, line.colour);
    try {
      if (!(await page.$('#ctl00_txtsearch'))) { await page.goto(`${config.base}/styles.aspx?f=0`, { waitUntil: 'domcontentloaded' }).catch(() => {}); if (creds) { try { await login(page, creds); } catch {} } }
      await page.fill('#ctl00_txtsearch', q);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('#ctl00_btnsearch')]);
      await page.waitForTimeout(400);
      const styleids = [];
      for (const a of await page.$$('a[href*="styleinfo"]')) { if (await a.isVisible().catch(() => false)) { const h = (await a.getAttribute('href')) || ''; const sid = h.split('styleid=')[1] || ''; if (sid && !styleids.includes(sid)) styleids.push(sid); } }
      const want = String(line.search || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const links = []; for (const a of await page.$$('a[href*="styleinfo"]')) if (await a.isVisible().catch(() => false)) links.push(a);
      let target = links[0], best = -1;
      for (const a of links) { const href = ((await a.getAttribute('href')) || '').toLowerCase(); const sid = (href.split('styleid=')[1] || '').replace(/[^a-z0-9]/g, ''); let sc = 0; if (sid === want) sc = 100; else if (sid.includes(want) || want.includes(sid)) sc = sid.length; if (sc > best) { best = sc; target = a; } }
      if (target) { await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), target.click()]); await page.waitForTimeout(500); }
      const grid = await page.evaluate(() => {
        const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width) }; };
        // For each qty box: its id, geometry, and the text of ancestors up to 5 levels —
        // the leg label (e.g. Regular/31") lives on the row, not as a leaf near the box.
        const boxes = [...document.querySelectorAll('input[id*="txtqty"]')].map((e) => {
          const anc = []; let p = e.parentElement; for (let i = 0; i < 6 && p; i++) { const own = [...p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(' '); anc.push({ tag: p.tagName, id: p.id || '', txt: (p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60), own: own.slice(0, 40) }); p = p.parentElement; }
        return { id: e.id, ...r(e), anc };
        });
        // The whole style block's raw text (rows in order) + any row-lead cells
        const block = document.querySelector('[id*="rpColour"]') || document.querySelector('table');
        const rowLeads = [...document.querySelectorAll('tr')].map((tr) => (tr.querySelector('td,th')?.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30);
        return { boxes, title: (document.querySelector('h1,h2,.styletitle')?.innerText || '').trim(), blockText: (block?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600), rowLeads };
      });
      out.push({ search: q, size: line.size, styleids, styleUrl: page.url(), ...grid });
    } catch (e) { out.push({ search: q, size: line.size, error: e.message }); }
  }
  return { inspect: out };
}

export async function stage(page, { lines, creds, keepBasket }) {
  const cleared = keepBasket ? null : await clearBasket(page);
  const results = [];
  for (const line of lines) {
    try { results.push({ line: line.search, size: line.size, qty: line.qty, ...(await addLine(page, line, creds)) }); }
    catch (e) { results.push({ line: line.search, size: line.size, qty: line.qty, ok: false, reason: e.message }); }
  }
  const added = results.filter((r) => r.ok).length;
  const cart = await cartCount(page);
  const units = lines.reduce((a, l) => a + (Number(l.qty) || 1), 0);   // basket counts units, not lines
  const screenshot = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
  return { cartCount: cart, added, expected: lines.length, units, ready: added === lines.length && cart === units, cleared, results, screenshot };
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
