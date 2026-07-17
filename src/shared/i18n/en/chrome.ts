/**
 * English dictionary, "chrome" domain: tab bar, toolbar, address bar,
 * window controls, find bar. Keys are the French source strings.
 */
export const enChrome: Record<string, string> = {
  // Toolbar.tsx
  'Précédent (Alt+←)': 'Back (Alt+←)',
  'Suivant (Alt+→)': 'Forward (Alt+→)',
  'Arrêter': 'Stop',
  'Recharger ({shortcut})': 'Reload ({shortcut})',
  'Accueil': 'Home',
  'Réinitialiser le zoom': 'Reset zoom',
  'Téléchargements ({shortcut})': 'Downloads ({shortcut})',
  'Mode Stream actif': 'Stream Mode active',
  'Activer le Mode Stream': 'Enable Stream Mode',
  'Mode Stream actif : clic pour désactiver, Alt+clic pour les paramètres':
    'Stream Mode active: click to disable, Alt+click for settings',
  'Activer le Mode Stream ({shortcut})': 'Enable Stream Mode ({shortcut})',
  'Menu': 'Menu',
  'Menu : une mise à jour est prête': 'Menu: an update is ready',
  '{title} (en veille, mémoire libérée)': '{title} (dormant, memory freed)',

  // WindowControls.tsx
  'Réduire': 'Minimize',
  'Restaurer': 'Restore',
  'Agrandir': 'Maximize',
  'Fermer': 'Close',

  // FindBar.tsx
  'Rechercher dans la page': 'Find in page',
  'Précédent (Maj+Entrée)': 'Previous (Shift+Enter)',
  'Suivant (Entrée)': 'Next (Enter)',
  'Fermer (Échap)': 'Close (Esc)',

  // AddressBar/AddressBar.tsx
  'Paramètres du site': 'Site settings',
  'Recherchez ou saisissez une URL': 'Search or enter a URL',
  'Rechercher sur {engine}': 'Search {engine}',
  'Page interne de Voksa': 'Voksa internal page',
  'Retirer des favoris': 'Remove from bookmarks',
  // Same key as the native menu item (en/main.ts, which wins the merge):
  // both must carry the same value or one silently shadows the other.
  'Ajouter aux favoris': 'Bookmark this page',

  // TabBar/TabBar.tsx (also the TabItem.tsx title fallback)
  'Nouvel onglet': 'New tab',
  'Nouvel onglet ({shortcut})': 'New tab ({shortcut})',

  // TabBar/TabItem.tsx
  'Réactiver le son': 'Unmute',
  'Couper le son': 'Mute',
  'Muté pour le stream : cliquer pour autoriser le son':
    'Muted for the stream: click to allow its audio',

  // CapturePicker (Capture Handshake)
  'Partager votre écran': 'Share your screen',
  'Choisissez ce que vous voulez partager. Une fenêtre Voksa est masquée avant la première image envoyée.':
    'Choose what to share. A Voksa window is masked before the first frame is sent.',
  'Écrans': 'Screens',
  'Fenêtres': 'Windows',
  'Voksa (masqué)': 'Voksa (masked)',
  'Partager': 'Share',
  'Fermer ({shortcut})': 'Close ({shortcut})',
};
