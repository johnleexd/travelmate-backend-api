# Accommodation provider integration

TravelMate keeps its existing green/yellow accommodation browser. This implementation adds a real Expedia Rapid API adapter, exact room occupancy, provider-ID photo galleries, encrypted quote selection, and price revalidation. **No Rapid or Amadeus credentials are configured in the inspected local environment. Live English property content, provider photos, room availability, and prices have not been verified against a real account. Automated tests use controlled API fixtures, not hotel inventory.**

## Existing sources and their limits

- OpenStreetMap / Overpass provides mapped property references, not room inventory or confirmed prices. Official English tags win; native-script names can use the optional romanization service. Direct property-linked Commons files retain license credits. Cross-provider Wikidata imagery is accepted only when English name/alias, address and coordinates agree; uncertain records remain placeholders.
- Existing TravelMate owner listings retain their supplied rate; this is not a date-specific room quote.
- Existing Amadeus hotel offers remain an adult-only fallback for uniform room occupancies. English content is requested, and the exact offer is rechecked before selection and generation. That adapter has no verified property-photo feed; tax/fee inclusion is explicitly unknown. It is skipped for child ages or unequal adults per room.
- Rapid is the complete optional source. Catalog, images, room offers and price checks share the same Rapid property ID. Rapid photos are never attached to map listings by approximate hotel-name matching.

## Backend configuration

Add the following to the backend deployment environment (examples are in `.env.example`). Never put these values in frontend or `NEXT_PUBLIC_` variables.

| Variable | Configuration |
| --- | --- |
| SESSION_SECRET | At least 32 random characters; encrypts and authenticates user-bound quote tickets. |
| RAPID_API_KEY / RAPID_API_SECRET | Credentials from an approved Expedia Rapid partnership with lodging API access. |
| RAPID_ENV | `test` initially; `production` only with approved production credentials and launch clearance. |
| RAPID_POINT_OF_SALE_COUNTRY | Actual selling market, e.g. `PH`; independent of destination country. |
| RAPID_CONTENT_RIGHTS_CONFIRMED | `false` until your agreement permits hotel-content/photo display in this trip-planning product. |
| RAPID_PHOTO_ATTRIBUTION_TEXT | Exact required provider/photographer credit from your agreement. No credit or permission flag means placeholders. |
| RAPID_PHOTO_TERMS_URL | HTTPS provider license/terms link, if required by your agreement. |
| HOTEL_ROMANIZATION_PROJECT | Optional billed Google Cloud project for native-script fallback. |
| HOTEL_ROMANIZATION_LOCATION | `global` by default; use a location supported by the Romanize API. |

Rapid uses [signature authentication](https://developers.expediagroup.com/rapid/lodging/reference/signature-authentication). Test requests go to `https://test.ean.com`; production requests go to `https://api.ean.com`. The account needs Geography, Property Content, Shopping and Price Check access. Acquire access through [Expedia Rapid partnership](https://partner.expediagroup.com/en-us/join-us/rapid-api) and complete the [lodging launch requirements](https://developers.expediagroup.com/rapid/setup/launch-requirements/lodging-launch-reqs). Commercial terms, commissions, minimums or API charges depend on the agreement; this project does not assume a free tier or a published fixed price. Obtain the actual terms and costs from Expedia before enabling production.

For transliteration, enable Cloud Translation Advanced and billing, grant the backend identity permission to romanize text and charge the project, and configure Application Default Credentials (workload identity is preferred). A local authorized service account file can be referenced through `GOOGLE_APPLICATION_CREDENTIALS` outside the repository. No key is sent to the browser. This calls [romanizeText](https://docs.cloud.google.com/translate/docs/advanced/romanize-text), which is a preview feature with [limited supported languages](https://docs.cloud.google.com/translate/docs/languages). Usage is billed under [Google Cloud Translation pricing](https://cloud.google.com/products/translate/pricing). Successful output is labeled **Transliterated name**, not presented as an official English brand name. Unsupported or failed romanization leaves an honest English-name-unavailable label and the original name in the details; addresses without Latin provider content remain unavailable in English.

## Provider requests and room prices

1. Geography finds city regions near the selected coordinates and reads their property IDs. This browser samples up to 40 IDs and filters content to valid coordinates, the destination country, and a 30 km radius; it does not claim exhaustive regional inventory.
2. Property Content is requested with `language=en-US`. Property IDs must match exactly. Category and amenities are shown only from readable supplied content. The displayed star rating is a provider hotel classification, not an invented traveler-review score.
3. Shopping sends actual check-in/check-out dates, original budget currency, point-of-sale market, and repeated per-room occupancies. A room with two adults and ages 5 and 9 is sent as `occupancy=2-5,9`. Up to eight rooms and twenty travelers are supported. Missing child ages are never guessed.
4. Each offer sums the provider's **full-stay property-inclusive billable total once per actual room**, with currency precision respected. A nightly amount is clearly an average for the group, not a guaranteed fixed nightly price. Supplied nightly/stay components appear in the breakdown. Mandatory property fees returned by the provider are labeled payable at the property and included in the property-inclusive total; they are not charged twice.
5. The original quoted currency is retained. A different requested-currency equivalent is approximate. To avoid silently converting a confirmed budget cost, selection requires the trip budget to use the billable quote currency; the traveler is prompted to change it if needed.
6. Sold-out inventory, missing prices and provider failures have separate states. Rates without a price-check link or full occupancy totals are not selectable confirmed offers.
7. Clicking Select accommodation calls `POST /api/accommodations/revalidate`. It uses the exact property's room/rate link. Changed prices or unavailable rooms require a fresh search and traveler review; they are not automatically accepted.
8. Itinerary generation repeats the price check and verifies the quote's traveler, destination, dates, room count, guests and currency. Search and revalidation time are shown. Quotes expire after ten minutes. Prices can still change until booking.

See [Content API](https://developers.expediagroup.com/rapid/lodging/content/about-content-api), [Geography API](https://developers.expediagroup.com/rapid/lodging/geography/about-geography-api), [Shopping API](https://developers.expediagroup.com/rapid/lodging/shopping/about-shopping-api), and [unavailable reason codes](https://developers.expediagroup.com/rapid/lodging/shopping/unavailable-reason-codes). This integration does **not** book a room, collect payment, or guarantee availability after price checking.

## Photos, storage and caching

Images come only from the exact Rapid content record, on the permitted provider CDN hosts (`images.trvl-media.com` and `a.travel-assets.com`). The main image, thumbnails, loading state, failed-image placeholder, and provider credit are built into the existing modal. No Traveloka assets, random destination images, AI hotel photos or screenshot assets are used.

Rapid content/quotes and price checks use no-store requests. Provider photo URLs are displayed directly, without an image proxy, server image cache or downloaded image files. The frontend CSP allows only the selected provider image hosts. Saved trip data retains the provider image reference/path, not image bytes, public photo URLs, provider booking links, or the encrypted selection token. Configure credits and permission according to your account agreement; account-specific attribution and retention rules still need verification before live launch.

## Trip persistence and database setup

The selected property ID, room ID, offer ID, check-in/check-out, per-room adults and child ages, original currency, quoted total, nightly average, taxes/fees flag, property charges, price breakdown, photo references, checked time and revalidated time are saved as `itinerary.accommodation.providerQuote`. The full group quote total is used once in the existing budget. Quote metadata must agree with the saved property, offer, dates, traveler count, currency and cost. Existing trip/version JSON storage retains this data, so **no database migration is required for this upgrade**. Older trips without providerQuote still load through the existing history.

## Verification and live acceptance

Automated coverage includes English localization and tagged transliteration; exact-ID joins and uncertain-photo rejection; child ages and multi-room shopping; original versus approximate currencies; quoted totals rather than starting-rate arithmetic; sold-out/missing/error states; authenticated selection; changed dates/occupancy; changed-price rejection; quote expiry/tampering/ownership; trip/version transaction persistence and budget precision; browser gallery/broken image behavior; date changes clearing selection; mobile overflow; generation and saving the correct offer. Provider and database access are mocked in these tests.

Before declaring this live:
- Configure approved test credentials and confirm English content, identity and photos for known real properties.
- Compare a returned quote with Rapid's response for actual dates, adults, children/ages and rooms, including payable-at-property charges.
- Exercise changed-date, sold-out and changed-price responses and production-domain access after approval.
- With an accessible PostgreSQL database, generate/save/reopen a trip and verify both trip and version JSON. Real PostgreSQL persistence could not be tested from this restricted environment.


## Current LiteAPI integration

The locally configured LiteAPI sandbox provider now takes precedence. See [LiteAPI recommendation integration](liteapi-recommendations.md) for the current implementation and successful sandbox checks. The earlier Rapid/Amadeus configuration findings above describe those adapters only.
