// hud.js — FOUNDRY-9 HUD: crosshair + hitmarker, health/armour, ammo,
// money, round timer, round score, team alive counts, bomb status, kill feed,
// round banner, map + objective line, buy menu, scoreboard.
// All DOM lives in index.html; this module only updates it (no per-frame
// allocation: text is written only when it changes).
import { WEAPONS, GRENADE, ARMOUR_PRICE } from './weapon.js';
import { teamName, aliveCount } from './sim.js';

const BUY_ITEMS = [
  { id: 'vk47', key: '1', name: 'VK-47 Rifle', desc: 'Auto • 30 rnd • $2500', price: 2500 },
  { id: 'hornet', key: '2', name: 'Hornet-9 SMG', desc: 'Auto • 25 rnd • $1200', price: 1200 },
  { id: 'frag', key: '3', name: 'Frag Grenade', desc: '1 per round • $300', price: 300 },
  { id: 'armour', key: '4', name: 'Kevlar Armour', desc: '100 armour • $650', price: 650 },
  { id: 'p12', key: '5', name: 'P-12 Pistol', desc: 'Always owned • $0', price: 0 },
];

export function createHud(s, onBuy) {
  const $ = id => document.getElementById(id);
  const els = {
    health: $('hud-health'), armour: $('hud-armour'), ammo: $('hud-ammo'),
    money: $('hud-money'), timer: $('hud-timer'), score: $('hud-score'),
    alive: $('hud-alive'), bomb: $('hud-bomb'), feed: $('hud-feed'),
    banner: $('hud-banner'), weapon: $('hud-weapon'), reload: $('hud-reload'),
    cross: $('crosshair'), hit: $('hitmarker'), buy: $('buy-menu'),
    buyList: $('buy-list'), board: $('scoreboard'), boardBody: $('board-body'),
    objective: $('hud-objective'), hint: $('hud-hint'), mute: $('hud-mute'),
    plant: $('hud-plant'), grenade: $('hud-grenade'),
  };
  const buyRows = BUY_ITEMS.map(it => {
    const row = document.createElement('div');
    row.className = 'buy-row';
    row.innerHTML = `<b>[${it.key}] ${it.name}</b><span>${it.desc}</span>`;
    row.addEventListener('click', () => onBuy(it.id));
    els.buyList.appendChild(row);
    return row;
  });
  const hud = { s, els, buyRows, last: {}, buyVisible: false, hitT: 0 };
  return hud;
}

function setText(el, key, hud, v) {
  if (hud.last[key] !== v) { hud.last[key] = v; el.textContent = v; }
}

export function showBuy(hud, show) {
  hud.buyVisible = show;
  hud.els.buy.style.display = show ? 'block' : 'none';
  if (show) {
    const p = hud.s.actors[0];
    hud.buyRows.forEach((row, i) => {
      const it = BUY_ITEMS[i];
      row.classList.toggle('cant', p.money < it.price || (it.id === 'frag' && p.grenades >= 1));
    });
  }
}
export function isBuyOpen(hud) { return hud.buyVisible; }

export function flashHitmarker(hud, head) {
  hud.els.hit.style.opacity = '1';
  hud.els.hit.style.borderColor = head ? '#e8a33d' : '#e8e0d0';
  hud.hitT = 0.25;
}

export function updateHud(hud, dt) {
  const s = hud.s, els = hud.els, p = s.actors[0];
  if (hud.hitT > 0) { hud.hitT -= dt; if (hud.hitT <= 0) els.hit.style.opacity = '0'; }
  setText(els.health, 'hp', hud, `${Math.max(0, Math.ceil(p.hp))}`);
  els.health.style.color = p.hp <= 30 ? '#e8a33d' : '';
  setText(els.armour, 'ar', hud, `${Math.round(p.armour)}`);
  const w = WEAPONS[p.weapon];
  setText(els.ammo, 'am', hud, `${p.mag} / ${p.reserve}`);
  setText(els.weapon, 'wp', hud, `${w.name}${p.grenades > 0 ? '  + FRAG' : ''}`);
  setText(els.money, 'mo', hud, `$${p.money}`);
  const t = Math.max(0, Math.ceil(s.timer));
  const phase = s.phase === 'buy' ? `BUY ${Math.max(0, Math.ceil(s.phaseT))}` : s.phase === 'over' ? 'ROUND END' : s.phase === 'match' ? 'MATCH END' : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  setText(els.timer, 'ti', hud, phase);
  setText(els.score, 'sc', hud, `${s.score.F}–${s.score.S}`);
  setText(els.alive, 'al', hud, `FOUNDRY ${aliveCount(s, 'F')}  •  SLAG ${aliveCount(s, 'S')}`);
  const b = s.bomb;
  const bombTxt = b.state === 'planted' ? `BOMB PLANTED SITE ${b.site} — ${Math.ceil(b.fuseT)}s`
    : b.state === 'exploded' ? 'BOMB DETONATED'
    : b.state === 'defused' ? 'BOMB DEFUSED'
    : b.state === 'dropped' ? 'BOMB DROPPED'
    : (p.team === s.attacker ? 'BOMB: CARRIED BY ' + (s.actors[b.carrierId] ? s.actors[b.carrierId].name : '—') : 'BOMB: DEFEND THE SITES');
  setText(els.bomb, 'bo', hud, bombTxt);
  els.bomb.style.color = b.state === 'planted' ? '#e8a33d' : '';
  setText(els.objective, 'ob', hud, `FOUNDRY-9  •  ${teamName(s.attacker)} ATTACK — PLANT AT SITE A OR B  •  FIRST TO 5`);
  // Kill feed.
  const feedHtml = s.feed.map(f => `<div>${f}</div>`).join('');
  if (hud.last.feed !== feedHtml) { hud.last.feed = feedHtml; els.feed.innerHTML = feedHtml; }
  // Banner.
  if (s.bannerT > 0 && s.banner) {
    els.banner.style.display = 'block';
    setText(els.banner, 'ba', hud, s.banner);
  } else els.banner.style.display = 'none';
  // Reload bar.
  if (p.reloadT > 0) {
    els.reload.style.display = 'block';
    const total = WEAPONS[p.weapon].reload;
    els.reload.querySelector('.bar').style.width = `${Math.round((1 - p.reloadT / total) * 100)}%`;
    els.reload.querySelector('span').textContent = `RELOADING ${w.name}…`;
  } else els.reload.style.display = 'none';
  // Plant / defuse progress.
  const prog = Math.max(p.plantT / 3, p.defuseT / 5);
  if (prog > 0) {
    els.plant.style.display = 'block';
    els.plant.querySelector('.bar').style.width = `${Math.round(prog * 100)}%`;
    els.plant.querySelector('span').textContent = p.plantT > 0 ? 'PLANTING…' : 'DEFUSING…';
  } else els.plant.style.display = 'none';
  // Grenade arc hint.
  setText(els.grenade, 'gr', hud, p.grenades > 0 ? 'FRAG READY — press 4 to throw' : '');
  // Crosshair spread grows with movement + heat (CSS var drives the gap).
  const spreadPx = 4 + Math.min(18, (Math.hypot(p.vx, p.vz) * 1.6) + p.spread * 220 + p.recoil * 120);
  els.cross.style.setProperty('--gap', `${spreadPx.toFixed(1)}px`);
  // Hint line.
  const hint = !p.alive ? 'YOU ARE DOWN — spectating the round'
    : s.phase === 'buy' ? 'BUY PHASE — press B for the buy menu'
    : s.phase === 'match' ? 'Press R to restart the match'
    : document.pointerLockElement ? '' : 'Click to lock the mouse — WASD move • R reload • B buy • E plant/defuse';
  setText(els.hint, 'hi', hud, hint);
}

export function updateScoreboard(hud, show) {
  const s = hud.s;
  hud.els.board.style.display = show ? 'block' : 'none';
  if (!show) return;
  const rows = s.actors.map(a =>
    `<tr><td>${a.name}${a.isPlayer ? ' (YOU)' : ''}</td><td>${teamName(a.team)}</td><td>${a.kills}</td><td>${a.deaths}</td><td>$${a.money}</td><td>${a.alive ? 'ALIVE' : 'DEAD'}</td></tr>`).join('');
  const html = rows;
  if (hud.last.board !== html) { hud.last.board = html; hud.els.boardBody.innerHTML = html; }
}
