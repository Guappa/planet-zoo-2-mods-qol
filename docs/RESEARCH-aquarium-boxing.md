# Research: animals boxed in aquariums and never released (2026-10-19)

Game 1.0.5 (build 1023906). Sources: decompiled game Lua, `animals.fdb`, English loc, and an
existing string dump of the exe made earlier (no new reads of the exe). Nothing below has been
watched happening in the game yet. **offline** = seen in files only, **guess** = inferred.

## Short answer

- **The boxing comes from C++, not from Lua.** No game Lua script ever boxes an animal on its own.
  The only Lua calls to `BoxAnimal` come from player buttons: the animal panel and the habitat
  gate's "Box all".
- A native **SOS system** (`Game\Src\Core\Animals\AnimalSOSComponentManager.cpp`) boxes animals it
  thinks are stuck. Our mod can't change how it decides an animal is stuck.
- **The "never released" part can be fixed in our mod.** Lua can read every state involved and can
  run the same unbox sequence as the game's own Unbox button.
- So a **full fix of the cause is out of reach**, but a **practical fix** is possible: find boxed
  animals in their own habitat and unbox them, or alert the player with one click.

## What boxes the animal (offline, from native strings)

Native log formats next to `AnimalSOSComponentManager`:

| String | Meaning |
|---|---|
| `[SOS] Reason: CanGetToResultArrived() Failed. Current Situation: %s.` | The animal's reachability query failed. The situation is e.g. underwater or swimming. |
| `NavAgentInHabitatComponentManager::CanGetToResultArrived()` | Where that query is made: animals in a habitat are checked over and over. |
| `[SOS] Reason: %s does not use an aquarium` | A species that doesn't live in aquariums ended up in one. |
| `AnimalSOSComponentManager::SOSAnimalsForNavRebuild()` | Boxes animals while the navmesh is rebuilt. Lua calls it once at park load when `navigationworld:LoadedOldMesh()` (`worlds.darwinworld.lua` ~642). |
| `AnimalSOSComponentManager::SOSAnimalsNearDeletedTunnel()` | Burrows. Doesn't apply here. |
| `Animal %s spawning in %s couldn't find a nearby dwelling point. SOSing for safety.` | Spawning. |
| `[SOS] Reason: "%s", i_unbox = %s` | Each SOS says whether the game will unbox the animal again by itself. |
| `BoxedAnimalComponentManager::UnboxAnimal call on animal which is not on accessible land` | The unbox fails when the box isn't on accessible ground. |

Message and behaviour names nearby: `NavAgentConnectedRegionChangedMessage`,
`HandleMessage_NavigationTilesUpdatedMessage`, `HandleMessage_WaterVolumeUpdateMessage`,
`Is-Stuck-In-Territory-Connected-Region`, `While-Not-Wanting-Boxed`, `Is-Boxed`, and the staff
jobs `AnimalPickupAquarium` / `AnimalPickupAquariumNav`.

**Likely chain (guess, to be checked in game):**

1. An aquarium animal swims into a spot that its underwater navmesh doesn't link to the rest.
   Likely spots: near the surface, in a tight gap between scenery or glass, or after an edit, a
   water-volume change or a navmesh rebuild changed the mesh. Aquarium species use 3D underwater
   nav worlds with clearance (`Navigation_Navmesh_DEF` `OctreeRadius` 0.25-1, `OctreeMinDepth` 2-3).
2. The habitat's reachability check fails, and the SOS system boxes the animal where it is. To the
   player this looks like "it thinks it's out of the water".
3. Either the SOS doesn't set `i_unbox`, or the automatic unbox fails ("not on accessible land").
   Then the animal stays boxed. The box plays its let-me-out animation,
   `DoesAnimalWantToBeLetOutOfBox` turns true (the panel says "Boxed for too long"), welfare
   drops, and much later `AnimalInProlongedLockdown` ("An animal has been boxed for too long")
   fires.
4. The player's Unbox works, because `UnboxAnimal` from Lua places the animal again.

**Possible extra cause (guess):** juveniles of many aquarium species use a smaller nav world than
adults. For example, the Sand tiger shark goes from `Underwater-Medium R-0.5` as a juvenile to
`Underwater_Large R-2.5` as an adult (`animals.fdb` `Navigation_Navmesh`). The Humphead wrasse
also differs by sex. An animal that grows up in a spot the bigger mesh doesn't cover would fail
the check. That would explain "over time".

**Ruled out as the usual cause:** the habitat-lockdown boxing for a broken barrier. That path is
`habitatboundary:IsBoundaryBroken` / `IsAnimalRequestingBoxed`; the repair tutorial ends with
"Unbox all animals". It boxes the whole habitat, but the reports are about single animals.
Check this in the trace anyway.

## What Lua can see and do (offline: every call below is used by game Lua)

- Read: `animals:IsAnimalBoxed`, `IsAnimalRequestingBoxed`, `IsAnimalRequestingUnboxed`,
  `IsBoxingClaimed`, `DoesAnimalWantToBeLetOutOfBox`, `IsAnimalUnboxableByPlayer`,
  `IsBoxWaitingForNavMeshRebuild` ("Building Habitat Data"), `IsAnimalInBoxAndBoxAnimating`,
  `GetCurrentLocationType`, `GetAssignedHabitatEntityID`, `GetAnimalTransportData`, and
  `habitat:IsAquarium`.
- Messages: `MsgType_AnimalBoxedMessage` and `MsgType_AnimalUnboxedMessage`
  (`editors.park.animaldatabasetab.lua` ~90).
- Act:
  - The Unbox button runs `ClaimBoxing(e)` and then `UnboxAnimal(e)` (`animalinfopopup.lua`
    ~4588, and `HabitatUtils.UnboxAllAnimalsInHabitat`, which first checks
    `IsAnimalUnboxableByPlayer`).
  - Fallback: `RequestTransportToAssignedHabitat(e)`, so staff carry the animal and place it.
  - `animals:SOS(e)` is also callable. It is the retail debug "SOS from here" button, and calling
    it would box the animal again.
- **Can't:** change the reachability check, the SOS decision, how the navmesh is built, or what
  the SOS does to the box. All of that is in the exe, which we never touch.
- Data levers: `animals.fdb` `Navigation_Navmesh` and `Navigation_Navmesh_DEF` could in theory be
  overridden through a pack's `Databases.<Pack>` merge, for example to give juveniles the adult
  nav world. Untested, it probably needs prebuilt nav-world prefabs, and it would change how every
  aquarium animal moves. Not recommended.

## Our mod today

`kinboxedcore.js` `isBoxedWaiting` alerts only for animals boxed **outside** any habitat
(`a.hab` set → no alert). So an animal boxed inside its aquarium gets no alert from us.

## Recommended approach

1. **Prove the trigger first** (debug build, one session in a park with aquariums). Trace each
   `AnimalBoxedMessage`, plus a slow poll of boxed animals, and log: species, age class, sex,
   habitat and `IsAquarium`, `lt`, and all the boxing reads above. Log them again when
   `DoesAnimalWantToBeLetOutOfBox` turns true. This shows whether it is the SOS (single animals,
   not requested, not waiting on the navmesh), the lockdown, or a navmesh rebuild.
2. **Alert (fits current rules):** add a "boxed in its own habitat" case to the boxed alert.
   Conditions: in the assigned habitat, not claimed, no transport job, not requested-boxed by the
   game. Give it an **Unbox** button that runs the vanilla Claim + Unbox sequence and shows the
   game's reason when `IsAnimalUnboxableByPlayer` is false. This is click-started, so it is fine
   in Franchise.
3. **Auto-release (needs a developer decision for Franchise):** a watcher that runs the same
   sequence by itself once `DoesAnimalWantToBeLetOutOfBox` is true. Rules:
   - one animal at a time;
   - skip it while the game still wants it boxed (`IsAnimalRequestingBoxed`, waiting on the
     navmesh, claimed, a transport job);
   - if the animal is boxed again within minutes, fall back to
     `RequestTransportToAssignedHabitat`, back off, and then just alert.

   Unboxing is park simulation, not a market or server transaction. But a timer-driven action in
   Franchise is an exception to the click-started rule, like Auto mode was (2026-10-19).

## First traced session (Y:, 2026-10-19 15:14-15:24, game 1.0.5)

Source: `pz2qol.boxtrace.lua` LOG lines, copy of trace.log in the session scratchpad. **proven** for
this park (6 aquariums, 30 water habitats).

- **Not out of the water.** Hawksbill turtles in aquariums 111805 and 113228 were boxed while
  swimming mid-water: 6.8-8.1 m below the surface, 0.9-2.2 m above the lake floor, 1.4-14 m from
  the lake's side bounds. They were slowly rising before it happened. No age class changed.
- **How a game-made boxing looks:** `claimed=true, animating=true, reqBox=false, reqUnbox=false`
  for 2-4 s (the box-in animation), then `claimed=false, unboxable=true` and nothing else. After
  115-209 s `wantsOut` turns true ("Boxed for too long"). The game never sets `reqUnbox` for these
  animals; they stayed boxed until the player's Unbox (15:23:58, four turtles together; 234-384 s).
- **Land and shore animals box and unbox by themselves.** Lemurs, otters, penguins, leopards,
  gibbons, a lynx and an owl showed `claimed=true, reqUnbox=true` boxings that ended after 2-6 s
  (the game's own unbox). Aquarium animals got no `reqUnbox`, which fits the native "UnboxAnimal
  call on animal which is not on accessible land" path: the automatic unbox needs land, and an
  aquarium has none.
- **At park load the game unboxes saved-boxed aquarium animals** (a sand tiger and two turtles
  went `reqUnbox=true` and ended within 14 s), so reloading frees them for a while.
- **It recurs quickly.** One turtle was boxed again 14 s after the player's unbox.
- `unboxable` (`IsAnimalUnboxableByPlayer`) stayed true the whole time a game-boxed aquarium
  animal sat in its box, so the vanilla Claim + Unbox sequence can release it from Lua.
- Two game crashes during traced sessions: one proven from registering message receivers
  (removed); one at 15:24:33 proven from the dump: BoxTrace read `IsAnimalBoxed` on an animal no habitat listed any more (fixed: never read ids from earlier ticks). Position sampling
  (transform reads from the worker-thread park tick) is now off by default, just in case.

**Conclusion:** the boxing itself is native and can't be changed. The game never letting an
aquarium animal out again is what the mod can fix. It would watch for aquarium animals that are
boxed, unclaimed, have no transport job, aren't requested boxed and are unboxable, wait a short
delay, then run Claim + Unbox, one animal at a time, and back off if the same animal gets boxed
again right away.
