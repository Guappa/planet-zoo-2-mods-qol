# Planet Zoo 2 Mods

- For any Planet Zoo 2 modding work, load the `pz2-modding` skill
  (`.claude/skills/pz2-modding/`) first. It is the definition source and guideline for this repo.
- **Keep that skill current.** Whenever you learn something new about modding Planet Zoo 2 (a
  format detail, an API or event, a data path, a pitfall, a crash cause, a tool trick), or find
  something in it is wrong, update the matching file in `.claude/skills/pz2-modding/reference/` in
  the same change and add a line to its `changelog.md`. Do this without being asked.
- Never patch the exe or touch Denuvo or online activation. Franchise automation must stay
  click-started (the player's click on Execute / Sell / Find a habitat is the opt-in; no extra
  "allow in Franchise" switches, decided 2026-10-16) and one action at a time.
- **Tag every official release.** Each version published on Nexus gets an annotated Git tag
  `vX.Y.Z` (e.g. `v3.0.2`, matching `Core.sVersion` / `VERSION`) on the commit whose
  `mods/PZ2QoL` source is exactly what the release zip ships. Commit the release source before
  uploading, tag that commit (`git tag -a vX.Y.Z -m "Mike's QoL Toolbox X.Y.Z"`), and push the
  commit and the tag together (`git push origin main vX.Y.Z`). Never move or delete a published
  tag; a fix is a new version with a new tag. `main` may run ahead of the latest release.
- Franchise is the priority: the developer only plays Franchise. Every feature should work there
  unless it would change what is sent to Frontier's servers.
