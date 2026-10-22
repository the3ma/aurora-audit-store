import type { CfnTemplate } from './synth';

/**
 * Resource -> resources it references. Edges come from Ref, Fn::GetAtt (array and "Id.Attr" forms),
 * Fn::Sub (`${Id}` / `${Id.Attr}`, minus the variables of the two-argument form) and DependsOn.
 * Parameters, pseudo parameters and anything that is not a resource are ignored.
 */
export function dependencyGraph(template: CfnTemplate): Map<string, Set<string>> {
  const ids = new Set(Object.keys(template.Resources));
  const graph = new Map<string, Set<string>>();

  for (const [id, resource] of Object.entries(template.Resources)) {
    const edges = new Set<string>();
    const add = (target: string): void => {
      if (ids.has(target)) edges.add(target);
    };
    const subRefs = (text: string, locals: ReadonlySet<string>): void => {
      for (const m of text.matchAll(/\$\{([^}!][^}]*)\}/g)) {
        const name = (m[1] ?? '').split('.')[0] ?? '';
        if (!locals.has(name)) add(name);
      }
    };
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'Ref' && typeof value === 'string') add(value);
        else if (key === 'Fn::GetAtt') {
          if (Array.isArray(value) && typeof value[0] === 'string') add(value[0]);
          else if (typeof value === 'string') add(value.split('.')[0] ?? '');
          walk(value);
        } else if (key === 'Fn::Sub') {
          if (typeof value === 'string') subRefs(value, new Set());
          else if (Array.isArray(value) && typeof value[0] === 'string') {
            const vars = (value[1] ?? {}) as Record<string, unknown>;
            subRefs(value[0], new Set(Object.keys(vars)));
            walk(vars);
          }
        } else walk(value);
      }
    };
    walk(resource.Properties);
    const deps = resource.DependsOn;
    for (const d of deps === undefined ? [] : Array.isArray(deps) ? deps : [deps]) add(d);
    graph.set(id, edges);
  }
  return graph;
}

/** Tarjan's strongly connected components; returns only the cyclic ones (size > 1 or a self-loop). */
export function findCycles(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  // Iterative to stay safe on templates with long dependency chains.
  for (const root of graph.keys()) {
    if (indexOf.has(root)) continue;
    const work: Array<{ node: string; edges: Iterator<string> }> = [];
    const visit = (node: string): void => {
      indexOf.set(node, index);
      low.set(node, index);
      index++;
      stack.push(node);
      onStack.add(node);
      work.push({ node, edges: (graph.get(node) ?? new Set<string>()).values() });
    };
    visit(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (!frame) break;
      const next = frame.edges.next();
      if (!next.done) {
        const w = next.value;
        if (!indexOf.has(w)) visit(w);
        else if (onStack.has(w)) low.set(frame.node, Math.min(low.get(frame.node) ?? 0, indexOf.get(w) ?? 0));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      if (low.get(frame.node) === indexOf.get(frame.node)) {
        const component: string[] = [];
        let w: string | undefined;
        do {
          w = stack.pop();
          if (w === undefined) break;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.node);
        const selfLoop = component.length === 1 && (graph.get(frame.node)?.has(frame.node) ?? false);
        if (component.length > 1 || selfLoop) cycles.push(component.sort());
      }
    }
  }
  return cycles;
}
