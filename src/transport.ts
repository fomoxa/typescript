/**
 * The transport layer carries bytes and nothing else (01 §1). It offers
 * exactly four functions and answers with a fixed set of signals (01 §2).
 *
 * Two of the six signals from the guide do not appear here, and both absences
 * are deliberate:
 *
 * - ⤢ "no room, I need this many bytes" cannot arise. It exists for languages
 *   where the core hands down a buffer to fill; here `recv` returns a buffer it
 *   owns, so there is never a buffer that turns out too small (02 §6.2 allows
 *   an implementation to hand over owned objects, provided it says so).
 * - A partial send cannot arise either. `send` takes every byte or none, which
 *   is what 02 §9.2 demands of a transport that would otherwise report ⏸
 *   half-way: a transport whose underlying library accepts part of a write must
 *   buffer the remainder itself and answer ✔.
 */

export type TransportKind = "stream" | "packet";

/** ✔ sent · ⏸ not now · ✖ closed · ⚠ error · ⊘ too large */
export type SendResult = "sent" | "would-block" | "closed" | "error" | "too-large";

/** ✔ here it is · ⏸ nothing right now · ✖ closed · ⚠ error */
export type RecvResult =
    | { readonly kind: "received"; readonly bytes: Uint8Array }
    | { readonly kind: "would-block" }
    | { readonly kind: "closed" }
    | { readonly kind: "error" };

export const WOULD_BLOCK: RecvResult = { kind: "would-block" };
export const CLOSED: RecvResult = { kind: "closed" };
export const RECV_ERROR: RecvResult = { kind: "error" };

export interface Transport {
    readonly kind: TransportKind;

    /** Never waits. Takes every byte or none of them. */
    send(bytes: Uint8Array): SendResult;

    /**
     * Never waits. For a packet transport this returns exactly one whole
     * packet or nothing — never part of one (01 §3).
     */
    recv(): RecvResult;

    /** Tell the peer we are going, if the protocol underneath has a way to. */
    closeSoft(): void;

    /** Release everything of ours. Called exactly once. */
    closeHard(): void;
}

export interface Listener {
    /** Returns the next accepted transport, or null when none is waiting. */
    accept(): Transport | null;
    close(): void;
    readonly port: number;
}
