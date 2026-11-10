import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { nowMs } from "../src/clock.ts";
import { defaultConfig, type Config } from "../src/config.ts";
import { Connection } from "../src/connection.ts";
import { Core } from "../src/core.ts";
import type { Event } from "../src/event.ts";
import {
    FRAME_HANDSHAKE,
    FRAME_HANDSHAKE_PART,
    FRAME_PROBE,
    MAX_HANDSHAKE_PARTS,
    MAX_HANDSHAKE_PAYLOAD,
    PACKET_HANDSHAKE_BUDGET,
    decodePacket,
    encodeHandshake,
    encodePart,
    encodeParts,
} from "../src/frame.ts";
import { PROTOCOL_VERSION, VERDICT_ACCEPT, VERDICT_MALFORMED_HELLO, encodeHello } from "../src/handshake.ts";
import { buildSchema, type MessageSchema, type Schema } from "../src/schema.ts";
import { Server, type PeerEvent } from "../src/server.ts";
import { WOULD_BLOCK, type RecvResult, type SendResult, type Transport, type TransportKind } from "../src/transport.ts";
import { HEADER_LENGTH, connectUdp, listenUdp } from "../src/transport/udp.ts";

const CONFIG = defaultConfig();

class FakeTransport implements Transport {
    readonly kind: TransportKind;
    readonly written: Uint8Array[] = [];
    sendAnswer: SendResult = "sent";
    private readonly inbox: RecvResult[] = [];

    constructor(kind: TransportKind = "packet") {
        this.kind = kind;
    }

    deliver(...packets: Uint8Array[]): void {
        for (const bytes of packets) {
            this.inbox.push({ kind: "received", bytes: bytes.slice() });
        }
    }

    take(): Uint8Array[] {
        return this.written.splice(0);
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

    closeSoft(): void {}

    closeHard(): void {}
}

function many(count: number): Schema {
    const messages: MessageSchema[] = [];
    for (let id = 1; id <= count; id += 1) {
        messages.push({ id, fingerprint: BigInt(id), prefixes: [BigInt(id)] });
    }
    return buildSchema(0xc0ffee00n + BigInt(count), messages);
}

function client(schema: Schema, kind: TransportKind = "packet") {
    const transport = new FakeTransport(kind);
    const core = new Core("client", transport, schema, CONFIG, 0);
    return { core, transport };
}

function server(schema: Schema, config: Config = CONFIG) {
    const transport = new FakeTransport();
    const core = new Core("server", transport, schema, config, 0);
    return { core, transport };
}

function helloParts(schema: Schema): Uint8Array[] {
    return client(schema).transport.take();
}

const u16 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(at, true);
const u32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
const has = (events: readonly { kind: string }[], kind: string) => events.some((event) => event.kind === kind);

function verdict(transport: FakeTransport): number {
    const sent = transport.take();
    assert.ok(sent.length > 0, "something was sent");
    const frame = decodePacket(sent[sent.length - 1], CONFIG.maxMessageBytes);
    assert.equal(frame.type, FRAME_HANDSHAKE, "the last packet is a handshake frame");
    assert.equal(frame.payload.length, 1, "a verdict is one byte");
    return frame.payload[0];
}

function refusedWith(schema: Schema, ...packets: Uint8Array[]): void {
    const side = server(schema);
    side.transport.deliver(...packets);
    assert.ok(has(side.core.tick(0), "handshake-failed"), "the server refused");
    assert.equal(verdict(side.transport), VERDICT_MALFORMED_HELLO);
}

test("a hello of 62 messages leaves as one HANDSHAKE frame, as before", () => {
    const sent = client(many(62)).transport.take();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], FRAME_HANDSHAKE);
    assert.equal(sent[0].length, 5 + 16 + 14 * 62);
});

test("a hello of 63 messages on a packet transport leaves in two parts", () => {
    const schema = many(63);
    const [first, second, ...rest] = helloParts(schema);
    assert.equal(rest.length, 0, "two parts and nothing else");
    assert.equal(first[0], FRAME_HANDSHAKE_PART);
    assert.equal(second[0], FRAME_HANDSHAKE_PART);
    assert.equal(u16(first, 1), 0);
    assert.equal(u16(second, 1), 1);
    assert.equal(u16(first, 3), 2);
    assert.equal(u16(second, 3), 2);
    assert.equal(u32(first, 5), 891);
    assert.equal(u32(second, 5), 7);

    const joined = new Uint8Array([...first.subarray(9), ...second.subarray(9)]);
    assert.deepEqual(joined, encodeHello(schema), "the parts carry the hello unchanged");
});

test("every part is at most 900 bytes and only the last one is short", () => {
    const parts = helloParts(many(500));
    assert.equal(parts.length, Math.ceil((16 + 14 * 500) / 891));
    parts.forEach((part, index) => {
        assert.ok(part.length <= 900, `part ${index} fits 900 bytes`);
        assert.ok(index === parts.length - 1 || part.length === 900, `part ${index} is full unless it is the last`);
    });
});

test("a stream transport sends a large hello as one HANDSHAKE frame", () => {
    const sent = client(many(200), "stream").transport.take();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], FRAME_HANDSHAKE);
    assert.equal(sent[0].length, 5 + 16 + 14 * 200);
});

test("a server assembles a hello sent in parts and accepts it", () => {
    const schema = many(200);
    const near = client(schema);
    const far = server(schema);

    far.transport.deliver(...near.transport.take());
    assert.ok(has(far.core.tick(0), "ready"), "the server accepted");

    near.transport.deliver(...far.transport.take());
    assert.ok(has(near.core.tick(0), "ready"), "the client got the verdict");
});

test("parts that arrive in reverse order are assembled", () => {
    const schema = many(200);
    const side = server(schema);
    side.transport.deliver(...helloParts(schema).reverse());
    assert.ok(has(side.core.tick(0), "ready"));
    assert.equal(verdict(side.transport), VERDICT_ACCEPT);
});

test("a repeated identical part is ignored", () => {
    const schema = many(200);
    const parts = helloParts(schema);
    const side = server(schema);
    side.transport.deliver(parts[0], parts[0], ...parts.slice(1));
    assert.ok(has(side.core.tick(0), "ready"));
    assert.equal(verdict(side.transport), VERDICT_ACCEPT);
});

test("a part that differs from an earlier copy is refused with 3", () => {
    const schema = many(200);
    const parts = helloParts(schema);
    const altered = parts[0].slice();
    altered[20] ^= 0xff;
    refusedWith(schema, parts[0], altered);
});

test("a part whose count changes is refused with 3", () => {
    refusedWith(many(200), encodePart(0, 3, new Uint8Array(891)), encodePart(1, 4, new Uint8Array(891)));
});

test("a short part before the last one is refused with 3", () => {
    refusedWith(many(200), encodePart(0, 3, new Uint8Array(890)));
});

test("an empty last part is refused with 3", () => {
    refusedWith(many(200), encodePart(0, 2, new Uint8Array(891)), encodePart(1, 2, new Uint8Array(0)));
});

test("a part count of 1 is refused with 3", () => {
    const schema = many(62);
    refusedWith(schema, encodePart(0, 1, encodeHello(schema)));
});

test("a part count past 1 177 is refused with 3", () => {
    refusedWith(many(200), encodePart(0, MAX_HANDSHAKE_PARTS + 1, new Uint8Array(891)));
});

test("a part index past the count is refused with 3", () => {
    refusedWith(many(200), encodePart(2, 2, new Uint8Array(891)));
});

test("a part carrying more than 891 bytes is dropped as a broken packet", () => {
    const schema = many(200);
    const side = server(schema);
    side.transport.deliver(encodePart(0, 2, new Uint8Array(892)));
    assert.ok(!has(side.core.tick(0), "handshake-failed"), "the handshake goes on");
    assert.equal(side.transport.written.length, 0, "no verdict was sent");

    side.transport.deliver(...helloParts(schema));
    assert.ok(has(side.core.tick(0), "ready"));
    assert.equal(verdict(side.transport), VERDICT_ACCEPT, "a correct hello is still accepted");
});

test("a HANDSHAKE frame arriving while parts are pending is refused with 3", () => {
    const schema = many(200);
    refusedWith(schema, helloParts(schema)[0], encodeHandshake(encodeHello(schema)));
});

test("content assembled past 1 MiB is refused with 3", () => {
    const entries = 74_900;
    const schema = many(1);
    const hello = new Uint8Array(16 + 14 * entries);
    const view = new DataView(hello.buffer);
    view.setUint32(0, PROTOCOL_VERSION, true);
    view.setBigUint64(4, schema.fingerprint, true);
    view.setUint32(12, entries, true);
    assert.ok(hello.length > MAX_HANDSHAKE_PAYLOAD, "the hello is past 1 MiB");

    const parts = encodeParts(hello);
    assert.ok(parts.length <= MAX_HANDSHAKE_PARTS, "within the part ceiling");
    const side = server(schema, { ...CONFIG, maxFramesPerTick: 2048 });
    side.transport.deliver(...parts);
    assert.ok(has(side.core.tick(0), "handshake-failed"));
    assert.equal(verdict(side.transport), VERDICT_MALFORMED_HELLO);
});

test("a part after the handshake is dropped and is not activity", () => {
    const schema = many(1);
    const side = server(schema);
    side.transport.deliver(encodeHandshake(encodeHello(schema)));
    assert.ok(has(side.core.tick(0), "ready"));
    assert.equal(verdict(side.transport), VERDICT_ACCEPT);

    const interval = CONFIG.heartbeatIntervalMs;
    side.transport.deliver(encodePart(0, 2, new Uint8Array(891)));
    assert.deepEqual(side.core.tick(interval - 1), [], "no event");
    assert.equal(side.transport.written.length, 0, "nothing sent");
    assert.equal(side.core.session.currentState, "ready", "still ready");

    side.core.tick(interval);
    const sent = side.transport.take();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], FRAME_PROBE, "the dropped part was not activity");
});

test("a part on a byte stream is a fatal framing error", () => {
    const transport = new FakeTransport("stream");
    const core = new Core("server", transport, many(1), CONFIG, 0);
    transport.deliver(encodePart(0, 2, new Uint8Array(891)));
    const events = core.tick(0);
    const ended = events.find((event) => event.kind === "disconnected");
    assert.ok(ended !== undefined, "the session ended");
    assert.equal((ended as { reason: string }).reason, "transport-error");
});

test("the client fails on a broken answer sent in parts", () => {
    const side = client(many(1));
    side.transport.take();
    side.transport.deliver(encodePart(0, 2, new Uint8Array(891)), encodePart(1, 2, new Uint8Array(0)));
    const failed = side.core.tick(0).find((event) => event.kind === "handshake-failed");
    assert.ok(failed !== undefined, "the client failed");
    assert.equal((failed as { reason: string }).reason, "malformed-peer");
});

test("a query and its reply that exceed the budget both travel in parts", () => {
    const messages = 160;
    const clientMessages: MessageSchema[] = [];
    const serverMessages: MessageSchema[] = [];
    for (let id = 1; id <= messages; id += 1) {
        clientMessages.push({ id, fingerprint: BigInt(id * 10 + 1), prefixes: [BigInt(id * 10), BigInt(id * 10 + 1)] });
        serverMessages.push({ id, fingerprint: BigInt(id * 10), prefixes: [BigInt(id * 10)] });
    }
    const near = client(buildSchema(1n, clientMessages));
    const far = server(buildSchema(2n, serverMessages));

    far.transport.deliver(...near.transport.take());
    far.core.tick(0);
    const query = far.transport.take();
    assert.equal(query.length, 2, "the query leaves in two parts");
    assert.equal(query[0][0], FRAME_HANDSHAKE_PART);

    near.transport.deliver(...query);
    near.core.tick(0);
    const reply = near.transport.take();
    assert.equal(reply.length, 3, "the reply leaves in three parts");

    far.transport.deliver(...reply);
    assert.ok(has(far.core.tick(0), "ready"), "the server is ready");
    assert.equal(verdict(far.transport), VERDICT_ACCEPT);
});

test("parts held back by a blocked socket leave later as separate packets", () => {
    const transport = new FakeTransport();
    transport.sendAnswer = "would-block";
    const core = new Core("client", transport, many(200), CONFIG, 0);
    assert.equal(transport.written.length, 0, "nothing left while blocked");
    assert.equal(core.isCongested, true, "the parts are waiting");

    transport.sendAnswer = "sent";
    core.tick(0);
    const parts = transport.take();
    assert.equal(parts.length, Math.ceil((16 + 14 * 200) / 891), "one packet per part");
    for (const part of parts) {
        assert.equal(part[0], FRAME_HANDSHAKE_PART);
        assert.equal(part.length, 9 + u32(part, 5), "each packet holds exactly one part");
    }
    assert.equal(core.isCongested, false, "nothing is waiting any more");
});

test("a hello of more than 8 parts held by a blocked socket does not hit the ceiling", () => {
    const transport = new FakeTransport();
    transport.sendAnswer = "would-block";
    const core = new Core("client", transport, many(5000), CONFIG, 0);
    assert.ok(!has(core.tick(0), "disconnected"), "the session is still open");

    transport.sendAnswer = "sent";
    core.tick(0);
    assert.equal(transport.written.length, Math.ceil((16 + 14 * 5000) / 891), "every part left");
});

test("a pending part counts as activity for the server", () => {
    const schema = many(200);
    const parts = helloParts(schema);
    const side = server(schema);
    const almost = CONFIG.handshakeTimeoutMs - 1;
    side.transport.deliver(parts[0]);
    side.core.tick(almost);
    side.core.tick(almost + almost);
    assert.equal(side.transport.written.length, 0, "no probe while parts keep the peer active");
});

test("a handshake part has the layout of 02 §2.8", () => {
    const part = encodePart(3, 5, new Uint8Array([0xaa, 0xbb]));
    assert.deepEqual(Array.from(part), [0x04, 0x03, 0x00, 0x05, 0x00, 0x02, 0x00, 0x00, 0x00, 0xaa, 0xbb]);
    const frame = decodePacket(part, CONFIG.maxMessageBytes);
    assert.equal(frame.type, FRAME_HANDSHAKE_PART);
    assert.deepEqual(Array.from(frame.payload), [0x03, 0x00, 0x05, 0x00, 0x02, 0x00, 0x00, 0x00, 0xaa, 0xbb]);
});

test("udp carries a 300-message handshake in datagrams of at most 908 bytes", async () => {
    assert.ok(HEADER_LENGTH + PACKET_HANDSHAKE_BUDGET <= 908, "a handshake datagram is at most 908 bytes");
    const schema = many(300);
    const listener = await listenUdp("127.0.0.1", 0);
    const far = new Server(listener, schema, CONFIG);
    const near = new Connection(await connectUdp("127.0.0.1", listener.port), schema, CONFIG);
    const serverEvents: PeerEvent[] = [];
    const clientEvents: Event[] = [];
    try {
        for (let round = 0; round < 300; round += 1) {
            const now = nowMs();
            serverEvents.push(...far.tick(now));
            clientEvents.push(...near.tick(now));
            if (has(clientEvents, "ready") && has(serverEvents, "ready")) {
                break;
            }
            await sleep(2);
        }
        assert.ok(has(clientEvents, "ready"), "the client became ready");
        assert.ok(has(serverEvents, "ready"), "the server accepted the peer");
    } finally {
        near.destroy();
        far.close();
    }
});
