import type { Config } from "./config.ts";
import type { DisconnectReason, Event } from "./event.ts";
import {
    FrameFormatError,
    StreamDecoder,
    decodePacket,
    encodeAck,
    encodeData,
    encodeHandshake,
    encodeProbe,
    type Frame,
} from "./frame.ts";
import type { Schema } from "./schema.ts";
import { Session, type Out, type Reaction, type Role } from "./session.ts";
import type { Transport } from "./transport.ts";

export type SendError = "not-ready" | "congested" | "too-large" | "closed";

/** One data frame plus the handful of control frames the protocol can owe at
 *  any moment. Reaching this means an assumption broke, so the session ends
 *  instead of growing. */
const MAX_OUTBOX_FRAMES = 8;

/**
 * The framing layer sits between core and transport, never inside either
 * (01 §3). Which one to use is decided once, when the transport is handed
 * over, so neither side has to ask "what kind are you?" again.
 */
type Intake =
    | { readonly kind: "stream"; readonly decoder: StreamDecoder }
    | { readonly kind: "packet" };

export class Core {
    readonly session: Session;

    private readonly transport: Transport;
    private readonly config: Config;
    private readonly intake: Intake;

    /**
     * The waiting slot, 02 §5.3. It holds whole frames only: a transport here
     * takes every byte or none, so nothing is ever half on the wire.
     *
     * The guide fixes one data frame per session and has the application's
     * `send` refused while it is occupied — that part is exact below. What it
     * does not say is what happens when the slot is busy and the *core* still
     * owes a control frame: an ACK it must answer with, or a refusal verdict.
     * Overwriting would lose a verdict, so control frames append instead. The
     * protocol bounds them on its own (one probe per silence window, one ack
     * per probe, at most two handshake payloads), and the cap below turns a
     * violation of that assumption into a dead session rather than unbounded
     * memory. Worth confirming against the guide's author.
     */
    private outbox: Uint8Array[] = [];
    /** Frames already lifted out of the framing layer but not yet handed to the
     *  session, because the tick budget ran out. Data the core stopped short of
     *  is never dropped — it waits for the next tick (01 §6). */
    private ready: Frame[] = [];
    private dead: DisconnectReason | null = null;
    private announced = false;
    private released = false;

    constructor(role: Role, transport: Transport, schema: Schema, config: Config, now: number) {
        this.transport = transport;
        this.config = config;
        this.session = new Session(role, schema, config, now);
        this.intake =
            transport.kind === "stream"
                ? { kind: "stream", decoder: new StreamDecoder(config.maxMessageBytes) }
                : { kind: "packet" };

        const opening = this.session.opening();
        if (opening.out !== undefined) {
            this.write(opening.out);
        }
    }

    get isCongested(): boolean {
        return this.outbox.length > 0;
    }

    send(messageId: number, payload: Uint8Array): SendError | null {
        // ① state check — nothing of the application goes out before both
        //    ends agree they read bytes the same way (02 §5.1, §5.2).
        if (!this.session.isReady) {
            return this.session.currentState === "closed" ? "closed" : "not-ready";
        }
        if (payload.length > this.config.maxMessageBytes) {
            return "too-large";
        }
        // ③ a frame still stuck means refuse — never queue. Cyclone would
        //    rather the application know than let memory climb quietly
        //    (01 §5).
        if (this.outbox.length > 0) {
            return "congested";
        }

        // ② the payload is copied into the frame here, so the caller may reuse
        //    its buffer the moment this returns (02 §5.1).
        const frame = encodeData(messageId, payload);
        const result = this.transport.send(frame);
        switch (result) {
            case "sent":
                return null;
            case "would-block":
                // ⏸ keeps the frame for the next tick and still reports success
                // upward: the application is never blocked.
                this.outbox.push(frame);
                return null;
            case "too-large":
                // ⊘ does not end the session and is never retried (01 §7).
                return "too-large";
            case "closed":
                this.dead = "peer-closed";
                return "closed";
            default:
                this.dead = "transport-error";
                return "closed";
        }
    }

    tick(now: number): Event[] {
        const events: Event[] = [];

        // ── 0. the CONNECTED event, once in the life of a session ──
        if (!this.announced) {
            this.announced = true;
            events.push({ kind: "connected" });
        }

        // ── 1. push out whatever is stuck — before anything else ──
        // A new frame reaching the wire ahead of the remains of an old one
        // corrupts the peer's decoder permanently (02 §5.3).
        while (this.outbox.length > 0 && this.dead === null) {
            const result = this.transport.send(this.outbox[0]);
            if (result === "sent") {
                this.outbox.shift();
                continue;
            }
            if (result === "would-block") {
                break;
            }
            this.dead = result === "closed" ? "peer-closed" : "transport-error";
        }

        // ── 2. drain what arrived, inside the budget ──
        if (this.dead === null) {
            this.drain(now, events);
        }

        // ── 3. run the protocol clock ──
        if (this.dead === null) {
            this.apply(this.session.tick(now), events);
        }

        // ── 4. transport died while the session was still open ──
        if (this.dead !== null && this.session.currentState !== "closed") {
            const reason = this.dead === "peer-closed" ? "peer-closed" : "transport-error";
            this.apply(this.session.transportClosed(reason), events);
        }

        // ── 5. hand the list to the application ──
        return events;
    }

    close(): void {
        if (this.session.currentState !== "closed") {
            this.session.close();
            this.transport.closeSoft();
        }
    }

    release(): void {
        if (!this.released) {
            this.released = true;
            this.transport.closeHard();
        }
    }

    private drain(now: number, events: Event[]): void {
        let budget = this.config.maxFramesPerTick;

        while (budget > 0 && this.dead === null) {
            if (this.ready.length === 0) {
                const frames = this.pull();
                if (frames === null) {
                    return;
                }
                if (frames.length === 0) {
                    // A dropped packet still costs budget: the cap exists for
                    // fairness between ticks, and a flood of malformed packets
                    // must not starve the loop either (01 §6).
                    budget -= 1;
                    continue;
                }
                this.ready = frames;
            }

            const frame = this.ready.shift() as Frame;
            this.apply(this.session.onFrame(frame, now), events);
            budget -= 1;
        }
    }

    /** One read from the transport, turned into whole frames by the framing layer. */
    private pull(): Frame[] | null {
        const result = this.transport.recv();

        if (result.kind === "would-block") {
            return null;
        }
        if (result.kind === "closed") {
            this.dead = "peer-closed";
            return null;
        }
        if (result.kind === "error") {
            this.dead = "transport-error";
            return null;
        }

        if (this.intake.kind === "packet") {
            // A framing violation on a packet transport is NOT fatal: drop that
            // packet and carry on, because there is no shared parsing state a
            // single bad packet could poison (02 §2.6).
            try {
                return [decodePacket(result.bytes, this.config.maxMessageBytes)];
            } catch {
                return [];
            }
        }

        // On a byte stream every framing violation IS fatal, and the decoder
        // stays poisoned so "just read on and see" cannot be written by
        // accident (02 §2.5).
        this.intake.decoder.feed(result.bytes);
        const frames: Frame[] = [];
        try {
            for (let frame = this.intake.decoder.next(); frame !== null; frame = this.intake.decoder.next()) {
                frames.push(frame);
            }
        } catch (error) {
            if (error instanceof FrameFormatError) {
                this.dead = "transport-error";
                return frames.length > 0 ? frames : null;
            }
            throw error;
        }
        return frames;
    }

    private apply(reaction: Reaction, events: Event[]): void {
        if (reaction.out !== undefined) {
            this.write(reaction.out);
        }
        if (reaction.event !== undefined) {
            events.push(reaction.event);
            if (reaction.event.kind === "handshake-failed") {
                this.dead = "transport-error";
                this.transport.closeSoft();
            }
        }
    }

    private write(out: Out): void {
        const bytes =
            out.kind === "probe"
                ? encodeProbe()
                : out.kind === "ack"
                  ? encodeAck()
                  : encodeHandshake(out.payload);

        // Wire order is absolute: once anything is waiting, everything queues
        // behind it rather than overtaking it (02 §5.3).
        if (this.outbox.length > 0) {
            this.queue(bytes);
            return;
        }

        const result = this.transport.send(bytes);
        if (result === "would-block") {
            this.queue(bytes);
        } else if (result === "closed") {
            this.dead = "peer-closed";
        } else if (result === "error" || result === "too-large") {
            this.dead = "transport-error";
        }
    }

    private queue(bytes: Uint8Array): void {
        if (this.outbox.length >= MAX_OUTBOX_FRAMES) {
            this.dead = "transport-error";
            return;
        }
        this.outbox.push(bytes);
    }
}
