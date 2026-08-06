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
