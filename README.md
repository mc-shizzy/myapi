# MovieBox API (split deployment)

## Structure

| Fichier | Rôle | Où déployer |
|---------|------|-------------|
| `worker.js` + `lib/api-handlers.cjs` | API principale (config, search, sources…) | **Cloudflare** → `https://apiv1.freehandyflix.online` |
| `proxy-server.js` | Stream / download / subtitles | **VPS, Heroku, Railway** |
| `index.js` | API Node (même routes que le worker) | Optionnel (dev / fallback) |
| `index.js.backup` | Sauvegarde complète avant split | — |

## Variables d'environnement

- **`STREAM_PROXY_URL`** (ou `PROXY_ORIGIN`) — URL publique du serveur stream, ex. `https://stream.freehandyflix.online`
- Les `proxyUrl` dans `/api/sources` seront : `{STREAM_PROXY_URL}/api/download/...`

## Cloudflare Workers

**URL API :** https://apiv1.freehandyflix.online

```bash
npm install -g wrangler
wrangler login
npm run deploy:worker
```

### DNS (si `apiv1` ne répond pas encore)

Dans Cloudflare → **freehandyflix.online** → **DNS** → Add record :

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| **AAAA** | `apiv1` | `100::` | Proxied (orange) |

Ou : Workers → **moviebox-api** → **Settings** → **Domains & Routes** → Add `apiv1.freehandyflix.online`

## Serveur stream (Heroku / Railway / VPS)

Dossier **`proxy/`** — package Node.js autonome :

```bash
cd proxy
npm install
npm start
# ou Heroku/Railway : root directory = proxy
# ou pm2 start ecosystem.config.cjs
```

Nginx exemple : `stream.example.com` → `127.0.0.1:7861`

## API Node locale (sans Cloudflare)

```bash
STREAM_PROXY_URL=https://ton-stream.example.com npm start
```
