/**
 * Key of the PANIC cover on the curtain channel (CURTAIN_SET / CURTAIN_CLEAR).
 *
 * Navigation curtains are keyed by tab id and the chrome UI paints the one of
 * the active tab. The panic cover is keyed by this sentinel instead: it
 * belongs to the window, not to a tab, so the UI paints it whatever tab is in
 * front, including one created or revived while panic is up. Tab ids are
 * nanoid strings (letters, digits, `_`, `-`): they can never equal it.
 */
export const PANIC_CURTAIN_ID = '*panic*';
