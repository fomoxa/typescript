import type { Schema } from "./schema.ts";

export const PROTOCOL_VERSION = 2;
export const QUERY_TAG = 4;

export const HELLO_HEADER_LEN = 16;
export const HELLO_ENTRY_LEN = 14;
export const QUERY_HEADER_LEN = 5;
export const QUERY_ENTRY_LEN = 6;
export const REPLY_HEADER_LEN = 4;
export const REPLY_ENTRY_LEN = 12;

export const MAX_SCHEMA_MESSAGES = 1_000_000;

export const VERDICT_ACCEPT = 0;
export const VERDICT_WRONG_VERSION = 1;
export const VERDICT_SCHEMA_CONFLICT = 2;
export const VERDICT_MALFORMED_HELLO = 3;

export type HandshakeFailure =
    | "wrong-version"
    | "schema-conflict"
    | "malformed-hello"
    | "malformed-peer"
    | "timeout";

export function failureOfVerdict(verdict: number): HandshakeFailure {
    switch (verdict) {
        case VERDICT_WRONG_VERSION:
            return "wrong-version";
        case VERDICT_SCHEMA_CONFLICT:
            return "schema-conflict";
        default:
            return "malformed-hello";
    }
}

export interface HelloEntry {
    readonly id: number;
    readonly fieldCount: number;
    readonly fingerprint: bigint;
}

export interface HelloView {
    readonly version: number;
    readonly fingerprint: bigint;
    readonly entries: readonly HelloEntry[];
}

export interface QueryItem {
    readonly id: number;
    readonly fieldCount: number;
}

export interface ReplyItem {
    readonly id: number;
    readonly fingerprint: bigint;
}

export function encodeHello(schema: Schema): Uint8Array {
    const out = new Uint8Array(HELLO_HEADER_LEN + HELLO_ENTRY_LEN * schema.messages.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, PROTOCOL_VERSION, true);
    view.setBigUint64(4, schema.fingerprint, true);
    view.setUint32(12, schema.messages.length, true);

    let at = HELLO_HEADER_LEN;
    for (const message of schema.messages) {
        view.setUint32(at, message.id, true);
        view.setUint16(at + 4, message.prefixes.length, true);
        view.setBigUint64(at + 6, message.fingerprint, true);
        at += HELLO_ENTRY_LEN;
    }
    return out;
}

export function decodeHello(payload: Uint8Array): HelloView | null {
    if (payload.length < HELLO_HEADER_LEN) {
        return null;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = view.getUint32(12, true);

    // The cap is checked before the multiply, never after: a count near 2^32
    // would overflow a 32-bit product and let a hostile hello pass the length
    // test (02 §3.3). JavaScript would not overflow, but the order is part of
    // the behaviour every implementation shares.
    if (count > MAX_SCHEMA_MESSAGES) {
        return null;
    }
    if (payload.length !== HELLO_HEADER_LEN + HELLO_ENTRY_LEN * count) {
        return null;
    }

    const entries: HelloEntry[] = [];
    let at = HELLO_HEADER_LEN;
    for (let index = 0; index < count; index += 1) {
        entries.push({
            id: view.getUint32(at, true),
            fieldCount: view.getUint16(at + 4, true),
            fingerprint: view.getBigUint64(at + 6, true),
        });
        at += HELLO_ENTRY_LEN;
    }

    return { version: view.getUint32(0, true), fingerprint: view.getBigUint64(4, true), entries };
}

export type Decision =
    | { readonly kind: "accept" }
    | { readonly kind: "reject"; readonly verdict: number }
    | { readonly kind: "query"; readonly items: readonly QueryItem[] };

export function decide(local: Schema, hello: HelloView): Decision {
    if (hello.version !== PROTOCOL_VERSION) {
        return { kind: "reject", verdict: VERDICT_WRONG_VERSION };
    }

    // Gate ③ opens with the whole-schema fingerprint: equal means both sides
    // were built from the same schema and not a single entry is read (02 §3.3).
    if (hello.fingerprint === local.fingerprint) {
        return { kind: "accept" };
    }

    const queries: QueryItem[] = [];

    for (const entry of hello.entries) {
        const mine = local.byId.get(entry.id);
        if (mine === undefined) {
            // A message only the peer knows is never a conflict: this side
            // simply never receives it (02 §3.3).
            continue;
        }

        const nClient = entry.fieldCount;
        const nServer = mine.prefixes.length;

        // ⓐ identical message
        if (entry.fingerprint === mine.fingerprint) {
            continue;
        }

        // ⓑ same length, different content — not a prefix relationship
        if (nClient === nServer) {
            return { kind: "reject", verdict: VERDICT_SCHEMA_CONFLICT };
        }

        // ⓒ the peer is shorter: k = nClient, and the fingerprint it sent is
        // already h_k, so the answer is in the local prefix chain.
        if (nClient < nServer) {
            if (nClient === 0) {
                continue;
            }
            if (mine.prefixes[nClient - 1] !== entry.fingerprint) {
                return { kind: "reject", verdict: VERDICT_SCHEMA_CONFLICT };
            }
            continue;
        }

        // ⓓ the peer is longer: k = nServer, and only the peer can produce
        // h_k. An empty prefix is a prefix of everything, so nServer === 0
        // still needs no question.
        if (nServer === 0) {
            continue;
        }
        queries.push({ id: entry.id, fieldCount: nServer });
    }

    if (queries.length === 0) {
        return { kind: "accept" };
    }
    return { kind: "query", items: queries };
}

export function encodeQuery(items: readonly QueryItem[]): Uint8Array {
    const out = new Uint8Array(QUERY_HEADER_LEN + QUERY_ENTRY_LEN * items.length);
    const view = new DataView(out.buffer);
    out[0] = QUERY_TAG;
    view.setUint32(1, items.length, true);
    let at = QUERY_HEADER_LEN;
    for (const item of items) {
        view.setUint32(at, item.id, true);
        view.setUint16(at + 4, item.fieldCount, true);
        at += QUERY_ENTRY_LEN;
    }
    return out;
}

export function decodeQuery(payload: Uint8Array): QueryItem[] | null {
    if (payload.length < QUERY_HEADER_LEN || payload[0] !== QUERY_TAG) {
        return null;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = view.getUint32(1, true);
    if (count > MAX_SCHEMA_MESSAGES) {
        return null;
    }
    if (payload.length !== QUERY_HEADER_LEN + QUERY_ENTRY_LEN * count) {
        return null;
    }

    const items: QueryItem[] = [];
    let at = QUERY_HEADER_LEN;
    for (let index = 0; index < count; index += 1) {
        const fieldCount = view.getUint16(at + 4, true);
        // The guide fixes the asked index at 1 ≤ n_s < n_c, so zero is a
        // malformed query rather than an empty-prefix question (02 §3.3.2).
        if (fieldCount < 1) {
            return null;
        }
        items.push({ id: view.getUint32(at, true), fieldCount });
        at += QUERY_ENTRY_LEN;
    }
    return items;
}

export function answerQuery(local: Schema, items: readonly QueryItem[]): ReplyItem[] | null {
    const out: ReplyItem[] = [];
    for (const item of items) {
        const mine = local.byId.get(item.id);
        if (mine === undefined || item.fieldCount > mine.prefixes.length) {
            return null;
        }
        out.push({ id: item.id, fingerprint: mine.prefixes[item.fieldCount - 1] });
    }
    return out;
}

export function encodeReply(items: readonly ReplyItem[]): Uint8Array {
    const out = new Uint8Array(REPLY_HEADER_LEN + REPLY_ENTRY_LEN * items.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, items.length, true);
    let at = REPLY_HEADER_LEN;
    for (const item of items) {
        view.setUint32(at, item.id, true);
        view.setBigUint64(at + 4, item.fingerprint, true);
        at += REPLY_ENTRY_LEN;
    }
    return out;
}

export function decodeReply(payload: Uint8Array): ReplyItem[] | null {
    if (payload.length < REPLY_HEADER_LEN) {
        return null;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = view.getUint32(0, true);
    if (count > MAX_SCHEMA_MESSAGES) {
        return null;
    }
    if (payload.length !== REPLY_HEADER_LEN + REPLY_ENTRY_LEN * count) {
        return null;
    }

    const items: ReplyItem[] = [];
    let at = REPLY_HEADER_LEN;
    for (let index = 0; index < count; index += 1) {
        items.push({ id: view.getUint32(at, true), fingerprint: view.getBigUint64(at + 4, true) });
        at += REPLY_ENTRY_LEN;
    }
    return items;
}

export function checkReply(
    local: Schema,
    asked: readonly QueryItem[],
    reply: readonly ReplyItem[],
): number {
    // The reply must carry every asked item, in the order they were asked
    // (02 §3.3.2); anything else is a malformed reply, not a conflict.
    if (reply.length !== asked.length) {
        return VERDICT_MALFORMED_HELLO;
    }
    for (let index = 0; index < asked.length; index += 1) {
        const question = asked[index];
        const answer = reply[index];
        if (answer.id !== question.id) {
            return VERDICT_MALFORMED_HELLO;
        }
        const mine = local.byId.get(question.id);
        if (mine === undefined || question.fieldCount > mine.prefixes.length) {
            return VERDICT_MALFORMED_HELLO;
        }
        if (mine.prefixes[question.fieldCount - 1] !== answer.fingerprint) {
            return VERDICT_SCHEMA_CONFLICT;
        }
    }
    return VERDICT_ACCEPT;
}
