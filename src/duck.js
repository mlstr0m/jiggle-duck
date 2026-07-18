import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { WiggleBone as WiggleSpringBone } from "wiggle/spring";

/**
 * Chargement du canard + montage du rig wiggle.
 *
 * Regle de la lib : un bone ne wiggle que si son parent est statique. On garde
 * donc figee la racine de chaque chaine et on rend dynamiques ses descendants.
 * Ces racines sont enfants de l'objet Armature, qu'on deplace a la main via le
 * drag — le mouvement se propage alors naturellement dans les chaines.
 */

/**
 * Reglages par chaine. Cle = nom du bone racine (statique).
 *
 * ATTENTION : GLTFLoader assainit les noms de nodes — le `Bone.001` de Blender
 * arrive ici en `Bone001`. On normalise donc avant de chercher, pour que les
 * deux ecritures marchent et que ça ne casse pas au renommage.
 */
/**
 * Anatomie identifiee par centroide des poids de skinning (cf. README).
 *
 * On utilise la variante RESSORT de la lib (`wiggle/spring`), pas la variante
 * lerp : un lerp converge vers sa cible sans jamais la depasser, donc zero
 * rebond quel que soit le reglage. Le ressort overshoote et oscille — c'est ça,
 * le "bouncy". Ratio d'amortissement = damping / (2*sqrt(stiffness)) ;
 * en dessous de 1 ça rebondit, et plus c'est bas plus ça rebondit longtemps.
 */
/**
 * Points anatomiques du rig, par nom de bone — l'AUTORITE unique. Tout code
 * qui a besoin d'un bone precis (cap de vol, emetteurs de trainees, regards)
 * passe par ici : un reexport Blender qui renomme se corrige a UN endroit.
 */
export const RIG = {
  head: "Bone002", // bout du cou : sert au cap de vol et aux regards
  body: "Bone013", // ancre du corps : sert au cap de vol
  wingTips: ["Bone004", "Bone006"], // emetteurs des trainees d'ailes
};

export const CHAIN_PRESETS = {
  Bone001: { label: "Cou + tete", stiffness: 320 },
  Bone003: { label: "Aile gauche", stiffness: 520 },
  Bone005: { label: "Aile droite", stiffness: 520 },
  Bone007: { label: "Patte droite", stiffness: 280 },
  Bone010: { label: "Patte gauche", stiffness: 280 },
  // Le corps est l'ancre : les chaines des membres sont ses SOEURS sous
  // l'armature, pas ses enfants. Le faire wiggler detacherait visuellement le
  // corps des racines des membres. Son "wiggle" a lui, c'est le ressort de
  // position + l'inclinaison dans GrabController.
  Bone013: { label: "Corps (ancre statique)", anchor: true },
};

const normalizeName = (name) => name.replace(/[^a-zA-Z0-9]/g, "");

/**
 * Butee d'angle des wiggle bones : les springs de la lib n'ont AUCUNE limite,
 * et au-dela de ~90 degres un cou a l'air casse (constate sur les copains de
 * la volee, dont le suivi genere de plus grosses accelerations que le drag du
 * leader). On borne la deviation par rapport a la rest pose — purement visuel,
 * l'etat interne du spring n'est pas touche et reprend la main des que la
 * deviation redescend.
 */
export const MAX_BEND = 1.0; // rad (~57 degres)
const _qClamp = new THREE.Quaternion();

export function clampBend(bone, rest, maxBend = MAX_BEND) {
  _qClamp.copy(rest).rotateTowards(bone.quaternion, maxBend);
  bone.quaternion.copy(_qClamp);
}

const DEFAULT_STIFFNESS = 400;
export const DEFAULT_DAMPING = 13;

export class Duck {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = "DuckRoot";

    this.gltf = null;
    this.skinnedMesh = null;
    this.skeleton = null;
    this.material = null;

    /** @type {Array<{root:THREE.Bone, bones:THREE.Bone[], dynamic:THREE.Bone[], label:string, velocity:number}>} */
    this.chains = [];
    /** @type {Array<{bone:THREE.Bone, wiggle:WiggleBone, chain:object}>} */
    this.wiggleBones = [];

    this.warnings = [];
  }

  async load(url, renderer = null) {
    const loader = new GLTFLoader();
    // Le GLB est compresse EXT_meshopt_compression : sans ce decodeur,
    // GLTFLoader rejette le fichier.
    loader.setMeshoptDecoder(MeshoptDecoder);
    // Textures KTX2/Basis : ~6x moins de VRAM et de bande passante que les
    // WebP decompresses (16.8 -> 2.8 Mo pour les 3 textures) — le poste qui
    // fait le plus mal aux vieux GPU integres. detectSupport choisit le
    // format GPU natif (ASTC/ETC2/BC7/S3TC) selon la machine.
    if (renderer) {
      const ktx2 = new KTX2Loader().setTranscoderPath("./basis/").detectSupport(renderer);
      loader.setKTX2Loader(ktx2);
    }

    const gltf = await loader.loadAsync(url);
    this.gltf = gltf;
    this.root.add(gltf.scene);

    gltf.scene.traverse((obj) => {
      if (obj.isSkinnedMesh && !this.skinnedMesh) {
        this.skinnedMesh = obj;
        this.skeleton = obj.skeleton;
        this.material = obj.material;
      }
    });

    if (!this.skinnedMesh) throw new Error("Aucun SkinnedMesh dans le GLB.");

    // Culling ACTIF avec une sphere gonflee : la geometrie est partagee par
    // les 6 oiseaux (leader + volee clonee), et les copains passent leur temps
    // hors champ avec la formation elargie — les dessiner quand meme coutait
    // 6 passes de skinning GPU systematiques. Le x1.6 couvre les deformations
    // wiggle au-dela de la rest pose. (La sphere de raycast, elle, est geree
    // dans GrabController.tryGrab — SkinnedMesh.raycast utilise
    // mesh.boundingSphere, pas geometry.boundingSphere.)
    this.skinnedMesh.geometry.computeBoundingSphere();
    this.skinnedMesh.geometry.boundingSphere.radius *= 1.6;
    this.skinnedMesh.frustumCulled = true;

    // Mesh ferme : le double face du GLB doublait le cout fragment de chaque
    // oiseau pour rien (panneau "double face" pour reactiver au besoin).
    this.material.side = THREE.FrontSide;

    this._recenter();
    this._buildChains();
    this._audit();

    // Clone VIERGE du rig, capture AVANT tout montage wiggle. Indispensable
    // pour la volee : la lib wiggle insere des bones "wrapper" dans la
    // hierarchie et remet les positions locales a zero a chaque frame —
    // cloner le leader deja wigglé embarque ces wrappers plus un offset
    // transitoire fige en pleine oscillation (= cous allonges en permanence
    // et visee des springs corrompue, constate sur les copains).
    this.pristineScene = skeletonClone(this.gltf.scene);

    return this;
  }

  /** Recentre le canard sur l'origine et le ramene a une taille de travail. */
  _recenter() {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    this.size = size;
    this.gltf.scene.position.sub(center);
    this.root.updateMatrixWorld(true);
  }

  /**
   * Une chaine = un bone dont le parent n'est pas un bone (racine statique),
   * plus toute sa descendance (dynamique).
   */
  _buildChains() {
    const boneSet = new Set(this.skeleton.bones);
    const roots = this.skeleton.bones.filter((b) => !boneSet.has(b.parent));

    for (const rootBone of roots) {
      const bones = [];
      rootBone.traverse((b) => {
        if (b.isBone) bones.push(b);
      });

      const preset = CHAIN_PRESETS[normalizeName(rootBone.name)] ?? {};
      this.chains.push({
        root: rootBone,
        bones,
        dynamic: bones.filter((b) => b !== rootBone),
        label: preset.label ?? rootBone.name,
        stiffness: preset.stiffness ?? DEFAULT_STIFFNESS,
        damping: preset.damping ?? DEFAULT_DAMPING,
        anchor: preset.anchor ?? false,
      });
    }
  }

  /**
   * Instancie les WiggleBone. A appeler APRES que le canard soit dans la scene
   * et les matrices monde a jour : le constructeur lit des positions monde.
   *
   * Ordre parent -> enfant obligatoire. WiggleBone reparente sa cible sous un
   * wrapper clone ; construire un enfant avant son parent donnerait une
   * hierarchie incoherente.
   */
  buildWiggle() {
    this.disposeWiggle();
    this.root.updateMatrixWorld(true);

    for (const chain of this.chains) {
      // Garde-fou : si le corps est un jour subdivise dans Blender, il ne doit
      // pas se mettre a wiggler pour autant — c'est l'ancre du systeme.
      if (chain.anchor) continue;

      for (const bone of chain.dynamic) {
        const rest = bone.quaternion.clone(); // AVANT le wrap wiggle : rest pose
        const wiggle = new WiggleSpringBone(bone, {
          stiffness: chain.stiffness,
          damping: chain.damping,
        });
        this.wiggleBones.push({ bone, wiggle, chain, rest });
      }
    }
    return this.wiggleBones.length;
  }

  disposeWiggle() {
    // Ordre inverse : chaque dispose() restaure la hierarchie d'origine, il
    // faut defaire les enfants avant les parents.
    for (let i = this.wiggleBones.length - 1; i >= 0; i--) {
      this.wiggleBones[i].wiggle.dispose();
    }
    this.wiggleBones.length = 0;
  }

  /** Met a jour les ressorts d'une chaine a chaud (les 3 axes de chaque bone). */
  setChainParams(chain, { stiffness, damping }) {
    if (stiffness !== undefined) chain.stiffness = stiffness;
    if (damping !== undefined) chain.damping = damping;
    const cfg = { stiffness: chain.stiffness, damping: chain.damping };
    for (const wb of this.wiggleBones) {
      if (wb.chain !== chain) continue;
      wb.wiggle.springX.updateConfig(cfg);
      wb.wiggle.springY.updateConfig(cfg);
      wb.wiggle.springZ.updateConfig(cfg);
    }
  }

  reset() {
    for (const wb of this.wiggleBones) wb.wiggle.reset();
  }

  update(dt) {
    for (const wb of this.wiggleBones) {
      wb.wiggle.update(dt);
      clampBend(wb.bone, wb.rest);
    }
  }

  /** Signale les problemes de rig qui se voient dans la donnee, pas a l'oeil. */
  _audit() {
    const w = this.warnings;

    for (const chain of this.chains) {
      // Une chaine d'ancrage est censee etre inerte : ce n'est pas un defaut.
      if (chain.anchor) continue;

      if (chain.dynamic.length === 0) {
        w.push(
          `${chain.label} : chaine d'un seul bone, elle ne wigglera JAMAIS. Subdiviser dans Blender.`,
        );
      } else if (chain.dynamic.length === 1) {
        w.push(
          `${chain.label} : un seul segment dynamique -> mouvement de charniere. Viser 3-4 bones.`,
        );
      }
    }

    const geo = this.skinnedMesh.geometry;
    if (geo.getAttribute("color1") || geo.getAttribute("COLOR_1")) {
      w.push("Deux couches de vertex colors exportees ; three.js n'en lit qu'une.");
    }
    if (geo.getAttribute("color") && this.material.vertexColors) {
      w.push(
        "Vertex colors actives : elles multiplient la base color (canard potentiellement assombri).",
      );
    }
    if (!this.material.normalMap) {
      w.push("Pas de normal map (texture absente du GLB) — reexport Blender requis.");
    }
    return w;
  }
}
