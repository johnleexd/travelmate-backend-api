# Administrative destinations

Philippine province browsing uses the bundled Philippine Statistics Authority
PSGC catalogue in `data/philippines-administrative.json`. It includes all 18
regions, 82 provinces, 149 cities and 1,493 municipalities, collected from the
complete official public tables on 2026-10-14. The public tables retain a
2025-07-31 header. Their current names and totals were checked against the PSA
2026 quarterly releases through 2026-09-30; provenance keeps both dates rather
than calling the tables a downloaded Q3 workbook.

Sources:
- https://psa.gov.ph/classification/psgc/provinces
- https://psa.gov.ph/classification/psgc/cities
- https://psa.gov.ph/classification/psgc/municipalities
- https://psa.gov.ph/classification/psgc/regions
- https://psa.gov.ph/classification/psgc/citimuni/0702200000

The workbook download returned 403 during collection. The complete public tables
were available instead. PSGC's authenticated API was not used. `data/philippines-
psgc-source.json` and `data/philippines-psgc-regions.json` preserve the source
records, including current ten-digit codes and old correspondence codes. Names
are not an identity: renames keep their PSGC code, and earlier names remain
aliases. Never truncate this source by population or top-result count.

## Membership and identity

Province children use the current PSGC province assignment, not the region name,
a city radius, an island polygon or hotel inventory. Cebu province has 44
municipalities and six component cities. Cebu City, Mandaue and Lapu-Lapu have
separate PSGC assignments and remain directly searchable as independent cities;
their geographic province is retained separately. Bantayan belongs to Cebu
province even though it is not on the main Cebu island. Barangays are not included
in the city/municipality list; a GeoNames ADM4 result in the Philippines is
labeled Barangay. Unconfirmed provider settlement types retain a general label.

The provider ID and administrative code are the exact ten-digit PSGC string.
Numeric UI IDs are `1_000_000_000_000 + Number(PSGC code)`, an exact safe-integer
namespace separate from GeoNames and OSM IDs. Generation and hotel searches
validate that identity against the selected country, province and geocoded point.
The grounding destination JSON retains the identity and coordinate provenance
through saving and reopening. Older trips with no identity keep their existing
stored destination point; no identifier is invented for them.

## Coordinates

Coordinates come from the existing full GeoNames source archive (2026-10-05),
not from PSGC or AI. The extraction retains all 65,299 Philippine administrative
and populated-place records rather than the travel index's top 200 cities.
Municipalities and cities crosswalk by the old PSGC correspondence code in
GeoNames ADM3. Manila's older representation uses its exact correspondence code
at ADM2; a populated point also needs an exact official-name/alias match.
Province/region geocodes require a unique administrative-name match.

There are 1,727 pre-geocoded catalogue entries. Fifteen entries lack a unique
stored match, including nine cities/municipalities. They remain listed with an
explicit coordinate-verification message. Selection performs a deduplicated
explicit geocoding request and rejects wrong country, administrative type,
province/region or ambiguous identities. A point is never guessed. The existing
public Nominatim queue is shared, respects spacing and 429 cooldowns, and is never
used for autocomplete. Geocoding points are approximate locality centers, not
hotel entrances or legal province boundaries.

Regenerate the committed catalogue after updating the complete official tables:

```sh
node scripts/extract-ph-geocodes.mjs
node scripts/build-ph-administrative-catalogue.mjs
node scripts/sync-administrative-location-contracts.mjs
```

Run `npm run contracts:sync` in the frontend afterward. The builder checks the
current expected counts; review those assertions and the release-check date when
PSA publishes an administrative change. This snapshot does not update itself.

## Search and incomplete global coverage

Official province searches filter the full dataset before returning pages of
20, with total and next offset. Aliases and country/province qualifiers remain
searchable. Hotel results do not filter or invalidate a destination.

Worldwide primary interactive search uses the imported full GeoNames catalogue,
with exact country codes and recorded administrative parents. Search checks the
full source before pagination; it is not limited to a loaded dropdown or a short
major-city list. Available local aliases are indexed. The snapshot requires
maintenance and is not a claim of complete worldwide geography. Generic types
remain explicit when the source lacks country-specific terminology.

Exact canonical country names, ISO alpha-2/alpha-3 codes, native names and unique
source aliases browse that verified country's contents. Canonical ISO identities
take precedence over ambiguous alternate names. `/api/locations` accepts a
validated `countryCode` filter and returns the verified `countryScope`; a newly
recognized exact country query changes it. Scoped searches allow empty text for
browsing and use pages of 20. Without a scope, ordinary worldwide name search
remains available. Philippine browsing retains the official PSGC path; typed
search also includes available lower-level GeoNames records.

The shared frontend selector displays the active country filter, cancels obsolete
requests on editing/clearing/closing, and preserves the scope after closing country
browsing. Final destination IDs, raw coordinates and trip integration are
unchanged. Local ISO-code SVG assets come from flag-icons 7.5.0 (MIT); their license
and notice are bundled in the frontend's `public/flags`. Missing assets display a
globe beside the visible country name.

When primary coverage is unavailable or missing, explicit verified OSM geocoding
remains available with country qualification and wrong-country rejection. Public
Nominatim is not used for autocomplete. Provider fallback limits and incomplete
administrative records are disclosed, rather than labeled complete coverage.

## Verification

See `../../audit/2026-10-14/administrative-selector/REPORT.md` for source diagnosis,
five destination IDs/coordinates, browser evidence and actual test results.
Browser verification uses public catalogue services and an isolated empty-hotel
fixture; it does not create a trip in the shared database. Unit tests run the real
accommodation controller with database access and provider inventory mocked.
