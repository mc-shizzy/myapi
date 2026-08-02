# Deploy

| Service | URL | How |
|---------|-----|-----|
| **API** | https://apiv1.freehandyflix.online | `npx wrangler deploy` |
| **Stream** | https://apii.freehandyflix.online | Northflank — **repo root**, `npm start` |

## Northflank (apii)

Deploy the **repository root** (default). No subfolder needed.

- **Start command:** `npm start` → `proxy-server.js` (do **not** use `npm run start:api`)
- **Dockerfile:** `/Dockerfile` (recommended)
- **Port:** app listens on `process.env.PORT` (Northflank injects this; default `8080` in Docker)
- **Bind:** server must listen on `0.0.0.0` (already set in `proxy-server.js`)
- **Env:**
  - `PROXY_PUBLIC_URL=https://apii.freehandyflix.online` (or your `*.code.run` URL)
  - `API_KEY=<secret>` (same value on Worker + Northflank backend)

### Northflank checklist (fix `503 Connection refused`)

1. **Start command** = `npm start` or `node proxy-server.js`
2. **Ports & DNS** → expose port **8080** (or match `PORT` env)
3. **Logs** → you should see: `MovieBox stream proxy listening on http://0.0.0.0:8080`
4. If logs show `EADDRINUSE` or crash → check start command / port conflict

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
