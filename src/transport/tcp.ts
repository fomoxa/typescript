import net from "node:net";

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
 * A TCP transport that never waits, built on a socket left in paused mode.
 *
 * The socket gets no `data` listener, which is what keeps it paused. In that
 * mode `socket.read()` is a synchronous call returning a buffer or null — the
 * exact shape of a non-blocking read. Bytes that arrive between ticks land in
 * the stream's own buffer, bounded by highWaterMark, and once that fills libuv
 * stops reading the descriptor and the peer stalls. That is the same
 * arrangement a kernel receive buffer gives a C implementation, one layer up
 * (01 §6).
 *
 * Attaching a `data` listener instead would switch the socket to flowing mode
 * and pull bytes into the heap as fast as the peer sends them, destroying TCP
 * backpressure and letting memory climb whenever the tick loop falls behind.
 */
export class TcpTransport implements Transport {
    readonly kind: TransportKind = "stream";

    private readonly socket: net.Socket;
    private ended = false;
    private failed = false;
    private closed = false;

    constructor(socket: net.Socket) {
        this.socket = socket;
        socket.setNoDelay(true);

        // These listeners only set a flag. They never call into the core and
        // start no thread of execution (01 §12); an `error` listener is also
        // how Node reports what errno reports elsewhere, and without one the
        // process would throw.
        socket.on("error", () => {
            this.failed = true;
        });
        socket.on("end", () => {
            this.ended = true;
        });
        socket.on("close", (hadError) => {
            this.ended = true;
            if (hadError) {
                this.failed = true;
            }
        });
    }

    send(bytes: Uint8Array): SendResult {
        if (this.closed || this.socket.destroyed) {
            return "closed";
        }
        if (this.failed) {
            return "error";
        }

        // The check comes BEFORE the write, and that order is the whole point:
        // `socket.write` always takes the entire buffer, so calling it and then
        // answering ⏸ would have the core send the same frame again and the
        // peer receive its first half twice (02 §9.2).
        if (this.socket.writableNeedDrain) {
            return "would-block";
        }
        try {
            this.socket.write(bytes);
            return "sent";
        } catch {
            this.failed = true;
            return "error";
        }
    }

    recv(): RecvResult {
        if (this.failed) {
            return RECV_ERROR;
        }
        if (this.closed) {
            return CLOSED;
        }

        const chunk = this.socket.read() as Buffer | null;
        if (chunk !== null && chunk.length > 0) {
            return { kind: "received", bytes: new Uint8Array(chunk) };
        }

        // Nothing buffered, and the peer said goodbye: a clean close is ✖,
        // distinct from the ⚠ of a broken connection (01 §9.2).
        if (this.ended || this.socket.readableEnded) {
            return CLOSED;
        }
        return WOULD_BLOCK;
    }

    closeSoft(): void {
        if (this.closed || this.socket.destroyed) {
            return;
        }
        // A FIN, and no waiting for an answer. Nothing is released here —
        // bytes may still be on their way in and the core may still read them
        // (02 §9.4).
        this.socket.end();
    }

    closeHard(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.socket.destroy();
    }
}

export class TcpListener implements Listener {
    readonly port: number;

    private readonly server: net.Server;
    private readonly waiting: net.Socket[] = [];
    private closed = false;

    constructor(server: net.Server) {
        this.server = server;
        const address = server.address();
        this.port = typeof address === "object" && address !== null ? address.port : 0;

        // Node has no way to accept synchronously, so arrivals are parked in a
        // queue. The handler appends and nothing else — it never reaches into
        // the core (01 §12).
        server.on("connection", (socket) => {
            if (this.closed) {
                socket.destroy();
                return;
            }
            socket.pause();
            this.waiting.push(socket);
        });
        server.on("error", () => {
            this.closed = true;
        });
    }

    accept(): Transport | null {
        const socket = this.waiting.shift();
        return socket === undefined ? null : new TcpTransport(socket);
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const socket of this.waiting.splice(0)) {
            socket.destroy();
        }
        this.server.close();
    }
}

/**
 * Opening the pipe happens outside Fomoxa and before the core starts
 * (01 §4), which is where every await in this library lives. Once this
 * resolves, the tick loop is synchronous for the rest of the session.
 */
export function connectTcp(host: string, port: number): Promise<TcpTransport> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.once("error", reject);
        socket.once("connect", () => {
            socket.removeListener("error", reject);
            socket.pause();
            resolve(new TcpTransport(socket));
        });
    });
}

export function listenTcp(host: string, port: number): Promise<TcpListener> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(port, host, () => {
            server.removeListener("error", reject);
            resolve(new TcpListener(server));
        });
    });
}
