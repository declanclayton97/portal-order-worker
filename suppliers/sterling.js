// Sterling Safetywear — famlive portal (sterlingsafetywear.famlive.net).
// Client-side app: catalogue/pricelists are static JSON, the cart is browser
// localStorage ("cartItems"), and "Complete order" (#btnSubmitOrder) clears the cart,
// copies it to OrderItems, sets a DeliveryType cookie, and fires the WebForms
// MainContent_Button2 postback. So we drive it in a real browser.
//
// ⚠ The exact cart-item field shape is still being confirmed against the live
// add-to-cart JS; buildCartItems seeds the known keys and stage() verifies the count
// before anything is placed.

export const config = {
  base: process.env.STERLING_BASE || 'https://sterlingsafetywear.famlive.net',
  envUser: 'STERLING_USER',
  envPass: 'STERLING_PASS',
};

export async function login(page, { user, pass }) {
  await page.goto(`${config.base}/AccLogin.aspx`, { waitUntil: 'domcontentloaded' });
  await page.fill('#TextBox2', user);
  await page.fill('#TextBox3', pass);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('#Button2'),
  ]);
  if (/AccLogin/i.test(page.url())) throw new Error('Sterling login failed (still on AccLogin)');
}

function buildCartItems(lines) {
  const obj = {};
  for (const l of lines) {
    const id = String(l.code || l.sku);
    obj[id] = {
      ProductCode: id,
      Size: l.size || '',
      quantity: Number(l.qty) || 1,
      SalesPrice: l.price != null ? String(l.price) : '',
      price: l.price != null ? String(l.price) : '',
    };
  }
  return obj;
}

export async function stage(page, { lines, deliveryAddressId, goodsMark }) {
  await page.goto(`${config.base}/Styles`, { waitUntil: 'domcontentloaded' });
  const cart = buildCartItems(lines);
  await page.evaluate((c) => localStorage.setItem('cartItems', JSON.stringify(c)), cart);
  await page.goto(`${config.base}/CheckOut`, { waitUntil: 'networkidle' });
  if (deliveryAddressId) await page.selectOption('#MainContent_cboDelAdd', String(deliveryAddressId)).catch(() => {});
  if (goodsMark) await page.fill('#MainContent_TextBox1', String(goodsMark)).catch(() => {});
  const cartCount = await page.evaluate(() => { const c = localStorage.getItem('cartItems'); return c ? Object.keys(JSON.parse(c)).length : 0; });
  return { cartCount, ready: cartCount === lines.length };
}

export async function place(page) {
  await page.click('#btnSubmitOrder');
  await page.waitForLoadState('networkidle').catch(() => {});
  const url = page.url();
  const body = await page.content();
  const orderNo = (body.match(/order\s*(?:no|number|ref)[^0-9]{0,15}(\d{4,})/i) || [])[1] || null;
  const placed = /thank|confirm|received|complete|success/i.test(body) || /Orders/i.test(url);
  return { placed, orderNo, url };
}
