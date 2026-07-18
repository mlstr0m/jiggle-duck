/**
 * Filtre One Euro (Casiez et al., 2012).
 *
 * Pourquoi pas un simple lerp : un lerp applique le meme lissage quelle que
 * soit la vitesse. Resultat, soit ça tremble a l'arret, soit ça traine quand
 * on bouge vite — on ne peut pas avoir les deux.
 *
 * One Euro adapte sa coupure a la vitesse du signal : tres lisse quand la main
 * est immobile (on tue le jitter MediaPipe), tres reactif quand elle bouge
 * (on tue le lag). C'est ce qui fait la difference entre "ça marche" et
 * "c'est agreable".
 */

class LowPass {
  constructor() {
    this.y = null;
    this.s = null;
  }

  filter(value, alpha) {
    this.s = this.y === null ? value : alpha * value + (1 - alpha) * this.s;
    this.y = value;
    return this.s;
  }

  reset() {
    this.y = null;
    this.s = null;
  }
}

export class OneEuroFilter {
  /**
   * @param {number} minCutoff  Coupure au repos. Plus bas = plus lisse, plus de lag.
   * @param {number} beta       Reactivite a la vitesse. Plus haut = moins de lag en mouvement.
   * @param {number} dCutoff    Coupure de l'estimation de vitesse. 1.0 convient presque toujours.
   */
  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.lastTime = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, timestamp = performance.now() / 1000) {
    let dt = 1 / 60;
    if (this.lastTime !== null) {
      const delta = timestamp - this.lastTime;
      // Garde-fou : un onglet en arriere-plan produit des dt absurdes.
      if (delta > 0 && delta < 1) dt = delta;
    }
    this.lastTime = timestamp;

    const prev = this.x.y;
    const derivative = prev === null ? 0 : (value - prev) / dt;
    const edx = this.dx.filter(derivative, OneEuroFilter.alpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }

  reset() {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
  }
}

/** Applique un One Euro independant sur chaque composante d'un vecteur. */
export class OneEuroVec {
  constructor(size, options) {
    this.filters = Array.from({ length: size }, () => new OneEuroFilter(options));
  }

  filter(values, timestamp) {
    return values.map((v, i) => this.filters[i].filter(v, timestamp));
  }

  setParams({ minCutoff, beta }) {
    for (const f of this.filters) {
      if (minCutoff !== undefined) f.minCutoff = minCutoff;
      if (beta !== undefined) f.beta = beta;
    }
  }

  reset() {
    for (const f of this.filters) f.reset();
  }
}
