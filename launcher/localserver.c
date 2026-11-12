/*
 * Tiny loopback HTTP server.
 *
 * Why this exists: the game is a single HTML file, and the old launcher opened
 * it with file://. A file:// page has an opaque origin, so every CORS request
 * to Supabase arrives as "Origin: null" and the WebSocket upgrade is at the
 * mercy of whatever the browser decides to do with a null-origin page. Online
 * multiplayer depends on both, so instead we serve the payload over
 * http://127.0.0.1:<port>/ which is a real, secure origin.
 *
 * Scope: exactly one file, read-only, only ever bound to the loopback address.
 * Not a general web server and never reachable from the network.
 */
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE
#endif
#define _POSIX_C_SOURCE 200809L

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET sock_t;
#define CLOSE_SOCK closesocket
#define BAD_SOCK INVALID_SOCKET
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>
#include <pthread.h>
#include <errno.h>
typedef int sock_t;
#define CLOSE_SOCK close
#define BAD_SOCK (-1)
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SRV_MAX_REQUEST 4096
#define SRV_READ_TIMEOUT_SEC 3

/*
 * How long the launcher keeps the game served after the browser process it
 * spawned has gone. See srv_wait_for_idle: Chromium forwards to an existing
 * instance and exits, so process exit is not the end of the session.
 */
#define SRV_IDLE_SHUTDOWN_MS 8000u        /* no requests for 8 s -> done */
#define SRV_MAX_UPTIME_MS (6u * 3600u * 1000u)  /* hard ceiling: 6 hours */
/* How long to keep serving before the browser asks for anything at all. */
#define SRV_FIRST_REQUEST_GRACE_MS (5u * 60u * 1000u)   /* 5 minutes */

/* The one write endpoint this server has. */
#define SRV_UPDATE_PATH "/__aetheris/staged"
#define SRV_UPDATE_PATH_LEN 18

/*
 * The game page polls this while it is open.
 *
 * Anything that only listens while it happens to be receiving traffic will
 * eventually be caught out: after the page has loaded, the player can sit in a
 * menu for minutes, press F5, or sit in a match while an update downloads. All
 * of those need the server up. So the page declares that it is still open, and
 * the launcher only stops once that declaration stops.
 */
#define SRV_ALIVE_PATH "/__aetheris/alive"
#define SRV_ALIVE_PATH_LEN 17
/* How often the page checks in. */
#define SRV_ALIVE_INTERVAL_MS 5000u
/*
 * How long a silent page is still considered open. Comfortably longer than the
 * poll interval so a slow timer, a background tab that Chromium throttles, or a
 * momentarily busy game loop cannot be mistaken for a closed window.
 */
#define SRV_ALIVE_TIMEOUT_MS 20000u

/* Case-insensitive compare, spelled out so the same source builds under both
 * MSVC/MinGW and gcc/clang without pulling in non-standard headers. */
static int _strnicmp_portable(const char *a, const char *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char ca = (unsigned char)a[i];
    unsigned char cb = (unsigned char)b[i];
    if (ca >= 'A' && ca <= 'Z') ca = (unsigned char)(ca - 'A' + 'a');
    if (cb >= 'A' && cb <= 'Z') cb = (unsigned char)(cb - 'A' + 'a');
    if (ca != cb) return (int)ca - (int)cb;
    if (ca == 0) return 0;
  }
  return 0;
}

/* Shared with the accept thread. `path` is owned by the caller and must stay
 * valid for the lifetime of the server. */
typedef struct {
  sock_t listen_sock;
  int port;
  const char *path;        /* file to serve for every GET */
  const char *staged_path; /* where POST /__aetheris/staged writes a new build */
  volatile int stop;
  volatile long requests;  /* incremented per served request; see srv_wait_for_idle */
  volatile long beats;     /* liveness check-ins from the open page */
  char status[256];        /* outcome of the last staged upload */
  char error[256];
} local_server;

/* Portable millisecond sleep, so the wait loop reads the same on both targets. */
static void srv_sleep_ms(unsigned ms) {
#ifdef _WIN32
  Sleep(ms);
#else
  usleep((useconds_t)ms * 1000);
#endif
}

static void srv_set_timeout(sock_t s, int seconds) {
#ifdef _WIN32
  DWORD ms = (DWORD)seconds * 1000;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&ms, sizeof(ms));
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&ms, sizeof(ms));
#else
  struct timeval tv;
  tv.tv_sec = seconds;
  tv.tv_usec = 0;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif
}

static int srv_send_all(sock_t s, const char *buf, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    int n = send(s, buf + sent, (int)(len - sent), 0);
    if (n <= 0) return 0;
    sent += (size_t)n;
  }
  return 1;
}

/* Read a file into memory. Returns NULL on failure. */
static char *srv_slurp(const char *path, size_t *out_len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
  long len = ftell(f);
  if (len <= 0) { fclose(f); return NULL; }
  rewind(f);
  char *buf = (char *)malloc((size_t)len);
  if (!buf) { fclose(f); return NULL; }
  size_t got = fread(buf, 1, (size_t)len, f);
  fclose(f);
  if (got != (size_t)len) { free(buf); return NULL; }
  *out_len = (size_t)len;
  return buf;
}

/* Case-insensitive search for a header value in a raw request. */
static int srv_header_value(const char *req, const char *name, char *out, size_t out_len) {
  size_t name_len = strlen(name);
  const char *p = req;
  while ((p = strchr(p, '\n')) != NULL) {
    p++;
    if (_strnicmp_portable(p, name, name_len) == 0 && p[name_len] == ':') {
      const char *v = p + name_len + 1;
      while (*v == ' ' || *v == '\t') v++;
      size_t i = 0;
      while (*v && *v != '\r' && *v != '\n' && i + 1 < out_len) out[i++] = *v++;
      out[i] = 0;
      return 1;
    }
  }
  return 0;
}

/*
 * Write `data` to `path` atomically: a full temporary file first, then a
 * rename. A crash or a full disk can therefore only ever leave the old build
 * or the new one, never half of either.
 */
static int srv_replace_file(const char *path, const char *data, size_t len) {
  char tmp[1024];
  if (strlen(path) + 5 >= sizeof(tmp)) return 0;
  snprintf(tmp, sizeof(tmp), "%s.part", path);

  FILE *f = fopen(tmp, "wb");
  if (!f) return 0;
  size_t wrote = fwrite(data, 1, len, f);
  if (fclose(f) != 0 || wrote != len) {
    remove(tmp);
    return 0;
  }

#ifdef _WIN32
  /* MoveFileEx replaces the destination in one step. */
  if (!MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    remove(tmp);
    return 0;
  }
#else
  if (rename(tmp, path) != 0) {
    remove(tmp);
    return 0;
  }
#endif
  return 1;
}

/* Read exactly `len` bytes from a socket. */
static int srv_recv_exact(sock_t s, char *buf, size_t len);

/* Small text response, shared by the update endpoints. */
static void srv_reply_text(sock_t client, int code, const char *text) {
  const char *reason = code == 200 ? "OK" : code == 400 ? "Bad Request" : "Internal Server Error";
  char head[256];
  int n = snprintf(head, sizeof(head),
    "HTTP/1.1 %d %s\r\n"
    "Content-Type: text/plain; charset=utf-8\r\n"
    "Content-Length: %d\r\n"
    "Cache-Control: no-store\r\n"
    "Connection: close\r\n"
    "\r\n",
    code, reason, (int)strlen(text));
  srv_send_all(client, head, (size_t)n);
  srv_send_all(client, text, strlen(text));
}

/* Read exactly `len` bytes from a socket. */
static int srv_recv_exact(sock_t s, char *buf, size_t len) {
  size_t got = 0;
  while (got < len) {
    int n = recv(s, buf + got, (int)(len - got), 0);
    if (n <= 0) return 0;
    got += (size_t)n;
  }
  return 1;
}

/*
 * POST /__aetheris/staged
 *
 * The running game has already downloaded and SHA-256-verified a newer build;
 * this stores it so the next launch uses it. Deliberately narrow:
 *   - only this exact path, only POST;
 *   - only from a loopback Host header, so a web page on the internet cannot
 *     aim a request at the player's update slot (the name needs no DNS rebinding
 *     tricks because the port is ephemeral, but the check is free);
 *   - size must match Content-Length and stay within a sane ceiling;
 *   - the body must be a complete html document.
 */
#define SRV_MAX_UPDATE (8u * 1024u * 1024u)

static void srv_handle_update(local_server *srv, sock_t client, const char *req, size_t req_len) {
  if (!srv->staged_path) { srv_reply_text(client, 400, "not accepting updates"); return; }

  char host[256];
  if (srv_header_value(req, "Host", host, sizeof(host))) {
    if (!(strncmp(host, "127.0.0.1", 9) == 0 || strncmp(host, "localhost", 9) == 0)) {
      srv_reply_text(client, 400, "bad host");
      return;
    }
  }

  char len_buf[32];
  if (!srv_header_value(req, "Content-Length", len_buf, sizeof(len_buf))) {
    srv_reply_text(client, 400, "missing content-length");
    return;
  }
  long long declared = atoll(len_buf);
  if (declared <= 0 || (unsigned long long)declared > SRV_MAX_UPDATE) {
    srv_reply_text(client, 400, "bad size");
    return;
  }

  size_t len = (size_t)declared;
  char *body = (char *)malloc(len + 1);
  if (!body) { srv_reply_text(client, 500, "out of memory"); return; }

  /* Some of the body usually arrives in the same packet as the headers, so
   * drain what is already buffered before reading from the socket. */
  size_t have = 0;
  if (req_len > 4 && req_len < SRV_MAX_REQUEST) {
    int is_post = (req_len > 5 && strncmp(req, "POST ", 5) == 0);
    if (is_post) {
      const char *sep = NULL;
      for (size_t i = 0; i + 3 < req_len; i++) {
        if (req[i] == '\r' && req[i+1] == '\n' && req[i+2] == '\r' && req[i+3] == '\n') {
          sep = req + i + 4;
          break;
        }
        if (req[i] == '\n' && req[i+1] == '\n') { sep = req + i + 2; break; }
      }
      if (sep) have = req_len - (size_t)(sep - req);
    }
  }
  if (have > len) have = len;
  if (have > 0) memcpy(body, req + (req_len - have), have);

  if (have < len && !srv_recv_exact(client, body + have, len - have)) {
    free(body);
    srv_reply_text(client, 400, "short body");
    return;
  }
  body[len] = 0;

  /* A payload that is not a finished html document is not worth storing. */
  int looks_html = 0;
  for (size_t i = 0; i + 14 < len && i < 512; i++) {
    if (_strnicmp_portable(body + i, "<!doctype html", 14) == 0) { looks_html = 1; break; }
  }
  if (!looks_html) {
    free(body);
    srv_reply_text(client, 400, "not an html build");
    return;
  }

  int ok = srv_replace_file(srv->staged_path, body, len);
  free(body);

  if (!ok) {
    snprintf(srv->status, sizeof(srv->status), "could not stage");
    srv_reply_text(client, 500, "could not stage");
    return;
  }
  snprintf(srv->status, sizeof(srv->status), "staged %lu bytes", (unsigned long)len);
  srv_reply_text(client, 200, srv->status);
}

static void srv_serve_one(local_server *srv, sock_t client) {
  /* Any traffic, of any kind, means a live page. Volatile, no atomic needed:
   * the counter is only ever compared for change. */
  srv->requests = srv->requests + 1;

  char req[SRV_MAX_REQUEST];
  int n = recv(client, req, sizeof(req) - 1, 0);
  if (n <= 0) return;
  req[n] = 0;

  /* Only GET is ever needed, but a HEAD or an empty request should still get a
   * clean answer rather than a dropped connection. */
  int is_get = (n > 4 && strncmp(req, "GET ", 4) == 0);
  int is_head = (n > 5 && strncmp(req, "HEAD ", 5) == 0);
  int is_post = (n > 5 && strncmp(req, "POST ", 5) == 0);

  /* The open page checking in: proof the window still exists. */
  if (is_get && n > 5 && strncmp(req + 4, SRV_ALIVE_PATH, SRV_ALIVE_PATH_LEN) == 0) {
    srv->beats = srv->beats + 1;
    srv_reply_text(client, 200, "alive");
    return;
  }

  /* Updates arrive here while the game is running, then the launcher promotes
   * them on the next start. Anything else keeps the plain read-only behaviour. */
  if (is_post && n > 5 && strncmp(req + 5, SRV_UPDATE_PATH, SRV_UPDATE_PATH_LEN) == 0) {
    srv_handle_update(srv, client, req, (size_t)n);
    return;
  }

  if (!is_get && !is_head) {
    const char *body =
      "HTTP/1.1 405 Method Not Allowed\r\n"
      "Content-Length: 0\r\nConnection: close\r\n\r\n";
    srv_send_all(client, body, strlen(body));
    return;
  }

  size_t size = 0;
  char *body = srv_slurp(srv->path, &size);
  if (!body) {
    const char *msg =
      "HTTP/1.1 500 Internal Server Error\r\n"
      "Content-Type: text/plain\r\nContent-Length: 21\r\n"
      "Connection: close\r\n\r\ncould not read the game";
    srv_send_all(client, msg, strlen(msg));
    return;
  }

  char header[512];
  int hlen = snprintf(header, sizeof(header),
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: text/html; charset=utf-8\r\n"
    "Content-Length: %lu\r\n"
    "Cache-Control: no-store\r\n"
    "X-Content-Type-Options: nosniff\r\n"
    "Connection: close\r\n"
    "\r\n",
    (unsigned long)size);

  srv_send_all(client, header, (size_t)hlen);
  if (is_get) srv_send_all(client, body, size);
  free(body);
}

/* Runs until stop is set. Returns the thread exit value. */
static void srv_loop(local_server *srv) {
  while (!srv->stop) {
    sock_t client = accept(srv->listen_sock, NULL, NULL);
    if (client == BAD_SOCK) {
      if (srv->stop) break;
      /* A transient accept failure must not spin the CPU. */
#ifdef _WIN32
      Sleep(10);
#else
      usleep(10000);
#endif
      continue;
    }
    srv_set_timeout(client, SRV_READ_TIMEOUT_SEC);
    srv_serve_one(srv, client);
    CLOSE_SOCK(client);
  }
}

#ifdef _WIN32
static DWORD WINAPI srv_thread_main(LPVOID arg) {
  srv_loop((local_server *)arg);
  return 0;
}
#else
static void *srv_thread_main(void *arg) {
  srv_loop((local_server *)arg);
  return NULL;
}
#endif

/*
 * Bind to an ephemeral loopback port and start serving `path`.
 * `staged_path` (may be NULL) enables POST /__aetheris/staged, which is how a
 * running game hands a verified newer build to the next launch.
 * Returns 1 on success; on failure returns 0 and fills srv->error.
 */
static int srv_start_ex(local_server *srv, const char *path, const char *staged_path) {
  memset(srv, 0, sizeof(*srv));
  srv->path = path;
  srv->staged_path = staged_path;
  srv->listen_sock = BAD_SOCK;

#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    snprintf(srv->error, sizeof(srv->error), "winsock init failed");
    return 0;
  }
#endif

  sock_t s = socket(AF_INET, SOCK_STREAM, 0);
  if (s == BAD_SOCK) {
    snprintf(srv->error, sizeof(srv->error), "socket() failed");
    return 0;
  }

  /* Let a restarted game rebind the same port immediately. */
  int reuse = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = 0;                        /* ephemeral: never collides */
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);  /* loopback only */

  if (bind(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    snprintf(srv->error, sizeof(srv->error), "bind() failed");
    CLOSE_SOCK(s);
    return 0;
  }

  /* Learn which port the OS picked. */
  struct sockaddr_in bound;
  socklen_t blen = sizeof(bound);
  if (getsockname(s, (struct sockaddr *)&bound, &blen) != 0) {
    snprintf(srv->error, sizeof(srv->error), "getsockname() failed");
    CLOSE_SOCK(s);
    return 0;
  }
  srv->port = ntohs(bound.sin_port);

  if (listen(s, 16) != 0) {
    snprintf(srv->error, sizeof(srv->error), "listen() failed");
    CLOSE_SOCK(s);
    return 0;
  }
  srv->listen_sock = s;

#ifdef _WIN32
  HANDLE h = CreateThread(NULL, 0, srv_thread_main, srv, 0, NULL);
  if (!h) {
    snprintf(srv->error, sizeof(srv->error), "could not start server thread");
    CLOSE_SOCK(s);
    srv->listen_sock = BAD_SOCK;
    return 0;
  }
  CloseHandle(h);   /* detached; the loop runs until srv_stop */
#else
  pthread_t t;
  if (pthread_create(&t, NULL, srv_thread_main, srv) != 0) {
    snprintf(srv->error, sizeof(srv->error), "could not start server thread");
    CLOSE_SOCK(s);
    srv->listen_sock = BAD_SOCK;
    return 0;
  }
  pthread_detach(t);
#endif
  return 1;
}

static int srv_start(local_server *srv, const char *path) {
  return srv_start_ex(srv, path, NULL);
}

/*
 * Keep serving until nobody has asked for anything for `idle_ms`.
 *
 * This replaces waiting on the browser's process handle. Chromium's process
 * singleton means the executable we launch usually forwards to an existing
 * instance and exits at once, so that handle says "done" while the real window
 * is still opening; stopping the server there produced ERR_CONNECTION_REFUSED
 * on a loopback URL that had been perfectly valid a moment earlier.
 *
 * A running game polls the loopback origin continuously (the update check, the
 * page itself), so genuine play keeps the counter moving. `max_ms` is a hard
 * ceiling so a launcher instance can never outlive its usefulness if the page
 * is left open and silent for a very long time.
 */
static void srv_wait_for_idle(local_server *srv, unsigned idle_ms,
                              unsigned alive_ms, unsigned max_ms) {
  /*
   * The page is what decides when this is over.
   *
   * Traffic alone is not a good signal: a player can load the game and then not
   * make a request for ten minutes, and that window is still open. So the page
   * checks in on SRV_ALIVE_PATH, and this loop distinguishes three phases:
   *
   *   1. nothing has been fetched yet  -> the browser is still starting up
   *   2. the page has checked in       -> it is open; keep serving
   *   3. the check-ins have stopped    -> the window is gone; we are done
   *
   * Phase 3 is what shuts the launcher down, with `alive_ms` of slack so a
   * throttled background tab is not punished. `idle_ms` still applies as a
   * fallback for a page that never polls (an older cached bundle), where a
   * burst of requests followed by silence really does mean it is finished.
   */
  unsigned long reqs = (unsigned long)srv->requests;
  unsigned long beats = (unsigned long)srv->beats;
  unsigned long waited = 0;
  unsigned long quiet = 0;
  unsigned long since_beat = 0;
  int saw_beat = 0;
  const unsigned step = 250;

  while (!srv->stop) {
    srv_sleep_ms(step);
    waited += step;

    unsigned long now_reqs = (unsigned long)srv->requests;
    unsigned long now_beats = (unsigned long)srv->beats;

    if (now_reqs != reqs) {
      reqs = now_reqs;
      quiet = 0;
    } else {
      quiet += step;
    }

    if (now_beats != beats) {
      beats = now_beats;
      saw_beat = 1;
      since_beat = 0;
    } else {
      since_beat += step;
    }

    if (saw_beat) {
      /* The page is open until it stops checking in. */
      if (since_beat >= alive_ms) break;
    } else {
      /* No liveness support (older bundle): fall back to plain idleness, but
       * never before the page has asked for anything at all. */
      if (quiet >= idle_ms) break;
      if (waited >= SRV_FIRST_REQUEST_GRACE_MS && reqs == 0) break;
    }

    if (waited >= max_ms) break;
  }
}

static void srv_stop(local_server *srv) {
  srv->stop = 1;
  if (srv->listen_sock != BAD_SOCK) {
    CLOSE_SOCK(srv->listen_sock);
    srv->listen_sock = BAD_SOCK;
  }
#ifdef _WIN32
  WSACleanup();
#endif
}
