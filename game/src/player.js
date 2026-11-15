// player.js — player input, mouse look, movement, plant/defuse.
// Keyboard: WASD move, Shift walk-slow, Space jump, C/Ctrl crouch,
// R reload, 1/2/3 weapon slots, 4 grenade, B buy menu, E plant/defuse,
// Tab scoreboard, M mute. Click locks the pointer.
import { moveActor, shoot, startReload, throwGrenade, siteAt, buyItem } from './sim.js';
import { WEAPONS } from './weapon.js';
import { sfx, toggleMute, unlockAudio } from './audio.js';

export function createInput() {
  return {
    keys: {}, mouseDX: 0, mouseDY: 0, firing: false, firePressed: false,
    locked: false, plantHeld: false, jumpQueued: false,
  };
}

export function bindInput(input, canvas, callbacks) {
  const onKey = (e, down) => {
    if (e.code === 'Tab') { e.preventDefault(); }
    input.keys[e.code] = down;
    if (down && e.code === 'Space') input.jumpQueued = true;
    if (down && !e.repeat) {
      if (e.code === 'KeyR') callbacks.onReload();
      if (e.code === 'Digit1') callbacks.onSlot(1);
      if (e.code === 'Digit2') callbacks.onSlot(2);
      if (e.code === 'Digit4') callbacks.onGrenade();
      if (e.code === 'KeyB') callbacks.onBuy();
      if (e.code === 'KeyM') { const m = toggleMute(); callbacks.onMute(m); }
      if (e.code === 'KeyE') input.plantHeld = true;
    }
    if (!down && e.code === 'KeyE') input.plantHeld = false;
  };
  window.addEventListener('keydown', e => onKey(e, true));
  window.addEventListener('keyup', e => onKey(e, false));
  canvas.addEventListener('click', () => {
    unlockAudio();
    if (!input.locked) { try { canvas.requestPointerLock(); } catch (err) { /* headless */ } }
  });
  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
  });
  document.addEventListener('mousemove', e => {
    if (input.locked) { input.mouseDX += e.movementX; input.mouseDY += e.movementY; }
  });
  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) { input.firing = true; input.firePressed = true; }
  });
  window.addEventListener('mouseup', e => { if (e.button === 0) input.firing = false; });
  window.addEventListener('blur', () => { input.firing = false; input.keys = {}; });
}

// One fixed step of player logic. Called from the fixed-step loop in main.js.
export function stepPlayer(s, input, dt) {
  const p = s.actors[0];
  if (!p.alive) return;
  // Mouse look.
  p.yaw -= input.mouseDX * 0.0022;
  p.pitch -= input.mouseDY * 0.0022;
  p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch));
  input.mouseDX = 0; input.mouseDY = 0;
  // Recoil recovery is in sim.js; pitch kick is applied at fire time.
  const k = input.keys;
  p.crouch = !!(k['KeyC'] || k['ControlLeft']);
  const slow = !!k['ShiftLeft'] || !!k['ShiftRight'];
  let fx = 0, fz = 0;
  if (k['KeyW']) fz += 1; if (k['KeyS']) fz -= 1;
  if (k['KeyA']) fx -= 1; if (k['KeyD']) fx += 1;
  const len = Math.hypot(fx, fz) || 1;
  fx /= len; fz /= len;
  // Camera-forward is (-sin yaw, -cos yaw); strafe is (cos yaw, -sin yaw) in x/z.
  const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
  const mx = (-sin * fz + cos * fx);
  const mz = (-cos * fz - sin * fx);
  const speed = slow ? 2.6 : 5.2;
  const jump = input.jumpQueued; input.jumpQueued = false;
  moveActor(s, p, mx, mz, dt, { speed, jump });
  if (p.moving && Math.random() < 0.02) sfx.step();

  // Firing: auto weapons hold, semi-auto (P-12) needs a fresh press.
  const w = WEAPONS[p.weapon];
  const wantFire = w.auto ? input.firing : input.firePressed;
  input.firePressed = false;
  if (wantFire && s.phase === 'live') {
    const r = shoot(s, p, p.yaw, p.pitch);
    if (r) {
      if (r.empty) sfx.empty();
      else if (r.hit) { sfx.hit(r.head); if (input.onHit) input.onHit(r.head); if (r.victim && !r.victim.alive) sfx.kill(); }
      else sfx.shot(p.weapon);
    }
  }
  // Grenade throw on key 4 (handled by callback) — also allow G.
  if (k['KeyG'] && p.grenades > 0) { throwGrenade(s, p); input.keys['KeyG'] = false; }

  // Plant / defuse while E is held inside a site (attackers) or near the bomb.
  if (input.plantHeld && s.phase === 'live') {
    const site = siteAt(p.x, p.z);
    if (p.team === s.attacker && site && (s.bomb.state === 'carried' || s.bomb.state === 'dropped')) {
      p.plantT += dt;
      if (p.plantT >= 3) {
        s.bomb.state = 'planted'; s.bomb.site = site; s.bomb.fuseT = 35;
        s.bomb.x = p.x; s.bomb.z = p.z; p.plantT = 0;
        s.stats.plants++; s.events.push({ kind: 'plant', t: +s.time.toFixed(2), round: s.round, text: `YOU planted the bomb at SITE ${site}` });
        s.log.push(`[r${s.round}] YOU planted the bomb at SITE ${site}`);
        s.banner = 'BOMB PLANTED — DEFEND IT'; s.bannerT = 3;
        sfx.plantDone();
      }
    } else if (p.team !== s.attacker && s.bomb.state === 'planted') {
      const d = Math.hypot(p.x - s.bomb.x, p.z - s.bomb.z);
      if (d < 3) {
        p.defuseT += dt;
        if (p.defuseT >= 5) {
          s.bomb.state = 'defused'; p.defuseT = 0;
          s.stats.defuses++;
          s.events.push({ kind: 'defuse', t: +s.time.toFixed(2), round: s.round, text: 'YOU defused the bomb' });
          s.log.push(`[r${s.round}] YOU defused the bomb`);
          sfx.win();
        }
      } else p.defuseT = 0;
    } else { p.plantT = 0; p.defuseT = 0; }
  } else { p.plantT = 0; p.defuseT = 0; }
}

export function tryReload(s) {
  const p = s.actors[0];
  if (startReload(s, p)) sfx.reload();
}
export function trySlot(s, slot) {
  const p = s.actors[0];
  if (slot === 2 && p.weapon !== 'p12') {
    p.weapon = 'p12'; p.mag = 12; p.reserve = 36; p.switchT = 0.45; p.reloadT = 0;
    sfx.click();
  } else if (slot === 1) {
    // Slot 1 returns to the primary if one was bought (stored on the actor).
    if (p.primaryWeapon && p.weapon !== p.primaryWeapon) {
      const w = WEAPONS[p.primaryWeapon];
      p.weapon = p.primaryWeapon; p.mag = w.mag; p.reserve = w.reserve; p.switchT = 0.45; p.reloadT = 0;
      sfx.click();
    }
  }
}
export function tryGrenade(s) {
  const p = s.actors[0];
  if (p.grenades > 0) { throwGrenade(s, p); sfx.click(); }
  else sfx.deny();
}
// Buy-menu number keys 1-5 while the menu is open (called from hud/main).
export function buyKey(s, n) {
  const items = ['vk47', 'hornet', 'frag', 'armour', 'p12'];
  const item = items[n - 1];
  if (!item) return { ok: false, why: '' };
  const p = s.actors[0];
  const r = buyItem(s, p, item);
  if (r.ok) { if (item === 'vk47' || item === 'hornet') p.primaryWeapon = item; sfx.buy(); }
  else sfx.deny();
  return r;
}
