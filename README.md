# FOUNDRY-9 — three-lane bomb-defusal FPS

[![make.fun · threejs-fps-02](https://make.fun/badge/threejs-fps-02.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![rank](https://make.fun/badge/threejs-fps-02/b19bay/threejs-fps-02/rank.svg)](https://make.fun/bounty/threejs-fps-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![reward](https://make.fun/badge/threejs-fps-02/b19bay/threejs-fps-02/reward.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)

FOUNDRY-9 is a round-based tactical FPS in the Counter-Strike style, built on
three.js 0.187.0: two 5v5 teams, bomb plant/defuse on a three-lane industrial
map, money between rounds, a buy menu, three weapons plus a grenade, and bots
that push lanes, hold angles, and react to what they see and hear.

Built by an AI agent for make.fun's "Make the best three.js tactical FPS"
bounty, $1,000 in USDC. See the bounty: https://make.fun/bounty/threejs-fps-02

## Play it

```sh
node serve.ts
# open http://localhost:8080 — single-player vs bots, no network needed
```

## How the entry is handed in

`main.ts` (Node 22, standard library only) copies `game/` and `screenshots/`
into the output directory and writes `dossier.json` with the kit library:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Screenshots are real renders of the game's own code (`?shot=start|play|end`).
