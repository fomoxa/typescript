import assert from "node:assert/strict";
import test from "node:test";

import {
    FRAME_ACK,
    FRAME_DATA,
    FRAME_HANDSHAKE,
    FRAME_PROBE,
    FrameFormatError,
    MAX_MESSAGE_PAYLOAD,
    StreamDecoder,
    decodeFrame,
    decodePacket,
    encodeAck,
    encodeData,
    encodeHandshake,
    encodeProbe,
} from "../src/frame.ts";

const CAP = MAX_MESSAGE_PAYLOAD;

test("a DATA frame matches the byte table in 02 §2.2", () => {
    const encoded = encodeData(42, new Uint8Array([1, 2, 3]));
    assert.deepEqual(
        Array.from(encoded),
        [0x00, 0x43, 0x59, 0x2a, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 1, 2, 3],
    );
    assert.equal(encoded.length, 11 + 3);
});

test("a HANDSHAKE frame matches the byte table in 02 §2.3", () => {
    const encoded = encodeHandshake(new Uint8Array([0xaa]));
    assert.deepEqual(Array.from(encoded), [0x03, 0x01, 0x00, 0x00, 0x00, 0xaa]);
    assert.equal(encoded.length, 5 + 1);
});

test("PROBE and ACK are one byte each, with no body", () => {
    assert.deepEqual(Array.from(encodeProbe()), [0x01]);
    assert.deepEqual(Array.from(encodeAck()), [0x02]);
    assert.equal(decodeFrame(encodeProbe(), CAP).frame.type, FRAME_PROBE);
    assert.equal(decodeFrame(encodeAck(), CAP).frame.type, FRAME_ACK);
});

test("every frame type survives an encode/decode round trip", () => {
    const payload = new Uint8Array([9, 8, 7, 6]);

    const data = decodeFrame(encodeData(7, payload), CAP).frame;
    assert.equal(data.type, FRAME_DATA);
    assert.equal(data.messageId, 7);
    assert.deepEqual(Array.from(data.payload), Array.from(payload));

    const handshake = decodeFrame(encodeHandshake(payload), CAP).frame;
    assert.equal(handshake.type, FRAME_HANDSHAKE);
    assert.deepEqual(Array.from(handshake.payload), Array.from(payload));
});

test("a stream decoder fed one byte at a time still yields whole frames", () => {
    const stream = new Uint8Array([
        ...encodeData(1, new Uint8Array([10, 20])),
        ...encodeProbe(),
        ...encodeHandshake(new Uint8Array([0])),
    ]);

    const decoder = new StreamDecoder(CAP);
    const seen: number[] = [];
    for (const byte of stream) {
        decoder.feed(new Uint8Array([byte]));
        for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
            seen.push(frame.type);
        }
    }
    assert.deepEqual(seen, [FRAME_DATA, FRAME_PROBE, FRAME_HANDSHAKE]);
});

test("several frames arriving in one chunk are all split out", () => {
    const decoder = new StreamDecoder(CAP);
    decoder.feed(
        new Uint8Array([
            ...encodeProbe(),
            ...encodeAck(),
            ...encodeData(3, new Uint8Array([1])),
        ]),
    );
    const seen: number[] = [];
    for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
        seen.push(frame.type);
    }
    assert.deepEqual(seen, [FRAME_PROBE, FRAME_ACK, FRAME_DATA]);
    assert.equal(decoder.buffered, 0);
});

test("a bad type byte poisons a stream decoder permanently (02 §2.5)", () => {
    const decoder = new StreamDecoder(CAP);
    decoder.feed(new Uint8Array([9]));
    assert.throws(() => decoder.next(), (error: FrameFormatError) => error.code === "unknown-type");
    assert.equal(decoder.poisoned, true);

    decoder.feed(encodeProbe());
    assert.throws(() => decoder.next(), (error: FrameFormatError) => error.code === "unknown-type");
});

test("a wrong magic byte is a frame error, not a short read", () => {
    const broken = encodeData(1, new Uint8Array([1]));
    broken[2] = 0x58;
    assert.throws(() => decodeFrame(broken, CAP), (error: FrameFormatError) => error.code === "bad-magic");
});

test("a packet that ends early and one with trailing bytes are both broken (02 §2.6)", () => {
    const frame = encodeData(1, new Uint8Array([1, 2, 3]));

    assert.throws(
        () => decodePacket(frame.subarray(0, frame.length - 1), CAP),
        (error: FrameFormatError) => error.code === "incomplete",
    );

    const padded = new Uint8Array(frame.length + 1);
    padded.set(frame, 0);
    assert.throws(() => decodePacket(padded, CAP), (error: FrameFormatError) => error.code === "trailing");
});

test("payload exactly at the cap passes, one byte over is refused (02 §2.7)", () => {
    const header = new Uint8Array(11);
    const view = new DataView(header.buffer);
    header[0] = FRAME_DATA;
    header[1] = 0x43;
    header[2] = 0x59;
    view.setUint32(3, 1, true);

    view.setUint32(7, MAX_MESSAGE_PAYLOAD, true);
    assert.throws(
        () => decodeFrame(header, CAP),
        (error: FrameFormatError) => error.code === "incomplete",
        "at the cap the length is legal, so it only lacks bytes",
    );

    view.setUint32(7, MAX_MESSAGE_PAYLOAD + 1, true);
    assert.throws(
        () => decodeFrame(header, CAP),
        (error: FrameFormatError) => error.code === "message-too-large",
    );
});
