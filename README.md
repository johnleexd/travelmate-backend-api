# TravelMate Express API

This is the TravelMate backend: Express 5 with strict TypeScript, Prisma ORM,
and Neon PostgreSQL.

The codebase follows the same layered organization as Express Breeze while
keeping TravelMate's existing API contracts and providers:

```text
src/
|-- config/          Runtime environment validation
|-- constants/       Static application data
|-- controllers/     HTTP request/response orchestration
|-- exceptions/      Named application errors
|-- generated/       Prisma-generated client code
|-- lib/             Infrastructure clients
|-- middlewares/     Authentication, security, rate-limit, and HTTP adapters
|-- repositories/    Database persistence operations
|-- routes/          Thin Express route declarations and composition
|-- schemas/         Shared domain types and validation rules
|-- services/        Capability-specific business logic and providers
|-- utils/           Stateless shared helpers
|-- app.ts           Express application composition
`-- server.ts        Process startup and graceful shutdown
```

Dependencies flow inward from routes to controllers, services, and repositories.
Route files contain no business logic, and `app.ts` owns only global middleware
and router composition.

Copy `.env.example` to `.env` and add the Neon pooled `DATABASE_URL`. Production
also requires a Resend API key and verified `EMAIL_FROM` sender for account
verification and password recovery. Then run:

```powershell
npm.cmd install
npm.cmd run db:setup
npm.cmd run dev
```

Production startup fails fast when `DATABASE_URL` is missing, local, or still a
placeholder; when session and account-token secrets are unsafe; when frontend
origins are not canonical HTTPS origins; when transactional email or AI is not
configured; or when `AI_MOCK_FALLBACK=true`. These checks prove configuration
shape, not external account ownership or provider availability, which must still
be verified through the deployment smoke test.

The server listens on port 5000 by default and exposes:

- `GET /health`
- `GET|POST /api/auth`
- `GET|PATCH /api/profile`
- `GET|POST /api/platform`
- `POST /api/itinerary`
- `GET /api/weather`
- `GET /api/locations`
- `GET /api/destination-context`
- `GET /api/accommodations`
- `GET /api/travel-options`

`DATABASE_URL` is used by Prisma Migrate and at runtime through Prisma's standard
PostgreSQL driver adapter. `DIRECT_URL` is optional and reserved for administrative tools
that specifically require a direct PostgreSQL connection.

Database writes use targeted Prisma operations. Related changes such as a
booking plus its capacity adjustment and audit event run in one transaction;
the API never rebuilds whole tables to persist a single action.

Saved-trip actions on `POST /api/platform` are `save-trip`, `update-trip`,
`duplicate-trip`, and `delete-trip`. Every lookup includes the authenticated
traveler ID, preventing one traveler from reading or mutating another traveler's
records. Trip ranges are limited to 1–14 days and stored with both start and end dates.
Every trip carries one supported ISO currency through generation, budget calculations,
persistence, and manual edits. Destination selection stores structured city, region,
country, country code, and coordinates; `/api/destination-context` maps that country
code to a supported local currency and curated, honestly labeled transport guidance.
The supported currency set is `PHP`, `USD`, `EUR`, `JPY`, `KRW`, `THB`, `GBP`, `AUD`,
`CAD`, `SGD`, `CNY`, `HKD`, `TWD`, `MYR`, `IDR`, `VND`, `INR`, `NZD`, `CHF`, and `AED`.
Stored budgets use PostgreSQL decimal values; zero-decimal currencies use whole units.
Offers in another currency remain visible for comparison but cannot be silently mixed
into a trip budget. Unsupported country codes produce an explicit manual fallback;
the system does not invent exchange rates.

Live Amadeus selections carry a server-generated HMAC token that binds identity,
price, currency, and live/test state. The itinerary API rejects browser-modified
offer data. Without Amadeus credentials,
the endpoint returns an explicit `configured: false` response rather than invented
availability. PayMongo is not integrated; payment states are a labeled simulation.

The unified travel-options endpoint normalizes Amadeus Flight Offers Search and
Tours and Activities results into stable comparison fields with provider, currency,
live/test status, and `fetchedAt` metadata. It also includes approved local activity
listings when available. Provider failures return explicit unavailable messages and
never fabricate flight, activity, or price data.

## Provider caching and freshness

Provider responses use a bounded in-process cache with request coalescing. Every
provider-backed response includes `freshness` metadata with its source, status,
fetch time, fresh expiry, stale cutoff, and a human-readable policy. A cached
value is served after its fresh TTL only when the upstream provider fails, and
only until the stale cutoff. Data older than that cutoff is never returned.

| Data source | Fresh TTL | Stale fallback cutoff |
| --- | ---: | ---: |
| Flights | 5 minutes | 15 minutes from fetch |
| Hotels | 5 minutes | 15 minutes from fetch |
| Activities | 30 minutes | 2 hours from fetch |
| Weather | 15 minutes | 1 hour from fetch |
| Exchange rates | 6 hours | 24 hours from fetch |

The possible statuses are `live`, `fresh-cache`, `stale-cache`, and
`unavailable`. The frontend permanently displays the status beside each result
group. `stale-cache` is rendered as an amber warning and is never presented as
live data. This cache is intentionally per API process; deployments with several
instances may independently refresh the same provider key.

AI mock itineraries are available only when `AI_MOCK_FALLBACK=true` outside
production. Production startup requires a configured OpenAI or Gemini provider.
If a configured provider times out, rejects the request, or fails schema validation
after one repair attempt, the itinerary endpoint returns a retryable error and never
replaces the user's current plan with mock data.

Weather uses OpenWeatherMap when configured and keyless Open-Meteo otherwise. It
returns `forecastAvailable: false` when the requested dates fall outside the live
forecast window. If both providers fail, it returns an explicit `unavailable` state
with no fabricated current conditions or forecast. Condition responses include
`fetchedAt`, `refreshAfter`, and date-matched crowd snapshots. Crowd values are
low-confidence, deterministic calendar-based estimates, not live foot-traffic or
venue-capacity data. Their timing suggestions remain advisory and never rewrite
itinerary activities automatically.

Run local logic tests with `npm.cmd test`. After seeding the demo records, run
the Neon-backed persistence checks with `npm.cmd run test:integration`.

## Continuous integration

`.github/workflows/ci.yml` runs unit tests, TypeScript checks, and the production
build on pushes and pull requests. Its database job starts an ephemeral PostgreSQL
16 service, applies every committed Prisma migration, seeds deterministic demo
records, and runs the integration suite. It never uses the production Neon
database or production provider secrets.

The frontend repository's E2E workflow checks this repository out beside the
frontend at `../travelmate-backend-api`. If this repository is private, add a
frontend repository secret named `BACKEND_REPO_TOKEN` containing a fine-grained,
read-only token with Contents access to this repository. Public repositories use
the workflow's normal GitHub token automatically.

Production environment gates, migration order, health monitoring, smoke tests,
and non-destructive rollback steps are documented in `DEPLOYMENT.md`.

Authentication codes are stored only as SHA-256 hashes in the `account_tokens`
table. Verification codes expire after 30 minutes; password-reset codes expire
after 15 minutes and are single-use. A successful password reset increments the
user session version so previously issued session cookies stop authorizing requests.
Development responses expose test codes when transactional email is not configured;
production startup requires `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and
`EMAIL_FROM`. Token hashes use a separate production `ACCOUNT_TOKEN_SECRET` so
database access alone is not enough to test guessed recovery codes offline.
# Account roles

TravelMate supports traveler and admin accounts through one login endpoint.
Public registration always creates a traveler. Migration
`20260930000000_traveler_admin_roles` converts legacy owners to travelers and
invalidates their old sessions without deleting their records. The admin dashboard
contains Overview, Users, Reports, and System Health. Profile approvals, trust
scoring, listings, bookings, disputes, and payment workflows are retired; historical
records remain intact. Email verification still protects sign-in.

Travelers submit problem reports from their account page. Migration
`20261001000000_traveler_reports` adds the report kind to the existing review table.
Only admins can read the report queue or resolve reports; each resolution is audited
and notifies the traveler. System Health shows service configuration and recent
generation failures, without claiming that configured providers are currently live.
# Suspension appeals

Suspended travelers can authenticate but cannot use normal platform, planning,
or profile APIs. They are redirected to `/account/appeal`, where the authenticated
`/api/account/appeal` endpoint exposes only their own account notices and appeal
history. One pending appeal per traveler is enforced in the database.

Admins review appeals in Reports using the `review-appeal` platform action, with
an `approved` or `rejected` decision and a 10–2000 character message. Approval
restores access; rejection keeps the suspension. Both decisions send an in-app
notification. Manual restoration also closes pending appeals. Apply all Prisma
migrations before using this flow.
