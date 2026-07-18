import * as THREE from "three";

/**
 * Trainees de bouts d'ailes, facon Sky : des rubans blancs qui filent
 * derriere les oiseaux.
 *
 * Le point cle : les oiseaux sont quasi IMMOBILES dans la scene (c'est le
 * monde qui defile). Pour que les trainees vendent la vitesse, chaque point
 * emis derive vers l'ARRIERE a une vitesse calee sur le defilement des
 * nuages — les rubans s'etirent comme si les oiseaux traversaient le monde,
 * et se courbent quand ils manoeuvrent (comme dans les refs).
 *
 * Architecture : un gestionnaire unique (WingTrails) auquel on ATTACHE des
 * bones d'ailes — leader et copains de la volee — avec un gain par ruban
 * (le leader brille plus quand il bat des ailes, chaque copain a le sien).
 *
 * Rendu : triangle strip reconstruit chaque frame, oriente face camera,
 * feathering transversal (coeur lumineux, bords fondus), alpha et largeur en
 * fuseau. Blending additif, pas d'ecriture de profondeur.
 */

const TRAIL_POINTS = 52;

const vertexShader = /* glsl */ `
  attribute float aAlpha;
  attribute float aV; // 0 = bord gauche du ruban, 1 = bord droit
  varying float vAlpha;
  varying float vV;
  void main() {
    vAlpha = aAlpha;
    vV = aV;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision mediump float;
  uniform float uIntensity;
  varying float vAlpha;
  varying float vV;
  void main() {
    // feathering transversal : coeur lumineux, bords fondus — sans ça le
    // ruban ressemble a un rail rigide, pas a une trainee de lumiere
    float across = 1.0 - abs(vV * 2.0 - 1.0);
    across *= across;
    gl_FragColor = vec4(vec3(1.0, 0.99, 0.96) * vAlpha * across * uIntensity, 1.0);
  }
`;

class Ribbon {
  constructor(scene, material) {
    this.scene = scene;
    // Historique des points en BUFFER CIRCULAIRE plat : pas d'allocation ni
    // de decalage de tableau par frame (l'ancien unshift/pop clonait un
    // Vector3 et deplacait 52 entrees, x12 rubans, a chaque frame).
    this._pts = new Float32Array(TRAIL_POINTS * 3);
    this._head = 0; // slot du point le plus recent
    this._count = 0; // points valides (0..TRAIL_POINTS)
    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(TRAIL_POINTS * 2 * 3);
    this.alphas = new Float32Array(TRAIL_POINTS * 2);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("aAlpha", new THREE.BufferAttribute(this.alphas, 1));

    const vs = new Float32Array(TRAIL_POINTS * 2);
    for (let i = 0; i < TRAIL_POINTS; i++) vs[i * 2 + 1] = 1;
    this.geometry.setAttribute("aV", new THREE.BufferAttribute(vs, 1));

    const index = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry.setIndex(index);

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10; // apres les oiseaux, en additif
    scene.add(this.mesh);

    this._side = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._view = new THREE.Vector3();
  }

  update(emitterPos, drift, dt, camera, width, gain) {
    const pts = this._pts;

    // derive arriere de tout l'historique, in place
    const dx = drift.x * dt;
    const dy = drift.y * dt;
    const dz = drift.z * dt;
    for (let o = 0; o < pts.length; o += 3) {
      pts[o] += dx;
      pts[o + 1] += dy;
      pts[o + 2] += dz;
    }

    // nouveau point en tete du ring
    this._head = (this._head + 1) % TRAIL_POINTS;
    if (this._count < TRAIL_POINTS) this._count++;
    const ho = this._head * 3;
    pts[ho] = emitterPos.x;
    pts[ho + 1] = emitterPos.y;
    pts[ho + 2] = emitterPos.z;

    // slot du i-eme point en partant du plus recent
    const slot = (i) => ((this._head - i + TRAIL_POINTS) % TRAIL_POINTS) * 3;

    const n = this._count;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const pi = Math.min(i, n - 1);
      const oa = slot(pi);
      const ob = slot(Math.min(pi + 1, n - 1));

      this._dir.set(pts[ob] - pts[oa], pts[ob + 1] - pts[oa + 1], pts[ob + 2] - pts[oa + 2]);
      if (this._dir.lengthSq() < 1e-8) this._dir.set(0, 0, 1);
      this._view.set(
        pts[oa] - camera.position.x,
        pts[oa + 1] - camera.position.y,
        pts[oa + 2] - camera.position.z,
      );
      this._side.crossVectors(this._dir, this._view).normalize();

      const f = i / (TRAIL_POINTS - 1); // 0 = aile, 1 = queue du ruban
      const w = width * (0.55 + f * 0.9);
      const alpha = (1.0 - f) * (1.0 - f) * (i < n ? 1 : 0) * gain;

      const o = i * 6;
      this.positions[o] = pts[oa] + this._side.x * w;
      this.positions[o + 1] = pts[oa + 1] + this._side.y * w;
      this.positions[o + 2] = pts[oa + 2] + this._side.z * w;
      this.positions[o + 3] = pts[oa] - this._side.x * w;
      this.positions[o + 4] = pts[oa + 1] - this._side.y * w;
      this.positions[o + 5] = pts[oa + 2] - this._side.z * w;
      this.alphas[i * 2] = alpha;
      this.alphas[i * 2 + 1] = alpha;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
  }
}

export class WingTrails {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Vector3} restForward Cap du vol (pour la derive arriere).
   */
  constructor(scene, restForward) {
    this.scene = scene;
    this.intensity = 0.3; // master (reglage Aurelien)
    this.width = 0.012;
    this.driftSpeed = 2.4; // vitesse de fuite vers l'arriere (unites/s)

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uIntensity: { value: 1 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this._drift = restForward.clone().normalize().multiplyScalar(-1);
    this._pos = new THREE.Vector3();
    this._driftV = new THREE.Vector3();

    /** @type {Array<{bone:THREE.Bone, local:THREE.Vector3, gain:number, ribbon:Ribbon}>} */
    this.entries = [];
  }

  /**
   * Attache un ruban a un bone d'aile. `gain` module l'alpha de CE ruban
   * (reglable a chaud via le handle retourne).
   */
  attach(bone, gain = 1) {
    const entry = {
      bone,
      local: new THREE.Vector3(0, 0.09, 0), // bout visuel de l'aile
      gain,
      ribbon: new Ribbon(this.scene, this.material),
    };
    this.entries.push(entry);
    return entry;
  }

  remove(entry) {
    const i = this.entries.indexOf(entry);
    if (i >= 0) {
      entry.ribbon.dispose();
      this.entries.splice(i, 1);
    }
  }

  update(dt, camera) {
    this.material.uniforms.uIntensity.value = this.intensity;
    this._driftV.set(this._drift.x * this.driftSpeed, 0, this._drift.z * this.driftSpeed);

    for (const e of this.entries) {
      // pas de clone ici : le ribbon copie le point pour son historique
      e.bone.localToWorld(this._pos.copy(e.local));
      e.ribbon.update(this._pos, this._driftV, dt, camera, this.width, e.gain);
    }
  }
}
