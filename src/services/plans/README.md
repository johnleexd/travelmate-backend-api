# AI allowance implementation

Development defaults are Free 3 / Plus 30 per calendar month. Override with
`AI_FREE_MONTHLY_LIMIT` and `AI_PLUS_MONTHLY_LIMIT`; these are provisional, not
approved pricing or business terms. Checkout is unavailable: existing payment
fields belong to retired, simulated booking flows, not subscription payments.
There is no public upgrade/payment endpoint and no new admin activation UI.
The internal demo-grant service checks active admin permission and records an
immutable activation key, actor, reason and expiry. Demo grants cannot replace
verified paid entitlements or shorten an entitlement. No provider keys rotate.

Calendar boundaries use **Asia/Manila, UTC+08:00** on the server. Tracking starts
at the migration's `generation_tracking.started_at`; older records are unmetered.
Upgrade increases the current month's ceiling without clearing usage. Expiry
returns to the Free ceiling, keeping used/reserved counts. A downgrade can leave
remaining allowance at zero; it never blocks saved trips or manual edits.
Existing reservations retain the allowance period of their original request.

The existing `itinerary_generations` ledger now reserves allowance under a user
row lock. Unique user/key and one-active-operation constraints also apply across
processes. Request keys cannot be reused with different payloads. A valid AI
itinerary or day-replan preview is persisted in this ledger atomically with one
deduction. Saving that result as a trip/version later does not charge again.
Catalogue-only fallbacks have no AI charge. Confirmed failures release the
reservation. Place-only day retries, photos, maps, budgets, manual edits and
reading saved trips never use this allowance.

Generation has a nine-minute bounded provider deadline; its reservation lease
is twelve minutes. Expired leases reconcile on allowance/status reads and new
reservations. A fenced old worker cannot persist after expiry. Reconciliation
does not resubmit an ambiguous provider call. The original operation key remains
terminal; the user can explicitly start a new operation. Transient database
errors leave uncertain operations reserved for safe reconciliation. Browser
timeouts/disconnects do not release a running operation. Results remain available
at the authenticated operation endpoint and in My Plan after refresh/restart.

AI regeneration and Replan My Day consume one allowance when a validated result
is persisted, including previews the user later declines. Internal provider
repair/retry calls remain part of that same operation. Input limits, 1–31 day
trip bounds, provider token caps and bounded repair loops remain enforced.
