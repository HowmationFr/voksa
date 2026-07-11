// Debug/CI harness: boots the real app on an isolated profile so a second
// instance can run next to a real session, with CDP enabled. Used by
// scripts/smoke.mjs in CI and for local debugging. Usage:
//   VOKSA_DEBUG_PROFILE=<dir> [VOKSA_DEBUG_PORT=9223] npx electron debug-profile.cjs
// Lives at the repo root ON PURPOSE: app.getAppPath() must stay the project
// root so window.ts finds dist-ui/.
const path = require('node:path');
const { app } = require('electron');

const profile = process.env.VOKSA_DEBUG_PROFILE;
if (!profile) {
  console.error('VOKSA_DEBUG_PROFILE is not set');
  process.exit(1);
}
app.setPath('userData', profile);
// sessionData does NOT follow a later userData override; without this the
// Chromium caches/singleton still target the real profile (held by the
// user's running instance) and the second instance dies silently.
app.setPath('sessionData', profile);
// main/index.ts re-pins userData to <appData>/voksa at require time (profile
// rename migration). Point appData inside the isolated dir too, otherwise
// that pin escapes back to the REAL profile (settings, session, extensions)
// and the harness both leaks state in and mutates the user's data.
app.setPath('appData', profile);
app.commandLine.appendSwitch('remote-debugging-port', process.env.VOKSA_DEBUG_PORT || '9223');

require(path.join(__dirname, 'dist-electron', 'main', 'index.js'));
