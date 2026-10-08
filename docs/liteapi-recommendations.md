# LiteAPI / Nuitée Connect accommodation recommendations

Implemented and checked against the current official documentation on 2026-10-08. TravelMate preserves the accommodation card modal, green/yellow styles, destination selection, manual/later choices, and Generate → Save → Reopen workflow.

## Local configuration

The existing backend key and `LITEAPI_ENV=sandbox` are used. The API key stays in the backend `.env`, sent only in the provider's `X-API-Key` header. Do not put it in a frontend environment variable, URL, log, or committed file.

A separate strong `ACCOMMODATION_QUOTE_SECRET` was generated in the ignored local backend `.env` so encrypted selection tokens work without changing login sessions. On another deployment, provide a persistent random secret of at least 32 characters, or an already configured strong `SESSION_SECRET`. Rotating the quote secret expires outstanding selections; it does not affect saved trips.

Restart the backend after changing environment values (the local development watcher handles this automatically). No database migration or new dependency is required: the existing itinerary JSON and version history store the selected hotel metadata and quote.

## Provider environment

[Authentication](https://docs.liteapi.travel/reference/authentication) uses the same base URL, `https://api.liteapi.travel/v3.0`, for both keys. Sandbox keys have the documented `sand_` prefix. `LITEAPI_ENV` is an application guard, not a provider request parameter or alternate hostname.

This adapter deliberately supports sandbox only. A production environment setting or production credential is rejected, and rates are accepted only when the response explicitly reports `sandbox: true`. No production activation, payment method, wallet, reservation, booking, or prebook operation was added or performed.

## Requests and identity

Only four provider paths are allowlisted:

- `GET /data/hotels`: the selected coordinates, 10,000-meter radius, 12 properties, `language=en`.
- `GET /data/hotel`: exact property ID, `language=en`, photo gallery and facilities.
- `GET /data/currencies`: verify the requested currency is supported.
- `POST /hotels/rates`: exact hotel IDs, check-in/out, one occupancy per room, actual adult counts and child ages, guest nationality, original currency, room mapping, and an opaque search session ID.

Guests enter their actual nationality in Rooms and guests; it is never inferred from the destination. Until supplied, property content can be browsed but rates remain unavailable. Country/region/island searches still require selecting a city or town.

The adapter filters geographically incorrect records and joins content/photos/rates only by LiteAPI's property ID. Foreign IDs are discarded; no fuzzy cross-provider matching occurs. English content is requested; an unavailable English name remains the official supplied name with an English-name-unavailable label. No hotel brand translation is invented. Without a reliable property category, the card uses the neutral English type “Accommodation”.

The sampled search is not an exhaustive inventory list. Rooms absent from a search mean unavailable for the query, not proven sold out. “Sold out” appears only for an explicit provider status.

## Prices, fees, refresh, and saving

The displayed test total is the API's `offerRetailRate`, checked against the sum of complete room `retailRate.total` values. The average per group night is the quoted total divided by the actual stay nights, rounded to the original currency precision. It is not a starting room rate multiplied into a fabricated total.

Tax/fee inclusion follows the response's `taxesAndFees[].included`. Missing disclosure remains unknown. Separately payable fees are displayed as additional to the provider total; disclosed fees in the same currency are included once in the itinerary's budget total. Selection is rejected if a disclosed additional fee cannot be budgeted accurately in that currency. No currency conversion is fabricated.

A signed, encrypted, user-bound ticket expires after 10 minutes. Selection and itinerary generation re-run the read-only rates search for the same hotel, dates, occupancies, nationality, and search session. Room/board/occupancy/refundability identity is compared; changed prices or fees require refreshing and reviewing. This is a rate refresh, never a prebook or availability guarantee.

The existing trip JSON retains the unique hotel ID, offer reference, mapped room reference, dates, occupancy, nationality, photo references, original quote total/currency, average nightly cost, fee disclosure, checked time, sandbox status, and budget cost. Tokens and API keys are not saved with the trip. Old saved trips and other providers remain compatible.

Destination/date/guest/room/currency/nationality changes invalidate the previous selection. Frontend aborts and request identities prevent stale searches or selection checks from overwriting the new query.

The browser and saved itinerary display:
“Selecting this hotel adds it to your itinerary. It does not reserve a room.”

## Photos and permitted use

Photos are taken only from the exact hotel content record. Approved direct image hosts are `static.cupid.travel` and `liteapi-travel-static-data.s3.amazonaws.com`. Main images, a small keyboard-accessible gallery, loading states, broken-image placeholders, and a Nuitée Connect credit/terms link are supported. No Traveloka or destination stock image is used as a property photo.

Provider images are displayed directly with no server image proxy, optimized image copies, downloaded image files, or property catalogue cache. Only currency reference codes are cached in memory. Photo paths/references and the selected stay snapshot are retained as itinerary data, not a reusable hotel database. Existing OpenStreetMap and other providers are kept separate and are not mapped to LiteAPI records.

Review [Nuitée Connect's terms](https://www.liteapi.travel/terms/) and account-specific content notices before production. Retain proprietary notices, obtain permission for this recommendation-only use and selected-trip retention, and verify whether your account requires additional photo attribution. General terms do not authorize unrestricted redistribution, third-party data mapping, bulk harvesting, or a separate hotel database.

## Testing

Real read-only sandbox searches succeeded:

- Yokohama: 12 nearby English properties, 10 usable test quotes; the exact APA Hotel & Resort Yokohama Bay Tower photo returned HTTP 200 with image/jpeg, and its test rate refreshed successfully.
- Singapore: 12 nearby properties, 11 usable test quotes; the exact Marina Bay Sands photo returned HTTP 200 with image/jpeg, and its test rate refreshed successfully.
- Changed Yokohama dates: quotes carried the requested new check-in/out dates.

See `../../audit/2026-10-08/liteapi-sandbox-results.json` for sanitized IDs, dates, photo-host/status checks and test results. These are sandbox observations, not verified production rates or inventory.

Automated coverage includes exact ID/photo joins, English requests, unequal room occupancy and children, missing totals/fees/photos, invalid credentials, 429s, timeouts, changed dates and quotes, environment mismatch, user-bound tokens, authenticated search/selection/generation, deterministic lodging budgets, saved-trip validation, desktop/mobile browsing, broken photos, and stale destination responses. Browser/API tests use controlled fixtures for generation and saving; they are separate from real provider sandbox verification.

## Before permitted production use

Production remains disabled. Request written confirmation from Nuitée Connect for recommendation-only access, the expected look-to-book ratio (this app intentionally creates no bookings), photo/content use, and selected-trip snapshot retention. Obtain production credentials only through an authorized account process; production access must not be inferred from sandbox success.

Public-production pricing must respect the provider's [rate response and suggested-selling-price rules](https://docs.liteapi.travel/docs/hotel-rates-api-json-data-structure), supported occupancy/currency policies and original supplier fee disclosures. The current adapter's sandbox retail totals are test prices; enabling production requires implementing and verifying the permitted public pricing model and lifting the explicit guard in a reviewed change.

[Published API pricing](https://docs.liteapi.travel/reference/api-pricing-usage-costs) describes core hotel content/other non-priced calls as no additional cost subject to reasonable look-to-book and fair use; recommendation-only traffic may require a separate agreement or pricing. Some premium endpoints are billed, but this integration does not use places, price-index, or AI search endpoints. Confirm your account's actual costs and limits with Nuitée rather than assuming free unrestricted production search. The [sandbox rate limit](https://docs.liteapi.travel/reference/rate-limiting) is 5 requests/second; requests are spaced below that ceiling within each backend process. Multiple backend instances need a shared account-level limiter before scaling.

Official references: [hotel listings](https://docs.liteapi.travel/reference/get_data-hotels), [details/photos](https://docs.liteapi.travel/reference/get_data-hotel), [rates](https://docs.liteapi.travel/reference/post_hotels-rates), [room occupancy](https://docs.liteapi.travel/docs/rate-request-parameters-guide), [currencies](https://docs.liteapi.travel/reference/get_data-currencies).
