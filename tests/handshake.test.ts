import assert from "node:assert/strict";
import test from "node:test";

import {
    PROTOCOL_VERSION,
    QUERY_TAG,
    VERDICT_ACCEPT,
    VERDICT_MALFORMED_HELLO,
    VERDICT_SCHEMA_CONFLICT,
    VERDICT_WRONG_VERSION,
    answerQuery,
    checkReply,
    decide,
    decodeHello,
    decodeQuery,
    decodeReply,
    encodeHello,
    encodeQuery,
    encodeReply,
} from "../src/handshake.ts";
import { buildSchema, type MessageSchema } from "../src/schema.ts";

function message(id: number, prefixes: bigint[]): MessageSchema {
    return { id, fingerprint: prefixes[prefixes.length - 1] ?? 0n, prefixes };
}

// Item { id }              → prefix chain [A]
// Item { id, name }        → prefix chain [A, B]
// Item { id, name, hp }    → prefix chain [A, B, C]
const A = 0xaaaa_aaaa_aaaa_aaaan;
const B = 0xbbbb_bbbb_bbbb_bbbbn;
const C = 0xcccc_cccc_cccc_ccccn;
const X = 0x1111_1111_1111_1111n;

const ONE_FIELD = buildSchema(0x1n, [message(7, [A])]);
const TWO_FIELDS = buildSchema(0x2n, [message(7, [A, B])]);
const THREE_FIELDS = buildSchema(0x3n, [message(7, [A, B, C])]);
const DIVERGED = buildSchema(0x4n, [message(7, [A, X])]);

function helloOf(schema: ReturnType<typeof buildSchema>) {
    const decoded = decodeHello(encodeHello(schema));
    assert.notEqual(decoded, null);
    return decoded!;
}

test("a hello matches the layout in 02 §3.2", () => {
    const encoded = encodeHello(TWO_FIELDS);
    assert.equal(encoded.length, 16 + 14 * 1);

    const view = new DataView(encoded.buffer);
    assert.equal(view.getUint32(0, true), PROTOCOL_VERSION);
    assert.equal(view.getBigUint64(4, true), 0x2n);
    assert.equal(view.getUint32(12, true), 1);
    assert.equal(view.getUint32(16, true), 7);
    assert.equal(view.getUint16(20, true), 2, "field count n travels on the wire");
    assert.equal(view.getBigUint64(22, true), B);
});

test("matching schema fingerprints accept without reading a single entry", () => {
    const decision = decide(TWO_FIELDS, helloOf(TWO_FIELDS));
    assert.equal(decision.kind, "accept");
});

test("a wrong protocol version is verdict 1", () => {
    const hello = encodeHello(TWO_FIELDS);
    new DataView(hello.buffer).setUint32(0, 1, true);
    const decision = decide(TWO_FIELDS, decodeHello(hello)!);
    assert.deepEqual(decision, { kind: "reject", verdict: VERDICT_WRONG_VERSION });
});

test("ⓑ same field count, different fingerprint is verdict 2", () => {
    const decision = decide(TWO_FIELDS, helloOf(DIVERGED));
    assert.deepEqual(decision, { kind: "reject", verdict: VERDICT_SCHEMA_CONFLICT });
});

test("ⓒ a shorter peer whose prefix matches is accepted with NO query", () => {
    const decision = decide(TWO_FIELDS, helloOf(ONE_FIELD));
    assert.equal(decision.kind, "accept");
});

test("ⓒ a shorter peer whose prefix diverges is verdict 2, still with no query", () => {
    const shortDiverged = buildSchema(0x5n, [message(7, [X])]);
    const decision = decide(TWO_FIELDS, helloOf(shortDiverged));
    assert.deepEqual(decision, { kind: "reject", verdict: VERDICT_SCHEMA_CONFLICT });
});

test("ⓓ a longer peer forces a query at the server's own field count", () => {
    const decision = decide(TWO_FIELDS, helloOf(THREE_FIELDS));
    assert.deepEqual(decision, { kind: "query", items: [{ id: 7, fieldCount: 2 }] });
});

test("ⓓ with n_s = 0 accepts, because an empty prefix is a prefix of everything", () => {
    const empty = buildSchema(0x6n, [message(7, [])]);
    const decision = decide(empty, helloOf(TWO_FIELDS));
    assert.equal(decision.kind, "accept");
});

test("a message only one side knows is never a conflict", () => {
    const extra = buildSchema(0x7n, [message(7, [A, B]), message(9, [C])]);
    assert.equal(decide(TWO_FIELDS, helloOf(extra)).kind, "accept");
    assert.equal(decide(extra, helloOf(TWO_FIELDS)).kind, "accept");
});

// The two cases the whole design exists for: RFC-0003 §8.6 vectors V-001 and
// V-002 lifted to the handshake. Failing either is non-compliance with
// RFC-0002 §9.1, not extra safety.
test("V-001/V-002: a peer that appended a field at the end connects", () => {
    const decision = decide(TWO_FIELDS, helloOf(THREE_FIELDS));
    assert.equal(decision.kind, "query");

    const asked = (decision as { items: { id: number; fieldCount: number }[] }).items;
    const reply = answerQuery(THREE_FIELDS, asked);
    assert.notEqual(reply, null);
    assert.equal(checkReply(TWO_FIELDS, asked, reply!), VERDICT_ACCEPT);
});

test("V-001/V-002: a peer that removed a trailing field connects", () => {
    const decision = decide(THREE_FIELDS, helloOf(TWO_FIELDS));
    assert.equal(decision.kind, "accept", "n_c < n_s takes branch ⓒ and needs no query");
});

test("a query round with a diverging answer is verdict 2", () => {
    const decision = decide(TWO_FIELDS, helloOf(THREE_FIELDS));
    const asked = (decision as { items: { id: number; fieldCount: number }[] }).items;
    const lying = [{ id: 7, fingerprint: X }];
    assert.equal(checkReply(TWO_FIELDS, asked, lying), VERDICT_SCHEMA_CONFLICT);
});

test("a reply that is short, long, or out of order is malformed, not a conflict", () => {
    const asked = [
        { id: 7, fieldCount: 2 },
        { id: 9, fieldCount: 1 },
    ];
    const local = buildSchema(0x8n, [message(7, [A, B]), message(9, [C])]);

    assert.equal(checkReply(local, asked, [{ id: 7, fingerprint: B }]), VERDICT_MALFORMED_HELLO);
    assert.equal(
        checkReply(local, asked, [
            { id: 9, fingerprint: C },
            { id: 7, fingerprint: B },
        ]),
        VERDICT_MALFORMED_HELLO,
    );
});

test("query and reply frames match the layouts in 02 §3.3.2", () => {
    const query = encodeQuery([{ id: 7, fieldCount: 2 }]);
    assert.equal(query[0], QUERY_TAG);
    assert.equal(query.length, 5 + 6 * 1);
    assert.deepEqual(decodeQuery(query), [{ id: 7, fieldCount: 2 }]);

    const reply = encodeReply([{ id: 7, fingerprint: B }]);
    assert.equal(reply.length, 4 + 12 * 1);
    assert.deepEqual(decodeReply(reply), [{ id: 7, fingerprint: B }]);
});

test("a query asking for index 0 is malformed", () => {
    const query = encodeQuery([{ id: 7, fieldCount: 0 }]);
    assert.equal(decodeQuery(query), null);
});

test("a hello whose length is off by one byte is refused", () => {
    const hello = encodeHello(TWO_FIELDS);
    assert.equal(decodeHello(hello.subarray(0, hello.length - 1)), null);

    const padded = new Uint8Array(hello.length + 1);
    padded.set(hello, 0);
    assert.equal(decodeHello(padded), null);
});

test("an absurd message count is refused before any allocation", () => {
    const hello = new Uint8Array(16);
    const view = new DataView(hello.buffer);
    view.setUint32(0, PROTOCOL_VERSION, true);
    view.setUint32(12, 0xffff_ffff, true);
    assert.equal(decodeHello(hello), null);
});
