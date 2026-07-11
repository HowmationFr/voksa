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
  'Général': 'General',
  'Langue': 'Language',
  'Système suit la langue de votre ordinateur (français ou anglais).':
    'System follows your computer language (French or English).',
  'Moteur de recherche': 'Search engine',
  'Utilisé quand la barre d’adresse ne contient pas une URL.':
    'Used when the address bar does not contain a URL.',
  'Page d’accueil': 'Home page',
  'Ouverte par le bouton Accueil et Alt+Home.': 'Opened by the Home button and Alt+Home.',
  'Barre de favoris': 'Bookmark bar',
  'Afficher la barre sous la barre d’adresse.': 'Show the bar below the address bar.',
  'Confidentialité': 'Privacy',
  'Effacer les données': 'Clear data',
  'Par type (historique, cookies, cache, autorisations…) et par période.':
    'By type (history, cookies, cache, permissions…) and by time range.',
  'Effacer…': 'Clear…',
  'Mode Stream': 'Stream Mode',
  'Mode Stream actif': 'Stream Mode active',
  'Configurer le Mode Stream': 'Set up Stream Mode',
  '· {n} mot-clé': '· {n} keyword',
  '· {n} mots-clés': '· {n} keywords',
  'Masquage des IP, emails, champs, permissions + mots-clés personnalisés.':
    'Masks IPs, emails, fields, permissions + custom keywords.',
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
  'Les mises à jour sont vérifiées au démarrage.': 'Updates are checked at startup.',
  'Redémarrer pour installer': 'Restart to install',
  'Vérification…': 'Checking…',
  'Vérifier les mises à jour': 'Check for updates',
};
