# Smart itinerary management

Open a saved trip's **View map / Navigate** action. The existing day controls select the day; **Manage your day** acts on the selected timeline item/pin. The saved-trip editor also offers **Manage activities / Replan My Day** for its selected day (disabled while unsaved edits exist).

## Confirmed manual changes

Complete, skip, undo completion/restore to planned, edit and reschedule each visit. All writes require explicit confirmation, the authenticated traveler owner, an active trip, the current trip revision and a valid saved activity ID. Archived/completed trips are readable; reopen before changing them. Completed details are protected until the user explicitly undoes completion. Changing a venue clears its old location/photo evidence and uses the existing exact-place chooser; no coordinates are invented. Daily allowances remain budget entries editable in the existing editor, rather than map stops.

## Replan My Day

Supply an explicit remaining window in **destination local time**. Preview calls the configured existing Gemini/OpenAI adapter; it never writes a trip or version. Only supplied remaining IDs and proposed start minutes can come from AI. Completed and skipped records, saved visit durations, costs, place evidence and budget entries are retained. Unscheduled visits stay recorded as Flexible. Unknown visit durations must be entered by the user first.

The server validates identity, duplicate locations, chronology, completed time slots, available window and supplied opening windows. Routing reuses OSRM with the selected walking/cycling/driving mode and returned leg durations; missing routing uses the existing conservative walking straight-line/general transfer buffer, clearly described as an estimate. No live starting position, traffic, venue availability or prices are inferred. Available catalog hours are references, not live opening confirmations. The preview lists limitations before acceptance.

Accept sends the signed 15-minute owner/trip/revision-bound preview plus explicit confirmation. A row lock and revision check reject concurrent edits and stale previews. Cancel (including aborting a pending preview) makes no itinerary writes. Provider failures leave manual controls usable.

## Persistence and compatibility

No migration or dependency is needed. Existing Trip.itinerary JSON gains optional activity id, status, statusChangedAt and managementHistory. Legacy IDs are derived read-only from the trip/day/original item until a confirmed write persists them; subsequent edits and cross-day moves keep those IDs. Old trips default to Planned. Existing saved/manual_edit version kinds preserve original snapshots and every confirmed update. Existing version restore remains an explicit whole-version restore. Status/history fields submitted through the old manual editor are ignored in favor of server-owned metadata, and completed/skipped records cannot be silently removed.

Confirmed changes invalidate only this trip's map client caches, stop any live tracking, refresh the existing map and card information, and retain activity selection by ID even after moving days. Skipped visits stay visible but are excluded from day routing/replanning. Opening navigation never completes an activity.

## Endpoints

All use the existing cookie/session middleware and traveler account rules. The OpenAPI document describes request/response contracts.

- GET /api/platform/trips/:id/activities — owned managed itinerary, revision, canManage; no write.
- PATCH /api/platform/trips/:id/activities/:activityId — revision, confirm:true, action and optional changes.
- POST /api/platform/trips/:id/replan — revision, dayIndex, fromTime, toTime, mode; returns preview/token/warnings.
- POST /api/platform/trips/:id/replan/accept — revision, token, confirm:true; confirmed transaction and version.

Existing server keys and AI_PROVIDER/GEMINI_MODEL/OPENAI_MODEL settings are reused. Missing keys/provider outages return an honest unavailable state; mock fallback is never used for replanning. No keys reach the browser. Preview rate: 3 per owner per 5 minutes. Other management requests: 60 per owner per minute. Identical previews share a 30-second provider cache; route requests reuse the existing 5-minute provider cache and public routing limiter.

## Validation commands

- Backend: npm test; npm run build.
- Frontend: npm test; npm run lint; npm run contracts:check; production build; Playwright smart-itinerary-management plus saved-trip navigation/edit/delete/photo/GPS regressions.
- Real PostgreSQL integration is deliberately opt-in: set TRAVELMATE_ISOLATED_TEST_DATABASE to a **migrated isolated PostgreSQL database**, then run node --test --experimental-strip-types tests/integration/smart-itinerary-persistence.test.ts from the backend. This test creates and cleans up its own test user/trip, exercises real confirmed transactions and version history, reconnects before checking persistence, and checks ownership/stale acceptance. It skips when the separate URL is absent and never implicitly uses the ordinary application database.

Official integration references: [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output), [OSRM route API](https://project-osrm.org/docs/v5.24.0/api/). Existing provider adapters are retained.
