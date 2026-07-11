## What does this PR do?

<!-- One or two sentences. Link the related issue: Fixes #123 -->

## How was it tested?

<!-- Be honest and specific. "Ran npm run dev and clicked through X" is fine;
     "should work" is not. If a code path was NOT exercised, say so. -->

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] Manually exercised the changed behavior in `npm run dev`

## Stream Mode impact

<!-- Required. Stream Mode is the flagship zero-leak feature. -->

- [ ] This change cannot affect Stream Mode (masking, curtain, shroud, chrome UI masking)
- [ ] OR: I verified frame by frame that no sensitive information can appear on screen

## Checklist

- [ ] User-facing strings go through the i18n layer (no hardcoded UI strings)
- [ ] New cross-process APIs follow the IPC golden rule (ipcChannels + handlers + voksaApi + voksa.*)
- [ ] No hardcoded hex colors
- [ ] Documentation updated if behavior or architecture changed
