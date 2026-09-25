# Composants tiers

ModCraft Deploy utilise les composants suivants. Chacun reste sous sa propre licence, toutes compatibles avec la GPL v3.

## Dépendances directes

| Paquet | Licence | Utilisé par |
|---|---|---|
| @azure/msal-node | MIT | launcher |
| adm-zip | MIT | api, launcher, admin |
| archiver | MIT | admin |
| basic-ftp | MIT | api, admin |
| cors | MIT | api |
| discord-rpc | MIT | launcher |
| dotenv | BSD-2-Clause | api |
| electron-log | MIT | launcher |
| electron-updater | MIT | launcher, admin |
| express | MIT | api |
| jsonwebtoken | MIT | api |
| minecraft-launcher-core | MIT | launcher |
| rcon-client | MIT | api |
| ssh2-sftp-client | Apache-2.0 | api, admin |

Electron (MIT) et electron-builder (MIT) servent à exécuter et empaqueter les applications. Les dépendances indirectes sont sous MIT, ISC, BSD, Apache-2.0 ou des licences permissives équivalentes. La liste complète s'obtient avec `npm ls --all` dans chaque dossier.

## Polices

- Inter, sous SIL Open Font License 1.1, voir [licenses/OFL-Inter.txt](licenses/OFL-Inter.txt)
- Oxanium, sous SIL Open Font License 1.1, voir [licenses/OFL-Oxanium.txt](licenses/OFL-Oxanium.txt)

## Marques

Minecraft est une marque de Mojang Synergies AB / Microsoft Corporation. Ce projet n'y est pas affilié, voir [DISCLAIMER.md](DISCLAIMER.md).
