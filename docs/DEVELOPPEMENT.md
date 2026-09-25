# Modifier et compiler le projet

Ce guide explique comment récupérer le code, le lancer, le modifier et fabriquer les installeurs du launcher et de l'application admin.

## Ce qu'il faut installer

- Node.js 20 ou plus récent (avec npm). Le projet a été développé avec Node 24.
- Git.
- Windows pour fabriquer les installeurs `.exe`. Les cibles macOS (`dmg`) et Linux (`AppImage`) sont configurées, mais elles n'ont pas été testées.

Java n'est pas nécessaire pour développer : le launcher télécharge lui-même celui qu'il lui faut.

## Récupérer le code

```bash
git clone https://github.com/yvanb26/modcraft-deploy.git
cd modcraft-deploy
```

Il y a trois projets indépendants, chacun avec son `package.json` : `api/`, `launcher/` et `admin/`. Il faut faire `npm install` dans chacun de ceux que vous voulez utiliser.

```bash
cd api && npm install && cd ..
cd launcher && npm install && cd ..
cd admin && npm install && cd ..
```

## Lancer en mode développement

Sous Windows, `compiler.cmd` (à la racine) ouvre un petit menu qui lance tout ce qui suit :

1. compiler le launcher,
2. compiler l'admin,
3. lancer le launcher sans compiler,
4. lancer l'admin sans compiler,
5. lancer l'API en local.

Sans le menu, les commandes sont celles-ci :

```bash
# API
cd api
cp .env.example .env       # puis changez LAUNCHER_KEY et JWT_SECRET
npm start                  # http://localhost:8787

# Launcher
cd launcher
cp launcher.config.example.json launcher.config.json   # même launcherKey que api/.env
npm start

# Admin
cd admin
npm start
```

En développement, l'admin travaille directement sur le dossier `api/` du dépôt.

## Où modifier quoi

| Je veux changer | Où regarder |
|---|---|
| L'apparence du launcher | `launcher/src/renderer/` (`index.html`, `styles.css`, `renderer.js`) |
| Les textes et traductions du launcher | `launcher/src/renderer/locales.js` |
| La connexion, le lancement du jeu, les loaders | `launcher/src/main/` (dossiers `auth/` et `core/`) |
| L'interface de l'admin | `admin/src/renderer/` |
| Ce que fait l'admin (envoi SFTP, génération du serveur Minecraft...) | `admin/src/main/core/` |
| Les routes de l'API, la whitelist | `api/src/` |
| La génération du manifest | `api/scripts/generate-manifest.js` |
| La config d'exemple (serveurs, branding, annonces) | `api/data/` |

Les deux applications ont une fenêtre (processus « renderer ») isolée du reste : elle ne parle au système que par les fonctions exposées dans `preload.js`, via des appels IPC déclarés dans `ipc.js`. Si vous ajoutez une fonctionnalité qui touche aux fichiers ou au réseau, elle va dans `src/main/`, et le renderer l'appelle par IPC.

`fileAllowlist.js` existe en trois exemplaires identiques (`admin/`, `api/scripts/` et `launcher/`). Si vous le modifiez, modifiez les trois.

## Fabriquer les installeurs

Avant de compiler l'admin, installez les dépendances de l'API : l'installeur de l'admin embarque `api/` et son `node_modules`.

```bash
cd api && npm install
```

Puis, dans `launcher/` ou `admin/` :

```bash
npm run dist
```

Le résultat est dans `dist/` : l'installeur `ModCraft-Deploy-Launcher-Setup-<version>.exe` (ou `...-Admin-Setup-...`), son `.blockmap` et `latest.yml`. Avec `compiler.cmd`, c'est l'option 1 ou 2.

Le launcher n'embarque aucune adresse d'API : l'installeur la demande à la première installation, avec la `launcherKey`.

Si `electron-builder` échoue sur Windows avec une erreur de lien symbolique pendant l'extraction de `winCodeSign`, activez le « Mode développeur » de Windows (Paramètres, Confidentialité et sécurité, Espace développeurs) ou lancez le terminal en administrateur.

## Si vous publiez votre propre version

Le code est sous GPL v3, vous pouvez donc distribuer une version modifiée. Quelques points à changer pour qu'elle soit bien la vôtre :

- Le nom et le logo « ModCraft Deploy » ne sont pas couverts par la licence : choisissez un autre nom (`productName` et `appId` dans les `package.json`, textes de l'interface) et vos propres icônes (`launcher/build/icon.ico`, `admin/build/icon.ico`).
- Les adresses de mise à jour sont écrites en dur (`launcher/src/main/core/updateConfig.js`, `admin/src/main/core/updateConfig.js`, et `build.publish` dans chaque `package.json`). Mettez les vôtres.
- Générez votre paire de clés de signature avec `node scripts/generate-update-key.js`, collez la clé publique dans `UPDATE_PUBLIC_KEY` des deux `updateConfig.js`, et signez chaque mise à jour avec `node scripts/sign-update.js <dossier dist>`. Sans cela, personne ne pourra recevoir vos mises à jour. Le détail est dans le [README](../README.md), section « Build et distribution ». Ne publiez jamais la clé privée.
- Les fichiers `api/.env` et `launcher/launcher.config.json` contiennent des secrets et sont ignorés par git. Ne les ajoutez pas au dépôt.
