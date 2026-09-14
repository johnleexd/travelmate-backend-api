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

Copy `.env.example` to `.env` and add the Neon pooled `DATABASE_URL`, then run:

```powershell
npm.cmd install
npm.cmd run db:setup
npm.cmd run dev
```

The server listens on port 5000 by default and exposes:

- `GET /health`
- `GET|POST /api/auth`
- `GET|PATCH /api/profile`
- `GET|POST /api/platform`
- `POST /api/itinerary`
- `GET /api/weather`
- `GET /api/locations`
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

Live Amadeus selections carry a server-generated HMAC token. The itinerary API
rejects browser-modified offer identities or prices. Without Amadeus credentials,
the endpoint returns an explicit `configured: false` response rather than invented
availability. PayMongo is not integrated; payment states are a labeled simulation.

The unified travel-options endpoint normalizes Amadeus Flight Offers Search and
Tours and Activities results into stable comparison fields with provider, currency,
live/test status, and `fetchedAt` metadata. It also includes approved local activity
listings when available. Provider failures return explicit unavailable messages and
never fabricate flight, activity, or price data.

Weather uses OpenWeatherMap when configured and keyless Open-Meteo otherwise. It
returns `forecastAvailable: false` when the requested dates fall outside the live
forecast window. If both providers fail, it returns an explicit `unavailable` state
with no fabricated current conditions or forecast. Crowd values are low-confidence,
deterministic calendar-based estimates, not live foot-traffic or venue-capacity data.

Run local logic tests with `npm.cmd test`. After seeding the demo records, run
the Neon-backed persistence checks with `npm.cmd run test:integration`.
