// weapon.js — FOUNDRY-9 arsenal: 3 weapons + frag grenade.
// All damage / spread / recoil numbers live here; sim.js and bots.js read
// them, so player and bots play by identical rules.
export const WEAPONS = {
  vk47: {
    id: 'vk47', name: 'VK-47', slot: 1, primary: true, price: 2500,
    damage: 34, headMult: 2, interval: 0.115, mag: 30, reserve: 90,
    reload: 2.6, spread: 0.011, spreadMove: 0.028, heat: 0.004, recoil: 0.016,
    range: 60, auto: true, tracer: 0xe8a33d,
  },
  hornet: {
    id: 'hornet', name: 'Hornet-9', slot: 1, primary: true, price: 1200,
    damage: 22, headMult: 2, interval: 0.075, mag: 25, reserve: 100,
    reload: 2.1, spread: 0.014, spreadMove: 0.016, heat: 0.003, recoil: 0.010,
    range: 45, auto: true, tracer: 0xe8e0d0,
  },
  p12: {
    id: 'p12', name: 'P-12', slot: 2, primary: false, price: 0,
    damage: 28, headMult: 2, interval: 0.28, mag: 12, reserve: 36,
    reload: 1.6, spread: 0.009, spreadMove: 0.02, heat: 0.002, recoil: 0.012,
    range: 40, auto: false, tracer: 0x8a939c,
  },
};
export const GRENADE = { id: 'frag', name: 'Frag', price: 300, maxPerRound: 1, radius: 6, maxDmg: 90, minDmg: 10, fuse: 2.2 };
export const ARMOUR_PRICE = 650;

export function weaponDamage(w, head) {
  return Math.round(w.damage * (head ? w.headMult : 1));
}
export function canAfford(money, price) { return money >= price; }

// Grenade arc preview: ballistic points from the thrower's eye, used by the
// HUD/viewmodel while the grenade is held. Pure math, no allocation in loop
// beyond the returned array (called only when the grenade is selected).
export function grenadeArc(x, y, z, yaw, pitch, steps = 14) {
  const pts = [];
  let px = x, py = y, pz = z;
  let vx = -Math.sin(yaw) * Math.cos(pitch) * 14;
  let vy = Math.sin(pitch) * 14 + 2;
  let vz = -Math.cos(yaw) * Math.cos(pitch) * 14;
  const dt = 0.09;
  for (let i = 0; i < steps; i++) {
    vy -= 18 * dt; px += vx * dt; py += vy * dt; pz += vz * dt;
    if (py < 0.15) break;
    pts.push([px, py, pz]);
  }
  return pts;
}
