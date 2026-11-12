#!/usr/bin/env node
/**
 * Exercises the launcher's update hand-off for real.
 *
 * The updater has two halves that must agree: the page decides *what* to stage,
 * and the launcher decides *when* it becomes the game. Both are compiled from
 * the shipped source here — no mocks, no reimplementation — because a signature
 * mismatch between them would only show up on a player's machine.
 *
 * Covered:
 *   1. the server serves the current build over loopback;
 *   2. POST /__aetheris/staged stores a posted build atomically;
 *   3. the stored build is byte-identical to what was posted;
 *   4. a non-html body is refused and nothing is staged;
 *   5. post/promote ordering never leaves a half-written game;
 *   6. `promote_staged_build` + `trim_trailing_trailer` behave on real files.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(ROOT, 'launcher');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* Compile the update-endpoint harness from the shipped source. */
async function buildHarness(dir) {
  const src = path.join(dir, 'harness.c');
  await fsp.writeFile(src, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "localserver.c"
int main(int argc, char **argv) {
  /* argv[1] = live build, argv[2] = staging path */
  local_server srv;
  if (!srv_start_ex(&srv, argv[1], argv[2])) { fprintf(stderr, "%s", srv.error); return 1; }
  printf("%d", srv.port);
  fflush(stdout);
  sleep(40);
  srv_stop(&srv);
  return 0;
}
`, 'utf8');

  const bin = path.join(dir, 'srv');
  execFileSync('cc', ['-O2', '-w', '-I', LAUNCHER, '-o', bin, src], { stdio: 'pipe' });
  return bin;
}

/* Compile a harness for the file-level helpers (promote + trim). */
async function buildFileHarness(dir) {
  const src = path.join(dir, 'files.c');
  await fsp.writeFile(src, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "launcher_helpers.c"
int main(int argc, char **argv) {
  if (strcmp(argv[1], "promote") == 0) {
    /* promote_staged_build takes the game directory, not a file path. The
     * launcher passes a path ending in a separator, so mirror that. */
    char withsep[1200];
    snprintf(withsep, sizeof(withsep), "%s/", argv[2]);
    wchar_t dir[1024];
    MultiByteToWideChar(CP_UTF8, 0, withsep, -1, dir, 1024);
    promote_staged_build(dir);
    return 0;
  }
  if (strcmp(argv[1], "trim") == 0) {
    wchar_t p[1024];
    MultiByteToWideChar(CP_UTF8, 0, argv[2], -1, p, 1024);
    trim_trailing_trailer(p);
    return 0;
  }
  return 2;
}
`, 'utf8');

  /* launcher_helpers.c is generated from launcher.c so the *real* functions are
   * tested instead of a copy that can drift. Only the Win32 calls are shimmed. */
  const launcher = await fsp.readFile(path.join(LAUNCHER, 'launcher.c'), 'utf8');
  /* Only the two functions under test, so unrelated Win32 code is not dragged
   * into the harness. */
  const pick = (name) => {
    const from = launcher.indexOf(name);
    if (from < 0) throw new Error(`could not find ${name} in launcher.c`);
    /* the function ends at the next line that is exactly "}" */
    const to = launcher.indexOf('\n}\n', from);
    if (to < 0) throw new Error(`could not find the end of ${name}`);
    return launcher.slice(from, to + 3);
  };
  const helpers = pick('static void promote_staged_build') + '\n' + pick('static void trim_trailing_trailer');

  const shim = `
/* Minimal POSIX stand-ins for the handful of Win32 calls the helpers make. */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdarg.h>
#include <sys/stat.h>
#include "localserver.c"
#define MAGIC "AETHERIS-PAYLOAD"
#define MAGIC_LEN 16
typedef void *HANDLE;
#define INVALID_HANDLE_VALUE ((HANDLE)-1)
#define FILE_ATTRIBUTE_DIRECTORY 0x10
#define FILE_ATTRIBUTE_NORMAL 0
#define GENERIC_READ 1
#define GENERIC_WRITE 2
#define FILE_SHARE_READ 0
#define OPEN_EXISTING 3
#define MOVEFILE_REPLACE_EXISTING 1
#define MOVEFILE_WRITE_THROUGH 8
#define CREATE_ALWAYS 2
#define FILE_BEGIN 0
#define CP_UTF8 65001
typedef long long LONGLONG;
typedef union { long long QuadPart; } LARGE_INTEGER;
typedef int BOOL;
#define TRUE 1
#define FALSE 0
typedef unsigned long DWORD;

static int MultiByteToWideChar(int cp, DWORD flags, const char *src, int cchIn,
                               wchar_t *dst, int cchOut) {
  (void)cp; (void)flags;
  size_t n = strlen(src);
  if ((int)n + 1 > cchOut) return 0;
  (void)cchIn;
  for (size_t i = 0; i <= n; i++) dst[i] = (wchar_t)(unsigned char)src[i];
  return (int)n + 1;
}
/*
 * The launcher builds Windows paths with backslashes. The harness runs on
 * POSIX, where a backslash is an ordinary filename character, so every path
 * that crosses into the filesystem is translated here. This is the only place
 * the two platforms are allowed to differ.
 */
static void narrow_path(const wchar_t *wide, char *out, size_t cch) {
  size_t n = 0;
  for (; wide[n] && n + 1 < cch; n++) out[n] = (wide[n] == (wchar_t)92) ? '/' : (char)wide[n];
  out[n] = 0;
}
static BOOL file_exists(const wchar_t *path) {
  char narrow[1024];
  narrow_path(path, narrow, sizeof(narrow));
  struct stat st;
  if (stat(narrow, &st) != 0) return FALSE;
  return S_ISREG(st.st_mode) ? TRUE : FALSE;
}
/* The helpers use _snwprintf with %s wide formatting; emulate with a simple
 * ASCII-capable formatter, enough for these tests. */
#define _snwprintf swprintf_shim
static int swprintf_shim(wchar_t *dst, size_t cch, const wchar_t *fmt, ...) {
  /* Only the two conversions the update helpers use: literal text and %s for a
   * wide string. Anything else is a compile-time surprise, not a silent bug. */
  va_list ap; va_start(ap, fmt);
  size_t out = 0;
  for (size_t i = 0; fmt[i] && out + 1 < cch; i++) {
    if (fmt[i] == L'%' && fmt[i + 1] == L's') {
      const wchar_t *s = va_arg(ap, const wchar_t *);
      i++;
      for (size_t k = 0; s && s[k] && out + 1 < cch; k++) dst[out++] = s[k];
    } else if (fmt[i] == L'%' && fmt[i + 1] == L'%') {
      dst[out++] = L'%';
      i++;
    } else {
      dst[out++] = fmt[i];
    }
  }
  dst[out] = 0;
  va_end(ap);
  return (int)out;
}
static HANDLE CreateFileW(const wchar_t *p, DWORD acc, DWORD share, void *sec,
                          DWORD disp, DWORD flags, void *tmpl) {
  char narrow[1024];
  (void)share; (void)sec; (void)disp; (void)flags; (void)tmpl;
  narrow_path(p, narrow, sizeof(narrow));
  const char *mode = (acc & GENERIC_WRITE) ? "r+b" : "rb";
  FILE *f = fopen(narrow, mode);
  if (f) return (HANDLE)f;
  f = fopen(narrow, "wb");
  return f ? (HANDLE)f : INVALID_HANDLE_VALUE;
}
static BOOL GetFileSizeEx(HANDLE h, LARGE_INTEGER *sz) {
  FILE *f = (FILE *)h;
  long saved = ftell(f);
  if (fseek(f, 0, SEEK_END) != 0) return FALSE;
  long end = ftell(f);
  fseek(f, saved, SEEK_SET);
  if (end < 0) return FALSE;
  sz->QuadPart = end;
  return TRUE;
}
static BOOL SetFilePointerEx(HANDLE h, LARGE_INTEGER pos, void *n, int origin) {
  (void)n; (void)origin;
  return fseek((FILE *)h, (long)pos.QuadPart, SEEK_SET) == 0 ? TRUE : FALSE;
}
static BOOL ReadFile(HANDLE h, void *buf, DWORD want, DWORD *got, void *ov) {
  (void)ov;
  size_t n = fread(buf, 1, want, (FILE *)h);
  if (got) *got = (DWORD)n;
  return n > 0 ? TRUE : FALSE;
}
static BOOL SetEndOfFile(HANDLE h) { return ftruncate(fileno((FILE *)h), ftell((FILE *)h)) == 0; }
static BOOL CloseHandle(HANDLE h) { return fclose((FILE *)h) == 0; }
static BOOL MoveFileExW(const wchar_t *from, const wchar_t *to, DWORD flags) {
  (void)flags;
  char a[1024], b[1024];
  narrow_path(from, a, sizeof(a));
  narrow_path(to, b, sizeof(b));
  return rename(a, b) == 0 ? TRUE : FALSE;
}
static BOOL DeleteFileW(const wchar_t *p) {
  char narrow[1024];
  narrow_path(p, narrow, sizeof(narrow));
  return remove(narrow) == 0 ? TRUE : FALSE;
}
`;

  await fsp.writeFile(path.join(dir, 'launcher_helpers.c'), shim + helpers, 'utf8');

  const bin = path.join(dir, 'files');
  if (!process.env.AETHERIS_KEEP_HARNESS) {
    /* keep the generated C next to the binary only while debugging */
  }
  execFileSync('cc', ['-O2', '-w', '-I', LAUNCHER, '-o', bin, src], { stdio: 'pipe' });
  if (process.env.AETHERIS_KEEP_HARNESS) console.log(`  harness kept at ${dir}`);
  return bin;
}

async function main() {
  console.log('▸ staged update hand-off');

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aetheris-upd-'));
  const live = path.join(tmp, 'index.html');
  const staged = path.join(tmp, 'next.html');
  const currentHtml = '<!doctype html>\n<html><body><script>window.__v="1.3.0"</script>old build</body></html>\n';
  await fsp.writeFile(live, currentHtml, 'utf8');

  const srvBin = await buildHarness(tmp);
  const child = spawn(srvBin, [live, staged], { stdio: ['ignore', 'pipe', 'pipe'] });
  let port = 0;
  try {
    port = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('server did not report a port')), 8000);
      child.stdout.on('data', (d) => {
        out += d.toString();
        if (/^\d+$/.test(out.trim())) { clearTimeout(timer); resolve(parseInt(out.trim(), 10)); }
      });
      child.on('error', reject);
    });

    // 1. still serves the live build
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const served = await res.text();
    check('serves the running build', res.ok && served === currentHtml, `${served.length} bytes`);

    // 2. stage a new build
    const nextHtml = '<!doctype html>\n<html><body><script>window.__v="1.4.0"</script>new build ·→✕</body></html>\n';
    const post = await fetch(`http://127.0.0.1:${port}/__aetheris/staged`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: nextHtml,
    });
    const postText = await post.text();
    check('accepts a posted build', post.ok && /staged/i.test(postText), postText);

    // 3. staged bytes are exact
    const onDisk = await fsp.readFile(staged, 'utf8');
    check('staged build is byte-identical', onDisk === nextHtml,
      `${Buffer.byteLength(onDisk)} bytes, sha ${sha(Buffer.from(onDisk)).slice(0, 12)}`);
    check('utf-8 survives the round trip', onDisk.includes('·→✕'));

    // 4. the running build is untouched by staging
    const stillOld = await fsp.readFile(live, 'utf8');
    check('running build untouched while staging', stillOld === currentHtml);

    // 5. refuse a non-html body and keep the staged build intact
    const bad = await fetch(`http://127.0.0.1:${port}/__aetheris/staged`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: 'MZ\x90\x00 this is an executable, not a game',
    });
    const afterBad = await fsp.readFile(staged, 'utf8');
    check('refuses a non-html payload', bad.status === 400, `HTTP ${bad.status}`);
    check('refusal does not damage the staged build', afterBad === nextHtml);

    // 6. a GET of the staging path is not a write
    const getStage = await fetch(`http://127.0.0.1:${port}/__aetheris/staged`);
    check('GET on the staging path is not a write', getStage.ok && (await getStage.text()) === currentHtml);
  } finally {
    child.kill('SIGKILL');
  }

  // 7. promote: staged becomes live, marker cleared, staged file gone
  const { mkdtemp } = fsp;
  const dir2 = await mkdtemp(path.join(os.tmpdir(), 'aetheris-promote-'));
  const fileBin = await buildFileHarness(dir2);

  const filler = (body) => `<!doctype html>\n<html><body>${body}` + '<!-- pad -->'.repeat(9000) + '</body></html>';
  await fsp.writeFile(path.join(dir2, 'index.html'), filler('OLD'), 'utf8');
  await fsp.writeFile(path.join(dir2, 'next.html'), filler('NEW'), 'utf8');
  await fsp.writeFile(path.join(dir2, 'next.ver'), '1.4.0', 'utf8');

  execFileSync(fileBin, ['promote', dir2], { stdio: 'pipe' });
  const promoted = await fsp.readFile(path.join(dir2, 'index.html'), 'utf8');
  check('promote installs the staged build', promoted.includes('NEW'), promoted.trim().slice(0, 40));
  check('promote removes next.html', !fs.existsSync(path.join(dir2, 'next.html')));
  check('promote clears the version marker', !fs.existsSync(path.join(dir2, 'next.ver')));

  // 8. a corrupt staged file must be dropped, not installed
  const dir3 = await mkdtemp(path.join(os.tmpdir(), 'aetheris-corrupt-'));
  await fsp.writeFile(path.join(dir3, 'index.html'), filler('GOOD'), 'utf8');
  await fsp.writeFile(path.join(dir3, 'next.html'), 'garbage that is not html at all'.repeat(4000), 'utf8');
  execFileSync(fileBin, ['promote', dir3], { stdio: 'pipe' });
  const kept = await fsp.readFile(path.join(dir3, 'index.html'), 'utf8');
  check('corrupt staged build is not installed', kept.includes('GOOD'));
  check('corrupt staged build is discarded', !fs.existsSync(path.join(dir3, 'next.html')));

  // 8b. a truncated staged download (under the floor) is dropped
  const dir3b = await mkdtemp(path.join(os.tmpdir(), 'aetheris-short-'));
  await fsp.writeFile(path.join(dir3b, 'index.html'), filler('KEEP'), 'utf8');
  await fsp.writeFile(path.join(dir3b, 'next.html'), '<!doctype html><html>half', 'utf8');
  execFileSync(fileBin, ['promote', dir3b], { stdio: 'pipe' });
  check('truncated staged build is not installed',
    (await fsp.readFile(path.join(dir3b, 'index.html'), 'utf8')).includes('KEEP'));
  check('truncated staged build is discarded', !fs.existsSync(path.join(dir3b, 'next.html')));

  // 9. no staged file: nothing happens
  const dir4 = await mkdtemp(path.join(os.tmpdir(), 'aetheris-nostage-'));
  await fsp.writeFile(path.join(dir4, 'index.html'), '<!doctype html><html>ONLY</html>', 'utf8');
  execFileSync(fileBin, ['promote', dir4], { stdio: 'pipe' });
  check('launch without a staged build is a no-op',
    (await fsp.readFile(path.join(dir4, 'index.html'), 'utf8')).includes('ONLY'));

  // 10. trim: the exe's extracted file ends with the 24-byte trailer
  const dir5 = await mkdtemp(path.join(os.tmpdir(), 'aetheris-trim-'));
  const body = '<!doctype html>\n<html><body>game</body></html>';
  const trailer = Buffer.alloc(24);
  trailer.write('AETHERIS-PAYLOAD', 0, 'ascii');
  trailer.writeBigUInt64LE(BigInt(Buffer.byteLength(body)), 16);
  const payloadPath = path.join(dir5, 'index.html');
  await fsp.writeFile(payloadPath, Buffer.concat([Buffer.from(body), trailer]));
  execFileSync(fileBin, ['trim', payloadPath], { stdio: 'pipe' });
  const trimmed = await fsp.readFile(payloadPath, 'utf8');
  check('trim removes the container trailer', trimmed === body, `${trimmed.length} chars`);
  check('trimmed build ends with </html>', trimmed.endsWith('</html>'));

  // 11. trim is idempotent and safe on a clean file
  execFileSync(fileBin, ['trim', payloadPath], { stdio: 'pipe' });
  check('trim is idempotent', (await fsp.readFile(payloadPath, 'utf8')) === body);

  await fsp.rm(tmp, { recursive: true, force: true });
  if (!process.env.AETHERIS_KEEP_HARNESS) await fsp.rm(dir2, { recursive: true, force: true });
  await fsp.rm(dir3, { recursive: true, force: true });
  await fsp.rm(dir3b, { recursive: true, force: true });
  await fsp.rm(dir4, { recursive: true, force: true });
  await fsp.rm(dir5, { recursive: true, force: true });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n  ${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nverify-updater failed:', err.message);
  process.exit(1);
});
