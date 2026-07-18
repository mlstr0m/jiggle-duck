import { defineConfig } from "vite";

export default defineConfig({
  // base relative : le dossier dist/ est relogeable tel quel n'importe ou
  // (racine du serveur, sous-chemin /jiggle-duck/, meme file://). Condition
  // sine qua non pour un deploiement interne dont on ne connait pas l'URL.
  base: "./",
  // host: true = ecoute IPv4 + IPv6 + reseau local. Sans ça, Vite peut se
  // retrouver bind sur [::1] seul (IPv6) et "localhost" refuse la connexion
  // selon la resolution du navigateur. Bonus : testable depuis un telephone
  // via l'URL "Network" affichee au demarrage (utile pour la webcam mobile).
  server: { host: true, port: 5173, open: false },
  // Le wasm MediaPipe fait ~11 Mo : on evite que Vite tente de l'inliner.
  assetsInclude: ["**/*.task"],
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
