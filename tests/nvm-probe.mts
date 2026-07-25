/**
 * builder-29: inner probe for nvm-fix-test.mts. Runs UNDER a node binary that lives in a
 * fake nvm tree, so process.execPath points there and the node-relative global-root
 * derivation in src/preflight.ts resolves inside the rig.
 *
 * argv[2] = absolute path to the preflight.ts under test (fixed or pre-fix baseline)
 * argv[3] = optional platform to force ('win32')
 * Prints one JSON line. Never trust a run whose execPath is not the rig's node.
 */
const src = process.argv[2];
const forcePlatform = process.argv[3];

if (forcePlatform) {
  Object.defineProperty(process, 'platform', { value: forcePlatform, configurable: true });
}

// Nothing inherited may decide the result: no explicit override, and no PATH for the
// last-resort bare `claude` candidate to succeed on (builder-28's false-green trap).
delete process.env.MISSION_CONTROL_CLI;
process.env.PATH = '/nonexistent-for-this-test';

const { resolveCli } = await import(src);
const r = await resolveCli();

console.log(JSON.stringify({
  execPath: process.execPath,
  platform: process.platform,
  found: r.found,
  source: r.source,
  version: r.version,
  command: r.command,
  prefixArgs: r.prefixArgs,
}));
