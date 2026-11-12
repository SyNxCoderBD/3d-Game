/**
 * Main-menu chrome for releases: the version badge, the update line and the
 * changelog panel.
 *
 * Kept out of main.js because none of it touches the game, and because it is
 * the part that talks to the network on startup: if the update check were
 * inline with the render loop it would be that much harder to reason about
 * what can go wrong on a slow connection.
 */

import { versionLabel } from '../net/updater.js';

/* The version is stamped in by the build (see vite.config.js). The fallback
   exists so the dev server and the test harness can run without a define. */
export const BUILD_VERSION = (() => {
  try {
    return typeof __AETHERIS_VERSION__ !== 'undefined' ? __AETHERIS_VERSION__ : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
})();

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  checking: 'CHECKING FOR UPDATES',
  downloading: 'DOWNLOADING A NEWER BUILD',
  staged: 'UPDATE READY · RESTART TO PLAY IT',
  current: '',
  offline: '',
  failed: '',
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 'YYYY-MM-DD' from an ISO timestamp; blank when the date is unusable. */
export function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Render release notes into the panel. `currentVersion` is marked so the player
 * can see where they are in the list; newer entries read as "next update".
 */
export function renderChangelog(entries, currentVersion, target = $('changelogBody')) {
  if (!target) return 0;
  if (!entries || entries.length === 0) {
    target.innerHTML = '<p class="clEmpty">No releases published yet.</p>';
    return 0;
  }

  const rows = entries.map((entry) => {
    const isCurrent = String(entry.version) === String(currentVersion);
    const notes = String(entry.notes ?? '').trim();
    return `
      <article class="clEntry${isCurrent ? ' current' : ''}">
        <div class="clHead">
          <span class="clVer">${escapeHtml(versionLabel(entry.version))}</span>
          <span class="clDate">${escapeHtml(shortDate(entry.released_at))}</span>
          ${isCurrent ? '<span class="clBadge">YOU ARE HERE</span>' : ''}
        </div>
        <p class="clNotes">${notes ? escapeHtml(notes) : 'No notes for this release.'}</p>
      </article>`;
  }).join('');

  target.innerHTML = rows;
  return entries.length;
}

/**
 * Wire the menu. Returns the controller so main.js can report update progress
 * without knowing how the DOM is put together.
 */
export function mountMenuChrome({
  version = BUILD_VERSION,
  fetchReleases,
  onCheck,
  window: win = globalThis.window,
} = {}) {
  const label = versionLabel(version);
  const badge = $('menuVersion');
  if (badge) badge.textContent = label;

  const panel = $('changelog');
  const body = $('changelogBody');
  const statusEl = $('updateStatus');
  const openBtn = $('btnChangelog');
  const closeBtn = $('btnChangelogClose');
  let releases = null;
  let loading = null;

  function setStatus(state) {
    if (!statusEl) return;
    const text = STATUS_TEXT[state] ?? '';
    statusEl.textContent = text;
    statusEl.classList.toggle('show', Boolean(text));
    statusEl.classList.toggle('ready', state === 'staged');
  }

  function setOpen(open) {
    if (!panel) return;
    panel.classList.toggle('show', open);
    if (open) {
      if (body) body.innerHTML = '<p class="clEmpty">Loading releases…</p>';
      load().then((entries) => {
        renderChangelog(entries, version, body);
        // Keep the newest entry in view: that is the one that matters.
        if (body) body.scrollTop = 0;
      });
    }
  }

  /** Releases are fetched once, then reused for the panel and the check. */
  function load() {
    if (releases) return Promise.resolve(releases);
    if (!loading) {
      loading = Promise.resolve()
        .then(() => (fetchReleases ? fetchReleases() : []))
        .then((rows) => {
          releases = Array.isArray(rows) ? rows : [];
          return releases;
        })
        .catch(() => {
          releases = [];
          return releases;
        })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  openBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(true);
  });
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(false);
  });
  panel?.addEventListener('click', (e) => {
    // Clicking the backdrop closes; clicking the card does not.
    if (e.target === panel) setOpen(false);
  });
  win?.addEventListener?.('keydown', (e) => {
    if (e.key === 'Escape' && panel?.classList.contains('show')) {
      e.stopPropagation();
      setOpen(false);
    }
  });

  if (typeof onCheck === 'function') {
    Promise.resolve()
      .then(() => onCheck({ setStatus, load }))
      .catch(() => setStatus('offline'));
  }

  return {
    version,
    label,
    setStatus,
    openChangelog: () => setOpen(true),
    closeChangelog: () => setOpen(false),
    loadReleases: load,
  };
}
