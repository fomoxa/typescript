import {
    FRAME_ACK,
    FRAME_DATA,
    FRAME_HANDSHAKE,
    FRAME_PROBE,
    type Frame,
} from "./frame.ts";
import {
    QUERY_TAG,
    VERDICT_ACCEPT,
    VERDICT_MALFORMED_HELLO,
    answerQuery,
    checkReply,
    decide,
    decodeHello,
    decodeQuery,
    decodeReply,
    encodeHello,
    encodeQuery,
    encodeReply,
    failureOfVerdict,
    type HandshakeFailure,
    type QueryItem,
} from "./handshake.ts";
import type { Schema } from "./schema.ts";
import type { Config } from "./config.ts";
import type { DisconnectReason, Event } from "./event.ts";

export type Role = "client" | "server";
export type State = "handshaking" | "ready" | "closed";

/** What the session wants written out. The core turns it into a frame. */
export type Out =
    | { readonly kind: "probe" }
    | { readonly kind: "ack" }
    | { readonly kind: "handshake"; readonly payload: Uint8Array };

/**
 * At most one frame to send and at most one event, which is what this protocol
 * actually produces (02 §8). Both together is "answer, then end" — a server
 * sending a refusal verdict and closing.
 */
export interface Reaction {
    readonly out?: Out;
    readonly event?: Event;
}

const NOTHING: Reaction = {};

export class Session {
    readonly role: Role;
    readonly schema: Schema;
    readonly config: Config;

    private state: State = "handshaking";
    private startedAt: number;
    private lastActivity: number;
    private probeSentAt: number | null = null;
    private queryAsked: readonly QueryItem[] | null = null;
    private querySeen = false;
    private ended = false;

    constructor(role: Role, schema: Schema, config: Config, now: number) {
        this.role = role;
        this.schema = schema;
        this.config = config;
        this.startedAt = now;
        this.lastActivity = now;
    }

    get currentState(): State {
        return this.state;
    }

    get isReady(): boolean {
        return this.state === "ready";
    }

    /** The client speaks first: its hello leaves before any tick runs (02 §3.1). */
    opening(): Reaction {
        if (this.role !== "client") {
            return NOTHING;
        }
        return { out: { kind: "handshake", payload: encodeHello(this.schema) } };
    }

    close(): void {
        this.state = "closed";
        this.ended = true;
    }

    transportClosed(reason: DisconnectReason): Reaction {
        if (this.state === "closed") {
            return NOTHING;
        }
        this.state = "closed";
        return this.end({ kind: "disconnected", reason });
    }

    onFrame(frame: Frame, now: number): Reaction {
        if (this.state === "closed") {
            return NOTHING;
        }

        // Any valid frame is a sign of life — DATA, PROBE, ACK, HANDSHAKE all
        // count, and any of them clears an outstanding probe (02 §4.2).
        this.lastActivity = now;
        this.probeSentAt = null;

        switch (frame.type) {
            case FRAME_PROBE:
                // Answered on the spot, even while still handshaking: a client
                // that stays silent here is killed by the server while it waits
                // for the very verdict it asked for (02 §3.6).
                return { out: { kind: "ack" }, event: this.isReady ? { kind: "probe" } : undefined };

            case FRAME_ACK:
                return this.isReady ? { event: { kind: "ack" } } : NOTHING;

            case FRAME_DATA:
                // Before READY the payload is dropped and never reaches the
                // application: nobody has confirmed both sides read bytes the
                // same way yet (02 §5.2, §3.6).
                if (!this.isReady) {
                    return NOTHING;
                }
                return { event: { kind: "message", messageId: frame.messageId, payload: frame.payload } };

            case FRAME_HANDSHAKE:
                return this.onHandshake(frame.payload);

            default:
                return NOTHING;
        }
    }

    tick(now: number): Reaction {
        if (this.state === "closed") {
            return NOTHING;
        }

        if (this.state === "handshaking" && this.role === "client") {
            // A hard deadline for the whole handshake, query round included:
            // it is never reset per round, or a hostile server could stretch a
            // session forever by asking again (02 §3.5).
            if (now - this.startedAt >= this.config.handshakeTimeoutMs) {
                this.state = "closed";
                return this.end({ kind: "handshake-failed", reason: "timeout" });
            }
            // The client runs no heartbeat while handshaking (02 §4.3).
            return NOTHING;
        }

        // The silence window is the only thing that differs by state; the last
        // activity mark and any in-flight probe survive the move to READY
        // (02 §4.3).
        const silenceWindow =
            this.state === "ready" ? this.config.heartbeatIntervalMs : this.config.handshakeTimeoutMs;

        if (this.probeSentAt !== null) {
            if (now - this.probeSentAt >= this.config.heartbeatTimeoutMs) {
                this.state = "closed";
                return this.end({ kind: "disconnected", reason: "unresponsive" });
            }
            return NOTHING;
        }

        if (now - this.lastActivity >= silenceWindow) {
            // Exactly one probe per cycle, not one per tick (02 §4.5).
            this.probeSentAt = now;
            return { out: { kind: "probe" } };
        }
        return NOTHING;
    }

    private onHandshake(payload: Uint8Array): Reaction {
        if (this.state !== "handshaking") {
            // A handshake frame arriving after the verdict is simply ignored
            // (02 §3.6) — not to be confused with the query round, which
            // happens while still handshaking.
            return NOTHING;
        }
        return this.role === "server" ? this.serverHandshake(payload) : this.clientHandshake(payload);
    }

    private serverHandshake(payload: Uint8Array): Reaction {
        if (this.queryAsked !== null) {
            const reply = decodeReply(payload);
            if (reply === null) {
                return this.refuse(VERDICT_MALFORMED_HELLO);
            }
            const verdict = checkReply(this.schema, this.queryAsked, reply);
            if (verdict !== VERDICT_ACCEPT) {
                return this.refuse(verdict);
            }
            return this.accept();
        }

        const hello = decodeHello(payload);
        if (hello === null) {
            return this.refuse(VERDICT_MALFORMED_HELLO);
        }

        const decision = decide(this.schema, hello);
        if (decision.kind === "accept") {
            return this.accept();
        }
        if (decision.kind === "reject") {
            return this.refuse(decision.verdict);
        }

        this.queryAsked = decision.items;
        // A query carries no event: to the application a two-round handshake
        // and a one-round handshake look identical (02 §8).
        return { out: { kind: "handshake", payload: encodeQuery(decision.items) } };
    }

    private clientHandshake(payload: Uint8Array): Reaction {
        if (payload.length > 0 && payload[0] === QUERY_TAG) {
            // At most one query per session; a second one is malformed
            // (02 §3.3.2 rule 2).
            if (this.querySeen) {
                return this.fail("malformed-peer");
            }
            this.querySeen = true;

            const items = decodeQuery(payload);
            if (items === null) {
                return this.fail("malformed-peer");
            }
            const reply = answerQuery(this.schema, items);
            if (reply === null) {
                // The server may only ask about ids this client declared
                // (02 §3.3.2).
                return this.fail("malformed-peer");
            }
            return { out: { kind: "handshake", payload: encodeReply(reply) } };
        }

        if (payload.length !== 1 || payload[0] > 3) {
            return this.fail("malformed-peer");
        }
        if (payload[0] === VERDICT_ACCEPT) {
            this.state = "ready";
            return { event: { kind: "ready" } };
        }
        return this.fail(failureOfVerdict(payload[0]));
    }

    private accept(): Reaction {
        this.state = "ready";
        return {
            out: { kind: "handshake", payload: new Uint8Array([VERDICT_ACCEPT]) },
            event: { kind: "ready" },
        };
    }

    private refuse(verdict: number): Reaction {
        this.state = "closed";
        const event: Event = { kind: "handshake-failed", reason: failureOfVerdict(verdict) };
        return { out: { kind: "handshake", payload: new Uint8Array([verdict]) }, ...this.end(event) };
    }

    private fail(reason: HandshakeFailure): Reaction {
        this.state = "closed";
        return this.end({ kind: "handshake-failed", reason });
    }

    /** Exactly one ending event per session, on every path that ends it (02 §7). */
    private end(event: Event): Reaction {
        if (this.ended) {
            return NOTHING;
        }
        this.ended = true;
        return { event };
    }
}
