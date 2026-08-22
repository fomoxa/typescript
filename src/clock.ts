import { performance } from "node:perf_hooks";

/**
 * A monotonic clock, never a wall clock (B9). One NTP step backwards must not
 * expire a handshake in flight or kill a healthy peer, which is exactly what
 * `Date.now()` would allow.
 */
export function nowMs(): number {
    return performance.now();
}
