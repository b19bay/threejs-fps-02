// sim.js — FOUNDRY-9 fixed-step simulation state: rounds, economy, win/loss.
// Pure game logic, no rendering. One state object, created by createSim(seed).
// Fixed dt = 1/60. All randomness flows from the seeded RNG so a given seed
// replays the same round (used by ?shot= deterministic screenshots).
import { COLLIDERS, SITES, SPAWNS, LANES, groundHeight, segmentBlocked, resolveCircle } from './world.js';
import { WEAPONS, weaponDamage, canAfford } from './weapon.js';

export const DT = 1 / 60;
export const ROUND_TIME = 100;
export const BUY_TIME = 12;
export const PLANT_TIME = 3;
export const DEFUSE_TIME = 5;
export const BOMB_FUSE = 35;
export const WIN_ROUNDS = 5;
export const MAX_ROUNDS = 9;

// Deterministic RNG (mulberry32). Seed from ?seed=, else Date.now().
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
export function yawTo(x0, z0, x1, z1) { return Math.atan2(-(x1 - x0), -(z1 - z0)); }

// One actor: the player or a bot. y is ground height under the actor.
export function makeActor(id, name, team, isPlayer) {
  return {
    id, name, team, isPlayer,
    x: 0, z: 0, y: 0, yaw: 0, pitch: 0,
    vx: 0, vz: 0, vy: 0, onGround: true, crouch: false, moving: false,
    hp: 100, armour: 0, alive: true,
    weapon: 'p12', mag: 12, reserve: 36, reloadT: 0, switchT: 0,
    fireT: 0, spread: 0, recoil: 0, grenades: 0, hasGrenade: false,
    money: 800, kills: 0, deaths: 0,
    lane: 'mid', wp: 0, holdT: 0, reactT: 0, aimErr: 0, state: 'advance',
    targetId: -1, plantT: 0, defuseT: 0, lastShotT: -99, flashT: 0,
    carrier: false, killsThisRound: 0,
  };
}

const BOT_NAMES_F = ['VEX', 'ANVIL', 'SLAG-2', 'EMBER'];
const BOT_NAMES_S = ['RUST', 'COIL', 'GRIT', 'ASH', 'TONG'];

export function createSim(seed) {
  const rng = mulberry32(seed);
  const s = {
    seed, rng, time: 0, round: 1,
    score: { F: 0, S: 0 },
    phase: 'buy', phaseT: BUY_TIME, timer: ROUND_TIME,
    // attacker alternates each round: odd rounds F attacks, even rounds S attacks.
    attacker: 'F',
    bomb: { state: 'carried', carrierId: 1, site: null, x: 0, z: 0, fuseT: BOMB_FUSE, plantT: 0 },
    actors: [], grenades: [], tracers: [], impacts: [],
    feed: [], log: [], banner: '', bannerT: 0, matchOver: false, winner: null,
    roundReason: '', buyOpen: true, stats: { shots: 0, hits: 0, kills: 0, plants: 0, defuses: 0, buys: 0, reloads: 0, grenades: 0 },
    events: [], // machine-readable play-test evidence: {kind, t, round, text}
  };
  // Player id 0 (team F). Teammate bots 1..4 (team F). Enemy bots 5..9 (team S).
  s.actors.push(makeActor(0, 'YOU', 'F', true));
  for (let i = 0; i < 4; i++) s.actors.push(makeActor(1 + i, BOT_NAMES_F[i], 'F', false));
  for (let i = 0; i < 5; i++) s.actors.push(makeActor(5 + i, BOT_NAMES_S[i], 'S', false));
  startRound(s);
  return s;
}

export function otherTeam(t) { return t === 'F' ? 'S' : 'F'; }
export function teamName(t) { return t === 'F' ? 'FOUNDRY' : 'SLAG'; }

export function ev(s, kind, text) {
  s.events.push({ kind, t: +s.time.toFixed(2), round: s.round, text });
  s.log.push(`[r${s.round} ${s.time.toFixed(1)}s] ${text}`);
  if (s.log.length > 400) s.log.shift();
}
export function feed(s, text) {
  s.feed.unshift(text);
  if (s.feed.length > 3) s.feed.pop();
}
export function setBanner(s, text, dur = 3) { s.banner = text; s.bannerT = dur; }

function placeAtSpawn(s, a) {
  const atk = a.team === s.attacker;
  const sp = atk ? SPAWNS.attacker : SPAWNS.defender;
  // Spread the five members of a team across the spawn area.
  const idx = a.isPlayer ? 0 : (a.team === 'F' ? a.id : a.id - 5);
  const offs = [[0, 0], [-2.5, -3], [-2.5, 3], [2.5, -3], [2.5, 3]];
  const o = offs[idx] || [0, 0];
  a.x = sp.x + o[0]; a.z = sp.z + o[1];
  a.y = groundHeight(a.x, a.z);
  const tgt = atk ? SITES.A : SITES.A; // face the map centre / sites
  a.yaw = yawTo(a.x, a.z, atk ? 0 : 0, atk ? -8 : 8);
  a.hp = 100; a.alive = true; a.vx = 0; a.vz = 0; a.vy = 0;
  a.reloadT = 0; a.switchT = 0; a.fireT = 0; a.spread = 0; a.recoil = 0;
  a.grenades = 0; a.hasGrenade = false; a.plantT = 0; a.defuseT = 0;
  a.state = 'advance'; a.holdT = 0; a.reactT = 0.3 + s.rng() * 0.7; a.targetId = -1;
  a.killsThisRound = 0; a.flashT = 0;
  // Lane assignment: attack 2 A / 1 Mid / 2 B; defence 2 A / 1 Mid / 2 B.
  const lanes = ['A', 'A', 'mid', 'B', 'B'];
  a.lane = lanes[idx] || 'mid';
  a.wp = 0;
  // Carrier: first attacker bot carries the bomb.
  a.carrier = false;
}

export function startRound(s) {
  s.attacker = s.round % 2 === 1 ? 'F' : 'S';
  s.phase = 'buy'; s.phaseT = BUY_TIME; s.timer = ROUND_TIME;
  s.bomb = { state: 'carried', carrierId: -1, site: null, x: 0, z: 0, fuseT: BOMB_FUSE, plantT: 0 };
  s.grenades = []; s.tracers = []; s.impacts = [];
  for (const a of s.actors) {
    placeAtSpawn(s, a);
    // Keep weapons bought last round; new match starts on pistol.
    if (s.round === 1) { a.weapon = 'p12'; a.mag = 12; a.reserve = 36; }
    else { const w = WEAPONS[a.weapon]; a.mag = w.mag; a.reserve = w.reserve; }
  }
  // Bomb carrier: first living attacker bot.
  const carrier = s.actors.find(a => a.team === s.attacker && !a.isPlayer);
  if (carrier) { carrier.carrier = true; s.bomb.carrierId = carrier.id; }
  s.buyOpen = true;
  setBanner(s, `ROUND ${s.round} — BUY PHASE  •  ${teamName(s.attacker)} ATTACK`, 3);
  ev(s, 'round', `Round ${s.round} started; ${teamName(s.attacker)} attacks`);
}

export function buyItem(s, actor, item) {
  if (s.phase !== 'buy') return { ok: false, why: 'buy phase is over' };
  const prices = { vk47: 2500, hornet: 1200, frag: 300, armour: 650 };
  if (item === 'p12') return { ok: false, why: 'P-12 is always owned' };
  const price = prices[item];
  if (price === undefined) return { ok: false, why: 'unknown item' };
  if (!canAfford(actor.money, price)) return { ok: false, why: `need $${price}, have $${actor.money}` };
  if (item === 'frag' && actor.grenades >= 1) return { ok: false, why: 'one frag per round max' };
  if (item === 'armour' && actor.armour >= 100) return { ok: false, why: 'armour already full' };
  actor.money -= price;
  if (item === 'vk47' || item === 'hornet') {
    actor.weapon = item; const w = WEAPONS[item];
    actor.mag = w.mag; actor.reserve = w.reserve; actor.reloadT = 0;
  } else if (item === 'frag') { actor.grenades = 1; actor.hasGrenade = true; }
  else if (item === 'armour') { actor.armour = 100; }
  s.stats.buys++;
  ev(s, 'buy', `${actor.name} bought ${item} for $${price} (now $${actor.money})`);
  return { ok: true, price };
}

// Bots buy with a simple rule: best affordable primary, armour if money remains.
export function botBuy(s, a) {
  if (a.money >= 2500) buyItem(s, a, 'vk47');
  else if (a.money >= 1200) buyItem(s, a, 'hornet');
  if (a.money >= 650 && a.armour < 100) buyItem(s, a, 'armour');
  if (a.money >= 300 && a.grenades === 0) buyItem(s, a, 'frag');
}

export function startReload(s, a) {
  const w = WEAPONS[a.weapon];
  if (a.reloadT > 0 || a.mag >= w.mag || a.reserve <= 0) return false;
  a.reloadT = w.reload;
  if (a.isPlayer) s.stats.reloads++;
  ev(s, 'reload', `${a.name} reloading ${w.name}`);
  return true;
}
export function finishReload(a) {
  const w = WEAPONS[a.weapon];
  const need = w.mag - a.mag, take = Math.min(need, a.reserve);
  a.mag += take; a.reserve -= take; a.reloadT = 0;
}
// --- shooting (hitscan, shared by player and bots) -------------------------
// dirYaw/dirPitch describe the shot direction. Returns hit info or null.
// Ray vs actors: chest sphere (r 0.45 at y+1.25) and head sphere (r 0.27 at y+1.62).
// Ray vs walls: 2D segment vs collider AABBs; a wall closer than the actor blocks.
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return -1;
  return tca - Math.sqrt(r * r - d2);
}
function wallDistance(ox, oz, dx, dz, maxD) {
  let best = maxD;
  for (const c of COLLIDERS) {
    // Slab test in 2D.
    let t0 = 0, t1 = best, ok = true;
    const o = [ox, oz], d = [dx, dz], mn = [c.x0, c.z0], mx = [c.x1, c.z1];
    for (let i = 0; i < 2; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) { ok = false; break; } }
      else {
        let ta = (mn[i] - o[i]) / d[i], tb = (mx[i] - o[i]) / d[i];
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
        if (t0 > t1) { ok = false; break; }
      }
    }
    if (ok && t0 < best && t0 > 0.01) best = t0;
  }
  return best;
}

export function shoot(s, a, dirYaw, dirPitch) {
  const w = WEAPONS[a.weapon];
  if (!a.alive || a.reloadT > 0 || a.switchT > 0 || a.fireT > 0) return null;
  if (a.mag <= 0) { startReload(s, a); return { empty: true }; }
  a.mag--; a.fireT = w.interval; a.lastShotT = s.time; a.flashT = 0.06;
  s.stats.shots++;
  // Spread: base + movement + air + heat; crouch/still tightens it.
  const moving = Math.hypot(a.vx, a.vz) > 0.5;
  let spread = w.spread + (moving ? w.spreadMove : 0) + (a.onGround ? 0 : 0.03)
    + a.spread + (a.crouch ? -0.006 : 0);
  spread = Math.max(0.004, spread);
  a.spread = Math.min(0.05, a.spread + w.heat);
  a.recoil = Math.min(0.09, a.recoil + w.recoil);
  const jy = (s.rng() * 2 - 1) * spread, jp = (s.rng() * 2 - 1) * spread;
  const yaw = dirYaw + jy, pitch = dirPitch + jp + a.recoil;
  const dx = -Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = -Math.cos(yaw) * Math.cos(pitch);
  const ox = a.x, oy = a.y + 1.55, oz = a.z;
  const wDist = wallDistance(ox, oz, dx, dz, w.range);
  let bestT = wDist, hitActor = null, head = false;
  for (const b of s.actors) {
    if (b === a || !b.alive || b.team === a.team) continue; // no friendly fire: bullets pass teammates
    const tc = raySphere(ox, oy, oz, dx, dy, dz, b.x, b.y + 1.25, b.z, 0.48);
    const th = raySphere(ox, oy, oz, dx, dy, dz, b.x, b.y + 1.62, b.z, 0.28);
    const t = th >= 0 && (tc < 0 || th < tc) ? th : tc;
    if (t >= 0 && t < bestT) { bestT = t; hitActor = b; head = th >= 0 && th <= tc; }
  }
  const endX = ox + dx * bestT, endY = oy + dy * bestT, endZ = oz + dz * bestT;
  s.tracers.push({ x0: ox, y0: oy, z0: oz, x1: endX, y1: endY, z1: endZ, t: 0.09 });
  if (hitActor) {
    s.stats.hits++;
    const dmg = weaponDamage(w, head);
    damage(s, hitActor, dmg, a, head);
    s.impacts.push({ x: endX, y: endY, z: endZ, t: 0.25, head });
    return { hit: true, victim: hitActor, head, dmg, x: endX, y: endY, z: endZ };
  }
  s.impacts.push({ x: endX, y: endY, z: endZ, t: 0.2, head: false });
  return { hit: false, x: endX, y: endY, z: endZ };
}

export function damage(s, victim, dmg, attacker, head) {
  if (!victim.alive) return;
  let rest = dmg;
  if (victim.armour > 0) {
    const absorbed = Math.min(victim.armour, Math.round(rest * 0.5));
    victim.armour -= absorbed; rest -= absorbed;
  }
  victim.hp -= rest;
  if (victim.hp <= 0) {
    victim.hp = 0; victim.alive = false; victim.deaths++;
    if (attacker) { attacker.kills++; attacker.killsThisRound++; attacker.money += 300; }
    s.stats.kills++;
    const txt = `${attacker ? attacker.name : '???'} ✕ ${victim.name}${head ? ' (headshot)' : ''}`;
    feed(s, txt); ev(s, 'kill', txt);
    if (victim.carrier) {
      victim.carrier = false;
      // Bomb drops where the carrier fell.
      s.bomb.state = 'dropped'; s.bomb.x = victim.x; s.bomb.z = victim.z; s.bomb.carrierId = -1;
      ev(s, 'bomb', `Bomb dropped at (${victim.x.toFixed(0)}, ${victim.z.toFixed(0)})`);
    }
    checkRoundEnd(s);
  }
}

// --- grenade ----------------------------------------------------------------
export function throwGrenade(s, a) {
  if (a.grenades <= 0 || !a.alive) return false;
  a.grenades--; a.hasGrenade = a.grenades > 0;
  const yaw = a.yaw, pitch = a.pitch + 0.35;
  const g = {
    x: a.x, y: a.y + 1.5, z: a.z,
    vx: -Math.sin(yaw) * Math.cos(pitch) * 14,
    vy: Math.sin(pitch) * 14 + 2, vz: -Math.cos(yaw) * Math.cos(pitch) * 14,
    fuse: 2.2, owner: a.id,
  };
  s.grenades.push(g);
  s.stats.grenades++;
  ev(s, 'grenade', `${a.name} threw a frag`);
  return true;
}
function stepGrenades(s, dt) {
  for (const g of s.grenades) {
    g.vy -= 18 * dt;
    g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
    const gh = groundHeight(g.x, g.z);
    if (g.y <= gh + 0.15) { g.y = gh + 0.15; g.vy = Math.abs(g.vy) * 0.35; g.vx *= 0.6; g.vz *= 0.6; }
    g.fuse -= dt;
    if (g.fuse <= 0) {
      g.dead = true;
      ev(s, 'grenade', `Frag exploded at (${g.x.toFixed(0)}, ${g.z.toFixed(0)})`);
      for (const a of s.actors) {
        if (!a.alive) continue;
        const d = Math.sqrt(dist2(g.x, g.z, a.x, a.z) + (g.y - (a.y + 1)) * (g.y - (a.y + 1)));
        if (d < 6 && !segmentBlocked(g.x, g.z, a.x, a.z)) {
          const dmg = Math.round(90 - (90 - 10) * (d / 6));
          const owner = s.actors[g.owner];
          damage(s, a, dmg, owner, false);
        }
      }
      s.impacts.push({ x: g.x, y: g.y, z: g.z, t: 0.5, head: false, big: true });
    }
  }
  s.grenades = s.grenades.filter(g => !g.dead);
}

// --- bomb plant / defuse ----------------------------------------------------
export function siteAt(x, z) {
  for (const key of ['A', 'B']) {
    const st = SITES[key];
    if (Math.abs(x - st.x) <= st.r && Math.abs(z - st.z) <= st.r) return key;
  }
  return null;
}
function stepBomb(s, dt) {
  const b = s.bomb;
  if (b.state === 'planted') {
    b.fuseT -= dt;
    if (b.fuseT <= 0) {
      b.state = 'exploded';
      ev(s, 'bomb', 'Bomb detonated');
      // Attackers win the round on detonation.
      endRound(s, s.attacker, 'BOMB DETONATED');
    }
  }
}

// --- round end / match ------------------------------------------------------
export function aliveCount(s, team) { return s.actors.filter(a => a.team === team && a.alive).length; }

export function checkRoundEnd(s) {
  if (s.phase !== 'live') return;
  const f = aliveCount(s, 'F'), g = aliveCount(s, 'S');
  if (f === 0) endRound(s, 'S', 'TEAM ELIMINATED');
  else if (g === 0) endRound(s, 'F', 'TEAM ELIMINATED');
}
export function endRound(s, winnerTeam, reason) {
  if (s.phase === 'over' || s.phase === 'match') return;
  s.phase = 'over'; s.phaseT = 3; s.roundReason = reason;
  s.score[winnerTeam]++;
  const loser = otherTeam(winnerTeam);
  for (const a of s.actors) {
    if (a.team === winnerTeam) a.money += 325;
    else { a.money += 300; if (s.bomb.state === 'planted' || s.bomb.state === 'exploded') a.money += 0; }
  }
  // Plant bonus: attackers get +$200 if the bomb was planted this round.
  if (s.bomb.state === 'planted' || s.bomb.state === 'exploded') {
    for (const a of s.actors) if (a.team === s.attacker) a.money += 200;
  }
  const youWon = winnerTeam === 'F';
  setBanner(s, `${youWon ? 'ROUND WON' : 'ROUND LOST'} — ${reason}  •  ${s.score.F}–${s.score.S}`, 3);
  ev(s, 'round', `Round ${s.round} won by ${teamName(winnerTeam)} (${reason}); score ${s.score.F}-${s.score.S}`);
  if (s.score[winnerTeam] >= WIN_ROUNDS || s.round >= MAX_ROUNDS) {
    s.matchOver = true; s.winner = winnerTeam;
  }
}

function nextRound(s) {
  if (s.matchOver) { s.phase = 'match'; setBanner(s, `MATCH ${s.winner === 'F' ? 'WON' : 'LOST'} — FINAL ${s.score.F}–${s.score.S}  •  press R to restart`, 9999); return; }
  s.round++;
  startRound(s);
}

// --- per-step update ----------------------------------------------------------
export function stepSim(s, dt, input) {
  s.time += dt;
  if (s.bannerT > 0) s.bannerT -= dt;
  // Timers / tracers decay.
  for (const t of s.tracers) t.t -= dt;
  s.tracers = s.tracers.filter(t => t.t > 0);
  for (const t of s.impacts) t.t -= dt;
  s.impacts = s.impacts.filter(t => t.t > 0);
  for (const a of s.actors) {
    if (a.fireT > 0) a.fireT -= dt;
    if (a.switchT > 0) a.switchT -= dt;
    if (a.flashT > 0) a.flashT -= dt;
    if (a.reloadT > 0) { a.reloadT -= dt; if (a.reloadT <= 0) finishReload(a); }
    if (a.spread > 0) a.spread = Math.max(0, a.spread - dt * 0.04);
    if (a.recoil > 0) a.recoil = Math.max(0, a.recoil - dt * 0.25);
  }

  if (s.phase === 'buy') {
    s.phaseT -= dt;
    if (s.phaseT <= 0) {
      s.phase = 'live'; s.buyOpen = false;
      setBanner(s, `ROUND ${s.round} — ${teamName(s.attacker)} ATTACK  •  PLANT AT A OR B`, 2.5);
      ev(s, 'round', 'Buy phase over — round live');
    }
    return;
  }
  if (s.phase === 'over') {
    s.phaseT -= dt;
    if (s.phaseT <= 0) nextRound(s);
    return;
  }
  if (s.phase === 'match') return;

  // Live round.
  s.timer -= dt;
  if (s.timer <= 0) {
    s.timer = 0;
    // Defenders win on timeout if the bomb was never planted.
    if (s.bomb.state !== 'planted') endRound(s, otherTeam(s.attacker), 'TIME EXPIRED');
    return;
  }
  stepGrenades(s, dt);
  stepBomb(s, dt);
  if (s.phase !== 'live') return;
  // Player movement/shooting is applied by main.js via applyPlayerInput before stepSim.
  // Bots act here (their movement is applied in bots.js updateBots, called from main.js).
  checkRoundEnd(s);
}

// Apply WASD movement + gravity to any actor (player or bot) with collision.
export function moveActor(s, a, mx, mz, dt, opts = {}) {
  const speed = opts.speed ?? 5.2;
  const accel = a.onGround ? 40 : 12;
  a.vx += mx * accel * dt; a.vz += mz * accel * dt;
  const sp = Math.hypot(a.vx, a.vz), max = speed * (a.crouch ? 0.45 : 1);
  if (sp > max) { a.vx *= max / sp; a.vz *= max / sp; }
  // Friction when no input.
  if (mx === 0 && mz === 0 && a.onGround) { a.vx *= Math.max(0, 1 - 10 * dt); a.vz *= Math.max(0, 1 - 10 * dt); }
  let nx = a.x + a.vx * dt, nz = a.z + a.vz * dt;
  // Ground-height step: cannot climb a ledge taller than 0.6 in one step.
  const gh0 = groundHeight(a.x, a.z), gh1 = groundHeight(nx, nz);
  if (gh1 - gh0 > 0.6 && a.onGround) { nx = a.x; nz = a.z; a.vx = 0; a.vz = 0; }
  const r = 0.42;
  const p = resolveCircle(nx, nz, r);
  a.x = p.x; a.z = p.z;
  a.y = groundHeight(a.x, a.z);
  a.moving = Math.hypot(a.vx, a.vz) > 0.5;
  // Vertical.
  if (opts.jump && a.onGround) { a.vy = 6.5; a.onGround = false; }
  if (!a.onGround) {
    a.vy -= 18 * dt; a.y += a.vy * dt;
    const gh = groundHeight(a.x, a.z);
    if (a.y <= gh) { a.y = gh; a.vy = 0; a.onGround = true; }
  }
}

export function restartMatch(s) {
  s.round = 1; s.score = { F: 0, S: 0 }; s.matchOver = false; s.winner = null;
  for (const a of s.actors) { a.money = 800; a.kills = 0; a.deaths = 0; a.weapon = 'p12'; }
  startRound(s);
  ev(s, 'round', 'Match restarted');
}
