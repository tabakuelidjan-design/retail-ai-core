// Creative Phase 5 — general segmentation and realistic product integration. Constants, states and bounds. Every threshold lives HERE so it is reviewable in one place.
// Everything in this module is pure and offline: RGBA buffers in, RGBA buffers and measurements out. No provider, no network, no clock, no randomness.

/** The explicit outcome of an integration. Anything but READY_FOR_COMPOSITE stops; there is no fallback to a generated product. */
export const STATE = Object.freeze({
  SEGMENTATION_FAILED: 'SEGMENTATION_FAILED',
  SEGMENTATION_LOW_CONFIDENCE: 'SEGMENTATION_LOW_CONFIDENCE',
  MATTE_INVALID: 'MATTE_INVALID',
  PRODUCT_IDENTITY_RISK: 'PRODUCT_IDENTITY_RISK',
  PLACEMENT_INVALID: 'PLACEMENT_INVALID',
  SHADOW_INVALID: 'SHADOW_INVALID',
  RELIGHT_OUT_OF_BOUNDS: 'RELIGHT_OUT_OF_BOUNDS',
  INTEGRATION_ARTIFACT: 'INTEGRATION_ARTIFACT',
  READY_FOR_COMPOSITE: 'READY_FOR_COMPOSITE',
});

/** Why a segmentation did not deliver a mask. */
export const SEG_REASON = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  BACKGROUND_NOT_PLAIN: 'BACKGROUND_NOT_PLAIN',
  NO_FOREGROUND: 'NO_FOREGROUND',
  AMBIGUOUS_SELECTION: 'AMBIGUOUS_SELECTION',
  SELECTION_NOT_FOUND: 'SELECTION_NOT_FOUND',
  SELECTION_TOUCHES_OTHER_OBJECT: 'SELECTION_TOUCHES_OTHER_OBJECT',
  PORT_CONTRACT_VIOLATION: 'PORT_CONTRACT_VIOLATION',
  PORT_FAILED: 'PORT_FAILED',
});

export const SEGMENTATION = Object.freeze({
  border_px: 3, // width of the ring used to learn the plain ground
  border_homogeneous_share: 0.85, // share of ring pixels close to the ground colour, below which the ground is "not plain"
  ground_tolerance: 18, // colour distance (0..255 scale) of a ring pixel to the ground colour
  t_lo: 14, // distance at which a pixel starts to count as product (alpha ramp start)
  t_hi: 44, // distance at which a pixel is fully product
  shadow_luma_floor: 0.62, // a pixel of the ground chroma that is darker than this share of the ground luma is product, not a soft ground shadow
  chroma_shadow_tolerance: 9,
  min_component_share: 0.0004, // components below this share of the image are fragments (reported, never selected silently)
  significant_share: 0.12, // a component at least this share of the largest one is "an object" for the ambiguity rule
  pinhole_px: 12, // an enclosed gap of at most this many pixels is a speck (a ground-coloured print dot, an anti-aliasing accident) and is filled; a larger one is a hole only if the ground shows through it
  max_split_erosion_px: 40, // touching objects are separated by eroding up to this radius
  min_core_share: 0.03,
  unmix_residual: 28, // a boundary pixel farther than this from the ground-to-product colour line is not a mixture of the two
  alpha_dust: 0.03, // an unmixed alpha below this is zero
  hole_ground_share: 0.5, // an enclosed gap is a real hole only if at least this share of it is clearly the ground colour
  sliver_min_length_px: 24, // ... and at least this long (the apex of a round hole is a short sliver too)
  sliver_min_elongation: 4, // a bridge is kept only if its bounding box is at least this many times longer than wide
  bridge_px: 5, // gaps up to 2 x this between foreground on both sides are bridged
  min_confidence: 0.6,
  semi_transparent_floor: 0.08,
});

export const MATTE = Object.freeze({
  edge_support_min_share: 0.7, // share of boundary pixels backed by an image edge
  edge_support_gradient: 10, // luma step across the boundary that counts as an edge
  cluster_max_px: 5, // a contiguous run of bad boundary pixels (a visible halo / fringe segment) at least this long fails, whatever its share
  fringe_max_share: 0.12, // share of boundary pixels whose colour is the ground, not the product
  pinhole_max_pixels: 0, // enclosed transparent specks inside the product
  accidental_hole_max_share: 0.0005, // of the matte area
  ground_blob_max_share: 0.002, // opaque pixels that are the ground colour, in blobs of at least ground_blob_min_px, as a share of the matte (ground that leaked into the product)
  ground_blob_min_px: 20,
  fragment_max_count: 0,
  fragment_min_pixels: 1,
  missing_thin_max_share: 0.004, // product-evidence pixels the matte dropped, as a share of the matte area
  offset_max_px: 1.5, // mean boundary offset between the matte and the image evidence (erosion < 0, dilation > 0)
  stray_alpha_max_pixels: 0, // non-zero alpha outside the product group
  interior_alpha_max_share: 0.004, // interior pixels (eroded) that are not opaque, unless semi-transparency is declared
  reconstruction_residual: 16, // a boundary pixel farther than this (RGB distance) from alpha * product + (1 - alpha) * ground is not explained by the matte
  reconstruction_gradient_gain: 3, // extra tolerance per unit of local colour gradient of the product
  reconstruction_max_share: 0.1,
  alpha_noise_max: 0.15, // share of partial-alpha pixels that are strict local extrema (a clean anti-aliased edge is monotonic across the boundary)
});

export const IDENTITY = Object.freeze({
  alpha_exact: true, // the integrated product layer keeps the cut-out alpha byte for byte
  detail_correlation_min: 0.985, // correlation of the illumination-free detail field (logos, text, ports, buttons)
  tile_correlation_min: 0.93, // the worst 8 x 8 tile with real detail
  tile_grid: 8,
  min_tile_variance: 4e-4,
  detail_blur_radius: 6,
  chromaticity_shift_max: 0.08, // L1 shift of the mean normalised colour (r, g, b over r + g + b): the product's colour identity, independent of exposure (the exposure is bounded by RELIGHT)
  hue_shift_max_deg: 10,
  duplicate_alpha_components_equal: true,
});

export const RELIGHT = Object.freeze({
  exposure_ev: 0.4, // |EV| bound
  local_gain: 0.15, // |gain gradient| across the product along the light axis
  temperature: 0.06, // |per-channel gain difference| for temperature
  tint: 0.04,
  saturation: 0.1, // |saturation change|, 0 = unchanged
  max_luma_change: 0.22, // the largest change of any interior pixel luma, as a share of 255 (a bound on highlights / shadows)
  clip_tolerance_levels: 8, // a channel that would pass 0 / 255 by more than this has lost information (a rounding of a near-white is not a clip)
  clip_share_max: 0.005, // share of interior pixels that lost information to clipping
});

export const GRADE = Object.freeze({
  luminance_delta_max: 0.22, // white point of the product vs the scene around it (0..1)
  min_white_point: 0.6, // below this the product has no bright part: the exposure cannot be judged and is skipped
  temperature_delta_max: 0.1, // cast of the neutral pixels, (R - B) / (R + B)
  saturation_delta_max: 0.45, // loose: mostly the product's own colour
  texture_floor: 0.004, // fine texture below this on both sides is noise: skipped
  texture_log2_max: 2.5, // the product's fine texture may differ from the scene's by 2^2.5 at most
  correction_share: 0.6, // the correction moves the product this share of the way to the scene, bounded
});

export const SHADOW = Object.freeze({
  kinds: Object.freeze(['SOFT', 'HARD', 'DIFFUSE', 'DIRECTIONAL']),
  max_opacity: 0.65,
  contact_band_share: 0.04, // the lowest rows of the product, as a share of its height, are the contact region
  min_contact_coverage: 0.55, // share of the contact region that must be darkened by the shadow
  max_detach_px: 3, // a shadow component farther than this from the contact region is detached
  max_lobes: 1,
  floating_gap_px: 3, // the product's lowest opaque row farther than this above the support surface is floating
});

export const PLACEMENT = Object.freeze({
  min_visible_share: 0.98,
  scale_tolerance: 0.18, // vs the expected px/cm
  min_height_share: 0.04,
  max_height_share: 0.92,
  max_tilt_deg: 12,
  contact_tolerance_px: 3,
  max_occlusion_of_protected: 0,
  aspect_tolerance: 0.005,
});

export const ARTIFACT = Object.freeze({
  halo_ring_px: 3,
  halo_luma_delta: 10, // the ring around the product differs from the plate by more than this (0..255) without being shadow
  halo_max_share: 0.08,
  alpha_noise_max: 0.2, // placed (scaled) alpha ramp, same measure
});

export const PERFORMANCE = Object.freeze({ cache_max_entries: 32 });
