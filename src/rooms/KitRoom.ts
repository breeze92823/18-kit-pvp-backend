import { Room, Client, CloseCode } from "colyseus";
import { KitState, KitPlayer } from "./schema/KitState.js";
import { KIT, ROOM_MAX_CLIENTS } from "../constants.js";
import { applyPose, cleanName, fitsBytes, RateLimit, sanitizeAct, sanitizeHit } from "../kitRelay.js";
import { verifyToken } from "../auth.js";
import { BOARD_STATS, loadKit, savePvpKill, sanitizeKitSave, saveKit, saveRating, savedTops, type BoardRow, type KitDoc } from "../kitStore.js";
import { DuelBook, eloDelta, type Duel, type DuelMode } from "../duels.js";
import { AdGate, verifyAdToken } from "../boxity/ads.js";
import { badgeCheck, badgeJoin, flushLeaderboards } from "../boxity/index.js";
import { attachMirror, detachMirror, KillGate, recordDuel, recordKill, type Mirror } from "../boxity/mirror.js";

/**
 * Kit PvP: the client joins with `joinOrCreate("kitpvp", { token, kit, pose })`. The roster
 * (KitState) carries every player's pose, kit, hp and look flags. Combat is client-authoritative
 * and relayed: the attacker's client detects a hit and the server forwards it to the victim's
 * client, which applies armor, shields and kit powers itself and reports its own death. The
 * arena bots are simulated by one client, the host (the earliest player in the arena): it
 * streams them as `bots` snapshots, and hits on bots go to it. The server only bounds numbers,
 * checks range and zones, and rate-limits (kitRelay.ts).
 *
 * client -> server: pose, hit { to, amount, opts, bot? }, botHit { bot, amount, opts },
 *   act { to | bot, type, ... }, fx { ... }, bots { ... } (host), died { by, byName, cause, streak },
 *   botDied { name, by, byName, cause, streak } (host), summon { a } (forwarded to the host),
 *   emote { id } (Boxity catalogue id, 24 hex), adReward { placement, token } (rewarded ad, boxity/ads.ts)
 * server -> client: hit { from, amount, opts }, botHit { from, bot, amount, opts }, act { from, ... },
 *   botAct { from, bot, ... }, fx { from, ... }, bots { ... }, feed { victim, victimId, killer, killerId, cause },
 *   kill { victim, streak }, summon { from, a }, emote { from, id }, adRewardResult { ok, placement, gold, reason? }
 */
export class KitRoom extends Room<{ state: KitState }> {
  state = new KitState();
  maxClients = ROOM_MAX_CLIENTS;
  private joins = 0;
  private hitRate = new RateLimit(KIT.hitsPerSecond);
  private actRate = new RateLimit(KIT.actsPerSecond);
  private fxRate = new RateLimit(KIT.fxPerSecond);
  private emoteRate = new RateLimit(KIT.emotesPerSecond);
  private killGate = new KillGate();
  private adGate = new AdGate();
  private mirrors = new Map<string, Mirror>(); // sessionId -> server-owned counters (boxity/mirror.ts)

  private player(id: string) {
    return this.state.players.get(id);
  }
  private client(id: string) {
    return this.clients.find((c) => c.sessionId === id);
  }
  private inArena = (p: KitPlayer | undefined) => !!p && p.zone === "arena";
  // may these two hurt each other? both in the arena, or both in the same duel
  private together(a: KitPlayer | undefined, b: KitPlayer | undefined) {
    if (!a || !b) return false;
    if (a.zone === "arena" && b.zone === "arena") return true;
    return a.zone === "duel" && b.zone === "duel" && !!a.duel && a.duel === b.duel;
  }

  // --- saves + leaderboards (kitStore.ts) ---------------------------------------------------
  private userIds = new Map<string, string>(); // sessionId -> verified Bloxity id
  private loaded = new Set<string>(); // sessions whose save has been read (only these may write)
  private live = new Map<string, { name: string; level: number; kills: number; playtime: number; gold: number }>();
  private pending = new Map<string, Partial<KitDoc>>(); // throttled writes
  private writing = new Set<string>();
  private duels = new DuelBook();

  onCreate() {
    this.clock.setInterval((): void => {
      void this.sendBoards();
    }, KIT.boardEveryMs);
    this.clock.setInterval((): void => this.flushSaves(), KIT.saveEveryMs);
  }

  private async boards() {
    const saved = await savedTops();
    const out: Record<string, BoardRow[]> = {};
    for (const stat of BOARD_STATS) {
      const rows = new Map<string, BoardRow>();
      for (const r of saved[stat]) rows.set(r.id, { name: r.name, level: r.level, value: r.value });
      this.state.players.forEach((p, sid) => {
        const s = this.live.get(sid);
        // ranked: only players who have played (the start rating is everyone's default)
        const value = stat === "rating" ? (p.rating !== KIT.duel.startRating ? p.rating : 0) : s ? s[stat] : 0;
        if (!value) return;
        const id = this.userIds.get(sid) ?? sid;
        const prev = rows.get(id);
        if (!prev || prev.value <= value) rows.set(id, { name: p.name, level: p.level, value });
      });
      out[stat] = [...rows.values()].sort((a, b) => b.value - a.value).slice(0, KIT.boardSize);
    }
    return out;
  }
  private async sendBoards(client?: Client) {
    const boards = await this.boards();
    if (client) client.send("leaderboard", { boards });
    else this.broadcast("leaderboard", { boards });
  }
  private flushSaves() {
    for (const [sid, patch] of this.pending) {
      const userId = this.userIds.get(sid);
      if (!userId || this.writing.has(sid)) continue;
      this.pending.delete(sid);
      this.writing.add(sid);
      const name = this.player(sid)?.name ?? "Player";
      void saveKit(userId, name, patch).finally(() => this.writing.delete(sid));
    }
  }

  // --- duels (duels.ts) -----------------------------------------------------------------------
  private tryMatch(mode: DuelMode) {
    for (let duel = this.duels.match(mode); duel; duel = this.duels.match(mode)) {
      duel.players.forEach((sid, side) => {
        const p = this.player(sid);
        const o = this.player(duel.players[1 - side]);
        if (!p || !o) return;
        p.queued = "";
        p.duel = duel.id;
        this.client(sid)?.send("duelStart", { id: duel.id, slot: duel.slot, mode: duel.mode, side, opponent: o.name, opponentId: duel.players[1 - side], opponentRating: o.rating, rating: p.rating });
      });
      this.nextRound(duel);
    }
  }
  private nextRound(duel: Duel) {
    duel.round++;
    duel.phase = "countdown";
    for (const sid of duel.players) this.client(sid)?.send("duelRound", { id: duel.id, round: duel.round, score: duel.score, countdownMs: KIT.duel.countdownMs });
    this.clock.setTimeout(() => {
      if (this.duels.duels.get(duel.id) === duel && duel.phase === "countdown") duel.phase = "fight";
    }, KIT.duel.countdownMs);
  }
  private finish(duel: Duel, winner: 0 | 1, forfeit: boolean) {
    this.duels.end(duel);
    const [wId, lId] = [duel.players[winner], duel.players[1 - winner]];
    const w = this.player(wId);
    const l = this.player(lId);
    let delta = 0;
    if (duel.mode === "ranked" && w && l) {
      delta = eloDelta(w.rating, l.rating);
      w.rating = Math.min(KIT.duel.ratingMax, w.rating + delta);
      l.rating = Math.max(KIT.duel.ratingMin, l.rating - delta);
      const wu = this.userIds.get(wId);
      const lu = this.userIds.get(lId);
      if (wu) void saveRating(wu, w.rating, true);
      if (lu) void saveRating(lu, l.rating, false);
      // Boxity stats / boards / badges: the ranked record is the persisted one (saveRating)
      for (const [sid, won, p] of [[wId, true, w], [lId, false, l]] as const) {
        const m = this.mirrors.get(sid);
        if (!m) continue;
        recordDuel(m, won, p.rating);
        void badgeCheck(m);
      }
      void flushLeaderboards();
    }
    duel.players.forEach((sid, side) => {
      const p = this.player(sid);
      if (p) p.duel = "";
      this.client(sid)?.send("duelEnd", { id: duel.id, won: side === winner, score: duel.score, forfeit, mode: duel.mode, delta: side === winner ? delta : -delta, rating: p?.rating ?? 0 });
    });
    if (duel.mode === "ranked") void this.sendBoards(); // the Top Ranked list moves now, not in 30 s
    this.tryMatch("casual");
    this.tryMatch("ranked");
  }
  private leaveDuels(sid: string) {
    this.duels.dequeue(sid);
    const p = this.player(sid);
    if (p) p.queued = "";
    const duel = this.duels.duelOf(sid);
    if (duel) this.finish(duel, (1 - duel.players.indexOf(sid)) as 0 | 1, true);
  }
  private near(a: KitPlayer, b: KitPlayer) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= KIT.hitRange;
  }
  private host() {
    return this.state.host ? this.client(this.state.host) : undefined;
  }

  // The host simulates the bots: keep the current one while it stays in the arena, else the
  // earliest arena player. "" when nobody is fighting.
  private electHost() {
    const cur = this.player(this.state.host);
    if (cur && this.inArena(cur)) return;
    let best = "";
    let bestAt = Infinity;
    this.state.players.forEach((p, id) => {
      if (this.inArena(p) && p.joinedAt < bestAt) {
        best = id;
        bestAt = p.joinedAt;
      }
    });
    this.state.host = best;
  }

  messages = {
    pose: (client: Client, msg: unknown) => {
      const p = this.player(client.sessionId);
      if (!p) return;
      const zone = p.zone;
      applyPose(p, msg);
      if (p.zone !== zone) this.electHost();
    },
    // A hit on another player (or, from the host, a bot's hit on a player: `bot` = its id).
    hit: (client: Client, msg: { to?: unknown; bot?: unknown }) => {
      const from = this.player(client.sessionId);
      const to = typeof msg?.to === "string" ? this.player(msg.to) : undefined;
      const hit = sanitizeHit(msg);
      if (!from || !to || !hit || msg.to === client.sessionId) return;
      if (!this.hitRate.allow(client.sessionId)) return;
      const bot = Number.isInteger(msg.bot) ? (msg.bot as number) : null;
      if (bot !== null) {
        if (client.sessionId !== this.state.host || !this.inArena(to)) return; // only the host speaks for bots
      } else if (!this.together(from, to) || !this.near(from, to)) return;
      this.client(msg.to as string)?.send("hit", { from: bot !== null ? `bot:${bot}` : client.sessionId, ...hit });
    },
    // A hit on a bot: the host applies it.
    botHit: (client: Client, msg: { bot?: unknown }) => {
      const from = this.player(client.sessionId);
      const hit = sanitizeHit(msg);
      const host = this.host();
      if (!from || !hit || !host || host.sessionId === client.sessionId || !this.inArena(from)) return;
      if (!Number.isInteger(msg?.bot) || !this.hitRate.allow(client.sessionId)) return;
      host.send("botHit", { from: client.sessionId, bot: msg.bot, ...hit });
    },
    // A status / ignite / push / teleport on a player (`to`) or a bot (`bot`, applied by the host).
    // The host also sends them on behalf of a bot (`by` = that bot's id).
    act: (client: Client, msg: { to?: unknown; bot?: unknown; by?: unknown }) => {
      const act = sanitizeAct(msg);
      if (!act || !this.player(client.sessionId) || !this.actRate.allow(client.sessionId)) return;
      const isHost = client.sessionId === this.state.host;
      const by = isHost && Number.isInteger(msg.by) ? `bot:${msg.by}` : client.sessionId;
      if (typeof msg.to === "string" && msg.to !== client.sessionId) {
        const to = this.player(msg.to);
        if (isHost ? this.inArena(to) || this.together(this.player(client.sessionId), to) : this.together(this.player(client.sessionId), to)) this.client(msg.to)?.send("act", { from: by, ...act });
      } else if (Number.isInteger(msg.bot) && !isHost) {
        this.host()?.send("botAct", { from: client.sessionId, bot: msg.bot, ...act });
      }
    },
    // Cosmetic events (thrown items, arrows, walls, lightning...): replayed by everyone else.
    fx: (client: Client, msg: unknown) => {
      if (!this.player(client.sessionId) || !fitsBytes(msg, KIT.fxBytes) || !this.fxRate.allow(client.sessionId)) return;
      this.broadcast("fx", { from: client.sessionId, ...(msg as object) }, { except: client });
    },
    // The host's bot snapshot (~10/s).
    bots: (client: Client, msg: unknown) => {
      if (client.sessionId !== this.state.host || !fitsBytes(msg, KIT.botsBytes)) return;
      this.broadcast("bots", msg, { except: client });
    },
    // The sender died. `by` = the killer's sessionId, "bot:<id>" or "".
    died: (client: Client, msg: { by?: unknown; byName?: unknown; cause?: unknown; streak?: unknown }) => {
      const p = this.player(client.sessionId);
      if (!p) return;
      const cause = typeof msg?.cause === "string" && (KIT.kinds as readonly string[]).includes(msg.cause) ? msg.cause : "melee";
      this.report(client, p.name, client.sessionId, msg?.by, msg?.byName, cause, msg?.streak);
      p.streak = 0;
    },
    // A bot died on the host.
    botDied: (client: Client, msg: { name?: unknown; id?: unknown; by?: unknown; byName?: unknown; cause?: unknown; streak?: unknown }) => {
      if (client.sessionId !== this.state.host) return;
      const cause = typeof msg?.cause === "string" && (KIT.kinds as readonly string[]).includes(msg.cause) ? msg.cause : "melee";
      this.report(client, cleanName(msg?.name) || "Bot", `bot:${Number(msg?.id) | 0}`, msg?.by, msg?.byName, cause, msg?.streak);
    },
    // The client's progress (state.js), throttled into Mongo for a verified player whose save has
    // been read; guests and serverless sessions only feed the live leaderboards.
    save: (client: Client, msg: unknown) => {
      const p = this.player(client.sessionId);
      const patch = sanitizeKitSave(msg);
      if (!p || !patch) return;
      if (patch.level) p.level = patch.level;
      this.live.set(client.sessionId, { name: p.name, level: p.level, kills: patch.kills ?? 0, playtime: patch.playtime ?? 0, gold: patch.gold ?? 0 });
      if (this.userIds.has(client.sessionId) && this.loaded.has(client.sessionId)) this.pending.set(client.sessionId, patch);
    },
    // Duels: queue for a mode, cancel, report losing a round, or quit (a forfeit).
    duelQueue: (client: Client, msg: { mode?: unknown }) => {
      const mode: DuelMode = msg?.mode === "ranked" ? "ranked" : "casual";
      const p = this.player(client.sessionId);
      if (!p || !this.duels.enqueue(client.sessionId, mode)) return;
      p.queued = mode;
      this.tryMatch(mode);
    },
    duelCancel: (client: Client) => {
      this.duels.dequeue(client.sessionId);
      const p = this.player(client.sessionId);
      if (p) p.queued = "";
    },
    duelDied: (client: Client) => {
      const duel = this.duels.duelOf(client.sessionId);
      if (!duel || duel.phase !== "fight") return;
      const side = duel.players.indexOf(client.sessionId) as 0 | 1;
      const { winner, over } = this.duels.roundLost(duel, side);
      for (const sid of duel.players) this.client(sid)?.send("duelScore", { id: duel.id, score: duel.score, roundWinner: winner });
      if (over) this.finish(duel, winner, false);
      else
        this.clock.setTimeout(() => {
          if (this.duels.duels.get(duel.id) === duel) this.nextRound(duel);
        }, KIT.duel.betweenMs);
    },
    duelLeave: (client: Client) => this.leaveDuels(client.sessionId),
    // Boxity emote: the portal picked an emote for the sender; everyone else replays it. The id is an
    // opaque catalogue id (24 hex): never checked against a list here, the catalogue grows without a release.
    emote: (client: Client, msg: { id?: unknown }) => {
      if (!this.player(client.sessionId)) return;
      const id = msg?.id;
      if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) return;
      if (!this.emoteRate.allow(client.sessionId)) return;
      this.broadcast("emote", { from: client.sessionId, id }, { except: client });
    },
    // A rewarded ad finished on the client: check its token with Boxity, then tell the client to grant
    // the Gold (the save is client-authoritative, so the server never writes gold itself).
    adReward: async (client: Client, msg: { placement?: unknown; token?: unknown }) => {
      const placement = typeof msg?.placement === "string" ? msg.placement : "";
      const deny = (reason: string) => client.send("adRewardResult", { ok: false, placement, gold: 0, reason });
      if (placement !== KIT.ad.placement) return deny("placement");
      if (!this.userIds.has(client.sessionId)) return deny("guest");
      const token = typeof msg?.token === "string" ? msg.token : "";
      if (token.length < 8 || token.length > 4096) return deny("token");
      const why = this.adGate.check(client.sessionId);
      if (why) return deny(why);
      let valid = false;
      try {
        valid = await verifyAdToken(token);
      } catch {
        valid = false;
      }
      if (!valid) {
        this.adGate.refund(client.sessionId);
        return deny("invalid");
      }
      client.send("adRewardResult", { ok: true, placement, gold: KIT.ad.gold });
    },
    // Necromancer zombies are bots: the host raises them for a non-host player.
    summon: (client: Client, msg: { a?: Record<string, unknown> }) => {
      const host = this.host();
      if (!host || host.sessionId === client.sessionId || !this.inArena(this.player(client.sessionId))) return;
      if (!this.actRate.allow(client.sessionId)) return;
      const a = msg?.a ?? {};
      const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
      host.send("summon", { from: client.sessionId, a: { count: n(a.count, 1, 4, 2), hp: n(a.hp, 1, 30, 10), life: n(a.life, 1, 60, 25) } });
    },
  };

  // A kill of another PLAYER (never a bot) by a verified player fighting in the arena, at most one per
  // KIT.killGapMs per killer: the only thing that feeds Boxity stats, leaderboards and badges.
  private countPvpKill(killerId: string, killer: KitPlayer, victimId: string) {
    const m = this.mirrors.get(killerId);
    const userId = this.userIds.get(killerId);
    if (!m || !userId || killer.zone !== "arena" || victimId.startsWith("bot:") || victimId === killerId) return;
    if (!this.player(victimId) || !this.killGate.allow(killerId)) return;
    recordKill(m, killer.streak);
    void savePvpKill(userId, killer.streak);
    void badgeCheck(m);
  }

  // Kill feed for everyone else + the killer's reward message.
  private report(sender: Client, victim: string, victimId: string, by: unknown, byName: unknown, cause: string, streak: unknown) {
    const killerId = typeof by === "string" ? by : "";
    const killer = killerId && !killerId.startsWith("bot:") ? this.player(killerId) : undefined;
    const killerName = killer ? killer.name : cleanName(byName);
    this.broadcast("feed", { victim, victimId, killer: killerName, killerId, cause }, { except: sender });
    if (killer && killerId !== sender.sessionId) {
      killer.kills++;
      killer.streak++;
      this.client(killerId)?.send("kill", { victim, streak: typeof streak === "number" ? Math.max(0, Math.min(999, streak | 0)) : 0 });
      this.countPvpKill(killerId, killer, victimId);
    }
  }

  async onJoin(client: Client, options?: { token?: unknown; kit?: unknown; pose?: unknown }) {
    const p = new KitPlayer();
    p.seed = Math.floor(Math.random() * 0xffffff);
    p.name = `Guest ${1000 + Math.floor(Math.random() * 9000)}`;
    p.joinedAt = ++this.joins;
    applyPose(p, { ...(options?.pose as object), kit: options?.kit });
    this.state.players.set(client.sessionId, p);
    this.electHost();
    const user = await verifyToken(options?.token);
    if (this.state.players.get(client.sessionId) !== p) return;
    p.rating = KIT.duel.startRating;
    if (user) {
      p.name = user.name;
      p.signedIn = true;
      p.uid = user.id;
      this.userIds.set(client.sessionId, user.id);
      const doc = await loadKit(user.id);
      if (this.state.players.get(client.sessionId) !== p) return;
      if (doc === "error") {
        client.send("noProgress", { reason: "error" }); // could not read: never overwrite it
      } else {
        this.loaded.add(client.sessionId);
        // server-owned counters for Boxity stats / boards / badges (a failed read gets none: never report zeros)
        const m = attachMirror(user.id, doc);
        this.mirrors.set(client.sessionId, m);
        void badgeJoin(m);
        if (doc) {
          p.rating = doc.rating ?? KIT.duel.startRating;
          p.level = doc.level ?? 1;
          const { _id, updatedAt, ...save } = doc;
          client.send("progress", { save, duelsWon: doc.duelsWon ?? 0, duelsLost: doc.duelsLost ?? 0 });
        } else client.send("noProgress", { reason: "new" });
      }
    } else client.send("noProgress", { reason: "guest" });
    void this.sendBoards(client);
  }

  // A deliberate leave drops the player at once; a dropped connection gets a few seconds.
  async onLeave(client: Client, code?: number) {
    if (code !== CloseCode.CONSENTED) {
      try {
        await this.allowReconnection(client, KIT.reconnectSeconds);
        return;
      } catch {
        // gone
      }
    }
    this.leaveDuels(client.sessionId);
    this.flushSaves();
    this.state.players.delete(client.sessionId);
    this.userIds.delete(client.sessionId);
    this.loaded.delete(client.sessionId);
    this.live.delete(client.sessionId);
    const mirrorUser = this.mirrors.get(client.sessionId)?.userId;
    if (mirrorUser) detachMirror(mirrorUser);
    this.mirrors.delete(client.sessionId);
    this.killGate.forget(client.sessionId);
    this.adGate.forget(client.sessionId);
    this.hitRate.forget(client.sessionId);
    this.actRate.forget(client.sessionId);
    this.fxRate.forget(client.sessionId);
    this.emoteRate.forget(client.sessionId);
    this.electHost();
  }
}
