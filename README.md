# Portal Order Worker

A generic headless-browser service that places supplier orders on portals that can't be
driven by plain server HTTP (browser-only carts, bot walls). One Chromium, one endpoint,
one small automation module per supplier under `suppliers/`.

Called by the purchasing backend: `POST /place-order` with a shared secret.

## Endpoints
- `GET /health` → `{ ok: true }`
- `POST /place-order` (header `x-worker-secret: <WORKER_SECRET>`)
  ```json
  { "supplier": "STERLING", "ref": "<our PO#>",
    "lines": [{ "code": "...", "size": "...", "qty": 1, "price": "..." }],
    "opts": { "deliveryAddressId": "12179", "goodsMark": "WORKWEAR" },
    "execute": false }
  ```
  `execute:false` (default) logs in + stages the cart and reports readiness — **nothing is
  placed**. `execute:true` clicks "Complete order" **once** (real order, no retry).

## Brightpearl (`supplier: "BRIGHTPEARL"`) — not a supplier

Brightpearl's own order screen is the **only** thing that can set an order's delivery
mobile. Everything else was tried and refused or silently ignored:

| Attempt | Result |
|---|---|
| `PATCH /order-service/order/{id}` `/parties/delivery/mobileTelephone` | `CMNC-043` path not supported |
| order party sub-resources (`/party`, `/parties`, `/party/delivery`) | 404 — don't exist |
| `pageLock` → `ajaxData.php?op=order:validateOrder` with `delivery_mobile` | 200s, **changed nothing** |
| `contact-service/postal-address/{id}` | holds no phone fields at all |

The order keeps its own phone snapshot, taken at import and independent of the contact, so
fixing the contact does not populate it. eBay fills `telephone` on all three parties and
leaves every mobile blank — hence delivery notifications reaching nobody.

```json
{ "supplier": "BRIGHTPEARL",
  "lines": [{ "orderId": 481823, "mobile": "07453813113" }],
  "opts": { "parties": ["delivery"] },
  "execute": false }
```

- `mobile` is optional — omitted, it takes that party's own `telephone`.
- `parties` defaults to `["delivery"]`; `customer` and `billing` are also available.
- Numbers are normalised to `07xxxxxxxxx`. **Landlines and non-UK numbers are never
  written** — a landline in a mobile field makes a record look fixed while the text still
  silently fails.
- **One order per call.** More than one line is rejected rather than silently skipped.
- `execute:false` fills the field and reports before/after, saving nothing.
- `opts.inspect:true` just reads the order's phone fields and changes nothing.

Env: `BP_WEB_EMAIL` / `BP_WEB_PASSWORD` (the fileuploader account), plus optional
`BP_WEB_HOST` and `BP_WEB_CLIENT_ID` (default `tuffworkwear`).

After saving, the page is **reloaded and the field re-read** before reporting success —
every HTTP route to this returned a happy status while changing nothing, so a save is only
believed once the value survives a fresh load.

## Adding a supplier
Drop `suppliers/<name>.js` exporting `config{ base, envUser, envPass }`, `login(page,{user,pass})`,
`stage(page, opts)` → `{ cartCount, ready }`, and `place(page)` → `{ placed, orderNo, url }`.

## Render setup (one-time)
1. Push this folder to a new GitHub repo (e.g. `portal-order-worker`).
2. Render → **New → Web Service** → connect the repo.
3. **Runtime: Docker** (Render auto-detects the `Dockerfile`).
4. **Instance type: Standard (2 GB)** — headless Chromium needs the RAM; Starter (512 MB)
   will OOM.
5. Environment variables:
   - `WORKER_SECRET` — a long random string (also set on the backend as `STERLING_WORKER_SECRET`)
   - `STERLING_USER`, `STERLING_PASS` — famlive login
   - (later, per supplier) its own `*_USER` / `*_PASS`
   - `HEADLESS=true` (default)
6. Deploy → note the service URL (e.g. `https://portal-order-worker.onrender.com`). Give
   it to the backend as `STERLING_WORKER_URL`.

## Test
- `GET /health` → ok.
- `POST /place-order` with `execute:false` → should log in + stage and report `ready:true`.
- Only then a supervised `execute:true` for the first real order.
