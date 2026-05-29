# MovieBox Stream Proxy

Serveur Node.js **standalone** pour `/api/download/*` et `/api/subtitles/*`.

L’API principale est sur **Cloudflare Workers** — configure `STREAM_PROXY_URL` sur l’URL publique de ce service.

## Deploy

### Northflank (apii.freehandyflix.online)

| Setting | Value |
|---------|--------|
| **Build context** | `/proxy` |
| **Dockerfile** (optional) | `/proxy/Dockerfile` |
| **Start** | `npm start` or `node index.js` |

Env: `PROXY_PUBLIC_URL=https://apii.freehandyflix.online`

**Do not** use repo root — `npm start` there runs the API (`index.js`), not this proxy.

### Heroku

```bash
cd proxy
heroku create ton-app-stream
heroku config:set PROXY_PUBLIC_URL=https://ton-app-stream.herokuapp.com
git subtree push --prefix proxy heroku main
# ou: déploie le dossier `proxy/` comme racine du repo sur Heroku
```

### Railway / Render

- **Root directory:** `proxy`
- **Start command:** `npm start`
- **Variables:** `PROXY_PUBLIC_URL` = URL publique du service

### VPS (PM2)

```bash
cd proxy
npm install
pm2 start ecosystem.config.cjs
```

### Local

```bash
npm install
npm start
curl http://localhost:7861/health
```

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /health` | Health check |
| `GET /api/download/*` | Proxy vidéo (Range supporté) |
| `GET /api/subtitles/*` | Proxy sous-titres SRT |

## Cloudflare Worker

Dans `wrangler.toml` (repo parent) :

```toml
STREAM_PROXY_URL = "https://ton-url-stream.com"
```
