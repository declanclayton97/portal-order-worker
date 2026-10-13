// Brightpearl Data Manager upload — NOT a supplier. Some maps only work from a real browser.
//
// Map 19 (Barcode Updater) is the case: the backend's HTTP upload (/api/purchasing/bp-import-upload)
// gets "Upload complete" back and changes nothing, whatever the flags — while the same file
// uploaded by hand in Chrome sets every barcode. The API cannot set `barcode` at all (it writes
// `ean` and silently ignores `barcode`). So this drives the actual import page, as a person would.
//
// ONE FILE PER CALL. lines: [{ mapId, filename, fileBase64, skip?, updateOnly? }]
//   opts.inspect     -> read the import form (fields, checkboxes, selects); changes nothing
//   execute:false    -> fills the form and submits it as a TEST RUN (doit unticked): BP reports
//                       what it would do and writes nothing
//   execute:true     -> ticks doit and submits for real
// Read the products back afterwards — the import page says "Upload complete" either way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config as bpConfig, login as bpLogin } from './brightpearl.js';

export const config = { ...bpConfig };
export const login = bpLogin;

const pageUrl = (mapId) => `${config.base}/patt-op.php?scode=data-manager&xfer_map_id=${encodeURIComponent(mapId)}`;

async function readForm(page) {
  return page.evaluate(() => {
    const f = document.querySelector('input[name="xfer_file"]')?.form;
    if (!f) return null;
    return {
      action: f.getAttribute('action'), method: f.method,
      fields: [...f.elements].filter((e) => e.name).map((e) => ({
        name: e.name, type: e.type, value: e.type === 'file' ? '' : String(e.value).slice(0, 60),
        checked: e.type === 'checkbox' || e.type === 'radio' ? e.checked : undefined,
        label: (e.closest('label')?.innerText || document.querySelector(`label[for="${e.id}"]`)?.innerText || '').trim().slice(0, 80),
      })),
    };
  });
}

const bodyText = (page) => page.evaluate(() => {
  const c = document.body.cloneNode(true);
  c.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  return c.innerText.replace(/\s+/g, ' ').trim();
});

export async function inspect(page, { lines }) {
  const mapId = (lines && lines[0] && lines[0].mapId) || 19;
  await page.goto(pageUrl(mapId), { waitUntil: 'domcontentloaded' });
  return { mapId, title: await page.title(), form: await readForm(page), text: (await bodyText(page)).slice(0, 1500) };
}

let pending = null;   // what stage() filled, for place()

export async function stage(page, { lines }) {
  if (!Array.isArray(lines) || lines.length !== 1) throw new Error('exactly one file per call (lines[0])');
  const { mapId, filename, fileBase64, skip = true, updateOnly = true } = lines[0];
  if (!mapId || !filename || !fileBase64) throw new Error('lines[0] needs mapId, filename and fileBase64');
  const buf = Buffer.from(fileBase64, 'base64');
  const tmp = path.join(os.tmpdir(), `bpimport-${Date.now()}-${path.basename(filename)}`);
  fs.writeFileSync(tmp, buf);

  await page.goto(pageUrl(mapId), { waitUntil: 'domcontentloaded' });
  const form = await readForm(page);
  if (!form) throw new Error(`no import form on the map ${mapId} page — ${JSON.stringify({ url: page.url(), title: await page.title() })}`);
  await page.setInputFiles('input[name="xfer_file"]', tmp);
  const tick = async (name, on) => { const el = await page.$(`input[name="${name}"]`); if (el) await el.setChecked(!!on); return !!el; };
  const set = { skip: await tick('skip', skip), update_only: await tick('update_only', updateOnly), doit: await tick('doit', false), email_report: await tick('email_report', false) };
  pending = { mapId, filename, bytes: buf.length, tmp };
  return { ready: true, mapId, filename, bytes: buf.length, checkboxesFound: set, form };
}

async function submit(page) {
  const btn = await page.evaluateHandle(() => {
    const f = document.querySelector('input[name="xfer_file"]')?.form;
    return f && (f.querySelector('input[type=submit], button[type=submit], button:not([type]), a.btn[onclick*="submit"]'));
  });
  const el = btn.asElement();
  await Promise.all([
    page.waitForLoadState('load', { timeout: 120000 }).catch(() => {}),
    el ? el.click() : page.evaluate(() => document.querySelector('input[name="xfer_file"]').form.submit()),
  ]);
  await page.waitForTimeout(3000);
  const text = await bodyText(page);
  return { url: page.url(), title: await page.title(), text: text.slice(0, 4000) };
}

// Test run: submit with doit unticked. Called by the worker's dry-run path via opts.testRun.
export async function testRun(page) {
  if (!pending) throw new Error('stage() first');
  const r = await submit(page);
  return { testRun: true, ...pending, ...r };
}

export async function place(page) {
  if (!pending) throw new Error('stage() first');
  const doit = await page.$('input[name="doit"]');
  if (!doit) throw new Error('no doit checkbox on the form — refusing to guess how this map commits');
  await doit.setChecked(true);
  const r = await submit(page);
  try { fs.unlinkSync(pending.tmp); } catch {}
  return { placed: true, committed: true, ...pending, ...r };
}
