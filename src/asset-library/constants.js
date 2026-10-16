// Chantier D asset library: vocabulary. The owner of the ASSET entity for Creative is CREATIVE (src/integration/ownership.js); this library is its inventory.

/** Where an image really comes from. Only HABB_PHOTO / HABB_DESIGN / BRAND_ELEMENT can ever be the truth of what a product looks like. */
export const ORIGIN_CLASS = Object.freeze({
  HABB_PHOTO: 'HABB_PHOTO', // photographed by HABB (shop, finished personalised item)
  HABB_DESIGN: 'HABB_DESIGN', // made by HABB: mockup, print file, poster, visiting card
  BRAND_ELEMENT: 'BRAND_ELEMENT', // logo, wordmark, icon, favicon
  SUPPLIER_IMAGE: 'SUPPLIER_IMAGE', // supplier / marketplace picture: the right to republish is NOT established
  AI_GENERATED: 'AI_GENERATED', // produced by an image model: never evidence of a real product
  SCREENSHOT_OR_SOCIAL: 'SCREENSHOT_OR_SOCIAL', // downloaded from a social network, or a screenshot
  UNCLASSIFIED: 'UNCLASSIFIED',
});

/** Rights are never inferred. UNVERIFIED is the default; only a named human moves it. */
export const RIGHTS_STATUS = Object.freeze({
  UNVERIFIED: 'UNVERIFIED',
  OWNER_CONFIRMED: 'OWNER_CONFIRMED', // the owner states HABB may publish it
  RESTRICTED: 'RESTRICTED', // supplier / third party: do not publish
});

export const APPROVAL_STATUS = Object.freeze({ NOT_REVIEWED: 'NOT_REVIEWED', APPROVED: 'APPROVED', REJECTED: 'REJECTED' });

export const ASSET_KIND = Object.freeze({
  IMAGE: 'IMAGE', VIDEO: 'VIDEO', DOCUMENT: 'DOCUMENT', FONT: 'FONT', OTHER: 'OTHER',
});

export const ASSET_STAGE = Object.freeze({
  ORIGINAL: 'ORIGINAL', // source material
  BRAND: 'BRAND', // brand element
  TEMPLATE: 'TEMPLATE',
  CREATION: 'CREATION', // an edited / produced creative (a project)
  APPROVED_CREATION: 'APPROVED_CREATION',
  PUBLISH_READY: 'PUBLISH_READY', // final, approved, exported for a channel
});

export const CHANNELS = Object.freeze(['INSTAGRAM_FEED', 'INSTAGRAM_STORY', 'INSTAGRAM_REEL', 'FACEBOOK_FEED', 'FACEBOOK_STORY']);

/** Pixel format per channel: [width, height]. */
export const CHANNEL_FORMATS = Object.freeze({
  INSTAGRAM_FEED: [1080, 1350], INSTAGRAM_STORY: [1080, 1920], INSTAGRAM_REEL: [1080, 1920],
  FACEBOOK_FEED: [1080, 1350], FACEBOOK_STORY: [1080, 1920],
});

export const LIBRARY_ERROR = Object.freeze({
  INVALID_ENTRY: 'INVALID_ENTRY', DUPLICATE_ID: 'DUPLICATE_ID', NOT_PUBLISHABLE: 'NOT_PUBLISHABLE', UNKNOWN_ASSET: 'UNKNOWN_ASSET', INVALID_CONTRACT: 'INVALID_CONTRACT',
});

export class AssetLibraryError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'AssetLibraryError'; this.code = code; this.detail = detail; }
}
