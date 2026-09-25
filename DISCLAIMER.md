# Avertissement

Ce texte n'est pas un avis juridique. Il s'inspire des
[règles d'usage de Minecraft](https://www.minecraft.net/en-us/usage-guidelines)
publiées par Mojang. Pour un usage commercial ou en cas de litige, voyez un
avocat.

## Statut du projet

ModCraft Deploy n'est ni affilié, ni approuvé, ni sponsorisé par Mojang Studios
ou Microsoft. « Minecraft » est une marque de Mojang Synergies AB / Microsoft.
C'est un projet communautaire indépendant, écrit par un joueur pour d'autres
joueurs.

## Ce que fait le launcher, et ce qu'il ne fait pas

- Aucun fichier du jeu n'est redistribué. Le launcher télécharge le client, les
  bibliothèques et les loaders (Forge, Fabric, Quilt, NeoForge) directement
  chez Mojang, Forge, Fabric, Quilt, NeoForge et Eclipse Adoptium (pour Java),
  comme le fait le launcher officiel. Rien de tout cela ne passe par ce projet.
- Il ne contourne aucune vérification de compte. Les serveurs en mode « online »
  exigent un compte Microsoft avec une licence Minecraft: Java Edition, et le
  launcher n'y change rien. Il propose en plus, si l'opérateur l'active, une
  connexion hors ligne (simple pseudo) et une connexion Ely.by, qui servent
  en solo et sur les serveurs configurés en `online-mode=false`. Le launcher
  officiel de Mojang n'a pas de mode hors ligne : c'est un choix de ce projet,
  que chaque opérateur peut désactiver. Il revient à chacun de respecter
  l'EULA de Minecraft.
- Le projet est gratuit et ne fait payer personne pour jouer à Minecraft.
- Les connexions Microsoft et Ely.by passent directement entre l'ordinateur du
  joueur et les serveurs de ces services. Le launcher ne voit ni ne stocke
  jamais un mot de passe Microsoft. Le détail est dans le README, section
  « Comptes ».

## Marques et propriétés tierces

« Minecraft », son logo et tous les éléments visuels et sonores du jeu
appartiennent à Mojang Synergies AB / Microsoft Corporation. Les autres marques
citées (Ely.by, Discord, Forge, Fabric, Quilt, NeoForge, Eclipse Adoptium)
appartiennent à leurs propriétaires. Elles ne servent ici qu'à décrire une
intégration technique, sans lien d'affiliation.

## Le code de ce projet

Le code de ModCraft Deploy (hors Minecraft et services tiers) est publié sous
licence GNU GPL v3 ou ultérieure, voir [`LICENSE`](LICENSE). Vous pouvez
l'utiliser, le modifier et le redistribuer, y compris pour habiller le launcher
aux couleurs d'une autre communauté, à condition, si vous distribuez une version modifiée, de la publier sous
la même licence, code source compris. Le nom et le logo « ModCraft Deploy » ne sont pas couverts
par la licence : une version modifiée distribuée publiquement doit porter un
autre nom. Le logiciel est fourni sans garantie.

## Retrait de contenu

Si Mojang, Microsoft ou un autre ayant droit trouve qu'un élément du projet pose
problème, écrivez à <support@modcraft-deploy.com> : il sera retiré rapidement.
