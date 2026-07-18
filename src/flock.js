import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { WiggleBone as WiggleSpringBone } from "wiggle/spring";
import { clampBend, RIG } from "./duck.js";

/**
 * La migration : des copains qui volent en formation derriere le canard.
 *
 * - Chaque copain est un clone COMPLET du canard (SkeletonUtils.clone — un
 *   clone naif d'un SkinnedMesh partagerait le squelette de l'original et
 *   toutes les copies bougeraient d'un bloc).
 * - Chaque copain a ses propres wiggle springs (memes chaines que le leader)
 *   et bat des ailes en continu — ils migrent — avec une phase et une cadence
 *   propres pour eviter l'effet armee de clones.
 * - Formation en V : chaque copain vise un slot derriere le leader via un
 *   ressort amorti, avec une raideur DECROISSANTE le long du V — le bout de
 *   la formation traine et fouette, comme une vraie volee. Deplacer le canard
 *   tire donc toute la migration avec des retards en cascade.
 * - Inclinaison par la vitesse (comme le leader) + houle idle pour qu'ils
 *   vivent meme a l'arret.
 */
export class Flock {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./duck.js').Duck} duck   Le leader (deja charge, wiggle monte).
   * @param {import('./flap.js').FlapController} flap  Pour les axes d'ailes calibres.
   * @param {THREE.Vector3} restForward       Avant du canard au repos (monde).
   */
  constructor(scene, duck, flap, restForward, trails = null, camera = null, headLook = null) {
    this.scene = scene;
    this.duck = duck;
    this.flap = flap;
    this.trails = trails;
    this.camera = camera;

    this.count = 5;
    this.spacing = 1.35; // profondeur d'un rang du V — large : la profondeur
    this.side = 1.4; // demi-largeur d'un rang — vient de la VRAIE distance
    this.drop = 0.22; // descente par rang : la volee vole SOUS le leader,
    // sinon le 1er rang traverse le cadre de la camera par defaut (qui
    // regarde depuis l'arriere, exactement la ou la formation s'etend)
    this.scatter = 1.2; // jitter aleatoire fige par copain (regle par Aurelien)
    this.wander = 0.6; // derive lente autour du slot (regle par Aurelien)
    this.stiffness = 55; // raideur de suivi du 1er rang
    // Bien amorti (ratio ~0.88) : un suivi sous-amorti pres de la resonance
    // fouette les copains et leur casse le cou via les springs wiggle.
    this.damping = 13;
    this.flapAmp = 0.5; // battement de croisiere
    this.flapFreq = 2.6; // Hz
    this.speedScale = 1; // cadence x vitesse de vol (pilote par main.js)
    this._flapPhase = 0; // phase ACCUMULEE : la cadence peut varier sans saut

    // — Arrivees progressives : on demarre seul, les copains rejoignent la
    // migration un par un, en volant depuis l'arriere (c'est le ressort de
    // suivi qui fait l'animation d'arrivee, gratuitement).
    this.arrivalDelay = 6; // premiere arrivee (s apres le debut)
    this.arrivalInterval = 7; // puis une arrivee toutes les N secondes
    this.active = 0;
    this.onArrival = null; // callback(activeCount) — camera etc.
    this._nextArrival = Infinity; // arme par beginArrivals() au lancement

    this._fwd = restForward.clone().normalize();
    this._side = new THREE.Vector3(-this._fwd.z, 0, this._fwd.x); // perpendiculaire a plat

    /** @type {Array<object>} */
    this.buddies = [];
    this._t = 0;
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();

    // Noms des bones utiles, releves une fois sur le leader.
    this._dynamicByChain = duck.chains
      .filter((c) => !c.anchor)
      .map((c) => ({
        stiffness: c.stiffness,
        damping: c.damping,
        names: c.dynamic.map((b) => b.name),
      }));
    this._wingInfo = flap.wings.map((w) => ({
      name: w.root.name,
      axis: w.axis.clone(),
      sign: w.sign,
    }));
    // regards : noms de la chaine du cou, releves sur le leader
    this.headLook = headLook;
    const neck = duck.chains.find((c) => c.label.startsWith("Cou"));
    this._neckNames = neck
      ? { root: neck.root.name, tip: (neck.dynamic[0] ?? neck.root).name }
      : null;

    this.rebuild();
  }

  _slotOffset(i) {
    // V alterne : 1er a droite, 2e a gauche, 3e a droite un rang plus loin...
    // + un jitter aleatoire fige par copain : une volee, pas une parade.
    const row = Math.floor(i / 2) + 1;
    const side = i % 2 === 0 ? 1 : -1;
    const j = () => (Math.random() * 2 - 1) * this.scatter;
    return new THREE.Vector3()
      .addScaledVector(this._fwd, -this.spacing * row + j())
      .addScaledVector(this._side, side * this.side * row + j())
      .add(new THREE.Vector3(0, -this.drop * row + j() * 0.4, 0));
  }

  rebuild() {
    // Un rebuild de REGLAGE (sliders du panneau) ne doit pas faire
    // disparaitre la volee ni rejouer toutes les arrivees : on capture
    // l'etat d'activation avant dispose() (qui le remet a zero) et on
    // reactive le meme nombre de copains, deja poses sur leurs slots.
    const wasActive = Math.min(this.active, this.count);
    const wasArmed = Number.isFinite(this._nextArrival); // arrivees lancees ?
    this.dispose();

    for (let i = 0; i < this.count; i++) {
      const root = new THREE.Group();
      // Clone du rig VIERGE (pristineScene), jamais du leader vivant : le
      // leader wigglé contient des bones wrapper et des positions transitoires
      // remises a zero — les cloner donnait des cous allonges en permanence
      // et une visee de springs corrompue.
      const model = skeletonClone(this.duck.pristineScene);
      root.add(model);
      // PAS de scale : la lib wiggle travaille en positions monde et se casse
      // sous une armature scalee (meme piege que le scale d'armature a
      // l'export Blender). La profondeur vient de la vraie distance des slots.
      root.visible = false; // invisible jusqu'a son arrivee dans la migration
      this.scene.add(root);

      let skinned = null;
      model.traverse((o) => {
        if (o.isSkinnedMesh && !skinned) skinned = o;
      });
      // culling actif : la geometrie partagee porte deja la sphere gonflee
      // (cf. duck.js) — un copain hors champ ne coute plus rien au GPU
      skinned.frustumCulled = true;
      const bones = skinned.skeleton.bones;
      const byName = new Map(bones.map((b) => [b.name, b]));

      const offset = this._slotOffset(i);
      root.position.copy(this.duck.root.position).add(offset);
      root.updateMatrixWorld(true);

      // wiggle : memes chaines que le leader, sur les bones du clone.
      // Ordre parent -> enfant deja garanti par la traversee d'origine.
      const wiggles = [];
      for (const chain of this._dynamicByChain) {
        for (const name of chain.names) {
          const bone = byName.get(name);
          if (bone) {
            const rest = bone.quaternion.clone(); // avant le wrap wiggle
            wiggles.push({
              bone,
              rest,
              wiggle: new WiggleSpringBone(bone, {
                stiffness: chain.stiffness,
                damping: chain.damping,
              }),
            });
          }
        }
      }

      // ailes : rest pose + axe calibre du leader (meme rig)
      const wings = this._wingInfo
        .map((w) => {
          const bone = byName.get(w.name);
          return bone ? { bone, rest: bone.quaternion.clone(), axis: w.axis, sign: w.sign } : null;
        })
        .filter(Boolean);

      // bouts d'ailes : emetteurs des trainees
      const wingTips = RIG.wingTips.map((n) => byName.get(n)).filter(Boolean);

      // regards : chaque copain observe autour de lui a son rythme
      let headEntry = null;
      if (this.headLook && this._neckNames) {
        const neckBone = byName.get(this._neckNames.root);
        if (neckBone)
          headEntry = this.headLook.attach(neckBone, byName.get(this._neckNames.tip) ?? neckBone);
      }

      this.buddies.push({
        root,
        offset,
        wiggles,
        wings,
        wingTips,
        headEntry,
        vel: new THREE.Vector3(),
        // le fond du V suit plus mou : retards en cascade quand le leader bouge
        k: this.stiffness / (1 + Math.floor(i / 2) * 0.45),
        phase: Math.random() * Math.PI * 2,
        freqMul: 0.9 + Math.random() * 0.25,
        bobPhase: Math.random() * Math.PI * 2,
        // derive lente pseudo-aleatoire autour du slot : chacun vit sa vie
        // tout en suivant la trame (frequences propres par axe, tres basses)
        wanderF: [
          0.11 + Math.random() * 0.16,
          0.07 + Math.random() * 0.12,
          0.09 + Math.random() * 0.14,
        ],
        wanderP: [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28],
        // battement personnel : certains battent fort, d'autres planent
        flapMul: 0.6 + Math.random() * 0.7,
        trailHandles: [],
      });
    }

    // reactivation IMMEDIATE des copains deja arrives : deja poses sur leurs
    // slots (pas de re-entree en vol), avec leurs trainees d'ailes
    for (let i = 0; i < wasActive; i++) {
      const b = this.buddies[i];
      b.root.visible = true;
      if (this.trails) {
        for (const tip of b.wingTips) {
          b.trailHandles.push(this.trails.attach(tip, 0.4 * b.flapMul));
        }
      }
    }
    this.active = wasActive;
    // et le planning d'arrivee reprend pour les suivants — avant ce fix, un
    // rebuild en cours de session le desarmait definitivement (Infinity)
    this._nextArrival = wasArmed ? this._t + this.arrivalInterval : Infinity;
  }

  /** Arme le compte a rebours des arrivees (appele au lancement de l'experience). */
  beginArrivals() {
    this._nextArrival = this._t + this.arrivalDelay;
  }

  /** Fait rejoindre le prochain copain : il arrive en volant depuis l'arriere. */
  _activate(leaderPos) {
    const b = this.buddies[this.active];
    if (!b) return;
    b.root.visible = true;
    // Spawn HORS CHAMP : derriere le plan de camera (garanti hors frustum),
    // decale lateralement selon le cote de son slot et un peu plus bas. Le
    // ressort de suivi le fait alors DEPASSER la camera et rejoindre son slot
    // — on le voit arriver, jamais apparaitre.
    if (this.camera) {
      const camDir = new THREE.Vector3();
      this.camera.getWorldDirection(camDir);
      b.root.position
        .copy(this.camera.position)
        .addScaledVector(camDir, -2.5 - Math.random() * 1.5)
        .addScaledVector(
          this._side,
          Math.sign(b.offset.dot(this._side) || 1) * (1.3 + Math.random() * 0.8),
        );
      b.root.position.y -= 0.7 + Math.random() * 0.5;
    } else {
      // fallback sans camera : loin derriere son slot
      b.root.position.copy(leaderPos).add(b.offset).addScaledVector(this._fwd, -5);
    }
    b.vel.set(0, 0, 0);
    b.root.updateMatrixWorld(true);
    for (const wb of b.wiggles) wb.wiggle.reset();

    if (this.trails) {
      for (const tip of b.wingTips) {
        b.trailHandles.push(this.trails.attach(tip, 0.4 * b.flapMul));
      }
    }

    this.active++;
    this.onArrival?.(this.active);
  }

  update(dt, leaderPos) {
    this._t += dt;
    this._flapPhase += dt * this.flapFreq * Math.PI * 2 * this.speedScale;

    // arrivees progressives
    if (this.active < this.buddies.length && this._t >= this._nextArrival) {
      this._activate(leaderPos);
      this._nextArrival = this._t + this.arrivalInterval;
    }

    for (let bi = 0; bi < this.active; bi++) {
      const b = this.buddies[bi];
      // — suivi ressort du slot de formation —
      const target = this._v.copy(leaderPos).add(b.offset);
      // houle idle : ils respirent meme quand le leader est immobile
      target.y += Math.sin(this._t * 1.3 + b.bobPhase) * 0.035;
      // derive lente autour du slot : comportement individuel dans la trame
      target.x += Math.sin(this._t * b.wanderF[0] * 6.28 + b.wanderP[0]) * this.wander;
      target.y += Math.sin(this._t * b.wanderF[1] * 6.28 + b.wanderP[1]) * this.wander * 0.5;
      target.z += Math.sin(this._t * b.wanderF[2] * 6.28 + b.wanderP[2]) * this.wander;

      const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      const h = dt / steps;
      for (let s = 0; s < steps; s++) {
        const ax = (target.x - b.root.position.x) * b.k - b.vel.x * this.damping;
        const ay = (target.y - b.root.position.y) * b.k - b.vel.y * this.damping;
        const az = (target.z - b.root.position.z) * b.k - b.vel.z * this.damping;
        b.vel.x += ax * h;
        b.vel.y += ay * h;
        b.vel.z += az * h;
        b.vel.clampLength(0, 3.0); // borne le fouet lors des gros a-coups
        b.root.position.addScaledVector(b.vel, h);
      }

      // — inclinaison par la vitesse, comme le leader —
      const clamp = (x) => Math.max(-0.45, Math.min(0.45, x));
      this._e.set(clamp(b.vel.y * 0.5), 0, clamp(-b.vel.x * 0.7));
      this._q.setFromEuler(this._e);
      b.root.quaternion.slerp(this._q, Math.min(1, dt * 8));

      // — battement de croisiere, desynchronise et personnalise par copain,
      // avec une modulation tres lente : parfois ça plane, parfois ça rame —
      const liveAmp =
        this.flapAmp * b.flapMul * (0.75 + 0.35 * Math.sin(this._t * 0.09 * 6.28 + b.bobPhase));
      const theta = liveAmp * (0.35 + Math.sin(this._flapPhase * b.freqMul + b.phase));
      for (const w of b.wings) {
        this._q.setFromAxisAngle(w.axis, w.sign * theta);
        w.bone.quaternion.copy(w.rest).multiply(this._q);
      }

      // — vie secondaire, avec la meme butee d'angle que le leader —
      for (const wb of b.wiggles) {
        wb.wiggle.update(dt);
        clampBend(wb.bone, wb.rest);
      }
    }
  }

  dispose() {
    for (const b of this.buddies) {
      // ordre inverse : defaire les enfants avant les parents
      for (let i = b.wiggles.length - 1; i >= 0; i--) b.wiggles[i].wiggle.dispose();
      if (this.trails) for (const h of b.trailHandles) this.trails.remove(h);
      if (this.headLook && b.headEntry) this.headLook.remove(b.headEntry);
      this.scene.remove(b.root);
    }
    this.buddies = [];
    this.active = 0;
  }
}
