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
