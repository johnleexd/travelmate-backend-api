The compressed destination index is derived from the official worldwide
[GeoNames gazetteer](https://download.geonames.org/export/dump/), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). GeoNames provides place
IDs, WGS84 coordinates, feature types, alternate names, and ISO country codes.
Administrative names come from `admin1CodesASCII.txt`. No per-country city lists
are manually maintained. The snapshot date is embedded in destinations.json.gz.

The index retains up to 200 cities, 30 administrative regions, 150 records per
natural feature type and 3 country records per country. The current snapshot
contains 132,826 records across all 252 supported country/territory entries.
Separately supported territories that GeoNames groups under a parent country
are resolved from matching island/ADM1 names and administrative membership;
neighboring islands outside that subdivision are never included.
City prominence uses population;
multilingual name counts provide a modest signal for physical destinations.
This is not a tourist popularity score. Small territories may have fewer than
10 eligible records. No destinations are invented to pad their lists.

To refresh, download `allCountries.zip` and `admin1CodesASCII.txt` from the URL
above into `.cache/destination-source/` (name the latter `admin1.txt`), then run
`node scripts/build-destination-index.mjs` from the backend directory. Review
the resulting country counts and run destination tests before deploying. Only
the compressed index is distributed; the large source archives are ignored.
Deploy the backend's data directory alongside src/dist. Open-Meteo remains the
live geocoder for direct names beyond this bounded catalogue.
