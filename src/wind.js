import * as THREE from "three";

/**
 * Particules de vent : les traits blancs etires qui filent devant la camera
 * (reference Sky). C'est l'effet au meilleur ratio sensation-de-vitesse /
 * cout de tout le projet : un seul LineSegments additif, ~90 segments dont
 * les positions sont recyclees en boucle dans un volume autour de la camera.
 * Cout : un draw call, ~200 sommets, mise a jour CPU negligeable.
 */

const COUNT = 90;
const BOX = new THREE.Vector3(9, 5, 9); // volume de recyclage autour de la camera

export class WindStreaks {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Vector3} restForward Cap du vol (les traits filent a l'oppose).
   */
  constructor(scene, restForward) {
    this.intensity = 1.0; // opacite globale (reglage Aurelien)
    this.speed = 3.4; // unites/s — cale sur la vitesse apparente des nuages
    this.length = 0.65; // longueur des traits (s'etire avec la vitesse)

    this._fwd = restForward.clone().normalize();
    this._back = this._fwd.clone().multiplyScalar(-1);

    this.positions = new Float32Array(COUNT * 2 * 3);
    this.alphas = new Float32Array(COUNT * 2);
    // alpha de BASE par trait (profondeur percue) : l'alpha effectif est
    // base x enveloppe de bord, recalcule chaque frame dans update()
    this._baseAlpha = new Float32Array(COUNT);
    this.heads = [];
    for (let i = 0; i < COUNT; i++) {
      this.heads.push(
        new THREE.Vector3(
          (Math.random() - 0.5) * BOX.x,
          (Math.random() - 0.5) * BOX.y,
          (Math.random() - 0.5) * BOX.z,
        ),
      );
      this._baseAlpha[i] = 0.35 + Math.random() * 0.65;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("aAlpha", new THREE.BufferAttribute(this.alphas, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: { uIntensity: { value: this.intensity } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform float uIntensity;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(vec3(1.0) * vAlpha * uIntensity, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
    scene.add(this.lines);

    this._tmp = new THREE.Vector3();
  }

  update(dt, camera) {
    this.material.uniforms.uIntensity.value = this.intensity;
    const drift = this.speed * dt;
    const len = this.length * (0.6 + this.speed * 0.12);

    for (let i = 0; i < COUNT; i++) {
      const h = this.heads[i];
      // les traits filent vers l'arriere du vol
      h.addScaledVector(this._back, drift);

      // recyclage : sorti du volume (relatif camera) -> reapparait devant
      let along = h.dot(this._fwd); // h est deja relatif a la camera
      if (along < -BOX.z * 0.5) {
        h.copy(this._fwd).multiplyScalar(BOX.z * 0.5);
        h.x += (Math.random() - 0.5) * BOX.x;
        h.y += (Math.random() - 0.5) * BOX.y;
        h.addScaledVector(this._fwd, Math.random() * 2);
        along = h.dot(this._fwd);
      }

      // Enveloppe de bord : la camera regarde vers l'ARRIERE du vol, donc le
      // plan de recyclage traverse son champ — sans fondu, les traits
      // disparaissaient d'un coup en plein ecran (bug constate). L'alpha
      // s'eteint sur ~1.5 unite avant la frontiere et se rallume apres le
      // respawn : le trait nait et meurt invisible.
      const edge = BOX.z * 0.5;
      const fadeOut = Math.min(1, Math.max(0, (along + edge) / 1.5));
      const fadeIn = Math.min(1, Math.max(0, (edge + 2.2 - along) / 1.5));
      const env = fadeOut * fadeIn;
      const a = this._baseAlpha[i] * env;
      this.alphas[i * 2] = a;
      this.alphas[i * 2 + 1] = a * 0.15; // queue presque eteinte

      // segment monde = position camera + offset ; queue etiree vers l'avant
      const o = i * 6;
      const cx = camera.position.x + h.x;
      const cy = camera.position.y + h.y;
      const cz = camera.position.z + h.z;
      this.positions[o] = cx;
      this.positions[o + 1] = cy;
      this.positions[o + 2] = cz;
      this.positions[o + 3] = cx + this._fwd.x * len;
      this.positions[o + 4] = cy + this._fwd.y * len;
      this.positions[o + 5] = cz + this._fwd.z * len;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }
}
