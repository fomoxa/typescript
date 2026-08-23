import dgram from "node:dgram";

import {
    CLOSED,
    RECV_ERROR,
    WOULD_BLOCK,
    type Listener,
    type RecvResult,
    type SendResult,
    type Transport,
    type TransportKind,
} from "../transport.ts";

/**
 * The largest payload an IPv4 datagram can carry. 01 §7 calls this the
 * absolute ceiling and advises applications to stay well under ~1200 bytes so
 * the IP layer never fragments — that advice belongs to the application, so it
 * is documented rather than enforced here.
 */
export const MAX_DATAGRAM = 65507;

/**
 * How many datagrams may wait for one peer before the oldest is dropped.
 *
 * 01 §6 requires an internal transport buffer to be bounded rather than grow
 * without limit, and for UDP dropping is the honest answer: the kernel does
 * exactly this when its receive buffer fills, and 01 §7 states plainly that
 * Fomoxa neither retransmits nor reorders. The guide does not say which end
 * to drop; the oldest goes, because a real-time peer is better served by the
 * freshest data, and a lost handshake datagram simply fails the handshake
 * closed (02 §3.3.2).
 */
export const MAX_QUEUED_DATAGRAMS = 64;

/**
 * How many distinct source addresses one endpoint will track at once.
 *
 * A UDP port hears from anyone, so without a cap a stream of spoofed source
 * addresses would grow the peer table and the accept queue without limit —
 * the unbounded growth 01 §6 rules out. Past this line datagrams from
 * addresses that are not already known are ignored, exactly as a stranger's
 * packet is ignored (01 §10): silently, and without disturbing any session
 * already running.
 */
export const MAX_TRACKED_PEERS = 1024;

interface Channel {
    dispatch(bytes: Uint8Array, port: number, address: string): SendResult;
    detach(peer: UdpTransport): void;
}

export class UdpTransport implements Transport {
    readonly kind: TransportKind = "packet";
    readonly address: string;
    readonly port: number;

    private readonly channel: Channel;
    private readonly queue: Uint8Array[] = [];
    private failed = false;
    private closed = false;
    private dropped = 0;

    constructor(channel: Channel, address: string, port: number) {
        this.channel = channel;
        this.address = address;
        this.port = port;
    }

    /** How many datagrams the bound above has discarded, for diagnostics. */
    get droppedCount(): number {
        return this.dropped;
    }

    /** Called by the owning socket, never by the core. Only appends. */
    deliver(bytes: Uint8Array): void {
        if (this.closed) {
            return;
        }
        if (this.queue.length >= MAX_QUEUED_DATAGRAMS) {
            this.queue.shift();
            this.dropped += 1;
        }
        this.queue.push(bytes);
    }

    fail(): void {
        this.failed = true;
    }

    send(bytes: Uint8Array): SendResult {
        if (this.closed) {
            return "closed";
        }
        if (this.failed) {
            return "error";
        }
        // ⊘ and not ⏸: this frame will never fit, so the core must not keep
        // retrying it forever. The session stays alive (01 §2, §7).
        if (bytes.length > MAX_DATAGRAM) {
            return "too-large";
        }
        return this.channel.dispatch(bytes, this.port, this.address);
    }

    recv(): RecvResult {
        const next = this.queue.shift();
        if (next !== undefined) {
            // Exactly one whole datagram. A packet transport may never hand up
            // part of one (01 §3).
            return { kind: "received", bytes: next };
        }
        if (this.failed) {
            return RECV_ERROR;
        }
        if (this.closed) {
            return CLOSED;
        }
        return WOULD_BLOCK;
    }

    closeSoft(): void {
        // UDP has no notion of a polite goodbye, so there is nothing to send.
        // Doing nothing here is correct, not an omission (01 §9.1).
    }

    closeHard(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.queue.length = 0;
        this.channel.detach(this);
    }
}

function keyOf(address: string, port: number): string {
    return `${address}:${port}`;
}

/**
 * One socket, many peers. A UDP endpoint hears from anyone, so every datagram
 * is matched against the address it came from and anything unrecognised is
 * silently ignored — no error, no session killed, because a stray packet says
 * nothing about the health of a session (01 §10).
 */
export class UdpListener implements Listener {
    readonly port: number;

    private readonly socket: dgram.Socket;
    private readonly peers = new Map<string, UdpTransport>();
    private readonly waiting: UdpTransport[] = [];
    private closed = false;
    private ignored = 0;

    constructor(socket: dgram.Socket) {
        this.socket = socket;
        this.port = socket.address().port;

        socket.on("message", (data, info) => {
            if (this.closed) {
                return;
            }
            const key = keyOf(info.address, info.port);
            let peer = this.peers.get(key);
            if (peer === undefined) {
                if (this.peers.size >= MAX_TRACKED_PEERS) {
                    this.ignored += 1;
                    return;
                }
                peer = new UdpTransport(this.channel(), info.address, info.port);
                this.peers.set(key, peer);
                this.waiting.push(peer);
            }
            peer.deliver(new Uint8Array(data));
        });

        socket.on("error", () => {
            this.closed = true;
            for (const peer of this.peers.values()) {
                peer.fail();
            }
        });
    }

    /** Datagrams turned away because the peer table was full, for diagnostics. */
    get ignoredCount(): number {
        return this.ignored;
    }

    get trackedPeers(): number {
        return this.peers.size;
    }

    accept(): Transport | null {
        return this.waiting.shift() ?? null;
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.waiting.length = 0;
        this.peers.clear();
        this.socket.close();
    }

    private channel(): Channel {
        return {
            dispatch: (bytes, port, address) => {
                if (this.closed) {
                    return "closed";
                }
                try {
                    this.socket.send(bytes, port, address);
                    return "sent";
                } catch {
                    return "error";
                }
            },
            detach: (peer) => {
                this.peers.delete(keyOf(peer.address, peer.port));
            },
        };
    }
}

/**
 * A client endpoint bound to one peer. The socket is connected, so the OS
 * already filters strangers out, and the source address is checked again here
 * rather than trusted (01 §10).
 */
export function connectUdp(host: string, port: number): Promise<UdpTransport> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket("udp4");
        socket.once("error", reject);

        socket.connect(port, host, () => {
            socket.removeListener("error", reject);
            const remote = socket.remoteAddress();

            const transport = new UdpTransport(
                {
                    dispatch: (bytes) => {
                        try {
                            socket.send(bytes);
                            return "sent";
                        } catch {
                            return "error";
                        }
                    },
                    detach: () => {
                        socket.close();
                    },
                },
                remote.address,
                remote.port,
            );

            socket.on("message", (data, info) => {
                if (info.address !== remote.address || info.port !== remote.port) {
                    return;
                }
                transport.deliver(new Uint8Array(data));
            });
            socket.on("error", () => {
                transport.fail();
            });

            resolve(transport);
        });
    });
}

export function listenUdp(host: string, port: number): Promise<UdpListener> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket("udp4");
        socket.once("error", reject);
        socket.bind(port, host, () => {
            socket.removeListener("error", reject);
            resolve(new UdpListener(socket));
        });
    });
}
