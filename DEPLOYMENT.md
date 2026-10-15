# TravelMate API deployment runbook

This runbook is provider-neutral. Deploy the API to a managed Node.js service
that supports Node.js 22, HTTPS, environment secrets, release commands, and a
long-running process. Use a managed PostgreSQL database with backups and pooled
application connections.

## Required production environment

Set these as encrypted platform variables, never committed files:

- `NODE_ENV=production`
- `PORT` as assigned by the host
- `DATABASE_URL` using the production pooled PostgreSQL connection
- `FRONTEND_URL` as one or more comma-separated, exact HTTPS origins
- `SESSION_SECRET` with at least 32 random characters
- `ACCOUNT_TOKEN_SECRET` with at least 32 different random characters
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for the production Google OAuth client
- `GOOGLE_OAUTH_REDIRECT_URI` as the HTTPS frontend callback URL registered in Google
- `OAUTH_STATE_SECRET` with at least 32 characters, different from both other secrets
- `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and a verified `EMAIL_FROM`
- `AI_PROVIDER=openai` plus `OPENAI_API_KEY`, or `AI_PROVIDER=gemini` plus
  `GEMINI_API_KEY`

Weather and Amadeus variables remain optional; their routes return explicit
unavailable states when credentials are absent. Do not enable
`AI_MOCK_FALLBACK` in production. `PAYMONGO_SECRET_KEY` does not make payment
processing real; payments remain a labeled simulation until that integration is
implemented.

## Release sequence

1. Confirm the backend CI workflow passes for the release revision.
2. Create or verify a current managed-database backup/restore point.
3. Install locked dependencies with `npm ci`.
4. Apply additive migrations with `npm run db:migrate` using the production
   `DATABASE_URL`. Never run `db:seed` against production.
   The authentication/generation safety migration must be applied before deploying
   code that queries `revoked_sessions` or generation `attempt_id` values.
   Inspect legacy seed logins with `npm run security:disable-demo-logins`, and
   use `-- --apply` if the old demo credentials are detected.
5. Build with `npm run build` and deploy the resulting application revision.
6. Start with `npm start`; production environment validation intentionally stops
   startup when security, sender, origin, or AI configuration is unsafe.
7. Require `GET /health` to return HTTP 200 with
   `{ "status": "ok", "database": "connected" }` before routing traffic.

Deploy this backend before the matching frontend: logout now returns the required
`sessionRevoked` flag, which the frontend uses to distinguish server revocation
from clearing only this browser's cookie.

The API trusts exactly one managed reverse proxy hop and rejects production
requests whose direct or `X-Forwarded-Proto` scheme is not HTTPS with HTTP 426.
Terminate TLS at the hosting platform and ensure it supplies
`X-Forwarded-Proto: https`; do not expose the Node process directly to the
internet.

## Docker Hub and SSH deployment

The Docker integration follows the reference portfolio backend's Docker Hub and
SSH deployment flow. Local `docker-compose.yaml` builds the API; production
`docker/docker-compose.yaml` pulls the published image. The existing Backend CI
workflow retains unit, type, and database checks and also builds the Docker image,
applies migrations to an isolated PostgreSQL database, and checks container health.

`.github/workflows/deploy.yaml` runs after a successful Backend CI push on `main`.
A manual run on `main` also requires successful CI for that exact revision. Images
are tagged with the full Git commit and `latest`, while the server deploys the
immutable image digest. Only the backend is containerized by this integration.

Configure these repository or `production` environment secrets in GitHub:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub account that owns `travelmate-backend-api` |
| `DOCKERHUB_TOKEN` | Docker Hub token with push access to that image repository |
| `SSH_HOST` | Deployment server hostname or IP address |
| `SSH_USER` | Server user with Docker access and write access to the deployment directory |
| `SSH_PRIVATE_KEY` | Private key for that deployment user |
| `SSH_FINGERPRINT` | SHA256 fingerprint of the server's SSH host key |

Keep Docker Hub secrets at repository scope because the build job publishes
before entering the `production` deployment environment. SSH secrets may live
in that environment. Optional repository/environment variables:

| Variable | Default |
| --- | --- |
| `DEPLOY_PATH` | `/root/travelmate-backend-api` |
| `SERVER_ENV_FILE` | `/root/env/travelmate-backend-api/.env` |
| `SSH_PORT` | `22` |

The server must support Linux amd64, have Docker Engine and Compose v2.20 or
newer, and provide HTTPS through a reverse proxy. If the image repository is
private, log in to Docker Hub on the server once with a read-only token using
`docker login`; the deployment workflow does not copy registry tokens to the server.

Create the deployment directory and the runtime environment file on the server.
The defaults below assume an SSH user that can write under `/root`; set the
variables above for a dedicated deployment user's directories instead.

```sh
mkdir -p /root/travelmate-backend-api /root/env/travelmate-backend-api
chmod 700 /root/env/travelmate-backend-api
touch /root/env/travelmate-backend-api/.env
chmod 600 /root/env/travelmate-backend-api/.env
```

Fill the runtime file with the required production variables listed above.
Use `NODE_ENV=production`, `PORT=8000`, `AI_MOCK_FALLBACK=false`, the Neon pooled
database URL, HTTPS frontend origins, and the real provider credentials.
The Google redirect URI must point to the frontend's
`/api/auth/oauth/google/callback` route. Configuration remains on the server;
the workflow copies only Compose and `scripts/deploy.sh`.

Production Compose defaults to `johnlyy/travelmate:latest` and
`/root/env/travelmate-backend/.env`; the deployment script overrides these through
`TRAVELMATE_IMAGE` and `TRAVELMATE_ENV_FILE` to use the verified release digest and
configured server environment file.

Production Compose binds the API to `127.0.0.1:8002` by default (container port
8000); set `TRAVELMATE_PORT` to change the host port. Route HTTPS API traffic
through the server's reverse proxy to that port and set `X-Forwarded-Proto: https`.
The container's internal health probe supplies that header for its loopback
request. This checks readiness; it does not verify the public TLS configuration.

Each deployment pulls the selected image, runs `prisma migrate deploy`, and
recreates only the TravelMate app. A migration failure leaves the running app
in place. The deployment waits up to 120 seconds for healthy startup; if a new
image fails, it restores the previous app image and reports failure. Migrations
remain applied during rollback, so releases must keep them compatible with the
previous application. No seeding, database reset, or host-wide image pruning
runs during deployment. Verify the database restore point before a release.

For an initial manual server deployment after copying `docker/` and `scripts/`
into the deployment directory:

```sh
export TRAVELMATE_IMAGE=YOUR_DOCKERHUB_USERNAME/travelmate-backend-api:FULL_COMMIT_SHA
export TRAVELMATE_DEPLOY_DIR=/root/travelmate-backend-api
export TRAVELMATE_ENV_FILE=/root/env/travelmate-backend-api/.env
sh "$TRAVELMATE_DEPLOY_DIR/scripts/deploy.sh"
```

Use the same command with a previous commit tag for an operator-directed rollback.
The script keeps rollback scoped to application images; it never reverses database
migrations. Complete the production smoke checks below through the public HTTPS
origin after the container is healthy.

## Transactional email activation

For local development without a domain, use the Gmail SMTP setup in
[README.md](README.md#development-gmail-smtp-without-purchasing-a-domain):
`EMAIL_PROVIDER=gmail`, `SMTP_USER`, `SMTP_PASS` (Google App Password), and
`EMAIL_FROM` matching the Gmail sender. It requires Google 2-Step Verification
and outbound TLS access to `smtp.gmail.com:465`. Gmail is deliberately disabled
in production; the production requirements below remain enforced. Keep all
credentials in the backend environment. Switching providers preserves accounts.

1. Add and verify the sending domain in Resend, including its DNS records.
2. Create a Resend API key with Sending access for that domain in the same
   account/team and store it as `RESEND_API_KEY` only in the backend host.
   Set `EMAIL_PROVIDER=resend`.
3. Set `EMAIL_FROM` to a sender on that verified domain and set a temporary
   `EMAIL_SMOKE_TO` to an inbox you control.
4. Run `npm run email:check` to validate settings without sending. From the
   backend release environment, run `npm run email:smoke` once. The
   command never prints the API key and fails unless the real provider accepts
   the message.
   Confirm the email's delivered status and receipt in the inbox separately.
   Host environment variables take precedence over the backend `.env`; the
   script loads that file by location, independent of the working directory.
5. Remove `EMAIL_SMOKE_TO` after verification if the platform does not need to
   retain it. Registration and password recovery continue to use the same
   verified sender.

## Production smoke test

Use dedicated smoke-test accounts and remove their data afterward.

1. Check `/health` and the API information route over HTTPS.
2. Register with a real inbox. Confirm the response does not expose the
   verification code and that the Resend message arrives.
3. Verify, sign in, sign out, request a password reset, and confirm the old
   session no longer authorizes requests after reset.
4. Generate one short itinerary through the configured AI provider; verify its
   source, dates, currency, and totals.
5. Save, reload, edit, update, duplicate, and delete a smoke trip.
6. Confirm missing optional weather/Amadeus configuration is disclosed as
   unavailable rather than fabricated.
7. Review application logs for the smoke-test request window and confirm no
   passwords, session cookies, provider keys, or account codes were logged.

## Monitoring

- Probe `/health` at least once per minute and alert after two consecutive
  failures.
- Alert on sustained HTTP 5xx responses, database pool exhaustion, process
  restarts, and abnormal authentication or rate-limit volume.
- Track Resend rejection/bounce events and AI/provider error rates separately
  from application defects.
- Keep structured logs for request correlation, but never log request secrets or
  full authentication payloads.

## Rollback

1. Stop traffic to the unhealthy revision and redeploy the last known-good
   application artifact.
2. Current migrations are additive; leave them applied when rolling application
   code back unless a reviewed compatibility analysis says otherwise.
   For the authentication/generation safety release, choose a backend revision
   that still checks `revoked_sessions` and writes generation `attempt_id` values.
   Earlier revisions can reauthorize revoked cookies or fail generation inserts;
   they require a separate compatibility and session invalidation plan.
3. Never improvise destructive reverse SQL in production. For a data-corrupting
   incident, stop writes and restore through the managed database's tested backup
   procedure.
4. Re-run `/health`, authentication, and saved-trip retrieval checks before
   reopening traffic, then record the incident and corrective action.
