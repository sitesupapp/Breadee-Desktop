# Breadee Desktop — production updates

How a fix reaches an installed till, and what to do when one goes wrong.

## The one-time bootstrap

An installed copy of Breadee that predates the updater **cannot update itself** —
it has no updater in it. The first updater-enabled build must be installed by
hand, once, on each terminal. Every release after that is delivered in-app.

## Releasing a new version

1. The fix lands on `desktop-staging` and CI is green.
2. Choose the next SemVer. Patch for a fix (`1.0.1`), minor for a feature
   (`1.1.0`). Plain `MAJOR.MINOR.PATCH` — no suffixes.
3. Bump **all three** in one commit, and keep them identical:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`

   `test/production-updater.test.ts` fails if they drift, and the release
   workflow refuses a tag that disagrees with them.
4. Merge to `desktop-staging`.
5. Owner approves the production promotion.
6. Tag the merged commit and push the tag:

   ```bash
   git tag desktop-prod-v1.0.1 <merged-sha>
   git push origin desktop-prod-v1.0.1
   ```

7. **Desktop Production Release** runs: it validates the tag, builds against the
   production backend, signs the update, publishes the GitHub release, and — last
   — advances `latest.json` on the `desktop-production-channel` branch.
8. Installed production terminals see *Breadee Update Available* on their next
   startup check, or immediately via **Settings → About → Check for updates**.
9. The user clicks **Update & Restart**.

Nothing is pushed. A terminal downloads only when someone clicks.

## Why the channel is a branch, not `/releases/latest`

This repository has published staging and RC releases — `desktop-v1.0.0-rc1-staging`
among them. A generic "latest release" endpoint would serve one of those to a
production till and point a real restaurant at the staging database.

So the updater reads exactly one file:

```
https://raw.githubusercontent.com/sitesupapp/Breadee-Desktop/desktop-production-channel/latest.json
```

Only the production release workflow writes it, and the branch is orphaned so it
holds the manifest and nothing else. A staging build has no path to that file.

The app has a second, independent guard: `lib/updater.ts` refuses to check at all
unless the build is `VITE_APP_ENV=production`. Either guard alone would be a
single point of failure.

## Signing

Updates are signed with the Breadee production updater key. The public half is
compiled into the app; an artifact the workflow did not sign will not install,
because the client refuses it.

- **Public key** — in `src-tauri/tauri.conf.json`. Not a secret.
- **Private key** — GitHub → Production environment → `TAURI_SIGNING_PRIVATE_KEY`.
  Never in the repository, never in a build log, never in an artifact.
- **Owner backup** — `%USERPROFILE%\.tauri\breadee-production-updater.key`.

Do **not** generate a new key per release. Every terminal in the field trusts the
public key that was compiled into the build it is running, so a new key makes
every installed terminal unable to accept updates until it is manually
reinstalled. Treat the key as permanent infrastructure.

### If the key is lost

Every installed terminal must be manually reinstalled with a build carrying the
new public key. There is no in-app recovery — that is the point of signing. Keep
the backup.

## Rolling back

Updates only move forward: the client refuses anything not strictly newer, so you
cannot ship `1.0.0` to fix a bad `1.0.1`.

To roll back, **release forward** to a version above the bad one carrying the old
code:

```bash
git revert <bad-commit>          # on desktop-staging
# bump to 1.0.2, merge, then:
git tag desktop-prod-v1.0.2 <sha>
git push origin desktop-prod-v1.0.2
```

To stop a bad version spreading *while* you prepare that, revert `latest.json` on
`desktop-production-channel` to the previous release's contents. Terminals that
already updated are unaffected — they need the roll-forward.

Deleting the GitHub release does not recall it either; terminals that already
downloaded have already installed.

## When something goes wrong on a terminal

An update failure never stops Breadee working — the installed version keeps
running and the error is shown in **Settings → About**.

| What the user sees | What it means |
|---|---|
| Could not reach the update server | Offline, or GitHub unreachable. Retry later. |
| Failed its signature check and was refused | The artifact was not signed by the Breadee key. Do not bypass — investigate the release. |
| Windows refused the update | Install the release installer manually on that machine. |

An offline terminal never mentions updates at all. That is deliberate: a message
every morning trains people to ignore the one that eventually matters.

## What is deliberately not automatic

- No silent install. Downloading requires a click.
- No forced restart. The user chooses when the till goes down.
- No update UI over the POS till — the banner lives in the admin shell only, so
  it cannot appear mid-order.
- No polling. One check at startup; everything else is manual.
