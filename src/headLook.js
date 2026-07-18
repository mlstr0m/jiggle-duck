import * as THREE from "three";

/**
 * Regards : les oiseaux tournent la tete de temps en temps, comme s'ils
 * observaient le paysage ou leurs voisins. Vie secondaire pure — aucun
 * gameplay, juste ce petit truc qui rend une volee vivante.
 *
 * On pilote la RACINE du cou (statique, comme les racines d'ailes pour le
 * battement) : la tete wigglée suit avec son ressort, ce qui donne un
 * mouvement organique gratuit. Machine a etats par oiseau : attente ->
 * regard (smoothstep) -> tenue -> parfois un autre regard, sinon retour au
 * neutre -> attente. Tout est desynchronise par du hasard.
 *
 * Meme contrainte que les ailes : l'orientation locale des bones est
 * arbitraire apres l'export glTF. On calibre par oiseau : l'axe local qui
 * deplace le plus le bout du cou a l'HORIZONTALE monde = lacet (regard
 * lateral), celui qui le deplace le plus a la VERTICALE = inclinaison.
 */

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

export class HeadLook {
  constructor() {
    this.amount = 1; // echelle des regards (0 = fige)
    this.interval = 1; // multiplicateur du temps entre deux regards

    /** @type {Array<object>} */
    this.entries = [];
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  /**
   * @param {THREE.Bone} neck Racine du cou (non wigglée).
   * @param {THREE.Object3D} tip Bout du cou/tete, pour la calibration.
   */
  attach(neck, tip) {
    const rest = neck.quaternion.clone();
    neck.updateWorldMatrix(true, true);
    const base = tip.getWorldPosition(new THREE.Vector3());

    // deux passes : d'abord les scores des trois axes, PUIS le choix — le
    // lacet prend le meilleur horizontal, l'inclinaison le meilleur vertical
    // parmi les deux axes restants
    const scores = AXES.map((axis) => {
      this._q.setFromAxisAngle(axis, 0.35);
      neck.quaternion.copy(rest).multiply(this._q);
      neck.updateWorldMatrix(false, true);
      const d = tip.getWorldPosition(this._v).sub(base);
      return { axis, horiz: Math.hypot(d.x, d.z), vert: Math.abs(d.y) };
    });
    neck.quaternion.copy(rest);
    neck.updateWorldMatrix(false, true);
    const yaw = scores.reduce((a, b) => (b.horiz > a.horiz ? b : a));
    const tilt = scores.filter((s) => s !== yaw).reduce((a, b) => (b.vert > a.vert ? b : a));

    const entry = {
      neck,
      rest,
      yawAxis: yaw.axis.clone(),
      tiltAxis: tilt.axis.clone(),
      mode: "wait",
      t: 1 + Math.random() * 4, // premier regard vite : ca vit des l'arrivee
      dur: 0.5,
      from: { y: 0, p: 0 },
      to: { y: 0, p: 0 },
      cur: { y: 0, p: 0 },
    };
    this.entries.push(entry);
    return entry;
  }

  remove(entry) {
    const i = this.entries.indexOf(entry);
    if (i >= 0) {
      entry.neck.quaternion.copy(entry.rest);
      this.entries.splice(i, 1);
    }
  }

  _startMove(e, toY, toP) {
    e.from = { ...e.cur };
    e.to = { y: toY, p: toP };
    e.dur = 0.45 + Math.random() * 0.5;
    e.t = e.dur;
  }

  update(dt) {
    for (const e of this.entries) {
      e.t -= dt;
      if (e.t <= 0) {
        if (e.mode === "wait") {
          // regard lateral franc + legere inclinaison : "tiens, quoi la-bas ?"
          this._startMove(e, (Math.random() * 2 - 1) * 0.55, (Math.random() * 2 - 1) * 0.18);
          e.mode = "turn";
        } else if (e.mode === "turn") {
          e.mode = "hold";
          e.t = 0.7 + Math.random() * 1.8;
        } else if (e.mode === "hold") {
          if (Math.random() < 0.35) {
            // enchaine un autre regard sans repasser par le neutre
            this._startMove(e, (Math.random() * 2 - 1) * 0.55, (Math.random() * 2 - 1) * 0.18);
            e.mode = "turn";
          } else {
            this._startMove(e, 0, 0);
            e.mode = "return";
          }
        } else {
          // return acheve : tete au neutre, on attend le prochain regard
          e.mode = "wait";
          e.t = (2.5 + Math.random() * 5) * this.interval;
        }
      }

      if (e.mode === "turn" || e.mode === "return") {
        const k = 1 - Math.max(0, e.t / e.dur);
        const s = k * k * (3 - 2 * k); // smoothstep : depart et arret doux
        e.cur.y = e.from.y + (e.to.y - e.from.y) * s;
        e.cur.p = e.from.p + (e.to.p - e.from.p) * s;
      }

      this._q.setFromAxisAngle(e.yawAxis, e.cur.y * this.amount);
      this._q2.setFromAxisAngle(e.tiltAxis, e.cur.p * this.amount);
      e.neck.quaternion.copy(e.rest).multiply(this._q).multiply(this._q2);
    }
  }
}
