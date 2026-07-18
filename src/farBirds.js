import * as THREE from "three";

/**
 * Volees lointaines : des silhouettes minuscules qui traversent le fond en
 * battant des ailes — les migrations d'arriere-plan des references Sky.
 * Elles remplissent le ciel sans jamais voler la vedette au premier plan.
 *
 * Cout : UN draw call pour toutes les volees. Chaque oiseau est deux
 * triangles (deux ailes) billboardes face camera dans le vertex shader, et
 * le battement est un sin() par sommet — zero travail CPU par oiseau, le
 * CPU ne deplace que les centres de volees (3 vecteurs par frame).
 *
 * Les volees traversent lateralement le fond (25-40 unites derriere le
 * canard), chacune a sa hauteur, sa profondeur, sa vitesse et sa cadence.
 * Sorties du champ, elles respawnent de l'autre cote apres une pause
 * aleatoire — le ciel vit par vagues, pas en continu.
 */

const FLOCKS = 3;
const BIRDS = 7; // oiseaux par volee
const VERTS_PER_BIRD = 6; // 2 triangles

export class FarBirds {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Vector3} restForward Cap du vol du leader (monde).
   */
  constructor(scene, restForward) {
    this.opacity = 0.5; // discretion des silhouettes
    this.size = 1; // echelle globale
    this.speed = 1; // multiplicateur de vitesse de traversee

    this._fwd = restForward.clone().normalize();
    this._side = new THREE.Vector3(-this._fwd.z, 0, this._fwd.x);

    // — geometrie : slots en V par volee, ailes en triangles ————
    const count = FLOCKS * BIRDS * VERTS_PER_BIRD;
    const corners = new Float32Array(count * 2); // offset local du sommet
    const slots = new Float32Array(count * 2); // position de l'oiseau dans le V
    const wings = new Float32Array(count); // |1| = bout d'aile (ca bat), 0 = corps
    const phases = new Float32Array(count); // dephasage du battement
    const flockIdx = new Float32Array(count);

    // une aile = triangle (corps arriere, corps avant, bout d'aile)
    const WING = [
      // gauche : x negatif au bout
      [
        [0, -0.16, 0],
        [0, 0.16, 0],
        [-1.0, 0.1, 1],
      ],
      // droite
      [
        [0, -0.16, 0],
        [0, 0.16, 0],
        [1.0, 0.1, 1],
      ],
    ];

    let v = 0;
    for (let f = 0; f < FLOCKS; f++) {
      for (let b = 0; b < BIRDS; b++) {
        // V de la volee, dans le plan facial (assez loin pour que l'a-plat
        // ne se voie pas) + jitter fige
        const row = Math.ceil(b / 2);
        const side = b === 0 ? 0 : b % 2 === 1 ? 1 : -1;
        const sx = side * row * 1.5 + (Math.random() - 0.5) * 0.5;
        const sy = -row * 0.55 + (Math.random() - 0.5) * 0.45;
        const phase = Math.random() * Math.PI * 2;
        for (const tri of WING) {
          for (const [cx, cy, wing] of tri) {
            corners[v * 2] = cx;
            corners[v * 2 + 1] = cy;
            slots[v * 2] = sx;
            slots[v * 2 + 1] = sy;
            wings[v] = wing;
            phases[v] = phase;
            flockIdx[v] = f;
            v++;
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    // position requise par three mais inutilisee (tout se fait en shader)
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute("aCorner", new THREE.BufferAttribute(corners, 2));
    geo.setAttribute("aSlot", new THREE.BufferAttribute(slots, 2));
    geo.setAttribute("aWing", new THREE.BufferAttribute(wings, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("aFlock", new THREE.BufferAttribute(flockIdx, 1));

    this.uniforms = {
      uTime: { value: 0 },
      uOpacity: { value: this.opacity },
      uSize: { value: this.size },
      // xyz = centre de la volee (monde), w = echelle propre de la volee
      uFlocks: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      // teinte : blanc fondu vers l'horizon selon la profondeur de la volee
      uTints: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
      uFlapFreq: { value: new THREE.Vector3(2.2, 2.6, 3.0) },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec2 aCorner;
        attribute vec2 aSlot;
        attribute float aWing;
        attribute float aPhase;
        attribute float aFlock;
        uniform float uTime;
        uniform float uSize;
        uniform vec4 uFlocks[${FLOCKS}];
        uniform vec3 uFlapFreq;
        varying float vFlock;
        void main() {
          vFlock = aFlock;
          int fi = int(aFlock + 0.5);
          vec4 F = uFlocks[fi];
          // axes billboard : colonnes de la view matrix
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          // battement : le bout d'aile monte/descend, le corps reste
          float freq = fi == 0 ? uFlapFreq.x : (fi == 1 ? uFlapFreq.y : uFlapFreq.z);
          float flap = aWing * sin(uTime * freq * 6.2831 + aPhase) * 0.55;
          float s = F.w * uSize;
          vec3 world = F.xyz
            + (right * aSlot.x + up * aSlot.y) * s * 2.0
            + (right * aCorner.x + up * (aCorner.y + flap)) * s;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform vec3 uTints[${FLOCKS}];
        uniform float uOpacity;
        varying float vFlock;
        void main() {
          int fi = int(vFlock + 0.5);
          gl_FragColor = vec4(uTints[fi], uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false; // 126 sommets : le test couterait plus cher
    this.mesh.renderOrder = 2; // au-dessus du fond ciel, sous les oiseaux proches
    scene.add(this.mesh);

    // — etat par volee : trajectoire + respawn ————————
    /** @type {Array<{dir:number, x:number, depth:number, height:number, vel:number, scale:number, wait:number}>} */
    this._flocks = [];
    for (let i = 0; i < FLOCKS; i++) this._flocks.push(this._spawn(i * 14)); // etalees au depart

    this._t = 0;
    this._v = new THREE.Vector3();
  }

  _spawn(startOffset = 0) {
    const depth = 22 + Math.random() * 16; // derriere le canard
    return {
      dir: Math.random() < 0.5 ? 1 : -1,
      x: -34 - startOffset, // abscisse le long de _side (signe applique par dir)
      depth,
      height: 0.8 + Math.random() * 2.4,
      vel: (0.55 + Math.random() * 0.5) * (depth / 30), // parallaxe : loin = lent
      scale: 0.05 + Math.random() * 0.05,
      wait: startOffset === 0 ? 4 + Math.random() * 14 : 0, // pause avant d'entrer
    };
  }

  /**
   * @param {number} dt
   * @param {THREE.Color} horizonColor Couleur d'horizon du ciel (brume).
   */
  update(dt, horizonColor) {
    this._t += dt;
    this.uniforms.uTime.value = this._t;
    this.uniforms.uOpacity.value = this.opacity;
    this.uniforms.uSize.value = this.size;

    for (let i = 0; i < FLOCKS; i++) {
      const f = this._flocks[i];
      if (f.wait > 0) {
        f.wait -= dt;
        // gare hors champ pendant la pause
        this.uniforms.uFlocks.value[i].set(0, -100, 0, f.scale);
        continue;
      }
      // traversee LENTE (30-60 s de bord a bord) : une migration lointaine
      // se devine, elle ne file pas comme une etoile filante
      f.x += f.vel * this.speed * dt * 2;
      if (f.x > 34) this._flocks[i] = this._spawn();

      const wx = f.x * f.dir;
      this._v
        .copy(this._fwd)
        .multiplyScalar(-f.depth)
        .addScaledVector(this._side, wx)
        .setY(f.height);
      this.uniforms.uFlocks.value[i].set(this._v.x, this._v.y, this._v.z, f.scale);

      // brume : plus la volee est loin, plus elle fond dans l'horizon
      const fogK = Math.min(1, (f.depth - 18) / 24);
      this.uniforms.uTints.value[i].setRGB(1, 1, 1).lerp(horizonColor, 0.35 + fogK * 0.45);
    }
  }
}
