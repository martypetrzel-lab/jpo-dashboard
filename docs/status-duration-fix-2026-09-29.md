# Status and duration repair — 2026-09-29

## Changes

- Historical Central Bohemian rows must contain a matching source ID. Support both query-string and `/zasahy-jpo/<id>/` links; never assume an unidentified row belongs to the requested event.
- Missing historical matches are marked unverified, without applying an invented status or closing an incident because it disappeared from RSS.
- API live durations use a verified start before first-seen estimates, matching the browser. Keep first-minute estimate metadata so the browser timer can advance.
- Ingest/reconciliation do not replace a verified active start with a first-seen estimate.
- A later closed-state observation without an end timestamp preserves an already captured official end and its accuracy.
- Pass the existing RSS2JSON secret to the active reconciliation step as well as the import step. No new secret is created or exposed.

## Verification and deployment

Run `npm ci` and `npm test`. Integration tests use an isolated database, not production.
After review, merge the branch through the normal deployment process. No schema migration is required.
Verify `/health`, a known active event with a verified start, and a completed event with a verified end. Run the existing reconciliation dry-run first and review proposed status changes before historical repair. Do not run a blanket production backfill based only on this patch.

Live historical verification from the development environment failed with an upstream connection-refused response. Tests cover parser fixtures and the API/database path; they do not prove production source reachability or successful deployment.

## Limits

`pubDate`/last source update is not automatically a start or end time. Exact completed duration requires a verified start and end; first-seen-based values remain estimates. If the source supplies no usable times, display unknown rather than fabricate a duration. The existing 72-hour duration validation limit is unchanged. This patch does not recover missing source timestamps or remove source/network restrictions.
