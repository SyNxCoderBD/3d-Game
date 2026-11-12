/*
 * AETHERIS portable launcher (Win32, no dependencies).
 *
 * The game itself is a single self-contained HTML file appended to this
 * executable at build time. On launch we unpack it to the user's temp
 * directory and open it in an app-mode window via the Edge/Chrome engine
 * that ships with Windows. Nothing is installed and nothing is written
 * outside %TEMP%.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

#include "localserver.c"
#include <stdio.h>
#include <string.h>

#define MAGIC "AETHERIS-PAYLOAD"
#define MAGIC_LEN 16

typedef struct {
  char magic[MAGIC_LEN];
  unsigned long long size;
} Trailer;

static BOOL file_exists(const wchar_t *path) {
  DWORD a = GetFileAttributesW(path);
  return (a != INVALID_FILE_ATTRIBUTES) && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static BOOL write_all(HANDLE h, const char *buf, DWORD len) {
  DWORD written = 0;
  while (len > 0) {
    if (!WriteFile(h, buf, len, &written, NULL) || written == 0) return FALSE;
    buf += written;
    len -= written;
  }
  return TRUE;
}

static BOOL file_exists_utf8(const char *path) {
  wchar_t wide[1400];
  if (MultiByteToWideChar(CP_UTF8, 0, path, -1, wide, 1400) <= 0) return FALSE;
  return file_exists(wide);
}

/*
 * A newer build is downloaded by the running game (which can speak TLS and has
 * already checked its hash) and written next to index.html as `next.html`.
 * Promote it here, before any browser opens the file.
 *
 * Order matters: index.html is only replaced once next.html is complete, and
 * next.html is only removed once index.html is in place. A power cut at any
 * point leaves either the old build or the new one.
 */
static void promote_staged_build(const wchar_t *gameDir) {
  wchar_t staged[1400], target[1400];
  _snwprintf(staged, 1399, L"%s\\next.html", gameDir); staged[1399] = 0;
  _snwprintf(target, 1399, L"%s\\index.html", gameDir); target[1399] = 0;

  if (!file_exists(staged)) return;

  /* An interrupted download would have been left as next.html.part and never
   * promoted; a next.html that is not a finished document is discarded. */
  HANDLE h = CreateFileW(staged, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                         FILE_ATTRIBUTE_NORMAL, NULL);
  BOOL usable = FALSE;
  if (h != INVALID_HANDLE_VALUE) {
    LARGE_INTEGER sz;
    if (GetFileSizeEx(h, &sz) && sz.QuadPart > 65536) {
      char head[64];
      DWORD got = 0;
      if (ReadFile(h, head, sizeof(head), &got, NULL) && got >= 15) {
        for (DWORD i = 0; i + 14 < got; i++) {
          if (_strnicmp_portable(head + i, "<!doctype html", 14) == 0) { usable = TRUE; break; }
        }
      }
    }
    CloseHandle(h);
  }

  if (!usable) {
    DeleteFileW(staged);
    return;
  }

  if (MoveFileExW(staged, target, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    /* Index is now the new build; the stale marker must not outlive it. */
    wchar_t marker[1400];
    _snwprintf(marker, 1399, L"%s\\next.ver", gameDir); marker[1399] = 0;
    DeleteFileW(marker);
  }
}

/*
 * The build tool appends the payload and then the trailer, so the extracted
 * file ends with 24 bytes of binary after `</html>`. Browsers ignore trailing
 * bytes, but they are not part of the document: trim them so index.html is
 * exactly the build that was hash-checked, and so a later re-read of the file
 * does not have to know about the container format.
 */
static void trim_trailing_trailer(const wchar_t *path) {
  HANDLE h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                         FILE_ATTRIBUTE_NORMAL, NULL);
  if (h == INVALID_HANDLE_VALUE) return;

  LARGE_INTEGER sz;
  if (!GetFileSizeEx(h, &sz) || sz.QuadPart < (LONGLONG)(MAGIC_LEN + 8)) {
    CloseHandle(h);
    return;
  }

  unsigned long long size = (unsigned long long)sz.QuadPart;
  unsigned long long scan = size < 4096 ? size : 4096;
  char tail[4096];
  LARGE_INTEGER seek;
  seek.QuadPart = (LONGLONG)(size - scan);
  if (!SetFilePointerEx(h, seek, NULL, FILE_BEGIN)) { CloseHandle(h); return; }

  DWORD got = 0;
  if (!ReadFile(h, tail, (DWORD)scan, &got, NULL) || got == 0) { CloseHandle(h); return; }

  long last_close = -1;
  for (long i = (long)got - 7; i >= 0; i--) {
    if (_strnicmp_portable(tail + i, "</html>", 7) == 0) { last_close = i; break; }
  }
  if (last_close < 0 || (unsigned long long)last_close + 7 >= size) {
    CloseHandle(h);  /* no trailer, or nothing after it */
    return;
  }

  LARGE_INTEGER cut;
  cut.QuadPart = (LONGLONG)(size - scan + (unsigned long long)last_close + 7);
  if (SetFilePointerEx(h, cut, NULL, FILE_BEGIN) && SetEndOfFile(h)) {
    /* done */
  }
  CloseHandle(h);
}

/* Copy `size` bytes starting at `offset` of `src` into `dstPath`. */
static BOOL extract_payload(HANDLE src, unsigned long long offset,
                            unsigned long long size, const wchar_t *dstPath) {
  LARGE_INTEGER li;
  li.QuadPart = (LONGLONG)offset;
  if (!SetFilePointerEx(src, li, NULL, FILE_BEGIN)) return FALSE;

  HANDLE dst = CreateFileW(dstPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
  if (dst == INVALID_HANDLE_VALUE) return FALSE;

  char buffer[65536];
  BOOL ok = TRUE;
  while (size > 0) {
    DWORD want = (size > sizeof(buffer)) ? (DWORD)sizeof(buffer) : (DWORD)size;
    DWORD got = 0;
    if (!ReadFile(src, buffer, want, &got, NULL) || got == 0) { ok = FALSE; break; }
    if (!write_all(dst, buffer, got)) { ok = FALSE; break; }
    size -= got;
  }
  CloseHandle(dst);
  return ok;
}

static BOOL registry_app_path(const wchar_t *exe, wchar_t *out, DWORD cch) {
  static const HKEY roots[2] = { HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER };
  wchar_t key[512];
  _snwprintf(key, 511, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\%s", exe);
  key[511] = 0;

  for (int i = 0; i < 2; i++) {
    HKEY h = NULL;
    if (RegOpenKeyExW(roots[i], key, 0, KEY_READ, &h) == ERROR_SUCCESS) {
      DWORD type = 0, size = cch * sizeof(wchar_t);
      LONG r = RegQueryValueExW(h, NULL, NULL, &type, (LPBYTE)out, &size);
      RegCloseKey(h);
      if (r == ERROR_SUCCESS && type == REG_SZ && file_exists(out)) return TRUE;
    }
  }
  return FALSE;
}

static BOOL find_browser(wchar_t *out, DWORD cch) {
  static const wchar_t *names[] = { L"msedge.exe", L"chrome.exe", L"brave.exe", L"vivaldi.exe" };
  for (int i = 0; i < 4; i++) {
    if (registry_app_path(names[i], out, cch)) return TRUE;
  }

  static const wchar_t *relative[] = {
    L"\\Microsoft\\Edge\\Application\\msedge.exe",
    L"\\Google\\Chrome\\Application\\chrome.exe",
    L"\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    L"\\Microsoft\\Edge Beta\\Application\\msedge.exe",
    L"\\Chromium\\Application\\chrome.exe",
  };

  wchar_t base[512];
  const wchar_t *vars[] = { L"ProgramFiles(x86)", L"ProgramFiles", L"LOCALAPPDATA" };
  for (int v = 0; v < 3; v++) {
    DWORD n = GetEnvironmentVariableW(vars[v], base, 512);
    if (n == 0 || n >= 512) continue;
    for (int r = 0; r < 5; r++) {
      _snwprintf(out, cch - 1, L"%s%s", base, relative[r]);
      out[cch - 1] = 0;
      if (file_exists(out)) return TRUE;
    }
  }
  return FALSE;
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmdLine, int nShow) {
  (void)hInst; (void)hPrev; (void)lpCmdLine; (void)nShow;

  wchar_t exePath[1024];
  DWORD len = GetModuleFileNameW(NULL, exePath, 1024);
  if (len == 0 || len >= 1024) {
    MessageBoxW(NULL, L"Could not resolve the executable path.", L"AETHERIS", MB_ICONERROR);
    return 1;
  }

  HANDLE src = CreateFileW(exePath, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (src == INVALID_HANDLE_VALUE) {
    MessageBoxW(NULL, L"Could not open the game data.", L"AETHERIS", MB_ICONERROR);
    return 1;
  }

  LARGE_INTEGER fileSize;
  if (!GetFileSizeEx(src, &fileSize) || fileSize.QuadPart <= (LONGLONG)sizeof(Trailer)) {
    CloseHandle(src);
    MessageBoxW(NULL, L"The game data is missing from this file.", L"AETHERIS", MB_ICONERROR);
    return 1;
  }

  Trailer trailer;
  LARGE_INTEGER seek;
  seek.QuadPart = fileSize.QuadPart - (LONGLONG)sizeof(Trailer);
  SetFilePointerEx(src, seek, NULL, FILE_BEGIN);
  DWORD got = 0;
  if (!ReadFile(src, &trailer, sizeof(Trailer), &got, NULL) || got != sizeof(Trailer) ||
      memcmp(trailer.magic, MAGIC, MAGIC_LEN) != 0) {
    CloseHandle(src);
    MessageBoxW(NULL,
      L"This executable is damaged (no game payload found).\n"
      L"Please re-download AETHERIS.",
      L"AETHERIS", MB_ICONERROR);
    return 1;
  }

  unsigned long long payloadOffset =
      (unsigned long long)fileSize.QuadPart - sizeof(Trailer) - trailer.size;

  wchar_t tempPath[1024];
  if (GetTempPathW(1024, tempPath) == 0) lstrcpyW(tempPath, L".\\");

  wchar_t gameDir[1200];
  _snwprintf(gameDir, 1199, L"%sAetherisIsle", tempPath);
  gameDir[1199] = 0;
  CreateDirectoryW(gameDir, NULL);

  wchar_t htmlPath[1400];
  _snwprintf(htmlPath, 1399, L"%s\\index.html", gameDir);
  htmlPath[1399] = 0;

  /* A build staged by the last session becomes the build this session runs. */
  promote_staged_build(gameDir);

  if (!file_exists(htmlPath) && !extract_payload(src, payloadOffset, trailer.size, htmlPath)) {
    CloseHandle(src);
    MessageBoxW(NULL, L"Could not unpack the game to the temp folder.", L"AETHERIS", MB_ICONERROR);
    return 1;
  }
  CloseHandle(src);

  trim_trailing_trailer(htmlPath);

  wchar_t profileDir[1400];
  _snwprintf(profileDir, 1399, L"%s\\profile", gameDir);
  profileDir[1399] = 0;
  CreateDirectoryW(profileDir, NULL);

  /*
   * Serve the payload over http://127.0.0.1:<port>/ rather than opening it as
   * file:///. A file:// page has an opaque (null) origin: CORS requests to
   * Supabase would arrive as "Origin: null" and the realtime WebSocket has to
   * be accepted for a null origin too. Both work in Chrome today, but both are
   * browser policy rather than something this program controls, and online
   * multiplayer depends on them. Serving over loopback makes the game a
   * first-class http origin with no special-casing.
   *
   * If the server cannot start for any reason we still play: the file:// path
   * below is kept as a fallback so a single-player game always works.
   */
  wchar_t htmlPathA[1400];
  _snwprintf(htmlPathA, 1399, L"%s", htmlPath);
  htmlPathA[1399] = 0;

  char htmlPathUtf8[1400];
  int haveUtf8 = WideCharToMultiByte(CP_UTF8, 0, htmlPathA, -1,
                                     htmlPathUtf8, sizeof(htmlPathUtf8), NULL, NULL) > 0;

  /* The game posts verified newer builds here; the next start promotes them. */
  wchar_t stagedPath[1400];
  _snwprintf(stagedPath, 1399, L"%s\\next.html", gameDir); stagedPath[1399] = 0;
  char stagedPathUtf8[1400];
  int haveStagedUtf8 = WideCharToMultiByte(CP_UTF8, 0, stagedPath, -1,
                                           stagedPathUtf8, sizeof(stagedPathUtf8), NULL, NULL) > 0;

  local_server server;
  int served = haveUtf8 && srv_start_ex(&server, htmlPathUtf8,
                                        haveStagedUtf8 ? stagedPathUtf8 : NULL);

  wchar_t url[1500];
  if (served) {
    _snwprintf(url, 1499, L"http://127.0.0.1:%d/", server.port);
    url[1499] = 0;
  } else {
    /* Windows path -> file:/// URL */
    lstrcpyW(url, L"file:///");
    size_t urlLen = 8;
    for (size_t i = 0; htmlPath[i] && urlLen < 1490; i++) {
      url[urlLen++] = (htmlPath[i] == L'\\') ? L'/' : htmlPath[i];
    }
    url[urlLen] = 0;
  }

  wchar_t browser[1024];
  if (find_browser(browser, 1024)) {
    wchar_t cmd[6000];
    _snwprintf(cmd, 5999,
      L"\"%s\" --app=\"%s\" --user-data-dir=\"%s\" "
      L"--window-size=1680,945 --start-maximized "
      L"--no-first-run --no-default-browser-check --no-service-autorun "
      L"--disable-features=TranslateUI,MediaRouter,OptimizationHints "
      L"--allow-file-access-from-files --autoplay-policy=no-user-gesture-required "
      L"--disable-background-networking --disable-component-update",
      browser, url, profileDir);
    cmd[5999] = 0;

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (CreateProcessW(browser, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
      /*
       * Do NOT stop the server when the spawned process exits.
       *
       * Chromium browsers use a process singleton: the chrome.exe this program
       * starts frequently forwards the request to an already-running browser
       * instance and exits immediately. Waiting on that handle and then calling
       * srv_stop() therefore closed the listening socket while the actual
       * browser window was still opening, and the window landed on a dead port:
       * ERR_CONNECTION_REFUSED at 127.0.0.1:<port>. It looked intermittent
       * because it depended on whether the spawned process survived.
       *
       * The window is gone when there is nothing left reading the page, so the
       * server stays up while anyone is polling it and shuts down a few seconds
       * after the last request. That covers both the forwarded and the direct
       * case, and it cleans up when the player closes the game.
       */
      CloseHandle(pi.hProcess);
      CloseHandle(pi.hThread);
      if (served) {
        srv_wait_for_idle(&server, SRV_IDLE_SHUTDOWN_MS, SRV_MAX_UPTIME_MS);
        srv_stop(&server);
      }
      return 0;
    }
    /* The browser refused to start: release the port before trying the shell. */
    if (served) srv_stop(&server);
  }

  /* No Chromium-family browser found: hand the file to the shell. */
  HINSTANCE r = ShellExecuteW(NULL, L"open", htmlPath, NULL, NULL, SW_SHOWNORMAL);
  if ((INT_PTR)r <= 32) {
    MessageBoxW(NULL,
      L"AETHERIS needs Microsoft Edge (or another Chromium browser) to render.\n"
      L"Edge is included with Windows 10 and 11 — please install it and try again.",
      L"AETHERIS", MB_ICONERROR);
    return 1;
  }
  return 0;
}
