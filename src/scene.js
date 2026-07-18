import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * Scene, rendu, camera.
 *
 * L'eclairage vient d'une RoomEnvironment generee proceduralement : PBR
 * correct sans avoir a embarquer un HDRI. A remplacer par un vrai .hdr le jour
 * ou le rendu compte vraiment.
 */
export function createScene(container) {
  // antialias: false — TOUT le rendu passe par l'EffectComposer, qui dessine
  // dans des render targets non-MSAA : le MSAA du canvas ne s'appliquerait
  // qu'au quad final de l'OutputPass, c'est-a-dire a rien. Le laisser actif
  // coute memoire et bande passante pour zero benefice visuel.
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.classList.add("three");
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose(); // la texture env reste valide, seuls les buffers de travail partent

  // Le canard fait ~0.3 unite : near tres court, sinon il disparait de si pres.
  const camera = new THREE.PerspectiveCamera(
    40,
    container.clientWidth / container.clientHeight,
    0.01,
    100,
  );
  // Cadrage VERROUILLE par Aurelien (export du 18/07) : vue de face,
  // legerement decalee — le canard arrive vers la camera.
  camera.position.set(3.0439, 0.0264, -4.0655);

  // Repositionnee a l'init sur la direction du soleil du shader ciel (cf.
  // main.js) : si la lumiere ne vient pas d'ou l'oeil voit le soleil, le
  // canard a l'air colle sur le fond au lieu d'habiter le meme monde.
  // Intensites calibrees avec le bloom (seuil 1.0) : a 2.2 le plumage blanc
  // depassait le blanc lineaire sur toute sa surface et le canard bloomait
  // en entier. A 1.4, seuls les rebords face soleil accrochent le bloom —
  // le petit halo "esprit de Sky", pas la boule radioactive.
  const key = new THREE.DirectionalLight(0xfff4e0, 1.4);
  key.position.set(2, 3, 2);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x88aaff, 0.45);
  fill.position.set(-2, 1, -1.5);
  scene.add(fill);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(-0.3684, 0.103, -0.4117);
  controls.minDistance = 0.15;
  controls.maxDistance = 5;

  // Coupee par defaut depuis le ciel : une grille qui flotte au milieu des
  // nuages casse l'illusion de vol. Reactivable dans Rendu.
  const grid = new THREE.GridHelper(2, 20, 0x2a2e35, 0x1e222a);
  grid.position.y = -0.25;
  grid.visible = false;
  scene.add(grid);

  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener("resize", onResize);

  return { renderer, scene, camera, controls, grid, key, onResize };
}
