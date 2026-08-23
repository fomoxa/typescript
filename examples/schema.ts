import { buildSchema } from "../src/index.ts";

/**
 * Stand-in fingerprints. A real project takes these from the tree `fomoxac`
 * generates: this SDK moves opaque bytes and never computes a fingerprint or
 * encodes a field itself.
 */
export const PLAYER_INPUT = 0x74fdfa74;

export const SCHEMA = buildSchema(0xbd60379718901aa5n, [
    {
        id: PLAYER_INPUT,
        fingerprint: 0x38e57f1ede9363dcn,
        prefixes: [0x19ed6ca454a7f3ffn, 0x38e57f1ede9363dcn],
    },
]);
