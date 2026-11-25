import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { KitState } from "../src/rooms/schema/KitState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const ARENA = { zone: "arena", x: 0, y: -115, z: -7 };

describe("kit pvp room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("elects the earliest arena player as host and hands over when it leaves the arena", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const a = await colyseus.connectTo(room, {});
    const b = await colyseus.connectTo(room, {});
    await sleep(50);
    assert.strictEqual(room.state.host, "", "nobody fighting: no host");
    b.send("pose", ARENA);
    await sleep(50);
    assert.strictEqual(room.state.host, b.sessionId);
    a.send("pose", ARENA);
    await sleep(50);
    assert.strictEqual(room.state.host, b.sessionId, "the host stays while it is in the arena");
    b.send("pose", { zone: "lobby" });
    await sleep(50);
    assert.strictEqual(room.state.host, a.sessionId);
    assert.match(room.state.players.get(a.sessionId)!.name, /^Guest \d{4}$/, "no token: a guest name");
  });

  it("relays hits to the victim only when both fight nearby, bounded", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const a = await colyseus.connectTo(room, {});
    const b = await colyseus.connectTo(room, {});
    const got: any[] = [];
    b.onMessage("hit", (m) => got.push(m));
    a.send("pose", ARENA);
    b.send("pose", { ...ARENA, x: 2 });
    await sleep(50);
    a.send("hit", { to: b.sessionId, amount: 999, opts: { kind: "melee", crit: true, evil: 1, dir: { x: 1, z: 0 } } });
    await sleep(50);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].from, a.sessionId);
    assert.strictEqual(got[0].amount, 40, "clamped to maxHit");
    assert.deepStrictEqual(got[0].opts, { kind: "melee", crit: true, dir: { x: 1, z: 0 } });

    // too far away, or the victim in the lobby: dropped
    b.send("pose", { ...ARENA, x: 200 });
    await sleep(50);
    a.send("hit", { to: b.sessionId, amount: 5, opts: {} });
    b.send("pose", { zone: "lobby", x: 2 });
    await sleep(50);
    a.send("hit", { to: b.sessionId, amount: 5, opts: {} });
    await sleep(50);
    assert.strictEqual(got.length, 1);
    // only the host may hit on behalf of a bot
    b.send("pose", { ...ARENA, x: 2 });
    await sleep(50);
    a.send("hit", { to: b.sessionId, amount: 5, opts: {}, bot: 901 });
    await sleep(50);
    assert.strictEqual(room.state.host, a.sessionId);
    assert.strictEqual(got.at(-1).from, "bot:901");
    b.send("hit", { to: a.sessionId, amount: 5, opts: {}, bot: 902 });
    await sleep(50);
  });

  it("sends bot hits to the host and rewards the killer", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const host = await colyseus.connectTo(room, {});
    const other = await colyseus.connectTo(room, {});
    const botHits: any[] = [];
    const kills: any[] = [];
    const feed: any[] = [];
    host.onMessage("botHit", (m) => botHits.push(m));
    other.onMessage("kill", (m) => kills.push(m));
    host.onMessage("feed", (m) => feed.push(m));
    host.send("pose", ARENA);
    await sleep(30);
    other.send("pose", ARENA);
    await sleep(50);
    other.send("botHit", { bot: 905, amount: 6, opts: { kind: "arrow" } });
    await sleep(50);
    assert.deepStrictEqual(botHits[0], { from: other.sessionId, bot: 905, amount: 6, opts: { kind: "arrow" } });

    // the host's bot dies to `other`: everyone else gets the feed line, `other` its reward
    host.send("botDied", { name: "EchoX", id: 905, by: other.sessionId, cause: "arrow", streak: 3 });
    await sleep(50);
    assert.deepStrictEqual(kills, [{ victim: "EchoX", streak: 3 }]);
    assert.strictEqual(room.state.players.get(other.sessionId)!.kills, 1);
    // a player dies to the host's bot
    other.send("died", { by: "bot:903", byName: "Zed", cause: "melee", streak: 0 });
    await sleep(50);
    assert.strictEqual(feed.at(-1).killer, "Zed");
    assert.strictEqual(feed.at(-1).killerId, "bot:903");
  });
});
