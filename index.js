// Portal-order worker — a generic headless-browser service for placing supplier orders
// on portals that CAN'T be driven by plain server HTTP (browser-only carts, bot walls).
// One Chromium, one endpoint; a small automation module per supplier under ./suppliers.
// The purchasing backend calls POST /place-order?supplier=STERLING with the lines.
//
// SAFETY: placement is real and usually irreversible (no draft/sandbox on these portals).
// It places ONLY when the body has { execute: true }; otherwise it logs in + stages the
// cart and reports readiness without submitting. Fire exactly once — no auto-retry of a
// submit.

import express from 'express';
import { chromium } from 'playwright';

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WORKER_SECRET;              // shared with the backend
const HEADLESS = process.env.HEADLESS !== 'false';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Supplier automation modules are loaded on demand from ./suppliers/<name>.js.
// Each exports: config{base}, async login(page,{user,pass}), async stage(page,opts),
// async place(page). Credentials come from env vars named by the module's config.
async function loadSupplier(name) {
  const key = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  try { return await import(`./suppliers/${key}.js`); }
  catch { return null; }
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'portal-order-worker', headless: HEADLESS }));

async function launch() {
  return chromium.launch({ headless: HEADLESS, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
}

app.post('/place-order', async (req, res) => {
  if (SECRET && req.get('x-worker-secret') !== SECRET) return res.status(401).json({ error: 'bad secret' });
  const { supplier, ref, lines, opts = {}, execute } = req.body || {};
  if (!supplier) return res.status(400).json({ error: 'supplier required' });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines[] required' });

  const mod = await loadSupplier(supplier);
  if (!mod) return res.status(400).json({ error: `no automation module for supplier "${supplier}"` });
  const user = process.env[mod.config.envUser];
  const pass = process.env[mod.config.envPass];
  if (!user || !pass) return res.status(500).json({ error: `${mod.config.envUser}/${mod.config.envPass} not set` });

  let browser; const t0 = Date.now();
  try {
    browser = await launch();
    const page = await (await browser.newContext()).newPage();
    await mod.login(page, { user, pass });
    const staged = await mod.stage(page, { lines, ...opts });   // seed cart + address; returns {cartCount, ready, ...}

    if (!execute) {
      await browser.close();
      return res.json({ ok: true, dryRun: true, supplier, ref, ...staged, ms: Date.now() - t0 });
    }
    if (!staged.ready) { await browser.close(); return res.status(409).json({ ok: false, error: 'not ready to place', supplier, ref, ...staged }); }

    const placed = await mod.place(page);                        // click Complete once; returns {placed, orderNo, url}
    await browser.close();
    return res.json({ ok: true, supplier, ref, ...staged, ...placed, ms: Date.now() - t0 });
  } catch (e) {
    let shot = null;
    try { if (browser) { const p = (await browser.contexts())[0]?.pages()?.[0]; if (p) shot = `data:image/png;base64,${(await p.screenshot()).toString('base64')}`; } } catch {}
    try { if (browser) await browser.close(); } catch {}
    return res.status(500).json({ ok: false, supplier, ref, error: e.message, screenshot: shot });
  }
});

app.listen(PORT, () => console.log(`portal-order-worker listening on ${PORT} (headless=${HEADLESS})`));
