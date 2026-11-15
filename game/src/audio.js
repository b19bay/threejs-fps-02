// audio.js — tiny synthesized WebAudio blips. No audio files, no network.
// All sounds are short oscillator envelopes; mute toggles with M.
let ctx = null, muted = false;
function ac() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; }
  }
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
function blip(freq, dur, type, vol, slideTo) {
  if (muted) return;
  const c = ac(); if (!c) return;
  try {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, c.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + dur + 0.02);
  } catch (e) { /* audio is best-effort */ }
}
export const sfx = {
  shot(w) { blip(w === 'vk47' ? 160 : w === 'hornet' ? 220 : 300, 0.09, 'square', 0.12, 60); },
  enemyShot() { blip(140, 0.08, 'square', 0.05, 70); },
  hit(head) { blip(head ? 1200 : 880, 0.06, 'sine', 0.14); },
  kill() { blip(520, 0.12, 'sine', 0.16, 780); },
  reload() { blip(440, 0.07, 'triangle', 0.1); blip(330, 0.07, 'triangle', 0.1); },
  empty() { blip(180, 0.05, 'square', 0.08); },
  plantBeep() { blip(990, 0.12, 'sine', 0.16); },
  plantDone() { blip(660, 0.2, 'sine', 0.16, 990); },
  explode() { blip(90, 0.7, 'sawtooth', 0.25, 30); },
  win() { [523, 659, 784].forEach((f, i) => setTimeout(() => blip(f, 0.18, 'sine', 0.14), i * 120)); },
  lose() { [392, 330, 262].forEach((f, i) => setTimeout(() => blip(f, 0.18, 'sine', 0.12), i * 120)); },
  buy() { blip(760, 0.08, 'sine', 0.14, 980); },
  deny() { blip(200, 0.12, 'square', 0.1, 140); },
  step() { blip(90, 0.03, 'sine', 0.02); },
  click() { blip(600, 0.04, 'sine', 0.1); },
};
export function toggleMute() { muted = !muted; return muted; }
export function isMuted() { return muted; }
export function unlockAudio() { ac(); }
