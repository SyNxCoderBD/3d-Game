AETHERIS - Island Warfare 1.6.0
========================================

WHAT THIS IS
  A complete static website. One file: index.html. It contains the game, its
  styles and its code. There is nothing to install and nothing to build.

HOW TO PUT IT ONLINE
  Any static host works. Unzip and upload index.html.

    Netlify      drag the folder onto https://app.netlify.com/drop
    Vercel       vercel deploy --prod  (from this folder)
    GitHub Pages commit index.html to a repo, enable Pages
    Cloudflare   wrangler pages deploy .
    S3 / nginx   copy index.html to the web root

  Self-hosting in the same folder also works:

    python3 -m http.server 8080    then open http://localhost:8080/

  Open it over http:// rather than double-clicking the file. A file:// page is
  an opaque origin: the browser blocks the cross-origin calls the online
  multiplayer needs. Single-player works either way.

WHAT WORKS
  Everything: split-screen, bot practice, the full weapon set, online rooms.

WHAT IS DIFFERENT FROM THE WINDOWS BUILD
  The .exe ships its own loopback server, which lets it hand a downloaded
  update to the launcher for the next start. The web build has no launcher, so
  it plays the version it was deployed as. Everything else is identical - it is
  the same game code.

CONTROLS
  Keyboard + mouse, or a gamepad. Both are used in the game itself; the menu
  has the full list.
