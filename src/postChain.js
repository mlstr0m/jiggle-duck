import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import { LUTPass } from "three/examples/jsm/postprocessing/LUTPass.js";
import { LUTCubeLoader } from "three/examples/jsm/loaders/LUTCubeLoader.js";
import { createGradePass } from "./grading.js";

/**
 * Chaine de rendu complete : fond ciel en basse resolution + post-processing.
 *
 * - Le ciel volumetrique est rendu dans SA scene vers un render target a
 *   fraction de resolution (skyRes.scale), puis affiche en fond de la scene
 *   principale par un triangle plein ecran (pas de quad : pas de couture).
 *   Raymarcher a pleine resolution DPR 2 est ce qui faisait ramer ; les
 *   nuages sont doux, un rendu a ~1/3 upscale est visuellement identique
 *   pour ~10x moins de travail GPU. C'est ce que font les jeux (Sky compris).
 *
 * - Post : RenderPass -> Bloom -> OutputPass (ACES + sRGB) -> Grading
 *   parametrique -> LUT optionnelle -> FXAA. Le tone mapping materiaux ne
 *   s'applique qu'au rendu ecran (three r180) : dans les render targets du
 *   composer tout reste lineaire, et l'OutputPass convertit une seule fois.
 *   Le bloom travaille donc en lineaire (halo solaire >1.0 accroche), le
 *   grading en espace d'affichage (la ou se font les LUTs en prod), et le
 *   FXAA en dernier remplace le MSAA coupe.
 */
export function createPostChain({ renderer, scene, camera, container }) {
  // — Fond : triangle plein ecran qui affiche le RT du ciel ————
  const bgUniforms = {
    tSky: { value: null },
    uInvRes: { value: new THREE.Vector2(1, 1) },
  };
  const bgTriangle = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    ),
    new THREE.ShaderMaterial({
      uniforms: bgUniforms,
      vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSky;
        uniform vec2 uInvRes;
        void main() { gl_FragColor = texture2D(tSky, gl_FragCoord.xy * uInvRes); }
      `,
      depthTest: false,
      depthWrite: false,
    }),
  );
  bgTriangle.renderOrder = -1000;
  bgTriangle.frustumCulled = false;
  scene.add(bgTriangle);

  // 0.65 : valide par Aurelien a 60 fps sur sa machine — silhouettes nettes.
  const skyRes = { scale: 0.65, rt: null };
  const rebuildSkyRT = () => {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (skyRes.rt) skyRes.rt.dispose();
    skyRes.rt = new THREE.WebGLRenderTarget(
      Math.max(2, Math.round(size.x * skyRes.scale)),
      Math.max(2, Math.round(size.y * skyRes.scale)),
      { depthBuffer: false },
    );
    bgUniforms.tSky.value = skyRes.rt.texture;
    bgUniforms.uInvRes.value.set(1 / size.x, 1 / size.y);
  };
  rebuildSkyRT();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.24, // strength (regle par Aurelien)
    0.14, // radius
    0.64, // seuil : seuls les rebords face soleil accrochent, pas tout le plumage
  );
  composer.addPass(bloom);

  composer.addPass(new OutputPass());
  const grade = createGradePass();
  composer.addPass(grade);

  // LUT 3D optionnelle : chargee a chaud depuis le panneau (.cube exporte de
  // DaVinci/Photoshop). S'applique APRES le grading parametrique.
  const lutPass = new LUTPass({ intensity: 1 });
  lutPass.enabled = false;
  composer.addPass(lutPass);
  const loadLUT = (text) => {
    const parsed = new LUTCubeLoader().parse(text);
    lutPass.lut = parsed.texture3D;
    lutPass.enabled = true;
    console.log(`[lut] chargee : ${parsed.title ?? "sans titre"} (${parsed.size}^3)`);
  };

  const fxaa = new ShaderPass(FXAAShader);
  composer.addPass(fxaa);

  const updateScreenUniforms = () => {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    fxaa.material.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
    grade.material.uniforms.uAspect.value = size.x / size.y;
  };
  updateScreenUniforms();

  // NOTE ordre des listeners resize : celui de scene.js (renderer.setSize)
  // est enregistre AVANT celui-ci — le composer et le RT lisent donc la
  // taille deja mise a jour.
  window.addEventListener("resize", () => {
    // meme garde-fou que scene.js : taille nulle transitoire -> on ignore
    if (container.clientWidth < 2 || container.clientHeight < 2) return;
    composer.setSize(container.clientWidth, container.clientHeight);
    rebuildSkyRT();
    updateScreenUniforms();
  });

  /** Frame complete : 1) ciel en basse resolution, 2) scene via composer. */
  const render = (skyScene) => {
    renderer.setRenderTarget(skyRes.rt);
    renderer.render(skyScene, camera);
    renderer.setRenderTarget(null);
    composer.render();
  };

  return { composer, bloom, grade, lutPass, loadLUT, skyRes, rebuildSkyRT, render };
}
