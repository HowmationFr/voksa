import { Menu, MenuItemConstructorOptions, app, shell } from 'electron';
import type { AppWindow } from './window';
import { getStreamMode } from './stream-mode/StreamModeController';
import { getSettings, setSettings } from './storage/settings';
import { IPC } from '../shared/ipcChannels';
import { t } from './i18n';

/**
 * The application menu is the SINGLE SOURCE OF TRUTH for keyboard shortcuts:
 * accelerators fire regardless of which webContents holds focus. UI-side
 * actions (focus address bar, open find bar, bookmark current page) are pushed
 * to the chrome renderer via the MENU_CMD channel; everything else acts on the
 * TabManager / window directly.
 *
 * Labels go through t(): the menu is rebuilt by handlers.ts whenever the
 * language setting changes.
 */
export function buildApplicationMenu(getApp: () => AppWindow | null): Menu {
  const isMac = process.platform === 'darwin';

  const tabs = () => getApp()?.tabs ?? null;
  const active = () => tabs()?.getActive() ?? null;
  // DevTools must target something useful on internal pages too: their tab
  // webContents is blank (internal pages render in the chromeView), so fall
  // back to the chrome UI; same rule as APP_OPEN_DEVTOOLS in handlers.ts.
  const devtoolsTarget = () => {
    const a = active();
    if (a && !a.isInternal) return a.view.webContents;
    return getApp()?.chromeView.webContents ?? null;
  };
  const cmd = (command: string) => {
    getApp()?.chromeView.webContents.send(IPC.MENU_CMD, command);
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: t('Fichier'),
      submenu: [
        { label: t('Nouvel onglet'), accelerator: 'CmdOrCtrl+T', click: () => tabs()?.create() },
        {
          label: t('Rouvrir l’onglet fermé'),
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => tabs()?.reopenClosed(),
        },
        {
          label: t('Fermer l’onglet'),
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const a = active();
            if (a) tabs()?.close(a.id);
          },
        },
        { type: 'separator' },
        {
          label: t('Imprimer…'),
          accelerator: 'CmdOrCtrl+P',
          // The print dialog lives in the chrome UI (preview + options).
          click: () => cmd('print'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: t('Édition'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: t('Rechercher dans la page…'), accelerator: 'CmdOrCtrl+F', click: () => cmd('find') },
        {
          label: t('Sélectionner la barre d’adresse'),
          accelerator: 'CmdOrCtrl+L',
          click: () => cmd('focus-address'),
        },
        { label: t('Sélectionner la barre d’adresse'), accelerator: 'Alt+D', visible: false, click: () => cmd('focus-address') },
      ],
    },
    {
      label: t('Affichage'),
      submenu: [
        {
          label: t('Recharger'),
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const a = active();
            if (a) void tabs()?.reload(a.id);
          },
        },
        { label: t('Recharger'), accelerator: 'F5', visible: false, click: () => { const a = active(); if (a) void tabs()?.reload(a.id); } },
        {
          label: t('Recharger (sans cache)'),
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => active()?.view.webContents.reloadIgnoringCache(),
        },
        { type: 'separator' },
        {
          label: t('Zoom avant'),
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            const a = active();
            if (a) tabs()?.adjustZoom(a.id, 1);
          },
        },
        {
          label: t('Zoom arrière'),
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            const a = active();
            if (a) tabs()?.adjustZoom(a.id, -1);
          },
        },
        {
          label: t('Zoom par défaut'),
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            const a = active();
            if (a) tabs()?.resetZoom(a.id);
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: t('Outils de développement'),
          accelerator: isMac ? 'Alt+Cmd+I' : 'F12',
          click: () => devtoolsTarget()?.toggleDevTools(),
        },
        { label: t('Outils de développement'), accelerator: 'CmdOrCtrl+Shift+I', visible: false, click: () => devtoolsTarget()?.toggleDevTools() },
      ],
    },
    {
      label: t('Historique'),
      submenu: [
        { label: t('Précédent'), accelerator: 'Alt+Left', click: () => { const a = active(); if (a) void tabs()?.back(a.id); } },
        { label: t('Suivant'), accelerator: 'Alt+Right', click: () => { const a = active(); if (a) void tabs()?.forward(a.id); } },
        {
          label: t('Accueil'),
          accelerator: 'Alt+Home',
          click: () => {
            const a = active();
            if (a) void tabs()?.navigate(a.id, getSettings().homepage || 'voksa://newtab');
          },
        },
        { type: 'separator' },
        { label: t('Historique'), accelerator: 'CmdOrCtrl+H', click: () => tabs()?.create('voksa://history') },
        { label: t('Téléchargements'), accelerator: 'CmdOrCtrl+J', click: () => tabs()?.create('voksa://downloads') },
      ],
    },
    {
      label: t('Onglets'),
      submenu: [
        { label: t('Onglet suivant'), accelerator: 'Control+Tab', click: () => tabs()?.cycle(1) },
        { label: t('Onglet précédent'), accelerator: 'Control+Shift+Tab', click: () => tabs()?.cycle(-1) },
        { type: 'separator' },
        ...([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
          label: t('Onglet {n}', { n }),
          accelerator: `CmdOrCtrl+${n}`,
          click: () => tabs()?.activateByIndex(n - 1),
        })) as MenuItemConstructorOptions[]),
        { label: t('Dernier onglet'), accelerator: 'CmdOrCtrl+9', click: () => tabs()?.activateByIndex(8) },
      ],
    },
    {
      label: t('Favoris'),
      submenu: [
        { label: t('Ajouter aux favoris'), accelerator: 'CmdOrCtrl+D', click: () => cmd('bookmark-current') },
        { label: t('Gérer les favoris'), accelerator: 'CmdOrCtrl+Shift+O', click: () => tabs()?.create('voksa://bookmarks') },
        {
          label: t('Afficher la barre de favoris'),
          accelerator: 'CmdOrCtrl+Shift+B',
          type: 'checkbox',
          checked: getSettings().showBookmarkBar,
          click: (item) => setSettings({ showBookmarkBar: item.checked }),
        },
      ],
    },
    {
      label: t('Confidentialité'),
      submenu: [
        {
          label: t('Mode Stream'),
          accelerator: 'CmdOrCtrl+Shift+S',
          type: 'checkbox',
          checked: getStreamMode().isEnabled(),
          click: () => getStreamMode().toggle(),
        },
        { label: t('Paramètres du Mode Stream'), click: () => tabs()?.create('voksa://stream') },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: t('Paramètres'), click: () => tabs()?.create('voksa://settings') },
        { label: t('À propos'), click: () => void shell.openExternal('https://voksa.app') },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
