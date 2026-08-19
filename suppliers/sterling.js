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

// Pick the search result matching BOTH style and COLOUR. Colour is decisive: each colour is a
// SEPARATE product after the search, and some styles' search names omit the colour (Stone
// "Lander" vs "Lander Black"), so a style-only match silently grabs the wrong colour. Strongly
// prefer a result naming the target colour; reject one naming a different colour. Returns the
// chosen link + a per-result score breakdown (for the diagnostic).
const RESULT_COLOURS = ['stone', 'black', 'brown', 'honey', 'grey', 'gray', 'navy', 'tan', 'sand', 'olive', 'wheat', 'chestnut', 'wine', 'bracken', 'khaki'];
async function pickResult(links, line) {
  const want = String(line.search || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wantCols = String(line.colour || '').toLowerCase().split(/[\/,&]/).map((c) => c.replace(/[^a-z]/g, '')).filter(Boolean);
  let target = links[0], best = -1e9; const breakdown = [];
  for (const a of links) {
    const href = ((await a.getAttribute('href')) || '').toLowerCase();
    const sid = (href.split('styleid=')[1] || '').replace(/[^a-z0-9]/g, '');
    const txt = String((await a.textContent().catch(() => '')) || '').toLowerCase();
    const hay = sid + ' ' + txt.replace(/[^a-z0-9]/g, '');
    let score = 0;
    if (sid === want) score += 100; else if (sid.includes(want) || want.includes(sid)) score += Math.min(sid.length, 40);
    if (wantCols.length) {
      if (wantCols.some((c) => hay.includes(c))) score += 200;                                   // this result IS the target colour
      else if (RESULT_COLOURS.some((c) => !wantCols.includes(c) && hay.includes(c))) score -= 300; // a DIFFERENT colour → reject
    }
    breakdown.push({ sid, txt: txt.replace(/\s+/g, ' ').trim().slice(0, 50), score });
    if (score > best) { best = score; target = a; }
  }
  return { target, breakdown };
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
// A selector can resolve and still be unusable. Playwright fill/click wait for VISIBILITY, so any
// readiness check that gates them must test the same thing — page.$ alone does not.
const isVisible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);

async function addLine(page, line, creds) {
  const q = searchTerm(line.search, line.colour);
  const wantQty = Number(line.qty) || 1;
  const cartBefore = await cartCount(page);
  // Recover the session/page if it dropped: without the search box (e.g. bounced to
  // login after many ops), go back to Styles and re-login. Prevents one bad line from
  // cascading fill-timeouts through the rest of the order.
  // VISIBILITY, not existence. page.$ returns a handle for a hidden element, so this guard used to
  // pass on a styleinfo page — where #ctl00_txtsearch IS in the DOM but is not visible — and the
  // fill below then burned its full 30s timeout. On 19 Aug that turned ONE bad line (Barkerville,
  // whose Add-to-Order click timed out and left us parked on its page) into 17 identical failures
  // and an 8-minute run: "locator resolved to <input> ... element is not visible", sixteen times.
  // Recovering here is exactly what this block was written for; it was just asking the wrong thing.
  if (!(await isVisible(page, '#ctl00_txtsearch'))) {
    await page.goto(`${config.base}/styles.aspx?f=0`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (creds && (!(await page.$('#ctl00_btnLogout')) || await page.$('#ctl00_Login1_Password'))) { try { await login(page, creds); } catch {} }
    if (!(await isVisible(page, '#ctl00_txtsearch'))) return { ok: false, reason: 'search box unavailable (session recovery failed)' };
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
  const { target } = await pickResult(links, line);
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
  // "Add to Order". Setting a quantity dispatches a change event, and on some styles that posts
  // back and re-renders the button block — Barkerville loses #cmdadd that way REPRODUCIBLY (it was
  // the only failure in 18 lines on both the 13:00 and the 13:50 run, while inspect, which never
  // types a quantity, sees cmdadd present and enabled on that same page). APKHT, 6 boxes and no
  // pagination, never does it.
  // Every style page carries TWO identical "Add to Order" controls (cmdadd at the foot, Button1 at
  // the head), so try each with a SHORT timeout rather than spending 30s on one id. This cannot add
  // the wrong thing silently: the basket-delta check below fails the line unless the basket grew by
  // exactly the quantity we asked for.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  let clicked = null;
  for (const sel of ['#ctl00_ContentPlaceHolder1_cmdadd', '#ctl00_ContentPlaceHolder1_Button1']) {
    try { await page.click(sel, { timeout: 8000 }); clicked = sel; break; } catch { /* try the other one */ }
  }
  if (!clicked) return { ok: false, reason: 'neither "Add to Order" button was clickable', boxId: set.boxId, matchedSize: set.matchedSize };
  await page.waitForLoadState('domcontentloaded').catch(() => {});
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
      if (!(await isVisible(page, '#ctl00_txtsearch'))) { await page.goto(`${config.base}/styles.aspx?f=0`, { waitUntil: 'domcontentloaded' }).catch(() => {}); if (creds) { try { await login(page, creds); } catch {} } }
      await page.fill('#ctl00_txtsearch', q);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('#ctl00_btnsearch')]);
      await page.waitForTimeout(400);
      const styleids = [];
      for (const a of await page.$$('a[href*="styleinfo"]')) { if (await a.isVisible().catch(() => false)) { const h = (await a.getAttribute('href')) || ''; const sid = h.split('styleid=')[1] || ''; if (sid && !styleids.includes(sid)) styleids.push(sid); } }
      const links = []; for (const a of await page.$$('a[href*="styleinfo"]')) if (await a.isVisible().catch(() => false)) links.push(a);
      const { target, breakdown } = await pickResult(links, line);   // SAME colour-aware picker as addLine
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
        // Every clickable control, with the two properties Playwright actually gates on. The whole
        // point of the 19 Aug post-mortem was that "the selector resolves" and "the selector is
        // usable" are different questions, so record BOTH rather than just presence.
        const buttons = [...document.querySelectorAll('input[type=submit],input[type=button],input[type=image],button,a[id*=cmd]')].map((e) => ({
          id: e.id || '', name: e.name || '', tag: e.tagName, type: e.type || '',
          label: (e.value || e.alt || e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          visible: !!(e.offsetParent || e.getClientRects().length), disabled: !!e.disabled,
        })).filter((b) => b.id || b.label);
        return { boxes, buttons, title: (document.querySelector('h1,h2,.styletitle')?.innerText || '').trim(), blockText: (block?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600), rowLeads };
      });
      out.push({ search: q, wantColour: line.colour, size: line.size, styleids, resultScores: breakdown, chosenStyleUrl: page.url(), ...grid });
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
  const ready = added === lines.length && cart === units;
  const screenshot = ready ? null : `data:image/png;base64,${(await page.screenshot()).toString('base64')}`; // only on a problem
  return { cartCount: cart, added, expected: lines.length, units, ready, cleared, results, screenshot };
}

// Diagnostic: after staging, try to REACH the accept-order screen (JS-click Checkout, which
// works even when the master-page button is hidden on a product page) and dump what's there —
// WITHOUT confirming. Lets us validate the checkout navigation before a real placement.
export async function checkoutProbe(page) {
  const dump = async (label) => ({ label, url: page.url(), title: await page.title().catch(() => ''),
    btnbasket: await page.evaluate(() => { const e = document.getElementById('ctl00_btnbasket'); if (!e) return { exists: false }; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { exists: true, display: s.display, visibility: s.visibility, w: Math.round(r.width), h: Math.round(r.height) }; }).catch(() => ({ err: true })),
    confirm: await page.evaluate(() => { const e = document.getElementById('ctl00_ContentPlaceHolder1_btnconfirmorder'); if (!e) return { exists: false }; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { exists: true, display: s.display, visibility: s.visibility, w: Math.round(r.width), h: Math.round(r.height) }; }).catch(() => ({ err: true })),
    delAddr: await page.evaluate(() => { const e = document.querySelector('#ctl00_ContentPlaceHolder1_cboDelAdd, select[id*=cboDelAdd], select[name*=cboDelAdd]'); return e ? { exists: true, value: e.options?.[e.selectedIndex]?.text || e.value } : { exists: false }; }).catch(() => ({ err: true })),
    cart: await cartCount(page) });
  const before = await dump('after-stage');
  // JS-click Checkout (visibility-proof postback) → redirects to createorder.aspx (basket)
  await page.evaluate(() => { const b = document.getElementById('ctl00_btnbasket'); if (b) b.click(); }).catch(() => {});
  await page.waitForURL(/createorder\.aspx/i, { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2500);
  const after = await dump('after-checkout-click');
  // Dump ALL clickable controls on the basket page so we can find the proceed→confirm path
  const controls = await page.evaluate(() => [...document.querySelectorAll('input[type=submit],input[type=button],button,a.btn,a[href*="rder"]')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || '', name: e.name || '', tag: e.tagName, txt: (e.value || e.innerText || '').trim().slice(0, 30), href: (e.getAttribute && e.getAttribute('href')) || '', w: Math.round(r.width), h: Math.round(r.height) }; }).filter((c) => c.txt || c.id).slice(0, 40)).catch(() => []);
  // One more step: Submit the basket → the accept-order/address screen (STOP before confirm).
  // Poll for the confirm button (same navigation-churn issue as place()) so this validates the
  // real 40-unit timing without ever confirming.
  await page.evaluate(() => { const b = document.getElementById('ctl00_ContentPlaceHolder1_SubmitOrder'); if (b) b.click(); }).catch(() => {});
  const confirmAppeared = await pollFor(page, '#ctl00_ContentPlaceHolder1_btnconfirmorder', { tries: 45, gap: 2000 });
  await page.waitForTimeout(800);
  const accept = await dump('after-submit');
  accept.confirmAppeared = confirmAppeared;
  const acceptControls = await page.evaluate(() => [...document.querySelectorAll('input[type=submit],input[type=button],button,select')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || '', tag: e.tagName, txt: (e.value || e.innerText || '').trim().slice(0, 30), sel: e.tagName === 'SELECT' ? (e.options?.[e.selectedIndex]?.text || '') : '', w: Math.round(r.width), h: Math.round(r.height) }; }).filter((c) => c.txt || c.id || c.sel).slice(0, 40)).catch(() => []);
  // Text inputs on the accept screen (find the required "Your Ref" field + any empty required ones)
  const acceptInputs = await page.evaluate(() => [...document.querySelectorAll('input[type=text],textarea')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || '', name: e.name || '', value: (e.value || '').slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((c) => c.w > 0).slice(0, 40)).catch(() => []);
  const screenshot = `data:image/png;base64,${(await page.screenshot({ fullPage: true })).toString('base64')}`;
  return { before, after, controls, accept, acceptControls, acceptInputs, screenshot };
}

// Place the staged order. Verified flow (see checkoutProbe):
//   styles → Checkout (ctl00_btnbasket, zero-sized so JS-click) → createorder.aspx (basket)
//   → Submit (ctl00…SubmitOrder) → accept-order screen → fill required "Your Ref"
//   (ctl00…txtcustomerref) with our PO number, delivery defaults to Invoice Address → confirm.
// Each hop redirects via a "Loading…" interstitial, so we wait for the next key element.
// Read the account's recent orders (Order Status page). Used to VERIFY a placement and
// recover its order number without re-submitting — the anti-double-fire safeguard.
export async function ordersList(page) {
  await page.goto(`${config.base}/Orders.aspx`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);
  const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 200).slice(0, 40)).catch(() => []);
  // order-number pulls only need rows; only grab a screenshot when the list came back empty (debug)
  const screenshot = rows.length ? null : `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
  return { ordersUrl: page.url(), rows, screenshot };
}

// The shop transitions between basket and accept-order screens via postbacks that KEEP the
// same createorder.aspx URL and pass through a JS "Loading…" interstitial — so Playwright's
// waitForSelector couples to a never-settling navigation and times out. Poll with page.$
// instead (tolerant of navigation churn); fixed sleeps between checks.
async function pollFor(page, sel, { tries = 40, gap = 2000 } = {}) {
  for (let i = 0; i < tries; i++) { await page.waitForTimeout(gap); const el = await page.$(sel).catch(() => null); if (el) return true; }
  return false;
}

export async function place(page, { ref } = {}) {
  // any JS confirm() on the final button must be ACCEPTED (Playwright's default is dismiss = cancel)
  page.on('dialog', (d) => d.accept().catch(() => {}));

  // 1. Checkout — master-page button is present but zero-sized; JS-click posts back to the basket
  await page.evaluate(() => { const b = document.getElementById('ctl00_btnbasket'); if (b) b.click(); }).catch(() => {});
  if (!(await pollFor(page, '#ctl00_ContentPlaceHolder1_SubmitOrder', { tries: 30, gap: 2000 }))) throw new Error('basket (createorder.aspx Submit) did not appear after Checkout');
  await page.waitForTimeout(500);

  // 2. Submit the basket (Confirm Order Quantity) → accept-order/address screen (same URL)
  await page.evaluate(() => { const b = document.getElementById('ctl00_ContentPlaceHolder1_SubmitOrder'); if (b) b.click(); }).catch(() => {});
  if (!(await pollFor(page, '#ctl00_ContentPlaceHolder1_btnconfirmorder', { tries: 45, gap: 2000 }))) throw new Error('accept-order screen (confirm button) did not appear within ~90s after Submit');
  await page.waitForTimeout(800);

  // 3. Fill the REQUIRED "Your Ref" (else validation blocks the order); PO number = traceability
  if (ref) {
    await page.fill('#ctl00_ContentPlaceHolder1_txtcustomerref', String(ref))
      .catch(() => page.evaluate((v) => { const e = document.getElementById('ctl00_ContentPlaceHolder1_txtcustomerref'); if (e) { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); } }, String(ref)));
  }
  const delAddr = await page.evaluate(() => { const e = document.getElementById('ctl00_ContentPlaceHolder1_cboDelAdd'); return e ? (e.options[e.selectedIndex]?.text || '') : ''; }).catch(() => '');
  const refSet = await page.inputValue('#ctl00_ContentPlaceHolder1_txtcustomerref').catch(() => '');

  // 4. Confirm (final, irreversible). Poll for the confirmation (button gone / thank-you text).
  await page.evaluate(() => { const b = document.getElementById('ctl00_ContentPlaceHolder1_btnconfirmorder'); if (b) b.click(); }).catch(() => {});
  let done = false, text = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const still = await page.$('#ctl00_ContentPlaceHolder1_btnconfirmorder').catch(() => 'err');
    text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (still === null || /thank|confirm(ed|ation)|success|received|has been (placed|submitted)|order (number|placed|received)/i.test(text)) { done = true; break; }
  }
  const stillOnConfirm = !!(await page.$('#ctl00_ContentPlaceHolder1_btnconfirmorder').catch(() => null));
  // Confirmation redirects to orders.aspx listing the placed order as
  // "Select <OrderID> <style> … <ourRef> <date>". Read the OrderID from the row carrying OUR
  // ref (the Your-Ref = PO number we set) — deterministic, vs guessing. Fallbacks after.
  const escRef = String(ref || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const orderNo = (escRef && (text.match(new RegExp(`Select\\s+(\\d{5,})(?:(?!Select)[\\s\\S])*?\\b${escRef}\\b`)) || [])[1])
    || (text.match(/order\s*(?:no|number|ref|confirmation)[^0-9]{0,15}(\d{3,})/i) || [])[1]
    || (text.match(/\b(?:order|confirmation)\D{0,6}(\d{5,})/i) || [])[1]
    || null;
  const placed = done || !stillOnConfirm;
  // Only capture the (large, full-page) screenshot when something went wrong — on a clean
  // placement it's pure wasted bandwidth back through the poll.
  const screenshot = placed ? null : `data:image/png;base64,${(await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64')}`;
  return { placed, orderNo, url: page.url(), delAddr, refSet, stillOnConfirm, confirmText: text.replace(/\s+/g, ' ').trim().slice(0, 500), screenshot };
}
