import { readFileSync } from 'node:fs';

const criticalities = new Set(['low', 'medium', 'high', 'critical']);
const workspaceComponents = [
  { id: 'sdlc-controls-gate', match: ['tools/sdlc-controls/**', '.github/workflows/sdlc-controls.yml'], criticality: 'critical', shared: false },
  { id: 'control-plane-policy', match: ['config/control-plane/**', 'docs/adr/**'], criticality: 'critical', shared: false },
  { id: 'ci-pipeline', match: ['.github/workflows/**'], criticality: 'high', shared: false },
  { id: 'workspace-config', match: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'nx.json'], criticality: 'high', shared: false },
  { id: 'docs', match: ['docs/**', 'README.md', 'AGENTS.md'], criticality: 'low', shared: false },
];

function fanIn(graph) {
  const names = new Set(Object.keys(graph.nodes ?? {}));
  const counts = new Map([...names].map((name) => [name, 0]));
  for (const [source, edges] of Object.entries(graph.dependencies ?? {})) {
    if (!names.has(source)) continue;
    for (const target of new Set((edges ?? []).map((edge) => edge.target))) {
      if (names.has(target) && target !== source) counts.set(target, counts.get(target) + 1);
    }
  }
  return counts;
}

export function buildComponentMap(graph) {
  const counts = fanIn(graph);
  const projects = Object.entries(graph.nodes ?? {}).map(([id, node]) => {
    const data = node.data ?? {};
    const criticality = (data.tags ?? []).find((tag) => tag.startsWith('criticality:'))?.slice(12) ?? 'high';
    if (!criticalities.has(criticality)) throw new Error(`invalid criticality for ${id}`);
    if (!data.root || data.root === '.') throw new Error(`root project cannot be mapped: ${id}`);
    return { id, match: [`${data.root.replace(/\/$/, '')}/**`], criticality, shared: (counts.get(id) ?? 0) >= 3 };
  });
  return { version: 1, defaults: { unmatched_path_tier: 'high', breadth_threshold: 4 }, components: [...workspaceComponents, ...projects].sort((a, b) => a.id.localeCompare(b.id)) };
}

export function toYaml(map) {
  const quote = (value) => JSON.stringify(value);
  return ['version: ' + map.version, 'defaults:', `  unmatched_path_tier: ${map.defaults.unmatched_path_tier}`, `  breadth_threshold: ${map.defaults.breadth_threshold}`, 'components:', ...map.components.flatMap((component) => [`  - id: ${quote(component.id)}`, `    match: [${component.match.map(quote).join(', ')}]`, `    criticality: ${component.criticality}`, `    shared: ${component.shared}`])].join('\n') + '\n';
}

if (process.argv[1]?.endsWith('generate-component-map.mjs')) {
  const input = process.argv[2] ?? 'graph.json';
  const { graph } = JSON.parse(readFileSync(input, 'utf8'));
  process.stdout.write(toYaml(buildComponentMap(graph)));
}
