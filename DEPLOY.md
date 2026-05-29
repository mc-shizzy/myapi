# Deploy

| Service | URL | How |
|---------|-----|-----|
| **API** | https://apiv1.freehandyflix.online | `npx wrangler deploy` |
| **Stream** | https://apii.freehandyflix.online | Northflank — **repo root**, `npm start` |

## Northflank (apii)

Deploy the **repository root** (default). No subfolder needed.

- **Start:** `npm start` → `proxy-server.js`
- **Dockerfile:** `/Dockerfile` (optional)
- **Env:** `PROXY_PUBLIC_URL=https://apii.freehandyflix.online`

Test:

```bash
curl https://apii.freehandyflix.online/health
```

## Cloudflare (apiv1)

```bash
npx wrangler deploy
```

`wrangler.toml` → `STREAM_PROXY_URL=https://apii.freehandyflix.online`

## Local

```bash
npm install
npm start          # stream proxy
npm run start:api  # API Node (dev only)
```
