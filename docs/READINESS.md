# Verification record — October 8, 2026

**Code verification passed. Live deployment verification remains outstanding.** Neither Vercel nor Turso has been configured yet, so this record does not certify the public portal for the October 9 event.

- Full integration run: 21 passed, 0 failed, 1 intentionally skipped (hosted JSON recovery is only applicable in hosted driver mode).
- Vercel entry checks verify that missing configuration returns 503, concurrent requests initialize one application once, and startup recovers after a simulated temporary connection failure. Hosted mode never silently writes scores into a temporary local database.
- Separate hosted application instances share secure sessions and saved evaluations. Secure, HttpOnly and SameSite cookies were checked behind the HTTPS proxy; results remain available to a newly initialized instance.
- Both database modes rehearsed 120 teams with five jury clients and ten criteria: 600 draft saves, 6,000 individual criterion scores, and five bulk submissions. Every completed team exported the expected 27.00 average, maximum 100, and five separate jury totals; all tied ranks were correct. The expanded rehearsal was rerun after the full suite and passed in both modes.
- Checks cover authentication, CSRF, inactive accounts, session revocation, home-venue and extra assignments, incomplete drafts, score bounds, stale revisions, locked submissions, audit history, import validation, CSV escaping, zero and pending scores, restart persistence, and consistent backups.
- Concurrent saves from two tabs produce one successful save and one conflict. Scoring an assignment concurrently with removing it cannot leave an evaluation detached from its assignment.
- A hosted JSON backup was recovered into a new local database. Scores and database integrity were verified; existing destination files cannot be overwritten. Saved pre-reset cloud backups can be retrieved by an administrator.
- Browser rehearsal with disposable data: jury login, assigned teams, draft save, and reopening the persisted 8 + 7 = 15 score. Responsive form checked with a narrow viewport. Earlier browser checks covered admin assignment management, submissions, averages and actual CSV download.
- Mobile corrections allow long names and criterion headers to wrap, keep wide tables inside their scrollable cards, prevent sidebar width animations from squeezing content during resizing, and restore the scoring buttons' responsive spacing. At a measured 390 CSS-pixel viewport, jury scoring and admin dashboard/teams/juries/criteria/leaderboard/audit pages had equal page client and scroll widths. Wide tables scrolled internally; the page itself did not overflow. The previous screenshot also contained browser capture scaling padding; the new screenshot captures the page content at the measured width.
- Additional admin layout measurements passed at approximately 358, 767 and 1024 CSS pixels without page horizontal overflow. Browser viewport overrides were reset after testing.
- Deployment entry is explicitly `app.js`, Node.js is pinned to `24.x`, and the dependency lockfile matches the application manifest. The original event database is byte-for-byte identical to its preserved backup.
- Production dependency audit: 0 known vulnerabilities reported. This is not a security certification.
- Automated database fixtures are disposable and do not use the real event database. Windows libSQL fixture cleanup runs after the test processes exit, when native file locks are released.

## Remaining before judging

1. Configure separate production and rehearsal Turso databases and Vercel environment variables.
2. Deploy and run every live check in [the deployment guide](VERCEL-DEPLOYMENT.md), on the actual venue connection and jury devices.
3. Configure the production event, reconcile all assignments, and download a full pre-event backup to another device.
4. Confirm an administrator can operate the recovery laptop if internet connectivity or a cloud service becomes unavailable. Recovery uses the last backup; newer scores require reconciliation.

Free capacity limits do not establish availability. The local libSQL driver rehearsal cannot establish real Turso latency, remote transaction duration, Vercel deployment behavior, token expiry, or provider uptime. Those are the purpose of the live rehearsal.
