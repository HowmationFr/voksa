/**
 * English dictionary, "stream" domain: voksa://stream page, permission
 * prompt, site settings popover. Keys are the French source strings.
 */
export const enStream: Record<string, string> = {
  // StreamPage: content mask cards
  'IPv4 publiques': 'Public IPv4',
  'Adresses IPv4 non locales dans le DOM.': 'Non-local IPv4 addresses in the DOM.',
  '1.2.3.4  →  xxx.xxx.xxx.xxx': '1.2.3.4  →  xxx.xxx.xxx.xxx',
  'IPv6 publiques': 'Public IPv6',
  'Adresses IPv6 non locales dans le DOM.': 'Non-local IPv6 addresses in the DOM.',
  '2a01:: → xxxx:xxxx:…': '2a01:: → xxxx:xxxx:…',
  'Adresses email': 'Email addresses',
  'Toute adresse email visible sur la page.': 'Any email address visible on the page.',
  'me@foo.com → xxx@xxx.xxx': 'me@foo.com → xxx@xxx.xxx',
  'Numéros de téléphone': 'Phone numbers',
  'Formats internationaux et nationaux courants.': 'Common international and national formats.',
  '+33 6 12 34 56 78  →  xxx xxx xxx xxx': '+33 6 12 34 56 78  →  xxx xxx xxx xxx',
  'Hostnames internes': 'Internal hostnames',
  '*.local, *.lan et le nom de machine. Désactivé par défaut.':
    '*.local, *.lan and the machine name. Disabled by default.',
  'mon-pc.local → xxxxxx.local': 'my-pc.local → xxxxxx.local',

  // StreamPage: access mask cards
  'Bloquer WebRTC': 'Block WebRTC',
  'Empêche toute divulgation d’IP via WebRTC.': 'Prevents any IP disclosure through WebRTC.',
  'RTCPeerConnection → blocked': 'RTCPeerConnection → blocked',
  'Refuser la géolocalisation': 'Deny geolocation',
  'Demandes refusées sans popup visible.': 'Requests denied without a visible popup.',
  'navigator.geolocation → denied': 'navigator.geolocation → denied',
  'Refuser la caméra': 'Deny camera',
  'Auto-refus de tout accès caméra.': 'Auto-denies any camera access.',
  'getUserMedia(video) → denied': 'getUserMedia(video) → denied',
  'Refuser le microphone': 'Deny microphone',
  'Auto-refus de tout accès micro.': 'Auto-denies any microphone access.',
  'getUserMedia(audio) → denied': 'getUserMedia(audio) → denied',
  'Masquer l’aperçu d’URL': 'Hide URL preview',
  'Remplace le preview natif au survol des liens.':
    'Replaces the native preview when hovering links.',
  'hover → href masqué': 'hover → href masked',
  'Masquer l’historique': 'Hide history',
  'Suggestions d’adresse et « sites les plus visités » sans votre historique. L’enregistrement continue.':
    'Address suggestions and "most visited sites" without your history. Recording continues.',
  'suggestions → historique exclu': 'suggestions → history excluded',
  'Détection d’enregistreur': 'Recorder detection',
  'OBS, Streamlabs, XSplit, vMix… ouvert ou lancé → le Mode Stream s’active tout seul.':
    'OBS, Streamlabs, XSplit, vMix… opened or launched → Stream Mode turns on by itself.',
  'OBS détecté → Stream ON': 'OBS detected → Stream ON',

  // StreamPage: section titles
  'Masquage dans le DOM': 'DOM masking',
  'Ce qui est réécrit à la volée sur chaque page visitée.':
    'What is rewritten on the fly on every page you visit.',
  'Permissions & accès matériel': 'Permissions & hardware access',
  'Ce qui est refusé automatiquement sans demander.':
    'What is denied automatically without asking.',
  'Mots-clés personnalisés': 'Custom keywords',
  'Masquez un nom de projet, un pseudo, une URL interne, n’importe quelle chaîne sensible.':
    'Mask a project name, a nickname, an internal URL, any sensitive string.',

  // StreamPage: hero header
  'Mode Stream': 'Stream Mode',
  'Actif': 'Active',
  'Inactif': 'Inactive',
  'Masquez en temps réel toutes les données sensibles de vos pages web (IP, emails, permissions, mots-clés personnalisés) pour un partage d’écran ou un live sans fuite.':
    'Mask in real time all the sensitive data on your web pages (IPs, emails, permissions, custom keywords) for screen sharing or live streaming without leaks.',
  '{n} catégorie active': '{n} active category',
  '{n} catégories actives': '{n} active categories',
  '{n} mot personnalisé': '{n} custom word',
  '{n} mots personnalisés': '{n} custom words',
  'Désactiver': 'Disable',
  'Activer': 'Enable',

  // StreamPage: custom masks card + chips
  'Supprimer {n} mot-clé ?': 'Delete {n} keyword?',
  'Supprimer {n} mots-clés ?': 'Delete {n} keywords?',
  'Supprimer': 'Delete',
  'Ajouter un mot ou une phrase à masquer…': 'Add a word or phrase to mask…',
  'Ajouter': 'Add',
  'La recherche est insensible à la casse. Chaque correspondance est remplacée par des puces. Parfait pour masquer un nom de client, un identifiant interne ou un secret que vous ne voulez pas qu’on voie dans votre flux.':
    'Matching is case-insensitive. Every match is replaced with bullets. Perfect for hiding a client name, an internal identifier or a secret you do not want anyone to see on your stream.',
  'Aucun mot-clé personnalisé pour le moment.': 'No custom keywords yet.',
  '{n} mot actif': '{n} active word',
  '{n} mots actifs': '{n} active words',
  'Tout effacer': 'Clear all',
  'Retirer le mot-clé masqué': 'Remove the masked keyword',
  'Retirer {text}': 'Remove {text}',

  // StreamPage: appearance (accent color) card
  'Apparence': 'Appearance',
  'La couleur qui signale le Mode Stream dans l’interface.':
    'The color that signals Stream Mode across the UI.',
  'Choisir cette couleur ({hex})': 'Pick this color ({hex})',
  'Couleur personnalisée': 'Custom color',
  'Appliquée en direct au liseré de fenêtre, au bouclier de la barre d’outils et à tous les indicateurs du Mode Stream, en thème clair comme en thème sombre.':
    'Applied live to the window ring, the toolbar shield and every Stream Mode indicator, in light and dark themes alike.',

  // PermissionPrompt
  'Ce site': 'This site',
  'souhaite {label}.': 'wants to {label}.',
  'Toujours refuser': 'Always deny',
  'Bloquer': 'Block',
  'Autoriser': 'Allow',

  // permissionLabels: request phrases (verb, follows "wants to")
  'utiliser votre caméra / micro': 'use your camera / microphone',
  'utiliser votre caméra': 'use your camera',
  'utiliser votre micro': 'use your microphone',
  'accéder à votre position': 'access your location',
  'afficher des notifications': 'show notifications',
  'capturer votre écran': 'capture your screen',
  'lire votre presse-papiers': 'read your clipboard',
  'verrouiller votre pointeur': 'lock your pointer',
  'passer en plein écran': 'go fullscreen',

  // permissionLabels: permission names
  'Caméra et micro': 'Camera and microphone',
  'Caméra': 'Camera',
  'Micro': 'Microphone',
  'Localisation': 'Location',
  'Notifications': 'Notifications',
  'Capture d’écran': 'Screen capture',
  'Presse-papiers (lecture)': 'Clipboard (read)',
  'Verrouillage du pointeur': 'Pointer lock',
  'Plein écran': 'Fullscreen',

  // SiteSettingsPopover
  'Connexion sécurisée (HTTPS)': 'Secure connection (HTTPS)',
  'Connexion non sécurisée': 'Connection not secure',
  'Fermer': 'Close',
  'Mode Stream actif : caméra, micro, géolocalisation et autres permissions sensibles sont refusées automatiquement. Les réglages ci-dessous s’appliquent hors stream.':
    'Stream Mode active: camera, microphone, geolocation and other sensitive permissions are denied automatically. The settings below apply outside of streaming.',
  'Demander (défaut)': 'Ask (default)',
  'Réinitialiser les autorisations': 'Reset permissions',
  'Les changements s’appliquent à la prochaine demande du site':
    'Changes apply to the next request from the site',
  'Recharger': 'Reload',

  // Go-Live Preflight card
  'Vérification avant live': 'Go-live check',
  'Un audit en un clic de ce qu’un spectateur pourrait apercevoir dans Voksa avant de lancer le direct.':
    'A one-click audit of what a viewer could catch in Voksa before you go live.',
  'L’audit couvre les onglets de Voksa. Il ne voit pas Discord, les notifications système ni le reste de l’écran.':
    'The audit covers Voksa tabs. It cannot see Discord, system notifications or the rest of your screen.',
  'Lancer la vérification': 'Run the check',
  'Analyse…': 'Scanning…',
  'Rien à signaler sur {n} onglets.': 'Nothing to flag across {n} tabs.',
  'Son en arrière-plan : {label}': 'Background sound: {label}',
  'Donnée sensible : {label}': 'Sensitive data: {label}',
  'Fermer l’onglet': 'Close tab',

  // Panic Key card
  'Bouton panique': 'Panic button',
  'Un raccourci SYSTÈME qui masque toutes les fenêtres et coupe tout le son, même quand OBS ou le jeu a le focus.':
    'A SYSTEM-WIDE shortcut that curtains every window and cuts all sound, even while OBS or the game has focus.',
  'Rideau sur toutes les fenêtres + son coupé + Mode Stream armé. Second appui : tout revient (le Mode Stream reste armé).':
    'Curtain over every window + sound cut + Stream Mode armed. Second press: everything comes back (Stream Mode stays armed).',
  'Le raccourci n’est actif que pendant que le Mode Stream est armé.':
    'The shortcut is only active while Stream Mode is armed.',
  'Cliquer puis appuyer sur le nouveau raccourci': 'Click, then press the new shortcut',
  'Appuyez sur un raccourci…': 'Press a shortcut…',

  // Audio routing card (DMCA stage 2)
  'Audio par onglet': 'Per-tab audio',
  'Sous Mode Stream, un onglet d’arrière-plan qui se met à jouer du son est coupé automatiquement ; la puce sur l’onglet le réautorise.':
    'Under Stream Mode, a background tab that starts playing sound is muted automatically; the chip on the tab allows it again.',
  'Envoyez le son d’un onglet vers une autre sortie : clic droit sur l’onglet, « Sortie audio », choisissez votre casque. OBS, qui capte la sortie par défaut, n’entend plus cet onglet ; vous, si.':
    'Send a tab’s sound to another output: right-click the tab, "Audio output", pick your headset. OBS, which captures the default output, no longer hears that tab; you still do.',
  'Réduction de risque, pas une immunité : un lecteur intégré venant d’un autre site (iframe), une frame sans préchargement ou un flux DRM peut échapper au routage et rester sur la sortie système. Si le périphérique choisi disparaît, l’onglet revient sur la sortie système et le menu cesse de l’afficher : rien n’est prétendu couvert qui ne l’est pas.':
    'Risk reduction, not immunity: an embedded player from another site (iframe), a preload-less frame or a DRM stream can escape the routing and stay on the system output. If the chosen device disappears, the tab falls back to the system output and the menu stops claiming it: nothing is pretended covered that is not.',

  // Sound Signals card
  'Signaux sonores': 'Sound signals',
  'Des repères audio courts : vous ENTENDEZ l’état changer sans quitter OBS des yeux. OBS capte ces sons, comme les bips de Discord.':
    'Short audio cues: you HEAR the state change without looking away from OBS. OBS captures these sounds, like Discord beeps.',
  'Mode Stream armé / désarmé': 'Stream Mode armed / disarmed',
  'Deux notes montantes à l’armement, descendantes au retrait.':
    'Two rising notes when arming, falling when disarming.',
  'Téléchargement terminé': 'Download finished',
  'Un bip discret quand un fichier arrive.': 'A discreet beep when a file lands.',
  'Mise à jour prête': 'Update ready',
  'Un bip quand une nouvelle version attend le redémarrage.':
    'A beep when a new version awaits the restart.',
};
