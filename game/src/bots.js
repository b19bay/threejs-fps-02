// bots.js — bot AI for FOUNDRY-9: 4 teammates + 5 enemies.
// Bots follow named lane waypoint chains (2 A / 1 Mid / 2 B on attack,
// site split on defence), pause at hold positions to check angles, react to
// gunfire, peek corners, plant the bomb when the carrier reaches a site and
// defuse when they hear the plant beep. Aim is deliberately human: reaction
// delay, tracking error, worse at long range and against moving targets.
// Bots never know the player's position through walls (line of sight is a
// real segment test against the map colliders).
import { LANES, HOLDS, SITES, segmentBlocked } from './world.js';
import { moveActor, shoot, startReload, throwGrenade, endRound, yawTo, clamp, dist2 } from './sim.js';
import { sfx } from './audio.js';

const AI_TICK = 0.1; // decisions at 10 Hz; movement integrates every fixed step

function losClear(s, a, b) {
  return !segmentBlocked(a.x, a.z, b.x, b.z);
}
function nearestEnemy(s, a) {
  let best = null, bestD = 1e9;
  for (const b of s.actors) {
    if (b.team === a.team || !b.alive) continue;
    const d = dist2(a.x, a.z, b.x, b.z);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best ? { bot: best, d: Math.sqrt(bestD) } : null;
}
function visibleEnemy(s, a, maxD = 42) {
  let best = null, bestD = 1e9;
  for (const b of s.actors) {
    if (b.team === a.team || !b.alive) continue;
    const d = Math.sqrt(dist2(a.x, a.z, b.x, b.z));
    if (d > maxD) continue;
    // Field of view: ~100 degrees in front.
    const want = yawTo(a.x, a.z, b.x, b.z);
    let dy = want - a.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    if (Math.abs(dy) > 0.95 && d > 6) continue;
    if (!losClear(s, a, b)) continue;
    if (d < bestD) { bestD = d; best = b; }
  }
  return best ? { bot: best, d: bestD } : null;
}

function botWaypoints(s, a) {
  if (a.team === s.attacker) {
    return LANES[a.lane] || LANES.mid;
  }
  // Defence: go to the assigned site and hold it.
  if (a.lane === 'A') return LANES.defA;
  if (a.lane === 'B') return LANES.defB;
  return LANES.defMid;
}

// One AI decision tick (10 Hz) for a single bot.
function decide(s, a, dt) {
  if (!a.alive) return;
  a.reactT -= dt;
  const wps = botWaypoints(s, a);
  const seen = visibleEnemy(s, a);
  if (seen) {
    // Reaction delay: only start shooting after reactT expires.
    if (a.targetId !== seen.bot.id) { a.targetId = seen.bot.id; a.reactT = 0.35 + s.rng() * 0.45; a.aimErr = (s.rng() * 2 - 1) * 0.05; }
    a.state = 'engage';
  } else if (a.targetId !== -1) {
    // Lost sight: keep the last known direction briefly, then resume route.
    a.targetId = -1; a.state = 'advance';
  }

  // Bomb carrier behaviour: head for the nearest site, plant on arrival.
  if (a.carrier && (s.bomb.state === 'carried' || s.bomb.state === 'dropped')) {
    const siteKey = a.lane === 'B' ? 'B' : 'A';
    const st = SITES[siteKey];
    const d = Math.sqrt(dist2(a.x, a.z, st.x, st.z));
    if (d < 2.5) {
      a.state = 'plant';
      a.plantT += dt;
      if (a.plantT >= 3) {
        s.bomb.state = 'planted'; s.bomb.site = siteKey; s.bomb.fuseT = 35;
        s.bomb.x = st.x; s.bomb.z = st.z; a.carrier = false; a.plantT = 0;
        s.stats.plants++;
        s.events.push({ kind: 'plant', t: +s.time.toFixed(2), round: s.round, text: `${a.name} planted the bomb at SITE ${siteKey}` });
        s.log.push(`[r${s.round}] ${a.name} planted the bomb at SITE ${siteKey}`);
        s.banner = `BOMB PLANTED AT SITE ${siteKey} — 35s`; s.bannerT = 3;
        sfx.plantBeep();
        a.state = 'advance';
      }
      return;
    }
  }
  // Defuse: a defender who reaches the planted bomb defuses it.
  if (a.team !== s.attacker && s.bomb.state === 'planted') {
    const d = Math.sqrt(dist2(a.x, a.z, s.bomb.x, s.bomb.z));
    if (d < 2.5) {
      a.state = 'defuse';
      a.defuseT += dt;
      if (a.defuseT >= 5) {
        s.bomb.state = 'defused'; a.defuseT = 0;
        s.stats.defuses++;
        s.events.push({ kind: 'defuse', t: +s.time.toFixed(2), round: s.round, text: `${a.name} defused the bomb` });
        s.log.push(`[r${s.round}] ${a.name} defused the bomb`);
        // Defuse wins the round for the defenders.
        endRound(s, a.team, 'BOMB DEFUSED');
        a.state = 'advance';
      }
      return;
    }
    // Otherwise walk toward the bomb site.
    a.state = 'advance';
    a.wp = wps.length - 1;
  }
  // Hold positions: pause at a lane waypoint to check the angle.
  if (a.state === 'advance' && a.holdT > 0) { a.holdT -= dt; return; }
  if (a.state === 'advance') {
    const wp = wps[Math.min(a.wp, wps.length - 1)];
    const d = Math.sqrt(dist2(a.x, a.z, wp[0], wp[1]));
    if (d < 1.2) {
      const holds = HOLDS[a.lane] || [];
      if (holds.includes(a.wp) && s.rng() < 0.7) a.holdT = 0.8 + s.rng() * 1.2;
      a.wp = Math.min(a.wp + 1, wps.length - 1);
    }
  }
}
// Per fixed step: steer + shoot. Called from main.js after stepSim().
export function updateBots(s, dt) {
  if (s.phase !== 'live') {
    // During buy phase bots stand at spawn; during 'over' they idle.
    return;
  }
  for (const a of s.actors) {
    if (a.isPlayer || !a.alive) continue;
    a._aiT = (a._aiT || 0) + dt;
    if (a._aiT >= AI_TICK) { decide(s, a, a._aiT); a._aiT = 0; }
    if (s.phase !== 'live') return;

    let mx = 0, mz = 0, speed = 4.6;
    const wps = botWaypoints(s, a);
    if (a.state === 'engage' && a.targetId !== -1) {
      const t = s.actors[a.targetId];
      if (t && t.alive) {
        // Face the target with tracking error; strafe slowly.
        const want = yawTo(a.x, a.z, t.x, t.z) + a.aimErr;
        let dy = want - a.yaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        a.yaw += clamp(dy, -2.4 * dt, 2.4 * dt);
        // Strafe perpendicular, switching direction now and then.
        if (s.rng() < 0.005) a._strafe = (s.rng() < 0.5 ? -1 : 1);
        const st = a._strafe || 1;
        mx = Math.cos(a.yaw) * st * 0.4; mz = -Math.sin(a.yaw) * st * 0.4;
        speed = 2.2;
        // Fire only after the reaction delay, with range/movement penalties.
        if (a.reactT <= 0 && a.mag > 0) {
          const d = Math.sqrt(dist2(a.x, a.z, t.x, t.z));
          const movingTarget = Math.hypot(t.vx, t.vz) > 1;
          let p = 0.85 - d * 0.012 - (movingTarget ? 0.18 : 0) - (a.moving ? 0.1 : 0);
          if (s.rng() < Math.max(0.15, p)) {
            const r = shoot(s, a, a.yaw + (s.rng() * 2 - 1) * 0.02, (s.rng() * 2 - 1) * 0.01);
            if (r && !r.empty && !r.hit) sfx.enemyShot();
          } else if (a.fireT <= 0) {
            // Miss on purpose: still spend the bullet and make noise.
            shoot(s, a, a.yaw + (s.rng() * 2 - 1) * 0.12, (s.rng() * 2 - 1) * 0.05);
            sfx.enemyShot();
          }
        } else if (a.mag === 0) startReload(s, a);
      }
    } else if (a.state === 'plant' || a.state === 'defuse') {
      // Stand still and work the bomb.
      mx = 0; mz = 0;
      a.yaw += 0.1 * dt;
    } else if (a.state === 'advance') {
      if (a.holdT > 0) { mx = 0; mz = 0; }
      else {
        const wp = wps[Math.min(a.wp, wps.length - 1)];
        // Defenders retarget to the planted bomb.
        let tx = wp[0], tz = wp[1];
        if (a.team !== s.attacker && s.bomb.state === 'planted') { tx = s.bomb.x; tz = s.bomb.z; }
        // Carrier heads for its site directly.
        if (a.carrier) { const st = SITES[a.lane === 'B' ? 'B' : 'A']; tx = st.x; tz = st.z; }
        const dx = tx - a.x, dz = tz - a.z, d = Math.hypot(dx, dz) || 1;
        mx = dx / d; mz = dz / d;
        a.yaw = yawTo(a.x, a.z, tx, tz);
        // Small random offsets so no two rounds look identical.
        if (!a._off) a._off = (s.rng() * 2 - 1) * 0.6;
      }
    }
    moveActor(s, a, mx, mz, dt, { speed });
    // Bots reload when the mag is low and they are not engaging.
    if (a.mag <= 4 && a.state !== 'engage' && a.reloadT <= 0) startReload(s, a);
    // A bot with a frag sometimes throws it at a visible enemy.
    if (a.grenades > 0 && a.state === 'engage' && s.rng() < 0.002) throwGrenade(s, a);
  }
}

// React to gunfire: bots near a shot turn toward the sound (called from main
// when the player fires). Hearing range 25 m, only through open air.
export function hearShot(s, shooter) {
  for (const a of s.actors) {
    if (a.isPlayer || !a.alive || a.team === shooter.team) continue;
    const d = Math.sqrt(dist2(a.x, a.z, shooter.x, shooter.z));
    if (d < 25 && !segmentBlocked(a.x, a.z, shooter.x, shooter.z)) {
      if (a.state !== 'engage') { a.state = 'advance'; a.yaw = yawTo(a.x, a.z, shooter.x, shooter.z); }
    }
  }
}
