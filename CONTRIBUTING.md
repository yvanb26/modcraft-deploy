# Contribuer

Les contributions sont les bienvenues : corrections de bugs, traductions, améliorations, retours d'expérience.

## Avant de commencer

Pour un changement important, ouvrez d'abord une issue pour en discuter. Ça évite de passer du temps sur quelque chose qui ne rentrera pas dans le projet.

Pour une faille de sécurité, suivez plutôt [SECURITY.md](SECURITY.md).

## Lancer le projet

Les étapes sont dans le [README](README.md), section « Démarrage rapide ». Chaque dossier (`api`, `launcher`, `admin`) a son propre `package.json` et son `npm install`.

## Conventions

- Le code, les commentaires et les textes de l'interface sont en français. Les traductions du launcher sont dans `launcher/src/renderer/locales.js`.
- `fileAllowlist.js` existe en trois exemplaires identiques (`admin/`, `api/scripts/`, `launcher/`). Si vous le changez, changez les trois.
- Ne mettez jamais de secret dans le dépôt : `.env`, `launcher.config.json` et les clés de signature sont ignorés par git.
- Gardez les commits petits, avec un message qui dit ce qui change et pourquoi.

## Licence

En envoyant une contribution, vous acceptez qu'elle soit publiée sous la licence GPL v3 ou ultérieure du projet. Le nom et le logo « ModCraft Deploy » ne sont pas couverts par cette licence.
