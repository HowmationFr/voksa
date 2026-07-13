/**
 * English dictionary, "pages" domain: voksa:// internal pages (new tab,
 * history, bookmarks, downloads, extensions, error page). Keys are the
 * French source strings.
 */
export const enPages: Record<string, string> = {
  // NewTab.tsx
  'Mode Stream actif : votre navigation reste confidentielle.':
    'Stream Mode active: your browsing stays private.',
  'Un navigateur moderne, rapide et respectueux.': 'A modern, fast and respectful browser.',
  'Rechercher ou saisir une URL': 'Search or enter a URL',
  'Sites les plus visités': 'Most visited sites',

  // History.tsx
  'Effacer tout l’historique ?': 'Clear all history?',
  'Toutes les pages visitées seront supprimées définitivement.':
    'All visited pages will be permanently deleted.',
  'Effacer': 'Clear',
  'Historique': 'History',
  'Tout effacer': 'Clear all',
  'Rechercher dans l’historique': 'Search history',
  'Aucune entrée ne correspond.': 'No matching entries.',
  'Aucune page dans l’historique.': 'No pages in history.',
  'Aujourd’hui': 'Today',
  'Hier': 'Yesterday',

  // Bookmarks.tsx
  'Supprimer ce dossier ?': 'Delete this folder?',
  'Les favoris et sous-dossiers qu’il contient remonteront à la racine.':
    'Bookmarks and subfolders inside it will move up to the root.',
  'Supprimer': 'Delete',
  'Nouveau sous-dossier': 'New subfolder',
  'Renommer': 'Rename',
  'Favoris': 'Bookmarks',
  'Nouveau dossier': 'New folder',
  'Aucun favori pour le moment. Cliquez sur l’icône signet dans la barre d’adresse pour en ajouter.':
    'No bookmarks yet. Click the bookmark icon in the address bar to add some.',
  'Renommer le dossier': 'Rename folder',
  'Modifier': 'Edit',

  // Downloads.tsx
  'o': 'B',
  'Ko': 'KB',
  'Mo': 'MB',
  'Go': 'GB',
  'Téléchargements': 'Downloads',
  'Effacer la liste': 'Clear list',
  'Aucun téléchargement': 'No downloads',
  'Annulé': 'Cancelled',
  'Interrompu': 'Interrupted',
  'Reprendre': 'Resume',
  'Pause': 'Pause',
  'Annuler': 'Cancel',
  'Ouvrir': 'Open',
  'Dossier': 'Folder',
  'Retirer': 'Remove',

  // Extensions.tsx
  'Extensions': 'Extensions',
  'Installez des extensions depuis le Chrome Web Store : elles apparaîtront ici et dans la barre d’outils.':
    'Install extensions from the Chrome Web Store: they will appear here and in the toolbar.',
  '{n} extensions installées. L’ordre ci-dessous est celui des icônes de la barre d’outils.':
    '{n} extensions installed. The order below matches the toolbar icons.',
  '{n} extension installée. L’ordre ci-dessous est celui des icônes de la barre d’outils.':
    '{n} extension installed. The order below matches the toolbar icons.',

  // ExtensionsSection.tsx
  'Désinstaller « {name} » ?': 'Uninstall "{name}"?',
  'Désinstaller': 'Uninstall',
  'Aucune extension installée. Rendez-vous sur': 'No extensions installed. Visit',
  'pour en ajouter.': 'to add some.',
  'Version {version}': 'Version {version}',
  'Monter': 'Move up',
  'Descendre': 'Move down',

  // ErrorPage.tsx
  "L'adresse est introuvable (DNS). Vérifiez le nom du site.":
    'The address could not be found (DNS). Check the site name.',
  'Vous semblez hors ligne.': 'You appear to be offline.',
  'Le site est injoignable.': 'The site is unreachable.',
  'La connexion a expiré.': 'The connection timed out.',
  'Le certificat de sécurité du site est invalide.': 'The site security certificate is invalid.',
  'Connexion non sécurisée.': 'Connection not secure.',
  'La page n’a pas pu être chargée.': 'The page could not be loaded.',
  'Cette page est inaccessible': 'This page is unreachable',
  'Réessayer': 'Retry',
  'Code {code}': 'Code {code}',

  // voksa://search
  'Moteurs de recherche': 'Search engines',
  'Tapez le mot-clé d’un moteur dans la barre d’adresse, puis Espace, pour chercher directement dessus sans changer votre moteur par défaut.':
    'Type an engine’s keyword in the address bar, then Space, to search it directly without changing your default engine.',
  'Nom': 'Name',
  'Mot-clé': 'Keyword',
  '(par défaut)': '(default)',
  'Définir par défaut': 'Make default',
  'Ajouter un moteur de recherche': 'Add a search engine',
  'Modifier le moteur de recherche': 'Edit search engine',
  'URL avec %s à la place de la recherche': 'URL with %s in place of the query',
  'Tapez ce mot-clé puis Espace dans la barre d’adresse.':
    'Type this keyword then Space in the address bar.',
  'Donnez un nom à ce moteur.': 'Give this engine a name.',
  'Choisissez un mot-clé (ce que vous taperez dans la barre d’adresse).':
    'Choose a keyword (what you will type in the address bar).',
  'Ce mot-clé est déjà utilisé par un autre moteur.':
    'That keyword is already used by another engine.',
  'L’URL doit commencer par https://.': 'The URL must start with https://.',
  'L’URL doit contenir %s à l’endroit de la recherche.':
    'The URL must contain %s where the query goes.',
  'Nombre maximal de moteurs personnalisés atteint ({n}).':
    'Maximum number of custom engines reached ({n}).',

  // voksa://credits
  'Crédits': 'Credits',
  'Afficher toutes les licences': 'Show all licences',
  'Tout masquer': 'Hide all',
  'Voksa est un logiciel libre : son {source} est public. Il fonctionne grâce au projet Open Source {chromium} et aux {n} projets ci-dessous, dont le code est distribué avec le navigateur.':
    'Voksa is free software: its {source} is public. It runs on the {chromium} open source project and on the {n} projects below, whose code is distributed with the browser.',
  'code source': 'source code',
  'Rechercher un projet ou une licence': 'Search for a project or a licence',
  'Aucun projet ne correspond à « {query} ».': 'No project matches “{query}”.',
  'afficher la licence': 'show licence',
  'masquer la licence': 'hide licence',
  'licence non fournie': 'no licence provided',
  'site web': 'homepage',
};
