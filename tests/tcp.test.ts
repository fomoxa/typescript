import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { nowMs } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { connect } from "../src/connection.ts";
import type { Event } from "../src/event.ts";
import { buildSchema, type MessageSchema } from "../src/schema.ts";
import { listen, type PeerEvent, type Server } from "../src/server.ts";
import type { Connection } from "../src/connection.ts";

const A = 0xaaaa_aaaa_aaaa_aaaan;
const B = 0xbbbb_bbbb_bbbb_bbbbn;
const C = 0xcccc_cccc_cccc_ccccn;

function message(id: number, prefixes: bigint[]): MessageSchema {
    return { id, fingerprint: prefixes[prefixes.length - 1], prefixes };
}

const SCHEMA = buildSchema(0x11n, [message(7, [A, B])]);
const LONGER = buildSchema(0x22n, [message(7, [A, B, C])]);
const CONFLICTING = buildSchema(0x33n, [message(7, [A, 0x9999_9999_9999_9999n])]);

const CONFIG = defaultConfig();

/** Pumps both sides until `done` says so, letting the event loop deliver
 *  bytes between ticks. Real sockets, no fakes. */
async function pump(
    server: Server,
    client: Connection,
    done: (serverEvents: PeerEvent[], clientEvents: Event[]) => boolean,
    rounds = 300,
): Promise<{ server: PeerEvent[]; client: Event[] }> {
    const serverEvents: PeerEvent[] = [];
    const clientEvents: Event[] = [];

    for (let round = 0; round < rounds; round += 1) {
        const now = nowMs();
        serverEvents.push(...server.tick(now));
        clientEvents.push(...client.tick(now));
        if (done(serverEvents, clientEvents)) {
            break;
        }
        await sleep(2);
    }
    return { server: serverEvents, client: clientEvents };
}

const kinds = (events: readonly { kind: string }[]) => events.map((event) => event.kind);

test("two peers on the same schema reach ready over a real socket", async () => {
    const server = await listen("127.0.0.1", 0, SCHEMA, CONFIG);
    const client = await connect("127.0.0.1", server.port, SCHEMA, CONFIG);

    try {
        const seen = await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));

        assert.equal(seen.client[0].kind, "connected", "CONNECTED is always the first event");
        assert.ok(kinds(seen.client).includes("ready"));
        assert.ok(kinds(seen.server).includes("ready"));
        assert.equal(client.isReady, true);
        assert.equal(server.peerCount, 1);
    } finally {
        client.destroy();
        server.close();
    }
});

test("a message travels once the session is ready", async () => {
    const server = await listen("127.0.0.1", 0, SCHEMA, CONFIG);
    const client = await connect("127.0.0.1", server.port, SCHEMA, CONFIG);

    try {
        await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));

        assert.equal(client.send(7, new Uint8Array([1, 2, 3, 4])), null);

        const seen = await pump(server, client, (s) => s.some((e) => e.kind === "message"));
        const received = seen.server.find((event) => event.kind === "message");

        assert.notEqual(received, undefined);
        assert.equal((received as { messageId: number }).messageId, 7);
        assert.deepEqual(
            Array.from((received as { payload: Uint8Array }).payload),
            [1, 2, 3, 4],
        );
    } finally {
        client.destroy();
        server.close();
    }
});

test("sending before ready is refused, not queued", async () => {
    const server = await listen("127.0.0.1", 0, SCHEMA, CONFIG);
    const client = await connect("127.0.0.1", server.port, SCHEMA, CONFIG);

    try {
        assert.equal(client.send(7, new Uint8Array([1])), "not-ready");
    } finally {
        client.destroy();
        server.close();
    }
});

// The case the whole prefix design exists for: RFC-0003 §8.6 V-001/V-002 at
// the handshake layer, over a real socket and through the query round.
test("a client that appended a field still connects, via the query round", async () => {
    const server = await listen("127.0.0.1", 0, SCHEMA, CONFIG);
    const client = await connect("127.0.0.1", server.port, LONGER, CONFIG);

    try {
        const seen = await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));
        assert.ok(kinds(seen.client).includes("ready"), "a longer client MUST NOT be rejected");
        assert.ok(!kinds(seen.client).includes("handshake-failed"));
    } finally {
        client.destroy();
        server.close();
    }
});

test("a server that dropped a trailing field still connects, with no query", async () => {
    const server = await listen("127.0.0.1", 0, LONGER, CONFIG);
    const client = await connect("127.0.0.1", server.port, SCHEMA, CONFIG);

    try {
        const seen = await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));
        assert.ok(kinds(seen.client).includes("ready"));
    } finally {
        client.destroy();
        server.close();
    }
});

test("a genuine schema conflict is refused with reason 2 on both ends", async () => {
    const server = await listen("127.0.0.1", 0, SCHEMA, CONFIG);
    const client = await connect("127.0.0.1", server.port, CONFLICTING, CONFIG);

    try {
        const seen = await pump(server, client, (_s, c) =>
            c.some((e) => e.kind === "handshake-failed"),
        );

        const failure = seen.client.find((event) => event.kind === "handshake-failed");
        assert.deepEqual(failure, { kind: "handshake-failed", reason: "schema-conflict" });

        // Exactly one ending event, even though the transport dies right after
        // the verdict (02 §7).
        assert.equal(
            seen.client.filter((e) => e.kind === "handshake-failed" || e.kind === "disconnected").length,
            1,
        );
    } finally {
        client.destroy();
        server.close();
    }
});

test("a peer that goes away raises exactly one disconnect", async () => {
    const server = await listen("127.0.0.1", 0, SCHEMA, CONFIG);
    const client = await connect("127.0.0.1", server.port, SCHEMA, CONFIG);

    try {
        await pump(server, client, (s) => s.some((e) => e.kind === "ready"));
        client.destroy();

        const seen = await pump(server, client, (s) => s.some((e) => e.kind === "disconnected"));
        const endings = seen.server.filter((e) => e.kind === "disconnected");

        assert.equal(endings.length, 1);
        assert.equal(server.peerCount, 0, "a closed peer is reaped");
    } finally {
        server.close();
    }
});
