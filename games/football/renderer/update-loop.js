/**
 * Football v2 — per-frame render dispatch.
 *
 * Single function: `renderState(ctx, state)` resets the per-pool
 * cursors, places stickmen + shadows, updates name labels, places the
 * ball(s) + ball-shadow, drains physics events into particle bursts,
 * advances the active camera, and renders the scene. Hides any pool
 * slots beyond what this frame used so an earlier frame's higher-N
 * harness scenario doesn't bleed leftover meshes through.
 *
 * ctx-style.
 */

import {
  BALL_VISUAL_RADIUS,
  BALL_SHADOW_GROWTH_PER_Z, BALL_SHADOW_FADE_PER_Z,
  SHADOW_ALPHA_BASE, SHADOW_Y, COLOR_TEXT,
} from './tuning.js';
import { Z_STRETCH } from '../physics/index.js';
import { addStickman, placePlayerShadow } from './player-rig.js';
import { updateNameLabels } from './scoreboard.js';
import {
  spawnBounceParticles, spawnPushContactParticles, spawnGoalBurst,
  stepParticles, drawParticles,
} from './particles.js';
import { stepDebugCam, stepFollowCam } from './camera.js';

// Fallback arrays for the single-match live path (state.players /
// state.balls are only set by the debug-harness composite). Reused
// across frames instead of allocated fresh each call; refilled
// unconditionally on every renderState() so a stale ref can never
// leak through even if state.p1/p2/ball ever change identity
// (resetStateInPlace mutates in place today, but this doesn't rely
// on that). Contents are consumed synchronously within the call —
// nothing retains the array itself past this function.
const _fallbackPlayers = [null, null];
const _fallbackBalls = [null];

export function renderState(ctx, state) {
  const tick = state.tick || 0;
  // state.players is the N-player path (any array of player-shaped
  // objects). Falls back to [p1, p2] for the single-match case.
  _fallbackPlayers[0] = state.p1;
  _fallbackPlayers[1] = state.p2;
  const players = state.players || _fallbackPlayers;
  const prevTorsoCursor    = ctx._stickmanTorsoCursor;
  const prevUpperArmCursor = ctx._stickmanUpperArmCursor;
  const prevLowerArmCursor = ctx._stickmanLowerArmCursor;
  const prevLegCursor      = ctx._stickmanLegCursor;
  const prevSphCursor      = ctx._stickmanSphCursor;
  const prevPlayerShadowCursor = ctx._playerShadowCursor;
  const prevBallCursor         = ctx._ballCursor;
  const prevBallShadowCursor   = ctx._ballShadowCursor;
  const prevRestStarCursor     = ctx._restStarCursor;
  ctx._stickmanTorsoCursor    = 0;
  ctx._stickmanUpperArmCursor = 0;
  ctx._stickmanLowerArmCursor = 0;
  ctx._stickmanLegCursor      = 0;
  ctx._stickmanSphCursor      = 0;
  ctx._playerShadowCursor     = 0;
  ctx._ballCursor             = 0;
  ctx._ballShadowCursor       = 0;
  ctx._restStarCursor         = 0;

  // Per-player dead-ball flags. The harness may stamp each player with
  // `_scenePauseState` + `_sceneGoalScorer` + `_sceneWinner` so multiple
  // independent scenarios inside one composite render frame don't
  // cross-contaminate. Live-match path falls back to global state.
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const pPause      = p._scenePauseState !== undefined ? p._scenePauseState : state.pauseState;
    const pGoalScorer = p._sceneGoalScorer !== undefined ? p._sceneGoalScorer : state.goalScorer;
    const pWinner     = p._sceneWinner     !== undefined ? p._sceneWinner     : state.winner;
    const pSide       = p._sceneSide       !== undefined ? p._sceneSide
                       : p === state.p1 ? 'left' : p === state.p2 ? 'right' : null;

    const pCelebrating = pPause === 'celebrate';
    const pMatchend    = pPause === 'matchend';
    const pMatchEndPhase = state.matchEndPhase;

    // Per-player flags drive both pose layers and the heading override
    // in animation/state.js.
    let isScorer    = pCelebrating && pGoalScorer === p;
    let isGrieving  = pCelebrating && pGoalScorer && pGoalScorer !== p;
    let isReposition = pPause === 'reposition';
    let faceCameraSmooth = false;
    let faceEachOtherSmooth = false;
    let isMatchendWin = false, isMatchendLose = false;

    if (pMatchend && pWinner && pSide) {
      const isWinner = pSide === pWinner;
      if (pMatchEndPhase === 'reposition') {
        isReposition = true;
      } else if (pMatchEndPhase === 'pose') {
        faceCameraSmooth = true;
        isScorer = isWinner;
        isGrieving = !isWinner;
      } else if (pMatchEndPhase === 'neutral') {
        faceEachOtherSmooth = true;
      } else {
        // Defensive fallback for harness scenarios that set
        // pauseState='matchend' without matchEndPhase — keep the
        // legacy static MATCHEND_WIN/LOSE pose.
        isMatchendWin  = isWinner;
        isMatchendLose = !isWinner;
      }
    }
    addStickman(
      ctx, p, COLOR_TEXT, tick, isScorer, isGrieving, isReposition,
      isMatchendWin, isMatchendLose, faceCameraSmooth, faceEachOtherSmooth,
    );
    placePlayerShadow(ctx, p);
  }
  // Player name labels — the two billboarded sprites above the heads.
  updateNameLabels(ctx, state, players);
  for (let i = ctx._stickmanTorsoCursor; i < prevTorsoCursor; i++) {
    ctx._stickmanTorsoOutline[i].visible = false;
    ctx._stickmanTorsoFill[i].visible = false;
    ctx._stickmanTorsoDisc[i].visible = false;
  }
  for (let i = ctx._stickmanUpperArmCursor; i < prevUpperArmCursor; i++) ctx._stickmanUpperArm[i].visible = false;
  for (let i = ctx._stickmanLowerArmCursor; i < prevLowerArmCursor; i++) ctx._stickmanLowerArm[i].visible = false;
  for (let i = ctx._stickmanLegCursor; i < prevLegCursor; i++) ctx._stickmanLeg[i].visible = false;
  for (let i = ctx._stickmanSphCursor; i < prevSphCursor; i++) ctx._stickmanSph[i].visible = false;
  for (let i = ctx._playerShadowCursor; i < prevPlayerShadowCursor; i++) ctx._playerShadows[i].visible = false;
  for (let i = ctx._restStarCursor; i < prevRestStarCursor; i++) ctx._restStars[i].visible = false;

  // Balls — single-ball state.ball path is backward-compatible;
  // state.balls[] is the N-ball path for harnesses/testing.
  // Each ball mesh accumulates its own spin quaternion across frames,
  // so callers must pass balls in stable index order.
  _fallbackBalls[0] = state.ball;
  const balls = state.balls || _fallbackBalls;
  const R = BALL_VISUAL_RADIUS;
  for (let bi = 0; bi < balls.length; bi++) {
    const b = balls[bi];
    while (ctx._ballMeshes.length <= bi) ctx._mkBall();
    while (ctx._ballShadows.length <= bi) ctx._ballShadows.push(ctx._makeShadow());
    const mesh = ctx._ballMeshes[bi];
    mesh.visible = true;
    const ballAltitude = b.z || 0;
    mesh.position.set(b.x, ballAltitude + BALL_VISUAL_RADIUS, b.y * Z_STRETCH);
    mesh.scale.set(BALL_VISUAL_RADIUS, BALL_VISUAL_RADIUS, BALL_VISUAL_RADIUS);
    // Rolling-without-slipping spin from linear velocity.
    const omegaX = (b.vy * Z_STRETCH) / R;
    const omegaZ = -b.vx / R;
    const omegaMag = Math.sqrt(omegaX * omegaX + omegaZ * omegaZ);
    if (omegaMag > 1e-5) {
      ctx._ballSpinAxis.set(omegaX / omegaMag, 0, omegaZ / omegaMag);
      ctx._ballSpinQuat.setFromAxisAngle(ctx._ballSpinAxis, omegaMag);
      mesh.quaternion.premultiply(ctx._ballSpinQuat);
    }
    // Ground shadow for this ball — stays flat on xz, grows slightly
    // and fades as the ball rises.
    const shadow = ctx._ballShadows[bi];
    const airH = Math.max(0, b.z || 0);
    const ballShadowR = BALL_VISUAL_RADIUS * (1 + airH * BALL_SHADOW_GROWTH_PER_Z);
    const ballShadowA = SHADOW_ALPHA_BASE / (1 + airH * BALL_SHADOW_FADE_PER_Z);
    shadow.visible = true;
    shadow.position.set(b.x, SHADOW_Y, b.y * Z_STRETCH);
    shadow.scale.set(ballShadowR * 2, ballShadowR * 2, 1);
    shadow._uAlpha.value = ballShadowA;
  }
  ctx._ballCursor       = balls.length;
  ctx._ballShadowCursor = balls.length;
  // Hide any ball / ball-shadow slots beyond what this frame used.
  for (let i = ctx._ballCursor;       i < prevBallCursor;       i++) ctx._ballMeshes[i].visible = false;
  for (let i = ctx._ballShadowCursor; i < prevBallShadowCursor; i++) ctx._ballShadows[i].visible = false;

  // Consume per-frame physics events. state.events is cleared at the
  // top of each tick, so anything here is brand-new this frame.
  for (let i = 0; i < state.events.length; i++) {
    const ev = state.events[i];
    if (ev.type === 'ball_bounce') spawnBounceParticles(ctx, ev);
    else if (ev.type === 'push_contact') spawnPushContactParticles(ctx, ev);
    else if (ev.type === 'goal') spawnGoalBurst(ctx, ev.scorer);
  }
  stepParticles(ctx);
  drawParticles(ctx);

  ctx._debugOverlay.update(state, players);

  if (ctx._followCam && ctx._followCam.active) stepFollowCam(ctx, state);
  else if (ctx._debugCam && ctx._debugCam.active) stepDebugCam(ctx);
  ctx.renderer.render(ctx.scene, ctx.camera);
}
