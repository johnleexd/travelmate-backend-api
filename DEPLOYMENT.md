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
5. Build with `npm run build` and deploy the resulting application revision.
6. Start with `npm start`; production environment validation intentionally stops
   startup when security, sender, origin, or AI configuration is unsafe.
7. Require `GET /health` to return HTTP 200 with
   `{ "status": "ok", "database": "connected" }` before routing traffic.

The API trusts exactly one managed reverse proxy hop and rejects production
requests whose direct or `X-Forwarded-Proto` scheme is not HTTPS with HTTP 426.
Terminate TLS at the hosting platform and ensure it supplies
`X-Forwarded-Proto: https`; do not expose the Node process directly to the
internet.

## Transactional email activation

1. Add and verify the sending domain in Resend, including its DNS records.
2. Create a production Resend API key and store it only in the backend host.
3. Set `EMAIL_FROM` to a sender on that verified domain and set a temporary
   `EMAIL_SMOKE_TO` to an inbox you control.
4. From the backend release environment, run `npm run email:smoke` once. The
   command never prints the API key and fails unless the real provider accepts
   the message.
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
3. Never improvise destructive reverse SQL in production. For a data-corrupting
   incident, stop writes and restore through the managed database's tested backup
   procedure.
4. Re-run `/health`, authentication, and saved-trip retrieval checks before
   reopening traffic, then record the incident and corrective action.
