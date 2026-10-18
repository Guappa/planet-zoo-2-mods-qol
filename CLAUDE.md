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
- Franchise is the priority: the developer only plays Franchise. Every feature should work there
  unless it would change what is sent to Frontier's servers.
