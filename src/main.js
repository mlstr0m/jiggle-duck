import * as THREE from "three";
import { createScene } from "./scene.js";
import { Duck, RIG } from "./duck.js";
import { HandTracker } from "./handTracking.js";
import { HandOverlay } from "./handOverlay.js";
import { PinchDetector } from "./pinch.js";
import { GrabController } from "./grab.js";
import { FlapController } from "./flap.js";
import { Sky } from "./sky.js";
import { Flock } from "./flock.js";
import { HeadLook } from "./headLook.js";
import { WingTrails } from "./trails.js";
import { WindStreaks } from "./wind.js";
import { FarBirds } from "./farBirds.js";
import { Sparkles } from "./sparkles.js";
import { createSunFlare } from "./flare.js";
import { createPostChain } from "./postChain.js";
import { createGovernor } from "./governor.js";
import { createCameraRig } from "./cameraRig.js";
import { createIntro } from "./intro.js";
import { createSpeedControl } from "./speedControl.js";
import { SETTINGS, applySettings } from "./settings.js";

const DUCK_URL = "./duck.ktx2.glb"; // patche + textures KTX2 ; cf. scripts + package.json

// Panneau de reglage + HUD perf : reserves au mode debug — URL terminee par
// #debug (ex. https://serveur.interne/jiggle-duck/#debug). Un visiteur public
// ne voit que l'experience, et ne TELECHARGE meme pas le code du panneau
// (import dynamique : lil-gui + debugPanel vivent dans leur propre chunk).
const DEBUG =
  location.hash === "#debug" ||
  new URLSearchParams(location.search).has("debug") ||
  import.meta.env.DEV;
// passer de/vers #debug a chaud : recharger est le comportement le plus previsible
window.addEventListener("hashchange", () => location.reload());

const els = {
  app: document.getElementById("app"),
  video: document.getElementById("webcam"),
  overlay: document.getElementById("overlay"),
  pip: document.getElementById("pip"),
  status: document.getElementById("status"),
  handcur: document.getElementById("handcur"),
  handcurRing: document.getElementById("handcur-ring"),
  handcurLabel: document.getElementById("handcur-label"),
  start: document.getElementById("start"),
  startBtn: document.getElementById("start-btn"),
  hud: document.getElementById("hud"),
};

const setStatus = (text, isError = false) => {
  els.status.innerHTML = isError ? `<span class="err">${text}</span>` : text;
};

async function boot() {
  const { renderer, scene, camera, controls, grid, key } = createScene(els.app);

  // Perte de contexte WebGL (vieux GPU, driver qui decroche) : sans ce
  // handler, l'ecran fige en noir sans explication. On previent et on guide.
  renderer.domElement.addEventListener(
    "webglcontextlost",
    (e) => {
      e.preventDefault();
      showFatal(
        "The graphics context was lost (this can happen on older machines).<br/>" +
          "Please <b>reload the page</b> to restart the experience.",
      );
    },
    false,
  );

  // — Canard ——————————————————————————
  setStatus("loading…");
  const duck = new Duck();
  await duck.load(DUCK_URL, renderer);
  scene.add(duck.root);

  // Le wiggle lit des positions monde a la construction : la scene doit etre
  // a jour, sinon toutes les chaines partent d'un etat faux.
  scene.updateMatrixWorld(true);
  const count = duck.buildWiggle();

  console.groupCollapsed(`[duck] ${duck.chains.length} chaines, ${count} wiggle bones`);
  for (const c of duck.chains) {
    console.log(`${c.label} — ${c.bones.length} bones, ${c.dynamic.length} dynamiques`);
  }
  console.groupEnd();

  if (duck.warnings.length) {
    console.group("[duck] avertissements rig");
    duck.warnings.forEach((w) => console.warn(w));
    console.groupEnd();
  }

  // — Interaction ————————————————————
  const pinch = new PinchDetector({ closeAt: 0.45, openAt: 0.62 });
  const grab = new GrabController(camera, duck.root, duck.skinnedMesh);
  const overlay = new HandOverlay(els.overlay);
  overlay.resize();

  // Battement d'ailes permanent. init() apres buildWiggle : la calibration de
  // l'axe se fait dans la hierarchie reelle, wrappers wiggle compris.
  const flap = new FlapController(duck);
  console.log("[flap] calibration axes ailes :", flap.init());

  // — Ciel defilant ————————————————————
  // L'avant du canard n'est pas code en dur : direction horizontale
  // corps -> tete mesuree sur le rig au chargement (noms centralises dans
  // RIG, duck.js). Le ciel volumetrique vit dans SA scene, rendue en basse
  // resolution puis composee en fond (cf. postChain.js).
  const skyScene = new THREE.Scene();
  const sky = new Sky(skyScene);
  const restForward = (() => {
    const head = new THREE.Vector3();
    const body = new THREE.Vector3();
    duck.root.updateMatrixWorld(true);
    duck.skeleton.bones.find((b) => b.name === RIG.head).getWorldPosition(head);
    duck.skeleton.bones.find((b) => b.name === RIG.body).getWorldPosition(body);
    const f = head.sub(body);
    f.y = 0;
    return f.normalize();
  })();

  // Soleil devant-haut sur l'axe de vol (contre-jour, comme les references
  // Sky) — et la key light du canard alignee dessus, sinon l'eclairage du
  // mesh contredit le ciel.
  const sunDir = restForward
    .clone()
    .add(new THREE.Vector3(0, 0.55, 0))
    .normalize();
  sky.setSun(sunDir);
  key.position.copy(sunDir).multiplyScalar(8);

  // Le flare a son PROPRE ancrage : avec la camera de face, le vrai soleil
  // (sur l'axe de vol) se projette DERRIERE la camera — flare invisible a
  // jamais. Le soleil VISUEL est place par position ecran (NDC), et replace
  // chaque frame : un soleil a l'infini reste fixe a l'ecran sous une
  // translation camera.
  const flareAnchor = new THREE.Object3D();
  scene.add(flareAnchor);
  const sunFlare = createSunFlare(flareAnchor);
  sunFlare.screen = { x: -0.99, y: 0.75 };
  sunFlare.place = () => {
    camera.updateMatrixWorld(); // unproject a besoin des matrices a jour
    const p = new THREE.Vector3(sunFlare.screen.x, sunFlare.screen.y, 0.5).unproject(camera);
    const dir = p.sub(camera.position).normalize();
    flareAnchor.position.copy(camera.position).addScaledVector(dir, 45);
  };

  // Brume atmospherique : sans elle, les copains lointains sont plaques nets
  // sur le ciel. Couleur synchronisee sur l'horizon a chaque frame (les
  // color pickers de la palette restent donc vivants).
  scene.fog = new THREE.Fog(0xffffff, 3.5, 16);

  const wind = new WindStreaks(scene, restForward);
  const sparkles = new Sparkles(scene, restForward);

  // — Volees lointaines : les migrations d'arriere-plan (ref Sky) ————
  const farBirds = new FarBirds(scene, restForward);

  // — Trainees de bouts d'ailes (leader + copains) ————
  const trails = new WingTrails(scene, restForward);
  const leaderTrailHandles = RIG.wingTips
    .map((n) => duck.skeleton.bones.find((b) => b.name === n))
    .filter(Boolean)
    .map((bone) => trails.attach(bone, 1));

  // — Regards : les oiseaux bougent la tete de temps en temps ————
  const headLook = new HeadLook();
  {
    const neck = duck.chains.find((c) => c.label.startsWith("Cou"));
    if (neck) headLook.attach(neck.root, neck.dynamic[0] ?? neck.root);
  }

  // — Migration : copains en formation derriere le leader ————
  scene.updateMatrixWorld(true);
  const flock = new Flock(scene, duck, flap, restForward, trails, camera, headLook);

  // — Vie au repos du leader : houle + vagabondage, comme les copains ——
  const idle = {
    amount: 0.6, // 0 = statue, 1 = houle marquee
    home: duck.root.position.clone(),
    t: Math.random() * 10,
  };

  // — Manette des gaz (2e main) — cf. speedControl.js ————
  // `intro` est cree plus bas : reference differee via closure.
  let intro = null;
  const speed = createSpeedControl({
    sky,
    wind,
    sparkles,
    trails,
    flap,
    flock,
    grab,
    restForward,
    getAspect: () => pinch.aspect,
    isIntroActive: () => intro?.active ?? false,
  });

  // Camera VERROUILLEE — y compris au clic maintenu, y compris en debug : le
  // cadrage est authored. La case "orbit controls" du panneau (#debug) reste
  // le seul moyen de liberer l'orbite, pour cadrer.
  controls.enabled = false;
  let savedOrbit = false; // etat orbite a restaurer apres une prise

  // — Post-processing + gouverneur de qualite ————————
  const post = createPostChain({ renderer, scene, camera, container: els.app });
  const { quality, govern } = createGovernor({
    renderer,
    composer: post.composer,
    bloom: post.bloom,
    sky,
    skyRes: post.skyRes,
    rebuildSkyRT: post.rebuildSkyRT,
  });

  // — Reglages bakes : source de verite unique (settings.js) ————
  applySettings(SETTINGS, {
    camera,
    controls,
    sky,
    grade: post.grade,
    bloom: post.bloom,
    wind,
    sparkles,
    farBirds,
    flare: sunFlare,
    trails,
    grab,
    idle,
    flap,
    speedCtl: speed.ctl,
    flock,
    headLook,
    duck,
  });
  sunFlare.place(); // apres la camera bakee

  // — Rig camera (APRES applySettings : capture la position de base bakee) —
  const camRig = createCameraRig({ camera, controls });
  camRig.follow = SETTINGS.camRig.suivi;
  camRig.smooth = SETTINGS.camRig.reactivite;
  camRig.zoomPerBird = SETTINGS.camRig.dezoomParCopain;
  camRig.fovKick = SETTINGS.camRig.fovKick;
  flock.onArrival = (n) => camRig.onArrival(n);

  // — Sequence d'ouverture (cf. intro.js) ————————————
  intro = createIntro({ camera, controls, duck, grab, idle, flock, grade: post.grade });
  let hasGrabbedOnce = false;

  const startExperience = () => {
    if (intro.started) return;
    els.start.style.display = "none";
    intro.start();
  };

  // — Panneau debug : import DYNAMIQUE — jamais telecharge par le public —
  const homePosition = duck.root.position.clone();
  if (!DEBUG) els.hud.style.display = "none";
  if (DEBUG) {
    const { createDebugPanel } = await import("./debugPanel.js");
    createDebugPanel({
      duck,
      pinch,
      grab,
      flap,
      idle,
      speedCtl: speed.ctl,
      flock,
      headLook,
      trails,
      camRig,
      quality,
      sky,
      skyRes: post.skyRes,
      rebuildSkyRT: post.rebuildSkyRT,
      grade: post.grade,
      lutPass: post.lutPass,
      loadLUT: post.loadLUT,
      wind,
      sparkles,
      farBirds,
      flare: sunFlare,
      bloom: post.bloom,
      composer: post.composer,
      grid,
      controls,
      renderer,
      onReset: () => {
        duck.root.position.copy(homePosition);
        duck.reset();
        flap.reset();
        grab.release();
      },
    });
  }

  // — Souris : fallback pour bosser sans webcam —————
  // Le tracking n'est pas toujours disponible (pas de camera, mauvaise
  // lumiere), et on ne veut pas etre bloque pour regler le wiggle ou le rendu.
  const mouseNdc = new THREE.Vector2();
  let mouseDown = false;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (!e.shiftKey) return; // shift+clic pour ne pas voler l'orbit
    mouseNdc.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    if (grab.tryGrab(mouseNdc.x, mouseNdc.y)) {
      mouseDown = true;
      savedOrbit = controls.enabled;
      controls.enabled = false;
    }
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!mouseDown) return;
    mouseNdc.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    grab.move(mouseNdc.x, mouseNdc.y);
  });
  window.addEventListener("pointerup", () => {
    if (!mouseDown) return;
    mouseDown = false;
    grab.release();
    controls.enabled = savedOrbit;
  });

  // — Tracking de main ——————————————————
  const tracker = new HandTracker(els.video);
  let trackingReady = false;
  // le gouverneur pilote aussi MediaPipe : 1 detection sur 2 aux paliers bas
  quality.onApply = (level) => {
    tracker.detectEveryN = level >= 3 ? 2 : 1;
  };
  let lastCtrlWrist = null; // continuite du role "main de controle"

  els.startBtn.addEventListener("click", async () => {
    els.startBtn.disabled = true;
    try {
      setStatus("loading hand tracking…");
      await tracker.init();

      setStatus("starting camera…");
      await tracker.startCamera();

      pinch.aspect = els.video.videoWidth / els.video.videoHeight || 4 / 3;
      overlay.resize();
      tracker.start();
      trackingReady = true;

      startExperience();
      setStatus(
        "pinch thumb + index to grab the duck.\nyour other hand is the throttle: pinch = speed, fist = spin boost.",
      );
    } catch (err) {
      console.error(err);
      setStatus(
        `camera unavailable: ${err.message}\nshift + click to move the duck with the mouse.`,
        true,
      );
      startExperience();
      els.startBtn.disabled = false;
    }
  });

  // — HUD perf (debug uniquement) ——————————————
  // Mesurer avant d'optimiser : fps rendu, cout frame JS, cout inference.
  let frames = 0;
  let frameCostAccum = 0;
  let hudSince = performance.now();

  const updateHud = () => {
    const now = performance.now();
    const elapsed = now - hudSince;
    if (elapsed < 500) return;
    const fps = (frames * 1000) / elapsed;
    const cost = frameCostAccum / Math.max(1, frames);
    const t = tracker.stats;
    els.hud.innerHTML =
      `<span class="${fps < 50 ? "bad" : ""}">render ${fps.toFixed(0)} fps · ${cost.toFixed(1)} ms/f · Q ${quality.levels[quality.level].name}</span>` +
      (trackingReady ? `\ndetect ${t.detectFps.toFixed(0)} fps · ${t.detectMs.toFixed(1)} ms` : "");
    frames = 0;
    frameCostAccum = 0;
    hudSince = now;
  };

  // — Boucle ————————————————————————
  const clock = new THREE.Clock();
  // temporaires du retour-cadre (zero allocation par frame)
  const homeView = new THREE.Vector3();
  const homeNdc = new THREE.Vector3();
  const homeTarget = new THREE.Vector3();
  let homeReturning = false; // rappel en cours (collant jusqu'a la zone sure)
  // etat DOM du curseur : on n'ecrit que les changements
  let curPinchClass = null;
  let curLabelShown = null;

  // forcedDt : stepping manuel deterministe (verif/headless — RAF gele quand
  // la page est cachee) ; en usage normal setAnimationLoop ne le passe jamais
  const tick = (_time, forcedDt) => {
    const frameStart = performance.now();
    const rawDt = clock.getDelta(); // temps de frame REEL, pour le gouverneur
    const dt = forcedDt ?? Math.min(rawDt, 1 / 20); // clamp : un onglet en fond renvoie des dt enormes
    govern(forcedDt ?? rawDt);

    if (trackingReady) {
      // — Attribution des roles entre les deux mains —
      // Par continuite de position, pas par handedness gauche/droite :
      // MediaPipe confond regulierement left/right en miroir, alors qu'un
      // poignet ne se teleporte pas d'une frame a l'autre.
      const hands = tracker.hands;
      let hand = null;
      let flapHand = null;

      if (hands.length > 0) {
        let ctrlIdx = 0;
        if (hands.length > 1 && lastCtrlWrist) {
          const d = (lm) => Math.hypot(lm[0].x - lastCtrlWrist.x, lm[0].y - lastCtrlWrist.y);
          ctrlIdx = d(hands[0]) <= d(hands[1]) ? 0 : 1;
        }
        hand = hands[ctrlIdx];
        flapHand = hands.length > 1 ? hands[1 - ctrlIdx] : null;
        lastCtrlWrist = { x: hand[0].x, y: hand[0].y };
      }

      pinch.update(hand);
      // avant tryGrab : la prise capture le roll courant comme reference
      grab.setHandRoll(pinch.roll);
      // 2e main : manette des gaz + vrille au poing (ignoree pendant l'intro)
      speed.handleHand(flapHand);

      if (pinch.justPressed) {
        if (grab.tryGrab(pinch.ndc.x, pinch.ndc.y)) {
          savedOrbit = controls.enabled;
          controls.enabled = false;
          hasGrabbedOnce = true;
        }
      }
      if (pinch.justReleased) {
        grab.release();
        controls.enabled = savedOrbit;
      }
      if (grab.isHolding) grab.move(pinch.ndc.x, pinch.ndc.y);

      // curseur main : DOM (anneau + label), suit le point de pincement.
      // Position/echelle ecrites chaque frame (elles bougent) ; classe et
      // label seulement au changement.
      if (hand) {
        const x = (pinch.ndc.x * 0.5 + 0.5) * window.innerWidth;
        const y = (1 - (pinch.ndc.y * 0.5 + 0.5)) * window.innerHeight;
        els.handcur.style.display = "flex";
        els.handcur.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        // l'anneau se referme AVEC les doigts (feedback continu), et se
        // verrouille petit + rempli une fois le pincement pris
        if (curPinchClass !== pinch.isPinching) {
          curPinchClass = pinch.isPinching;
          els.handcur.classList.toggle("pinch", pinch.isPinching);
        }
        const rs = pinch.isPinching
          ? 0.5
          : 0.55 + 0.45 * Math.min(1, Math.max(0, (pinch.ratio - 0.4) / 0.5));
        els.handcurRing.style.transform = `scale(${rs})`;
        // le hint disparait des la premiere prise reussie : mission accomplie
        const showLabel = !hasGrabbedOnce;
        if (curLabelShown !== showLabel) {
          curLabelShown = showLabel;
          els.handcurLabel.style.display = showLabel ? "block" : "none";
        }
      } else {
        els.handcur.style.display = "none";
      }

      els.pip.classList.toggle("idle", hands.length === 0);
      overlay.draw(hand, flapHand, {
        pinching: pinch.isPinching,
        ratio: pinch.ratio,
        throttle: Math.min(1, (speed.ctl.factor - speed.ctl.min) / (speed.ctl.max - speed.ctl.min)),
      });
    }

    // vie au repos : la cible du ressort ondule autour du point de lacher
    if (grab.isHolding) {
      idle.home.copy(grab.desired); // le point de lacher devient le foyer
    } else {
      // retour automatique dans le cadre : un canard lache hors champ est
      // IMPRENABLE (le raycast ne peut plus le toucher). Des que le foyer
      // sort du cadre (seuil 0.88/0.82), il glisse tout seul vers une zone
      // confortable — et le rappel reste COLLANT jusqu'a y arriver (0.7/0.65),
      // sinon il s'arreterait pile au bord, a moitie visible.
      if (!intro.active) {
        homeView.copy(idle.home).applyMatrix4(camera.matrixWorldInverse);
        if (homeView.z > -0.05) {
          // cas degenere : foyer derriere la camera -> retour a l'origine
          idle.home.copy(homePosition);
        } else {
          homeNdc.copy(idle.home).project(camera);
          if (Math.abs(homeNdc.x) > 0.88 || Math.abs(homeNdc.y) > 0.82) homeReturning = true;
          else if (Math.abs(homeNdc.x) < 0.7 && Math.abs(homeNdc.y) < 0.65) homeReturning = false;
          if (homeReturning) {
            homeNdc.x = Math.max(-0.6, Math.min(0.6, homeNdc.x));
            homeNdc.y = Math.max(-0.55, Math.min(0.55, homeNdc.y));
            homeTarget.copy(homeNdc).unproject(camera); // meme profondeur (z NDC conserve)
            idle.home.lerp(homeTarget, Math.min(1, dt * 2));
          }
        }
      }
      idle.t += dt;
      const a = idle.amount;
      grab.desired.set(
        idle.home.x + (Math.sin(idle.t * 0.5) * 0.06 + Math.sin(idle.t * 0.23 + 1.7) * 0.04) * a,
        idle.home.y + Math.sin(idle.t * 0.8 + 0.6) * 0.05 * a,
        idle.home.z + Math.sin(idle.t * 0.31 + 3.1) * 0.04 * a,
      );
    }

    intro.update(dt); // iris + dezoom + retenue du canard sous le champ
    speed.update(dt); // vrille + facteur de vitesse — AVANT grab.update

    grab.update(dt); // ressort du corps : tourne aussi hors prise (retombee)
    headLook.update(dt); // regards : AVANT duck/flock.update, comme le battement
    flap.update(dt); // AVANT duck.update : les springs doivent voir la pose fraiche des racines d'ailes
    duck.update(dt);
    flock.update(dt, duck.root.position); // la migration suit le leader
    // APRES duck.update : les bones d'ailes sont dans leur pose finale.
    // Les trainees du leader brillent avec la VITESSE.
    for (const h of leaderTrailHandles) h.gain = Math.min(1.2, 0.35 + 0.28 * speed.ctl.factor);
    trails.update(dt, camera);

    // camera : pendant l'intro on suit le HOME, pas le canard (sinon elle
    // plonge vers le spawn hors champ puis remonte avec lui)
    camRig.update(
      dt,
      intro.active ? idle.home : duck.root.position,
      (speed.ctl.factor - 1) / Math.max(0.001, speed.ctl.max - 1),
    );
    sunFlare.place(); // soleil a l'infini : fixe a l'ecran sous translation

    // Le defilement suit le CAP du canard, pas son attitude : appliquer le
    // quaternion du root ici ferait tourner les nuages avec le roll de la
    // main et l'inclinaison par la vitesse (bug constate). Le canard n'a pas
    // de mecanique de lacet — son cap est constant, c'est restForward.
    sky.update(dt, restForward);
    scene.fog.color.copy(sky.uniforms.uHorizon.value);
    wind.update(dt, camera);
    sparkles.update(dt, camera);
    farBirds.update(dt, sky.uniforms.uHorizon.value);
    controls.update();

    post.render(skyScene);

    if (DEBUG) {
      frames++;
      frameCostAccum += performance.now() - frameStart;
      updateHud();
    }
  };
  renderer.setAnimationLoop(tick);

  window.addEventListener("resize", () => overlay.resize());

  // — Handles debug (console + verification automatisee) ————
  if (DEBUG) {
    // Capture d'ecran programmatique : rend une frame complete puis lit le
    // canvas DANS LA MEME TACHE (preserveDrawingBuffer est false).
    const snapshot = (quality = 0.88) => {
      post.render(skyScene);
      return renderer.domElement.toDataURL("image/jpeg", quality);
    };
    Object.assign(window, {
      __duck: duck,
      __scene: scene,
      __camera: camera,
      __controls: controls,
      __sky: sky,
      __flare: sunFlare,
      __wind: wind,
      __sparkles: sparkles,
      __trails: trails,
      __farBirds: farBirds,
      __flock: flock,
      __headLook: headLook,
      __idle: idle,
      __grab: grab,
      __pinch: pinch,
      __flap: flap,
      __speedCtl: speed.ctl,
      __camRig: camRig,
      __quality: quality,
      __grade: post.grade,
      __startExperience: startExperience,
      // injection de mains synthetiques : teste le VRAI pipeline d'entree
      // (roles, pinch, raycast, grab) sans webcam — verification automatisee
      __injectHands: (landmarks) => {
        tracker.result = { landmarks };
        trackingReady = true;
      },
      __snapshot: snapshot,
      __tick: tick,
    });
  }
}

// — Garde-fous production ————————————————
// 1) WebGL2 indisponible (tres vieux navigateur / GPU blockliste)
function webgl2Available() {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

// 2) erreurs globales -> message lisible plutot qu'un ecran fige
function showFatal(message) {
  const div = document.createElement("div");
  div.style.cssText =
    "position:fixed;inset:0;display:grid;place-content:center;text-align:center;" +
    "background:#14161a;color:#e8e8e8;font:14px/1.6 ui-monospace,monospace;z-index:99;padding:24px";
  div.innerHTML = message;
  document.body.appendChild(div);
}

window.addEventListener("error", (e) => {
  console.error(e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
});

// Experience DESKTOP uniquement (decision produit) : sur mobile/tablette on
// bloque AVANT le boot — message clair, et surtout pas 45 Mo de wasm + modele
// telecharges pour une experience qui n'est pas prevue la.
const IS_MOBILE =
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches);

if (IS_MOBILE) {
  document.getElementById("start").style.display = "none";
  showFatal(
    "🦆<br/><br/>Jiggle Duck is a <b>desktop</b> experience:<br/>" +
      "it needs a webcam and a computer screen.<br/><br/>" +
      "Open this link on a Mac or PC!",
  );
  throw new Error("mobile non supporte");
}

if (!webgl2Available()) {
  document.getElementById("start").style.display = "none";
  showFatal(
    "This browser does not support WebGL2, which the experience needs.<br/>" +
      "Please try a recent Chrome, Firefox, Edge or Safari.",
  );
  throw new Error("WebGL2 indisponible");
}

// 3) piege classique du serveur interne : la webcam (getUserMedia) exige un
// contexte securise (https ou localhost). En http://IP-interne, on previent
// AVANT le clic au lieu de laisser echouer mysterieusement.
if (!window.isSecureContext) {
  const p = document.getElementById("start-note");
  if (p) {
    p.innerHTML =
      "⚠️ This page is served over insecure HTTP: the browser will block the " +
      "camera.<br/>Ask for an <b>https</b> URL to enable hand tracking.";
  }
}

boot().catch((err) => {
  console.error(err);
  setStatus(`something went wrong: ${err.message}`, true);
  els.start.style.display = "none";
});
