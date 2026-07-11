import React from 'react';
import { NewTabPage } from './NewTab';
import { HistoryPage } from './History';
import { BookmarksPage } from './Bookmarks';
import { SettingsPage } from './Settings';
import { StreamPage } from './StreamPage';
import { DownloadsPage } from './Downloads';
import { ExtensionsPage } from './Extensions';

export type Slug =
  | 'newtab'
  | 'history'
  | 'bookmarks'
  | 'settings'
  | 'stream'
  | 'downloads'
  | 'extensions';

type Props = { slug: Slug };

export function InternalPage({ slug }: Props): React.ReactElement {
  // The `key` prop forces a fresh mount when the user switches between
  // internal pages so each page re-runs its initial data fetch.
  switch (slug) {
    case 'newtab':
      return <NewTabPage key="newtab" />;
    case 'history':
      return <HistoryPage key="history" />;
    case 'bookmarks':
      return <BookmarksPage key="bookmarks" />;
    case 'settings':
      return <SettingsPage key="settings" />;
    case 'stream':
      return <StreamPage key="stream" />;
    case 'downloads':
      return <DownloadsPage key="downloads" />;
    case 'extensions':
      return <ExtensionsPage key="extensions" />;
  }
}
