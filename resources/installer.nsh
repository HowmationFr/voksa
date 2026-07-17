; Default-browser registration (Windows). Auto-included by electron-builder
; (installer.nsh in buildResources) into the NSIS script.
;
; Windows 10/11 builds the "Default apps" list from the REGISTRY, written at
; INSTALL time: RegisteredApplications points at a Capabilities key describing
; what the app can open (http/https/.html), backed by a ProgID whose
; shell\open\command launches the exe with the URL. No runtime API can do
; this, and none can CLAIM the default either (association hashes): the app
; can only register here and send the user to ms-settings to pick it.
;
; SHCTX follows the install mode (per-user -> HKCU, elevated -> HKLM), which
; is exactly where Windows looks for each kind of install.

!macro customInstall
  ; Browser client entry (the name Windows shows in Default apps).
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa" "" "Voksa"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'

  ; Capabilities: what Voksa can handle. URLAssociations is what makes it a
  ; BROWSER candidate; FileAssociations covers local HTML files.
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\Capabilities" "ApplicationName" "Voksa"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\Capabilities" "ApplicationDescription" "Navigateur avec Mode Stream : protection anti-fuite pour le streaming et le partage d'ecran."
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\Capabilities\StartMenu" "StartMenuInternet" "Voksa"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\Capabilities\URLAssociations" "http" "VoksaHTM"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\Capabilities\URLAssociations" "https" "VoksaHTM"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\Capabilities\FileAssociations" ".htm" "VoksaHTM"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Voksa\Capabilities\FileAssociations" ".html" "VoksaHTM"

  ; The ProgID the associations above point at. "%1" receives the URL or file
  ; path; the single-instance lock routes it to the running Voksa if any
  ; (second-instance -> new window with the URL).
  WriteRegStr SHCTX "Software\Classes\VoksaHTM" "" "Document HTML Voksa"
  WriteRegStr SHCTX "Software\Classes\VoksaHTM" "FriendlyTypeName" "Document HTML Voksa"
  WriteRegStr SHCTX "Software\Classes\VoksaHTM\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\VoksaHTM\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Registers the Capabilities key with Windows (this line is what makes
  ; Voksa APPEAR in Settings > Default apps).
  WriteRegStr SHCTX "Software\RegisteredApplications" "Voksa" "Software\Clients\StartMenuInternet\Voksa\Capabilities"

  ; SHCNE_ASSOCCHANGED: tell the shell the association landscape changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Voksa"
  DeleteRegKey SHCTX "Software\Clients\StartMenuInternet\Voksa"
  DeleteRegKey SHCTX "Software\Classes\VoksaHTM"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
