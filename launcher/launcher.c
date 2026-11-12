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

  if (!extract_payload(src, payloadOffset, trailer.size, htmlPath)) {
    CloseHandle(src);
    MessageBoxW(NULL, L"Could not unpack the game to the temp folder.", L"AETHERIS", MB_ICONERROR);
    return 1;
  }
  CloseHandle(src);

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

  local_server server;
  int served = haveUtf8 && srv_start(&server, htmlPathUtf8);

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
      WaitForSingleObject(pi.hProcess, INFINITE);
      CloseHandle(pi.hProcess);
      CloseHandle(pi.hThread);
      if (served) srv_stop(&server);
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
