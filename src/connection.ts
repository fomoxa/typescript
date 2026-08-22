import { defaultConfig, type Config } from "./config.ts";
import { Core, type SendError } from "./core.ts";
import type { Event } from "./event.ts";
import type { Schema } from "./schema.ts";
import type { State } from "./session.ts";
import type { Transport } from "./transport.ts";
import { connectTcp } from "./transport/tcp.ts";
import { connectUdp } from "./transport/udp.ts";
import { nowMs } from "./clock.ts";

export class Connection {
    private readonly core: Core;

    constructor(transport: Transport, schema: Schema, config: Config = defaultConfig(), now = nowMs()) {
        this.core = new Core("client", transport, schema, config, now);
    }

    tick(now: number = nowMs()): Event[] {
        return this.core.tick(now);
    }

    send(messageId: number, payload: Uint8Array): SendError | null {
        return this.core.send(messageId, payload);
    }

    get state(): State {
        return this.core.session.currentState;
    }

    get isReady(): boolean {
        return this.core.session.isReady;
    }

    get isClosed(): boolean {
        return this.core.session.currentState === "closed";
    }

    get isCongested(): boolean {
        return this.core.isCongested;
    }

    close(): void {
        this.core.close();
    }

    destroy(): void {
        this.core.release();
    }
}

/** Opens the pipe, then hands the core a connection that is already live. */
export async function connect(
    host: string,
    port: number,
    schema: Schema,
    config: Config = defaultConfig(),
): Promise<Connection> {
    const transport = await connectTcp(host, port);
    return new Connection(transport, schema, config);
}

/** The UDP counterpart. Same session afterwards — the application uses it
 *  exactly as it uses a TCP one (01 §11). */
export async function connectUdpSession(
    host: string,
    port: number,
    schema: Schema,
    config: Config = defaultConfig(),
): Promise<Connection> {
    const transport = await connectUdp(host, port);
    return new Connection(transport, schema, config);
}
