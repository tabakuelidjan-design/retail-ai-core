import { createHash } from 'node:crypto';

import { SCHEMA, UPSTREAM_NODES } from './constants.js';

// THE LAYER DEPENDENCY MAP of a layered artifact: which node is made from which. A repair invalidates a node and ONLY what depends on it; the reasoning upstream of the layers (concept, art direction, asset plan,
// product identity) is never invalidated by a layer-level defect. Pure and deterministic: the same artifact gives the same map and the same digest.
//
//   PLATE ───────────────┐
//   PROP (each) ─────────┼──► COMPOSITE_BASE (plate + background / midground props) ─┐
//   PRODUCT (protected) ─┴──► COMPOSITE_STACK (every raster layer) ──► TEXT_STYLE (colour read on the stack) ──► RENDER
//   TEXT (locked content) ───────────────────────────────────────────────────────────► (drawn by the deterministic typography)

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The node ids of an artifact, with their kind and dependencies. */
export function buildLayerDependencyMap(artifact) {
  const n = artifact?.nodes;
  if (artifact?.schema !== SCHEMA.artifact || !n?.plate || !Array.isArray(n.props) || !n.product || !Array.isArray(n.text) || !Array.isArray(n.text_style) || !n.composite) return null;
  const nodes = [];
  const add = (node_id, kind, depends_on, extra = {}) => nodes.push({ node_id, kind, depends_on, upstream: false, protected: false, ...extra });
  for (const id of UPSTREAM_NODES) nodes.push({ node_id: id, kind: 'UPSTREAM', depends_on: [], upstream: true, protected: false });
  add(n.plate.node_id, 'PLATE', ['ART_DIRECTION'], { digest: n.plate.candidate_sha256 });
  for (const p of n.props) add(p.node_id, p.kind, ['ART_DIRECTION', 'PRODUCT_IDENTITY'], { digest: digestOf([p.candidate_sha256, p.placed_sha256, p.box]) });
  add(n.product.node_id, 'PRODUCT', ['PRODUCT_IDENTITY'], { protected: true, digest: digestOf([n.product.cutout_sha256, n.product.placed_sha256, n.product.rect]) });
  for (const t of n.text) add(t.node_id, 'TEXT', ['ASSET_PLAN'], { protected: true, digest: digestOf([t.text_sha256, t.geometry]) });
  const under = [n.plate.node_id, ...n.props.filter((p) => p.kind !== 'PROP_FOREGROUND').map((p) => p.node_id)];
  add('COMPOSITE_BASE', 'COMPOSITE', under, { digest: n.composite.base_sha256 });
  add('COMPOSITE_STACK', 'COMPOSITE', [n.plate.node_id, ...n.props.map((p) => p.node_id), n.product.node_id], { digest: n.composite.stack_sha256 });
  for (const s of n.text_style) add(s.node_id, 'TEXT_STYLE', ['COMPOSITE_STACK', `TEXT:${s.role}`], { digest: s.style_sha256 });
  add('RENDER', 'RENDER', ['COMPOSITE_BASE', n.product.node_id, ...n.props.filter((p) => p.kind === 'PROP_FOREGROUND').map((p) => p.node_id), ...n.text.map((t) => t.node_id), ...n.text_style.map((s) => s.node_id)], { digest: n.render.png_sha256 ?? null });
  const map = { schema: SCHEMA.map, scene_id: artifact.scene_id, nodes };
  return Object.freeze({ ...map, digest: digestOf(nodes) });
}

/** Every node that depends, directly or not, on one of `changed` (the changed nodes themselves excluded). Upstream nodes appear only when they are named. */
export function dependentsOfNodes(map, changed) {
  const out = new Set(); const queue = [...changed];
  while (queue.length) {
    const current = queue.shift();
    for (const node of map.nodes) if (node.depends_on.includes(current) && !out.has(node.node_id) && !changed.includes(node.node_id)) { out.add(node.node_id); queue.push(node.node_id); }
  }
  return [...out].sort();
}

/**
 * What a repair of `targets` invalidates: the targets and their dependents. A node that is protected (the product, the locked text) or upstream is NEVER invalidated by a layer-level repair: if the closure reaches
 * one, the repair is not a layer repair and the planner refuses it.
 */
export function invalidationOf(map, targets) {
  const dependents = dependentsOfNodes(map, targets);
  const all = [...new Set([...targets, ...dependents])].sort();
  const byId = new Map(map.nodes.map((x) => [x.node_id, x]));
  const reachedProtected = all.filter((id) => byId.get(id)?.protected);
  const reachedUpstream = all.filter((id) => byId.get(id)?.upstream);
  const reused = map.nodes.filter((x) => !all.includes(x.node_id) && !x.upstream).map((x) => x.node_id).sort();
  return { invalidated: all, reused, reached_protected: reachedProtected, reached_upstream: reachedUpstream };
}
