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
};
