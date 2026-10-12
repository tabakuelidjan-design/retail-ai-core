import { isSupported } from '../creative-brain/tool-registry.js';
import { deepFreeze } from '../creative-brain/validation.js';
import { PRODUCTION_CAPABILITY as P } from './constants.js';

// CAPABILITY ROUTING (NDR-D01, NDR-P20). A capability may have several ranked candidate tools, DECLARED here, each with its executor, its region, the data class it may receive, its size limit and the registry
// capability that proves it is wired. The choice is made once, deterministically, from the constraints of the request, and WRITTEN INTO THE SPEC with the candidates it passed over and why. Execution uses only the
// selected tool: there is no fallback chain, no tool replaces another at run time, and a capability with no admissible tool is an explicit state (the asset is blocked), never a guess. Switching to another
// tool or another capability is a replanning decision with a new spec and a new id.
//
// A tool is named by an opaque id; the concrete adapter behind it lives in the Creative Brain's tool registry, the only place that knows a provider.

export const TOOL_CANDIDATES = deepFreeze({
  [P.ENVIRONMENT_PLATE_GENERATION]: [
    { tool_id: 'text-to-image/primary', executor: 'PROVIDER', region: 'EU_PINNED', data_class: 'PUBLIC', max_side_px: 2048, registry_capability: 'ENVIRONMENT_GENERATION' },
    { tool_id: 'text-to-image/secondary', executor: 'PROVIDER', region: 'EU_PINNED', data_class: 'PUBLIC', max_side_px: 2048, registry_capability: 'MULTI_REFERENCE_COMPOSITION' },
  ],
  [P.PROP_ON_PLAIN_GROUND_GENERATION]: [
    { tool_id: 'text-to-image/primary', executor: 'PROVIDER', region: 'EU_PINNED', data_class: 'PUBLIC', max_side_px: 2048, registry_capability: 'ENVIRONMENT_GENERATION' },
  ],
  [P.PROP_CUTOUT]: [
    { tool_id: 'cutout/plain-ground-matte', executor: 'LOCAL', region: 'LOCAL', data_class: 'PUBLIC', max_side_px: 4096, registry_capability: 'PRODUCT_CUTOUT' },
  ],
  [P.LOCAL_SEGMENTATION]: [
    { tool_id: 'segmentation/annotated-outline', executor: 'LOCAL', region: 'LOCAL', data_class: 'PRIVATE', max_side_px: 8192, registry_capability: 'LOCAL_SEGMENTATION' },
  ],
  [P.PRODUCT_CUTOUT]: [
    { tool_id: 'cutout/exact-source-pixels', executor: 'LOCAL', region: 'LOCAL', data_class: 'PRIVATE', max_side_px: 8192, registry_capability: 'PRODUCT_CUTOUT' },
  ],
  [P.DETERMINISTIC_COMPOSITE]: [
    { tool_id: 'composite/z-ordered-layers', executor: 'LOCAL', region: 'LOCAL', data_class: 'PRIVATE', max_side_px: 8192, registry_capability: 'DETERMINISTIC_PRODUCT_COMPOSITE' },
  ],
  [P.DETERMINISTIC_TEXT]: [
    { tool_id: 'typography/real-fonts', executor: 'LOCAL', region: 'LOCAL', data_class: 'PUBLIC', max_side_px: 8192, registry_capability: 'DETERMINISTIC_TEXT' },
  ],
});

/**
 * The tool for a capability under constraints: the first candidate, in rank order, that is wired, accepts the data class, is in an allowed region and takes the size. Returns the selection with the candidates it
 * passed over and why, or `selected: null` with all of them rejected.
 * @param {string} capability
 * @param {object} constraints { dataClass, regions: string[], sideMax }
 */
export function selectTool(capability, { dataClass, regions = ['LOCAL', 'EU_PINNED'], sideMax = 0 }) {
  const candidates = TOOL_CANDIDATES[capability] ?? [];
  const rejected = [];
  for (const c of candidates) {
    if (!isSupported(c.registry_capability)) { rejected.push({ tool_id: c.tool_id, reason: 'NOT_WIRED' }); continue; }
    if (c.data_class !== dataClass && !(c.data_class === 'PRIVATE' && dataClass === 'PUBLIC')) { rejected.push({ tool_id: c.tool_id, reason: 'DATA_CLASS_NOT_ACCEPTED' }); continue; }
    if (!regions.includes(c.region)) { rejected.push({ tool_id: c.tool_id, reason: 'REGION_NOT_ALLOWED' }); continue; }
    if (sideMax > c.max_side_px) { rejected.push({ tool_id: c.tool_id, reason: 'SIZE_NOT_ACCEPTED' }); continue; }
    return deepFreeze({
      capability, selected: { tool_id: c.tool_id, executor: c.executor, region: c.region, data_class: c.data_class }, candidates: candidates.map((x) => x.tool_id), rejected, execution_policy: 'ONLY_THE_SELECTED_TOOL',
    });
  }
  return deepFreeze({
    capability, selected: null, candidates: candidates.map((x) => x.tool_id), rejected, execution_policy: 'ONLY_THE_SELECTED_TOOL',
  });
}
