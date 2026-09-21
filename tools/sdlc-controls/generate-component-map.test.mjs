import assert from 'node:assert/strict';
import test from 'node:test';
import { buildComponentMap } from './generate-component-map.mjs';
test('derives shared components from Nx fan-in while preserving declared criticality', () => {
  const graph = {
    nodes: {
      lib: { data: { root: 'packages/lib', tags: ['criticality:low'] } },
      a: { data: { root: 'packages/a', tags: [] } },
      b: { data: { root: 'packages/b', tags: [] } },
      c: { data: { root: 'packages/c', tags: [] } },
    },
    dependencies: { a: [{ target: 'lib' }], b: [{ target: 'lib' }], c: [{ target: 'lib' }] },
  };
  const component = buildComponentMap(graph).components.find((item) => item.id === 'lib');
  assert.deepEqual(component, {
    id: 'lib',
    match: ['packages/lib/**'],
    criticality: 'low',
    shared: true,
  });
});
