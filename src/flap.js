import * as THREE from "three";

/**
 * Battement d'ailes PERMANENT du leader (croisiere), module par la vitesse
 * de vol et le boost de vrille.
 *
 * Principe : une enveloppe 0..1 (croisiere constante, boost par-dessus
 * pendant la vrille) module l'amplitude d'une oscillation sinusoidale
 * appliquee aux RACINES des chaines d'ailes. C'est exactement le modele de
 * la lib wiggle — les bones statiques sont faits pour etre pilotes a la
 * main — et les bouts d'ailes suivent via leurs springs, ce qui donne la
 * souplesse du battement sans rien coder de plus.
 *
 * L'axe de battement n'est PAS code en dur : l'orientation locale des bones
 * est arbitraire apres l'export glTF (la convention Blender disparait). On
 * calibre a l'init : on essaie les trois axes locaux, on mesure lequel fait
 * monter le bout d'aile en coordonnees monde, on garde axe + signe. Robuste a
 * un reexport ou un renommage du rig.
 */
export class FlapController {
  constructor(duck) {
    this.duck = duck;

    // Reglages exposes au panneau.
    this.amplitude = 0.7; // rad, bras de levier du battement a enveloppe pleine
    this.frequency = 2.4; // Hz de base -> ~2.65 Hz effectifs, comme la volee

    /**
     * Croisiere PERMANENTE : le leader bat des ailes tout le temps, calibre
     * sur le battement des copains de la migration (amp effective ~0.5 rad,
     * ~2.6 Hz). La 2e main ne pilote plus les ailes — elle pilote la vitesse.
     */
    this.cruise = 0.72;
    /** Surcouche boost (poing ferme -> vrille) : 0..1, pousse par main.js. */
    this.boost = 0;
    /** Multiplicateur de cadence pilote par la vitesse de vol (main.js). */
    this.speedScale = 1;

    /** Enveloppe 0..1 : 0 = ailes au repos, 1 = battement plein. */
    this.envelope = 0;
    this._phase = 0;

    /** @type {Array<{root:THREE.Bone, rest:THREE.Quaternion, axis:THREE.Vector3, sign:number}>} */
    this.wings = [];

    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  /**
   * Calibre l'axe de battement de chaque aile. A appeler quand le canard est
   * dans la scene, matrices monde a jour, wiggle deja monte (les wrappers de
   * la lib changent la hierarchie — on calibre dans l'etat reel).
   */
  init() {
    const wingChains = this.duck.chains.filter((c) => c.label.startsWith("Aile"));

    for (const chain of wingChains) {
      const root = chain.root;
      const tip = chain.dynamic[0] ?? root;
      const rest = root.quaternion.clone();

      root.updateWorldMatrix(true, true);
      const baseY = tip.getWorldPosition(this._v).y;

      let best = null;
      for (const axis of [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1),
      ]) {
        this._q.setFromAxisAngle(axis, 0.4);
        root.quaternion.copy(rest).multiply(this._q);
        root.updateWorldMatrix(false, true);
        const dy = tip.getWorldPosition(this._v).y - baseY;
        if (!best || Math.abs(dy) > Math.abs(best.dy)) best = { axis, dy };
      }

      // restauration stricte de la rest pose
      root.quaternion.copy(rest);
      root.updateWorldMatrix(false, true);

      this.wings.push({
        root,
        rest,
        axis: best.axis,
        sign: best.dy > 0 ? 1 : -1, // +theta = aile qui MONTE, pour les deux ailes
        label: chain.label,
      });
    }
    return this.wings.map(
      (w) =>
        `${w.label}: axe ${["x", "y", "z"][["x", "y", "z"].findIndex((_, i) => w.axis.getComponent(i) === 1)]}${w.sign > 0 ? "+" : "-"}`,
    );
  }

  update(dt) {
    // Enveloppe : croisiere constante, le boost vient par-dessus.
    const target = Math.min(1, Math.max(this.cruise, this.boost));
    const rate = target > this.envelope ? 1 - Math.exp(-dt / 0.1) : 1 - Math.exp(-dt / 0.45);
    this.envelope += (target - this.envelope) * rate;

    if (this.envelope < 1e-3 && this.wings.every((w) => w.root.quaternion.equals(w.rest))) return;

    // La cadence accelere un peu avec l'intensite : bat plus vite quand on
    // agite fort, ce qui se lit immediatement comme "il vole plus fort".
    this._phase +=
      dt * this.frequency * Math.PI * 2 * (0.75 + 0.5 * this.envelope) * this.speedScale;

    // Posture relevee + oscillation : en vol les ailes travaillent au-dessus
    // de l'horizontale, pas centrees sur la rest pose.
    const theta = this.envelope * this.amplitude * (0.35 + Math.sin(this._phase));

    for (const w of this.wings) {
      this._q.setFromAxisAngle(w.axis, w.sign * theta);
      w.root.quaternion.copy(w.rest).multiply(this._q);
    }
  }

  reset() {
    this.envelope = 0;
    for (const w of this.wings) w.root.quaternion.copy(w.rest);
  }
}
