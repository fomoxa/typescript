export interface MessageSchema {
    readonly id: number;
    readonly fingerprint: bigint;
    /**
     * One fingerprint per prefix of the message: entry `k-1` commits to its
     * first `k` fields. The last entry equals `fingerprint`. The chain never
     * travels over the wire — each side keeps its own and exactly one value
     * is exchanged (02 §3.2).
     */
    readonly prefixes: readonly bigint[];
}

export interface Schema {
    readonly fingerprint: bigint;
    readonly messages: readonly MessageSchema[];
    readonly byId: ReadonlyMap<number, MessageSchema>;
}

export class SchemaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SchemaError";
    }
}

export function buildSchema(
    fingerprint: bigint,
    messages: readonly MessageSchema[],
): Schema {
    const byId = new Map<number, MessageSchema>();
    let previousId = -1;

    for (const message of messages) {
        if (message.id <= previousId) {
            throw new SchemaError("messages must be sorted by id, without duplicates");
        }
        previousId = message.id;

        if (message.prefixes.length > 0xffff) {
            throw new SchemaError(`message ${message.id} declares more than 65535 fields`);
        }
        if (
            message.prefixes.length > 0 &&
            message.prefixes[message.prefixes.length - 1] !== message.fingerprint
        ) {
            throw new SchemaError(
                `message ${message.id}: the last prefix must equal the message fingerprint`,
            );
        }
        byId.set(message.id, message);
    }

    return { fingerprint, messages, byId };
}
