// Nordla Growth - PUBLIC snapshot of the REMAX products of the HABB catalogue, for the local evaluation harness only.
// Source: Shopify Admin GraphQL, READ-ONLY query on 2026-11-27 (search: vendor Remax / RX / tag remax; 17 products returned, hasNextPage = false).
// Only public storefront fields are kept: title, handle, vendor, product type, tags, status, minimum public price (EUR).
// NOT here, on purpose: purchase cost, margin, supplier, stock, sales, orders, customers. None of them was requested from Shopify.
// The product type "Packaging" of the hair dryer is kept in the snapshot but excluded from the Tech group (it is not an accessory).
// Limits: the search query may miss a product whose vendor and tags do not match it; the snapshot is a point-in-time copy.

export const REMAX_SNAPSHOT_DATE = '2026-11-27';

export const REMAX_PRODUCTS = Object.freeze([
  { handle: 'casque-bluetooth-remax-rb-300hb-pliable', title: 'Casque Bluetooth Remax RB-300HB pliable', vendor: 'Remax', productType: 'Headphones', tags: ['Casque sans fil', 'remax', 'Écouteurs'], status: 'ACTIVE', price: '34.90' },
  { handle: 'cable-tresse-usb-c-30w-65w', title: 'Câble tressé USB-C 30W / 65W', vendor: 'Remax CB16', productType: 'Câbles & chargeurs', tags: ['remax'], status: 'ACTIVE', price: '9.99' },
  { handle: 'cable-4-en-1-ultra-rapide-240w', title: 'Câble 4-en-1 ultra-rapide 240W', vendor: 'Remax CB18', productType: 'Câbles & chargeurs', tags: ['remax'], status: 'ACTIVE', price: '19.00' },
  { handle: 'ecouteurs-true-wireless-musique-et-appels', title: 'Écouteurs True Wireless pour musique et appels', vendor: 'RX PD-BT533N Pro', productType: 'Headphones', tags: ['Airpod', 'remax'], status: 'ACTIVE', price: '39.00' },
  { handle: 'casque-bluetooth-telescopique-et-pliable', title: 'Casque Bluetooth télescopique et pliable', vendor: 'Remax RB-870', productType: 'Headphones', tags: ['remax'], status: 'ACTIVE', price: '49.99' },
  { handle: 'ecouteurs-true-wireless-cozypods-anc-enc', title: 'Écouteurs True Wireless CozyPods avec ANC + ENC', vendor: 'Remax CozyPods W28N', productType: 'Headphones', tags: ['remax'], status: 'ACTIVE', price: '49.00' },
  { handle: 'casque-bluetooth-rb-980hb-plongez-dans-le-son', title: 'Casque Bluetooth avec réduction de bruit', vendor: 'Remax RB-980HB', productType: 'Headphones', tags: ['remax'], status: 'ACTIVE', price: '69.90' },
  { handle: 'ecouteurs-conduction-osseuse-bluetooth', title: 'Écouteurs à conduction osseuse Bluetooth', vendor: 'Remax RB-S18', productType: 'Headphones', tags: [], status: 'ACTIVE', price: '59.00' },
  { handle: 'batterie-externe-mini-10000mah-22-5w', title: 'Batterie externe Mini 10 000 mAh – 22,5W', vendor: 'Remax MH136', productType: 'Batteries externes', tags: ['remax'], status: 'ACTIVE', price: '29.00' },
  { handle: 'batterie-externe-20000mah-45w', title: 'Batterie externe 20 000 mAh – 45W', vendor: 'Remax FC-02', productType: 'Batteries externes', tags: [], status: 'ACTIVE', price: '49.00' },
  { handle: 'seche-cheveux-plasma-haute-vitesse', title: 'Sèche-cheveux plasma haute vitesse', vendor: 'Remax RS-H08', productType: 'Packaging', tags: [], status: 'ACTIVE', price: '129.00', excludedFromTech: true },
  { handle: 'cable-remax-c19-30w-c20-65w', title: 'Câble C19 30W / C20 65W', vendor: 'Remax C19 / C20', productType: 'Câbles & chargeurs', tags: [], status: 'ACTIVE', price: '14.90' },
  { handle: 'cable-remax-cb23-usb-a-vers-usb-c', title: 'Câble Remax CB23 – USB-A vers USB-C 66W / USB-C vers USB-C 65W', vendor: 'Remax CB23', productType: 'Câbles & chargeurs', tags: [], status: 'ACTIVE', price: '8.90' },
  { handle: 'cable-usb-c-vers-lightning-20w-30w-2m', title: 'Câble USB-C vers Lightning 20W / 30W – 2 m', vendor: 'Remax RC-C123', productType: 'Câbles & chargeurs', tags: [], status: 'ACTIVE', price: '11.90' },
  { handle: 'cable-usb-c-vers-usb-c-remax-65w-2m', title: 'Câble USB-C vers USB-C Remax 65W – 2 m', vendor: 'Remax RC-C021', productType: 'Câbles & chargeurs', tags: [], status: 'ACTIVE', price: '11.90' },
  { handle: 'kit-de-charge-rapide-gan-30w', title: 'Kit de charge rapide GaN 30W', vendor: 'Remax RP-U71', productType: 'Câbles & chargeurs', tags: [], status: 'ACTIVE', price: '14.90' },
  { handle: 'chargeur-sans-fil-pliable-3-en-1-avec-veilleuse', title: 'Chargeur sans fil pliable 3-en-1 avec veilleuse', vendor: 'Remax RP-W70', productType: 'Câbles & chargeurs', tags: [], status: 'ACTIVE', price: '29.90' },
]);

/** The Tech group: REMAX products the catalogue types as accessories (the hair dryer is excluded). */
export const REMAX_TECH = Object.freeze(REMAX_PRODUCTS.filter((p) => !p.excludedFromTech));
