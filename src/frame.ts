export const FRAME_DATA = 0;
export const FRAME_PROBE = 1;
export const FRAME_ACK = 2;
export const FRAME_HANDSHAKE = 3;
export const FRAME_HANDSHAKE_PART = 4;

export const MAGIC_C = 0x43;
export const MAGIC_Y = 0x59;

export const DATA_HEADER_LEN = 11;
export const HANDSHAKE_HEADER_LEN = 5;
export const PART_HEADER_LEN = 9;

export const MAX_MESSAGE_PAYLOAD = 16 * 1024 * 1024;
export const MAX_HANDSHAKE_PAYLOAD = 1 * 1024 * 1024;

export const PACKET_HANDSHAKE_BUDGET = 900;
export const PART_CONTENT_LEN = PACKET_HANDSHAKE_BUDGET - PART_HEADER_LEN;
export const MAX_HANDSHAKE_PARTS = Math.ceil(MAX_HANDSHAKE_PAYLOAD / PART_CONTENT_LEN);

export type FrameError =
    | "incomplete"
    | "unknown-type"
    | "bad-magic"
    | "message-too-large"
    | "handshake-too-large"
    | "part-too-large"
    | "part-on-stream"
    | "truncated"
    | "trailing";

export interface Frame {
    readonly type: number;
    readonly messageId: number;
    readonly payload: Uint8Array;
}

export class FrameFormatError extends Error {
    readonly code: FrameError;

    constructor(code: FrameError) {
        super(code);
        this.name = "FrameFormatError";
        this.code = code;
    }
}

export function dataFrameLength(payloadLength: number): number {
    return DATA_HEADER_LEN + payloadLength;
}

export function handshakeFrameLength(payloadLength: number): number {
    return HANDSHAKE_HEADER_LEN + payloadLength;
}

export function encodeData(messageId: number, payload: Uint8Array): Uint8Array {
    if (payload.length > MAX_MESSAGE_PAYLOAD) {
        throw new FrameFormatError("message-too-large");
    }
    const out = new Uint8Array(dataFrameLength(payload.length));
    const view = new DataView(out.buffer);
    out[0] = FRAME_DATA;
    out[1] = MAGIC_C;
    out[2] = MAGIC_Y;
    view.setUint32(3, messageId, true);
    view.setUint32(7, payload.length, true);
    out.set(payload, DATA_HEADER_LEN);
    return out;
}

export function encodeHandshake(payload: Uint8Array): Uint8Array {
    if (payload.length > MAX_HANDSHAKE_PAYLOAD) {
        throw new FrameFormatError("handshake-too-large");
    }
    const out = new Uint8Array(handshakeFrameLength(payload.length));
    const view = new DataView(out.buffer);
    out[0] = FRAME_HANDSHAKE;
    view.setUint32(1, payload.length, true);
    out.set(payload, HANDSHAKE_HEADER_LEN);
    return out;
}

export function encodePart(index: number, count: number, content: Uint8Array): Uint8Array {
    const out = new Uint8Array(PART_HEADER_LEN + content.length);
    const view = new DataView(out.buffer);
    out[0] = FRAME_HANDSHAKE_PART;
    view.setUint16(1, index, true);
    view.setUint16(3, count, true);
    view.setUint32(5, content.length, true);
    out.set(content, PART_HEADER_LEN);
    return out;
}

export function encodeParts(payload: Uint8Array): Uint8Array[] {
    const count = Math.ceil(payload.length / PART_CONTENT_LEN);
    const parts: Uint8Array[] = [];
    for (let index = 0; index < count; index += 1) {
        const offset = index * PART_CONTENT_LEN;
        parts.push(encodePart(index, count, payload.subarray(offset, offset + PART_CONTENT_LEN)));
    }
    return parts;
}

export function encodeProbe(): Uint8Array {
    return new Uint8Array([FRAME_PROBE]);
}

export function encodeAck(): Uint8Array {
    return new Uint8Array([FRAME_ACK]);
}

export interface DecodedFrame {
    readonly frame: Frame;
    readonly used: number;
}

const EMPTY = new Uint8Array(0);

export function decodeFrame(bytes: Uint8Array, maxMessageBytes: number): DecodedFrame {
    if (bytes.length < 1) {
        throw new FrameFormatError("incomplete");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    switch (bytes[0]) {
        case FRAME_PROBE:
            return { frame: { type: FRAME_PROBE, messageId: 0, payload: EMPTY }, used: 1 };

        case FRAME_ACK:
            return { frame: { type: FRAME_ACK, messageId: 0, payload: EMPTY }, used: 1 };

        case FRAME_DATA: {
            if (bytes.length < DATA_HEADER_LEN) {
                throw new FrameFormatError("incomplete");
            }
            if (bytes[1] !== MAGIC_C || bytes[2] !== MAGIC_Y) {
                throw new FrameFormatError("bad-magic");
            }
            const messageId = view.getUint32(3, true);
            const length = view.getUint32(7, true);
            if (length > MAX_MESSAGE_PAYLOAD || length > maxMessageBytes) {
                throw new FrameFormatError("message-too-large");
            }
            const total = DATA_HEADER_LEN + length;
            if (bytes.length < total) {
                throw new FrameFormatError("incomplete");
            }
            return {
                frame: {
                    type: FRAME_DATA,
                    messageId,
                    payload: bytes.subarray(DATA_HEADER_LEN, total),
                },
                used: total,
            };
        }

        case FRAME_HANDSHAKE: {
            if (bytes.length < HANDSHAKE_HEADER_LEN) {
                throw new FrameFormatError("incomplete");
            }
            const length = view.getUint32(1, true);
            if (length > MAX_HANDSHAKE_PAYLOAD) {
                throw new FrameFormatError("handshake-too-large");
            }
            const total = HANDSHAKE_HEADER_LEN + length;
            if (bytes.length < total) {
                throw new FrameFormatError("incomplete");
            }
            return {
                frame: {
                    type: FRAME_HANDSHAKE,
                    messageId: 0,
                    payload: bytes.subarray(HANDSHAKE_HEADER_LEN, total),
                },
                used: total,
            };
        }

        case FRAME_HANDSHAKE_PART: {
            if (bytes.length < PART_HEADER_LEN) {
                throw new FrameFormatError("incomplete");
            }
            const length = view.getUint32(5, true);
            if (length > PART_CONTENT_LEN) {
                throw new FrameFormatError("part-too-large");
            }
            const total = PART_HEADER_LEN + length;
            if (bytes.length < total) {
                throw new FrameFormatError("incomplete");
            }
            return {
                frame: {
                    type: FRAME_HANDSHAKE_PART,
                    messageId: 0,
                    payload: bytes.subarray(1, total),
                },
                used: total,
            };
        }

        default:
            throw new FrameFormatError("unknown-type");
    }
}

export function decodePacket(bytes: Uint8Array, maxMessageBytes: number): Frame {
    const decoded = decodeFrame(bytes, maxMessageBytes);
    if (decoded.used !== bytes.length) {
        throw new FrameFormatError("trailing");
    }
    return decoded.frame;
}

export class StreamDecoder {
    private buffer: Uint8Array = EMPTY;
    private poison: FrameFormatError | null = null;
    private readonly maxMessageBytes: number;

    constructor(maxMessageBytes: number) {
        this.maxMessageBytes = maxMessageBytes;
    }

    get buffered(): number {
        return this.buffer.length;
    }

    get poisoned(): boolean {
        return this.poison !== null;
    }

    feed(bytes: Uint8Array): void {
        if (this.poison !== null || bytes.length === 0) {
            return;
        }
        if (this.buffer.length === 0) {
            this.buffer = bytes.slice();
            return;
        }
        const grown = new Uint8Array(this.buffer.length + bytes.length);
        grown.set(this.buffer, 0);
        grown.set(bytes, this.buffer.length);
        this.buffer = grown;
    }

    next(): Frame | null {
        if (this.poison !== null) {
            throw this.poison;
        }
        if (this.buffer.length === 0) {
            return null;
        }
        if (this.buffer[0] === FRAME_HANDSHAKE_PART) {
            this.poison = new FrameFormatError("part-on-stream");
            throw this.poison;
        }
        let decoded: DecodedFrame;
        try {
            decoded = decodeFrame(this.buffer, this.maxMessageBytes);
        } catch (error) {
            const failure = error as FrameFormatError;
            if (failure.code === "incomplete") {
                return null;
            }
            this.poison = failure;
            throw failure;
        }
        const frame: Frame = { ...decoded.frame, payload: decoded.frame.payload.slice() };
        this.buffer = this.buffer.subarray(decoded.used);
        return frame;
    }
}
