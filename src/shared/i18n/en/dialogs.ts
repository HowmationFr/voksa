/**
 * English dictionary, "dialogs" domain: print dialog, clear data dialog,
 * confirm dialog, error boundary. Keys are the French source strings.
 */
export const enDialogs: Record<string, string> = {
  // ConfirmDialog
  'Annuler': 'Cancel',
  'Confirmer': 'Confirm',

  // ErrorBoundary
  'Fermer': 'Close',
  'Une erreur est survenue': 'An error occurred',
  'L’interface a rencontré un problème inattendu.': 'The interface ran into an unexpected problem.',
  'Recharger l’interface': 'Reload the interface',

  // PrintDialog
  'Imprimer': 'Print',
  'Enregistrer': 'Save',
  'Enregistrer en PDF': 'Save as PDF',
  'Échec de l’impression.': 'Printing failed.',
  'Destination': 'Destination',
  'Copies': 'Copies',
  'Mise en page': 'Layout',
  'Portrait': 'Portrait',
  'Paysage': 'Landscape',
  'Pages': 'Pages',
  'Toutes': 'All',
  'Personnalisées': 'Custom',
  'Ex. : 1-5, 8, 11-13': 'E.g. 1-5, 8, 11-13',
  'Couleur': 'Color',
  'Noir et blanc': 'Black and white',
  'Marges': 'Margins',
  'Par défaut': 'Default',
  'Minimales': 'Minimum',
  'Aucune': 'None',
  'Imprimer les arrière-plans': 'Print backgrounds',
  'Aperçu avant impression': 'Print preview',
  'Aperçu indisponible pour cette page.': 'Preview unavailable for this page.',

  // ClearDataDialog
  'Effacer les données de navigation': 'Clear browsing data',
  'Période': 'Time range',
  'Dernière heure': 'Last hour',
  'Dernières 24 heures': 'Last 24 hours',
  '7 derniers jours': 'Last 7 days',
  '4 dernières semaines': 'Last 4 weeks',
  'Toutes les périodes': 'All time',
  'Historique de navigation': 'Browsing history',
  'Pages visitées et sites les plus visités.': 'Pages you visited and your most visited sites.',
  'Historique des téléchargements': 'Download history',
  'La liste seulement : les fichiers téléchargés restent sur le disque.':
    'The list only: downloaded files stay on your disk.',
  'Cookies': 'Cookies',
  'Vous serez déconnecté de la plupart des sites.': 'You will be signed out of most sites.',
  'Images et fichiers en cache': 'Cached images and files',
  'Certains sites se rechargeront plus lentement à la prochaine visite.':
    'Some sites will load more slowly on your next visit.',
  'Données de sites': 'Site data',
  'localStorage, IndexedDB, service workers.': 'localStorage, IndexedDB, service workers.',
  'Autorisations de sites': 'Site permissions',
  'Décisions caméra / micro / localisation / notifications mémorisées.':
    'Saved camera / microphone / location / notification decisions.',
  'Niveaux de zoom': 'Zoom levels',
  'Zoom mémorisé site par site.': 'Zoom saved per site.',
  'La période choisie s’applique à l’historique et aux téléchargements. Cookies, cache, données et autorisations de sites n’ont pas d’horodatage : ils seront effacés en entier.':
    'The chosen time range applies to history and downloads. Cookies, cache, site data and site permissions have no timestamps: they will be cleared entirely.',
  'Effacement…': 'Clearing…',
  'Effacer les données': 'Clear data',
};
