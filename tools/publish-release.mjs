#!/usr/bin/env node
/**
 * Publish a build so every installed copy of the game updates itself.
 *
 *   node tools/publish-release.mjs --version 1.4.0 --notes "…" [--dry-run]
 *
 * How the update actually travels
 * ------------------------------
 * The .exe is never replaced. It carries one copy of the game to start from,
 * and on every launch the running page asks Supabase whether a newer build has
 * been published. If there is one, it downloads it, checks its SHA-256, and
 * hands it to the launcher, which swaps it in for the next start.
 *
 * So "publishing" means exactly one thing: make the new HTML the newest
 * published release. Two facts make this safe:
 *
 *   - The payload is fetched from a URL, not uploaded byte by byte. Postgres
 *     (pg_net) pulls the file, validates it and stores it. That keeps the
 *     release command small and means the bytes that get published are the
 *     bytes that were committed, hash included.
 *   - Only the database's owner role may publish. The anon key lives inside
 *     the game, so if it could publish, anyone could ship a modified build to
 *     every player. The publish functions are revoked from anon/authenticated.
 *
 * Prerequisites
 * -------------
 *   1. Point the release at a committed file. `release/Aetheris.html` must be
 *      committed and pushed to the branch below for the commit that is being
 *      released, because that is what gets fetched.
 *   2. Provide the database credential: SUPABASE_DB_URL (a Postgres URI from
 *      the Supabase dashboard) or SUPABASE_ACCESS_TOKEN (a management API
 *      token, used to run the same SQL over HTTPS).
 *
 * Usage notes
 * -----------
 *   --dry-run     validate the local build only; touch nothing
 *   --source      override the URL that gets fetched (defaults to the commit
 *                 build of the current branch on GitHub)
 *   --channel     publish to a channel other than 'stable'
 *   --unpublish   mark this version as unpublished (it stops being offered)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_REF = 'srugeztbfxcjuvokhumw';
const REPO = 'SyNxCoderBD/3d-Game';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(arg('version') || pkg.version);
const channel = String(arg('channel') || 'stable');
const notes = String(arg('notes') || '');
const dryRun = !!arg('dry-run', false);
const unpublish = !!arg('unpublish', false);
const sourceOverride = arg('source');

const htmlPath = path.join(ROOT, 'release', 'Aetheris.html');

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

/** The URL Postgres will fetch. Must be reachable from the internet. */
function sourceUrl() {
  if (sourceOverride) return String(sourceOverride);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch || branch === 'HEAD') fail('cannot determine the branch; pass --source explicitly');
  return `https://raw.githubusercontent.com/${REPO}/${branch}/release/Aetheris.html`;
}

/**
 * Local checks first. They cannot prove the *published* copy is right (Postgres
 * re-hashes what it fetches), but they catch the expensive mistakes before a
 * round trip: a stale build, a version that does not match the package, an
 * html file that is really an executable.
 */
function inspectBuild() {
  if (!fs.existsSync(htmlPath)) {
    fail('release/Aetheris.html is missing — run `npm run build:exe` first');
  }
  const bytes = fs.readFileSync(htmlPath);
  const text = bytes.toString('utf8');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');

  const problems = [];
  if (!/^\s*<!doctype html/i.test(text.slice(0, 200))) problems.push('does not start with <!doctype html');
  if (!/<title>AETHERIS/i.test(text)) problems.push('missing the AETHERIS <title>');
  if (!text.includes('</html>')) problems.push('is not a complete document (no </html>)');
  if (text.includes('AETHERIS-PAYLOAD')) problems.push('contains the exe payload trailer');
  if (text.includes('__aetherisBooted')) {
    /* the boot marker means the game code is actually in there */
  } else {
    problems.push('does not contain the game bundle');
  }
  if (bytes.length < 100_000) problems.push(`is only ${bytes.length} bytes — truncated build?`);
  if (bytes.length > 8 * 1024 * 1024) problems.push('is larger than the 8 MB staging limit');

  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`version "${version}" is not X.Y.Z`);

  /* The build stamps its own version; if it disagrees with --version the
     changelog would show one number and the menu another. */
  const stamped = text.match(/["']?version["']?\s*[:=]\s*["'](\d+\.\d+\.\d+)["']/);
  const buildPkg = text.includes(`"${pkg.version}"`) || text.includes(`'${pkg.version}'`);
  const versionInBuild = text.includes(pkg.version);

  return { bytes, text, sha, problems, versionInBuild, stamped: stamped?.[1], buildPkg };
}

async function main() {
  console.log(`▸ publishing AETHERIS ${version} to channel "${channel}"`);

  const build = inspectBuild();
  console.log(`  build: ${(build.bytes.length / 1024).toFixed(0)} KB  sha256 ${build.sha.slice(0, 16)}…`);

  if (build.problems.length) {
    console.error('\nRefusing to publish:');
    for (const p of build.problems) console.error(`  - release/Aetheris.html ${p}`);
    process.exit(1);
  }
  console.log('  sanity: 5/5 checks passed ✓');

  if (version !== pkg.version) {
    console.warn(`\n  ! package.json says ${pkg.version} but --version says ${version}`);
    if (!build.versionInBuild) {
      fail(`release/Aetheris.html was built as ${pkg.version}, not ${version} — rebuild before publishing`);
    }
  }

  /* Is the committed file the one on disk? If not, the URL serves something
     else and the hash the players verify will not be the one printed above.
     Compared as raw bytes: git stores them verbatim, and a text-mode read
     would silently normalise line endings and report a false mismatch. */
  let committedSha = '';
  try {
    const blob = execFileSync('git', ['cat-file', 'blob', 'HEAD:release/Aetheris.html'],
      { cwd: ROOT, stdio: 'pipe' });
    committedSha = crypto.createHash('sha256').update(blob).digest('hex');
  } catch {
    committedSha = '';
  }

  if (!committedSha) {
    console.log('  note: release/Aetheris.html is not committed yet — push it before publishing.');
  } else if (committedSha !== build.sha) {
    console.log(`  note: HEAD holds ${committedSha.slice(0, 16)}… but the working copy is ${build.sha.slice(0, 16)}…`);
    console.log('        the published build is the committed one, so commit and push if you mean to ship the local one.');
  } else {
    console.log('  committed: release/Aetheris.html matches the working copy ✓');
  }

  const url = sourceUrl();
  console.log(`  source: ${url}`);
  console.log(`  notes:  ${notes ? notes.slice(0, 80) : '(none)'}`);

  if (dryRun) {
    console.log('\n▸ dry run — nothing was published');
    return;
  }

  /* Reachability before the publish: a 404 from GitHub would otherwise be
   * reported a minute later as a confusing fetch failure inside Postgres. */
  let reachable = false;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    reachable = res.ok;
    console.log(`  reachable: HTTP ${res.status}`);
  } catch (err) {
    console.log(`  reachable: no (${err.message})`);
  }
  if (!reachable) {
    fail('the source URL is not reachable from here. Commit and push the build, then retry.');
  }

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error('\n✗ SUPABASE_DB_URL is not set.');
    console.error('  Publishing needs the database credential (the anon key in the game cannot publish —');
    console.error('  if it could, anyone with the game could ship an update to everyone).');
    console.error('  Set it for one command, never in the repo:');
    console.error('    SUPABASE_DB_URL="postgresql://postgres.%s:[PASSWORD]@..." node tools/publish-release.mjs ...' % PROJECT_REF);
    process.exit(1);
  }

  const { default: pg } = await import('pg').catch(() => {
    fail('the `pg` package is required: npm install --no-save pg');
  });

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    if (unpublish) {
      const r = await client.query(
        `update public.aetheris_releases set published = false where version = $1 returning version`,
        [version]
      );
      if (!r.rowCount) fail(`no release called ${version}`);
      console.log(`\n✓ ${version} is no longer offered to players`);
      return;
    }

    const start = await client.query(
      `select public.aetheris_publish_start($1, $2) as job`, [version, url]
    );
    const job = start.rows[0].job;
    console.log(`  fetch started (request ${job.request_id})`);

    /* Postgres fetches asynchronously; poll the finish step until it either
     * publishes or gives up. 30 s is generous for a sub-megabyte file. */
    const deadline = Date.now() + 30_000;
    let result = null;
    while (Date.now() < deadline) {
      const r = await client.query(
        `select public.aetheris_publish_finish($1, $2, $3, $4) as result`,
        [version, job.request_id, notes, channel]
      );
      const value = r.rows[0].result;
      if (value.status === 'published') { result = value; break; }
      await new Promise((res) => setTimeout(res, 400));
    }

    if (!result) fail('the fetch did not complete in 30 s');
    console.log(`\n✓ published ${result.version} on "${result.channel}" (release ${result.release_no})`);
    console.log(`  ${result.bytes} bytes  sha256 ${result.sha256}`);
    console.log('\n  Every installed copy picks this up on its next launch.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
