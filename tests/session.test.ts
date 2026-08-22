import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.ts";
import { FRAME_ACK, FRAME_DATA, FRAME_HANDSHAKE, FRAME_PROBE, type Frame } from "../src/frame.ts";
import { decodeHello, encodeHello } from "../src/handshake.ts";
import { buildSchema } from "../src/schema.ts";
import { Session } from "../src/session.ts";

const A = 0xaaaa_aaaa_aaaa_aaaan;
const SCHEMA = buildSchema(0x1n, [{ id: 7, fingerprint: A, prefixes: [A] }]);
const CONFIG = defaultConfig();

function frame(type: number, payload: Uint8Array = new Uint8Array(0), messageId = 0): Frame {
    return { type, messageId, payload };
}

function readyClient(now = 0): Session {
    const client = new Session("client", SCHEMA, CONFIG, now);
    client.opening();
    const reaction = client.onFrame(frame(FRAME_HANDSHAKE, new Uint8Array([0])), now);
    assert.deepEqual(reaction.event, { kind: "ready" });
    return client;
}

test("the client's opening carries a hello, the server's carries nothing", () => {
    const client = new Session("client", SCHEMA, CONFIG, 0);
    const out = client.opening().out;
    assert.equal(out?.kind, "handshake");
    assert.notEqual(decodeHello((out as { payload: Uint8Array }).payload), null);

    const server = new Session("server", SCHEMA, CONFIG, 0);
    assert.equal(server.opening().out, undefined);
});

test("a server accepting a hello answers verdict 0 and goes ready in one step", () => {
    const server = new Session("server", SCHEMA, CONFIG, 0);
    const reaction = server.onFrame(frame(FRAME_HANDSHAKE, encodeHello(SCHEMA)), 0);
    assert.deepEqual(reaction.event, { kind: "ready" });
    assert.deepEqual((reaction.out as { payload: Uint8Array }).payload, new Uint8Array([0]));
    assert.equal(server.isReady, true);
});

test("a refusal sends the verdict AND ends the session — the one case with both", () => {
    const server = new Session("server", SCHEMA, CONFIG, 0);
    const reaction = server.onFrame(frame(FRAME_HANDSHAKE, new Uint8Array([1, 2, 3])), 0);
    assert.deepEqual((reaction.out as { payload: Uint8Array }).payload, new Uint8Array([3]));
    assert.deepEqual(reaction.event, { kind: "handshake-failed", reason: "malformed-hello" });
    assert.equal(server.currentState, "closed");
});

test("a client still handshaking answers a PROBE, and raises no event (02 §3.6)", () => {
    const client = new Session("client", SCHEMA, CONFIG, 0);
    client.opening();
    const reaction = client.onFrame(frame(FRAME_PROBE), 0);
    assert.equal(reaction.out?.kind, "ack");
    assert.equal(reaction.event, undefined);
});

test("DATA arriving before READY is dropped and never reaches the application", () => {
    const client = new Session("client", SCHEMA, CONFIG, 0);
    client.opening();
    const reaction = client.onFrame(frame(FRAME_DATA, new Uint8Array([1, 2]), 7), 0);
    assert.deepEqual(reaction, {});
});

// The two roles only differ visibly when the handshake deadline is wider than
// the heartbeat interval. Both default to 5000ms, so these two cases need a
// config that pulls them apart.
const SPREAD = { ...CONFIG, handshakeTimeoutMs: 8_000, heartbeatIntervalMs: 2_000 };

test("a client runs no heartbeat while handshaking, only its hard deadline", () => {
    const client = new Session("client", SCHEMA, SPREAD, 0);
    client.opening();

    for (let now = 0; now < SPREAD.handshakeTimeoutMs; now += 100) {
        assert.equal(client.tick(now).out, undefined, `no probe may be sent at ${now}ms`);
    }

    const expired = client.tick(SPREAD.handshakeTimeoutMs);
    assert.deepEqual(expired.event, { kind: "handshake-failed", reason: "timeout" });
    assert.equal(expired.out, undefined);
});

test("a server DOES run a heartbeat while its peer is handshaking, on the wider window", () => {
    const server = new Session("server", SCHEMA, SPREAD, 0);

    assert.deepEqual(
        server.tick(SPREAD.heartbeatIntervalMs),
        {},
        "the narrow READY window must not be used while handshaking",
    );
    assert.equal(server.tick(SPREAD.handshakeTimeoutMs).out?.kind, "probe");
});

test("a server peer that keeps answering probes is never timed out (02 §3.5)", () => {
    const server = new Session("server", SCHEMA, CONFIG, 0);
    let now = 0;

    for (let round = 0; round < 50; round += 1) {
        now += CONFIG.handshakeTimeoutMs;
        assert.equal(server.tick(now).out?.kind, "probe");
        now += 1;
        server.onFrame(frame(FRAME_ACK), now);
    }
    assert.equal(server.currentState, "handshaking", "no absolute cap may be invented");
});

test("silence sends exactly one probe, not one per tick (02 §4.5)", () => {
    const client = readyClient();
    let probes = 0;

    for (let now = 0; now <= CONFIG.heartbeatIntervalMs * 2; now += 100) {
        if (client.tick(now).out?.kind === "probe") {
            probes += 1;
        }
    }
    assert.equal(probes, 1);
});

test("traffic keeps a session probe-free", () => {
    const client = readyClient();
    let probes = 0;

    for (let now = 0; now <= 60_000; now += 1_000) {
        if (client.tick(now).out?.kind === "probe") {
            probes += 1;
        }
        client.onFrame(frame(FRAME_DATA, new Uint8Array([1]), 7), now);
    }
    assert.equal(probes, 0);
});

test("any frame clears an outstanding probe, not just an ACK", () => {
    for (const type of [FRAME_ACK, FRAME_PROBE, FRAME_DATA]) {
        const client = readyClient();
        assert.equal(client.tick(CONFIG.heartbeatIntervalMs).out?.kind, "probe");

        client.onFrame(frame(type, new Uint8Array(0), 7), CONFIG.heartbeatIntervalMs + 1);
        const later = client.tick(CONFIG.heartbeatIntervalMs + CONFIG.heartbeatTimeoutMs + 2);
        assert.notDeepEqual(later.event, { kind: "disconnected", reason: "unresponsive" });
    }
});

test("a probe with no answer inside the timeout declares the peer dead", () => {
    const client = readyClient();
    assert.equal(client.tick(CONFIG.heartbeatIntervalMs).out?.kind, "probe");

    const dead = client.tick(CONFIG.heartbeatIntervalMs + CONFIG.heartbeatTimeoutMs);
    assert.deepEqual(dead.event, { kind: "disconnected", reason: "unresponsive" });
    assert.equal(client.currentState, "closed");
});

test("a whole expiry cycle runs without waiting — time is a parameter (B8)", () => {
    const started = Date.now();
    const client = readyClient();
    client.tick(CONFIG.heartbeatIntervalMs);
    const dead = client.tick(CONFIG.heartbeatIntervalMs + CONFIG.heartbeatTimeoutMs);
    assert.deepEqual(dead.event, { kind: "disconnected", reason: "unresponsive" });
    assert.ok(Date.now() - started < 1_000, "20 seconds of protocol time, no real waiting");
});

test("a failed handshake is followed by no disconnect event (02 §7)", () => {
    const client = new Session("client", SCHEMA, CONFIG, 0);
    client.opening();
    const failed = client.onFrame(frame(FRAME_HANDSHAKE, new Uint8Array([2])), 0);
    assert.deepEqual(failed.event, { kind: "handshake-failed", reason: "schema-conflict" });

    assert.deepEqual(client.transportClosed("transport-error"), {}, "exactly one ending event");
});

test("a second query is malformed-peer, and the deadline never resets", () => {
    const client = new Session("client", SCHEMA, CONFIG, 0);
    client.opening();

    const query = new Uint8Array([4, 1, 0, 0, 0, 7, 0, 0, 0, 1, 0]);
    assert.equal(client.onFrame(frame(FRAME_HANDSHAKE, query), 100).out?.kind, "handshake");

    const second = client.onFrame(frame(FRAME_HANDSHAKE, query), 200);
    assert.deepEqual(second.event, { kind: "handshake-failed", reason: "malformed-peer" });
});

test("the client's deadline covers the whole handshake, query round included", () => {
    const client = new Session("client", SCHEMA, CONFIG, 0);
    client.opening();

    const query = new Uint8Array([4, 1, 0, 0, 0, 7, 0, 0, 0, 1, 0]);
    client.onFrame(frame(FRAME_HANDSHAKE, query), CONFIG.handshakeTimeoutMs - 1);

    const expired = client.tick(CONFIG.handshakeTimeoutMs);
    assert.deepEqual(expired.event, { kind: "handshake-failed", reason: "timeout" });
});

test("a verdict of 5 or more is a malformed peer", () => {
    const client = new Session("client", SCHEMA, CONFIG, 0);
    client.opening();
    const reaction = client.onFrame(frame(FRAME_HANDSHAKE, new Uint8Array([5])), 0);
    assert.deepEqual(reaction.event, { kind: "handshake-failed", reason: "malformed-peer" });
});
