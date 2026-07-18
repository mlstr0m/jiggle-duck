import * as THREE from "three";

/**
 * Paillettes magiques, facon poussieres de lumiere de Sky : des points
 * additifs qui SCINTILLENT chacun a leur rythme (le clignotement est fait
 * dans le shader, pas sur CPU), derivent doucement vers l'arriere du vol et
 * ondulent. Recyclees dans un volume autour de la camera.
 *
 * Cout : un draw call de THREE.Points (~160 sommets), une mise a jour CPU
 * de positions triviale. Le twinkle est gratuit (uTime dans le vertex).
 */

const COUNT = 160;
const BOX = new THREE.Vector3(10, 6, 10);

export class Sparkles {
  constructor(scene, restForward) {
    this.intensity = 1.15;
    this.size = 1.85; // multiplicateur de taille
    this.driftSpeed = 3.0; // derive arriere
    this.color = new THREE.Color().setRGB(255 / 255, 196 / 255, 0 / 255); // or franc (reglage Aurelien)

    this._back = restForward.clone().normalize().multiplyScalar(-1);

    this.positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);
    const sizes = new Float32Array(COUNT);
    this.offsets = [];
    for (let i = 0; i < COUNT; i++) {
      this.offsets.push(
        new THREE.Vector3(
          (Math.random() - 0.5) * BOX.x,
          (Math.random() - 0.5) * BOX.y,
          (Math.random() - 0.5) * BOX.z,
        ),
      );
      seeds[i] = Math.random() * 100;
      sizes[i] = 0.6 + Math.random() * 1.4;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: this.intensity },
        uSize: { value: this.size },
        uColor: { value: this.color },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        attribute float aSize;
        uniform float uTime;
        uniform float uSize;
        varying float vTwinkle;
        void main() {
          // scintillement individuel : des eclats brefs, pas une pulsation
          float t = 0.5 + 0.5 * sin(uTime * (0.8 + fract(aSeed) * 2.2) + aSeed * 7.0);
          vTwinkle = pow(t, 4.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uSize * (26.0 + 30.0 * vTwinkle) / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform float uIntensity;
        uniform vec3 uColor;
        varying float vTwinkle;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p) * 2.0;
          // coeur brillant + halo doux + petite croix d'eclat
          float core = pow(max(0.0, 1.0 - d), 4.0);
          float cross = max(0.0, 1.0 - abs(p.x * p.y) * 90.0) * max(0.0, 1.0 - d);
          float glow = (core + cross * 0.55) * (0.15 + 0.85 * vTwinkle);
          gl_FragColor = vec4(uColor * glow * uIntensity, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);

    this._t = 0;
  }

  update(dt, camera) {
    this._t += dt;
    this.material.uniforms.uTime.value = this._t;
    this.material.uniforms.uIntensity.value = this.intensity;
    this.material.uniforms.uSize.value = this.size;

    const fwd = this._back; // derive arriere
    for (let i = 0; i < COUNT; i++) {
      const o = this.offsets[i];
      o.addScaledVector(fwd, this.driftSpeed * dt);
      // ondulation lente, dephasee par particule
      const bob = Math.sin(this._t * 0.6 + i * 1.7) * 0.15 * dt;
      o.y += bob;

      // recyclage dans le volume (relatif camera)
      if (o.dot(fwd) > BOX.z * 0.5) {
        o.copy(fwd).multiplyScalar(-BOX.z * 0.5);
        o.x += (Math.random() - 0.5) * BOX.x;
        o.y += (Math.random() - 0.5) * BOX.y;
      }

      const k = i * 3;
      this.positions[k] = camera.position.x + o.x;
      this.positions[k + 1] = camera.position.y + o.y;
      this.positions[k + 2] = camera.position.z + o.z;
    }
    this.geometry.attributes.position.needsUpdate = true;
  }
}
