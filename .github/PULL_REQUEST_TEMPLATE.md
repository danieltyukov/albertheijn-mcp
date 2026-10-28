## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm run check` and `npm run test:e2e` pass locally.
- [ ] New or changed code has a test that runs offline.
- [ ] Endpoints I touched are updated in `docs/api.md`, and `npm run test:live` passes.
- [ ] The diff contains no account data, tokens or session files.
- [ ] `docs/tools.md` is regenerated with `npm run docs:tools` if tools changed.
- [ ] Anything that can change a booked order goes through a `prepare_*` and `confirm_*` pair.
