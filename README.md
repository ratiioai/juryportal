# Jury Portal — venue operation

This is one application: Vercel serves the frontend and Express API, and Turso stores persistent event data. Frontend and backend do not need separate deployments. Follow [the Vercel deployment and rehearsal guide](docs/VERCEL-DEPLOYMENT.md) for public hosting. The local SQLite mode below remains available for development and recovery.

## Start on Windows

1. Use Node.js 24 LTS or newer. From this application folder, run `npm ci` if dependencies are not already installed.
2. Double-click **Start-Portal.cmd**, or run `npm start`. Keep that window open during judging.
3. Open `http://localhost:3000` on the server laptop. The startup window also prints the laptop’s venue Wi-Fi address, such as `http://192.168.1.25:3000`.
4. Share that Wi-Fi address with juries connected to the same network. `localhost` only works on the server laptop itself.
5. If Windows asks about network access, allow Node.js on the trusted **Private** venue network. Do not expose this server to the public internet or enable router port forwarding.

The preserved database has the existing `admin` account. If its password is still the original `admin123`, the portal requires changing it at first login. For a fresh database, startup prints a randomly generated administrator password; it must also be changed at first login. `ADMIN_PASSWORD` can set the initial password for a fresh database, but does not override an existing account.

## Set up the event

1. Create venues.
2. Create all scoring criteria and their maximum marks. Criteria are frozen as soon as any draft or submission exists, so finish the rubric before judging begins. The total maximum can be any positive value; it need not be 100.
3. Add jury accounts, each with a unique username, a password of at least 10 characters, and a home venue. Share each account only with its jury member. They use the same login page as admins and are redirected to their own portal.
4. Add teams, or import CSV/XLSX using the supplied template: `teamNumber,teamName,venue`. Venue names must match a configured venue (case is ignored). Imports are all-or-nothing: correct every reported row and upload again. Files are limited to 2 MB and 2000 teams. In Excel, format identifiers as **Text** if leading zeros must be preserved.
5. Active juries are automatically assigned all teams in their home venue. On **Juries → Assign Teams**, an admin can add teams from another venue or remove untouched assignments. Teams with saved evaluations cannot be unassigned.
6. Check assigned team counts and download a database backup before judging.

Venue capacity is informational; it does not cap the number of teams assigned.

## During judging

- A jury logs in, selects **My Assigned Teams**, chooses a team, and enters its criterion scores.
- **Save Score (Draft)** allows partial work. Saved scores persist through server restarts. Unsaved changes remain only in that browser; the portal warns before leaving them.
- **Submit this team** requires all criterion scores and locks that evaluation. **Submit All Evaluations** requires complete scores for every assigned team and validates all drafts before submitting any.
- Admins can unlock a submission from **Teams → View**, with a required reason recorded in the audit history. The jury must reopen the evaluation before editing it.
- If the same evaluation is edited in two tabs, the stale save is rejected. Reopen the evaluation to see the saved version before re-entering changes.
- A team’s final score is the average of **all assigned juries’ submitted totals**. Until every assigned jury submits, its final score and rank remain blank. Ties share a rank, with competition ranking (1, 1, 3).
- Adding an extra jury to a completed team makes that team incomplete until the extra jury submits. Finish assignment planning early to keep workloads and completion expectations clear.
- Changing a team’s or jury’s home venue is blocked once it has evaluations. Add cross-venue assignments instead.
- Disabling a jury revokes access immediately. Existing scored assignments remain part of the event; reactivate the jury if its drafts still need completion. Deleting a jury with evaluations is blocked. Deleting a team removes its evaluations too, so make a backup first.

## Results CSV

**Leaderboard → Download Detailed Results CSV** includes every team, its venue, completion status, assigned/submitted counts, maximum possible score, final average and rank. Each assigned jury has a name, status, criterion scores, and total. Pending scores are empty; valid zero scores remain zero. Draft scores are explicitly labelled and do not contribute to a final average. Quotes, commas, line breaks and Unicode are preserved, with spreadsheet formula protection for text fields.

The leaderboard displays fully evaluated teams only. The CSV also includes pending and unassigned teams so administrators can reconcile missing work.

## Judging rounds

Use **Start new round**, rather than resetting the event, to move from Round 1 to Round 2. The current round is archived atomically with its teams, names, assignments, rubric, drafts and submitted scores. The new round starts with blank evaluations. Jury accounts, venues and criteria remain available; keep teams and assignments by default, or uncheck that option to import a fresh roster.

The admin **Judging round** selector opens either the active round or an earlier read-only round. Dashboard totals, team details, leaderboard, venues, juries, rubric and detailed CSV reflect the selected round. Earlier rounds cannot be edited or reopened for judging. Judges see the active round name. Old forms are rejected after a round transition; refresh and reopen the evaluation before scoring the new round.

Existing event data becomes **Round 1** automatically when this version starts. Full JSON/SQLite backups include round history. **Reset event setup** is for a different event: it still saves a backup, preserves archived rounds and audit history, clears current event setup and revokes jury accounts.

After deploying this update, refresh every admin and jury browser once so it loads the new round-aware controls. Login sessions expire after 12 hours and no longer rewrite the database on each ordinary read.

## Backups and recovery

- While the server runs, an online SQLite backup is written to `backups/` every 15 minutes. Check free disk space before the event; automatic backups are retained.
- **Download Backup** on the admin dashboard creates a fresh consistent snapshot and downloads it. `npm run backup` also creates a snapshot, including committed WAL data, without stopping the server.
- Hosted **Download Backup** creates a JSON snapshot. **Saved Reset Backups** retrieves snapshots saved before hosted resets. See the deployment guide for recovery into a new local database. The automatic 15-minute SQLite backups described here apply only to local mode.
- Copy backups to a separate USB drive or another device. Backups on the same laptop do not protect against laptop failure.
- To restore: stop the server, preserve the current `database/` folder, then place the selected backup in a clean database folder as `database.db`. Move the old `database.db-wal` and `database.db-shm` files out with the old database; never pair them with a restored database. Start the portal again and log in. Restoring an older snapshot also restores the passwords stored in that snapshot.
- `database/.session-secret` is generated automatically and must remain private. Keep it across ordinary restarts. If it is missing on recovery, a new secret is generated and everyone logs in again.
- **Reset event setup** requires typing `RESET EVENT`. It first saves a backup, archives the current round, clears event data, retains earlier rounds, audit history and administrator accounts, and logs everyone out. Use only when preparing a new event.
- The original application and database are preserved at `backups/pre-hardening-2026-10-08/`.

## Venue rehearsal — do this on the actual Wi-Fi

1. Keep the server laptop plugged in and disable sleep for the event. Keep its venue address stable; reconnecting may change its IP.
2. On a second device, open the printed Wi-Fi address and log in with a jury account. Some guest networks isolate devices; ask venue IT for a network that permits device-to-server connections if the address is unreachable.
3. Score one temporary team with two temporary juries. Verify an average, a pending team, CSV export and a backup. Remove temporary data before real judging, or restore the clean pre-rehearsal backup.
4. Stop and restart the server; verify saved scores remain. Keep a paper scoring fallback and a spare device available.

## Configuration and checks

Run `npm test` for HTTP integration tests using disposable databases. Run `npm audit` to check dependencies. Tests do not use the event database.

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Listen on venue interfaces; use `127.0.0.1` for laptop-only access |
| `DB_PATH` | `database/database.db` | Absolute path to event database on local disk |
| `SESSION_SECRET` | Private generated file | Optional secret of at least 32 characters |
| `ADMIN_PASSWORD` | Generated for a fresh database | Initial admin password only |
| `HTTPS_ONLY` | Off | Set `1` when served over HTTPS |
| `TRUST_PROXY` | Off | Set `1` only behind one trusted reverse proxy |

Local HTTP does not encrypt credentials or scores in transit; use it only on a trusted venue network with unique event passwords. Hosted mode enforces secure cookies behind Vercel HTTPS and uses Turso rather than local files. A public deployment needs its own rehearsal.
