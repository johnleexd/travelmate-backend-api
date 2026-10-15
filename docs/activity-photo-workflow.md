# Activity suggestions and photos

Generation selects verified catalog places using interests, AI route hints,
destination geography, weather and usable schedule windows. Existing deterministic
budget calculations and price disclosures remain in force. A provider-verified,
reusable photo breaks only relevance ties within 0.25 score points. Missing photos
never exclude an otherwise eligible activity. The AI returns place IDs and times;
it cannot supply image URLs.

Activity image order is: suitable stored activity selection, matched
Wikipedia/Wikimedia place photograph, Unsplash illustration, this trip's existing
destination image, then a neutral placeholder. Production activity requests do
not depend on Google Places or billing. The existing Google Maps links and other
navigation features remain available.

Named searches use the exact place name, destination city/country, and stored
coordinates when available. Conflicting location/identity and ambiguous Wikipedia
articles are rejected. Commons files require reusable rights and creator credit.
Artwork checks include category/medium evidence and documented historical artist
lifespans; a JPEG extension or modern upload date alone does not prove a photograph.
Generic activities such as Lunch and Beach walking skip place lookup and require
relevant Unsplash metadata. They display **Illustrative photo**. A trip-image
fallback displays **Destination photo**.

Creating or saving an activity never waits for image searches. Generation returns
the catalog's already resolved images; missing selections are enriched separately.
Notes, time and cost changes preserve photo identity. Title/location changes clear
the prior place, Google ID, photo and any mirrored day cover. The editor uses the
activity title as the place name and Location as an optional user-entered address.

Manual saves accept server-owned stored photos or a matching provider selection
from the existing cache, rather than arbitrary submitted URLs. Saved enrichment
merges only photo fields into the latest owned record with an optimistic database
comparison. Changed identities discard stale responses. Browser selections stay
scoped to the trip and activity, including when another activity is added to a
draft. Reopening uses the persisted URL, credits, license and photo type.

Unsplash keeps its returned hotlink and parameters, photographer/source referral
links, photo ID and download-location metadata. Selection tracking is recorded and
retried after outages; it is not sent on every image render. These are the existing
[Unsplash API requirements](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines).
Wikimedia requests retain pacing, maxlag, deduplication, bounded caches and
Retry-After handling, following [MediaWiki etiquette](https://www.mediawiki.org/wiki/API:Etiquette).
Failed searches retain working stored photos. Failed image loading can display a
separately credited destination fallback without deleting the stored selection.

No reusable photo-upload endpoint or storage infrastructure was found in these
projects, so this change does not add uploads. Any future upload flow must require
photos the traveler owns or has permission to use. Provider coverage, metadata,
rights and availability remain variable; photos are not guaranteed for every
attraction.

Verification evidence: `../../audit/2026-10-13/activity-photo-workflow/REPORT.md`.
