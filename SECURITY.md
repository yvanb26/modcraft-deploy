# Signaler une faille de sécurité

Si vous trouvez une vulnérabilité, ne l'ouvrez pas en issue publique. Écrivez à <support@modcraft-deploy.com> en décrivant ce que vous avez trouvé, comment le reproduire et la version concernée.

Je réponds en général sous quelques jours. Une fois le correctif publié, je peux vous citer dans les notes de version si vous le souhaitez.

## Ce qui compte

Les points les plus sensibles du projet :

- l'échange de token et l'accès à l'API,
- la synchronisation des modpacks (chemins de fichiers, liste blanche d'extensions),
- la vérification de signature des mises à jour,
- le stockage des identifiants (RCON, SFTP, comptes).

## Versions prises en charge

Seule la dernière version publiée reçoit des correctifs.
