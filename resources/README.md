# resources/

Packaging assets bundled by `electron-builder`.

## Contents

| File | Purpose |
|---|---|
| `icon.png` | Application icon source (all platforms derive from it) |
| `entitlements.mac.plist` | macOS hardened-runtime entitlements used when signing releases |

## Icon

A single source file is required:

- **`icon.png`**: square PNG, **1024x1024**, transparent background recommended.

From it, `electron-builder` generates everything at packaging time:

| Platform | Generated file | Source |
|---|---|---|
| Windows | `icon.ico` (multi-size) | `resources/icon.png` |
| macOS | `icon.icns` (multi-size) | `resources/icon.png` |
| Linux | `icon.png` (as is) | `resources/icon.png` |

No manual step: `npm run package:win|mac|linux` converts on the fly.

## Icon design tips

- Avoid fine details: they vanish when downscaled to 16x16.
- Keep about 10% of margin around the symbol (macOS applies a rounded mask since Big Sur that crops the edges).
- Use strong contrast between the symbol and its background: the icon must stay readable on a dark dock and on a light taskbar.
