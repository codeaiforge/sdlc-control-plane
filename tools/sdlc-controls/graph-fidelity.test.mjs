import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// The component map derives blast radius from Nx edges, and those edges are declared by
// hand: Nx does not resolve the deep relative imports these packages use. A declared edge
// with no import inflates fan-in; a missing one hides it. Both mistier a change silently.
const projects = readdirSync('packages')
  .filter((dir) => existsSync(`packages/${dir}/project.json`))
  .map((dir) => {
    const config = JSON.parse(readFileSync(`packages/${dir}/project.json`, 'utf8'));
    const imported = readdirSync(`packages/${dir}/src`)
      .flatMap((file) => [
        ...readFileSync(`packages/${dir}/src/${file}`, 'utf8').matchAll(
          /from '\.\.\/\.\.\/([^/]+)\//g,
        ),
      ])
      .map((match) => match[1]);
    return { dir, name: config.name, declared: config.implicitDependencies ?? [], imported };
  });

const nameByDir = new Map(projects.map((project) => [project.dir, project.name]));
const sorted = (values) => [...new Set(values)].sort();

test('every declared Nx edge matches an import, and every import is declared', () => {
  for (const { dir, declared, imported } of projects) {
    assert.deepEqual(
      sorted(declared),
      sorted(imported.map((target) => nameByDir.get(target) ?? target)),
      `packages/${dir}/project.json implicitDependencies disagree with its imports`,
    );
  }
});

test('every project directory is a discoverable Nx project', () => {
  assert.deepEqual(
    readdirSync('packages').filter((dir) => !existsSync(`packages/${dir}/project.json`)),
    [],
    'a directory under packages/ has no project.json, so the graph cannot see it',
  );
});

// The reviewed fan-in of every project, from the declared edges the first test holds to the
// imports. generate-component-map.mjs flips `shared` at a fan-in of 3, which permanently retiers
// every later change under that project; contracts sits at 2, one edge below it. ADR-0003 forbids
// control-plane-api from importing it, and task 2.1's design keeps workload-identity a leaf for
// the same reason. evidence-store (task 2.2) is the same kind of leaf: it imports no project,
// and control-plane-api is its one dependent. A new edge - from source or from a test, since this scan reads every file in
// src/ - fails here and names the threshold, before the component map retiers anything. Changing
// this table is a reviewed decision about blast radius, not a fix-up.
const REVIEWED_FAN_IN = {
  contracts: 2,
  'workspace-registry': 1,
  'guardrail-policy': 1,
  indicators: 1,
  'workload-identity': 1,
  'evidence-store': 1,
  'control-plane-api': 0,
};

test('the declared fan-in of every project matches the reviewed table', () => {
  const fanIn = Object.fromEntries(projects.map(({ name }) => [name, 0]));
  for (const { name, declared } of projects) {
    for (const target of new Set(declared)) {
      if (target !== name && Object.hasOwn(fanIn, target)) fanIn[target] += 1;
    }
  }
  assert.deepEqual(
    fanIn,
    REVIEWED_FAN_IN,
    'a project fan-in moved. At 3 the component map marks a project shared and raises the tier ' +
      'of every change under it; contracts is at 2 by design (ADR-0003), so an edge onto it from ' +
      'control-plane-api or workload-identity is refused here.',
  );
  for (const [name, count] of Object.entries(REVIEWED_FAN_IN))
    assert.ok(count < 3, `${name} is reviewed at fan-in ${count}, which the map would mark shared`);
});
