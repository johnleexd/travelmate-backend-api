# Property photos and accommodation configuration


The existing OpenStreetMap discovery feed and Amadeus adapter did not return verified property photos. The backend now enriches mapped properties using explicitly linked Wikimedia Commons files:

1. Accept an OSM property’s `wikimedia_commons=File:...` link, or its exact `wikidata=Q...` entity.
2. For Wikidata, require that entity's coordinates to match the mapped property before reading its P18 image. No hotel-name image searches or matching photos from chain names.
3. Use Commons Imageinfo metadata to verify an allowed free license, creator and bitmap URL. Unknown/restricted licenses, missing credits, non-photo indicators and inaccessible media remain placeholders.
4. Return image URL and creator, license, license URL and original file-page attribution. The UI shows these credits and discloses cropping. Broken images switch to “Photo unavailable”.

Sources: [Commons reuse guide](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia), [MediaWiki Imageinfo API](https://www.mediawiki.org/wiki/API:Imageinfo/en). Credits are checked per file rather than assuming every provider image is licensed for reuse.

### Configuration

- No new API key is needed for the public Commons/Wikidata integration. The backend needs HTTPS access to `www.wikidata.org` and `commons.wikimedia.org`; browsers need image access to `upload.wikimedia.org` / `thumb.wikimedia.org`.
- Keep existing `ACCOMMODATION_PLACES_URL` / optional fallback configured for OSM discovery. Photos require property-specific Commons or Wikidata tags in that upstream data, matching coordinates where applicable, and acceptable file rights metadata. Untagged properties remain selectable with placeholders.
- Existing `AMADEUS_API_KEY`, `AMADEUS_API_SECRET` and `AMADEUS_ENV` remain backend-only. Test quotes are labeled as test prices; production room rates require an appropriately configured production account. This adapter does not supply hotel photos.
- Existing owner-upload URL fields do not establish per-image reuse permission or creator/license credits, so they are not displayed as verified hotel photos by this browser. To add owned/licensed media or a contracted hotel photo service, use a backend adapter that resolves the exact stable property ID and supplies verified rights/attribution; explicitly extend the UI image-host allowlist for that provider. Do not infer hotel photos from unrelated stock images.
- No database migration is required: the optional accommodation type extends the existing saved itinerary JSON contract. Old trips remain readable.
