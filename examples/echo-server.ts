import { listen, nowMs } from "../src/index.ts";
import { PLAYER_INPUT, SCHEMA } from "./schema.ts";

const PORT = 9321;
const server = await listen("127.0.0.1", PORT, SCHEMA);
console.log(`fomoxa-ts echo server on 127.0.0.1:${PORT}`);

setInterval(() => {
    for (const event of server.tick(nowMs())) {
        switch (event.kind) {
            case "connected":
                console.log(`peer#${event.peer} connected`);
                break;
            case "ready":
                console.log(`peer#${event.peer} handshake accepted`);
                break;
            case "message":
                console.log(`peer#${event.peer} sent ${event.payload.length} bytes`);
                server.send(event.peer, event.messageId, event.payload);
                break;
            case "handshake-failed":
                console.log(`peer#${event.peer} refused: ${event.reason}`);
                break;
            case "disconnected":
                console.log(`peer#${event.peer} gone: ${event.reason}`);
                break;
        }
    }
}, 16);

void PLAYER_INPUT;
