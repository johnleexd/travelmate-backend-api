# Incomplete generated days

The scheduler distributes only candidates that fit a remaining sightseeing
window. Counting every catalog entry before evaluating visit duration, transfers,
return travel, lunch and known opening windows can use the feasible places early
and leave later dates empty. Unknown hours and missing photos do not remove a
place. Photo availability breaks only close relevance ties.

`SchedulingOptions.diagnostics` emits allocation and slot counts and individual
rejection reasons when a diagnostic caller supplies a callback. It makes no
provider calls and adds no persisted fields.

Existing saved plans retain their original generated content until deliberately
repaired. Run from the backend directory:

```powershell
node --experimental-strip-types scripts/repair-incomplete-trip-days.ts
node --experimental-strip-types scripts/repair-incomplete-trip-days.ts --apply
```

The default command writes previews without updating trips. `--apply` validates
each proposal, locks the trip, checks its original revision, saves a recoverable
version, and records an audit event. A concurrent change skips the write. There
are no destination-specific IDs in the repair algorithm or batch selection.

Only active, grounded, untouched generated plans qualify. A day must contain
only daily allowances and be explicitly incomplete, or carry the older “details
need confirmation” theme. Populated days, user-created entries, manual edits,
rest/travel days, completed/archived plans and legacy plans without trustworthy
destination evidence are preserved. Previously used place IDs cannot be added
again. Requests are shared through the existing provider cache; nothing searches
on rendering or reading a trip.

The repair preserves every saved entry, photo and cost, adding only actual
catalog-backed visits. New admission allowances use the unspent portion of the
existing 20% planning allocation, with currency precision respected. Exhausted
allowances produce an unavailable-price label, never a claim of free entry.
Trip totals and signing are recalculated with the existing storage services.

Older records do not contain the original arrival/departure constraint input.
Their repaired days use suggested 09:00–18:00 windows, visibly requiring
confirmation. Explicit saved rest/travel days remain excluded. Current generation
continues to respect submitted arrival/departure buffers and rest dates.

One short visit does not change a day into a complete sightseeing itinerary.
Meal/free-time/unscheduled blocks and daily allowances are not sightseeing visits.
Opening hours, venue access, admissions and real routes require confirmation;
available catalog coverage cannot guarantee a full day or a photograph.
