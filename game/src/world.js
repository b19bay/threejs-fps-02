// world.js — FOUNDRY-9: original 3-lane industrial smelting hall.
// Map: 64 x 44 m. Attackers spawn west, defenders east. Sites A (north-east)
// and B (south-east). Lanes: A-long (north), Mid (centre, with a raised
// catwalk + ramp), B-tunnel (south). Six colours only:
//   dark #101418, panel #1c2126, hairline #2e353c, ink #e8e0d0,
//   grey #8a939c, amber #e8a33d.
// Collision is a list of 2D AABBs; groundHeight() gives the walkable height
// (0, or the catwalk ramp/platform). Every wall and prop in COLLIDERS blocks
// movement and bullets; segmentBlocked() is the shared line-of-sight test.
import * as THREE from 'three';

export const MAP = { x0: -32, x1: 32, z0: -22, z1: 22 };
export const SPAWNS = { attacker: { x: -28, z: 0 }, defender: { x: 28, z: 0 } };
export const SITES = {
  A: { x: 24, z: -16, r: 4, label: 'SITE A — FURNACE' },
  B: { x: 24, z: 16, r: 4, label: 'SITE B — SMELTER' },
};
// Waypoint chains per lane (attack direction west -> east).
export const LANES = {
  A: [[-28, 0], [-22, -14], [-12, -16], [0, -16], [10, -16], [18, -16], [24, -16]],
  mid: [[-28, 0], [-14, 0], [-4, 0], [4, 0], [12, 0], [18, 0], [24, -8]],
  B: [[-28, 0], [-22, 14], [-12, 16], [0, 16], [10, 16], [18, 16], [24, 16]],
  defA: [[28, 0], [24, -8], [24, -16]],
  defB: [[28, 0], [24, 8], [24, 16]],
  defMid: [[28, 0], [16, 0], [12, 0]],
};
// Hold positions: bots pause here to check angles (waypoint index, seconds).
export const HOLDS = { A: [2, 4], mid: [3, 5], B: [2, 4] };

// --- collision ---------------------------------------------------------------
// AABB list {x0,z0,x1,z1,h} — h is the wall height (bullets stop below it).
export const COLLIDERS = [];
function wall(x0, z0, x1, z1, h = 4) { COLLIDERS.push({ x0, z0, x1, z1, h }); return COLLIDERS[COLLIDERS.length - 1]; }
// Outer boundary.
wall(MAP.x0 - 1, MAP.z0 - 1, MAP.x1 + 1, MAP.z0, 5);
wall(MAP.x0 - 1, MAP.z1, MAP.x1 + 1, MAP.z1 + 1, 5);
wall(MAP.x0 - 1, MAP.z0, MAP.x0, MAP.z1, 5);
wall(MAP.x1, MAP.z0, MAP.x1 + 1, MAP.z1, 5);
// Lane divider walls (create the three lanes, with gaps as doorways).
wall(-14, -8, -12, -2, 4);   // north divider, west
wall(2, -8, 4, -2, 4);       // north divider, east
wall(-14, 2, -12, 8, 4);     // south divider, west
wall(2, 2, 4, 8, 4);         // south divider, east
// Mid cross-wall with a central doorway.
wall(-6, -1.2, -4, 1.2, 4);
wall(14, -1.2, 16, 1.2, 4);
// Site cover + furnace blocks.
wall(20, -19, 22, -13, 3.2); // furnace block at A
wall(26, -19, 28, -13, 3.2); // A back wall block
wall(20, 13, 22, 19, 3.2);   // smelter block at B
wall(26, 13, 28, 19, 3.2);   // B back wall block
// Crates (cover) scattered on the lanes.
wall(-18, -18, -16, -16, 1.6);
wall(-6, -18.5, -4, -17, 1.6);
wall(6, -18, 8, -16.5, 1.6);
wall(-18, 16, -16, 18, 1.6);
wall(-6, 17, -4, 18.5, 1.6);
wall(6, 16.5, 8, 18, 1.6);
wall(-2, -6, 0, -4, 1.4);
wall(-2, 4, 0, 6, 1.4);
wall(12, -6, 14, -4, 1.4);
wall(12, 4, 14, 6, 1.4);
// Catwalk side rails (the platform itself is walked via the ramp at x 2..6).
wall(6, -4.6, 20, -4, 3.4);
wall(6, 4, 20, 4.6, 3.4);
wall(20, -4, 20.6, 4, 3.4);

export function groundHeight(x, z) {
  // Catwalk platform x 6..20, z -4..4 at height 3; ramp x 2..6 slopes up.
  if (x >= 6 && x <= 20 && z >= -4 && z <= 4) return 3;
  if (x >= 2 && x < 6 && z >= -4 && z <= 4) return (x - 2) / 4 * 3;
  return 0;
}

// Circle (radius r) vs AABB colliders: push the point out. Returns {x,z}.
export function resolveCircle(x, z, r) {
  for (const c of COLLIDERS) {
    const cx = Math.max(c.x0, Math.min(x, c.x1));
    const cz = Math.max(c.z0, Math.min(z, c.z1));
    const dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        x = cx + dx / d * r; z = cz + dz / d * r;
      } else {
        // Centre inside the box: push out along the smallest penetration axis.
        const pl = x - c.x0, pr = c.x1 - x, pt = z - c.z0, pb = c.z1 - z;
        const m = Math.min(pl, pr, pt, pb);
        if (m === pl) x = c.x0 - r; else if (m === pr) x = c.x1 + r;
        else if (m === pt) z = c.z0 - r; else z = c.z1 + r;
      }
    }
  }
  // Map bounds.
  x = Math.max(MAP.x0 + 0.5, Math.min(MAP.x1 - 0.5, x));
  z = Math.max(MAP.z0 + 0.5, Math.min(MAP.z1 - 0.5, z));
  return { x, z };
}

// 2D segment vs colliders: true if any wall blocks the line (line of sight).
export function segmentBlocked(x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  for (const c of COLLIDERS) {
    let t0 = 0, t1 = 1, ok = true;
    const o = [x0, z0], d = [dx, dz], mn = [c.x0, c.z0], mx = [c.x1, c.z1];
    for (let i = 0; i < 2; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) { ok = false; break; } }
      else {
        let ta = (mn[i] - o[i]) / d[i], tb = (mx[i] - o[i]) / d[i];
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
        if (t0 > t1) { ok = false; break; }
      }
    }
    if (ok) return true;
  }
  return false;
}

// --- visual props (shared by the three.js scene and the 2D fallback) ---------
// Each prop: centre, size, height, colour key, optional label.
export const PROPS = [
  { x: 21, z: -16, w: 2, d: 6, h: 3.2, c: 'panel', label: 'FURNACE' },
  { x: 27, z: -16, w: 2, d: 6, h: 3.2, c: 'panel' },
  { x: 21, z: 16, w: 2, d: 6, h: 3.2, c: 'panel', label: 'SMELTER' },
  { x: 27, z: 16, w: 2, d: 6, h: 3.2, c: 'panel' },
  { x: -17, z: -17, w: 2, d: 2, h: 1.6, c: 'grey', label: 'CRATES' },
  { x: -5, z: -17.7, w: 2, d: 1.5, h: 1.6, c: 'grey' },
  { x: 7, z: -17.2, w: 2, d: 1.5, h: 1.6, c: 'grey' },
  { x: -17, z: 17, w: 2, d: 2, h: 1.6, c: 'grey' },
  { x: -5, z: 17.7, w: 2, d: 1.5, h: 1.6, c: 'grey' },
  { x: 7, z: 17.2, w: 2, d: 1.5, h: 1.6, c: 'grey' },
  { x: -1, z: -5, w: 2, d: 2, h: 1.4, c: 'amber', label: 'PRESS' },
  { x: -1, z: 5, w: 2, d: 2, h: 1.4, c: 'grey' },
  { x: 13, z: -5, w: 2, d: 2, h: 1.4, c: 'grey' },
  { x: 13, z: 5, w: 2, d: 2, h: 1.4, c: 'grey' },
  { x: 13, z: 0, w: 14, d: 8, h: 0.4, c: 'panel', y: 3, label: 'CATWALK' },
  { x: -24, z: -10, w: 1.5, d: 1.5, h: 2.6, c: 'amber', label: 'TANK' },
  { x: -24, z: 10, w: 1.5, d: 1.5, h: 2.6, c: 'amber' },
];

export const PALETTE = {
  dark: 0x101418, panel: 0x1c2126, hairline: 0x2e353c,
  ink: 0xe8e0d0, grey: 0x8a939c, amber: 0xe8a33d,
};

// Build the three.js scene for FOUNDRY-9. Shared materials, no per-frame
// allocation; shadows off (software renderer must hold frame rate).
export function buildWorld(scene) {
  const mats = {
    dark: new THREE.MeshStandardMaterial({ color: PALETTE.dark, roughness: 0.95 }),
    panel: new THREE.MeshStandardMaterial({ color: PALETTE.panel, roughness: 0.85 }),
    hairline: new THREE.MeshStandardMaterial({ color: PALETTE.hairline, roughness: 0.9 }),
    grey: new THREE.MeshStandardMaterial({ color: PALETTE.grey, roughness: 0.7, metalness: 0.3 }),
    amber: new THREE.MeshStandardMaterial({ color: PALETTE.amber, roughness: 0.55, metalness: 0.4, emissive: 0x442200 }),
  };
  const group = new THREE.Group();
  // Floor: one big slab + a darker mid strip so lanes read at a glance.
  const floor = new THREE.Mesh(new THREE.BoxGeometry(66, 0.5, 46), mats.dark);
  floor.position.set(0, -0.25, 0); group.add(floor);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(66, 0.06, 2.4), mats.hairline);
  strip.position.set(0, 0.03, 0); group.add(strip);
  // Lane guide strips (amber hairlines down A-long and B-tunnel).
  for (const z of [-16, 16]) {
    const guide = new THREE.Mesh(new THREE.BoxGeometry(56, 0.05, 0.35), mats.amber);
    guide.position.set(0, 0.04, z); group.add(guide);
  }
  // Walls from the collider list (visual boxes, height h).
  for (const c of COLLIDERS) {
    if (c.x1 - c.x0 > 60 || c.z1 - c.z0 > 40) continue; // outer bounds drawn below
    const w = c.x1 - c.x0, d = c.z1 - c.z0;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, c.h, d), mats.panel);
    m.position.set((c.x0 + c.x1) / 2, c.h / 2, (c.z0 + c.z1) / 2);
    group.add(m);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.12, d + 0.08), mats.hairline);
    cap.position.set((c.x0 + c.x1) / 2, c.h + 0.06, (c.z0 + c.z1) / 2);
    group.add(cap);
  }
  // Outer walls.
  const mkWall = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats.panel);
    m.position.set(x, y, z); group.add(m);
  };
  mkWall(66, 5, 1, 0, 2.5, -22.5); mkWall(66, 5, 1, 0, 2.5, 22.5);
  mkWall(1, 5, 46, -32.5, 2.5, 0); mkWall(1, 5, 46, 32.5, 2.5, 0);
  // Catwalk deck + ramp + support pillars.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(14, 0.4, 8), mats.grey);
  deck.position.set(13, 3.2, 0); group.add(deck);
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.35, 8), mats.grey);
  ramp.position.set(4, 1.5, 0); ramp.rotation.z = -Math.atan2(3, 4); group.add(ramp);
  for (const [px, pz] of [[7, -3.5], [7, 3.5], [19, -3.5], [19, 3.5]]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.2, 0.5), mats.hairline);
    p.position.set(px, 1.6, pz); group.add(p);
  }
  // Pipes along the north wall (cylinders, amber + grey).
  for (let i = 0; i < 3; i++) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 60, 10), i === 1 ? mats.amber : mats.grey);
    pipe.rotation.z = Math.PI / 2; pipe.position.set(0, 4.2 - i * 0.55, -21.4);
    group.add(pipe);
  }
  // Furnace glow: emissive amber slabs at both sites.
  for (const key of ['A', 'B']) {
    const st = SITES[key];
    const glow = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.2, 4.5), mats.amber);
    glow.position.set(st.x - 3.4, 1.6, st.z); group.add(glow);
  }
  // Site markers: flat amber rings on the floor.
  for (const key of ['A', 'B']) {
    const st = SITES[key];
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 4, 32), new THREE.MeshBasicMaterial({ color: PALETTE.amber, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(st.x, 0.06, st.z); group.add(ring);
  }
  // Zone label boards: thin amber-topped panels over each lane entrance.
  const board = (x, z, w) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, 0.15), mats.amber);
    b.position.set(x, 3.6, z); group.add(b);
  };
  board(-20, -16, 4); board(-20, 16, 4); board(-20, 0, 4);
  scene.add(group);

  // Lighting: hemisphere ambient + a few warm point lights (furnace, mid, B).
  scene.add(new THREE.HemisphereLight(0xe8e0d0, 0x101418, 0.85));
  const lights = [
    [24, 4.5, -16, 0xe8a33d, 60], [24, 4.5, 16, 0xe8a33d, 60],
    [0, 5, 0, 0xffd9a0, 45], [-28, 4, 0, 0xe8e0d0, 25], [28, 4, 0, 0xe8e0d0, 25],
  ];
  for (const [x, y, z, col, inten] of lights) {
    const l = new THREE.PointLight(col, inten, 34, 1.6);
    l.position.set(x, y, z); scene.add(l);
  }
  scene.fog = new THREE.Fog(0x101418, 30, 85);
  scene.background = new THREE.Color(0x101418);
  return { group, mats };
}
