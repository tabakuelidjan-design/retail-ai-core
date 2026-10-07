# Creative Fidelity benchmark data

This directory contains only benchmark structure, examples and documentation.

Do not commit merchant product originals, customer photos, faces, private Library file IDs, API keys, generated private assets, or sensitive HABB data here.

A private asset list is converted into the standard five cases per product by `buildManifestFromAssets`.

## Source-of-truth requirements

A benchmark source must be:
- a real product photo;
- not AI-generated;
- not a screenshot;
- rights confirmed for the pilot;
- referenced privately/opaquely rather than copied into the generic public repository.

Initial target: 10 difficult real HABB products.

Suggested diversity:
1. glossy bottle/tumbler;
2. phone case with fine print or photo;
3. transparent/acrylic item;
4. gift box/packaging;
5. slate/stone item;
6. product carrying a logo;
7. product carrying small exact text;
8. dark/tech product;
9. personalized object containing a face;
10. geometrically complex object.

Each product automatically receives the same five benchmark tasks:
- BACKGROUND_SWAP;
- PREMIUM_AD;
- IN_CONTEXT;
- EXTERNAL_EDIT;
- COHERENT_SET.
