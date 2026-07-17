/**
 * Global panic flag, in its own tiny module to break an import cycle: Tab
 * needs to read it (any audio re-application while panic is up must stay
 * muted) and PanicController needs to write it, but PanicController reaches
 * tabs through the window registry, which reaches back to Tab.
 */
let active = false;

export function isPanicActive(): boolean {
  return active;
}

export function setPanicActive(value: boolean): void {
  active = value;
}
