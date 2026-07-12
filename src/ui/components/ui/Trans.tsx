import React from 'react';

/**
 * Renders an already-translated sentence whose {placeholders} are React nodes
 * (typically inline links).
 *
 * The point is the i18n rule: a translated sentence is never assembled from
 * fragments. "Voksa runs on Chromium and other {libs}." stays ONE dictionary
 * key with one placeholder, so a translator sees the whole sentence and can
 * move the link wherever their grammar puts it, instead of receiving three
 * dangling shards glued together in French word order.
 *
 * Pass the translated sentence as `text` (the placeholders survive translation
 * untouched); the values are substituted wherever the translated string happens
 * to place them.
 */
export function Trans({
  text,
  values,
}: {
  text: string;
  values: Record<string, React.ReactNode>;
}): React.ReactElement {
  const parts = text.split(/(\{[a-zA-Z0-9_]+\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const name = /^\{([a-zA-Z0-9_]+)\}$/.exec(part)?.[1];
        const node = name !== undefined ? values[name] : undefined;
        return (
          <React.Fragment key={i}>{node !== undefined ? node : part}</React.Fragment>
        );
      })}
    </>
  );
}
