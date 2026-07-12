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
  'Fermer ({shortcut})': 'Close ({shortcut})',
};
