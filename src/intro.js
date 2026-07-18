import * as THREE from "three";

/**
 * Sequence d'ouverture : iris shader ("fenetre qui se repand" sur le ciel),
 * leger dezoom camera vers le cadrage par defaut, et le leader qui GLISSE
 * dans le champ depuis sous le bord bas de l'ecran.
 *
 * L'entree du canard n'est pas une cinematique : on pose le spawn hors
 * champ, la cible du ressort de corps reste au spawn pendant birdDelay puis
 * redevient le point d'arrivee — le ressort ADOUCI fait la montee avec un
 * leger depassement, et le wiggle anime tout le reste gratuitement.
 *
 * Pendant toute la sequence, la camera suit le HOME et pas le canard (sinon
 * elle plongerait vers le spawn puis remonterait avec lui — constate), et
 * la 2e main est ignoree (pas de vrille pendant l'entree).
 */
export function createIntro({ camera, controls, duck, grab, idle, flock, grade }) {
  grade.material.uniforms.uReveal.value = 0; // noir tant que pas lance

  const intro = {
    active: false,
    started: false,
    t: 0,
    dur: 2.8, // iris
    camDur: 3.4, // dezoom camera
    camFrom: 0.82, // zoom de depart (fraction de la distance par defaut)
    birdDelay: 1.0, // le canard attend sous le champ
    birdDur: 3.4, // puis monte en douceur
    spawn: new THREE.Vector3(),
    _camZoom: 1,
    _savedK: 0,
    _savedD: 0,

    start() {
      if (this.started) return;
      this.started = true;
      this.active = true;
      this.t = 0;

      // spawn garanti HORS CHAMP : sous le bord bas du cadre, a la
      // profondeur du point d'arrivee, calcule AVANT le zoom-in d'intro
      // (le cadre final est le plus large) — l'oiseau glisse ensuite dedans
      camera.updateMatrixWorld();
      const homeNdc = idle.home.clone().project(camera);
      this.spawn.set(homeNdc.x + 0.1, -1.45, homeNdc.z).unproject(camera);
      duck.root.position.copy(this.spawn);
      grab.velocity.set(0, 0, 0);
      // cible du ressort explicitement au point d'arrivee : l'entree ne
      // depend d'aucun ordre d'initialisation de frames
      grab.setDesired(idle.home);
      // ressort ADOUCI le temps de l'entree : a 14/7 le canard monte
      // gracieusement en ~3 s avec un leger depassement, puis on restaure
      this._savedK = grab.stiffness;
      this._savedD = grab.damping;
      grab.stiffness = 14;
      grab.damping = 7;
      // camera serree au depart : le dezoom se joue dans update()
      this._camZoom = this.camFrom;
      camera.position.sub(controls.target).multiplyScalar(this.camFrom).add(controls.target);

      flock.beginArrivals();
    },

    update(dt) {
      if (!this.active) return;
      this.t += dt;

      const k = Math.min(1, this.t / this.dur);
      grade.material.uniforms.uReveal.value = 1 - Math.pow(1 - k, 3); // easeOutCubic

      // dezoom : scaling RELATIF de l'offset camera-cible, comme le camRig
      // — les deux cohabitent sans se marcher dessus
      const kc = Math.min(1, this.t / this.camDur);
      const z = this.camFrom + (1 - this.camFrom) * (1 - Math.pow(1 - kc, 3));
      if (Math.abs(z - this._camZoom) > 1e-6) {
        camera.position
          .sub(controls.target)
          .multiplyScalar(z / this._camZoom)
          .add(controls.target);
        this._camZoom = z;
      }

      // l'oiseau patiente sous le champ, puis sa cible redevient home (posee
      // par la vie au repos) et le ressort doux le fait monter
      if (this.t < this.birdDelay) grab.desired.copy(this.spawn);

      if (this.t >= Math.max(this.dur, this.camDur, this.birdDelay + this.birdDur)) {
        this.active = false;
        grab.stiffness = this._savedK; // fin d'entree : le grab redevient reactif
        grab.damping = this._savedD;
      }
    },
  };

  return intro;
}
