# Releasing an update

The `.exe` never changes. It carries one copy of the game so it can always
start, and every launch it asks Supabase whether a newer build has been
published. If one has, it downloads it, verifies its SHA-256, and hands it to
the launcher, which swaps it in for the *next* start.

So shipping an update is exactly one job: **make the new build the newest
published release.** Everyone who already has the exe gets it on their next
launch. Nobody re-downloads anything.

---

## The 60-second version

```bash
# 1. bump the version — this is what the menu will show
npm version 1.5.0 --no-git-tag-version

# 2. build and run the test suite
npm run build:exe
npm run verify:all

# 3. commit and push: the published payload is fetched from the commit
git add -A && git commit -m "1.5.0 — ..." && git push

# 4. publish it (needs the database credential, see below)
SUPABASE_DB_URL="postgresql://postgres.srugeztbfxcjuvokhumw:…@…" \
  node tools/publish-release.mjs --version 1.5.0 --notes "What changed, in plain words."
```

The published build is fetched from the **commit** you just pushed, never from
the branch, and its SHA-256 is checked against the file on disk before it is
allowed to become the newest release. See "Why the source is pinned to a
commit" below for the failure this prevents.

That is the whole loop. Anyone launching 1.4.0 or later gets 1.5.0.

---

## What each piece does

| Piece | Role |
| --- | --- |
| `release/Aetheris.html` | The build. Committed, so it has a stable public URL. |
| `release/Aetheris.exe` | Launcher + fallback copy. Changes only when the launcher itself changes. |
| `tools/publish-release.mjs` | Validates the build, points Postgres at it, records the release. |
| `aetheris_releases` | One row per version: notes, date, size, sha256, published flag. |
| `aetheris_release_payload` | The html itself, exactly as it was fetched. |
| `pg_net` | Lets Postgres fetch the file, so the release command uploads nothing. |

### Why Postgres fetches the file instead of the tool uploading it

A 730 KB html is awkward to push through a SQL statement, and anything that
re-encodes it (JSON escaping, line endings, a text-mode write) would change the
hash and make every client reject the download. Letting `pg_net` fetch the
committed file means the bytes that get published are the bytes that were
committed — and the same hash that the build tool prints is the one the players
verify.

It also keeps the release command small enough to be one step that either fully
succeeds or fully fails.

### Why the source is pinned to a commit, not a branch

`raw.githubusercontent.com` serves branch URLs through a CDN that keeps handing
back the *previous* build for a while after a push. Publishing from a branch URL
therefore risks storing the old html under the new version number — the menu
would say 1.5.0 while the download was still 1.4.0, and every player would
"update" to nothing. Commit URLs are immutable, so the bytes fetched are the
bytes committed.

As a second line of defence the caller states the SHA-256 it built, and
`aetheris_publish_finish` refuses to publish a body that does not match:

```
stale fetch: got 745533 bytes sha 1477d61e0d9e, expected deadbeefdead
```

If you see that, nothing was published and nothing was damaged — run the same
command again once the CDN catches up.

### Why publishing is two calls

`aetheris_publish_start` asks Postgres to fetch the URL and returns immediately.
`aetheris_publish_finish` is called until the body has landed; it validates the
html, hashes it, and makes it the newest release. The split exists because a
synchronous fetch can exceed the management API's 30-second request ceiling —
which is not a failure mode you want halfway through replacing the game for
every player. `publish-release.mjs` does the polling for you.

---

## The credential

`SUPABASE_DB_URL` is a Postgres connection string from the Supabase dashboard
(Project settings → Database). Set it per command or in your shell profile —
never in the repository.

The anon key that ships inside the game **cannot** publish, by design:

- write grants are revoked from `anon` and `authenticated` on both release
  tables (RLS would also block it, but the grants no longer contradict that);
- `aetheris_publish_start` / `aetheris_publish_finish` are revoked from
  everyone except the database owner.

If the anon key could publish, extracting it from the game would let anyone
ship a modified build to every player in the world. That is the one part of
this system that must never be relaxed.

---

## Verifying a release

```bash
# what players will see
node -e "…"   # or just open the game → Change log
```

Checklist that the tooling enforces for you:

- [x] the html starts with `<!doctype html` and ends with `</html>`
- [x] it contains the AETHERIS title and the booted-game bundle
- [x] it does **not** contain the exe payload trailer
- [x] it is between 100 KB and 8 MB (the launcher's staging ceiling)
- [x] its SHA-256 matches what was stored
- [x] the version is `X.Y.Z`

The one thing it cannot check is whether the *committed* build is the one you
just made. It prints a note when the working copy and `HEAD` disagree; if you
see that, commit and push first.

---

## Rolling back

Mark the bad version unpublished:

```bash
node tools/publish-release.mjs --version 1.5.0 --unpublish
```

Players already on 1.5.0 keep playing it — the client never downgrades itself,
because silently replacing a working game with an older one is worse than
leaving it alone. Ship 1.5.1 with the fix; that is the path every player will
actually take.

---

## If an update breaks something

The launcher is deliberately paranoid, so most failures are survivable:

| What happens | What the player sees |
| --- | --- |
| No internet | The build they already have. The check is silent. |
| Supabase unreachable or erroring | Same. |
| Download truncated / hash mismatch | Update refused, old build keeps working. |
| Launcher refuses the body | Same; the refusal is logged, nothing is staged. |
| Crash mid-stage | Old build runs; the partial `next.html` is discarded next launch. |
| `next.html` is corrupt on disk | Discarded at startup; `index.html` is untouched. |

The only irreversible action in the whole flow is the final rename, which
either happens or does not. There is no state where `index.html` is half a
file.

---

## Bumping the launcher itself

Everything above updates the *game*. The launcher — the exe — only needs to be
redistributed when its own behaviour changes (new browser lookups, a different
update hand-off). When that happens the payload is still embedded, so the new
exe works immediately and then pulls the newest game on its first launch.

`npm run build:exe` verifies the loopback server by compiling the real launcher
source, serving the actual payload through it and fetching it back byte for
byte, so a broken launcher fails the build rather than the player.
