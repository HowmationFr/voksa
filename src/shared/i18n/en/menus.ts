/**
 * English dictionary, "menus" domain: burger menu, page context menu, tab
 * context menu, bookmark bar and its dialogs. Keys are the French source
 * strings.
 */
export const enMenus: Record<string, string> = {
  // Menu/Menu.tsx
  // Same key as the native menu item (en/main.ts, which wins the merge):
  // both must carry the same value or one silently shadows the other.
  'Nouvelle fenêtre': 'New window',
  'Mettre à jour Voksa {version}': 'Update Voksa {version}',
  'Mettre en veille (libérer la mémoire)': 'Put to sleep (free memory)',
  'Historique': 'History',
  'Téléchargements': 'Downloads',
  'Favoris': 'Bookmarks',
  'Zoom': 'Zoom',
  'Zoom arrière': 'Zoom out',
  'Réinitialiser': 'Reset',
  'Zoom avant': 'Zoom in',
  'Rechercher dans la page': 'Find in page',
  'Imprimer…': 'Print…',
  'Mode Stream : activé': 'Stream Mode: on',
  'Mode Stream : désactivé': 'Stream Mode: off',
  'Paramètres du Mode Stream': 'Stream Mode settings',
  'Extensions': 'Extensions',
  'Paramètres': 'Settings',
  'Outils de développement': 'Developer tools',
  'Barre de favoris': 'Bookmark bar',
  // Same key as the native menu item (en/main.ts, which wins the merge):
  // both must carry the same value or one silently shadows the other.
  'Afficher la barre de favoris': 'Show bookmarks bar',

  // PageContextMenu.tsx (also "(vide)" shared with FolderDropdown.tsx)
  'Ouvrir le lien dans un nouvel onglet': 'Open link in new tab',
  'Ouvrir dans un nouvel onglet actif': 'Open in new active tab',
  'Copier l’adresse du lien': 'Copy link address',
  'Ouvrir l’image dans un nouvel onglet': 'Open image in new tab',
  'Copier l’image': 'Copy image',
  'Copier l’adresse de l’image': 'Copy image address',
  'Enregistrer l’image sous…': 'Save image as…',
  'Image dans l’image': 'Picture in picture',
  'Couper': 'Cut',
  'Copier': 'Copy',
  'Coller': 'Paste',
  'Tout sélectionner': 'Select all',
  'Rechercher « {selection} »': 'Search for "{selection}"',
  'Précédent': 'Back',
  'Suivant': 'Forward',
  'Recharger': 'Reload',
  'Vider le cache et actualiser': 'Clear cache and refresh',
  'Inspecter': 'Inspect',
  '(vide)': '(empty)',

  // TabBar/TabContextMenu.tsx
  'Dupliquer': 'Duplicate',
  'Réactiver le son': 'Unmute',
  'Couper le son': 'Mute',
  'Rouvrir l’onglet fermé': 'Reopen closed tab',
  'Fermer les autres onglets': 'Close other tabs',
  'Fermer les onglets à droite': 'Close tabs to the right',
  'Fermer': 'Close',

  // BookmarkBar/BookmarkBar.tsx
  'Supprimer ce dossier ?': 'Delete this folder?',
  // Same key as the voksa://bookmarks confirm (en/pages.ts, which wins the
  // merge): both must carry the same value or one silently shadows the other.
  'Les favoris et sous-dossiers qu’il contient remonteront à la racine.':
    'Bookmarks and subfolders inside it will move up to the root.',
  'Supprimer': 'Delete',
  'Cliquez sur l’icône signet pour ajouter vos premiers favoris ; clic droit pour créer un dossier.':
    'Click the bookmark icon to add your first bookmarks; right-click to create a folder.',
  'Nouveau sous-dossier': 'New subfolder',
  'Renommer': 'Rename',
  'Nouveau dossier': 'New folder',
  'Renommer le dossier': 'Rename folder',

  // BookmarkBar/BookmarkContextMenu.tsx
  'Ouvrir dans un nouvel onglet': 'Open in new tab',
  'Modifier': 'Edit',

  // BookmarkBar/BookmarkEditDialog.tsx
  'Modifier le favori': 'Edit bookmark',
  'Titre': 'Title',
  'URL': 'URL',
  'URL invalide': 'Invalid URL',
  'Dossier': 'Folder',
  'Annuler': 'Cancel',
  'Enregistrer': 'Save',

  // BookmarkBar/FolderNameDialog.tsx
  'Nom du dossier': 'Folder name',
};
