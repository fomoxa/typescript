# fomoxa-net

The Fomoxa runtime for Node: framing, schema handshake, heartbeat, and a
non-blocking tick loop over TCP or UDP.

No dependencies. No hidden threads of execution. No `async` anywhere past the
moment the pipe is open — your loop drives everything.

Codecs come from `fomoxac`. This package moves opaque bytes and never
interprets one.

---

## Install

```
npm install fomoxa-net
```

Node 22 or newer. The published package ships compiled JavaScript with `.d.ts`
declarations beside it, so JavaScript and TypeScript projects both consume it
directly — a JavaScript project needs no TypeScript compiler of its own.

### This package is ESM only

There is no CommonJS build, and the error you get for reaching it from
CommonJS does not say so:

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]:
No "exports" main defined in .../node_modules/fomoxa-net/package.json
```

`import` from an ESM module, or `await import("fomoxa-net")` from CommonJS.
Watch out for the second one under TypeScript: with `"module": "commonjs"`,
`tsc` rewrites `await import(...)` into `require(...)`, which produces exactly
the message above even though the source looked like a dynamic import. Setting
`"module": "nodenext"` keeps it a real dynamic import and it resolves.

---

## Client

```ts
import { connect, nowMs } from "fomoxa-net";
import { SCHEMA, PLAYER_INPUT } from "./schema.js";

// Opening the pipe is the one asynchronous step, and it happens before
// Fomoxa starts. Everything after this is synchronous.
const client = await connect("127.0.0.1", 9321, SCHEMA);

setInterval(() => {
    for (const event of client.tick(nowMs())) {
        switch (event.kind) {
            case "ready":
                console.log("handshake accepted");
                break;
            case "message":
                console.log(`message ${event.messageId}, ${event.payload.length} bytes`);
                break;
            case "disconnected":
                console.log(`disconnected: ${event.reason}`);
                break;
        }
    }

    if (client.isReady) {
        const refused = client.send(PLAYER_INPUT, payload);
        if (refused !== null) {
            // "not-ready" · "congested" · "too-large" · "closed"
            console.log(`send refused: ${refused}`);
        }
    }
}, 16);
```

## Server

```ts
import { listen, nowMs } from "fomoxa-net";

const server = await listen("127.0.0.1", 9321, SCHEMA);

setInterval(() => {
    for (const event of server.tick(nowMs())) {
        if (event.kind === "message") {
            server.send(event.peer, event.messageId, event.payload);
        }
    }
}, 16);
```

Every server event carries the `peer` it belongs to. `broadcast`, `disconnect`,
`peers()` and `isPeerReady()` round out the API.

## UDP

Same session, same events, same loop — only the entry point changes.

```ts
import { connectUdpSession, listenUdpServer } from "fomoxa-net";

const server = await listenUdpServer("127.0.0.1", 9321, SCHEMA);
const client = await connectUdpSession("127.0.0.1", 9321, SCHEMA);
```

Datagrams may be lost, arrive out of order, or arrive twice. Fomoxa hands them
up **in the order it received them** and repairs nothing — that trade is
deliberate, since a game would usually rather lose a position update than wait
for a retransmit. Heartbeat and dead-peer detection still work, because they
run on a clock rather than on sequence numbers.

---

## What this package guarantees

| | |
|---|---|
| Nothing blocks | Every call returns immediately, including `send` on a congested link |
| No hidden concurrency | The package starts no thread of execution; between ticks, bytes wait in the OS or stream buffer exactly as they would in C |
| Time is a parameter | `tick(now)` takes the clock from you, so a whole expiry cycle can be tested without waiting |
| A monotonic clock | `nowMs()` is `performance.now()`, never `Date.now()`: one NTP step backwards must not expire a live handshake |
| One ending event | A session raises exactly one of `handshake-failed` or `disconnected`, never both |
| No unbounded queues | A send while a frame is still stuck is refused with `congested` rather than quietly growing memory |

## Backpressure

The TCP transport keeps its socket in **paused mode** and reads with
`socket.read()` inside the tick. Attaching a `data` listener would put the
socket into flowing mode and pull bytes into the heap as fast as the peer
sends, destroying TCP backpressure the moment your loop fell behind. In paused
mode the bytes wait in the stream's own buffer, bounded by `highWaterMark`;
when that fills, libuv stops reading the descriptor and the peer stalls —
exactly what a kernel receive buffer does for a C implementation.

**Stop calling `tick` and the session dies.** The heartbeat stops with it, the
peer probes, gets nothing, and declares you gone. A long pause is not a safe
pause.

---

## Schema compatibility

Two peers with **different** schemas still connect, as long as the part they
share agrees:

| | |
|---|---|
| Identical schema fingerprints | accepted, without reading a single entry |
| One side knows a message the other does not | accepted — it is simply never sent |
| A shared message, one side appended a field at the end | accepted |
| A shared message, one side has zero fields | accepted |
| A shared message differing at an index both sides have | refused |

The last row is the only failure, and it has to be: the same position would
carry two meanings, and position is the only identifier on the wire.

## Message payloads

`event.payload` is a `Uint8Array` this package owns and hands to you. Keep it
as long as you like — it is not overwritten by the next tick. Implementations
in other languages hand over a borrowed view that expires, so code ported from
one of those can drop its defensive copies here.

---

## Codecs from fomoxac need a build step

This package moves opaque bytes; the codecs that turn your models into those
bytes come from `fomoxac`. Point it at your annotated sources and it writes a
tree — `runtime.ts`, `handshake.ts`, and one file per model per codec:

```
fomoxac generate --src src/models --out src/generated
```

Build the schema for this SDK straight out of that tree, so no fingerprint is
ever copied by hand:

```ts
import { FOMOXA_MESSAGES, FOMOXA_SCHEMA_FINGERPRINT } from "./generated/handshake.js";
import { buildSchema } from "fomoxa-net";

export const SCHEMA = buildSchema(
    FOMOXA_SCHEMA_FINGERPRINT,
    FOMOXA_MESSAGES.map((m) => ({ id: m.id, fingerprint: m.fingerprint, prefixes: m.prefixes })),
);
```

**The generated tree does not run under `node` directly, and yours will need a
`tsc` step because of it.** Two things put it outside the subset Node can strip
types from: its relative imports carry no file extension (`from "./runtime"`),
and `handshake.ts` declares `enum`s. Neither is a problem — it simply means the
generated code is compiled rather than executed as-is.

This is worth stating plainly because the SDK itself is the opposite: its
sources stay inside the type-stripping subset and its own test suite runs with
no build at all. That difference belongs to the generated code, not to
`fomoxa-net`, and it surprises people who notice one and assume the other.

## Development

```
npm test           # 74 tests, no build step — Node runs the TypeScript directly
npm run build      # emit dist/ with .d.ts
node examples/echo-server.ts
node examples/echo-client.ts
```

The sources stay inside Node's type-stripping subset — no parameter
properties, no enums, no namespaces — which is what lets the test suite run
without compiling anything first.

## Behaviour, and where it comes from

This package was written from the Fomoxa implementation guide and the
protocol RFCs, not by porting another SDK. The guide states that reading it is
enough to rebuild an SDK in any language without reading any existing
implementation's source, and that is how this one was built. Comments through
the source cite the section each rule comes from.

## Licence

Apache-2.0.
