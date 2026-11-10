import { MAX_HANDSHAKE_PARTS, MAX_HANDSHAKE_PAYLOAD, PART_CONTENT_LEN, PART_HEADER_LEN } from "./frame.ts";

export type Assembly = "pending" | "complete" | "broken";

const PART_FIELDS_LEN = PART_HEADER_LEN - 1;
const EMPTY = new Uint8Array(0);

export class HandshakeAssembler {
    private content: Uint8Array = EMPTY;
    private received: Uint8Array = EMPTY;
    private count = 0;
    private arrived = 0;
    private lastLength = 0;

    get pending(): boolean {
        return this.count > 0;
    }

    get body(): Uint8Array {
        return this.content.subarray(0, (this.count - 1) * PART_CONTENT_LEN + this.lastLength);
    }

    add(part: Uint8Array): Assembly {
        const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
        const index = view.getUint16(0, true);
        const count = view.getUint16(2, true);
        const bytes = part.subarray(PART_FIELDS_LEN);

        if (count < 2 || count > MAX_HANDSHAKE_PARTS || index >= count) {
            return "broken";
        }
        const last = index === count - 1;
        if (last ? bytes.length === 0 : bytes.length !== PART_CONTENT_LEN) {
            return "broken";
        }

        if (this.count === 0) {
            this.begin(count);
        } else if (count !== this.count) {
            return "broken";
        }

        const offset = index * PART_CONTENT_LEN;
        if (this.received[index] === 1) {
            if (last && bytes.length !== this.lastLength) {
                return "broken";
            }
            for (let i = 0; i < bytes.length; i += 1) {
                if (bytes[i] !== this.content[offset + i]) {
                    return "broken";
                }
            }
            return "pending";
        }

        this.content.set(bytes, offset);
        this.received[index] = 1;
        this.arrived += 1;
        if (last) {
            this.lastLength = bytes.length;
        }

        if (this.arrived < this.count) {
            return "pending";
        }
        return this.body.length > MAX_HANDSHAKE_PAYLOAD ? "broken" : "complete";
    }

    reset(): void {
        this.content = EMPTY;
        this.received = EMPTY;
        this.count = 0;
        this.arrived = 0;
        this.lastLength = 0;
    }

    private begin(count: number): void {
        this.content = new Uint8Array(count * PART_CONTENT_LEN);
        this.received = new Uint8Array(count);
        this.count = count;
    }
}
