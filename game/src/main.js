// main.js — FOUNDRY-9 bootstrap, fixed-step loop, rendering, ?shot= staging.
// Fixed dt 1/60: simulation (sim.js) and bot AI (bots.js) run in fixed steps,
// rendering only reads state. Deterministic for a given seed.
// ?shot=start|play|end&seed=N stages a scene and sets window.__shotReady.
// ?selftest=1 runs a scripted round headlessly and records the result on the
// page (document.body.dataset.testResult) for verification without a browser.
import * as THREE from 'three';
import { buildWorld, PALETTE, PROPS, COLLIDERS, SITES, groundHeight } from './world.js';
import { createSim, stepSim, DT, BUY_TIME, buyItem, startReload, throwGrenade, restartMatch, yawTo } from './sim.js';
import { updateBots, hearShot } from './bots.js';
import { createInput, bindInput, stepPlayer, tryReload, trySlot, tryGrenade, buyKey } from './player.js';
import { createHud, updateHud, updateScoreboard, showBuy, isBuyOpen, flashHitmarker } from './hud.js';

const params = new URLSearchParams(location.search);
const seed = parseInt(params.get('seed') || '1', 10) || 1;
const shotMode = params.get('shot');
const selftest = params.get('selftest') === '1';

const sim = createSim(seed);
window.__foundry = sim;
window.__shotReady = false;
window.__errors = [];
window.addEventListener('error', e => { const m = String(e.message || e.error); if (!window.__errors.includes(m)) window.__errors.push(m); });

const canvas = document.getElementById('game');
const input = createInput();
input.onHit = head => flashHitmarker(hud, head);
let hud = null;

// --- renderer: WebGL first, software 2D fallback if WebGL is unavailable ----
let renderer = null, scene = null, camera = null, useFallback = false;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
} catch (e) { renderer = null; }
if (renderer) {
  const gl = renderer.getContext();
  if (!gl) { renderer = null; }
}
if (!renderer) useFallback = true;

const fallback = document.getElementById('fallback');
let fctx = null;
if (useFallback) {
  fallback.style.display = 'block';
  canvas.style.display = 'none';
  fctx = fallback.getContext('2d');
  // Diagnostic banner in normal play only; deterministic ?shot= captures hide
  // it so the frame shows the game, not the capture environment (the hand-back
  // still records that these shots used the software fallback renderer).
  if (!shotMode) document.getElementById('nogl').style.display = 'block';
}

// --- three.js scene ----------------------------------------------------------
let botMeshes = [], bombMesh = null, gun = null, flash = null;
let tracerPool = [], impactPool = [];
if (!useFallback) {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.rotation.order = 'YXZ';
  buildWorld(scene);
  // Bot bodies: box torso + head, team-tinted (F amber trim, S grey).
  const bodyGeo = new THREE.BoxGeometry(0.7, 1.0, 0.4);
  const headGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
  const legGeo = new THREE.BoxGeometry(0.6, 0.7, 0.36);
  for (const a of sim.actors) {
    if (a.isPlayer) continue;
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: a.team === 'F' ? 0x8a939c : 0x3a4148, roughness: 0.8 });
    const trim = new THREE.MeshStandardMaterial({ color: a.team === 'F' ? PALETTE.amber : 0x5a636c, roughness: 0.6 });
    const torso = new THREE.Mesh(bodyGeo, mat); torso.position.y = 1.05; g.add(torso);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.18, 0.42), trim); chest.position.y = 1.35; g.add(chest);
    const head = new THREE.Mesh(headGeo, trim); head.position.y = 1.78; g.add(head);
    const legs = new THREE.Mesh(legGeo, mat); legs.position.y = 0.35; g.add(legs);
    // Name label sprite (canvas texture, created once).
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32;
    const cx = cv.getContext('2d');
    cx.fillStyle = a.team === 'F' ? '#e8a33d' : '#e8e0d0';
    cx.font = 'bold 20px monospace'; cx.textAlign = 'center'; cx.fillText(a.name, 64, 22);
    const tex = new THREE.CanvasTexture(cv);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(2.2, 0.55, 1); spr.position.y = 2.35; g.add(spr);
    scene.add(g);
    botMeshes.push({ a, g });
  }
  // Bomb: small amber box + blinking light, shown when dropped/planted.
  bombMesh = new THREE.Group();
  const bb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.35), new THREE.MeshStandardMaterial({ color: PALETTE.amber, emissive: 0x662200 }));
  bombMesh.add(bb);
  const bl = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff5522 }));
  bl.position.y = 0.25; bombMesh.add(bl); bombMesh.userData.light = bl;
  scene.add(bombMesh);
  // Viewmodel gun attached to the camera.
  gun = new THREE.Group();
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x1c2126, roughness: 0.5, metalness: 0.6 });
  const gunAmber = new THREE.MeshStandardMaterial({ color: PALETTE.amber, roughness: 0.5, metalness: 0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.62), gunMat); gun.add(body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.34), gunMat);
  barrel.position.set(0, 0.03, -0.45); gun.add(barrel);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.1), gunAmber);
  sight.position.set(0, 0.11, -0.2); gun.add(sight);
  gun.position.set(0.34, -0.32, -0.55);
  camera.add(gun);
  scene.add(camera);
  // Muzzle flash quad at the barrel tip.
  flash = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xffc861, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  flash.position.set(0.34, -0.29, -1.0);
  camera.add(flash);
  // Tracer + impact pools (preallocated, reused every frame).
  for (let i = 0; i < 8; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xe8a33d, transparent: true, opacity: 0.9 }));
    line.visible = false; scene.add(line); tracerPool.push(line);
  }
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffc861 }));
    m.visible = false; scene.add(m); impactPool.push(m);
  }
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// --- HUD + input -------------------------------------------------------------
hud = createHud(sim, id => {
  const r = buyKey(sim, { vk47: 1, hornet: 2, frag: 3, armour: 4, p12: 5 }[id]);
  if (!r.ok && r.why) { /* deny blip already played */ }
});
bindInput(input, canvas, {
  onReload: () => { if (sim.phase === 'match') restartMatch(sim); else tryReload(sim); },
  onSlot: n => {
    if (isBuyOpen(hud)) { buyKey(sim, n); return; }
    trySlot(sim, n);
  },
  onGrenade: () => tryGrenade(sim),
  onBuy: () => { if (sim.phase === 'buy') showBuy(hud, !isBuyOpen(hud)); },
  onMute: m => { hud.els.mute.textContent = m ? 'MUTED (M)' : ''; },
});
window.addEventListener('keydown', e => {
  if (isBuyOpen(hud) && /^Digit[1-5]$/.test(e.code)) buyKey(sim, parseInt(e.code.slice(5), 10));
  if (e.code === 'KeyR' && sim.phase === 'match') restartMatch(sim);
  if (e.code === 'Escape') showBuy(hud, false);
});

// --- ?shot= staging ----------------------------------------------------------
function stageShot(mode) {
  const p = sim.actors[0];
  const bots = sim.actors.filter(a => !a.isPlayer);
  const setBot = (name, x, z, yaw) => {
    const b = bots.find(a => a.name === name);
    if (b) { b.x = x; b.z = z; b.y = groundHeight(x, z); b.yaw = yaw; b.alive = true; b.hp = 100; }
    return b;
  };
  if (mode === 'start') {
    // Buy phase, player at attacker spawn looking down A-long.
    sim.phase = 'buy'; sim.phaseT = 12; sim.timer = 100; sim.round = 1;
    p.x = -26; p.z = -2; p.y = 0; p.yaw = yawTo(-26, -2, 24, -16); p.pitch = 0.01;
    p.weapon = 'p12'; p.mag = 12; p.reserve = 36; p.money = 800;
    // Teammates ahead at 7+ m so they read as figures, not foreground blocks.
    setBot('VEX', -20, -8, yawTo(-20, -8, 0, -14));
    setBot('ANVIL', -20, 4, yawTo(-20, 4, 0, 12));
    setBot('SLAG-2', -18, -13, p.yaw);
    setBot('EMBER', -18, 8, p.yaw);
    setBot('RUST', -6, -16, yawTo(-6, -16, -26, -2));
    setBot('COIL', 4, -16, yawTo(4, -16, -26, -2));
    setBot('GRIT', -12, 0, yawTo(-12, 0, -28, 0));
    setBot('ASH', 24, -16, 0); setBot('TONG', 24, 16, 0);
    sim.banner = 'ROUND 1 — BUY PHASE  •  FOUNDRY ATTACK'; sim.bannerT = 99;
    showBuy(hud, false);
  } else if (mode === 'play') {
    // Mid-round firefight: bots mid-lane, tracer + muzzle flash, one bot at
    // the site, ammo spent, timer mid-round.
    sim.phase = 'live'; sim.timer = 55; sim.round = 2; sim.score = { F: 1, S: 0 };
    sim.attacker = 'F';
    p.x = -6; p.z = -14; p.y = 0; p.yaw = yawTo(-6, -14, 24, -16); p.pitch = 0.02;
    p.weapon = 'vk47'; p.primaryWeapon = 'vk47'; p.mag = 18; p.reserve = 60; p.money = 1150;
    p.flashT = 0.5;
    setBot('VEX', 2, -18, yawTo(2, -18, 10, -16));
    setBot('ANVIL', -3, -8, yawTo(-3, -8, 10, -16));
    setBot('SLAG-2', 4, -12, yawTo(4, -12, 10, -16));
    setBot('EMBER', 12, 0, yawTo(12, 0, 24, -16));
    setBot('RUST', 2, -16, yawTo(2, -16, -6, -14));
    setBot('COIL', 8, -13, yawTo(8, -13, -6, -14));
    setBot('GRIT', 18, -16, yawTo(18, -16, -10, -14)); // near SITE A
    setBot('ASH', 8, 8, yawTo(8, 8, -10, -14));
    setBot('TONG', 24, 16, yawTo(24, 16, -10, -14));
    // Carrier bot near the site, bomb carried.
    const carrier = sim.actors.find(a => a.name === 'VEX');
    if (carrier) { carrier.carrier = true; sim.bomb.carrierId = carrier.id; }
    sim.bomb.state = 'carried';
    // A live tracer + impact so the firefight reads in one frame.
    sim.tracers.push({ x0: -6, y0: 1.55, z0: -14, x1: 2, y1: 1.3, z1: -16, t: 99 });
    sim.impacts.push({ x: 2, y: 1.3, z: -16, t: 99, head: false });
    sim.banner = 'ROUND 2 — PUSH SITE A'; sim.bannerT = 99;
    sim.feed = ['VEX ✕ COIL', 'RUST ✕ ANVIL'];
  } else if (mode === 'end') {
    // Round-end banner, bomb planted at SITE A, fuse counting down.
    sim.phase = 'over'; sim.phaseT = 3; sim.timer = 0; sim.round = 2;
    sim.score = { F: 2, S: 0 };
    sim.bomb.state = 'planted'; sim.bomb.site = 'A'; sim.bomb.x = 24; sim.bomb.z = -16; sim.bomb.fuseT = 12;
    p.x = 4; p.z = -10; p.y = 0; p.yaw = yawTo(4, -10, 24, -16); p.pitch = 0.02;
    p.weapon = 'vk47'; p.primaryWeapon = 'vk47'; p.mag = 24; p.reserve = 54; p.money = 1475;
    setBot('VEX', 10, -14, yawTo(10, -14, 24, -16));
    setBot('ANVIL', 18, -12, yawTo(18, -12, 24, -16));
    setBot('SLAG-2', 0, -16, yawTo(0, -16, 24, -16));
    setBot('EMBER', 12, 4, yawTo(12, 4, 24, -16));
    setBot('RUST', 20, -16, yawTo(20, -16, 4, -10)); // dead at the site
    const rust = sim.actors.find(a => a.name === 'RUST');
    if (rust) { rust.alive = false; rust.hp = 0; }
    setBot('COIL', 26, -12, yawTo(26, -12, 4, -10));
    setBot('GRIT', 24, -8, yawTo(24, -8, 4, -10));
    setBot('ASH', 16, 16, yawTo(16, 16, 4, -10));
    setBot('TONG', 28, 8, yawTo(28, 8, 4, -10));
    sim.banner = 'ROUND WON — BOMB PLANTED  •  2–0'; sim.bannerT = 99;
    sim.feed = ['YOU ✕ RUST (headshot)', 'VEX ✕ ASH'];
  }
  // Freeze the staged scene: no sim stepping in shot mode (deterministic).
  sim._frozen = true;
}

// --- rendering ---------------------------------------------------------------
function render3D() {
  const p = sim.actors[0];
  camera.position.set(p.x, p.y + (p.crouch ? 1.15 : 1.55), p.z);
  camera.rotation.y = p.yaw;
  camera.rotation.x = p.pitch + p.recoil * 0.6;
  camera.rotation.z = 0;
  // Gun bob + recoil kick.
  const bob = p.moving ? Math.sin(sim.time * 9) * 0.012 : 0;
  gun.position.set(0.34, -0.32 + bob, -0.55 + p.recoil * 0.5);
  flash.visible = p.flashT > 0;
  if (p.flashT > 0) { flash.rotation.z = Math.random() * Math.PI; flash.scale.setScalar(0.8 + Math.random() * 0.5); }
  // Bots.
  for (const { a, g } of botMeshes) {
    g.visible = true;
    g.position.set(a.x, a.y, a.z);
    if (a.alive) { g.rotation.set(0, a.yaw + Math.PI, 0); }
    else { g.rotation.set(-Math.PI / 2, 0, 0); g.position.y = a.y + 0.3; }
  }
  // Bomb.
  const b = sim.bomb;
  const showBomb = b.state === 'dropped' || b.state === 'planted';
  bombMesh.visible = showBomb;
  if (showBomb) {
    bombMesh.position.set(b.x, (b.state === 'planted' ? 0 : groundHeight(b.x, b.z)) + 0.2, b.z);
    bombMesh.userData.light.visible = Math.floor(sim.time * 3) % 2 === 0;
  }
  // Tracers / impacts from the pools.
  tracerPool.forEach((line, i) => {
    const t = sim.tracers[i];
    if (t) {
      line.visible = true;
      const pos = line.geometry.attributes.position.array;
      pos[0] = t.x0; pos[1] = t.y0; pos[2] = t.z0; pos[3] = t.x1; pos[4] = t.y1; pos[5] = t.z1;
      line.geometry.attributes.position.needsUpdate = true;
      line.material.opacity = Math.min(1, t.t * 8);
    } else line.visible = false;
  });
  impactPool.forEach((m, i) => {
    const t = sim.impacts[i];
    if (t) { m.visible = true; m.position.set(t.x, t.y, t.z); m.material.opacity = 1; }
    else m.visible = false;
  });
  renderer.render(scene, camera);
}

// Software 2D fallback: project the same world data (colliders, props, bots)
// through the player's camera. Used only when WebGL is unavailable.
function renderFallback() {
  const W = fallback.width = window.innerWidth, H = fallback.height = window.innerHeight;
  const p = sim.actors[0];
  const f = (H / 2) / Math.tan(37.5 * Math.PI / 180);
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
  // Sky + floor gradient.
  const g = fctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#101418'); g.addColorStop(0.55, '#1c2126'); g.addColorStop(0.551, '#14181c'); g.addColorStop(1, '#0a0d0f');
  fctx.fillStyle = g; fctx.fillRect(0, 0, W, H);
  const proj = (x, y, z) => {
    const dx = x - p.x, dy = y - (p.y + 1.55), dz = z - p.z;
    // Camera space: forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
    const fwd = -sy * dx - cy * dz;
    const right = cy * dx - sy * dz;
    const up = dy * cp - fwd * sp;
    const dep = dy * sp + fwd * cp;
    if (dep < 0.2) return null;
    return { x: W / 2 + right / dep * f, y: H / 2 - up / dep * f, d: dep };
  };
  const quads = [];
  const FACE_NORMALS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0]];
  const addBox = (x0, y0, z0, x1, y1, z1, color) => {
    const corners = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4]];
    for (let fi = 0; fi < faces.length; fi++) {
      const fc = faces[fi];
      // Backface cull: skip faces whose outward normal points away from the camera.
      const n = FACE_NORMALS[fi];
      const ccx = (corners[fc[0]][0] + corners[fc[2]][0]) / 2;
      const ccy = (corners[fc[0]][1] + corners[fc[2]][1]) / 2;
      const ccz = (corners[fc[0]][2] + corners[fc[2]][2]) / 2;
      if (n[0] * (p.x - ccx) + n[1] * (p.y + 1.55 - ccy) + n[2] * (p.z - ccz) <= 0) continue;
      const pts = fc.map(i => proj(...corners[i]));
      if (pts.some(q => !q)) continue;
      const d = pts.reduce((s, q) => s + q.d, 0) / 4;
      quads.push({ pts, d, color });
    }
  };
  for (const c of COLLIDERS) {
    if (c.x1 - c.x0 > 60 || c.z1 - c.z0 > 40) continue;
    addBox(c.x0, 0, c.z0, c.x1, c.h, c.z1, '#1c2126');
  }
  // Outer boundary walls (horizon backdrop) + catwalk deck and ramp.
  addBox(-33, 0, -23, 33, 5, -22, '#1c2126');
  addBox(-33, 0, 22, 33, 5, 23, '#1c2126');
  addBox(-33, 0, -22, -32, 5, 22, '#1c2126');
  addBox(32, 0, -22, 33, 5, 22, '#1c2126');
  addBox(6, 3, -4, 20, 3.4, 4, '#8a939c'); // catwalk deck
  addBox(2, 0, -4, 6, 3, 4, '#2e353c');    // ramp block (approx.)
  for (const pr of PROPS) {
    if (pr.label === 'CATWALK') continue;
    addBox(pr.x - pr.w / 2, pr.y || 0, pr.z - pr.d / 2, pr.x + pr.w / 2, (pr.y || 0) + pr.h, pr.z + pr.d / 2, pr.c === 'amber' ? '#e8a33d' : pr.c === 'grey' ? '#8a939c' : '#2e353c');
  }
  // Site rings (floor quads).
  for (const key of ['A', 'B']) {
    const st = SITES[key];
    addBox(st.x - 4, 0, st.z - 4, st.x + 4, 0.08, st.z + 4, '#e8a33d');
  }
  quads.sort((a, b) => b.d - a.d);
  for (const q of quads) {
    fctx.fillStyle = q.color; fctx.globalAlpha = Math.max(0.35, Math.min(1, 18 / q.d));
    fctx.beginPath(); fctx.moveTo(q.pts[0].x, q.pts[0].y);
    for (let i = 1; i < q.pts.length; i++) fctx.lineTo(q.pts[i].x, q.pts[i].y);
    fctx.closePath(); fctx.fill();
  }
  fctx.globalAlpha = 1;
  // Bots as figures (far to near).
  const bots = sim.actors.filter(a => !a.isPlayer).map(a => ({ a, d: Math.hypot(a.x - p.x, a.z - p.z) })).sort((x, y) => y.d - x.d);
  for (const { a } of bots) {
    const feet = proj(a.x, a.y, a.z), head = proj(a.x, a.y + 1.85, a.z);
    if (!feet || !head) continue;
    const h = Math.abs(feet.y - head.y), w = h * 0.34;
    // Torso + legs as one tapered figure, head a separate circle above it.
    fctx.fillStyle = a.alive ? (a.team === 'F' ? '#e8a33d' : '#8a939c') : '#2e353c';
    fctx.fillRect(feet.x - w / 2, head.y + h * 0.16, w, h * 0.84);
    fctx.beginPath(); fctx.arc(feet.x, head.y + h * 0.08, w * 0.30, 0, Math.PI * 2); fctx.fill();
    if (h > 14) {
      fctx.fillStyle = '#e8e0d0'; fctx.font = `${Math.max(10, h * 0.13)}px monospace`; fctx.textAlign = 'center';
      fctx.fillText(a.name, feet.x, head.y - 6);
    }
  }
  // Tracer.
  for (const t of sim.tracers) {
    const a0 = proj(t.x0, t.y0, t.z0), a1 = proj(t.x1, t.y1, t.z1);
    if (!a0 || !a1) continue;
    fctx.strokeStyle = '#e8a33d'; fctx.lineWidth = 2;
    fctx.beginPath(); fctx.moveTo(a0.x, a0.y); fctx.lineTo(a1.x, a1.y); fctx.stroke();
  }
  // Gun viewmodel (bottom-right wedge).
  fctx.fillStyle = '#1c2126';
  fctx.beginPath(); fctx.moveTo(W * 0.62, H); fctx.lineTo(W * 0.78, H * 0.82); fctx.lineTo(W * 0.86, H * 0.86); fctx.lineTo(W * 0.86, H); fctx.closePath(); fctx.fill();
  fctx.fillStyle = '#e8a33d'; fctx.fillRect(W * 0.77, H * 0.82, 6, 10);
  // Zone label (below the HUD objective line, top-left).
  fctx.fillStyle = '#e8e0d0'; fctx.font = 'bold 16px monospace'; fctx.textAlign = 'left';
  fctx.fillText('FOUNDRY-9  •  A-LONG', 16, 108);
}

// --- fixed-step loop ---------------------------------------------------------
let last = performance.now(), acc = 0, frames = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = Math.min(100, now - last); last = now;
  if (!sim._frozen) {
    acc += dtMs / 1000;
    let n = 0;
    while (acc >= DT && n < 5) {
      stepPlayer(sim, input, DT);
      stepSim(sim, DT, input);
      updateBots(sim, DT);
      // Bot buy at round start.
      if (sim.phase === 'buy' && sim.phaseT > BUY_TIME - 0.1) {
        for (const a of sim.actors) if (!a.isPlayer && !a._bought) { a._bought = true; const { botBuy } = botBuyModule; botBuy(sim, a); }
      }
      if (sim.phase !== 'buy') for (const a of sim.actors) a._bought = false;
      acc -= DT; n++;
      // Hearing: player shots alert nearby enemies.
      if (sim.stats.shots > frame._shots) { hearShot(sim, sim.actors[0]); frame._shots = sim.stats.shots; }
    }
    if (n === 5) acc = 0;
  }
  // Scoreboard while Tab is held.
  updateScoreboard(hud, !!input.keys['Tab']);
  updateHud(hud, dtMs / 1000);
  if (useFallback) renderFallback(); else render3D();
  frames++;
  if (shotMode && frames >= 3 && !window.__shotReady) {
    window.__shotReady = true;
    document.body.dataset.shotReady = 'true';
  }
  if (selftest && frames === 5) runSelftest();
}
// botBuy imported lazily to keep the loop's import list short.
import { botBuy as _botBuy } from './sim.js';
const botBuyModule = { botBuy: _botBuy };
frame._shots = 0;

// --- self-test (?selftest=1): scripted round, no rendering needed ----------
function runSelftest() {
  const out = { buy: null, reload: null, grenade: null, plant: null, defuse: null, rounds: 0, errors: window.__errors.slice(), events: [] };
  try {
    const p = sim.actors[0];
    // 1. Buy during buy phase (frag $300 is affordable on the $800 start).
    const r = buyItem(sim, p, 'frag');
    out.buy = r.ok ? `bought Frag for $${r.price}, money $${p.money}` : `FAILED: ${r.why}`;
    // 2. Start the round.
    sim.phaseT = 0; stepSim(sim, DT, input);
    // 3. Scripted play: 240 s of sim time, max 3 rounds.
    let steps = 0, lastRound = sim.round, firedAt = 0;
    while (steps < 240 * 60 && sim.round <= lastRound + 2 && !sim.matchOver) {
      const t = sim.time;
      // Fire at the nearest visible enemy every 0.4 s.
      if (t - firedAt > 0.4 && p.alive && sim.phase === 'live') {
        firedAt = t;
        let best = null, bd = 1e9;
        for (const b of sim.actors) {
          if (b.team === p.team || !b.alive) continue;
          const d = Math.hypot(b.x - p.x, b.z - p.z);
          if (d < bd) { bd = d; best = b; }
        }
        if (best) {
          p.yaw = yawTo(p.x, p.z, best.x, best.z); p.pitch = 0;
          const res = shootSim();
          if (res && res.empty) startReload(sim, p);
        }
      }
      // Grenade once, in the first live round that lasts past 25 s.
      if (!out.grenade && sim.phase === 'live' && t > 25) {
        p.grenades = 1;
        out.grenade = throwGrenade(sim, p) ? 'threw frag' : 'FAILED to throw';
      }
      // Reload check: force an empty mag once.
      if (!out.reload && p.mag === 0 && p.reserve > 0) {
        const ok = startReload(sim, p);
        out.reload = ok ? 'reload started and finished in sim' : 'FAILED to start reload';
        for (let i = 0; i < 200; i++) stepSim(sim, DT, input);
      }
      stepSim(sim, DT, input);
      updateBots(sim, DT);
      // Teleport the carrier to SITE A once, so plant/defuse get exercised.
      if (!out._plantTry && sim.phase === 'live' && sim.bomb.state === 'carried') {
        const c = sim.actors[sim.bomb.carrierId];
        if (c && c.alive) { c.x = SITES.A.x; c.z = SITES.A.z; c.wp = 99; out._plantTry = true; }
      }
      if (sim.round !== lastRound) { out.rounds++; lastRound = sim.round; }
      steps++;
    }
    out.rounds = sim.round - 1 + (sim.phase === 'match' ? 1 : 0);
    out.plant = sim.stats.plants > 0 ? `${sim.stats.plants} plant(s) observed` : 'no plant observed in scripted run';
    out.defuse = sim.stats.defuses > 0 ? `${sim.stats.defuses} defuse(s) observed` : 'no defuse observed in scripted run';
    out.score = `${sim.score.F}-${sim.score.S}`;
    out.stats = { shots: sim.stats.shots, hits: sim.stats.hits, kills: sim.stats.kills, buys: sim.stats.buys, grenades: sim.stats.grenades, reloads: sim.stats.reloads };
    out.events = sim.events.slice(-30);
    out.errors = window.__errors.slice();
  } catch (e) {
    out.errors.push('selftest exception: ' + (e && e.message));
  }
  document.body.dataset.testResult = JSON.stringify(out);
  document.title = 'SELFTEST ' + JSON.stringify(out);
  window.__testResult = out;
  window.__shotReady = true;
  document.body.dataset.shotReady = 'true';
}
function shootSim() {
  // Player fires via the shared shoot() with the current aim.
  const p = sim.actors[0];
  const { shoot } = shootModule;
  return shoot(sim, p, p.yaw, p.pitch);
}
import { shoot as _shoot } from './sim.js';
const shootModule = { shoot: _shoot };

// --- go ----------------------------------------------------------------------
if (shotMode) stageShot(shotMode);
requestAnimationFrame(frame);
