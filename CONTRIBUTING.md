# Contributing

Thank you for helping. Bug reports, fixes and new features are all welcome.

## Licence of contributions

Contributions are accepted under the same licence as the project (Apache License 2.0 with the
Commons Clause License Condition v1.0, see `LICENSE`): what you contribute is licensed to everyone
on exactly the terms you received the editor under ("inbound = outbound"). There is **no
Contributor License Agreement** to sign. By opening a pull request you confirm that you have the
right to contribute the change under those terms.

## How to contribute

1. Fork the repository and make a branch.
2. Keep the editor dependency-free at run time, and keep the security model in `README.md`
   ("Security model") as it is: loopback only, the Host check, Origin and JSON for writes, plain
   map names, fixed commands for Apply actions.
3. Run `npm test` (it must pass). For a change to the page, also run `npm run check:browser`
   (see `README.md`, "Tests").
4. Describe what changed and how you checked it in the pull request.

Game-specific behaviour belongs in a project's `map-editor.config.mjs`, not in the editor's core.
