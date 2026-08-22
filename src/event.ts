export type DisconnectReason =
    | "peer-closed"
    | "transport-error"
    | "unresponsive"
    | "local";

import type { HandshakeFailure } from "./handshake.ts";

export type Event =
    | { readonly kind: "connected" }
    | { readonly kind: "ready" }
    | { readonly kind: "handshake-failed"; readonly reason: HandshakeFailure }
    | { readonly kind: "message"; readonly messageId: number; readonly payload: Uint8Array }
    | { readonly kind: "probe" }
    | { readonly kind: "ack" }
    | { readonly kind: "disconnected"; readonly reason: DisconnectReason };
