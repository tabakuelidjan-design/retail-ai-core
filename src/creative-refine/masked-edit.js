import { decodePng } from '../creative-intelligence/png-pixels.js';
import {
  MASKED_EDIT, MASKED_EDIT_BLOCK, MASKED_EDIT_OUTPUT_CLASS, SCHEMA,
} from './constants.js';
import { COMPONENT, DECISION } from '../creative-runtime/ledger.js';

// THE MASKED-EDIT CAPABILITY (interface only). A masked edit changes ONLY the pixels under a mask, according to an instruction, and must leave every protected region exactly as it was. No provider is connected in
// Phase 4: this module defines the request, validates it, checks an output, and says HONESTLY that nothing can execute. It never fakes an edit, never falls back to another tool, and is not a scope of the
// executable REFINE (a repair that needs it is refused with PROVIDER_NOT_CONNECTED).
//
// Request: { source_image: { sha256, width, height }, mask: { width, height, regions?: [{x,y,width,height}] | png?: Uint8Array (white and opaque = editable) }, instruction, protected_regions: [{x,y,width,height}],
//            expected_output_class, provenance: { requested_by, ... }, cost_estimate_eur }

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const rectOk = (r) => r && finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width > 0 && r.height > 0;
const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** What the capability needs and the state of the connection. `executable` is true only when a provider port is connected AND declares its tool. */
export function describeMaskedEditCapability(ports = {}) {
  const port = ports?.maskedEdit ?? null;
  const connected = Boolean(port && typeof port.edit === 'function' && typeof port.tool_id === 'string' && port.tool_id.length > 0);
  return Object.freeze({
    schema: SCHEMA.maskedEdit,
    interface: MASKED_EDIT.INTERFACE_READY,
    provider: connected ? MASKED_EDIT.CONNECTED : MASKED_EDIT.NOT_CONNECTED,
    executable: connected,
    tool_id: connected ? port.tool_id : null,
    request_fields: Object.freeze(['source_image', 'mask', 'instruction', 'protected_regions', 'expected_output_class', 'provenance', 'cost_estimate_eur']),
    output_classes: Object.freeze(Object.values(MASKED_EDIT_OUTPUT_CLASS)),
  });
}

/** The editable regions of a mask, in pixels: the rectangles, or the runs of opaque white pixels of a PNG mask. */
function editableRects(mask) {
  if (Array.isArray(mask.regions)) return mask.regions;
  if (!mask.png) return [];
  const img = decodePng(mask.png); const rects = [];
  for (let y = 0; y < img.height; y += 1) {
    let start = -1;
    for (let x = 0; x <= img.width; x += 1) {
      const on = x < img.width && img.pixels[(y * img.width + x) * 4 + 3] > 0 && img.pixels[(y * img.width + x) * 4] > 127;
      if (on && start < 0) start = x;
      else if (!on && start >= 0) { rects.push({ x: start, y, width: x - start, height: 1 }); start = -1; }
    }
  }
  return rects;
}

/** Validation of a request, with every problem named. A mask that touches a protected region is refused BEFORE any provider is asked. */
export function validateMaskedEditRequest(request) {
  const problems = [];
  const r = request ?? {};
  if (!r.source_image || typeof r.source_image.sha256 !== 'string' || !finite(r.source_image.width) || !finite(r.source_image.height)) problems.push('SOURCE_IMAGE_NEEDS_SHA256_WIDTH_HEIGHT');
  if (!r.mask || !finite(r.mask.width) || !finite(r.mask.height) || (!Array.isArray(r.mask.regions) && !r.mask.png)) problems.push('MASK_NEEDS_SIZE_AND_REGIONS_OR_PNG');
  else if (r.source_image && (r.mask.width !== r.source_image.width || r.mask.height !== r.source_image.height)) problems.push('MASK_SIZE_DIFFERS_FROM_THE_SOURCE');
  if (typeof r.instruction !== 'string' || r.instruction.trim().length === 0) problems.push('INSTRUCTION_REQUIRED');
  if (!Array.isArray(r.protected_regions) || !r.protected_regions.every(rectOk)) problems.push('PROTECTED_REGIONS_MUST_BE_RECTANGLES');
  if (!Object.values(MASKED_EDIT_OUTPUT_CLASS).includes(r.expected_output_class)) problems.push(MASKED_EDIT_BLOCK.OUTPUT_CLASS_NOT_ALLOWED);
  if (!r.provenance || typeof r.provenance !== 'object' || !r.provenance.requested_by) problems.push('PROVENANCE_REQUIRED');
  if (!finite(r.cost_estimate_eur) || r.cost_estimate_eur < 0) problems.push('COST_ESTIMATE_REQUIRED');
  if (!problems.length) {
    const touched = editableRects(r.mask).some((m) => r.protected_regions.some((p) => intersects(m, p)));
    if (touched) problems.push(MASKED_EDIT_BLOCK.MASK_TOUCHES_A_PROTECTED_REGION);
  }
  return { ok: problems.length === 0, problems };
}

/** The output must leave every protected region pixel for pixel as in the source. */
export function protectedRegionsIntact({ source, output, protectedRegions }) {
  const a = decodePng(source); const b = decodePng(output);
  if (a.width !== b.width || a.height !== b.height) return { intact: false, reason: 'OUTPUT_SIZE_DIFFERS' };
  for (const r of protectedRegions) {
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(a.height, Math.ceil(r.y + r.height)); y += 1) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(a.width, Math.ceil(r.x + r.width)); x += 1) {
        const i = (y * a.width + x) * 4;
        if (a.pixels[i] !== b.pixels[i] || a.pixels[i + 1] !== b.pixels[i + 1] || a.pixels[i + 2] !== b.pixels[i + 2] || a.pixels[i + 3] !== b.pixels[i + 3]) return { intact: false, reason: 'A_PROTECTED_PIXEL_CHANGED', at: { x, y } };
      }
    }
  }
  return { intact: true };
}

/**
 * Ask for a masked edit. With no provider connected the answer is PROVIDER_NOT_CONNECTED and nothing is produced; with one, the request is validated first, the provider is reached only through an OPEN gate, and the
 * output is accepted only if every protected region is intact. There is no fallback to another tool.
 */
export async function requestMaskedEdit({
  ports = {}, request, sourcePng = null, gate = null, ledger = null,
}) {
  const capability = describeMaskedEditCapability(ports);
  const record = (outcome) => ledger?.record({
    decision: DECISION.MASKED_EDIT_REQUEST, decided_by: COMPONENT.MASKED_EDIT_CAPABILITY, rule: 'A_MASKED_EDIT_IS_NEVER_FAKED_AND_NEVER_TOUCHES_A_PROTECTED_REGION', basis: [request?.source_image?.sha256 ?? 'no-source'], outcome,
  });
  const validation = validateMaskedEditRequest(request);
  if (!validation.ok) {
    record({ status: 'BLOCKED', problems: validation.problems });
    return Object.freeze({
      status: 'BLOCKED', executed: false, reason: validation.problems.includes(MASKED_EDIT_BLOCK.MASK_TOUCHES_A_PROTECTED_REGION) ? MASKED_EDIT_BLOCK.MASK_TOUCHES_A_PROTECTED_REGION : MASKED_EDIT_BLOCK.REQUEST_INVALID, problems: validation.problems, capability,
    });
  }
  if (!capability.executable) { record({ status: MASKED_EDIT.NOT_CONNECTED }); return Object.freeze({ status: MASKED_EDIT_BLOCK.PROVIDER_NOT_CONNECTED, executed: false, output: null, capability }); }
  if (gate?.status !== 'OPEN_BY_OWNER') { record({ status: 'BLOCKED', reason: MASKED_EDIT_BLOCK.PROVIDER_GATE_NOT_OPEN }); return Object.freeze({ status: 'BLOCKED', executed: false, reason: MASKED_EDIT_BLOCK.PROVIDER_GATE_NOT_OPEN, capability }); }
  const out = await ports.maskedEdit.edit(request);
  if (sourcePng) {
    const check = protectedRegionsIntact({ source: sourcePng, output: out.output_bytes, protectedRegions: request.protected_regions });
    if (!check.intact) { record({ status: 'REJECTED', reason: MASKED_EDIT_BLOCK.OUTPUT_CHANGED_A_PROTECTED_REGION, detail: check }); return Object.freeze({ status: 'REJECTED', executed: true, reason: MASKED_EDIT_BLOCK.OUTPUT_CHANGED_A_PROTECTED_REGION, detail: check, output: null, capability }); }
  }
  record({ status: 'EXECUTED' });
  return Object.freeze({ status: 'EXECUTED', executed: true, output: out, capability });
}
