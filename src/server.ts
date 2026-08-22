import { nowMs } from "./clock.ts";
import { defaultConfig, type Config } from "./config.ts";
import { Core, type SendError } from "./core.ts";
import type { Event } from "./event.ts";
import type { Schema } from "./schema.ts";
import type { Listener } from "./transport.ts";
import { listenTcp } from "./transport/tcp.ts";
import { listenUdp } from "./transport/udp.ts";

export type PeerId = number;

/** Every server event carries the peer it belongs to (02 §10). */
export type PeerEvent = Event & { readonly peer: PeerId };

interface Slot {
    readonly id: PeerId;
    readonly core: Core;
}

export class Server {
    private readonly listener: Listener;
    private readonly schema: Schema;
    private readonly config: Config;
    private readonly slots: Slot[] = [];
    private nextId: PeerId = 1;
    private closed = false;

    constructor(listener: Listener, schema: Schema, config: Config = defaultConfig()) {
        this.listener = listener;
        this.schema = schema;
        this.config = config;
    }

    get port(): number {
        return this.listener.port;
    }

    get peerCount(): number {
        return this.slots.length;
    }

    peers(): PeerId[] {
        return this.slots.map((slot) => slot.id);
    }

    isPeerReady(peer: PeerId): boolean {
        return this.slotOf(peer)?.core.session.isReady ?? false;
    }

    tick(now: number = nowMs()): PeerEvent[] {
        const events: PeerEvent[] = [];

        while (this.slots.length < this.config.maxPeers) {
            const transport = this.listener.accept();
            if (transport === null) {
                break;
            }
            const id = this.nextId;
            this.nextId += 1;
            this.slots.push({ id, core: new Core("server", transport, this.schema, this.config, now) });
        }

        for (let index = this.slots.length - 1; index >= 0; index -= 1) {
            const slot = this.slots[index];
            for (const event of slot.core.tick(now)) {
                events.push({ ...event, peer: slot.id });
            }
            if (slot.core.session.currentState === "closed") {
                slot.core.release();
                this.slots.splice(index, 1);
            }
        }

        return events;
    }

    send(peer: PeerId, messageId: number, payload: Uint8Array): SendError | null {
        const slot = this.slotOf(peer);
        return slot === undefined ? "closed" : slot.core.send(messageId, payload);
    }

    broadcast(messageId: number, payload: Uint8Array): void {
        for (const slot of this.slots) {
            slot.core.send(messageId, payload);
        }
    }

    disconnect(peer: PeerId): void {
        this.slotOf(peer)?.core.close();
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const slot of this.slots.splice(0)) {
            slot.core.close();
            slot.core.release();
        }
        this.listener.close();
    }

    private slotOf(peer: PeerId): Slot | undefined {
        return this.slots.find((slot) => slot.id === peer);
    }
}

export async function listen(
    host: string,
    port: number,
    schema: Schema,
    config: Config = defaultConfig(),
): Promise<Server> {
    return new Server(await listenTcp(host, port), schema, config);
}

export async function listenUdpServer(
    host: string,
    port: number,
    schema: Schema,
    config: Config = defaultConfig(),
): Promise<Server> {
    return new Server(await listenUdp(host, port), schema, config);
}
