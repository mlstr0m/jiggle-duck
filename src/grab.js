import * as THREE from "three";

/**
 * Attraper et deplacer le canard au pincement.
 *
 * Deux idees :
 *
 * 1. PROFONDEUR. Elle ne vient PAS de MediaPipe : le `z` des landmarks est
 *    relatif au poignet, mal calibre et bruite. On projette le drag sur un plan
 *    parallele au plan image passant par le point d'accroche — l'objet reste
 *    exactement a la profondeur ou on l'a saisi.
 *
 * 2. RESSORT, PAS LERP. Le corps suit la main via un ressort amorti integre a
 *    chaque frame. Contrairement a un lerp (qui converge sans jamais depasser),
 *    un ressort sous-amorti overshoote et rebondit : c'est ce qui donne du
 *    poids et de la vie au corps. En bonus, l'inclinaison du corps est pilotee
 *    par la vitesse (il "se penche" dans le mouvement), ce qui alimente les
 *    wiggle bones des membres en rotation, pas seulement en translation.
 */
export class GrabController {
  constructor(camera, target, mesh) {
    this.camera = camera;
    this.target = target; // l'objet qu'on deplace (root du canard)
    this.mesh = mesh; // la geometrie testee au raycast

    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane();
    this.hitPoint = new THREE.Vector3();
    this.grabOffset = new THREE.Vector3();
    this.isHolding = false;

    // — Parametres du ressort (exposes dans le panneau) —
    // ratio d'amortissement = damping / (2*sqrt(stiffness)) ; en dessous de 1
    // ça rebondit. 130/2·sqrt(130)≈0.53 : nettement bouncy sans etre elastique.
    this.stiffness = 130;
    this.damping = 12;
    this.tilt = 0.9; // inclinaison par unite de vitesse ; 0 = desactive
    this.rollGain = 1.0; // roll de la main -> roll du canard ; 0 = desactive

    // — Roll de la main —
    // Applique en DELTA depuis la prise : c'est l'ecart de rotation depuis le
    // moment ou on attrape qui penche le canard, pas l'angle absolu de la main
    // (sinon le canard sauterait a la saisie). Au lacher, il revient a plat.
    this._handRoll = 0; // dernier roll connu de la main (radians)
    this._rollStart = 0; // roll de la main au moment de la prise
    this._roll = 0; // roll effectivement applique, lisse
    /** Roll additionnel pilote par la vrille boost (radians, anime par main.js). */
    this.extraRoll = 0;

    /**
     * API publique du ressort : `desired` est la cible courante (l'exterieur
     * peut l'ecrire — vie au repos, intro, prise d'avance), `velocity` la
     * vitesse integree (pour les impulsions). Prefere setDesired()/addImpulse()
     * pour les ecritures ponctuelles.
     */
    this.desired = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this._accel = new THREE.Vector3();
    this._ndc = new THREE.Vector2();
    this._normal = new THREE.Vector3();
    this._point = new THREE.Vector3();
    this._tiltEuler = new THREE.Euler();
    this._baseQuat = new THREE.Quaternion();
    this._tiltQuat = new THREE.Quaternion();

    this.desiredInit = false;
  }

  /** @returns {boolean} true si le canard a bien ete attrape. */
  tryGrab(ndcX, ndcY) {
    // SkinnedMesh.raycast teste d'abord `mesh.boundingSphere`, calcule UNE fois
    // au premier raycast puis jamais rafraichie (three r180). Si ce premier
    // raycast tombe pendant l'init transitoire des springs, la sphere en cache
    // est fausse et toutes les prises suivantes ratent. On recalcule donc
    // matrices + sphere a chaque tentative : une prise est un evenement rare,
    // ~1 ms pour 6.8k verts, et ça rend aussi le raycast correct sur la pose
    // deformee courante (attraper une aile en plein wiggle).
    this.camera.updateMatrixWorld();
    this.mesh.updateWorldMatrix(true, false);
    this.mesh.computeBoundingSphere();

    this._ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this._ndc, this.camera);

    const hits = this.raycaster.intersectObject(this.mesh, true);
    if (hits.length === 0) return false;

    this.hitPoint.copy(hits[0].point);

    // Plan face camera passant par le point touche.
    this.camera.getWorldDirection(this._normal);
    this.plane.setFromNormalAndCoplanarPoint(this._normal, this.hitPoint);

    // Ecart entre l'origine de l'objet et le point saisi, sinon le canard se
    // teleporte pour centrer son pivot sous le curseur.
    this.grabOffset.copy(this.target.position).sub(this.hitPoint);

    this.desired.copy(this.target.position);
    this.desiredInit = true;
    this._rollStart = this._handRoll;
    // La velocite n'est PAS remise a zero : si on rattrape le canard en plein
    // rebond, le mouvement reste continu.
    this.isHolding = true;
    return true;
  }

  /** Dernier roll de main connu (radians), a pousser chaque frame de tracking. */
  setHandRoll(roll) {
    this._handRoll = roll;
  }

  move(ndcX, ndcY) {
    if (!this.isHolding) return;

    this._ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this._ndc, this.camera);

    if (!this.raycaster.ray.intersectPlane(this.plane, this._point)) return;
    this.desired.copy(this._point).add(this.grabOffset);
  }

  /** Fixe la cible du ressort et la marque initialisee (intro, teleports). */
  setDesired(pos) {
    this.desired.copy(pos);
    this._desiredInit = true;
  }

  /** Impulsion instantanee sur la vitesse du corps (vrille boost). */
  addImpulse(dir, amount) {
    this.velocity.addScaledVector(dir, amount);
  }

  release() {
    this.isHolding = false;
    // `desired` reste au point de lacher : le ressort finit d'y osciller,
    // ce qui donne un petit rebond de "pose" gratuit.
  }

  /**
   * Integration du ressort — a appeler chaque frame, tenu ou non.
   * Semi-implicite (Euler symplectique), stable aux raideurs qu'on utilise.
   */
  update(dt) {
    if (!this.desiredInit) {
      this.desired.copy(this.target.position);
      this.desiredInit = true;
    }

    // Sous-pas fixes : a 20 fps un seul pas d'Euler avec k=400 divergerait.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this._accel
        .copy(this.desired)
        .sub(this.target.position)
        .multiplyScalar(this.stiffness)
        .addScaledVector(this.velocity, -this.damping);
      this.velocity.addScaledVector(this._accel, h);
      this.target.position.addScaledVector(this.velocity, h);
    }

    // Roll de la main : delta depuis la prise quand on tient, retour a plat
    // sinon. Lisse pour absorber le jitter residuel du tracking.
    const targetRoll = this.isHolding
      ? Math.max(-1.8, Math.min(1.8, (this._handRoll - this._rollStart) * this.rollGain))
      : 0;
    this._roll += (targetRoll - this._roll) * Math.min(1, dt * 12);

    // Inclinaison (vitesse) + roll (main) composes dans la MEME cible de
    // quaternion : deux slerps concurrents se voleraient la rotation.
    // Signe du roll : main penchee a droite (roll > 0) = canard penche a
    // droite a l'ecran = rotation z negative (z pointe vers la camera).
    const v = this.velocity;
    const clamp = (x) => Math.max(-0.5, Math.min(0.5, x));
    this._tiltEuler.set(
      clamp(v.y * this.tilt) * 0.6,
      0,
      // signe INVERSE a la demande d'Aurelien : main tournee a gauche =
      // canard penche a gauche (mapping direct, pas miroir)
      clamp(-v.x * this.tilt) + this._roll + this.extraRoll,
    );
    this._tiltQuat.setFromEuler(this._tiltEuler);
    // slerp vers la cible pour eviter tout claquement
    this.target.quaternion.slerp(this._tiltQuat.premultiply(this._baseQuat), Math.min(1, dt * 10));
  }

  /** Rayon courant, pour positionner le curseur 3D meme sans prise. */
  cursorPosition(ndcX, ndcY, out = new THREE.Vector3(), distance = 0.9) {
    this._ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this._ndc, this.camera);

    if (this.isHolding && this.raycaster.ray.intersectPlane(this.plane, out)) return out;
    return this.raycaster.ray.at(distance, out);
  }
}
