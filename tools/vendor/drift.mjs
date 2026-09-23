// Report how this repository has drifted from the ai-ready-nx-workspace governance layer,
// and emit patches for the part of that drift which belongs upstream.
//
// The upstream bootstrap already answers "which managed files differ from what I would
// install" — it derives its manifest from the upstream repository, so there is no list here
// to fall behind. What it cannot answer is *who* changed a file, and that is the only
// question that decides what to do about one. This wraps `--check` and classifies its STALE
// lines against the import commit:
//
//   ours      imported by the baseline commit, modified here since  -> patch upstream
//   upstream  imported by the baseline commit, untouched here       -> pull on next sync
//   local     not imported by it; this repo's own file that the bootstrap also manages
//   missing   upstream has it, this repo never took it
//
// `local` is the category that makes this worth running. The bootstrap manages more files
// than it imported here — AGENTS.md, the docs/specs templates, the component-map adapter all
// predate the import — so `--check` calls them STALE, and a sync that took its version of
// them would overwrite deliberate work. Without this split, "23 files differ" is not
// actionable in either direction.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The commit that applied the framework's install script. Everything here is measured from
// it, and it is a single atomic commit for exactly this reason: its diff IS the vendored file
// list, so nothing has to be maintained by hand. Move this only when a sync lands, and move
// it to that sync's commit.
const BASELINE = '4430cfc';

// This repository's install profile. The bootstrap reads the target to detect these, and it
// would detect them correctly, but a report whose answer depends on autodetection is a report
// that changes when the detection does.
const PROFILE = ['--kind', 'nx', '--package-manager', 'pnpm', '--with-sdlc-controls'];

const UPSTREAM_DEFAULT = '../ai-ready-nx-workspace';
const BOOTSTRAP = 'scripts/bootstrap-ai-governance.sh';

const git = (...args) => {
  const { status, stdout, stderr } = spawnSync('git', args, { encoding: 'utf8' });
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout;
};

const root = git('rev-parse', '--show-toplevel').trim();
const upstream = resolve(root, process.env.AI_NX_WORKSPACE ?? UPSTREAM_DEFAULT);
const bootstrap = join(upstream, BOOTSTRAP);

// --check is read-only and exits 1 when anything differs, so a non-zero status is the normal
// case here and only a missing script or an unreadable target is a real failure.
const checked = spawnSync(bootstrap, ['--target', root, ...PROFILE, '--check'], {
  encoding: 'utf8',
  cwd: root,
});
if (checked.error) {
  console.error(`cannot run ${bootstrap}`);
  console.error(`  ${checked.error.message}`);
  console.error(`\nSet AI_NX_WORKSPACE to the ai-ready-nx-workspace checkout, or clone it to`);
  console.error(`${UPSTREAM_DEFAULT} relative to this repository.`);
  process.exit(1);
}

// Files the baseline commit itself introduced. `git show --name-only` on a commit lists what
// that commit changed, which for the import is precisely the vendored set.
const imported = new Set(
  git('show', '--name-only', '--format=', BASELINE)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
);

const changedSinceBaseline = new Set(
  git('diff', '--name-only', `${BASELINE}..HEAD`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
);

// Everything below is measured against HEAD, because a patch is cut from committed work. That
// makes uncommitted drift invisible exactly when it matters most — you edit a managed file,
// run this, and get a patch that silently predates the edit. Marked rather than included: the
// fix is to commit, not to widen the diff.
const dirty = new Set(
  git('diff', '--name-only', 'HEAD')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
);

const buckets = { ours: [], upstream: [], local: [], missing: [] };

for (const line of checked.stdout.split('\n')) {
  const match = /^(STALE|CREATE)\s+(\S+)/.exec(line);
  if (!match) continue;
  const [, state, path] = match;
  if (state === 'CREATE') {
    buckets.missing.push(path);
    continue;
  }
  if (!imported.has(path)) buckets.local.push(path);
  else if (changedSinceBaseline.has(path)) buckets.ours.push(path);
  else buckets.upstream.push(path);
}

const LEGEND = {
  ours: 'modified here since the import — patch these upstream or the next sync reverts them',
  upstream: 'upstream moved on — pull these on the next sync',
  local: "this repo's own files the bootstrap also manages — never upstream, never --force",
  missing: 'upstream has these, this repo never took them',
};

for (const [name, paths] of Object.entries(buckets)) {
  console.log(`\n${name} (${paths.length}) — ${LEGEND[name]}`);
  for (const path of paths.sort())
    console.log(`  ${path}${dirty.has(path) ? '   [uncommitted changes — not in any patch]' : ''}`);
}

const patchIndex = process.argv.indexOf('--patch');
if (patchIndex !== -1) {
  const outDir = resolve(root, process.argv[patchIndex + 1] ?? '.vendor-patches');
  mkdirSync(outDir, { recursive: true });
  const uncommitted = buckets.ours.filter((path) => dirty.has(path));
  if (uncommitted.length > 0) {
    console.log(`\nWARNING: ${uncommitted.length} upstreamable file(s) have uncommitted changes.`);
    console.log('These patches are cut from HEAD and will not carry them. Commit first.');
    for (const path of uncommitted) console.log(`  ${path}`);
  }
  console.log(`\npatches for the ${buckets.ours.length} upstreamable file(s):`);
  for (const path of buckets.ours) {
    // Diffed from the baseline, not from HEAD's parent: upstream's copy is the baseline
    // version, so this is the patch that applies cleanly there. A diff of the commit that
    // made the change would carry whatever else that commit touched.
    const patch = git('diff', `${BASELINE}..HEAD`, '--', path);
    // The leading dot goes: most of what drifts lives under .github/ or .ai/, and a flattened
    // name that kept it would be a dotfile — invisible to `ls` and unmatched by `*.patch`,
    // which is exactly how you would apply a directory of these.
    const file = join(outDir, `${path.replaceAll('/', '__').replace(/^\.+/, '')}.patch`);
    writeFileSync(file, patch);
    console.log(`  ${file}`);
  }
  console.log(`\nApply in the upstream checkout with:  git apply <patch>`);
}

console.log(
  `\n${buckets.ours.length} file(s) to send upstream, ${buckets.upstream.length + buckets.missing.length} to pull.`,
);
