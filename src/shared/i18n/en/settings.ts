/**
 * English dictionary, "settings" domain: voksa://settings page including the
 * update/About card. Keys are the French source strings.
 */
export const enSettings: Record<string, string> = {
  // SettingsPage
  'Paramètres': 'Settings',
  'Apparence': 'Appearance',
  'Thème': 'Theme',
  'Suit le système, ou forcez clair / sombre.': 'Follows the system, or force light / dark.',
  'Clair': 'Light',
  'Sombre': 'Dark',
  'Système': 'System',
  'Langue': 'Language',
  'Système suit la langue de votre ordinateur (français ou anglais).':
    'System follows your computer language (French or English).',
  'Moteur de recherche': 'Search engine',
  'Utilisé quand la barre d’adresse ne contient pas une URL, et pour la recherche d’une sélection.':
    'Used when the address bar does not contain a URL, and to search a selection.',
  'Utilisé pour les recherches lancées depuis la barre d’adresse.':
    'Used for searches started from the address bar.',
  'Gérer les moteurs de recherche': 'Manage search engines',
  'Mots-clés de la barre d’adresse : tapez « duckduckgo.com » puis Espace pour chercher directement sur DuckDuckGo.':
    'Address bar keywords: type “duckduckgo.com” then Space to search DuckDuckGo directly.',
  'Page d’accueil': 'Home page',
  'Ouverte par le bouton Accueil et Alt+Home.': 'Opened by the Home button and Alt+Home.',
  'Barre de favoris': 'Bookmark bar',
  'Afficher la barre sous la barre d’adresse.': 'Show the bar below the address bar.',
  // SettingsPage: on startup
  'Au démarrage': 'On startup',
  'Ce que Voksa ouvre au lancement.': 'What Voksa opens when it starts.',
  'Ouvrir la page « Nouvel onglet »': 'Open the New Tab page',
  'Reprendre là où vous vous étiez arrêté': 'Continue where you left off',
  'Ouvrir une page ou un ensemble de pages spécifiques':
    'Open a specific page or set of pages',
  'Pages à ouvrir': 'Pages to open',
  'Utiliser les pages actuelles': 'Use current pages',
  'https://exemple.com': 'https://example.com',
  'Liste pleine ({n} pages).': 'List full ({n} pages).',
  'Aucune page : Voksa ouvrira un nouvel onglet.':
    'No pages: Voksa will open a new tab.',

  // SettingsPage: performance (speed)
  'Vitesse': 'Speed',
  'Voksa résout le DNS et ouvre la connexion des sites que vous survolez, pour que la page s’affiche plus vite au clic. Aucune page n’est téléchargée à l’avance.':
    'Voksa resolves DNS and opens the connection to sites you hover, so the page appears faster when you click. No page is downloaded ahead of time.',

  // SettingsPage: shell (sidebar + search)
  'Confidentialité et sécurité': 'Privacy and security',
  'Rechercher un paramètre': 'Search settings',
  'Effacer la recherche': 'Clear the search',
  'Aucun paramètre ne correspond à « {query} ».': 'No setting matches "{query}".',

  // SettingsPage: performance / memory saver
  'Performances': 'Performance',
  'Économiseur de mémoire': 'Memory Saver',
  'Voksa libère la mémoire des onglets inactifs. Les onglets actifs et vos autres applications en profitent, et Voksa reste rapide. Un onglet mis en veille se recharge quand vous y revenez.':
    'Voksa frees memory from inactive tabs. Active tabs and your other apps get the resources instead, and Voksa stays fast. A dormant tab reloads when you come back to it.',
  'Désactivé': 'Off',
  'Modéré': 'Moderate',
  'Équilibré': 'Balanced',
  'Maximal': 'Maximum',
  'Niveau appliqué': 'Current behaviour',
  'Aucun onglet n’est mis en veille.': 'No tab is ever put to sleep.',
  'Les onglets inactifs ne sont libérés que si votre ordinateur manque réellement de mémoire.':
    'Inactive tabs are only freed when your computer is genuinely short on memory.',
  'Les onglets inactifs depuis longtemps sont libérés, plus tôt si la mémoire se tend.':
    'Long-inactive tabs are freed, and sooner when memory gets tight.',
  'Les onglets inactifs sont libérés dès que possible.': 'Inactive tabs are freed as soon as possible.',
  '{n} onglet en veille': '{n} dormant tab',
  '{n} onglets en veille': '{n} dormant tabs',
  'Sites toujours actifs': 'Always keep these sites active',
  'Ces sites ne sont jamais mis en veille, même inactifs (une webapp, un tableau de bord que vous gardez ouvert).':
    'These sites are never put to sleep, even when inactive (a web app, a dashboard you keep open).',
  'exemple.com': 'example.com',
  'Aucun site protégé pour le moment.': 'No protected site yet.',
  'Retirer {host}': 'Remove {host}',

  'Confidentialité': 'Privacy',
  'Masque IP, emails, téléphones et mots-clés en direct pour partager votre écran sans fuite.':
    'Masks IPs, emails, phone numbers and keywords live, so you can share your screen without leaking.',
  'Effacer les données': 'Clear data',
  'Par type (historique, cookies, cache, autorisations…) et par période.':
    'By type (history, cookies, cache, permissions…) and by time range.',
  'Effacer…': 'Clear…',
  'Mode Stream': 'Stream Mode',
  'Mode Stream actif': 'Stream Mode active',
  'Configurer le Mode Stream': 'Set up Stream Mode',
  'Extensions': 'Extensions',
  'Gérer les extensions': 'Manage extensions',
  'Aucune extension installée : installez-en depuis le Chrome Web Store.':
    'No extensions installed: install some from the Chrome Web Store.',
  '{n} extension installée · ordre de la barre d’outils, désinstallation.':
    '{n} extension installed · toolbar order, uninstall.',
  '{n} extensions installées · ordre de la barre d’outils, désinstallation.':
    '{n} extensions installed · toolbar order, uninstall.',

  // UpdatesSection
  'Recherche de mise à jour…': 'Checking for updates…',
  'Téléchargement de la version {version}… {percent}%': 'Downloading version {version}… {percent}%',
  'La version {version} est prête. Elle sera installée au prochain redémarrage.':
    'Version {version} is ready. It will be installed on the next restart.',
  'Voksa est à jour.': 'Voksa is up to date.',
  'La vérification a échoué : {error}': 'The check failed: {error}',
  'erreur inconnue': 'unknown error',
  'Mises à jour automatiques indisponibles (version de développement ou installation .deb : mettez à jour via GitHub).':
    'Automatic updates unavailable (development build or .deb install: update via GitHub).',
  'À propos': 'About',
  'Les mises à jour sont vérifiées au démarrage puis régulièrement.':
    'Updates are checked at startup, then regularly.',
  'Redémarrer': 'Restart',
  'Vérification…': 'Checking…',
  'Vérifier les mises à jour': 'Check for updates',

  // AboutCard: author credit, source code, legal footer
  'Voir la chaîne Howmation': 'Visit the Howmation channel',
  'Voir le dépôt GitHub': 'Visit the GitHub repository',
  'Signaler un problème': 'Report an issue',
  '© 2026 Howmation. Distribué sous licence GPL-3.0.':
    '© 2026 Howmation. Distributed under the GPL-3.0 licence.',
  'Voksa fonctionne grâce au projet Open Source Chromium et à d’autres {libs}.':
    'Voksa is made possible by the Chromium open source project and other {libs}.',
  'logiciels libres': 'open source software',
};
