/* Material branch codes for the street prop kit.
 *
 * In a file of their own because two producers write them — `props.ts` builds
 * the footway objects and `signage.ts` builds the brackets that hold the
 * projecting signs up — and one consumer reads them, `scene/propMaterials.ts`.
 * Putting them in either producer would make the other import it for a
 * constant and create an import cycle for nothing.
 */
export const PMAT = {
  IRON: 0,      // painted cast iron: bollards, hydrants, hoops, sign brackets
  GALV: 1,      // galvanised steel: cabinets, standpipes, banding
  POLY: 2,      // black polythene refuse sack
  PLASTIC: 3,   // moulded plastic: wheelie bin, cone, news box
  TIMBER: 4,    // softwood pallet and crate
  CONCRETE: 5,  // precast tub, vault light surround
  PAINT: 6,     // painted sheet steel, gone chalky
  CARD: 7,      // wet corrugated cardboard
  RUBBER: 8,    // castors, cone base, tyre
  ALLOY: 9,     // dull aluminium and stainless
} as const;
