# MovieBox API

## URLs

- **API:** https://apiv1.freehandyflix.online (Cloudflare Workers)
- **Stream:** https://apii.freehandyflix.online (Northflank — `npm start` at repo root)

## Deploy

See [DEPLOY.md](DEPLOY.md).

```bash
# Stream (Northflank / VPS)
npm install && npm start

# API (Cloudflare)
npx wrangler deploy
```

## Files

| File | Role |
|------|------|
| `proxy-server.js` | Stream proxy — **default `npm start`** |
| `worker.js` | API for Cloudflare |
| `index.js` | API Node local dev only (`npm run start:api`) |
| `index.js.backup` | Full backup before split |

## Env

- `PROXY_PUBLIC_URL` — public URL of stream service (Northflank)
- `STREAM_PROXY_URL` — in `wrangler.toml` for Cloudflare
