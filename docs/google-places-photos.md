# Google Places activity photo fallback

Google photo requests are disabled by default. Set
`GOOGLE_PLACES_PHOTOS_ENABLED=false` to retain the key while making no Google
photo/search/details requests. Wikipedia/Wikimedia, Unsplash and stored photos
continue normally, as does the existing OpenStreetMap layout. Re-enabling requires
an explicit `GOOGLE_PLACES_PHOTOS_ENABLED=true` as well as the server-side key.

The existing integration uses Wikidata/Wikimedia and Unsplash; Google OAuth keys
are unrelated. `GOOGLE_PLACES_API_KEY` is read only by the backend, including the
development `.env` loader. Injected environment variables take precedence. Do not
put the key in the frontend, request URLs, logs, or committed files.

In Google Cloud, enable **Places API (New)** (`places.googleapis.com`) in the key's
project, attach an active billing account, allow that API in the key's API
restrictions, and allow the server's outbound IP in application restrictions.
Browser referrer restrictions do not authorize these server requests. Restart the
backend after changing its environment. API quotas and billing budgets should be
configured for the expected traffic.

Run `node --experimental-strip-types scripts/check-google-place-photos.ts` from
the backend directory. It makes live Text Search and Place Photos requests and
checks the image bytes in memory. Output contains operational status and a Place
ID only. A successful test proves access from that server at that time; it cannot
inspect Cloud Console restrictions or remaining billing credits. If Google
returns a specific error reason, the resolver records the redacted reason and
message. A generic 403 cannot establish which Console setting is responsible.

Only missing or observed-failing non-hotel activity photos are eligible. Text
Search requests each attraction's name, city and country separately, with a
coordinate bias where available. Acceptance requires exact normalized name,
city/country address components and coordinates within 1 km when provided. More
than one matching result, incomplete pagination, conflicting locations and
photos lacking source links are rejected. Conservative matching can leave
translated/alias names unmatched. No Google Images scraping is used.

The matched `googlePlaceId` is stored on the activity in the existing itinerary
JSON. Google coordinates, addresses and names never replace existing place/map
data. Photo names remain local to one request. Each reopened/refreshed view uses
a new Details response; a rejected expired photo name is refreshed once. Photo
URLs, credits and files are never saved in trips, versions, browser storage,
backend caches, or the Next image optimizer. Display responses use `no-store`.
The browser holds URLs and credits only in the active view. Concurrent requests
share in-flight work; rerenders do not issue another request. Configuration
errors and rate limits have cooldowns. Google image load failures go directly to
the existing fallback once, without a Google retry loop.

Photos are requested at up to 960×720 px and browser images load lazily. The
Google Maps credit, all supplied author names/profile links/avatars and the
individual photo's `googleMapsUri` are attached to the photo. Google photos are
used only in the itinerary's non-map photo views. When Google photos are present,
the planner switches between activity photos and the existing trip map; they are
never rendered together. Opening other map views suppresses Google photo content.
OpenStreetMap/Leaflet map dialogs retain independently sourced place coordinates and contain no Google
photo/result content. Do not add these photos, Google place results or derived
coordinates to non-Google map markers, popups, route views or exports.

Existing working activity photos and all hotel photos retain their current
behavior. Google outages/no suitable photo use the existing Wikipedia/Unsplash
pipeline or destination image, with its source/illustrative label. Generation
preserves supplied photos and loads missing Google photos on demand after display.
Saving/reopening does not regenerate or change activities, budgets or schedules.
Owned completed and archived trips can also retain photo metadata/Place IDs;
their lifecycle status and activity data remain unchanged.

Public `/terms` and `/privacy` pages link Google's terms/privacy. Production
owners should review these statements and applicable EEA terms for their actual
billing region. Official documentation:

- https://developers.google.com/maps/documentation/places/web-service/place-photos
- https://developers.google.com/maps/documentation/places/web-service/policies
- https://cloud.google.com/maps-platform/terms/maps-service-terms
- https://developers.google.com/maps/billing-and-pricing/pricing

At the published first paid volume tier, Text Search Pro costs $32 per 1,000,
Details Pro $17 per 1,000, and Place Details Photos $7 per 1,000 requests, after
their respective free monthly caps (5,000, 5,000, and 1,000). Search fields used
for identity validation trigger Pro pricing. A first successful match normally
uses one search plus one photo request; a saved ID uses one Details plus one
photo request on reopen/refresh. Refresh/reopen can therefore incur new usage.
Actual invoices depend on region, plan, free usage, volume and Google's current
pricing; the app does not claim to know the account's remaining credits.
