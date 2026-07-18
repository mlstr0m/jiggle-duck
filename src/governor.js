/**
 * Gouverneur de qualite adaptatif.
 *
 * Les reglages par defaut sont calibres sur une machine recente ; sur un
 * vieux Mac/PC ils donnent 20 fps et un GPU qui chauffe. Plutot que de
 * degrader tout le monde, on mesure le temps de frame reel et on descend
 * l'echelle par paliers jusqu'a tenir 60 fps — puis on y reste (remontee
 * tres prudente pour eviter le yo-yo, et pour que la machine ne chauffe
 * pas en tournant en permanence a la limite).
 *
 * Ordre des paliers = rapport gain-perf / degat-visuel : d'abord la
 * resolution du ciel (le poste dominant), puis les pas de raymarch, puis
 * le pixel ratio, et le bloom en dernier recours.
 */
export function createGovernor({ renderer, composer, bloom, sky, skyRes, rebuildSkyRT }) {
  const dpr = window.devicePixelRatio || 1;

  const quality = {
    auto: true,
    level: 0,
    levels: [
      { name: "ultra", sky: 0.65, steps: 40, pr: Math.min(dpr, 2), bloom: true },
      { name: "haute", sky: 0.5, steps: 28, pr: Math.min(dpr, 2), bloom: true },
      { name: "moyenne", sky: 0.45, steps: 22, pr: Math.min(dpr, 1.5), bloom: true },
      // Planchers de resolution ciel RELEVES (0.42/0.35, ex 0.35/0.28) : en
      // dessous, le jitter anti-banding du raymarch upscale devient un gros
      // grain en blocs sur les nuages (constate en capture). On compense par
      // moins de pas de marche — moins visible que la bouillie de pixels.
      { name: "basse", sky: 0.42, steps: 14, pr: Math.min(dpr, 1.25), bloom: false },
      { name: "mini", sky: 0.35, steps: 10, pr: 1, bloom: false },
    ],
    /** Callback optionnel (niveau) — main s'en sert pour degrader MediaPipe. */
    onApply: null,
    apply(i) {
      this.level = Math.max(0, Math.min(this.levels.length - 1, i));
      const L = this.levels[this.level];
      skyRes.scale = L.sky;
      sky.uniforms.uSteps.value = L.steps;
      renderer.setPixelRatio(L.pr);
      composer.setPixelRatio(L.pr);
      bloom.enabled = L.bloom;
      rebuildSkyRT();
      this.onApply?.(this.level);
    },
  };

  let qAvg = 16.7; // EMA du temps de frame (ms)
  let qCooldown = 0; // anti-oscillation apres un changement
  let qOver = 0; // temps passe EN SURCHARGE avant de descendre
  let qUpStable = 0; // temps passe avec de la marge avant de REMONTER
  let qWarmup = 3; // ignore les premieres secondes (compil shaders, caches)

  const govern = (rawDt) => {
    if (!quality.auto) return;
    // onglet en arriere-plan ou hoquet systeme : pas un signal de perf GPU
    if (rawDt > 0.1) return;
    if ((qWarmup -= rawDt) > 0) return;

    qAvg += (rawDt * 1000 - qAvg) * 0.05; // ~20 frames de lissage
    qCooldown -= rawDt;
    if (qCooldown > 0) return;

    if (qAvg > 17.5 && quality.level < quality.levels.length - 1) {
      // surcharge SOUTENUE (1.2 s) avant de descendre : un hoquet passager
      // (retour d'onglet, GC, autre appli) ne doit pas degrader le visuel
      qOver += rawDt;
      qUpStable = 0;
      if (qOver > 1.2) {
        quality.apply(quality.level + 1);
        qCooldown = 2.5;
        qAvg = 16;
        qOver = 0;
      }
    } else if (qAvg < 14 && quality.level > 0) {
      // marge confortable soutenue 8 s -> on remonte d'un cran (une descente
      // injustifiee se corrige vite, le yo-yo reste impossible grace au seuil
      // d'ecart 14/17.5 + le cooldown)
      qOver = 0;
      qUpStable += rawDt;
      if (qUpStable > 8) {
        quality.apply(quality.level - 1);
        qCooldown = 4;
        qAvg = 16;
        qUpStable = 0;
      }
    } else {
      qOver = 0;
      qUpStable = 0;
    }
  };

  return { quality, govern };
}
