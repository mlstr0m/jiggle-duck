import GUI from "lil-gui";
import { DEFAULT_DAMPING } from "./duck.js";

/**
 * Panneau de reglage live.
 *
 * Volontairement etoffe : regler un ressort ou un seuil de pincement dans le
 * code puis recharger, c'est 30 secondes par essai. Ici c'est instantane, et
 * ces valeurs se trouvent a l'oeil, pas au raisonnement.
 */
export function createDebugPanel({
  duck,
  pinch,
  grab,
  flap,
  idle,
  speedCtl,
  flock,
  headLook,
  trails,
  camRig,
  quality,
  sky,
  skyRes,
  rebuildSkyRT,
  grade,
  lutPass,
  loadLUT,
  wind,
  sparkles,
  farBirds,
  flare,
  bloom,
  composer,
  grid,
  controls,
  renderer,
  onReset,
}) {
  const gui = new GUI({ title: "Jiggle Duck" });

  // — Wiggle (membres) ———————————————————
  // stiffness bas = membre mou qui traine ; damping bas = rebondit longtemps.
  const fWiggle = gui.addFolder("Wiggle membres");
  const wiggleGlobal = { damping: DEFAULT_DAMPING };

  for (const chain of duck.chains) {
    if (chain.anchor) continue;
    const proxy = { stiffness: chain.stiffness };
    fWiggle
      .add(proxy, "stiffness", 60, 1200, 10)
      .name(chain.label)
      .onChange((v) => duck.setChainParams(chain, { stiffness: v }));
  }

  fWiggle
    .add(wiggleGlobal, "damping", 4, 40, 0.5)
    .name("amorti (tous)")
    .onChange((v) => {
      for (const chain of duck.chains) duck.setChainParams(chain, { damping: v });
    });

  fWiggle.add({ reset: () => duck.reset() }, "reset").name("reset pose");

  // — Corps ————————————————————————
  const fBody = gui.addFolder("Corps (ressort)");
  fBody.add(grab, "stiffness", 30, 500, 5).name("raideur");
  fBody.add(grab, "damping", 4, 40, 0.5).name("amorti");
  fBody.add(grab, "tilt", 0, 2.5, 0.05).name("inclinaison");
  fBody.add(grab, "rollGain", 0, 2, 0.05).name("roll main");
  fBody.add(idle, "amount", 0, 1.5, 0.05).name("vie au repos");
  fBody.add(flap, "cruise", 0, 1, 0.02).name("battement croisiere");

  // — Battement (permanent) ————————————————
  const fFlap = gui.addFolder("Battement");
  fFlap.add(flap, "amplitude", 0, 1.5, 0.05).name("amplitude (rad)");
  fFlap.add(flap, "frequency", 1, 6, 0.1).name("frequence (Hz)");

  // — Vitesse (2e main) ————————————————————
  const fSpeed = gui.addFolder("Vitesse (2e main)");
  fSpeed.add(speedCtl, "min", 0.1, 1, 0.05).name("main ouverte (lent)");
  fSpeed.add(speedCtl, "max", 1, 8, 0.1).name("doigts serres (vite)");
  fSpeed.add(speedCtl.boost, "extra", 0, 8, 0.1).name("boost vrille (+vitesse)");
  fSpeed.add(speedCtl.boost, "impulse", 0, 5, 0.1).name("impulsion avant");
  fSpeed.add(speedCtl.boost, "dur", 0.3, 3, 0.05).name("duree vrille (s)");
  fSpeed.add(speedCtl.boost, "sepAmp", 0, 4, 0.1).name("prise d'avance");
  fSpeed.add(speedCtl.boost, "sepDur", 1, 6, 0.1).name("duree avance (s)");

  // — Ciel ————————————————————————————
  const fSky = gui.addFolder("Ciel");
  fSky.add(speedCtl.bases, "sky", 0, 6, 0.1).name("vitesse de vol (base)");
  fSky.add(sky.uniforms.uCoverage, "value", 0, 1, 0.02).name("couverture nuages");
  fSky.add(sky.uniforms.uScale, "value", 0.4, 3, 0.05).name("echelle motif");
  fSky.add(sky, "stretch", 1, 6, 0.1).name("etirement nuages");
  // qualite du raymarching : c'est LE levier GPU du ciel volumetrique.
  // Toucher un levier gere par le gouverneur = passage en manuel, sinon
  // l'auto ecraserait le reglage au prochain palier.
  fSky
    .add(sky.uniforms.uSteps, "value", 8, 40, 1)
    .name("qualite nuages (pas)")
    .onChange(() => (quality.auto = false))
    .listen();
  // resolution du RT ciel (fraction du framebuffer) : 2e levier GPU
  fSky
    .add(skyRes, "scale", 0.15, 1, 0.05)
    .name("resolution ciel")
    .onChange(() => {
      quality.auto = false;
      rebuildSkyRT();
    })
    .listen();

  // — Palette (calibree post-ACES) ————————————
  const fPalette = fSky.addFolder("Palette");
  fPalette.addColor(sky.uniforms.uZenith, "value").name("zenith");
  fPalette.addColor(sky.uniforms.uHorizon, "value").name("horizon");
  fPalette.addColor(sky.uniforms.uShadow, "value").name("ombre nuages");
  fPalette.addColor(sky.uniforms.uDeep, "value").name("ocean (trouees)");
  // positions du degrade (en elevation, -1 = nadir, +1 = zenith) et force
  // de l'ombrage — demande utilisateur : placer le degrade soi-meme
  fPalette.add(sky.uniforms.uGradLo, "value", -0.5, 0.5, 0.01).name("position horizon");
  fPalette.add(sky.uniforms.uGradHi, "value", 0.1, 1, 0.01).name("position zenith");
  fPalette.add(sky.uniforms.uShadowAmt, "value", 0, 1.5, 0.02).name("force ombre nuages");
  // contraste du modele des nuages : gain de l'ombrage directionnel et
  // luminosite des faces eclairees — demande utilisateur
  fPalette.add(sky.uniforms.uContrast, "value", 0.5, 8, 0.1).name("contraste nuages");
  fPalette.add(sky.uniforms.uLitBoost, "value", 0.7, 1.4, 0.01).name("luminosite nuages");
  fSky.add(sky.uniforms.uRays, "value", 0, 1.5, 0.02).name("rayons de soleil");
  fSky.add(sky.uniforms.uFar, "value", 0, 1, 0.02).name("nuages lointains");
  fSky.add(sky.uniforms.uFarHeight, "value", 0.3, 2.5, 0.05).name("hauteur lointains");

  // — Trainees d'ailes ————————————————————
  const fTrails = gui.addFolder("Trainees ailes");
  fTrails.add(trails, "intensity", 0, 2, 0.05).name("intensite");
  fTrails.add(trails, "width", 0.003, 0.04, 0.001).name("largeur");
  fTrails.add(speedCtl.bases, "trail", 0.5, 6, 0.1).name("vitesse de fuite (base)");

  // — Grading (l'aspect "fini") ——————————————
  const fGrade = gui.addFolder("Grading");
  const gu = grade.material.uniforms;
  fGrade.add(gu.uContrast, "value", 0.85, 1.35, 0.01).name("contraste");
  fGrade.add(gu.uSaturation, "value", 0.6, 1.5, 0.01).name("saturation");
  fGrade.add(gu.uBrightness, "value", -0.15, 0.15, 0.005).name("luminosite");
  fGrade.addColor(gu.uShadowTint, "value").name("teinte ombres");
  fGrade.add(gu.uShadowTintAmt, "value", 0, 0.4, 0.01).name("force teinte");
  fGrade.add(gu.uVignette, "value", 0, 0.8, 0.02).name("vignettage");
  fGrade.add(gu.uDither, "value", 0, 2.5, 0.05).name("dithering");
  // LUT .cube chargeable a chaud : grade dans DaVinci/Photoshop, exporte,
  // glisse ici — le workflow pro, sans rebuild
  fGrade
    .add(
      {
        charger: () => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".cube";
          input.onchange = () => {
            const f = input.files?.[0];
            if (!f) return;
            f.text()
              .then(loadLUT)
              .catch((e) => console.error("[lut]", e));
          };
          input.click();
        },
      },
      "charger",
    )
    .name("charger LUT (.cube)");
  fGrade.add(lutPass, "intensity", 0, 1, 0.02).name("intensite LUT");
  fGrade.add(lutPass, "enabled").name("LUT active").listen();

  // — Vent ———————————————————————————
  const fWind = gui.addFolder("Vent");
  fWind.add(wind, "intensity", 0, 1, 0.02).name("intensite");
  fWind.add(speedCtl.bases, "wind", 0.5, 8, 0.1).name("vitesse (base)");
  fWind.add(wind, "length", 0.1, 1.5, 0.05).name("longueur traits");

  // — Paillettes ———————————————————————
  const fSpark = gui.addFolder("Paillettes");
  fSpark.add(sparkles, "intensity", 0, 2, 0.05).name("intensite");
  fSpark.add(sparkles, "size", 0.2, 3, 0.05).name("taille");
  fSpark.add(speedCtl.bases, "spark", 0, 4, 0.05).name("derive (base)");
  fSpark.addColor(sparkles, "color").name("teinte");

  // — Fond (volees lointaines) ————————————————
  const fFond = gui.addFolder("Fond");
  fFond.add(farBirds.mesh, "visible").name("volees lointaines");
  fFond.add(farBirds, "opacity", 0, 1, 0.02).name("opacite");
  fFond.add(farBirds, "size", 0.3, 3, 0.05).name("taille");
  fFond.add(farBirds, "speed", 0.2, 3, 0.05).name("vitesse traversee");

  // — Flare ———————————————————————————
  const fFlare = gui.addFolder("Flare");
  const reFlare = () => flare.rebuild();
  fFlare.add(flare, "visible").name("actif");
  fFlare.add(flare, "intensity", 0, 2, 0.05).name("intensite").onChange(reFlare);
  fFlare.add(flare, "glowSize", 50, 700, 10).name("halo (px)").onChange(reFlare);
  fFlare.add(flare, "warmth", 0, 1, 0.05).name("chaleur (dore)").onChange(reFlare);
  fFlare.add(flare, "ringSize", 0, 350, 5).name("anneau (px, 0=off)").onChange(reFlare);
  fFlare.add(flare, "ringOffset", 0, 1, 0.01).name("decalage anneau").onChange(reFlare);
  fFlare.add(flare, "dots", 0, 1, 0.05).name("points fantomes").onChange(reFlare);
  fFlare
    .add(flare.screen, "x", -1, 1, 0.01)
    .name("position x (ecran)")
    .onChange(() => flare.place());
  fFlare
    .add(flare.screen, "y", -1, 1, 0.01)
    .name("position y (ecran)")
    .onChange(() => flare.place());

  // — Bloom ———————————————————————————
  const fBloom = gui.addFolder("Bloom");
  fBloom.add(bloom, "strength", 0, 1.5, 0.02).name("intensite");
  fBloom.add(bloom, "radius", 0, 1.5, 0.02).name("rayon");
  fBloom.add(bloom, "threshold", 0.3, 1.2, 0.01).name("seuil");

  // — Migration ————————————————————————
  const fFlock = gui.addFolder("Migration");
  fFlock
    .add(flock, "count", 0, 6, 1)
    .name("copains")
    .onFinishChange(() => flock.rebuild());
  fFlock
    .add(flock, "stiffness", 15, 150, 1)
    .name("raideur suivi")
    .onFinishChange(() => flock.rebuild());
  fFlock.add(flock, "damping", 3, 25, 0.5).name("amorti suivi");
  fFlock
    .add(flock, "spacing", 0.3, 3, 0.05)
    .name("profondeur du V")
    .onFinishChange(() => flock.rebuild());
  fFlock
    .add(flock, "side", 0.2, 3, 0.05)
    .name("largeur du V")
    .onFinishChange(() => flock.rebuild());
  fFlock
    .add(flock, "scatter", 0, 1.2, 0.05)
    .name("dispersion")
    .onFinishChange(() => flock.rebuild());
  fFlock.add(flock, "wander", 0, 0.6, 0.02).name("vagabondage");
  fFlock.add(flock, "flapAmp", 0, 1, 0.02).name("battement (amp)");
  fFlock.add(flock, "flapFreq", 0.5, 5, 0.1).name("battement (Hz)");
  fFlock.add(flock, "arrivalInterval", 2, 20, 0.5).name("intervalle arrivee (s)");
  fFlock.add(headLook, "amount", 0, 1.5, 0.05).name("regards (tetes)");
  fFlock.add(headLook, "interval", 0.3, 3, 0.1).name("espacement regards");

  // — Pincement ————————————————————————
  const fPinch = gui.addFolder("Pincement");
  const pinchParams = { closeAt: pinch.closeAt, openAt: pinch.openAt, minCutoff: 2.0, beta: 0.015 };
  const applyPinch = () => {
    // Garde-fou : si closeAt depasse openAt, l'hysteresis s'inverse et l'etat
    // se met a clignoter — exactement le bug qu'elle est censee empecher.
    if (pinchParams.closeAt >= pinchParams.openAt) {
      pinchParams.openAt = pinchParams.closeAt + 0.05;
      fPinch.controllers.forEach((c) => c.updateDisplay());
    }
    pinch.setParams(pinchParams);
  };

  fPinch.add(pinchParams, "closeAt", 0.1, 1.0, 0.01).name("ferme sous").onChange(applyPinch);
  fPinch.add(pinchParams, "openAt", 0.15, 1.5, 0.01).name("ouvre au-dessus").onChange(applyPinch);
  fPinch
    .add(pinchParams, "minCutoff", 0.1, 5, 0.05)
    .name("lissage (minCutoff)")
    .onChange(applyPinch);
  fPinch.add(pinchParams, "beta", 0, 0.2, 0.001).name("reactivite (beta)").onChange(applyPinch);

  // — Rendu ————————————————————————————
  const fRender = gui.addFolder("Rendu");
  fRender.add(quality, "auto").name("qualite auto").listen();
  const mat = duck.material;
  const render = {
    pixelRatio: renderer.getPixelRatio(),
    vertexColors: !!mat.vertexColors,
    doubleSided: mat.side === 2,
    wireframe: false,
    grid: grid.visible,
  };

  // Premier levier perf sur ecran retina : DPR 2 = 4x plus de fragments que DPR 1.
  fRender
    .add(render, "pixelRatio", 0.5, Math.min(window.devicePixelRatio, 2), 0.25)
    .name("pixel ratio")
    .onChange((v) => {
      quality.auto = false;
      renderer.setPixelRatio(v);
      // le composer et le RT ciel ont leurs propres tailles, ils doivent suivre
      composer.setPixelRatio(v);
      rebuildSkyRT();
    });

  fRender
    .add(render, "vertexColors")
    .name("vertex colors")
    .onChange((v) => {
      // Si le canard s'eclaircit nettement en decochant, c'est que les vertex
      // colors Blender etaient un masque interne, pas une info de rendu.
      mat.vertexColors = v;
      mat.needsUpdate = true;
    });

  fRender
    .add(render, "doubleSided")
    .name("double face")
    .onChange((v) => {
      mat.side = v ? 2 : 0;
      mat.needsUpdate = true;
    });

  fRender.add(render, "wireframe").onChange((v) => (mat.wireframe = v));
  fRender
    .add(render, "grid")
    .name("grille")
    .onChange((v) => (grid.visible = v));

  // — Scene ————————————————————————————
  const fScene = gui.addFolder("Scene");
  fScene.add(camRig, "follow", 0, 1, 0.02).name("suivi camera");
  fScene.add(camRig, "smooth", 0.3, 6, 0.1).name("reactivite suivi");
  fScene.add(camRig, "zoomPerBird", 0, 0.4, 0.01).name("dezoom / copain");
  fScene.add(camRig, "fovKick", 0, 15, 0.5).name("fov kick (vitesse)");
  fScene.add({ reset: () => camRig.reset(flock.active) }, "reset").name("reset camera");
  // Export : copie TOUS les reglages courants (camera comprise) en JSON dans
  // le presse-papier — a coller a Claude pour les baker en defauts du code.
  const hex = (c) =>
    "#" +
    [c.r, c.g, c.b]
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const exporter = () => {
    const cam = controls.object;
    const u = sky.uniforms;
    const g = grade.material.uniforms;
    const json = JSON.stringify(
      {
        camera: { position: cam.position.toArray(), target: controls.target.toArray() },
        ciel: {
          vitesse: speedCtl.bases.sky,
          etirement: sky.stretch,
          couverture: u.uCoverage.value,
          echelle: u.uScale.value,
          pas: u.uSteps.value,
          rayons: u.uRays.value,
          gradLo: u.uGradLo.value,
          gradHi: u.uGradHi.value,
          forceOmbre: u.uShadowAmt.value,
          contraste: u.uContrast.value,
          luminosite: u.uLitBoost.value,
          lointains: u.uFar.value,
          lointainsHauteur: u.uFarHeight.value,
          zenith: hex(u.uZenith.value),
          horizon: hex(u.uHorizon.value),
          ombre: hex(u.uShadow.value),
          ocean: hex(u.uDeep.value),
        },
        grading: {
          contraste: g.uContrast.value,
          saturation: g.uSaturation.value,
          luminosite: g.uBrightness.value,
          teinteOmbres: hex(g.uShadowTint.value),
          forceTeinte: g.uShadowTintAmt.value,
          vignette: g.uVignette.value,
        },
        bloom: { intensite: bloom.strength, rayon: bloom.radius, seuil: bloom.threshold },
        vent: { intensite: wind.intensity, vitesse: speedCtl.bases.wind, longueur: wind.length },
        paillettes: {
          intensite: sparkles.intensity,
          taille: sparkles.size,
          derive: speedCtl.bases.spark,
          teinte: hex(sparkles.color),
        },
        flare: {
          actif: flare.visible,
          intensite: flare.intensity,
          halo: flare.glowSize,
          chaleur: flare.warmth,
          anneau: flare.ringSize,
          decalageAnneau: flare.ringOffset,
          points: flare.dots,
          x: flare.screen.x,
          y: flare.screen.y,
        },
        trainees: {
          intensite: trails.intensity,
          largeur: trails.width,
          fuite: speedCtl.bases.trail,
        },
        fond: { opacite: farBirds.opacity, taille: farBirds.size, vitesse: farBirds.speed },
        corps: {
          raideur: grab.stiffness,
          amorti: grab.damping,
          inclinaison: grab.tilt,
          rollMain: grab.rollGain,
          vieAuRepos: idle.amount,
          battementCroisiere: flap.cruise,
        },
        battement: { amplitude: flap.amplitude, frequence: flap.frequency },
        vitesse: {
          min: speedCtl.min,
          max: speedCtl.max,
          boostExtra: speedCtl.boost.extra,
          impulsion: speedCtl.boost.impulse,
          dureeVrille: speedCtl.boost.dur,
          avance: speedCtl.boost.sepAmp,
          dureeAvance: speedCtl.boost.sepDur,
        },
        migration: {
          copains: flock.count,
          raideur: flock.stiffness,
          amorti: flock.damping,
          profondeur: flock.spacing,
          largeur: flock.side,
          dispersion: flock.scatter,
          vagabondage: flock.wander,
          battAmp: flock.flapAmp,
          battHz: flock.flapFreq,
          intervalle: flock.arrivalInterval,
          regards: headLook.amount,
          espacementRegards: headLook.interval,
        },
        camRig: {
          suivi: camRig.follow,
          reactivite: camRig.smooth,
          dezoomParCopain: camRig.zoomPerBird,
          fovKick: camRig.fovKick,
        },
        wiggle: Object.fromEntries(
          duck.chains.filter((c) => !c.anchor).map((c) => [c.label, c.stiffness]),
        ),
      },
      null,
      2,
    );
    navigator.clipboard?.writeText(json).catch(() => {});
    console.log("[reglages]\n" + json);
    return json;
  };
  fScene.add({ exporter }, "exporter").name("copier reglages (JSON)");
  fScene.add(controls, "enabled").name("orbit controls");
  fScene.add({ reset: onReset }, "reset").name("tout reinitialiser");

  fWiggle.open();
  fBody.open();
  fPinch.close();
  fRender.close();
  fScene.close();

  return gui;
}
