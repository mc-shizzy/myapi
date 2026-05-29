# Deployment guide

## Architecture

| Service | Domain | Deploy target |
|---------|--------|---------------|
| **API** (JSON) | `https://apiv1.freehandyflix.online` | Cloudflare Workers (`worker.js`) |
| **Stream proxy** | `https://apii.freehandyflix.online` | Northflank / VPS — folder **`proxy/`** only |

---

## Cloudflare (apiv1)

```bash
npx wrangler deploy
```

`wrangler.toml` → `STREAM_PROXY_URL = "https://apii.freehandyflix.online"`

---

## Northflank (apii) — IMPORTANT

Do **not** deploy the repository root. That runs `index.js` (API without stream).

### Option A — Buildpack (recommended)

In Northflank service → **Build**:

| Setting | Value |
|---------|--------|
| **Build context** | `/proxy` |
| **Builder** | Heroku 24 (or default) |

Runtime → **Start command**: `node index.js` (or `npm start`)

### Option B — Dockerfile

| Setting | Value |
|---------|--------|
| **Dockerfile path** | `/proxy/Dockerfile` |
| **Build context** | `/proxy` |

### Environment

```
PROXY_PUBLIC_URL=https://apii.freehandyflix.online
```

`PORT` is set automatically by Northflank.

### Verify after deploy

```bash
curl https://apii.freehandyflix.online/health
# → {"status":"ok","service":"moviebox-stream-proxy",...}

curl https://apii.freehandyflix.online/api/config
# → 404 (correct — API is on apiv1 only)
```

---

## VPS (PM2)

```bash
cd proxy
npm install
pm2 start ecosystem.config.cjs
```
