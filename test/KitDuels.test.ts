import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { KIT } from "../src/constants.js";
import { eloDelta } from "../src/duels.js";
import { sanitizeKitSave } from "../src/kitStore.js";
import { KitState } from "../src/rooms/schema/KitState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("kit pvp duels + saves", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const timing = { ...KIT.duel };
  before(async () => {
    colyseus = await testServer();
    KIT.duel.countdownMs = 200; // fast rounds for the test
    KIT.duel.betweenMs = 40;
  });
  after(() => Object.assign(KIT.duel, timing));
  beforeEach(async () => await colyseus.cleanup());

  it("bounds a client save and never lets it carry the rating", () => {
    const s = sanitizeKitSave({ gold: 1e99, level: -5, kills: 12.7, kits: ["swordsman", "BAD ID", "archer", "archer"], kit: "tank", hotbar: [{ id: "apple", count: 1e9 }, { id: "<x>", count: 1 }], rating: 9999, duelsWon: 50, settings: { scoreboard: true, "bad key!": 1 } })!;
    assert.strictEqual(s.gold, KIT.save.goldMax);
    assert.strictEqual(s.level, 1);
    assert.strictEqual(s.kills, 12);
    assert.deepStrictEqual(s.kits, ["swordsman", "archer"]);
    assert.strictEqual(s.kit, undefined, "an unowned kit is not equipped");
    assert.deepStrictEqual(s.hotbar!.slice(0, 2), [{ id: "apple", count: 9999 }, null]);
    assert.strictEqual(s.hotbar!.length, 9);
    assert.strictEqual((s as Record<string, unknown>).rating, undefined);
    assert.strictEqual((s as Record<string, unknown>).duelsWon, undefined);
    assert.deepStrictEqual(s.settings, { scoreboard: true });
  });

  it("keeps kit mastery, a borrowed kit and the trial day, bounded", () => {
    const s = sanitizeKitSave({ mastery: { spark: 12.9, "BAD ID": 3, tamer: -4, samurai: 1e99 }, borrow: { id: "samurai", kind: "trial", paid: 99, used: true, extra: 1 }, trialDay: 20417.6 })!;
    assert.deepStrictEqual(s.mastery, { spark: 12, tamer: 0, samurai: KIT.save.countMax });
    assert.deepStrictEqual(s.borrow, { id: "samurai", kind: "trial", paid: 99, used: true });
    assert.strictEqual(s.trialDay, 20417);
    assert.strictEqual(sanitizeKitSave({ borrow: null })!.borrow, null, "returning a kit clears it");
    assert.strictEqual(sanitizeKitSave({ borrow: { id: "samurai", kind: "gift" } })!.borrow, undefined, "unknown kinds are dropped");
    assert.strictEqual(sanitizeKitSave({ mastery: ["spark"] })!.mastery, undefined);
  });

  it("rates an upset higher than an expected win", () => {
    assert.strictEqual(eloDelta(1000, 1000), 16);
    assert.ok(eloDelta(900, 1200) > eloDelta(1200, 900));
  });

  it("matches two players, plays the rounds and moves the ranked rating", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const a = await colyseus.connectTo(room, {});
    const b = await colyseus.connectTo(room, {});
    const got: Record<string, any[]> = { a: [], b: [] };
    for (const [k, c] of [["a", a], ["b", b]] as const) for (const t of ["duelStart", "duelRound", "duelScore", "duelEnd"]) c.onMessage(t, (m) => got[k].push({ t, ...m }));
    a.send("duelQueue", { mode: "ranked" });
    await sleep(30);
    assert.strictEqual(room.state.players.get(a.sessionId)!.queued, "ranked");
    b.send("duelQueue", { mode: "ranked" });
    await sleep(60);
    const start = got.a.find((m) => m.t === "duelStart");
    assert.ok(start, "matched");
    assert.strictEqual(start.side, 0);
    assert.strictEqual(room.state.players.get(b.sessionId)!.duel, start.id);
    assert.strictEqual(room.state.players.get(a.sessionId)!.queued, "");

    // dying during the countdown does not count
    b.send("duelDied", {});
    await sleep(10);
    assert.ok(!got.a.some((m) => m.t === "duelScore"));
    for (let i = 0; i < KIT.duel.wins; i++) {
      await sleep(320); // countdown (+ the pause between rounds) over
      b.send("duelDied", {});
      await sleep(30);
    }
    await sleep(50);
    const endA = got.a.find((m) => m.t === "duelEnd");
    const endB = got.b.find((m) => m.t === "duelEnd");
    assert.ok(endA && endB, "ended");
    assert.strictEqual(endA.won, true);
    assert.deepStrictEqual(endA.score, [3, 0]);
    assert.strictEqual(endA.delta, 16);
    assert.strictEqual(endB.delta, -16);
    assert.strictEqual(room.state.players.get(a.sessionId)!.rating, 1016);
    assert.strictEqual(room.state.players.get(b.sessionId)!.rating, 984);
    assert.strictEqual(room.state.players.get(a.sessionId)!.duel, "");
  });

  it("gives the duel to the other player when one leaves", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const a = await colyseus.connectTo(room, {});
    const b = await colyseus.connectTo(room, {});
    const ends: any[] = [];
    a.onMessage("duelEnd", (m) => ends.push(m));
    a.send("duelQueue", { mode: "casual" });
    b.send("duelQueue", { mode: "casual" });
    await sleep(60);
    b.send("duelLeave", {});
    await sleep(50);
    assert.strictEqual(ends.length, 1);
    assert.strictEqual(ends[0].won, true);
    assert.strictEqual(ends[0].forfeit, true);
    assert.strictEqual(ends[0].delta, 0, "casual duels never move the rating");
  });

  it("relays hits between the two duellists only", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const a = await colyseus.connectTo(room, {});
    const b = await colyseus.connectTo(room, {});
    const c = await colyseus.connectTo(room, {});
    const hitsB: any[] = [];
    const hitsC: any[] = [];
    b.onMessage("hit", (m) => hitsB.push(m));
    c.onMessage("hit", (m) => hitsC.push(m));
    a.send("duelQueue", { mode: "casual" });
    b.send("duelQueue", { mode: "casual" });
    await sleep(60);
    const pose = { zone: "duel", x: 150, y: -40, z: -60 };
    a.send("pose", pose);
    b.send("pose", { ...pose, x: 152 });
    c.send("pose", { ...pose, x: 151 }); // not in this duel
    await sleep(50);
    a.send("hit", { to: b.sessionId, amount: 5, opts: {} });
    a.send("hit", { to: c.sessionId, amount: 5, opts: {} });
    await sleep(50);
    assert.strictEqual(hitsB.length, 1);
    assert.strictEqual(hitsC.length, 0);
  });

  it("puts the room's players on the leaderboards from their saves", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const a = await colyseus.connectTo(room, {});
    const boards: any[] = [];
    a.onMessage("leaderboard", (m) => boards.push(m.boards));
    a.send("save", { kills: 7, gold: 300, playtime: 120, level: 4 });
    await sleep(50);
    await (room as unknown as { sendBoards(): Promise<void> }).sendBoards(); // the periodic broadcast
    await sleep(50);
    const kills = boards.at(-1).kills;
    assert.strictEqual(kills[0].value, 7);
    assert.strictEqual(kills[0].level, 4);
    assert.strictEqual(boards.at(-1).rating.length, 0, "nobody has played ranked yet");
  });
});
