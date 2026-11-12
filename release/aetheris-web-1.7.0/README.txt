AETHERIS - Island Warfare 1.7.0
========================================

WHAT THIS IS
  A complete static website that keeps itself up to date.

      index.html   the boot shell: picks which build to open (small, stable)
      game.html    the game as shipped in this zip (the fallback)
      sw.js        serves a browser-downloaded build at the site's own origin

HOW TO PUT IT ONLINE
  Any static host works. Upload all three files to the same folder.

    Netlify      drag the folder onto https://app.netlify.com/drop
    Vercel       vercel deploy --prod  (from this folder)
    GitHub Pages commit the three files to a repo, enable Pages
    Cloudflare   wrangler pages deploy .
    S3 / nginx   copy the files to the web root

  Must be served over http:// or https:// - not opened as a file. The browser
  needs a real origin for the service worker and for online multiplayer.

SELF-UPDATES
  On every load the shell asks the release channel what the newest build is.
  If it is newer than what the player has, it downloads it, checks its SHA-256
  against the published hash, caches it, and opens it. A released version
  reaches players on their next visit without you redeploying anything.

  If the download fails, is tampered with, or the player is offline, the game
  falls back to the copy in this zip and plays normally. The game cannot be
  broken by a bad update.

  The shell (index.html) is meant never to need replacing again. Only repackage
  if the fallback build itself should move.

CONTROLS
  Keyboard + mouse, or a gamepad. The menu lists the full set.
