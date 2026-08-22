import { connect, nowMs } from "../src/index.ts";
import { PLAYER_INPUT, SCHEMA } from "./schema.ts";

const client = await connect("127.0.0.1", 9321, SCHEMA);
let frame = 0;

const loop = setInterval(() => {
    for (const event of client.tick(nowMs())) {
        switch (event.kind) {
            case "connected":
                console.log("transport up, handshaking");
                break;
            case "ready":
                console.log("handshake accepted");
                break;
            case "message":
                console.log(`echo of ${event.payload.length} bytes back`);
                break;
            case "handshake-failed":
                console.log(`handshake refused: ${event.reason}`);
                break;
            case "disconnected":
                console.log(`disconnected: ${event.reason}`);
                break;
        }
    }

    if (client.isReady && frame % 30 === 0) {
        const refused = client.send(PLAYER_INPUT, new Uint8Array([1, 2, 3, 4]));
        if (refused !== null) {
            console.log(`send refused: ${refused}`);
        }
    }
    frame += 1;

    if (client.isClosed) {
        clearInterval(loop);
        client.destroy();
    }
}, 16);
