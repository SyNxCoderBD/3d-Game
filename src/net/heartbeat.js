/**
 * Keep the launcher alive for as long as the game is open.
 *
 * The Windows launcher starts a loopback server, points a browser at it, and
 * then has to decide when to stop serving. The obvious answer — "when the
 * browser process I started exits" — is wrong, because Chromium forwards the
 * URL to an already-running instance and the spawned process exits straight
 * away. Waiting on it closed the socket while the real window was still
 * opening, which is the ERR_CONNECTION_REFUSED the player saw.
 *
 * Traffic is not a good signal either. Once the page has loaded, the player can
 * sit in a menu for minutes without a single request, press F5, or be in a
 * match while an update downloads. All of those need the server up.
 *
 * So the page just says so. While it is open it checks in every few seconds;
 * when the tab is closed the check-ins stop, and the launcher shuts down a
 * little later. Polling continues while the tab is hidden (Chromium throttles
 * it to about once a minute, well inside the launcher's tolerance), so
 * backgrounding the game does not kill it.
 *
 * Everything here is best effort. A missing endpoint (file://, the dev server,
 * an older launcher) simply stops the heartbeat, and nothing about the game
 * depends on it.
 */

import { updateTarget } from './updater.js';

/** Matches SRV_ALIVE_INTERVAL_MS in launcher/localserver.c. */
export const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Start checking in with the launcher.
 *
 * Returns { stop, url } — `url` is null when there is no launcher to talk to,
 * in which case nothing is scheduled and `stop` is a no-op.
 */
export function startHeartbeat({
  location = globalThis.location,
  fetchImpl = globalThis.fetch,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
} = {}) {
  const target = updateTarget(location);
  if (!target) return { stop() {}, url: null };

  const url = `${target.base}/__aetheris/alive`;
  let timer = null;
  let stopped = false;

  const beat = () => {
    if (stopped) return;
    try {
      // Deliberately not awaited and never surfaced: losing a check-in only
      // means the launcher waits a little longer before shutting down.
      fetchImpl?.(url, { cache: 'no-store', keepalive: true })?.catch?.(() => {});
    } catch {
      /* no fetch, no problem — the launcher falls back to plain idleness */
    }
  };

  beat(); // do not wait a whole interval to announce the first one
  try {
    timer = setIntervalImpl?.(beat, intervalMs) ?? null;
  } catch {
    timer = null;
  }

  return {
    url,
    stop() {
      stopped = true;
      if (timer !== null) {
        try {
          clearIntervalImpl?.(timer);
        } catch {
          /* nothing to clean up */
        }
        timer = null;
      }
    },
  };
}
