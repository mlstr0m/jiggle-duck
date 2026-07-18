import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/**
 * Grading final + vignettage — LE levier "aspect fini" des jeux.
 *
 * S'execute APRES l'OutputPass (donc en espace d'affichage sRGB, la ou se
 * font les LUTs de grading en production) : contraste doux, saturation,
 * teinte des ombres (la signature Sky : ombres qui tirent vers le
 * bleu-lavande au lieu du gris), et vignettage discret qui concentre le
 * regard sur le canard. Cout : une passe fullscreen triviale (~0.2 ms).
 */

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uContrast: { value: 1.22 },
    uSaturation: { value: 1.07 },
    uBrightness: { value: 0.01 },
    uShadowTint: { value: new THREE.Color().setRGB(52 / 255, 0 / 255, 194 / 255) },
    uShadowTintAmt: { value: 0.1 },
    uVignette: { value: 0.8 },
    // iris d'ouverture : 0 = noir, 1 = tout ouvert. Anime au demarrage de
    // l'experience (la "fenetre qui se repand" sur le ciel).
    uReveal: { value: 1.0 },
    uAspect: { value: 1.0 },
    // dithering : casse les bandes de quantification 8 bits dans les
    // degrades doux (ciel !) — standard AAA, invisible a l'oeil
    uDither: { value: 1.2 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uBrightness;
    uniform vec3 uShadowTint;
    uniform float uShadowTintAmt;
    uniform float uVignette;
    uniform float uReveal;
    uniform float uAspect;
    uniform float uDither;
    varying vec2 vUv;

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      // contraste pivote sur le gris moyen + luminosite
      c = (c - 0.5) * uContrast + 0.5 + uBrightness;

      // teinte des ombres : plus le pixel est sombre, plus il tire vers la
      // teinte (les noirs purs deviennent des bleus profonds, facon Sky)
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      float shadowMask = 1.0 - smoothstep(0.0, 0.55, lum);
      c = mix(c, uShadowTint * (0.35 + lum), shadowMask * uShadowTintAmt * 3.0);

      // saturation
      lum = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(lum), c, uSaturation);

      // vignettage doux
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - uVignette * smoothstep(0.35, 0.85, d);

      // iris d'ouverture : un cercle au bord organique (ondule) qui se
      // repand depuis le centre et revele le ciel
      if (uReveal < 1.0) {
        vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
        float ang = atan(p.y, p.x);
        float wobble = 0.045 * sin(ang * 7.0 + uReveal * 9.0)
                     + 0.03 * sin(ang * 13.0 - uReveal * 6.0);
        float radius = uReveal * uReveal * (1.1 + 0.2 * uAspect) + wobble * uReveal;
        float mask = smoothstep(radius - 0.09, radius, length(p)); // noir DEHORS, ciel au centre
        c = mix(c, vec3(0.078, 0.086, 0.102), mask);
      }

      // interleaved gradient noise (Jimenez) : mieux distribue que du bruit
      // blanc, applique en DERNIER — juste avant la quantification 8 bits
      float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      c += (ign - 0.5) * (uDither / 255.0);

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

export function createGradePass() {
  return new ShaderPass(GradeShader);
}
