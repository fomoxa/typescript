export interface Config {
    readonly handshakeTimeoutMs: number;
    readonly heartbeatIntervalMs: number;
    readonly heartbeatTimeoutMs: number;
    readonly maxFramesPerTick: number;
    readonly maxMessageBytes: number;
    readonly maxPeers: number;
}

/** The recommended defaults from 02 §4.4. Worst case to notice a dead peer
 *  while READY is heartbeatIntervalMs + heartbeatTimeoutMs. */
export function defaultConfig(): Config {
    return {
        handshakeTimeoutMs: 5_000,
        heartbeatIntervalMs: 5_000,
        heartbeatTimeoutMs: 15_000,
        maxFramesPerTick: 64,
        maxMessageBytes: 64 * 1024,
        maxPeers: 256,
    };
}
