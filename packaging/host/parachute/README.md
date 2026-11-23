# Parachute payload slot

Empty in this bundle. When Parachute's embedded mode ships (docs/distribution/LAUNCH-PLAN.md §3,
E1–E10), the pinned darwin-arm64 Parachute release goes here, unmodified, with its licence
(AGPL-3.0) and a link to the exact source of that release:

    parachute/
      bin/parachute          the hub (`parachute serve --embedded`)
      bin/parachute-vault    the vault CLI
      modules/               modules resolved from this path, never from ~/.bun
      LICENSE                Parachute's licence text
      SOURCE.md              the release tag and the source URL
      VERSION                the pinned version (`parachute version --json` at build time)

`build-info.json` → `parachute.bundled` says whether a payload is present, and
`prism install --parachute embedded` is refused until it is. Until then the agent installs
stock Parachute (the launch plan's fallback) and Prism talks to it as `--parachute external`.
