import { schema, t, type SchemaType } from "@colyseus/schema";

// Kit PvP roster: what every client needs to draw the others (client remotePlayers.js) and
// to fight them. Combat itself is relayed as messages (KitRoom.ts), not stored here.
export const KitPlayer = schema(
  {
    name: t.string().default("Guest"), // verified Bloxity display name, else "Guest 1234"
    signedIn: t.boolean().default(false),
    uid: t.string().default(""), // verified Bloxity user id ("" = guest): the client matches chat bubbles by it
    seed: t.uint32().default(0), // skin seed for the blocky character
    zone: t.string().default("lobby"), // lobby | drop | arena | dead
    kit: t.string().default("swordsman"), // KITS id (client config.js)
    x: t.float32().default(0), // feet, world metres
    y: t.float32().default(0),
    z: t.float32().default(0),
    yaw: t.float32().default(0), // body facing, rad
    pitch: t.float32().default(0), // look pitch, rad (+ = down)
    speed: t.float32().default(0), // horizontal m/s, for the walk cycle
    vx: t.float32().default(0), // velocity, for archers' lead
    vy: t.float32().default(0),
    vz: t.float32().default(0),
    hp: t.float32().default(20),
    flags: t.uint16().default(0), // FLAGS bits (constants.ts)
    swing: t.uint8().default(0), // increments on every swing / throw (wraps)
    item: t.string().default(""), // pixel-art id in hand ("" = fist)
    kills: t.uint16().default(0),
    streak: t.uint16().default(0),
    joinedAt: t.uint32().default(0), // join order (host election)
    level: t.uint32().default(1), // from the player's save (name tags, boards)
    rating: t.uint16().default(1000), // ranked duel rating (server-owned)
    duel: t.string().default(""), // the duel this player is fighting in ("" = none)
    queued: t.string().default(""), // waiting for a duel: "casual" | "ranked" | ""
  },
  "KitPlayer",
);
export type KitPlayer = SchemaType<typeof KitPlayer>;

export const KitState = schema(
  {
    players: t.map(KitPlayer), // keyed by sessionId
    host: t.string().default(""), // sessionId that simulates the arena bots ("" = nobody in the arena)
  },
  "KitState",
);
export type KitState = SchemaType<typeof KitState>;
