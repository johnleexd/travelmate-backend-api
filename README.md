# TravelMate Express API

Location selection scope is shared with the frontend through
`src/lib/location-scope.ts`. A verified locality is selectable independently of
its child count. Imported administrative records retain their source level;
explicit Chinese local terms such as ADM4 Zhen/Xiang identify towns/townships,
while unclassified administrative divisions remain areas. Caohai Zhen (GeoNames
10260117) uses its recorded Yunnan parent and coordinates without requiring a
lower settlement. No catalogue data rewrite or external geocoding is needed.

Expense unit extension lives in `src/lib/expense-ledger.ts` and is synchronized to
the frontend. Stored activity amounts are extended totals, with price evidence
recording the unit, quantity and participants. AI route output must include the
full selected party; backend pricing never uses a smaller AI subgroup. Solo and
couple counts are enforced during generation and saved-plan validation.

No database migration or historical rewrite is required: existing itinerary JSON
already stores party details and price evidence. Reads preserve historical
activities and edits. Missing cost bases, inconsistent coverage and unitemized
legacy balances require refresh/clarification, rather than inferred per-person
prices. Shared quotes retain their recorded total; room quantities include nights,
and provider occupancy/child pricing is preserved. Trip budgets cover the whole
party. Equal shares use minor currency units and reconcile with the total.

This is the TravelMate backend: Express 5 with strict TypeScript, Prisma ORM,
and Neon PostgreSQL.

System Health's Activity Log reads `GET /api/platform/activity?page=1&q=...`.
It requires an active authenticated admin and returns 10 records per page, ordered
by creation time and ID. Search covers all stored events by current actor name,
readable action label/action code, target ID, or event ID; percent and underscore
are literal search characters. The query joins `audit_events.actor_id` to `users.id`.
It never infers the actor from the polymorphic target ID. Names and roles are current
account metadata, not historical snapshots. Missing identities have explicit
unavailable/not-recorded fallbacks. Existing writers already record an actor ID,
so this change needs no migration, identity backfill, or changes to stored events.

Action presentation is maintained in `activity-presentation.ts`. Generic account
status events stay generic; the reader does not invent a specific old decision.
Unrecognized values show Other activity. Embedded plan activation/payment metadata
is excluded from responses and search; the legacy platform snapshot also exposes
only safe action codes. Neither response includes credentials or authentication
tokens. Stored raw audit values remain unchanged. Verify with
`node --test --experimental-strip-types tests/activity-log.test.ts` and the isolated
database suite `tests/integration/activity-log.test.ts`.

Itinerary generation starts place-reference discovery and advisory weather in
parallel. Each Wikipedia/Wikidata reference request has a 12-second timeout within
the existing overall discovery budget. A host that times out, fails to connect,
or returns a server error is skipped for the remainder of that lookup, allowing
healthy language/reference sources to continue. Missing evidence still produces
an explicitly incomplete plan; timeouts never justify invented attractions.
AI calls and bounded validation/repair can add further time, especially for long
trips. A successful controlled test is not a promise of live provider latency.

Saved-trip visit recording uses the existing `visited_places` database table and
`POST /api/platform` action infrastructure. `GET /api/platform/trips/:id/visit-candidates`
reads all named saved itinerary places and existing visit status for the signed-in
owner. `record-trip-visits` accepts `tripId`, selected `{key,fingerprint}` pairs,
an actual `visitDate`, and the user's `timeZone`. It rechecks the current itinerary,
rejects stale selections, and saves the batch atomically under a per-user database
lock. Duplicate retries (including a different date) do not add those places again.
The separate manual `record-visit` action retains dated return visits.

Verified Wikidata IDs provide cross-trip identity. Other saved places use coordinates
and full locations; uncertain names without points or precise locations retain a
trip/activity identity to avoid combining unrelated namesakes. Historical provider
references remain stored even when insufficient for verified-ID deduplication.
Migration `20261015000000_visited_place_media` adds optional place/photo metadata;
existing visits remain compatible. Neither recording nor deleting visits updates
trip status, and completion/reopening does not write visited records.

Saved-trip navigation uses signed traveler-only `POST /api/navigation/search` and
`POST /api/navigation/route`. Explicit place/address searches share the existing
Nominatim queue; no public-geocoder autocomplete is added. Routes use OSRM/FOSSGIS
walking, cycling and driving datasets with validated geometry and maneuvers. GPS
coordinates are accepted in request bodies, used transiently and never stored in
trips, visits or audit records. Request logs omit bodies and query parameters.
The routing provider can log route queries; the UI links to its privacy information.
Each endpoint permits 12 requests per traveler per minute; a database bucket also
limits all instances to one public routing request per 1.1 seconds. 429 responses
include Retry-After. Unreachable routes, invalid data and provider failures are
reported without invented path geometry.

`NAVIGATION_ROUTING_BASE_URL` defaults to `https://routing.openstreetmap.de/` for
this non-commercial capstone. That public service has usage limits and no uptime
guarantee. For production/heavier use, configure a controlled deployment exposing
`routed-foot`, `routed-bike` and `routed-car` OSRM paths. `DESTINATION_GEOCODER_URL`
can similarly select a controlled geocoder. No paid subscription or new secret
API key is required. Frontend routing requests do not run for every GPS fix.

Manual destinations resolve through `/api/locations/resolve` before confirmation.
Suggestions and resolved entries share validated coordinates, ISO country codes
and provider IDs. Explicit lookups can use keyless Nominatim when GeoNames lacks
a locality; public Nominatim is not used for autocomplete. Compound country and
region qualifiers are retained. Ambiguous names require the traveler to choose.
Country/region/island selections offer city/town narrowing instead of searching
a broad geographic center for hotels.

`GET /api/locations/areas` automatically browses verified cities/towns within the
selected parent, supports `query` and paginated `offset`, and returns membership
evidence, source links and timestamps. Country membership uses the worldwide
GeoNames catalogue; ADM1 regions use administrative membership; islands and other
regions use a matching OSM boundary and point-in-polygon checks. The catalogue is
not exhaustive. Searches can retrieve additional GeoNames settlements, and areas
without catalogue cities can retrieve mapped towns inside their verified boundary.

`GET /api/locations/areas/compare` retrieves a sample of mapped food, culture and
nature places within 1 km of up to six validated city centres. The UI compares four
current suggestions and uses the entered budget as a per-person daily allowance,
not a researched price. Neither browsing nor comparison chooses a city. Geographic
data is cached for 24 hours; interest samples for six hours; in-flight requests are
shared and provider errors have a cooldown. Set `DESTINATION_AREAS_PLACES_URL` for
a compatible hosted/private Overpass interpreter; otherwise the existing
`ACCOMMODATION_PLACES_URL` or the public development endpoint is used.

Public Nominatim boundary lookups run only after explicit area selection, share
the manual-resolution queue (at least 1.1 seconds apart), and are cached; typing
uses GeoNames/Open-Meteo, never public Nominatim autocomplete. Follow the
[public Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/).
Configure a hosted/private `DESTINATION_GEOCODER_URL` for production capacity or
multiple app instances; the public service's limit applies across the application.

Mapped accommodation searches start within 1 km, expanding to 3/10/30 km only
when the smaller area has no named properties. Results retain their OSM IDs,
actual mapped addresses/localities or coordinates, and distance from the chosen
center. They never imply a room price, vacancy or a reservation. Responses
distinguish ready, no-results, provider-error and needs-area states. Amadeus room
quotes additionally require `AMADEUS_API_KEY` and `AMADEUS_API_SECRET`.
Configure `DESTINATION_GEOCODER_URL`, `ACCOMMODATION_PLACES_URL` and optionally
`ACCOMMODATION_PLACES_FALLBACK_URL` for hosted/private provider capacity.

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

`db:setup` applies the schema without creating demo users. Demo seeding is
disabled in production and requires an explicit local opt-in:
`TRAVELMATE_ALLOW_DEMO_SEED=true`, with distinct `DEMO_ADMIN_PASSWORD` and
`DEMO_TRAVELER_PASSWORD` values of 16–64 characters satisfying the password rules.
Supply these through local environment variables, then run `npm run db:seed`.
The seed never resets an existing account or reactivates a disabled one.

For databases created using the old public demo password, run
`npm run security:disable-demo-logins` to inspect the affected seed identities,
then append `-- --apply` to disable those logins and invalidate their sessions.
Owned data and audit history are retained. Accounts already using a different
password are skipped. Real administrator accounts should be provisioned separately.

Logout revokes the current session on the server. If the database is unavailable,
browser cookies still clear and the UI explains that server revocation could not
be confirmed; it does not claim the copied token was invalidated.

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

## Docker

With Docker Engine and Docker Compose v2.20 or newer installed, configure the
backend `.env` as above and run from this backend directory:

```powershell
docker compose up --build --detach --wait
docker compose logs --follow app
```

Compose applies the existing Prisma migrations before starting the compiled API.
The API is available at `http://localhost:8002`; set `TRAVELMATE_PORT` to another
host port if needed. The Next.js frontend can
continue running on the host with its `BACKEND_URL` pointing to this port.
This container defaults to development settings with production build artifacts;
set `NODE_ENV=production` to enable production configuration checks. Source edits
require rebuilding the image.

To build without starting containers, run `docker compose build`. The default
image tag is `johnlyy/travelmate:local`; set `TRAVELMATE_IMAGE` to use another tag.
Building creates a local image; publishing it requires a separate push.

The multi-stage Dockerfile uses Node.js 22, runs the API as the `node` user,
and checks both API and database readiness. Prisma is a production dependency
so the same image can run the one-shot migration service. Provider secrets are
supplied at runtime; `.dockerignore` excludes environment files and local dependencies.

The standard `node:22-bookworm` base includes CA certificates and OpenSSL. It is
larger than the slim variant, but avoids a build-time `apt-get` download from
Debian mirrors, which can fail on networks that block outbound HTTP (port 80).
Building still requires access to Docker Hub and the npm registry.

For Docker Hub publishing, SSH deployment, required GitHub secrets, server
configuration, and rollback, see [DEPLOYMENT.md](DEPLOYMENT.md#docker-hub-and-ssh-deployment).

Accommodation discovery uses destination coordinates worldwide. Country-level
selections require choosing a city or area first. OpenStreetMap/Overpass supplies
nearby hotel, hostel, resort, guesthouse, motel, and apartment names and locations;
these listings carry **no price or availability claim**. Listings are cached for
24 hours and the shared public endpoint is capped at 100 uncached searches/day.
Set backend `ACCOMMODATION_PLACES_URL` to a hosted/private Overpass interpreter
for production or greater traffic. The development default requires no API key.
Attribution is shown in the planner; data is © OpenStreetMap contributors (ODbL).

Traveler workspace reads support `GET /api/platform?scope=traveler&summary=true`
with an optional owned-trip `cursor`: each page contains at most 20 trip summaries
and `tripsPage` metadata, without itinerary/weather snapshots. The frontend uses
this mode; the original full workspace response remains available for compatibility.
`GET /api/platform/trips/:id` loads one owned plan, and
`GET /api/platform/trips/:id/versions` loads pages of 50 version metadata records.
`GET /api/platform/notifications` reads only the current account's latest 50 notices.
Saved budget summaries, shares, and optimization suggestions are recalculated
server-side from validated item and selected-travel costs.

New itinerary versions store a versioned envelope inside the existing JSON column,
including original trip metadata. Restore validates the envelope and atomically
recovers the plan and its matching context. No new database migration is required.
Older plain-itinerary versions recover recorded core details; unrecorded geographic
details and interests are cleared, and the response flags `legacyContextRecovered`.
If a legacy snapshot did not record its party details, restoration fails safely
without modifying the current trip; those historical values cannot be inferred.

Optional Amadeus room offers require backend `AMADEUS_API_KEY`,
`AMADEUS_API_SECRET`, and `AMADEUS_ENV=production` for real availability.
`AMADEUS_ENV=test` produces explicitly labeled test offers, not real availability.
Hotel Search access and inventory coverage depend on the Amadeus account.
Quoted totals cover the requested rooms and are counted once in the budget.
Mapped or manually entered stays are saved as unpriced planning preferences;
no lodging quote is fabricated. Outages and empty results allow manual entry
or choosing accommodation later. Restart the API after changing environment settings.
- `GET /api/travel-options`

`DATABASE_URL` is used by Prisma Migrate and at runtime through Prisma's standard
PostgreSQL driver adapter. `DIRECT_URL` is optional and reserved for administrative tools
that specifically require a direct PostgreSQL connection.

Database writes use targeted Prisma operations. Related changes such as a
booking plus its capacity adjustment and audit event run in one transaction;
the API never rebuilds whole tables to persist a single action.

Saved-trip actions on `POST /api/platform` include `save-trip`, `update-trip`,
`delete-trip`, and the completion, archive, and version-restoration actions. Trip
duplication has been removed. Every lookup includes the authenticated
traveler ID, preventing one traveler from reading or mutating another traveler's
records. Trip ranges support 1–31 calendar days, counting both start and end dates,
and are stored with both dates. Longer AI itineraries use consecutive batches of at
most seven days. Each batch selects only backend-supplied place IDs and excludes
already used places. The server validates dates, participants, geographic transfer
time and available opening-hour references, and repairs invalid batches once.
Prices and group totals are calculated by backend code; failed or incomplete plans never replace
the current plan. Generation may take several minutes for a month-long trip.
Accommodation uses 30 nights for 31 travel days (a selected overnight stay on a
one-day trip retains the existing one-night behavior). Run `npm run db:migrate`
to apply `20261006000200_trip_duration_31_days`, which extends the existing trip
date constraint without changing saved accounts or itineraries. Weather requests
accept the full trip range but retain only actual provider forecast dates; Open-Meteo
still requests 14 days and dates outside coverage are labeled unavailable.
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

### Grounded itinerary generation

`POST /api/itinerary` requires `startingLocation`, `destinationDetails`
(city/country/countryCode/latitude/longitude), matching top-level coordinates and
valid dates. AI arranges a Wikipedia/Wikidata catalog; it does not generate prices,
venue facts or photos. Exact place-linked Commons files carry attribution, and
missing photos use placeholders. Conservative reference coverage can leave days
without supported attractions. Opening hours, access and estimated walking
transfers still need confirmation.

Optional `rooms`, `nightlyRoomEstimate`, `foodDailyPerPerson`, `transportFare`,
`transportFareType`, `fees` and `contingencyPercent` set explicit user assumptions.
Without researched prices, the plan labels budget allowances and their basis,
never confirmed market prices. Rooms × nights, daily food × party × days,
participating activity travelers and shared/per-person fares are computed on the
backend. Group totals and equal shares include contingency (10% of the subtotal
by default). Selected quote amounts are included once; activity group amounts
assume per-person headline fares and require confirmation of coverage.

The signed `grounding`/`groundingProof` metadata fits existing itinerary/version
JSON storage; it adds no migration. Saving validates formulas and category totals
independently. Manual changes downgrade unsupported claims to user estimates.
Reference caches are backend-only, bounded and keyed by destination/coordinates
(6 hours fresh, 24 hours stale fallback). Existing quote caches use trip parameters.
Food menus, local fares, complete mandatory fees and street/transit routing need
additional source integrations. Amadeus credentials enable provider quotes;
neither AI nor a venue price level establishes an actual price.

The unified travel-options endpoint normalizes Amadeus Flight Offers Search and
Tours and Activities results into stable comparison fields with provider, currency,
live/test status, and `fetchedAt` metadata. It also includes approved local activity
listings when available. Provider failures return explicit unavailable messages and
never fabricate flight, activity, or price data.

Starting locations use worldwide destination search or browser geolocation requested
only when the traveler clicks **Use my current location**. Reverse geocoding uses
OpenStreetMap Nominatim to label the supplied coordinates; it does not supply a
default location. Permission denial or provider failure leaves manual entry available.
Selected origin coordinates drive Amadeus nearest-airport lookup, independently
of destination coordinates. Live flight comparisons still require the existing
`AMADEUS_API_KEY` and `AMADEUS_API_SECRET`; no new location credentials are required.
Origin selections and pending lookups are cleared when the authenticated account
changes. Saved trip data remains associated with its own account.

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

Run local logic tests with `npm.cmd test`. Run persistence checks only against
an isolated test database. Seed it using the explicit demo opt-in and unique
passwords described above, then export the same values when running
`npm.cmd run test:integration`.

## Continuous integration

`.github/workflows/ci.yml` runs unit tests, TypeScript checks, and the production
build on pushes and pull requests. Its database job starts an ephemeral PostgreSQL
16 service, applies every committed Prisma migration, generates unique passwords,
seeds demo records, and runs the integration suite. It never uses the production Neon
database or production provider secrets.

The frontend repository's E2E workflow checks this repository out beside the
frontend at `../travelmate-backend-api`. If this repository is private, add a
frontend repository secret named `BACKEND_REPO_TOKEN` containing a fine-grained,
read-only token with Contents access to this repository. Public repositories use
the workflow's normal GitHub token automatically.

Production environment gates, migration order, health monitoring, smoke tests,
and non-destructive rollback steps are documented in `DEPLOYMENT.md`.

Authentication codes are stored only as HMAC-SHA-256 hashes in the `account_tokens`
table. Verification codes are bound to the user and email-verification purpose,
expire after 5 minutes, and allow at most 5 attempts per issued code. Resending
requires a 60-second cooldown and replaces the previous code. Consumption is
atomic, including overlapping requests. Password-reset codes expire
after 15 minutes and are single-use. A successful password reset increments the
user session version so previously issued session cookies stop authorizing requests.
Codes are delivered only by email and never returned to the browser, in any
environment. Missing configuration or delivery failures return an error; failed
verification deliveries invalidate the undelivered code and leave the account
unverified. Configure backend `.env` with `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`,
and `EMAIL_FROM` using a sender verified in Resend, or use the development Gmail
SMTP option below, then restart the API.
Production startup also requires a separate `ACCOUNT_TOKEN_SECRET` so
database access alone is not enough to test guessed recovery codes offline.

If registration returns 503 while `/health` returns 200, inspect the auth error
response: database health does not check email configuration. The
`configuration_required` email error means setup is needed, rather than a wrong
password or a temporary failure to retry. Configure the selected provider's
variables below. For Resend, obtain a sending API key, verify the sender domain,
and use an address on that domain for `EMAIL_FROM`; Gmail development uses an
App Password instead. Restart the backend after
editing `.env`. Set `EMAIL_SMOKE_TO` to an inbox you control and run
`npm run email:smoke` to check delivery. Never put these credentials in frontend
environment variables. Production also requires separate strong `SESSION_SECRET`
and `ACCOUNT_TOKEN_SECRET` values (at least 32 characters each).

### Development Gmail SMTP without purchasing a domain

The explicit `gmail` provider sends real messages through `smtp.gmail.com:465`
with authenticated TLS. No domain purchase or Resend key is needed. It is for
development only; production continues to require Resend and a verified domain.
Existing pending accounts can use Resend Code after changing providers; do not
delete accounts, change verification status, or re-register to switch providers.

1. Choose a personal Gmail account to send TravelMate emails. Enable
   [Google 2-Step Verification](https://myaccount.google.com/security), then create
   an [App Password](https://myaccount.google.com/apppasswords) named TravelMate
   development. Use that 16-character App Password, never the normal Google
   password. Spaces Google shows between groups may be included. If the option
   is absent, organization policies, Advanced Protection, or security-key-only
   2-Step Verification may prevent it; use an eligible personal account.
   [Google setup instructions](https://support.google.com/accounts/answer/185833).
2. Edit **backend `.env` only**, replacing placeholders locally:

   ```dotenv
   NODE_ENV=development
   EMAIL_PROVIDER=gmail
   SMTP_USER=YOUR_SENDING_ACCOUNT@gmail.com
   SMTP_PASS=YOUR_GOOGLE_APP_PASSWORD
   EMAIL_FROM="TravelMate <YOUR_SENDING_ACCOUNT@gmail.com>"
   EMAIL_SMOKE_TO=recipient@example.com
   ```

   `EMAIL_FROM` must match `SMTP_USER`. The recipient may be a different email
   address. `EMAIL_SMOKE_TO` is only for the smoke test; registration and resend
   always deliver to the pending user's stored registration email. Leave existing
   Resend settings intact if desired; they are ignored while `gmail` is selected.
   Keep credentials out of frontend variables, Git, logs, and chat. Gmail App
   Passwords are revoked when the Google account password changes.
3. Restart the backend. Run `npm.cmd run email:check`, then
   `npm.cmd run email:smoke` from the backend directory. The first command only
   validates configuration; the second sends a harmless email without a code.
   Check the recipient inbox/spam folder. SMTP acceptance does not prove inbox
   delivery. Outbound TLS connections to `smtp.gmail.com:465` must be allowed.
4. Use Resend Code for an existing pending account, wait for its real email, and
   enter the emailed code within 5 minutes. The 60-second resend cooldown,
   3-per-hour account limit, 5 verification attempts, single use, and replacement
   of older codes apply to both providers. Failed SMTP sends return an error and
   expire the undelivered code. An already verified account should sign in.

`email:check` reports missing/invalid variable names without printing values.
`smtp_authentication_failed` means check the sending account and App Password;
`smtp_connection_or_delivery_failed` means inspect connectivity or Gmail sending
limits. SMTP raw responses and credentials are never written to application logs.
The API and smoke script load backend `.env` by file location; injected process
environment variables take precedence. No provider switches automatically.

`npm run dev` generates the Prisma client before loading the API, and regenerates
it when `prisma/schema.prisma` changes. This prevents a Git pull from leaving the
ignored local client behind the current plan/itinerary schema. Generation failure
keeps the API stopped with a setup message. Source-only restarts reuse the client;
generated files do not cause restart loops. Database migrations remain explicit:
run `npm run db:setup` after pulling schema migrations. For an already running API
with a stale client, run `npm run db:generate` and restart the backend.

The dev runner watches backend `src/`, `.env`, and `prisma/schema.prisma` and
restarts the API when their contents change.
Dependency changes in `node_modules/` do not trigger restarts during sign-in.
This also works when launched by the frontend development script. Development startup
logs `email_configuration` with the provider, invalid/missing variable names,
and names of process environment variables overriding `.env`; values are never
logged. If the smoke test works but a running API still uses old settings,
restart an API started before this watcher was installed. A frontend launcher
may reuse an independently running API; its `/health` check alone does not
validate email configuration. Confirm `BACKEND_URL` points to that backend.
Remove obsolete process-level overrides from the terminal used to start the API
and restart it; `.env` intentionally does not override injected deployment values.

### Saved-trip feedback

Travelers can use **Rate this trip** on a saved trip or its itinerary workspace.
The form loads existing feedback and lets the traveler update its interactive
1–5 star rating, category, and 10–2000 character comment. The backend uses the
session's user ID and checks saved-trip ownership; client-supplied identity or
sentiment is ignored. A database unique constraint and transaction lock enforce
one entry per user/trip, including simultaneous submissions.

`GET /api/feedback/itinerary/:id` reads the traveler's own existing feedback;
`POST /api/feedback` creates or updates it. Admin-only `GET /api/feedback` provides
the paginated, filtered User Feedback table, and `GET /api/feedback/:id/itinerary`
opens the linked itinerary. Ratings do not imply sentiment analysis: entries
show **Not analyzed** until an actual analysis service is integrated. Submission
time is preserved when editing; edits also have an updated timestamp and audit.

Deploy with `npm run db:migrate` and `npm run db:generate`. The new migrations add
the per-user/trip uniqueness constraint, update timestamp, and `not_analyzed`
sentiment. Old sentiment labels inferred solely from stars are reset. The
configured development database migrations have already been applied.

### Configure Resend and run the email smoke test

1. In the [Resend Domains dashboard](https://resend.com/domains), add a domain or
   subdomain you own. Copy the exact DKIM and SPF DNS records shown by Resend to
   your DNS host and wait until sending is verified. Your personal Gmail address
   can be the recipient, but Gmail's domain cannot be your verified sender domain.
   See [Resend's domain verification instructions](https://resend.com/docs/add-a-domain).
2. In the [Resend API Keys dashboard](https://resend.com/api-keys), create a key
   with **Sending access** in the same account/team that owns the verified domain.
   If the key is restricted to a domain, select the domain used by `EMAIL_FROM`.
   Store the real key privately when it is created; it is shown only once.
   See [Resend's API key instructions](https://resend.com/docs/create-an-api-key).
3. Edit the existing **backend** `.env`; do not overwrite your database or other
   settings. If no `.env` exists, copy `.env.example` first. Set:
   - `EMAIL_PROVIDER=resend`
   - `RESEND_API_KEY` to your real Resend key.
   - `EMAIL_FROM` to a sender on the verified domain, optionally formatted as
     `TravelMate <your-sender@your-verified-domain>` with your real address.
   - `EMAIL_SMOKE_TO` to a real inbox you control. This is required only for testing.
   The template deliberately leaves the last three values empty. Editing
   `.env.example` alone does not configure the application.
4. From the backend directory, run `npm.cmd run email:check` to validate local
   configuration without sending. Then run `npm.cmd run email:smoke`, check the
   inbox/spam folder and Resend delivery status, and restart the API.

The script loads `travelmate-backend-api/.env` relative to its own location,
including when launched from another working directory. Existing process/host
environment variables take precedence over the file. If a corrected `.env` still
fails validation, correct or unset the corresponding old shell/host variable.
No values are printed. Local checks validate syntax and required settings; only
Resend can confirm key validity, permissions, and sender-domain verification.
API acceptance is distinct from inbox delivery. Credentials stay in backend
environment variables; never use `NEXT_PUBLIC_` for them or commit your `.env`.

The `resend.dev` test sender is not accepted for account email configuration:
Resend restricts it to your Resend account inbox, which can make a smoke test work
while verification fails for a different registration address. Use your own
verified sender domain. See [Resend's test-domain restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).
Sending-only API keys cannot retrieve delivery history; inspect email events in
the Resend dashboard without changing the app key's permissions. Provider-accepted
verification requests return `emailAccepted=true`; an ineligible/already verified
account returns `emailAccepted=false` and never claims that an email was sent.
Safe logs record provider status/reason and, when present, the provider receipt ID.
They omit credentials, message bodies, codes, and recipient addresses.

Safe `auth_dependency_unavailable` log events identify the auth action and failed
operation (email configuration, rate-limit database writes, account lookup, or
token operations), and share the HTTP request ID without logging account inputs,
passwords, codes, or credential values.
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

Trip completion uses the additive 20261008000000_completed_trips migration (TripStatus.completed and trips.completed_at). The owned traveler actions complete-trip and reopen-trip persist completion or undo it. Lifecycle writes acquire a row lock; repeated completion preserves its timestamp. Archiving keeps completion metadata, and restore-trip returns completed travel to Completed. Updates and version restoration require active status. Summary and detail responses expose optional completedAt.


## Missing activity photos (2026-10-11)

Existing catalog/Wikidata P18 photos and other working providers are preserved.
Missing named-activity photos now use Wikipedia and Commons public Action APIs;
no new API key is required. The fallback verifies the exact place name and
coordinates (within 1 km), or city/country evidence when coordinates are absent.
Verified article redirects and local-language links supply alternate names.
Conflicting entities/coordinates, generic destination images, flags, logos,
illustrations and incomplete attribution are rejected. Only supported licensed
raster photos with the actual creator, Commons source and license link qualify.

`POST /api/itinerary/images` retains its existing authentication/rate limit.
`lookupOnly: true` provides read-only photo metadata without signing user edits
or changing budgets. Saved-trip cards retrieve missing photos as they enter
view. Their owned `/api/platform/trips/:id/photos` endpoint persists photo fields
with a compare-and-swap check, preserving concurrent edits and updating the proof
only from server-verified data. Reopening retains the selected image and credit.
Generation resolves licensed attraction photos before returning the plan, using
catalog-linked Commons files and the existing Wikipedia/Unsplash resolver under
separate photo deadlines. Image-provider failures leave the scheduled activities
and budgets intact. Selected URLs, attribution and photo type are saved together.

Reopening uses stored photos, including historical image-field aliases, without
re-searching or checking place identity through providers. Enrichment runs only
for missing images or an observed load failure. `failedPhotos` contains activity
indices and stored URLs; replacement requires those identities still to match.
Empty responses never clear an image or activity. Successful replacements update
only the related photo fields with the existing compare-and-swap protection.
An available saved cover/day photo is labeled **Destination photo** when no
activity photo exists. Historical metadata gaps receive a saved-photo label;
new selections still require approved reusable licenses. No venue names are
invented for days that originally contain only allowances.

The backend serializes fallback requests across all Wikimedia hosts. Its bounded
per-process cache keeps successes for 24 hours, verified misses for one hour and
failures for one minute, coalescing identical in-flight lookups. HTTP 429 imposes
a shared `Retry-After` cooldown; API `maxlag`/503 failures back off without blocking
other healthy providers. The frontend also queues and caches read-only lookups.
Default request spacing is 6100 ms. Set `WIKIMEDIA_USER_AGENT` to a meaningful bot
identity with a public contact URL/email before configuring a faster permitted
pace via `WIKIMEDIA_PHOTO_INTERVAL_MS` (minimum 1100 ms). Multiple backend instances
each have their own queue/cache. See Wikimedia's [API etiquette](https://www.mediawiki.org/wiki/API:Etiquette),
[current rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits),
and [image metadata API](https://www.mediawiki.org/wiki/API:Imageinfo).

Activity lookups first check the geographically verified Wikidata entity's P18
file directly in Commons. Otherwise, the entity's available Wikipedia languages
precede missing English articles, using PageImages (`pilicense=free`,
`piprop=thumbnail|name`, `pithumbsize=960`). SVG placeholders are skipped.
ImageInfo supplies the file's actual creator, source and reusable-license evidence;
ambiguous articles, conflicting coordinates, restricted/unknown licenses, logos
and unrelated files are rejected. The existing verified Wikidata/Commons recovery
is retained. Shared entity/article/file responses are cached for one hour in
addition to the existing subject cache. A bounded Wikipedia lookup leaves time
for the existing Unsplash fallback, always labeled **Illustrative photo**; complete
failure displays a placeholder. Saved Trip covers and hotel-provider photos keep
their separate integrations. Wikipedia needs no API key. Unsplash continues to use
the existing backend-only `UNSPLASH_ACCESS_KEY`; no new key or migration is required.

### Saved-trip destination covers (2026-10-12)

Saved covers use `/api/destination-context/photo`, independently of activity-image
enrichment. Working Unsplash pools and previously selected valid covers are kept.
When no Unsplash photo matches, Wikipedia/Commons now resolve a representative
destination photograph using the verified city, region, country and coordinates.
The fallback shares the activity resolver's rate-limited queue, cache, real-creator
and license checks; activity matching remains within 1 km, while a verified city
article can use a city-cover point within 15 km. Company articles without matching
city coordinates, flags/logos/maps and photos of another city are rejected.
The existing attraction catalog remains the last exact-location provider.
Unrelated country photos no longer substitute for a missing city cover.

Cover lookups are read-only and never regenerate/update itineraries, hotels or
budgets. Successful server/browser caches keep their existing lifetimes. Server
misses now expire after one minute, including previously long-lived empty entries;
obsolete browser misses retry while valid stored selections survive the addition
of region matching. Browser timeouts allow 90 seconds for queued fallback work.

### Non-Google activity and day photos (2026-10-12)

`GOOGLE_PLACES_PHOTOS_ENABLED=false` disables all Places photo requests, even
when the server key and stored Place IDs exist. The default is disabled; enabling
requires an explicit `true`. Normal OpenStreetMap views require no photo/map
switch when no Google photos are displayed. See [Google photo configuration](docs/google-places-photos.md).

Missing day covers can reuse licensed, credited photographs already in the same
itinerary. A photograph of a different activity is explicitly labeled
**Destination photo**; it never becomes an exact attraction match. Working
photos, attribution, hotels and non-photo trip data are preserved. Days containing
only budget allowances still say **No activities scheduled** and can show a
destination photograph in both overview and day details. Saved photo-only repairs
use the existing compare-and-swap and grounding protections.

Generation allows 25 seconds for independent photo enrichment. Wikimedia gets
up to 16 seconds before Unsplash so the default 6100 ms request spacing can
complete multiple metadata requests. Existing queues, caches, miss cooldowns and
in-flight coalescing remain in use. Provider failures retain stored destination
fallbacks rather than clearing images or blocking generation.

Actual Manila/Cheonan record repairs, real generated plans, screenshots, all-day
save/reopen/refresh results and remaining source gaps are recorded in
[the verification report](../audit/2026-10-12/non-google-activity-photos/README.md).

## Planning and visited-place improvements (2026-10-08)

- Paid subscriptions are excluded at the user's request. No paid plans, checkout, billing status, or entitlements are implemented.
- Cloudinary is not configured: no SDK, integration, cloud name, or credentials were found in the code or environment. Licensed Commons and local images use Next's responsive optimizer at quality 75, AVIF/WebP negotiation, four-hour minimum server cache, native lazy loading, eager modal heroes, stable placeholders and retry fallbacks. Real-provider hotel photos continue to display directly under provider terms; URL metadata and attribution are preserved without downloading/storing hotel images.
- An optional starting city is in the planner and is sent to the grounded AI request even without a flight selection. The same origin remains available in flight comparison. It gives departure context; intercity arrival times and routes are not claimed as verified.
- Travel pace caps catalog stops at 2 (relaxed), 3 (balanced), or 4 (active) per day. Relaxed schedules add a 30-minute transfer buffer. The existing city/country grounding, duplicate-place, opening-reference, date and party checks remain in place.
- Daily cards and details show activity order, proposed local time, duration, location, photo/fallback, source-aware cost, map and explicit visit controls. Timing-only edits retain verified place/photo data. Custom identity changes remove verification. Reordering reschedules timed stops; legacy visits get an explicit 30-minute estimate requiring review. Browser and server enforce same-day duration and transfer/overlap checks. Buffers based on straight-line walking are estimates, not live routes. Flexible entries and daily allowances have no fixed time slot.
- Save retries use a canonical content hash by default, or a payload-bound saveKey. The database unique key is per user; concurrent retries return one saved trip and create one version. Use Duplicate for an intentional identical copy. Existing historical trips remain untouched.
- Visited places are stored separately from saved/completed plans. Recording a visit requires an explicit past/current date. Unique user/place/date keys prevent duplicates and retain return visits on different dates. Known Wikidata identities and coordinates are derived only from server-signed saved itineraries. Manual records are labeled as entered by the user. History supports search, pagination, removal and reopening an associated trip; deleting a trip retains its visits with the association cleared.
- Visit opens Google Maps directly using verified coordinates or place plus destination. It never records a visit. Mark as visited is a separate confirmation. Save itinerary changes before recording a place from that plan; stale activity identity is rejected.
- Traveler navigation now includes Visited places, Preferences and Feedback, preserving Home, Planner, Saved trips, Notifications, Budget review, Travel options and Account. The remaining itinerary hotel booking button is removed; map access remains. Backend booking actions remain disabled.

Optional Cloudinary integration would need a cloud name and an approved delivery/upload strategy for licensed assets. Authenticated uploads require an API key and API secret held only on the server. Do not proxy or upload provider hotel media without permission. See [Cloudinary image transformations](https://cloudinary.com/documentation/image_transformations) and [Google Maps URL parameters](https://developers.google.com/maps/documentation/urls/get-started).

Database migration: 20261008120000_visited_places_save_keys (additive; applied to the configured database). Routes: GET /api/platform/visited-places?q=&cursor= and authenticated platform actions record-visit / remove-visit. Record from a saved trip with tripId, dayIndex, activityIndex, activityTitle, optional placeId; or manually with name and destination. Both require visitDate and optional IANA timeZone. Only the current traveler can read/remove records. API contracts are regenerated from OpenAPI.

## Worldwide destination catalogue

Interactive `/api/locations?q=&offset=` searches the imported GeoNames catalogue, including aliases and all available administrative and populated-place records, rather than the legacy capped city index. `/api/locations/areas` browses direct children and searches all available descendants using source administrative codes. Responses expose `total`, `nextOffset`, source identity, coordinates, hierarchy, and a coverage notice. PSGC remains authoritative for the imported Philippine regions, provinces, cities and municipalities. GeoNames supplies available lower Philippine divisions; it is not a complete official barangay dataset. A separate, explicit `/api/locations/resolve?secondary=true&q=` lookup verifies OpenStreetMap results, using stable element IDs. Public Nominatim is never used for autocomplete or systematic enumeration.

Provision the catalogue on every backend host. It is approximately 1 GB and intentionally ignored by Git. Use Node >=22.13 (verified on Node 26.7), retain the full official `https://download.geonames.org/export/dump/allCountries.zip` in `.cache/destination-source/`, then run `npm run locations:build`. The builder downloads country metadata and the separate ADM5 codes from GeoNames, imports without population cutoffs or per-country record limits, and writes `.cache/global-locations/catalogue.sqlite` plus `coverage.json`. Allow at least 2 GB free during rebuilding; stop the backend before replacing an open catalogue on Windows. `GLOBAL_LOCATION_CATALOGUE_PATH` can point to a provisioned read-only file outside this default cache. Restart after provisioning/replacement. Runtime requests do not download the archive. If the catalogue is unavailable, the API clearly labels its limited legacy/Open-Meteo fallback as partial coverage.

Refresh from GeoNames when appropriate and check `coverage.json` for source dates, each country's counts and supplied feature levels. `npm run locations:verify` records public-source searches, parent membership, production generation/accommodation identity validation and JSON/map reopening in `../audit/2026-10-14/worldwide-locations/`. It does not create shared database trips or obtain real hotel quotes. Country and local administrative coverage, intermediate parent codes, populated-place classifications and points vary in quality. Missing types stay unconfirmed; no worldwide completeness guarantee is made. Source data uses GeoNames CC BY 4.0; secondary results retain their OpenStreetMap source URL. Legacy photo resolution and natural-destination examples retain their existing limited index.

## Balanced generation default

`POST /api/itinerary` uses Balanced style and pacing for every new or regenerated
plan. `travelStyle` and `pace` are optional legacy request fields and do not change
that default. Saved itinerary schemas continue to accept historical values; opening
an older plan preserves its activities, costs, photos and metadata. Regenerating it
produces a new Balanced plan. Generation request identity includes the current
policy version so an older style-specific cached response cannot be replayed as
new Balanced output.

Interests, preferred activities, stay preference, transportation, dates, travelers,
explicit hotel selection and entered expense estimates remain active. Stay choices
are suggestions only. The budget is a spending ceiling; provider references and
user-entered estimates retain their amounts, while absent prices stay unavailable
and are excluded from the known subtotal. Source-backed visits, transport buffers,
meal breaks and rest time use the existing shared scheduler. No data migration or
rewrite of existing saved itineraries is required.
