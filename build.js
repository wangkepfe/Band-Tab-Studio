/* ============================================================================
 * build.js — assemble dist/ for the hosted builds. Node >= 18, zero dependencies.
 *
 * TWO TARGETS, selected by an ARGV FLAG (not an env var: release-web.bat is a cmd
 * script, where `STUDIO_MODE=cloud node build.js` is not a thing):
 *
 *   node build.js           mode 'web'   — DEFAULT. The OFFLINE editor + the bundled
 *                           project library: full in-browser editor, no backend and no
 *                           network (no AI; the bundled projects open read-only and
 *                           edits are kept via "Save file" — a downloaded .studio.json).
 *                           This is what release-web.bat zips and start-studio.bat
 *                           refreshes, so both keep working with no change.
 *   node build.js --cloud   mode 'cloud' — the same frontend deployed on Cloudflare
 *                           Workers in front of the shared D1 library. This is the only
 *                           mode in which store.js / api.js / sync.js do anything: the
 *                           public searchable library, GitHub sign-in to save or
 *                           duplicate, IndexedDB-staged edits. `wrangler deploy` serves
 *                           ./dist as static assets with worker/ handling /api/*.
 *
 *   dist/
 *     <web app files>     <- copied from tab-studio/web/
 *     config.js           <- generated: window.STUDIO_CONFIG = { mode, libVersion }
 *     projects/           <- the project-library bundle (see below)
 *       index.json        <-   the library list (same shape as GET /api/projects)
 *       <id>.json         <-   each project (full project.json)
 *     _headers
 *
 * The library is bundled from the committed projects/ folder — the SAME folder the
 * desktop backend reads and writes in place, so an edit made on desktop is exactly
 * what the build ships. BOTH targets emit it: in cloud mode it is the FALLBACK library
 * api.js (listSeedProjects / getSeedProject) and sync.js fall back to when D1 is
 * unreachable or the database has not been seeded yet.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'tab-studio', 'web');
const PROJECTS = path.join(ROOT, 'projects');

// 0. target. Unknown flags are FATAL rather than ignored: a silently-mistyped --cloud
//    would produce a dist/ that looks right and is inert (mode 'web' turns off all
//    three cloud modules), which is exactly the failure this flag exists to prevent.
let MODE = 'web';
for (const arg of process.argv.slice(2)) {
  if (arg === '--cloud') MODE = 'cloud';
  else if (arg === '--web') MODE = 'web';
  else {
    console.error('build.js: unknown argument "' + arg + '" (expected --cloud or --web)');
    process.exit(1);
  }
}

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (!filter || filter(e.name)) fs.copyFileSync(s, d);
  }
}

// The build stamp api.js's libVersion() reads and hangs on every seed-library fetch as
// ?v=<stamp>. Without it libVersion() falls back to the constant '0', the query string
// never changes, and a returning visitor keeps whatever library an older build pinned
// into the HTTP cache (those fetches used cache:'force-cache'). The git sha makes the
// stamp identify the deploy; projects/ is edited IN PLACE by the desktop app and is
// therefore often uncommitted, so a dirty tree appends the build time and the stamp
// still moves.
function buildStamp() {
  const git = (args) => execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  try {
    const sha = git(['rev-parse', '--short=10', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--', 'tab-studio/web', 'projects']) !== '';
    if (sha) return dirty ? sha + '.' + Date.now().toString(36) : sha;
  } catch (e) { /* no git on PATH, not a repo, or an empty checkout — timestamp it is */ }
  return Date.now().toString(36);
}
const STAMP = buildStamp();

// 1. fresh dist/ + the web app
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copyDir(WEB, OUT);

// 2. project-library bundle — projects/<id>.json (full project) + projects/index.json
//    (same shape as GET /api/projects). Only each project.json is read; the per-project
//    audio (stems/, song.*) is left out of every build. In 'web' this IS the library;
//    in 'cloud' it is the offline / empty-database fallback.
let projectCount = 0;
if (fs.existsSync(PROJECTS)) {
  const outLib = path.join(OUT, 'projects');
  fs.mkdirSync(outLib, { recursive: true });
  const index = [];
  for (const e of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const pj = path.join(PROJECTS, e.name, 'project.json');
    if (!fs.existsSync(pj)) continue;
    const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
    const id = meta.id || e.name;
    fs.copyFileSync(pj, path.join(outLib, id + '.json'));
    const tracks = meta.tracks || [];
    index.push({
      id: id, name: meta.name || id, updated: meta.updated || 0,
      // hasSong describes what SHIPPED, not what the desktop project holds on disk:
      // the audio bytes are deliberately excluded above, and browser playback is
      // YouTube-only. Reading it off meta.song painted the library's "♪" badge
      // (app.js:696) onto audio no visitor can ever hear.
      youtubeUrl: meta.youtubeUrl || '', hasSong: false,
      instruments: tracks.map(t => t.instrument), trackCount: tracks.length,
    });
  }
  index.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  fs.writeFileSync(path.join(outLib, 'index.json'), JSON.stringify({ projects: index }));
  projectCount = index.length;
}

// 3. config.js — force the build's mode (overwrites the committed mode='desktop'
//    default) and stamp the build. The committed config.js runs after this line and
//    only normalises .mode, so libVersion survives untouched.
fs.writeFileSync(path.join(OUT, 'config.js'),
  'window.STUDIO_CONFIG = { mode: ' + JSON.stringify(MODE) +
  ', libVersion: ' + JSON.stringify(STAMP) + ' };\n' +
  fs.readFileSync(path.join(WEB, 'config.js'), 'utf8'));

// 4. _headers (security + asset caching). Honored by both Pages and Workers static assets.
fs.writeFileSync(path.join(OUT, '_headers'),
`/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  # NOT no-referrer. The YouTube "Song" source is a cross-origin iframe
  # navigation from this document, and youtube.com refuses to play for an
  # embedder it can't name — PLAYABILITY_ERROR_CODE_EMBEDDER_IDENTITY_
  # MISSING_REFERRER, which reaches the page as onError 153. It worked on
  # desktop only by accident: YouTube's own widget API sets
  # referrerpolicy="strict-origin-when-cross-origin" on the iframe element it
  # builds, and an element-level policy overrides the document's — so the whole
  # feature was resting on an attribute we don't control, which iPadOS Safari
  # does not always honour. strict-origin sends the ORIGIN only, never a path,
  # so nothing no-referrer was protecting actually leaks.
  Referrer-Policy: strict-origin-when-cross-origin
  Cache-Control: no-cache
/config.js
  Cache-Control: no-store
/projects/*
  Cache-Control: no-cache
`);
// No _redirects file: a `/* /index.html 200` SPA rule is rejected by Cloudflare
// Workers static assets as an "infinite loop". Unknown-path handling is done via
// not_found_handling in wrangler.jsonc (Workers); a single-page app needs nothing
// extra on Pages.

console.log('Built dist/  mode=' + MODE + '  libVersion=' + STAMP + '  projects=' + projectCount);
