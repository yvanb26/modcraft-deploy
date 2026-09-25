; Ecran d'installation personnalise : demande l'adresse de l'API et la cle
; du launcher (launcherKey), et les ecrit dans "$APPDATA\<app>\launcher.config.json"
; : exactement l'emplacement que launcherConfig.js lit pour un build
; packagé (cf. src/main/core/launcherConfig.js). Volontairement PAS dans
; resources/ (ecrase a chaque mise a jour) et PAS dans l'asar (illisible
; sans recompiler, donc impossible a reconfigurer sans reinstaller).
;
; Ne s'affiche/n'ecrit QUE si ce fichier n'existe pas deja : sur une mise a
; jour (electron-updater relance l'installateur, generalement en silencieux),
; la config deja en place ne doit jamais etre touchee ni redemandee.

!include "nsDialogs.nsh"

; electron-builder compile ce script deux fois (installateur, puis
; desinstalleur embarque via BUILD_UNINSTALLER) : la page/les fonctions
; ci-dessous ne concernent que l'installation, jamais la desinstallation.
!ifndef BUILD_UNINSTALLER

Var ConfigDialog
Var ConfigInputApiUrl
Var ConfigInputLauncherKey
Var ConfigApiUrlValue
Var ConfigLauncherKeyValue

; ${APP_PACKAGE_NAME} : nom de dossier assaini fourni par electron-builder,
; identique a celui utilise par Electron pour app.getPath('userData').

Function ConfigPageCreate
  ; Ne s'affiche que pour une premiere installation : une mise a jour (qui
  ; relance l'installateur, generalement en silencieux) ne doit jamais
  ; redemander/ecraser la config deja en place.
  IfFileExists "$APPDATA\${APP_PACKAGE_NAME}\launcher.config.json" 0 +2
    Abort

  nsDialogs::Create 1018
  Pop $ConfigDialog
  ${If} $ConfigDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Adresse de l'API de votre communaute (ex: https://exemple.com). Cette valeur se trouve dans l'outil d'administration, onglet Deploiement."
  Pop $0

  ${NSD_CreateLabel} 0 28u 100% 12u "Adresse de l'API :"
  Pop $0
  ${NSD_CreateText} 0 40u 100% 12u ""
  Pop $ConfigInputApiUrl

  ${NSD_CreateLabel} 0 60u 100% 12u "Cle du launcher (launcherKey) :"
  Pop $0
  ${NSD_CreateText} 0 72u 100% 12u ""
  Pop $ConfigInputLauncherKey

  nsDialogs::Show
FunctionEnd

Function ConfigPageLeave
  ${NSD_GetText} $ConfigInputApiUrl $ConfigApiUrlValue
  ${NSD_GetText} $ConfigInputLauncherKey $ConfigLauncherKeyValue

  ${If} $ConfigApiUrlValue == ""
  ${OrIf} $ConfigLauncherKeyValue == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "Merci de renseigner l'adresse de l'API et la cle du launcher : ces deux valeurs sont necessaires au premier lancement."
    Abort
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  Page custom ConfigPageCreate ConfigPageLeave
!macroend

!endif ; BUILD_UNINSTALLER

!macro customInstall
  IfFileExists "$APPDATA\${APP_PACKAGE_NAME}\launcher.config.json" skip_write_config
    CreateDirectory "$APPDATA\${APP_PACKAGE_NAME}"
    FileOpen $0 "$APPDATA\${APP_PACKAGE_NAME}\launcher.config.json" w
    FileWrite $0 '{$\r$\n'
    FileWrite $0 '  "apiBaseUrl": "$ConfigApiUrlValue",$\r$\n'
    FileWrite $0 '  "launcherKey": "$ConfigLauncherKeyValue"$\r$\n'
    FileWrite $0 '}$\r$\n'
    FileClose $0
  skip_write_config:
!macroend

; A la desinstallation, "$APPDATA\${APP_PACKAGE_NAME}" contient tout ce que
; le launcher a jamais ecrit hors de son dossier d'installation :
; launcher.config.json, settings.json/preferences.json, les comptes
; enregistres, le cache MSAL, ET SURTOUT gamedata/ (Java installes, versions
; Minecraft, librairies) et instances/ (les modpacks synchronises, mondes
; sauvegardes compris) : potentiellement plusieurs Go. electron-builder ne
; touche jamais a ce dossier tout seul (il ne desinstalle que le dossier
; d'installation du programme), donc sans ce prompt ces donnees restent
; orphelines indefiniment sur le disque du joueur apres une desinstallation.
; On demande explicitement plutot que de supprimer par defaut : NON perd
; potentiellement des mondes/comptes, donc doit rester un choix actif.
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Voulez-vous aussi supprimer toutes les donnees du launcher (comptes, preferences, jeu installe, mondes sauvegardes, mods telecharges) ?$\r$\n$\r$\nDossier concerne : $APPDATA\${APP_PACKAGE_NAME}$\r$\n$\r$\nRepondez NON si vous comptez reinstaller plus tard et voulez conserver vos mondes/comptes." IDNO skip_data_removal
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
  skip_data_removal:
!macroend
