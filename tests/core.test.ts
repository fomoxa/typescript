import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.ts";
import { Core } from "../src/core.ts";
import { encodeData, encodeHandshake, encodeProbe } from "../src/frame.ts";
import { encodeHello } from "../src/handshake.ts";
import { buildSchema, type MessageSchema } from "../src/schema.ts";
import {
    CLOSED,
    RECV_ERROR,
    WOULD_BLOCK,
    type RecvResult,
    type SendResult,
    type Transport,
    type TransportKind,
} from "../src/transport.ts";

const A = 0xaaaa_aaaa_aaaa_aaaan;
const B = 0xbbbb_bbbb_bbbb_bbbbn;

function message(id: number, prefixes: bigint[]): MessageSchema {
    return { id, fingerprint: prefixes[prefixes.length - 1], prefixes };
}

const SCHEMA = buildSchema(0x11n, [message(7, [A, B])]);
const CONFIG = defaultConfig();

/** A transport whose every answer is scripted, so the paths a real socket
 *  will not reproduce on demand can be driven exactly. */
class FakeTransport implements Transport {
    readonly kind: TransportKind;
    readonly written: Uint8Array[] = [];

    sendAnswer: SendResult = "sent";
    private readonly inbox: RecvResult[] = [];
    softClosed = 0;
    hardClosed = 0;

    constructor(kind: TransportKind = "stream") {
        this.kind = kind;
    }

    /** Everything ever accepted, concatenated — the wire as the peer sees it. */
    get wire(): number[] {
        return this.written.flatMap((chunk) => Array.from(chunk));
    }

    queue(bytes: Uint8Array): void {
        this.inbox.push({ kind: "received", bytes });
    }

    queueResult(result: RecvResult): void {
        this.inbox.push(result);
    }

    send(bytes: Uint8Array): SendResult {
        if (this.sendAnswer === "sent") {
            this.written.push(bytes.slice());
        }
        return this.sendAnswer;
    }

    recv(): RecvResult {
        return this.inbox.shift() ?? WOULD_BLOCK;
    }

    closeSoft(): void {
        this.softClosed += 1;
    }

    closeHard(): void {
        this.hardClosed += 1;
    }
}

function readyClient(transport: FakeTransport): Core {
    const core = new Core("client", transport, SCHEMA, CONFIG, 0);
    transport.queue(encodeHandshake(new Uint8Array([0])));
    const events = core.tick(0);
    assert.ok(events.some((event) => event.kind === "ready"));
    return core;
}

test("CONNECTED is the first event, always", () => {
    const transport = new FakeTransport();
    const core = new Core("client", transport, SCHEMA, CONFIG, 0);
    assert.equal(core.tick(0)[0].kind, "connected");
    assert.ok(!core.tick(1).some((event) => event.kind === "connected"), "and only once");
});

test("a transport answering ⏸ holds the frame, and the next tick sends it once", () => {
    const transport = new FakeTransport();
    transport.sendAnswer = "would-block";

    // The hello itself is refused, so nothing has reached the wire yet.
    const core = new Core("client", transport, SCHEMA, CONFIG, 0);
    assert.equal(transport.written.length, 0);
    assert.equal(core.isCongested, true);

    core.tick(0);
    assert.equal(transport.written.length, 0, "still stuck, still not on the wire");

    transport.sendAnswer = "sent";
    core.tick(1);

    assert.deepEqual(transport.wire, Array.from(encodeHandshake(encodeHello(SCHEMA))));
    assert.equal(core.isCongested, false);
});

test("nothing is ever sent twice, and wire order is kept", () => {
    const transport = new FakeTransport();
    const core = readyClient(transport);
    transport.written.length = 0;

    transport.sendAnswer = "would-block";
    assert.equal(core.send(7, new Uint8Array([1])), null, "the application is never blocked");
    assert.equal(core.send(7, new Uint8Array([2])), "congested", "and a second send is refused");

    transport.sendAnswer = "sent";
    core.tick(1);

    assert.deepEqual(transport.wire, Array.from(encodeData(7, new Uint8Array([1]))));
    assert.equal(transport.written.length, 1, "exactly one frame, not a duplicate");
});

test("⊘ raises an error to the application and leaves the session alive", () => {
    const transport = new FakeTransport();
    const core = readyClient(transport);

    transport.sendAnswer = "too-large";
    assert.equal(core.send(7, new Uint8Array([1])), "too-large");
    assert.equal(core.session.currentState, "ready", "⊘ never ends a session");

    transport.sendAnswer = "sent";
    assert.equal(core.send(7, new Uint8Array([1])), null, "and it is never retried on its own");
});

test("a payload over the configured cap is refused before any framing", () => {
    const transport = new FakeTransport();
    const core = readyClient(transport);
    transport.written.length = 0;

    assert.equal(core.send(7, new Uint8Array(CONFIG.maxMessageBytes + 1)), "too-large");
    assert.equal(transport.written.length, 0);
});

test("a flood stops at the tick budget, and the rest is still there next tick", () => {
    const transport = new FakeTransport();
    const core = readyClient(transport);

    const flood = CONFIG.maxFramesPerTick + 20;
    for (let index = 0; index < flood; index += 1) {
        transport.queue(encodeData(7, new Uint8Array([index & 0xff])));
    }

    const first = core.tick(1).filter((event) => event.kind === "message");
    assert.equal(first.length, CONFIG.maxFramesPerTick, "the cap is honoured exactly");

    const second = core.tick(2).filter((event) => event.kind === "message");
    assert.equal(second.length, 20, "nothing the core stopped short of was lost");

    // And in order, with none skipped at the boundary.
    const all = [...first, ...second].map((event) => (event as { payload: Uint8Array }).payload[0]);
    assert.deepEqual(all, Array.from({ length: flood }, (_, index) => index & 0xff));
});

test("✖ and ⚠ arrive as different disconnect reasons", () => {
    for (const [result, reason] of [
        [CLOSED, "peer-closed"],
        [RECV_ERROR, "transport-error"],
    ] as const) {
        const transport = new FakeTransport();
        const core = readyClient(transport);
        transport.queueResult(result);

        const events = core.tick(1);
        assert.deepEqual(
            events.find((event) => event.kind === "disconnected"),
            { kind: "disconnected", reason },
        );
    }
});

test("a failed handshake soft-closes the transport and ends the session once", () => {
    const transport = new FakeTransport();
    const core = new Core("client", transport, SCHEMA, CONFIG, 0);

    transport.queue(encodeHandshake(new Uint8Array([2])));
    const events = core.tick(0);

    assert.deepEqual(
        events.find((event) => event.kind === "handshake-failed"),
        { kind: "handshake-failed", reason: "schema-conflict" },
    );
    assert.equal(transport.softClosed, 1);

    transport.queueResult(RECV_ERROR);
    const later = core.tick(1);
    assert.equal(
        later.filter((event) => event.kind === "disconnected" || event.kind === "handshake-failed").length,
        0,
        "exactly one ending event in the life of a session",
    );
});

test("a PROBE is answered inside the tick, without the application doing anything", () => {
    const transport = new FakeTransport();
    const core = readyClient(transport);
    transport.written.length = 0;

    transport.queue(encodeProbe());
    const events = core.tick(1);

    assert.deepEqual(transport.wire, [0x02], "the ACK went out on its own");
    assert.ok(events.some((event) => event.kind === "probe"));
});

test("a broken byte stream is fatal, and the decoder stays poisoned", () => {
    const transport = new FakeTransport("stream");
    const core = readyClient(transport);

    transport.queue(new Uint8Array([0x09]));
    const events = core.tick(1);

    assert.deepEqual(
        events.find((event) => event.kind === "disconnected"),
        { kind: "disconnected", reason: "transport-error" },
    );
});

test("a broken packet is dropped, and the session carries on", () => {
    const transport = new FakeTransport("packet");
    const core = readyClient(transport);

    transport.queue(new Uint8Array([0x09, 0x09]));
    transport.queue(encodeData(7, new Uint8Array([42])));
    const events = core.tick(1);

    assert.ok(!events.some((event) => event.kind === "disconnected"), "not fatal on a packet transport");
    const received = events.find((event) => event.kind === "message");
    assert.equal((received as { payload: Uint8Array }).payload[0], 42);
});

test("closing releases the transport exactly once", () => {
    const transport = new FakeTransport();
    const core = readyClient(transport);

    core.close();
    assert.equal(transport.softClosed, 1);

    core.release();
    core.release();
    assert.equal(transport.hardClosed, 1);
});
