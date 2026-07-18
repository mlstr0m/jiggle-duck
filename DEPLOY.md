# Déployer Jiggle Duck (serveur interne)

Le build est un **dossier statique autonome** : pas de backend, pas de base de
données, pas de variable d'environnement. Tout tourne dans le navigateur du
visiteur (le flux webcam ne quitte jamais sa machine). Les chemins sont
relatifs : le dossier fonctionne à la racine d'un domaine, sous un sous-chemin
(`https://intranet/jiggle-duck/`), peu importe.

## 1. Construire

```bash
npm ci
npm run build        # -> dist/ (~35 Mo, dont 33 de wasm MediaPipe + modèle)
```

C'est **le dossier `dist/` qu'on déploie**, rien d'autre.

## 2. Servir — trois options, de la plus simple à la plus propre

### Option A — n'importe quel serveur web existant

Copier `dist/` où le serveur sert des fichiers, c'est tout :

```bash
scp -r dist/ serveur:/var/www/jiggle-duck/
```

Seule exigence : que `.wasm` soit servi en `application/wasm` (nginx et Apache
récents le font par défaut ; voir `deploy/nginx.conf` sinon).

### Option B — un serveur en une commande (démo rapide)

```bash
npx serve dist          # http://localhost:3000
# ou, sans npm sur la machine cible :
python3 -m http.server 8080 --directory dist
```

### Option C — Docker (si l'infra interne préfère les conteneurs)

```bash
docker build -t jiggle-duck .
docker run -p 8080:80 jiggle-duck
```

Image nginx-alpine ~50 Mo, config incluse (MIME wasm, gzip, cache long sur
les assets fingerprintés).

## ⚠️ Le piège du déploiement interne : HTTPS et la webcam

`getUserMedia` (la webcam, donc le tracking des mains) n'est autorisé par les
navigateurs **qu'en contexte sécurisé** : `https://` ou `localhost`.

- `http://10.x.x.x:8080` ou `http://monserveur.local` → **webcam bloquée**.
  L'app le détecte et l'affiche à l'utilisateur (le canard reste manipulable
  à la souris), mais l'expérience principale est perdue.
- Solutions, au choix de l'infra : un reverse proxy TLS devant (certificat
  interne ou Let's Encrypt), ou un tunnel type Tailscale/cloudflared qui
  fournit du https sans toucher au serveur.

**En résumé : prévoir une URL en https, c'est la seule vraie contrainte.**

## Mode debug

L'interface publique est nue (pas de panneau de réglages, pas de HUD), et le
code du panneau n'est **même pas téléchargé** par les visiteurs (chunk séparé).
Terminer l'URL par `#debug` fait tout apparaître :
`https://…/jiggle-duck/#debug`

Le workflow de réglage : ajuster au panneau → bouton « copier reglages
(JSON) » → coller l'objet dans `src/settings.js` → rebuild. Ce fichier est la
source de vérité unique de toutes les valeurs artistiques.

## Regénérer l'asset canard (si réexport Blender)

```bash
# depose le nouveau duck.glb dans assets-src/ puis :
npm run patch:glb    # patch normal map + compression textures KTX2
# (nécessite toktx — KTX-Software — dans le PATH)
```

## Desktop uniquement

Decision produit : l'experience est bloquee sur mobile/tablette (message
propre AVANT tout telechargement — un visiteur mobile ne coute que quelques
Ko). Rien a configurer cote serveur.

## Checklist avant d'ouvrir aux gens

- [ ] URL en **https** (webcam)
- [ ] La page charge et le canard s'affiche (test sans webcam OK)
- [ ] Test webcam : pincer attrape le canard
- [ ] Test sur une machine modeste : le HUD (`#debug`) doit se stabiliser à
      ~60 fps sur un palier de qualité quelconque
- [ ] Chrome + Firefox + Safari récents
