// Extra tools layered on top of the base Sleeper MCP server:
//   search_players, compare_players, research_player_status  (ported ideas from FloSchl8/sleeper-mcp)
//   power_rankings, playoff_odds, trade_finder               (new)
// Everything here uses only Sleeper's public API plus Google News RSS for headlines.

const API = "https://api.sleeper.app/v1";
const API2 = "https://api.sleeper.com";
const POS_QS = ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `position[]=${p}`).join("&");

type Json = any;
type ToolResult = { content: Array<{ type: "text"; text: string }> };

export type LeagueRef = { leagueId: string; rosterId?: string; leagueName?: string };
export type Resolver = (hint?: string) => Promise<{ league: LeagueRef } | null>;

// ---------------------------------------------------------------- fetch + cache
const cache = new Map<string, { t: number; v: any }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
async function getJson(url: string, tries = 3): Promise<any> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error(`HTTP ${r.status} for ${url}`);
      if (r.status === 404) break;
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  throw last;
}

const HOUR = 3600_000;
const getState = () => cached("state", 5 * 60_000, () => getJson(`${API}/state/nfl`));
const getPlayers = () => cached<Record<string, Json>>("players", 24 * HOUR, () => getJson(`${API}/players/nfl`));
const getLeague = (id: string) => cached(`league:${id}`, 5 * 60_000, () => getJson(`${API}/league/${id}`));
const getRosters = (id: string) => cached<Json[]>(`rosters:${id}`, 5 * 60_000, () => getJson(`${API}/league/${id}/rosters`));
const getUsers = (id: string) => cached<Json[]>(`users:${id}`, 30 * 60_000, () => getJson(`${API}/league/${id}/users`));
const getMatchups = (id: string, w: number) =>
  cached<Json[]>(`matchups:${id}:${w}`, 5 * 60_000, () => getJson(`${API}/league/${id}/matchups/${w}`));

async function weekStats(season: string, week: number): Promise<Map<string, Json>> {
  return cached(`stats:${season}:${week}`, 30 * 60_000, async () => {
    const arr: Json[] = await getJson(`${API2}/stats/nfl/${season}/${week}?season_type=regular&${POS_QS}`);
    return new Map(arr.map((x) => [String(x.player_id), x.stats || {}]));
  });
}
async function weekProj(season: string, week: number): Promise<Map<string, Json>> {
  return cached(`proj:${season}:${week}`, 30 * 60_000, async () => {
    const arr: Json[] = await getJson(`${API2}/projections/nfl/${season}/${week}?season_type=regular&${POS_QS}`);
    return new Map(arr.map((x) => [String(x.player_id), x.stats || {}]));
  });
}

// ---------------------------------------------------------------- scoring + values
function ptsKey(league: Json): "pts_ppr" | "pts_half_ppr" | "pts_std" {
  const rec = Number(league?.scoring_settings?.rec ?? 1);
  if (rec >= 0.99) return "pts_ppr";
  if (rec >= 0.4) return "pts_half_ppr";
  return "pts_std";
}

const OUT = new Set(["Out", "IR", "PUP", "Sus", "Suspended", "NA", "COV"]);
function injuryFactor(status?: string | null): number {
  if (!status) return 1;
  if (OUT.has(status)) return 0.15;
  if (status === "Doubtful") return 0.55;
  if (status === "Questionable") return 0.95;
  return 1;
}

export type PlayerVal = {
  id: string;
  name: string;
  pos: string;
  team: string | null;
  injury: string | null;
  seasonAvg: number;
  last3: number;
  proj: number | null;
  games: number;
  value: number; // weekly points-equivalent used by every tool here
};

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

async function buildValues(league: Json): Promise<{ vals: Map<string, PlayerVal>; week: number; season: string; key: string }> {
  const state = await getState();
  const season: string = String(league.season || state.season);
  const week: number = Math.max(1, Number(state.week));
  const key = ptsKey(league);
  const players = await getPlayers();

  const lastDone = state.season_type === "regular" ? week - 1 : 18;
  const weeks = Array.from({ length: Math.max(0, lastDone) }, (_, i) => i + 1);
  const statMaps = await Promise.all(weeks.map((w) => weekStats(season, w).catch(() => new Map<string, Json>())));
  let proj = new Map<string, Json>();
  try {
    proj = await weekProj(season, week);
  } catch {
    /* projections optional */
  }

  const history = new Map<string, number[]>();
  statMaps.forEach((m) => {
    m.forEach((s, pid) => {
      const played = (s.gp ?? 0) > 0 || (s.off_snp ?? 0) > 0;
      const pts = s[key];
      if (played && typeof pts === "number") {
        if (!history.has(pid)) history.set(pid, []);
        history.get(pid)!.push(pts);
      }
    });
  });

  const vals = new Map<string, PlayerVal>();
  for (const [pid, p] of Object.entries(players)) {
    const pos = p.position as string;
    if (!["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos)) continue;
    const h = history.get(pid) || [];
    const pr = proj.get(pid)?.[key];
    const projection = typeof pr === "number" && pr > 0 ? pr : null;
    if (!h.length && projection == null) continue;
    const seasonAvg = mean(h);
    const last3 = mean(h.slice(-3));
    let v: number;
    if (projection != null && h.length) v = 0.4 * projection + 0.35 * last3 + 0.25 * seasonAvg;
    else if (projection != null) v = projection;
    else v = 0.55 * last3 + 0.45 * seasonAvg;
    v *= injuryFactor(p.injury_status);
    vals.set(pid, {
      id: pid,
      name: pos === "DEF" ? `${p.team || pid} DST` : `${p.first_name} ${p.last_name}`,
      pos,
      team: p.team ?? null,
      injury: p.injury_status ?? null,
      seasonAvg: round(seasonAvg),
      last3: round(last3),
      proj: projection == null ? null : round(projection),
      games: h.length,
      value: v,
    });
  }
  return { vals, week, season, key };
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- lineup optimiser
const FLEX_ELIGIBLE: Record<string, string[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};
function slotsOf(rosterPositions: string[]): string[] {
  return rosterPositions.filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI");
}
// Greedy: fixed slots first, then most restrictive flex to least restrictive. Optimal for standard layouts.
function optimalLineup(slots: string[], ids: string[], vals: Map<string, PlayerVal>) {
  const pool = ids.map((i) => vals.get(i)).filter(Boolean) as PlayerVal[];
  pool.sort((a, b) => b.value - a.value);
  const used = new Set<string>();
  const picked: Array<{ slot: string; p: PlayerVal | null }> = [];
  const order = [
    ...slots.filter((s) => !FLEX_ELIGIBLE[s]),
    ...["REC_FLEX", "WRRB_FLEX", "FLEX", "SUPER_FLEX"].flatMap((f) => slots.filter((s) => s === f)),
  ];
  let total = 0;
  for (const slot of order) {
    const elig = FLEX_ELIGIBLE[slot];
    const p = pool.find((x) => !used.has(x.id) && (elig ? elig.includes(x.pos) : x.pos === slot));
    if (p) {
      used.add(p.id);
      total += p.value;
    }
    picked.push({ slot, p: p || null });
  }
  return { total, picked, starters: used };
}

// ---------------------------------------------------------------- helpers
function teamNames(users: Json[], rosters: Json[]): Map<number, string> {
  const byOwner = new Map(users.map((u) => [u.user_id, u.metadata?.team_name || u.display_name]));
  const m = new Map<number, string>();
  rosters.forEach((r) => m.set(r.roster_id, byOwner.get(r.owner_id) || `Roster ${r.roster_id}`));
  return m;
}
const fpts = (s: Json) => (s?.fpts ?? 0) + (s?.fpts_decimal ?? 0) / 100;
const fptsAgainst = (s: Json) => (s?.fpts_against ?? 0) + (s?.fpts_against_decimal ?? 0) / 100;
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
function randn() {
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const ok = (o: any): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] });

function findPlayerIds(players: Record<string, Json>, vals: Map<string, PlayerVal> | null, q: string, limit = 10, position?: string) {
  const term = q.toLowerCase().trim();
  const out: Array<{ id: string; p: Json }> = [];
  for (const [id, p] of Object.entries(players)) {
    if (position && p.position !== position) continue;
    const full = (p.search_full_name || `${p.first_name || ""}${p.last_name || ""}`).toLowerCase();
    const spaced = `${p.first_name || ""} ${p.last_name || ""}`.toLowerCase();
    if (full.includes(term.replace(/\s+/g, "")) || spaced.includes(term)) out.push({ id, p });
  }
  out.sort((a, b) => {
    const act = (x: Json) => (x.status === "Active" ? 0 : 1);
    if (act(a.p) !== act(b.p)) return act(a.p) - act(b.p);
    const rank = (x: Json) => x.search_rank ?? 99999;
    return rank(a.p) - rank(b.p);
  });
  return out.slice(0, limit);
}

async function resolvePlayer(ref: string, players: Record<string, Json>): Promise<{ id: string; p: Json } | null> {
  if (players[ref]) return { id: ref, p: players[ref] };
  const hit = findPlayerIds(players, null, ref, 1);
  return hit[0] || null;
}

async function news(query: string): Promise<Array<{ title: string; source: string; published: string; link: string }>> {
  try {
    const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`);
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    const dec = (s: string) =>
      s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const parsed = items.map((m) => {
      const b = m[1];
      const g = (t: string) => dec((b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "");
      return { title: g("title"), source: g("source"), published: g("pubDate"), link: g("link") };
    });
    const cutoff = Date.now() - 45 * 24 * HOUR;
    const fresh = parsed.filter((x) => Date.parse(x.published) >= cutoff);
    return (fresh.length ? fresh : parsed).sort((x, y) => Date.parse(y.published) - Date.parse(x.published)).slice(0, 8);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- tool definitions
const leagueArg = {
  type: "string",
  description: "League name (or part of it) or league ID. Defaults to your first configured league.",
};

export const extraTools = [
  {
    name: "search_players",
    description: "Search NFL players by name (partial matches ok). Optionally filter by position. Returns Sleeper player IDs, team, injury status and a current value estimate.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Player name or part of it" },
        position: { type: "string", description: "Optional: QB, RB, WR, TE, K, DEF" },
        limit: { type: "number", description: "Max results (default 10)" },
        league: leagueArg,
      },
      required: ["query"],
    },
  },
  {
    name: "compare_players",
    description:
      "Head-to-head comparison of two players using season average, last-3-game average, this week's projection, injury status and a blended value, scored in the chosen league's format.",
    inputSchema: {
      type: "object",
      properties: {
        player1: { type: "string", description: "Player name or Sleeper player ID" },
        player2: { type: "string", description: "Player name or Sleeper player ID" },
        league: leagueArg,
      },
      required: ["player1", "player2"],
    },
  },
  {
    name: "research_player_status",
    description: "Check a player's current injury/roster status in Sleeper and pull the latest news headlines (web lookup) about injuries, role and playing time.",
    inputSchema: {
      type: "object",
      properties: {
        player: { type: "string", description: "Player name or Sleeper player ID" },
        team: { type: "string", description: "Optional team abbreviation to disambiguate" },
      },
      required: ["player"],
    },
  },
  {
    name: "power_rankings",
    description:
      "Power rankings for every team in a league: points for, recent form, roster value (optimal lineup projection), record, past and remaining schedule strength, plus Monte Carlo playoff odds.",
    inputSchema: { type: "object", properties: { league: leagueArg } },
  },
  {
    name: "playoff_odds",
    description: "Playoff odds for every team in a league from 10,000 simulations of the remaining regular season (uses real remaining schedule, team scoring strength and variance).",
    inputSchema: { type: "object", properties: { league: leagueArg } },
  },
  {
    name: "trade_finder",
    description:
      "Scan every other roster in a league for win-win trades. Finds swaps (1-for-1 and 2-for-1) that raise your optimal lineup while also helping the other team, and writes each as an offer. Excludes injured (Out/IR) targets.",
    inputSchema: {
      type: "object",
      properties: {
        league: leagueArg,
        limit: { type: "number", description: "Max offers to return (default 8)" },
        team: { type: "string", description: "Optional: find trades for another team (name) instead of yours" },
      },
    },
  },
];

const EXTRA_NAMES = new Set(extraTools.map((t) => t.name));
export const isExtraTool = (n: string) => EXTRA_NAMES.has(n);

// ---------------------------------------------------------------- handlers
export async function handleExtra(name: string, args: Json, resolve: Resolver): Promise<ToolResult> {
  const a = args || {};
  if (name === "research_player_status") return researchPlayer(a);
  const ctx = await resolve(a.league);
  if (!ctx) return ok({ error: "No league configured" });
  const league = await getLeague(ctx.league.leagueId);
  switch (name) {
    case "search_players":
      return searchPlayers(a, league);
    case "compare_players":
      return comparePlayers(a, league);
    case "power_rankings":
      return powerRankings(league, false);
    case "playoff_odds":
      return powerRankings(league, true);
    case "trade_finder":
      return tradeFinder(a, league, ctx.league);
  }
  return ok({ error: `Unknown tool ${name}` });
}

async function searchPlayers(a: Json, league: Json) {
  const players = await getPlayers();
  const { vals } = await buildValues(league);
  const hits = findPlayerIds(players, vals, String(a.query), Math.min(Number(a.limit) || 10, 25), a.position);
  return ok({
    league: league.name,
    results: hits.map(({ id, p }) => {
      const v = vals.get(id);
      return {
        player_id: id,
        name: `${p.first_name} ${p.last_name}`,
        position: p.position,
        team: p.team,
        status: p.status,
        injury_status: p.injury_status || null,
        age: p.age ?? null,
        value_pts_per_week: v ? round(v.value) : null,
        season_avg: v?.seasonAvg ?? null,
        last3_avg: v?.last3 ?? null,
        this_week_projection: v?.proj ?? null,
      };
    }),
  });
}

async function comparePlayers(a: Json, league: Json) {
  const players = await getPlayers();
  const { vals, week, key } = await buildValues(league);
  const [p1, p2] = await Promise.all([resolvePlayer(String(a.player1), players), resolvePlayer(String(a.player2), players)]);
  if (!p1 || !p2) return ok({ error: "Could not find one or both players", found: [p1?.p.last_name, p2?.p.last_name] });
  const row = (x: { id: string; p: Json }) => {
    const v = vals.get(x.id);
    return {
      name: `${x.p.first_name} ${x.p.last_name}`,
      position: x.p.position,
      team: x.p.team,
      injury_status: x.p.injury_status || "Healthy",
      games_played: v?.games ?? 0,
      season_avg: v?.seasonAvg ?? null,
      last3_avg: v?.last3 ?? null,
      week_projection: v?.proj ?? null,
      blended_value: v ? round(v.value) : null,
    };
  };
  const r1 = row(p1);
  const r2 = row(p2);
  const v1 = r1.blended_value ?? 0;
  const v2 = r2.blended_value ?? 0;
  const diff = round(v1 - v2);
  const lean = Math.abs(diff) < 0.75 ? "Too close to call on numbers" : diff > 0 ? r1.name : r2.name;
  return ok({
    league: league.name,
    scoring: key.replace("pts_", ""),
    week,
    player1: r1,
    player2: r2,
    edge: { blended_value_difference: diff, leans_toward: lean },
    note: "Blended value = 40% this week's projection, 35% last-3 average, 25% season average, discounted for injury status.",
  });
}

async function researchPlayer(a: Json) {
  const players = await getPlayers();
  let hit = await resolvePlayer(String(a.player), players);
  if (hit && a.team && String(hit.p.team).toUpperCase() !== String(a.team).toUpperCase()) {
    const alt = findPlayerIds(players, null, String(a.player), 10).find((x) => String(x.p.team).toUpperCase() === String(a.team).toUpperCase());
    if (alt) hit = alt;
  }
  if (!hit) return ok({ error: `Player "${a.player}" not found` });
  const p = hit.p;
  const name = `${p.first_name} ${p.last_name}`;
  const headlines = await news(`"${name}" NFL injury OR depth chart OR snap count`);
  return ok({
    player: name,
    position: p.position,
    team: p.team,
    sleeper_status: {
      roster_status: p.status,
      injury_status: p.injury_status || "Healthy",
      injury_body_part: p.injury_body_part || null,
      injury_notes: p.injury_notes || null,
      injury_start_date: p.injury_start_date || null,
      depth_chart_order: p.depth_chart_order ?? null,
    },
    recent_headlines: headlines,
    note: "Headlines come from a Google News search; open the links for details. Sleeper's injury fields can lag the news.",
  });
}

// ---------------------------------------------------------------- power rankings / playoff odds
async function powerRankings(league: Json, oddsOnly: boolean) {
  const id = league.league_id;
  const [rosters, users, state] = await Promise.all([getRosters(id), getUsers(id), getState()]);
  if (league.status !== "in_season") {
    return ok({ league: league.name, message: `League status is "${league.status}"; power rankings need an in-season league.` });
  }
  const names = teamNames(users, rosters);
  const { vals, week } = await buildValues(league);
  const slots = slotsOf(league.roster_positions || []);
  const regWeeks = Number(league.settings?.playoff_week_start || 15) - 1;
  const playoffTeams = Number(league.settings?.playoff_teams || 6);
  const medianGame = Number(league.settings?.league_average_match || 0) === 1;

  const matchupsByWeek: Json[][] = await Promise.all(Array.from({ length: regWeeks }, (_, i) => getMatchups(id, i + 1).catch(() => [])));
  const done = Math.max(0, Math.min(week - 1, regWeeks));

  const weekly = new Map<number, number[]>();
  for (let w = 0; w < done; w++) {
    for (const m of matchupsByWeek[w]) {
      if (!weekly.has(m.roster_id)) weekly.set(m.roster_id, []);
      weekly.get(m.roster_id)!.push(m.points || 0);
    }
  }

  const teams = rosters.map((r) => {
    const pts = weekly.get(r.roster_id) || [];
    const gp = (r.settings?.wins ?? 0) + (r.settings?.losses ?? 0) + (r.settings?.ties ?? 0);
    const avgPF = pts.length ? mean(pts) : gp ? fpts(r.settings) / gp : 0;
    const last3 = mean(pts.slice(-3));
    const lineup = optimalLineup(slots, r.players || [], vals).total;
    const mu = pts.length ? 0.35 * avgPF + 0.25 * last3 + 0.4 * lineup : lineup;
    const sd = Math.max(12, pts.length >= 3 ? std(pts) : 25);
    return {
      roster_id: r.roster_id as number,
      team: names.get(r.roster_id)!,
      wins: r.settings?.wins ?? 0,
      losses: r.settings?.losses ?? 0,
      ties: r.settings?.ties ?? 0,
      pf: fpts(r.settings),
      pa: fptsAgainst(r.settings),
      gp,
      avgPF,
      last3,
      lineup,
      mu,
      sd,
    };
  });
  const T = new Map(teams.map((t) => [t.roster_id, t]));

  // schedule strength: opponents' expected scoring
  const sos = (from: number, to: number, rid: number) => {
    const opp: number[] = [];
    for (let w = from; w < to; w++) {
      const mine = matchupsByWeek[w]?.find((m) => m.roster_id === rid);
      if (!mine || mine.matchup_id == null) continue;
      const o = matchupsByWeek[w].find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== rid);
      if (o) opp.push(T.get(o.roster_id)?.mu ?? 0);
    }
    return opp.length ? mean(opp) : null;
  };

  // Monte Carlo
  const SIMS = 10000;
  const n = teams.length;
  const idx = new Map(teams.map((t, i) => [t.roster_id, i]));
  const made = new Array(n).fill(0);
  const first = new Array(n).fill(0);
  const winSum = new Array(n).fill(0);
  const pairs: Array<Array<[number, number]>> = [];
  for (let w = done; w < regWeeks; w++) {
    const g = new Map<number, number[]>();
    for (const m of matchupsByWeek[w] || []) {
      if (m.matchup_id == null) continue;
      if (!g.has(m.matchup_id)) g.set(m.matchup_id, []);
      g.get(m.matchup_id)!.push(idx.get(m.roster_id)!);
    }
    pairs.push([...g.values()].filter((x) => x.length === 2).map((x) => [x[0], x[1]] as [number, number]));
  }
  for (let s = 0; s < SIMS; s++) {
    const wins = teams.map((t) => t.wins + t.ties * 0.5);
    const pf = teams.map((t) => t.pf);
    for (const wk of pairs) {
      const sc = teams.map((t) => Math.max(0, t.mu + t.sd * randn()));
      for (const [i, j] of wk) {
        if (sc[i] > sc[j]) wins[i]++;
        else if (sc[j] > sc[i]) wins[j]++;
        else {
          wins[i] += 0.5;
          wins[j] += 0.5;
        }
      }
      if (medianGame) {
        const med = [...sc].sort((x, y) => x - y)[Math.floor(n / 2) - 1] ?? 0;
        sc.forEach((x, i) => {
          if (x > med) wins[i]++;
        });
      }
      sc.forEach((x, i) => (pf[i] += x));
    }
    const order = teams.map((_, i) => i).sort((x, y) => wins[y] - wins[x] || pf[y] - pf[x]);
    order.slice(0, playoffTeams).forEach((i) => made[i]++);
    first[order[0]]++;
    wins.forEach((w, i) => (winSum[i] += w));
  }

  // power score
  const z = (get: (t: (typeof teams)[number]) => number) => {
    const arr = teams.map(get);
    const m = mean(arr);
    const sd = std(arr) || 1;
    return (t: (typeof teams)[number]) => (get(t) - m) / sd;
  };
  const zPF = z((t) => t.avgPF),
    zForm = z((t) => t.last3),
    zRoster = z((t) => t.lineup),
    zWin = z((t) => (t.gp ? (t.wins + t.ties / 2) / t.gp : 0));
  const raw = teams.map((t) => 0.3 * zPF(t) + 0.2 * zForm(t) + 0.3 * zRoster(t) + 0.2 * zWin(t));
  const lo = Math.min(...raw),
    hi = Math.max(...raw);

  const rows = teams
    .map((t, i) => ({
      team: t.team,
      record: `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`,
      power_score: round(((raw[i] - lo) / (hi - lo || 1)) * 100),
      avg_points_for: round(t.avgPF),
      last3_avg: round(t.last3),
      roster_value_lineup_pts: round(t.lineup),
      expected_weekly_score: round(t.mu),
      played_sos: round(sos(0, done, t.roster_id) ?? 0),
      remaining_sos: sos(done, regWeeks, t.roster_id) == null ? null : round(sos(done, regWeeks, t.roster_id)!),
      playoff_odds_pct: round((made[i] / SIMS) * 100),
      top_seed_pct: round((first[i] / SIMS) * 100),
      projected_final_wins: round(winSum[i] / SIMS),
    }))
    .sort((x, y) => (oddsOnly ? y.playoff_odds_pct - x.playoff_odds_pct : y.power_score - x.power_score))
    .map((r, i) => ({ rank: i + 1, ...r }));

  const out: Json = {
    league: league.name,
    week,
    regular_season_weeks: regWeeks,
    playoff_spots: playoffTeams,
    simulations: SIMS,
    best_ball: Number(league.settings?.best_ball || 0) === 1,
    rankings: oddsOnly
      ? rows.map((r) => ({ rank: r.rank, team: r.team, record: r.record, playoff_odds_pct: r.playoff_odds_pct, top_seed_pct: r.top_seed_pct, projected_final_wins: r.projected_final_wins, remaining_sos: r.remaining_sos }))
      : rows,
    method:
      "Power score (0-100) = 30% avg points for, 20% last-3 avg, 30% roster value (best lineup by blended projection), 20% win%. Playoff odds simulate each remaining week with team scoring ~ Normal(expected score, observed std dev); ties broken by points for. SOS = average expected scoring of opponents (higher = harder).",
  };
  return ok(out);
}

// ---------------------------------------------------------------- trade finder
async function tradeFinder(a: Json, league: Json, ref: LeagueRef) {
  const id = league.league_id;
  const [rosters, users] = await Promise.all([getRosters(id), getUsers(id)]);
  const names = teamNames(users, rosters);
  const { vals, week } = await buildValues(league);
  const slots = slotsOf(league.roster_positions || []);

  let me = rosters.find((r) => String(r.roster_id) === String(ref.rosterId));
  if (a.team) {
    const t = String(a.team).toLowerCase();
    me = rosters.find((r) => (names.get(r.roster_id) || "").toLowerCase().includes(t)) || me;
  }
  if (!me) return ok({ error: "Could not determine your roster in this league" });

  const myIds: string[] = (me.players || []).filter((p: string) => vals.has(p));
  const myBase = optimalLineup(slots, myIds, vals).total;
  const V = (pid: string) => vals.get(pid)!;
  const tag = (p: PlayerVal) => `${p.name} (${p.pos}, ${p.team || "FA"}${p.injury ? `, ${p.injury}` : ""}, ~${round(p.value)}/wk)`;

  type Offer = { team: string; give: string[]; get: string[]; my_gain: number; their_gain: number; roster_note?: string };
  const offers: Offer[] = [];

  for (const r of rosters) {
    if (r.roster_id === me.roster_id) continue;
    const theirIds: string[] = (r.players || []).filter((p: string) => vals.has(p));
    const theirBase = optimalLineup(slots, theirIds, vals).total;
    const targets = theirIds.filter((q) => !OUT.has(V(q).injury || "") && V(q).value >= 4);
    const mine = myIds.filter((p) => V(p).value >= 1);

    // 1-for-1
    for (const p of mine) {
      for (const q of targets) {
        if (V(q).value < V(p).value * 0.8 && V(p).value > 6) continue;
        const myNew = optimalLineup(slots, myIds.filter((x) => x !== p).concat(q), vals).total;
        const gMe = myNew - myBase;
        if (gMe < 1) continue;
        const thNew = optimalLineup(slots, theirIds.filter((x) => x !== q).concat(p), vals).total;
        const gTh = thNew - theirBase;
        if (gTh < 0.5) continue;
        offers.push({ team: names.get(r.roster_id)!, give: [tag(V(p))], get: [tag(V(q))], my_gain: round(gMe), their_gain: round(gTh) });
      }
    }
    // 2-for-1 (you consolidate depth into one better player)
    const topTargets = [...targets].sort((x, y) => V(y).value - V(x).value).slice(0, 8);
    const giveable = [...mine].sort((x, y) => V(y).value - V(x).value).slice(0, 14);
    for (const q of topTargets) {
      for (let i = 0; i < giveable.length; i++) {
        for (let j = i + 1; j < giveable.length; j++) {
          const p1 = giveable[i],
            p2 = giveable[j];
          const myNew = optimalLineup(slots, myIds.filter((x) => x !== p1 && x !== p2).concat(q), vals).total;
          const gMe = myNew - myBase;
          if (gMe < 1.5) continue;
          const thNew = optimalLineup(slots, theirIds.filter((x) => x !== q).concat(p1, p2), vals).total;
          const gTh = thNew - theirBase;
          if (gTh < 1) continue;
          offers.push({
            team: names.get(r.roster_id)!,
            give: [tag(V(p1)), tag(V(p2))],
            get: [tag(V(q))],
            my_gain: round(gMe),
            their_gain: round(gTh),
            roster_note: "They receive one extra player, so they would need to drop someone.",
          });
        }
      }
    }
  }

  // best mutual benefit first, then biggest gain for you; keep a spread across teams
  offers.sort((x, y) => Math.min(y.my_gain, y.their_gain) - Math.min(x.my_gain, x.their_gain) || y.my_gain - x.my_gain);
  const limit = Math.min(Number(a.limit) || 8, 20);
  const perTeam = new Map<string, number>();
  const picked: Offer[] = [];
  const seen = new Set<string>();
  for (const o of offers) {
    const k = `${o.team}|${o.get.join()}`;
    if (seen.has(k)) continue;
    if ((perTeam.get(o.team) || 0) >= 2) continue;
    seen.add(k);
    perTeam.set(o.team, (perTeam.get(o.team) || 0) + 1);
    picked.push(o);
    if (picked.length >= limit) break;
  }

  // need / surplus summary for your team
  const lineup = optimalLineup(slots, myIds, vals);
  const byPos: Record<string, { starters: string[]; best_bench: string | null }> = {};
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const st = lineup.picked.filter((x) => x.p?.pos === pos).map((x) => `${x.p!.name} ~${round(x.p!.value)}`);
    const bench = myIds
      .map(V)
      .filter((p) => p.pos === pos && !lineup.starters.has(p.id))
      .sort((x, y) => y.value - x.value)[0];
    byPos[pos] = { starters: st, best_bench: bench ? `${bench.name} ~${round(bench.value)}` : null };
  }

  return ok({
    league: league.name,
    team: names.get(me.roster_id),
    week,
    your_lineup_pts_per_week: round(myBase),
    position_summary: byPos,
    offers: picked.map((o, i) => ({
      n: i + 1,
      to_team: o.team,
      you_give: o.give,
      you_get: o.get,
      your_lineup_gain_pts_per_week: o.my_gain,
      their_lineup_gain_pts_per_week: o.their_gain,
      note: o.roster_note,
      pitch: `Offer ${o.team}: your ${o.give.join(" + ")} for their ${o.get.join(" + ")}. Raises your best lineup by ${o.my_gain} pts/wk and theirs by ${o.their_gain}.`,
    })),
    method:
      "Every 1-for-1 and 2-for-1 swap is scored by recomputing both teams' optimal starting lineups from blended player values (40% this week's projection, 35% last-3 avg, 25% season avg, injury-discounted). Only trades that help both sides are shown. Values are estimates; check news before sending.",
  });
}
