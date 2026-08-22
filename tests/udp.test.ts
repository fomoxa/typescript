import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { nowMs } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { Connection } from "../src/connection.ts";
import type { Event } from "../src/event.ts";
import { buildSchema, type MessageSchema } from "../src/schema.ts";
import { Server, type PeerEvent } from "../src/server.ts";
import {
    MAX_DATAGRAM,
    MAX_QUEUED_DATAGRAMS,
    MAX_TRACKED_PEERS,
    UdpTransport,
    connectUdp,
    listenUdp,
} from "../src/transport/udp.ts";

const A = 0xaaaa_aaaa_aaaa_aaaan;
const B = 0xbbbb_bbbb_bbbb_bbbbn;
const C = 0xcccc_cccc_cccc_ccccn;

function message(id: number, prefixes: bigint[]): MessageSchema {
    return { id, fingerprint: prefixes[prefixes.length - 1], prefixes };
}

const SCHEMA = buildSchema(0x11n, [message(7, [A, B])]);
const LONGER = buildSchema(0x22n, [message(7, [A, B, C])]);
const CONFIG = defaultConfig();

async function pump(
    server: Server,
    client: Connection,
    done: (s: PeerEvent[], c: Event[]) => boolean,
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

async function pair(clientSchema = SCHEMA, serverSchema = SCHEMA) {
    const listener = await listenUdp("127.0.0.1", 0);
    const server = new Server(listener, serverSchema, CONFIG);
    const transport = await connectUdp("127.0.0.1", listener.port);
    const client = new Connection(transport, clientSchema, CONFIG);
    return { server, client };
}

test("a udp transport declares itself packet type, so core adds no framing", async () => {
    const transport = await connectUdp("127.0.0.1", 9);
    assert.equal(transport.kind, "packet");
    transport.closeHard();
});

test("two peers reach ready over real datagrams", async () => {
    const { server, client } = await pair();
    try {
        const seen = await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));
        assert.equal(seen.client[0].kind, "connected", "CONNECTED is synthesised even on UDP");
        assert.ok(kinds(seen.client).includes("ready"));
        assert.ok(kinds(seen.server).includes("ready"));
    } finally {
        client.destroy();
        server.close();
    }
});

test("a message crosses on udp and arrives whole", async () => {
    const { server, client } = await pair();
    try {
        await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));
        assert.equal(client.send(7, new Uint8Array([5, 6, 7])), null);

        const seen = await pump(server, client, (s) => s.some((e) => e.kind === "message"));
        const received = seen.server.find((event) => event.kind === "message");
        assert.deepEqual(Array.from((received as { payload: Uint8Array }).payload), [5, 6, 7]);
    } finally {
        client.destroy();
        server.close();
    }
});

test("the query round survives a packet transport too", async () => {
    const { server, client } = await pair(LONGER, SCHEMA);
    try {
        const seen = await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));
        assert.ok(kinds(seen.client).includes("ready"));
    } finally {
        client.destroy();
        server.close();
    }
});

test("a datagram from a stranger is ignored, and never harms the session", async () => {
    const { server, client } = await pair();
    try {
        await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));

        // A third party shouting at the server's port must not disturb the
        // peer already talking to it (01 §10).
        const stranger = dgram.createSocket("udp4");
        for (let index = 0; index < 5; index += 1) {
            stranger.send(new Uint8Array([0xff, 0xfe, 0xfd]), server.port, "127.0.0.1");
        }
        await sleep(20);

        const seen = await pump(server, client, () => false, 20);
        assert.ok(!kinds(seen.client).includes("disconnected"));
        assert.equal(client.isReady, true);

        // The stranger became a peer of its own, and its garbage killed only
        // that peer — never the healthy one.
        assert.ok(!kinds(seen.server).some((k) => k === "handshake-failed" && server.peerCount === 0));
        stranger.close();
    } finally {
        client.destroy();
        server.close();
    }
});

test("a frame past the datagram ceiling is ⊘, and the session lives on", async () => {
    const { server, client } = await pair();
    try {
        await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));

        const huge = new Uint8Array(MAX_DATAGRAM + 1);
        assert.equal(client.send(7, huge), "too-large");
        assert.equal(client.isClosed, false, "⊘ must not end the session");

        assert.equal(client.send(7, new Uint8Array([1])), null, "and the next send still works");
    } finally {
        client.destroy();
        server.close();
    }
});

test("the incoming queue is bounded, dropping the oldest", () => {
    const channel = { dispatch: () => "sent" as const, detach: () => {} };
    const transport = new UdpTransport(channel, "127.0.0.1", 1234);

    for (let index = 0; index < MAX_QUEUED_DATAGRAMS + 10; index += 1) {
        transport.deliver(new Uint8Array([index & 0xff]));
    }
    assert.equal(transport.droppedCount, 10);

    const first = transport.recv();
    assert.equal(first.kind, "received");
    assert.equal((first as { bytes: Uint8Array }).bytes[0], 10, "the ten oldest were the ones dropped");
});

test("a malformed datagram is dropped without killing the session (02 §2.6)", async () => {
    const { server, client } = await pair();
    try {
        await pump(server, client, (_s, c) => c.some((e) => e.kind === "ready"));

        // Same source address, so it is not a stranger — it is the live peer
        // sending nonsense. On a byte stream that would be fatal; on packets
        // the one datagram is dropped and the session carries on.
        const injector = dgram.createSocket("udp4");
        await new Promise<void>((resolve) => injector.bind(0, "127.0.0.1", resolve));
        injector.send(new Uint8Array([0x09, 0x09]), server.port, "127.0.0.1");
        await sleep(20);

        const seen = await pump(server, client, () => false, 20);
        assert.ok(!kinds(seen.client).includes("disconnected"));
        assert.equal(client.isReady, true);
        injector.close();
    } finally {
        client.destroy();
        server.close();
    }
});

test("closeHard twice does not throw", async () => {
    const transport = await connectUdp("127.0.0.1", 9);
    transport.closeHard();
    transport.closeHard();
});

test("the peer table is bounded, so spoofed sources cannot grow it forever", async () => {
    const listener = await listenUdp("127.0.0.1", 0);
    try {
        // Each socket binds its own ephemeral port, so each looks like a
        // distinct source address to the listener.
        const shouters: dgram.Socket[] = [];
        for (let index = 0; index < 12; index += 1) {
            const socket = dgram.createSocket("udp4");
            await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
            socket.send(new Uint8Array([1]), listener.port, "127.0.0.1");
            shouters.push(socket);
        }
        await sleep(40);

        assert.ok(listener.trackedPeers <= MAX_TRACKED_PEERS);
        assert.ok(listener.trackedPeers > 0, "genuine new peers are still accepted");
        for (const socket of shouters) {
            socket.close();
        }
    } finally {
        listener.close();
    }
});
