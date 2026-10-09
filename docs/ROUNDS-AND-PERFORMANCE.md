# Rounds and response-time verification — 9 October 2026

## Changes

The admin can start a named round and select previous rounds in the dashboard. Teams and jury assignments carry over by default; an optional fresh roster keeps venues, criteria and jury accounts. Previous rounds retain immutable snapshots for admin views and CSV exports. Archives do not store password hashes or recursively include other round archives. Backups include all rounds and recovery supports both older and newer backups.

Transactions protect round transitions, score saving and administrative mutations. Round identifiers reject stale forms, including forms from before this update that do not supply an identifier. Existing live data is retained as Round 1; the schema migration never clears scores or replaces an existing administrator password.

Session expiry is fixed for ordinary reads. Session reads no longer cause a session rewrite and expired-session cleanup on every click. Related dashboard/results and evaluation queries are batched. The jury workspace returns its dashboard, assigned teams and rubric together, and save no longer triggers several redundant refresh requests. Buttons and tables display pending state immediately. Server-Timing headers distinguish server processing from client/network delay.

## Evidence

Before deployment of this change, public measurements from this laptop showed a 363 ms static asset request, a first health request of 1333 ms, and subsequent health requests of 288, 279 and 291 ms. This sample establishes a server/database component; it does not rule out venue Wi-Fi issues or measure authenticated button latency.

Automated suite: 31 passed, zero failed, two intentional local-mode skips. Tests cover both SQLite and the real libSQL client with disposable file databases, including migration preservation, historical CSV equality, isolation of new scores, missing/stale round identifiers, concurrent transitions, rollback, backup recovery and a 120-team concurrent scoring rehearsal.

An instrumented libSQL test verifies three database query/batch calls for authenticated dashboard, teams, jury workspace and evaluation reads: session read, authorization read and one data batch. Score saving uses five query/batch calls, plus transaction begin/commit; this is a query-count assertion rather than a hosted latency benchmark.

Chrome UI verification used an isolated in-memory database. Starting Round 2 retained two teams but cleared scores. Selecting archived Round 1 displayed the submitted 100.00 score and a draft total of 22, hid editing actions and downloaded a CSV containing both teams. The downloaded historical CSV was parsed and reconciled, including a blank average for the draft.

The jury UI displayed Round 2 with two pending teams and blank scoring forms. Innovation = 19 was saved as a partial draft and persisted when reopened. A mobile viewport measured 382 CSS pixels with no horizontal page overflow. No browser console errors were recorded in this fixture.

## Round management update

Manage rounds lists all rounds with Open round, Rename and Remove actions. Removed archived rounds can be restored with their original scores; the active round cannot be removed. The selector excludes removed rounds, and backups retain them. Round management works while viewing archived results, without making historical scoring forms editable. Start new round always targets the active round, accepts a name, preserves the old round and displays errors inside its dialog. Versioned script URLs prevent old browser assets from mixing with the new controls after refresh.

The schema version 3 migration adds only a nullable removal timestamp. Tests verify migration preserves archived snapshots, rename updates historical metadata, removal hides historical views, restoration produces the same CSV, jury access is rejected, and stale round identifiers cannot manage rounds. The complete suite passes 33 tests with two intentional local-mode skips.

## Deployment rehearsal

Refresh every browser after deployment, confirm the active round and current scores, then measure representative authenticated navigation and saves on venue Wi-Fi. Use Start new round only when ready to finish the current round. Keep a full backup before judging. The isolated UI and query-count tests do not replace a hosted round-transition rehearsal.
