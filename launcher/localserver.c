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

/* Shared with the accept thread. `path` is owned by the caller and must stay
 * valid for the lifetime of the server. */
typedef struct {
  sock_t listen_sock;
  int port;
  const char *path;   /* file to serve for every GET */
  volatile int stop;
  char error[256];
} local_server;

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

static void srv_serve_one(local_server *srv, sock_t client) {
  char req[SRV_MAX_REQUEST];
  int n = recv(client, req, sizeof(req) - 1, 0);
  if (n <= 0) return;
  req[n] = 0;

  /* Only GET is ever needed, but a HEAD or an empty request should still get a
   * clean answer rather than a dropped connection. */
  int is_get = (n > 4 && strncmp(req, "GET ", 4) == 0);
  int is_head = (n > 5 && strncmp(req, "HEAD ", 5) == 0);

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
 * Returns 1 on success; on failure returns 0 and fills srv->error.
 */
static int srv_start(local_server *srv, const char *path) {
  memset(srv, 0, sizeof(*srv));
  srv->path = path;
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
