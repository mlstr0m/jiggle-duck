/**
 * Manette des gaz (2e main) + vrille boostee au poing ferme.
 *
 * Le pinch de la 2e main pilote la VITESSE DE VOL : doigts serres = vite,
 * ouverts = lent. Poing ferme = vrille (un tour sur lui-meme avec
 * acceleration, facon Skyward Sword) : le leader s'arrache vers l'avant et
 * la volee, en ressorts de formation, le rattrape naturellement.
 *
 * Le facteur multiplie TOUS les systemes de defilement (ciel, vent,
 * paillettes, trainees) — les bases restent les reglages d'Aurelien — et la
 * cadence de battement des ailes (leader ET copains) monte en sqrt(facteur).
 */
export function createSpeedControl({
  sky,
  wind,
  sparkles,
  trails,
  flap,
  flock,
  grab,
  restForward,
  getAspect,
  isIntroActive,
}) {
  const ctl = {
    factor: 1,
    target: 1,
    min: 0.6, // main ouverte : plus lent que la croisiere
    max: 4.0, // doigts serres : sprint
    bases: {
      sky: sky.speed,
      wind: wind.speed,
      spark: sparkles.driftSpeed,
      trail: trails.driftSpeed,
    },
    boost: {
      active: false,
      t: 0,
      dur: 0.85, // duree du tour complet
      cooldown: 0,
      impulse: 4.0, // impulsion avant sur le corps
      extra: 4.5, // pic de vitesse monde, decroit sur la vrille
      // prise d'avance : le leader s'arrache DEVANT la volee puis se fait
      // rattraper — excursion de la cible du ressort, montee eclair / retour lent
      sepAmp: 1.6,
      sepDur: 3.2,
      sepT: Infinity,
    },
  };

  // poing ferme : au moins 3 doigts replies (bout plus pres du poignet que
  // sa base metacarpienne)
  const isFist = (lm) => {
    const w = lm[0];
    let folded = 0;
    for (const [tip, mcp] of [
      [8, 5],
      [12, 9],
      [16, 13],
      [20, 17],
    ]) {
      const dTip = Math.hypot(lm[tip].x - w.x, lm[tip].y - w.y);
      const dMcp = Math.hypot(lm[mcp].x - w.x, lm[mcp].y - w.y);
      if (dTip < dMcp * 1.15) folded++;
    }
    return folded >= 3;
  };

  // ratio pouce-index normalise de la 2e main (meme normalisation que le
  // pinch de la main de controle : invariant a la distance webcam)
  const throttleRatio = (lm) => {
    const aspect = getAspect();
    const dist = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    // meme reference robuste a l'inclinaison que le pinch (cf. pinch.js) :
    // paume OU empan des articulations, le plus grand des deux
    const ref = Math.max(dist(lm[0], lm[5]), dist(lm[5], lm[17]) / 0.62);
    if (ref < 1e-4) return 1;
    return dist(lm[4], lm[8]) / ref;
  };

  /**
   * A appeler chaque frame de tracking avec la 2e main (ou null).
   * Pendant l'intro, la 2e main est ignoree : pas de sprint ni de vrille
   * pendant que l'oiseau fait son entree.
   */
  const handleHand = (flapHand) => {
    if (!flapHand || isIntroActive()) {
      ctl.target = 1; // croisiere
      return;
    }
    const r = throttleRatio(flapHand);
    const k = Math.min(1, Math.max(0, (1.05 - r) / 0.75)); // 0 ouvert -> 1 serre
    ctl.target = ctl.min + (ctl.max - ctl.min) * k * k;

    const B = ctl.boost;
    if (isFist(flapHand) && !B.active && B.cooldown <= 0) {
      B.active = true;
      B.t = 0;
      B.sepT = 0;
      B.cooldown = B.dur + 1.6;
      // impulsion vers l'avant : le leader s'arrache de la formation
      grab.addImpulse(restForward, B.impulse);
    }
  };

  /**
   * Animation vrille + application du facteur. A appeler AVANT grab.update :
   * l'excursion de la cible et l'extraRoll doivent agir la frame courante.
   */
  const update = (dt) => {
    const B = ctl.boost;
    B.cooldown = Math.max(0, B.cooldown - dt);
    let boostExtra = 0;
    if (B.active) {
      B.t += dt;
      const k = Math.min(1, B.t / B.dur);
      // un tour complet avec acceleration puis freinage (easeInOutCubic)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      grab.extraRoll = e * Math.PI * 2;
      boostExtra = B.extra * (1 - k); // pic de vitesse qui retombe
      flap.boost = 1 - k; // ailes a fond pendant la vrille
      if (k >= 1) {
        B.active = false;
        grab.extraRoll = 0;
        flap.boost = 0;
      }
    }

    // prise d'avance : montee eclair (0.16 du temps), retour lent — le
    // leader file devant la volee, le ressort le ramene, elle le rattrape
    if (B.sepT < B.sepDur) {
      B.sepT += dt;
      const p = Math.min(1, B.sepT / B.sepDur);
      let env;
      if (p < 0.16) {
        const q = p / 0.16;
        env = 1 - (1 - q) * (1 - q);
      } else {
        const q = (p - 0.16) / 0.84;
        env = 1 - q * q * (3 - 2 * q); // smoothstep inverse
      }
      grab.desired.addScaledVector(restForward, B.sepAmp * env);
    }

    ctl.factor += (ctl.target + boostExtra - ctl.factor) * Math.min(1, dt * 3);
    sky.speed = ctl.bases.sky * ctl.factor;
    const fEnv = Math.pow(ctl.factor, 0.8); // les proches un peu moins que le ciel
    wind.speed = ctl.bases.wind * fEnv;
    sparkles.driftSpeed = ctl.bases.spark * fEnv;
    trails.driftSpeed = ctl.bases.trail * fEnv;
    // les ailes battent plus vite quand on accelere — leader ET copains
    const flapScale = Math.sqrt(ctl.factor);
    flap.speedScale = flapScale;
    flock.speedScale = flapScale;
  };

  return { ctl, handleHand, update };
}
