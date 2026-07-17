# InCircle Self-Hosted Backend

This is the self-hosted runtime backend for the Mini Program. Configure the public HTTP API URL locally instead of committing a real production domain.

## Stack

- Node.js 20 + Fastify
- PostgreSQL 16
- Docker Compose
- Local mounted uploads at `./uploads`, served as `/uploads/...`

## Required Environment

Create or update `/home/ubuntu/incircle-server/.env` on the server:

```bash
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
POSTGRES_PASSWORD=your-db-password
DATABASE_URL=postgres://incircle:your-db-password@postgres:5432/incircle
CORS_ORIGINS=https://your-api.example.com
PUBLIC_BASE_URL=https://your-api.example.com
UPLOAD_DIR=/app/uploads
LEGAL_OPERATOR_TYPE=individual
LEGAL_OPERATOR_NAME=your-public-operator-name
LEGAL_CONTACT_EMAIL=legal-contact@example.com
LEGAL_TERMS_VERSION=your-terms-version
LEGAL_PRIVACY_VERSION=your-privacy-version
LEGAL_EFFECTIVE_DATE=YYYY-MM-DD
WECHAT_APP_ID=your-wechat-app-id
WECHAT_APP_SECRET=your-wechat-app-secret
INCIRCLE_SUPER_ADMIN_OPENIDS=your-openid
JWT_SECRET=your-long-random-secret
AI_CREDENTIALS_ENCRYPTION_KEY=64-random-hex-characters
AI_PROVIDER_TIMEOUT_MS=300000
AI_CONTENT_SECURITY_ENABLED=true
```

`WECHAT_APP_SECRET` is required because the backend validates every login request with WeChat `jscode2session` and generates official WeChat Mini Program invite codes with `getwxacodeunlimit`.

The legal configuration is only an initialization seed for the singleton `incircle_public_legal_profile` table. Migration fills missing fields but never overwrites a complete database profile on later deploys. `LEGAL_OPERATOR_TYPE` accepts `individual` or `enterprise`; migration `0025` may initialize only this newly introduced field. Later legal text or version changes must be made deliberately in PostgreSQL. Changing either agreement version makes prior acceptance stale and requires users to confirm the current agreements again.

Docker publishes the API only on `127.0.0.1:3000` for the local reverse proxy. Keep `HOST=0.0.0.0` inside the container so Docker networking works; do not change the Compose port mapping back to `3000:3000`.

## Deploy

From the Windows project root, first create the local private deployment script from the committed template:

```powershell
Copy-Item .\scripts\deploy-server.example.ps1 .\scripts\deploy-server.ps1
```

Set the local AppID, public API URL, and first-install legal profile seed in `scripts/deploy-server.ps1`, or pass them as command parameters. The copied script is excluded from Git. Existing legal values in `.env` and PostgreSQL are preserved on later deploys. Then deploy with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1 -HostName "your-server-host"
```

If the server `.env` does not have `WECHAT_APP_SECRET` yet, pass it once during deploy:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1 -HostName "your-server-host" -WechatAppSecret "your-wechat-app-secret"
```

The script preserves `.env`, backs up PostgreSQL, builds the API image, stops the old API, runs migrations in a one-off container, starts the API, checks `/health`, and verifies that port 3000 is bound only to loopback. It does not delete the PostgreSQL volume or uploaded files.

The first deployment containing the circle AI feature also generates and preserves `AI_CREDENTIALS_ENCRYPTION_KEY` automatically. Do not rotate or remove that value unless every saved provider API key will be entered again.

## Circle AI Assistant

Circle AI is disabled by default for every circle. A circle owner, circle super admin, or platform super admin can add an approved provider, save an encrypted API key, sync or manually add models, choose a default model, and then enable the assistant from circle settings.

- Provider credentials are encrypted with AES-256-GCM and never returned to the Mini Program.
- Members cannot configure providers or quotas; circle owners and super admins can.
- Conversations are scoped by `circle_id + user_id`; owners and super admins cannot read other members' messages.
- Provider requests reject HTTP, credentials in URLs, loopback, private, link-local, metadata, unsafe DNS, and unsafe redirects.
- Text input and buffered model output use WeChat `msg_sec_check` when `AI_CONTENT_SECURITY_ENABLED=true`.
- Chat requests use `reasoningMode=auto|on|off`. `auto` omits provider reasoning parameters, while `on` and `off` use the selected provider's native controls; unsupported explicit modes are rejected instead of being silently simulated.
- Context windows and output limits are separate model capabilities. Context configuration supports up to 2,000,000 tokens; the circle output target defaults to 8,192 and can be set from 128 to 32,768 tokens.
- Model capability sources are ordered as `manual > provider sync > confirmed probe/compatibility > database catalog`. Sources are persisted as `manual`, `sync`, `probe`, `compatibility`, or `catalog`, and lower-confidence sources never replace higher-confidence values.
- Model testing never sends huge prompts to discover 128K or 1M context windows. Unknown contexts remain conservative until provider metadata, an exact database-catalog match, or a manual value is available.
- The effective output limit is bounded by the circle target, a known model output limit, and the remaining context budget. Unknown output capability is tried optimistically; an explicit pre-stream parameter rejection may retry once at 8,192 tokens and records that compatible value.
- Leaving or being removed from a circle physically deletes that member's AI conversations for the circle.

### Model capability catalog

The runtime catalog is stored in `incircle_ai_model_capability_catalog`; immutable import metadata is stored in `incircle_ai_model_catalog_releases`. The bundled `db/catalog/model-capabilities.json` release `2026-07-18.1` contains 689 text-model records across ten supported provider keys. It is a reviewed community seed based on `models.dev`, not an assertion that every entry is official or that every model in existence is covered. Runtime production processes do not scrape the internet.

Catalog matching is limited to an exact built-in provider key and normalized model ID or an explicitly stored alias. Custom providers and user-defined deployment names are not guessed. Manual database rows (`source_kind=manual`) and `official`/`verified` rows are protected from lower-confidence community imports.

To prepare a new release on a development machine:

```powershell
npm run ai:catalog:refresh -- --catalog-version 2026-07-18.2
npm test
npm run check
```

Always use a new catalog version after a release has been deployed. `npm run db:migrate` imports a new bundle transactionally. The same version and checksum is a no-op; the same version with a different checksum fails deployment instead of silently changing production data. `npm run db:catalog:import` can retry only the catalog import when needed.

Before enabling AI in a public Mini Program version, update the WeChat privacy protection guide to disclose that user-entered chat content and current conversation context are sent to the selected AI provider. The first-use consent screen in the Mini Program does not replace this platform declaration.

`AI_PROVIDER_TIMEOUT_MS` is an upstream idle timeout, not a total generation limit. Each provider chunk resets it, so long answers are not cut off while data is still arriving.

Each generating assistant message carries a 30-second database lease owned by the current API process. Checkpoints renew the lease, expired work is recovered as failed, and `SIGTERM`/`SIGINT` marks owned work as interrupted before shutdown. Docker grants the API 30 seconds for this shutdown path.

Operational provider consent remains in `incircle_ai_consents`. Immutable per-version evidence is appended to `incircle_ai_consent_acceptances`; deleting an account clears its user foreign key while retaining only the random agreement subject, provider/circle scope IDs, provider snapshots, version, and acceptance time.

The production stream uses guarded output: provider deltas are read continuously, reviewed in contextual batches, and then released with their original delta boundaries. Do not disable `AI_CONTENT_SECURITY_ENABLED` in production; removing it would allow unchecked user prompts and model output to reach the Mini Program.

If the WeChat Gateway product is enabled with no-code interception, exclude `/api/ai/chat/stream` from its routing rules. That gateway can buffer or time out long chunked responses and then retry through `wx.request`. The endpoint sends two-second SSE heartbeats and the API can resume an idempotent retry, but neither can override a gateway's hard request-duration limit. Bypassing the gateway for this one endpoint is required for the lowest-latency stream; other `/api/` endpoints can continue to use the gateway.

If the public API is behind Nginx, disable response buffering for the streaming endpoint and keep generous stream timeouts:

```nginx
location = /api/ai/chat/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_read_timeout 660s;
    proxy_send_timeout 660s;
}
```

Keep the existing general `/api/` reverse-proxy rule for all other endpoints.

If Docker permission fails on the server, run once:

```bash
sudo usermod -aG docker ubuntu
exit
```

Then SSH in again and rerun deploy.

## Manual Server Commands

```bash
cd ~/incircle-server
docker compose ps
docker compose build api
docker compose up -d postgres
docker compose stop api
docker compose run --rm api npm run db:migrate
docker compose up -d api
curl http://127.0.0.1:3000/health
```

Never use `docker compose down -v` unless you intentionally want to delete the database volume.
