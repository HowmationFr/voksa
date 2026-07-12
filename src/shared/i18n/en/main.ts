/**
 * English dictionary, "main" domain: native application menu, permission
 * dialogs and any other main-process user-facing string. Keys are the
 * French source strings.
 */
export const enMain: Record<string, string> = {
  // Application menu (menu.ts)
  'Fichier': 'File',
  'Nouvel onglet': 'New tab',
  'Nouvelle fenêtre': 'New window',
  'Rouvrir l’onglet fermé': 'Reopen closed tab',
  'Fermer l’onglet': 'Close tab',
  'Imprimer…': 'Print…',
  'Édition': 'Edit',
  'Rechercher dans la page…': 'Find in page…',
  'Sélectionner la barre d’adresse': 'Focus the address bar',
  'Affichage': 'View',
  'Recharger': 'Reload',
  'Recharger (sans cache)': 'Reload (ignore cache)',
  'Zoom avant': 'Zoom in',
  'Zoom arrière': 'Zoom out',
  'Zoom par défaut': 'Reset zoom',
  'Outils de développement': 'Developer tools',
  'Historique': 'History',
  'Précédent': 'Back',
  'Suivant': 'Forward',
  'Accueil': 'Home',
  'Téléchargements': 'Downloads',
  'Onglets': 'Tabs',
  'Onglet suivant': 'Next tab',
  'Onglet précédent': 'Previous tab',
  'Onglet {n}': 'Tab {n}',
  'Dernier onglet': 'Last tab',
  'Favoris': 'Bookmarks',
  'Ajouter aux favoris': 'Bookmark this page',
  'Gérer les favoris': 'Manage bookmarks',
  'Afficher la barre de favoris': 'Show bookmarks bar',
  'Confidentialité': 'Privacy',
  'Mode Stream': 'Stream Mode',
  'Paramètres du Mode Stream': 'Stream Mode settings',
  'Paramètres': 'Settings',
  'À propos': 'About',

  // Extension permission dialog (extensions/webstore.ts)
  'Autoriser': 'Allow',
  'Refuser': 'Deny',
  '« {name} » demande des autorisations supplémentaires': '"{name}" requests additional permissions',

  // Update notification (ipc/handlers.ts)
  'Voksa {version} est prête': 'Voksa {version} is ready',
  'Une mise à jour de Voksa est prête': 'A Voksa update is ready',
  'Redémarrez pour installer la nouvelle version.': 'Restart to install the new version.',

  // Address bar suggestions built in main (ipc/handlers.ts)
  'Aller à {query}': 'Go to {query}',
  'Rechercher « {query} »': 'Search for "{query}"',

  // Google OAuth fallback popup (oauth/GoogleOAuthBridge.ts)
  'Connexion Google': 'Google sign-in',

  // Printing (printing.ts)
  'Onglet introuvable.': 'Tab not found.',
  'Échec de l’impression.': 'Printing failed.',
  'Enregistrer en PDF': 'Save as PDF',
  'Écriture du PDF impossible.': 'Could not write the PDF file.',
};
