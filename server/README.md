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
WECHAT_APP_ID=your-wechat-app-id
WECHAT_APP_SECRET=your-wechat-app-secret
INCIRCLE_SUPER_ADMIN_OPENIDS=your-openid
JWT_SECRET=your-long-random-secret
AI_CREDENTIALS_ENCRYPTION_KEY=64-random-hex-characters
AI_PROVIDER_TIMEOUT_MS=300000
AI_CONTENT_SECURITY_ENABLED=true
```

`WECHAT_APP_SECRET` is required because the backend validates every login request with WeChat `jscode2session` and generates official WeChat Mini Program invite codes with `getwxacodeunlimit`.

## Deploy

From the Windows project root, first create the local private deployment script from the committed template:

```powershell
Copy-Item .\scripts\deploy-server.example.ps1 .\scripts\deploy-server.ps1
```

Set the local AppID and public API URL in `scripts/deploy-server.ps1`, or pass them as command parameters. The copied script is excluded from Git. Then deploy with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1 -HostName "your-server-host"
```

If the server `.env` does not have `WECHAT_APP_SECRET` yet, pass it once during deploy:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1 -HostName "your-server-host" -WechatAppSecret "your-wechat-app-secret"
```

The script preserves `.env`, backs up PostgreSQL when it is already running, rebuilds containers, runs migrations, and checks `/health`. It does not delete the PostgreSQL volume or uploaded files.

The first deployment containing the circle AI feature also generates and preserves `AI_CREDENTIALS_ENCRYPTION_KEY` automatically. Do not rotate or remove that value unless every saved provider API key will be entered again.

## Circle AI Assistant

Circle AI is disabled by default for every circle. A circle owner, circle super admin, or platform super admin can add an approved provider, save an encrypted API key, sync or manually add models, choose a default model, and then enable the assistant from circle settings.

- Provider credentials are encrypted with AES-256-GCM and never returned to the Mini Program.
- Members cannot configure providers or quotas; circle owners and super admins can.
- Conversations are scoped by `circle_id + user_id`; owners and super admins cannot read other members' messages.
- Provider requests reject HTTP, credentials in URLs, loopback, private, link-local, metadata, unsafe DNS, and unsafe redirects.
- Text input and buffered model output use WeChat `msg_sec_check` when `AI_CONTENT_SECURITY_ENABLED=true`.
- Chat requests use `reasoningMode=auto|on|off`. `auto` omits provider reasoning parameters, while `on` and `off` use the selected provider's native controls; unsupported explicit modes are rejected instead of being silently simulated.
- Leaving or being removed from a circle physically deletes that member's AI conversations for the circle.

Before enabling AI in a public Mini Program version, update the WeChat privacy protection guide to disclose that user-entered chat content and current conversation context are sent to the selected AI provider. The first-use consent screen in the Mini Program does not replace this platform declaration.

`AI_PROVIDER_TIMEOUT_MS` is an upstream idle timeout, not a total generation limit. Each provider chunk resets it, so long answers are not cut off while data is still arriving.

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
docker compose exec api npm run db:migrate
curl http://127.0.0.1:3000/health
```

Never use `docker compose down -v` unless you intentionally want to delete the database volume.
