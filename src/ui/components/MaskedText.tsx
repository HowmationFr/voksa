import React from 'react';
import { useMaskedText } from '../lib/masking';

/**
 * Renders text with Stream Mode masking applied (chrome UI surfaces: tab
 * titles, suggestions, history/bookmarks rows). Display-only; callers keep
 * the real value for navigation.
 */
export function MaskedText({ text }: { text: string | null | undefined }): React.ReactElement {
  const masked = useMaskedText(text);
  return <>{masked}</>;
}
