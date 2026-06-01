# Deploy

| Service | URL | How |
|---------|-----|-----|
| **API** | https://apiv1.freehandyflix.online | `npx wrangler deploy` |
| **Stream** | https://apii.freehandyflix.online | Northflank — **repo root**, `npm start` |

## Northflank (apii)

Deploy the **repository root** (default). No subfolder needed.

- **Start:** `npm start` → `proxy-server.js`
- **Dockerfile:** `/Dockerfile` (optional)
- **Env:**
  - `PROXY_PUBLIC_URL=https://apii.freehandyflix.online`
  - `API_KEY=<secret>` (same value on Worker + Northflank backend)

Test:

```bash
curl https://apii.freehandyflix.online/health
curl -H "X-Api-Key: YOUR_KEY" https://apii.freehandyflix.online/api/popular-searches
```

## Cloudflare (apiv1)

```bash
npx wrangler secret put API_KEY
npx wrangler deploy
```

`wrangler.toml` → `STREAM_PROXY_URL=https://apii.freehandyflix.online`

## Auth (backend Northflank → apii)

- JSON routes: header `X-Api-Key` or `Authorization: Bearer <API_KEY>`
- Stream (`proxyUrl`): signed `?exp=&sig=` on URL (4h) — users never need the master key
- Forward `X-Forwarded-For: <client IP>` so rate limits apply per user, not per server

## Local

```bash
npm install
npm start          # stream proxy
npm run start:api  # API Node (dev only)
```
