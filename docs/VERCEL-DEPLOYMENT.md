# Vercel + Turso: deployment and event rehearsal

The public portal is one Vercel project. Its Express entry point is `app.js`, its website files are in `public/`, and persistent data is in Turso. `npm start` runs the separate local SQLite recovery mode; it does not connect to Turso.

## Set up the accounts

1. Create a Vercel project using the **inner application folder** containing `package.json`, `app.js`, `server.js` and `vercel.json`. If importing a repository containing the outer folder, set Vercel's Root Directory to this inner folder. Use Node.js 24, the Express framework, and the configured defaults. Do not set a frontend build output directory.
2. Create a Turso Cloud **libSQL/SQLite-compatible** database, either through the Vercel Turso marketplace integration or the Turso dashboard/CLI. Select a primary region near Vercel's Mumbai `bom1` region if available. This code uses `@libsql/client`, not a different database protocol.
3. Add the environment variables below in the Vercel dashboard's Production environment. Never paste secrets into source files, browser JavaScript, screenshots, or chat.

| Variable | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | Turso's database connection URL, beginning `libsql://` or `https://` |
| `TURSO_AUTH_TOKEN` | A database token with read and write access; keep it valid throughout the event |
| `SESSION_SECRET` | A stable random secret of at least 32 characters; do not rotate during judging |
| `ADMIN_PASSWORD` | A unique initial administrator password of at least 10 characters and at most 72 bytes |

The Turso integration can supply the first two variables. Set the remaining two yourself. `ADMIN_PASSWORD` initializes an empty database; changing it later does not reset an existing account password.

4. Deploy. Visit `/api/health` on the deployment URL: it must return `{"status":"ok"}`. The first API request initializes the database. Missing credentials or an unavailable database returns a setup/unavailable error rather than silently using a temporary local file.
5. Sign in as `admin` with the initial password and change it when prompted. Create venues, criteria, juries and teams as described in the main README. Existing local data is **not** automatically uploaded to Turso. Import the teams and configure the event before judging.
6. If using a company domain, connect it in Vercel, verify HTTPS, and use that same domain for all jury logins. A different domain has a different login cookie. Vercel Hobby is for personal non-commercial use; choose a suitable commercial plan for company use. Turso's Free plan can be used within its published quotas.

Do not point a Preview deployment, an automated test, or a rehearsal that resets data at the real event database. Use a separate Turso database for destructive rehearsal and add its variables only to Preview.

## Required rehearsal on the deployed portal

Finish these checks before October 9, 2026 judging begins. Local tests cannot establish the venue's internet quality, remote latency, token validity, or actual Vercel deployment behavior.

1. Open the public HTTPS URL on at least two venue Wi-Fi devices. Verify admin and jury logins and that a jury cannot see admin screens or unassigned teams.
2. Confirm all 100–120 teams were imported, every venue has the intended juries, and assignment totals match the judging plan. Verify one cross-venue assignment.
3. In the rehearsal database, have several juries save and submit at the same time. Confirm each jury's totals separately. Submitted scores must be locked and the final average must remain blank until all assigned juries submit.
4. Open the same evaluation in two tabs; save one tab then attempt to save the older tab. The older tab must be rejected instead of overwriting newer work.
5. Download the detailed CSV while judging is active. Compare a completed team, a pending team, a draft, and a zero score against the portal. Confirm the criterion names, individual jury totals and average.
6. Redeploy without changing database or session secrets. Verify saved evaluations remain. Confirm the public URL works without Vercel deployment-login protection blocking jury devices; keep the portal's own login enabled.
7. Temporarily disconnect one jury device's internet while saving. It must show failure, keep the entered scores on screen, and never claim success. On reconnect, reopen the evaluation to establish whether the previous request reached the server before retrying. Do not automatically repeat a submission whose outcome is uncertain.
8. Download a full backup, test the recovery procedure below, and check the final production portal separately. A CSV report alone cannot restore accounts, assignments and audit history.

## During the event

- Keep an administrator watching incomplete evaluations and errors. If a jury cannot save, keep its form open, restore connectivity, then reopen the evaluation and check the saved revision before retrying.
- Download a full backup before judging, between rounds, and after judging. Store backups on another device securely: they include password hashes and private event information.
- Do not change criteria, database credentials, primary URL or deployment settings during judging. Avoid Master Reset. Extra jury assignments make completed teams incomplete until the added jury submits.
- All normal hosted saves require internet. This portal does not automatically switch databases or merge offline scores. Keep paper scoring sheets and a hotspot available for a venue connection outage.
- Check both providers' usage dashboards. Free quotas are capacity allowances, not an uptime guarantee. Turso's recovery retention depends on the plan and is additional to downloadable portal backups.

## Recover a hosted backup locally

Use this only with a full downloaded `.json` backup. A restoration returns the event to that snapshot's time, including its stored passwords. Record scores submitted after that time for reconciliation.

1. On a prepared recovery laptop with Node.js 24 and dependencies installed, run:

   ```powershell
   node scripts/restore-backup.js "downloaded-backup.json" "recovery\event.db"
   ```

   The destination must be a **new file**; the recovery tool refuses to overwrite an existing database. It validates the backup and checks restored database integrity. If recovery fails, use another new destination; the failed file is not a usable recovery database.

2. Start the restored event in local mode:

   ```powershell
   $env:DB_PATH = (Resolve-Path "recovery\event.db").Path
   npm start
   ```

3. Log in with the credentials saved in that snapshot. Everyone logs in again. Verify team counts, jury assignments and several known scores, then share the laptop's venue network address.
4. Have a trusted venue network ready: it must allow jury devices to reach the laptop, and the laptop must remain plugged in and awake. Local HTTP is suitable only on a trusted network. This is an operational fallback, not an automatic failover.

**Saved Reset Backups** lets an administrator download a snapshot retained inside Turso before a hosted Master Reset. These snapshots are in the same cloud database and do not replace a backup copied to another device.

## What automated tests establish

`npm test` runs real HTTP requests against disposable databases in local SQLite mode and through the asynchronous libSQL driver. It checks permission boundaries, cross-venue judging, score validation, revision conflicts, locking, atomic submission, CSV correctness, imports, restart persistence, recovery, hosted secure sessions across instances, startup failure recovery, and a 120-team/five-jury/ten-criterion rehearsal.

The driver tests use a local libSQL file database. They do **not** prove live Turso network latency, Vercel compatibility under an actual deployment, provider uptime, or event connectivity. Passing the deployed rehearsal above is required before declaring the portal ready.

Official references: [Express on Vercel](https://vercel.com/docs/frameworks/backend/express), [Turso integration](https://vercel.com/marketplace/tursocloud), [Turso plans](https://turso.tech/pricing?frequency=monthly), [Vercel Hobby terms](https://vercel.com/docs/plans/hobby).
