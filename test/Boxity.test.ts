import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { KIT } from "../src/constants.js";
import { BADGES, badgesFor } from "../src/boxity/badges.js";
import { __resetBadgeClient, badgeCheck, badgeJoin } from "../src/boxity/badgeClient.js";
import { BOARDS } from "../src/boxity/boards.js";
import { AdGate } from "../src/boxity/ads.js";
import { flushLeaderboards, buildScoreBatches } from "../src/boxity/leaderboards.js";
import { __resetMirrors, allMirrors, attachMirror, KillGate, recordDuel, recordKill } from "../src/boxity/mirror.js";
import { buildStatBatches, flushStats, STAT_DEFS } from "../src/boxity/stats.js";
import { sanitizeKitSave } from "../src/kitStore.js";
import { KitState } from "../src/rooms/schema/KitState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const ARENA = { zone: "arena", x: 0, y: -115, z: -7 };
const realFetch = globalThis.fetch;
type Call = { url: string; body: any; auth: string };
let calls: Call[] = [];
// Fake Boxity API: tokens "tok-<name>" verify as user <name>; ad tokens "ad-ok..." are valid.
function stubFetch(over: (url: string, body: any) => { status?: number; body?: any } | undefined = () => undefined) {
  calls = [];
  globalThis.fetch = (async (url: any, init: any) => {
    // only the fake Boxity API is stubbed; the Colyseus test client's own HTTP goes through
    if (!/^https:\/\/api\./.test(String(url))) return realFetch(url, init);
    const body = init?.body ? JSON.parse(init.body) : null;
    const auth = String(init?.headers?.Authorization ?? "");
    calls.push({ url: String(url), body, auth });
    const custom = over(String(url), body);
    let status = 200;
    let out: any = { ok: true };
    if (custom) {
      status = custom.status ?? 200;
      out = custom.body ?? out;
    } else if (String(url).endsWith("/v1/auth/game-token/verify")) {
      const name = auth.replace("Bearer tok-", "");
      out = { valid: true, user: { _id: name, username: name } };
    } else if (String(url).endsWith("/v1/ads/reward/verify")) out = { valid: String(body?.rewardToken).startsWith("ad-ok") };
    return { status, ok: status >= 200 && status < 300, json: async () => out } as Response;
  }) as typeof fetch;
}
const setEnv = () => {
  process.env.BLOXITY_REPORT_TOKEN = "rt";
  process.env.BLOXITY_GAME_ID = "kit-pvp";
  process.env.BLOXITY_API_URL = "https://api.test";
};
const clearEnv = () => {
  for (const k of ["BLOXITY_REPORT_TOKEN", "BLOXITY_GAME_ID", "BLOXITY_API_URL", "BLOXITY_GAME_SLUG"]) delete process.env[k];
};

describe("boxity: pure rules", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearEnv();
    __resetMirrors();
    __resetBadgeClient();
  });

  it("earns badges from server counters only", () => {
    assert.deepStrictEqual(badgesFor({ pvpKills: 0, bestStreak: 0, duelsWon: 0, rating: 1000 }), ["welcome"]);
    const all = badgesFor({ pvpKills: 500, bestStreak: 10, duelsWon: 10, rating: 1400 });
    assert.deepStrictEqual([...all].sort(), BADGES.map((b) => b.key).sort());
    assert.ok(badgesFor({ pvpKills: 25, bestStreak: 5, duelsWon: 1, rating: 1200 }).includes("hunter"));
    assert.ok(!badgesFor({ pvpKills: 24, bestStreak: 4, duelsWon: 0, rating: 1199 }).includes("hunter"));
    assert.strictEqual(new Set(BADGES.map((b) => b.key)).size, BADGES.length);
  });

  it("keeps the declared boards stable", () => {
    assert.deepStrictEqual(BOARDS.map((b) => `${b.id}:${b.mode}:${b.reset}`), ["kills:sum:weekly", "streak:best:weekly", "duels:sum:none", "rating:best:none"]);
  });

  it("builds stat batches: legion ids, batches of 200, invalid values omitted", () => {
    __resetMirrors();
    for (let i = 0; i < 450; i++) attachMirror(`u${i}`, { pvpKills: i });
    const bad = attachMirror("bad", { pvpKills: 5 });
    bad.pvpKills = Number.NaN;
    bad.duelsLost = -3;
    bad.bestStreak = 2e9;
    const batches = buildStatBatches(allMirrors());
    assert.deepStrictEqual(batches.map((b) => b.length), [200, 200, 51]);
    assert.strictEqual(batches[0][3].userId, "legion_u3");
    assert.deepStrictEqual(batches[0][3].values, { pvp_kills: 3, best_streak: 0, duels_won: 0, duels_lost: 0, rating: KIT.duel.startRating });
    const row = batches[2].find((r) => r.userId === "legion_bad")!;
    assert.deepStrictEqual(Object.keys(row.values).sort(), ["duels_won", "rating"], "NaN, negative and over-ceiling values are left out");
    assert.deepStrictEqual(STAT_DEFS.map((d) => d.key), ["pvp_kills", "best_streak", "duels_won", "duels_lost", "rating"]);
    for (const r of batches.flat()) assert.ok(r.userId.startsWith("legion_"), "guests have no mirror, only legion ids go out");
  });

  it("accumulates leaderboard deltas and only forgets them once a batch lands", () => {
    __resetMirrors();
    const m = attachMirror("a", null);
    recordKill(m, 1);
    recordKill(m, 2);
    recordDuel(m, true, 1016);
    let batches = buildScoreBatches([m]);
    assert.deepStrictEqual(batches[0].scores, [
      { board: "kills", userId: "legion_a", score: 2 },
      { board: "streak", userId: "legion_a", score: 2 },
      { board: "duels", userId: "legion_a", score: 1 },
      { board: "rating", userId: "legion_a", score: 1016 },
    ]);
    recordKill(m, 1); // gained while the request was in flight
    batches[0].commit();
    batches = buildScoreBatches([m]);
    assert.deepStrictEqual(batches[0].scores, [{ board: "kills", userId: "legion_a", score: 1 }], "only the new kill is left; streak/rating unchanged");
    // a failed batch is never committed: the next build carries the same amount again
    assert.deepStrictEqual(buildScoreBatches([m])[0].scores, [{ board: "kills", userId: "legion_a", score: 1 }]);
    // a player still on the start rating is not ranked
    const fresh = attachMirror("b", null);
    assert.deepStrictEqual(buildScoreBatches([fresh]), []);
    // 450 players -> batches of 200
    __resetMirrors();
    for (let i = 0; i < 450; i++) recordKill(attachMirror(`p${i}`, null), 1);
    assert.deepStrictEqual(buildScoreBatches(allMirrors()).map((b) => b.scores.length), [200, 200, 200, 200, 100], "kills + streak per player");
  });

  it("does nothing without the hosting credentials", async () => {
    stubFetch();
    recordKill(attachMirror("a", null), 1);
    await flushStats();
    await flushLeaderboards();
    assert.strictEqual(calls.length, 0);
  });

  it("posts stats and leaderboards with the report token, keeping scores when a post fails", async () => {
    setEnv();
    stubFetch();
    const m = attachMirror("a", { pvpKills: 7 });
    recordKill(m, 3);
    await flushStats();
    assert.strictEqual(calls[0].url, "https://api.test/v1/games/kit-pvp/stats");
    assert.strictEqual(calls[0].auth, "Bearer rt");
    assert.strictEqual(calls[0].body.definitions.length, 5);
    assert.strictEqual(calls[0].body.players[0].values.pvp_kills, 8);
    await flushLeaderboards();
    const lb = calls.find((c) => c.url.includes("/v1/leaderboards/hosted/kit-pvp/report"))!;
    assert.deepStrictEqual(lb.body.boards, BOARDS);
    assert.deepStrictEqual(lb.body.scores.map((s: any) => s.board), ["kills", "streak"]);
    assert.strictEqual(m.pendingKills, 0, "landed: forgotten");
    recordKill(m, 1);
    stubFetch(() => ({ status: 500, body: { ok: false } }));
    await flushLeaderboards();
    assert.strictEqual(m.pendingKills, 1, "failed: kept for the next flush");
  });

  it("awards each badge once, retries a failed award and stops on 403", async () => {
    setEnv();
    process.env.BLOXITY_GAME_SLUG = "kit-pvp";
    let awardFails = true;
    stubFetch((url) => {
      if (url.endsWith("/declare")) return { body: { ok: true } };
      if (url.endsWith("/owned")) return { body: { owned: { legion_a: ["welcome"] } } };
      if (url.endsWith("/award")) return awardFails ? { status: 500, body: {} } : { body: { awarded: [] } };
      return undefined;
    });
    const m = attachMirror("a", { pvpKills: 30 });
    badgeJoin(m);
    await sleep(80);
    const award = () => calls.filter((c) => c.url.endsWith("/award"));
    assert.deepStrictEqual(award()[0].body.awards.map((a: any) => a.key).sort(), ["first_blood", "hunter"], "welcome is already held");
    assert.strictEqual(award()[0].body.gameSlug, "kit-pvp");
    assert.ok(calls.find((c) => c.url.endsWith("/declare"))!.body.badges.length === BADGES.length);
    awardFails = false;
    await badgeCheck(m); // the failed ones are sent again
    assert.strictEqual(award().length, 2);
    await badgeCheck(m);
    assert.strictEqual(award().length, 2, "nothing left to send");
    // a 403 (dev channel on production) switches every badge call off
    __resetBadgeClient();
    stubFetch((url) => (url.endsWith("/declare") ? { status: 403, body: {} } : undefined));
    badgeJoin(attachMirror("c", null));
    await sleep(60);
    const n = calls.length;
    await badgeCheck(attachMirror("d", null));
    assert.strictEqual(calls.length, n);
  });

  it("gates kills and ads", () => {
    const k = new KillGate();
    assert.ok(k.allow("a", 1000));
    assert.ok(!k.allow("a", 1000 + KIT.killGapMs - 1));
    assert.ok(k.allow("a", 1000 + KIT.killGapMs));
    const ad = new AdGate();
    assert.strictEqual(ad.check("s", 0), null);
    assert.strictEqual(ad.check("s", 1000), "cooldown");
    ad.refund("s");
    assert.strictEqual(ad.check("s", 1001), null);
    for (let i = 0; i < KIT.ad.maxPerSession; i++) ad.check("t", i * KIT.ad.cooldownMs);
    assert.strictEqual(ad.check("t", 99 * KIT.ad.cooldownMs), "limit");
  });

  it("never lets a client save carry the server-owned counters", () => {
    const s = sanitizeKitSave({ gold: 5, pvpKills: 999, pvpBestStreak: 99, duelsWon: 9, rating: 3000 }) as Record<string, unknown>;
    for (const k of ["pvpKills", "pvpBestStreak", "duelsWon", "rating"]) assert.strictEqual(s[k], undefined);
  });
});

describe("boxity: kit room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    __resetMirrors();
    stubFetch();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearEnv();
  });

  it("publishes the verified Bloxity id on the roster and leaves guests empty", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const a = await colyseus.connectTo(room, { token: "tok-alice01" });
    const g = await colyseus.connectTo(room, {});
    await sleep(50);
    assert.strictEqual(room.state.players.get(a.sessionId)!.uid, "alice01");
    assert.strictEqual(room.state.players.get(g.sessionId)!.uid, "");
  });

  it("relays emotes by opaque catalogue id, bounded and rate limited", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const a = await colyseus.connectTo(room, {});
    const b = await colyseus.connectTo(room, {});
    const gotB: any[] = [];
    const gotA: any[] = [];
    b.onMessage("emote", (m) => gotB.push(m));
    a.onMessage("emote", (m) => gotA.push(m));
    const id = "000000000000000000000e01";
    a.send("emote", { id });
    a.send("emote", { id: "000000000000000000000e02" }); // within the same second: dropped
    await sleep(80);
    a.send("emote", { id: "not-an-id" });
    a.send("emote", {});
    await sleep(1100);
    a.send("emote", { id: "000000000000000000000E03" }); // upper case: not a catalogue id
    a.send("emote", { id: "000000000000000000000e04" });
    await sleep(80);
    assert.deepStrictEqual(gotB, [{ from: a.sessionId, id }, { from: a.sessionId, id: "000000000000000000000e04" }]);
    assert.deepStrictEqual(gotA, [], "the sender plays its own emote locally");
  });

  it("verifies rewarded-ad tokens with Boxity before telling the client to grant Gold", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const guest = await colyseus.connectTo(room, {});
    const a = await colyseus.connectTo(room, { token: "tok-alice01" });
    const res: any[] = [];
    const gres: any[] = [];
    a.onMessage("adRewardResult", (m) => res.push(m));
    guest.onMessage("adRewardResult", (m) => gres.push(m));
    guest.send("adReward", { placement: "bonus-gold", token: "ad-ok-guest-token" });
    a.send("adReward", { placement: "revive", token: "ad-ok-aaaaaaaa" });
    a.send("adReward", { placement: "bonus-gold", token: "ad-bad-aaaaaaaa" });
    await sleep(120);
    assert.strictEqual(gres[0].reason, "guest");
    assert.deepStrictEqual(res.slice(0, 2).map((r) => [r.ok, r.reason, r.gold]), [[false, "placement", 0], [false, "invalid", 0]]);
    a.send("adReward", { placement: "bonus-gold", token: "ad-ok-aaaaaaaa" }); // an invalid token did not burn the cooldown
    await sleep(120);
    assert.deepStrictEqual(res[2], { ok: true, placement: "bonus-gold", gold: KIT.ad.gold });
    const verify = calls.find((c) => c.url.endsWith("/v1/ads/reward/verify") && c.body.rewardToken === "ad-ok-aaaaaaaa")!;
    assert.deepStrictEqual(verify.body, { gameSlug: "kit-pvp", rewardToken: "ad-ok-aaaaaaaa" });
    a.send("adReward", { placement: "bonus-gold", token: "ad-ok-bbbbbbbb" });
    await sleep(100);
    assert.strictEqual(res[3].reason, "cooldown");
  });

  it("counts a player kill once per gap, never a bot kill, and feeds the mirror", async () => {
    const room = await colyseus.createRoom<KitState>("kitpvp", {});
    const killer = await colyseus.connectTo(room, { token: "tok-alice01" });
    const victim = await colyseus.connectTo(room, { token: "tok-bob0001" });
    const host = await colyseus.connectTo(room, {});
    killer.send("pose", ARENA);
    victim.send("pose", ARENA);
    host.send("pose", ARENA);
    await sleep(60);
    const alice = () => allMirrors().find((m) => m.userId === "alice01")!;
    victim.send("died", { by: killer.sessionId, cause: "melee", streak: 0 });
    await sleep(60);
    victim.send("died", { by: killer.sessionId, cause: "melee", streak: 0 }); // inside the gap: not counted
    await sleep(60);
    assert.strictEqual(alice().pvpKills, 1);
    assert.strictEqual(alice().pendingKills, 1);
    assert.strictEqual(alice().bestStreak, 1);
    // a bot dying never counts, nor does a guest killer
    const hostFirst = room.state.host;
    assert.ok(hostFirst);
    (hostFirst === host.sessionId ? host : hostFirst === killer.sessionId ? killer : victim).send("botDied", { name: "Echo", id: 7, by: killer.sessionId, cause: "arrow", streak: 1 });
    host.send("died", { by: killer.sessionId, cause: "melee", streak: 0 }); // a guest victim of a verified killer, but still in the gap
    await sleep(80);
    assert.strictEqual(alice().pvpKills, 1);
    assert.strictEqual(room.state.players.get(killer.sessionId)!.kills >= 2, true, "the roster's own kill count is unchanged behaviour");
    assert.strictEqual(allMirrors().find((m) => m.userId === "bob0001")!.pvpKills, 0);
  });
});
