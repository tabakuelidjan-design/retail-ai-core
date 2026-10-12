// Test fixtures that want a COMPLETE landed cost must say that the other import costs are really zero: an import cost that is not entered is UNKNOWN, never zero.
const z = () => ({ total: 0, status: 'KNOWN', source: 'test fixture: explicitly zero' });
export const ZERO_COSTS = Object.freeze({ originCharges: z(), insurance: z(), brokerage: z(), inspection: z(), testing: z(), labelling: z(), epr: z(), inboundLogistics: z() });
