// Portal-order worker — a generic headless-browser service for placing supplier orders
// on portals that CAN'T be driven by plain server HTTP (browser-only carts, bot walls).
// One Chromium, one endpoint; a small automation module per supplier under ./suppliers.
// The purchasing backend calls POST /place-order?supplier=STERLING with the lines.
//
// SYNC vs ASYNC: a big order takes many minutes (each line is several WebForms postbacks),
// longer than an HTTP request should hang. Pass { async: true } → the call returns a jobId
// immediately and processes in the background; poll GET /job/:id for the result. Without
// the flag it runs synchronously (fine for small/quick calls + dry-runs).
//
// SAFETY: placement is real and usually irreversible (no draft/sandbox on these portals).
// It places ONLY when the body has { execute: true }; otherwise it logs in + stages the
// cart and reports readiness without submitting. Fire exactly once — no auto-retry of a submit.

import express from 'express';
import { chromium } from 'playwright';

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WORKER_SECRET;              // shared with the backend
const HEADLESS = process.env.HEADLESS !== 'false';

const app = express();
app.use(express.json({ limit: '2mb' }));

const jobs = new Map();                                // jobId -> { status, result, error, started, ended }

async function loadSupplier(name) {
  const key = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  try { return await import(`./suppliers/${key}.js`); } catch { return null; }
}

async function launch() {
  return chromium.launch({ headless: HEADLESS, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
}

// The core order flow. NEVER throws — always resolves to a result object.
async function runOrder({ supplier, ref, lines, opts = {}, execute }) {
  const mod = await loadSupplier(supplier);
  if (!mod) return { ok: false, supplier, ref, error: `no automation module for supplier "${supplier}"` };
  const user = process.env[mod.config.envUser];
  const pass = process.env[mod.config.envPass];
  if (!user || !pass) return { ok: false, supplier, ref, error: `${mod.config.envUser}/${mod.config.envPass} not set` };

  let browser; const t0 = Date.now();
  try {
    browser = await launch();
    const page = await (await browser.newContext()).newPage();
    await mod.login(page, { user, pass });
    const staged = await mod.stage(page, { lines, creds: { user, pass }, ...opts });
    if (!execute) { await browser.close(); return { ok: true, dryRun: true, supplier, ref, ...staged, ms: Date.now() - t0 }; }
    if (!staged.ready) { await browser.close(); return { ok: false, error: 'not ready to place', supplier, ref, ...staged }; }
    const placed = await mod.place(page);
    await browser.close();
    return { ok: true, supplier, ref, ...staged, ...placed, ms: Date.now() - t0 };
  } catch (e) {
    let shot = null;
    try { if (browser) { const p = (await browser.contexts())[0]?.pages()?.[0]; if (p) shot = `data:image/png;base64,${(await p.screenshot()).toString('base64')}`; } } catch {}
    try { if (browser) await browser.close(); } catch {}
    return { ok: false, supplier, ref, error: e.message, screenshot: shot };
  }
}

const auth = (req) => !SECRET || req.get('x-worker-secret') === SECRET;

app.get('/health', (_req, res) => res.json({ ok: true, service: 'portal-order-worker', headless: HEADLESS, jobs: jobs.size }));

app.post('/place-order', async (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: 'bad secret' });
  const body = req.body || {};
  if (!body.supplier) return res.status(400).json({ error: 'supplier required' });
  if (!Array.isArray(body.lines) || !body.lines.length) return res.status(400).json({ error: 'lines[] required' });

  if (body.async) {
    const jobId = `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, { status: 'running', started: Date.now() });
    runOrder(body)
      .then((r) => jobs.set(jobId, { status: 'done', result: r, started: jobs.get(jobId)?.started, ended: Date.now() }))
      .catch((e) => jobs.set(jobId, { status: 'error', error: e.message, started: jobs.get(jobId)?.started, ended: Date.now() }));
    return res.status(202).json({ jobId, status: 'running' });
  }
  return res.json(await runOrder(body));
});

app.get('/job/:id', (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: 'bad secret' });
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'unknown job (expired or wrong id)' });
  if (j.status === 'done') return res.json({ status: 'done', ...j.result });
  if (j.status === 'error') return res.json({ status: 'error', error: j.error });
  return res.json({ status: 'running', runningMs: Date.now() - (j.started || Date.now()) });
});

// forget finished jobs after 30 min so the map doesn't grow unbounded
setInterval(() => { const cutoff = Date.now() - 30 * 60 * 1000; for (const [k, v] of jobs) if (v.status !== 'running' && (v.ended || 0) < cutoff) jobs.delete(k); }, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`portal-order-worker listening on ${PORT} (headless=${HEADLESS})`));
