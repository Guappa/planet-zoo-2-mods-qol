# Breeding programme: how far can the optimisation go? (research, 2026-10-18)

Research only, nothing implemented. Scope: the Species board's **Breeding programme**
(`kinprogramme.js`), one species at a time, with a budget of up to **5 minutes per species**.
Experiments ran in the scratchpad against the real module (`planProgramme`, `scoreLayout`); the
numbers below come from them.

## 1. Answer in short

- **The layout problem is a standard one**: an assignment of animals to capacitated habitats with
  an exact matching inside each (capacitated facility location for harems and mixed groups,
  matching plus bin packing for pairs), with "no relatives together" as conflict edges. It is
  NP-hard, but small. It has an **exact mixed-integer linear programme (MILP)** that reproduces
  the programme's score to 1e-6 (validated on 144 zoos).
- **Today's search is good, not optimal.** Against proven optima it is 0.7–1.7 % short on
  average, up to 3.7 %, and optimal in 9 of 29 proven zoos. At 100 breeders the best known layouts
  beat it by about 2 % on average (one monogamy zoo by 13.7 %). The skill's earlier "within
  0.1 %" was measured against longer runs of the same search, which get stuck in the same places.
- **What 5 minutes buys:**
  - **Up to about 40–70 breeders, the proven optimum.** HiGHS (open source, runs as WebAssembly)
    proves 20 breeders in about 1 s, 40 in about 13 s and 70 in about 1 minute (median). It
    proves 1 of 12 zoos at 100 breeders and none at 150.
  - **Above that, the best tool is the current search run from several starting points.** In the
    experiments, different random seeds reached the best known layout within 12 s where one
    seed stayed stuck for 78 s.
  - **A MILP bound gives a certificate either way:** "this plan is within X % of the best
    possible".
- **A better objective gains less than expected.** In a 50-year simulation of PZ2's strand
  genetics, multi-generation policies (lookahead, rare-strand bonus) beat today's myopic pair value
  by about 0.06 grade at about 20 animals, which is only suggestive, and by nothing at 40.
  Pedigree mean kinship, the real-zoo method, was the worst. Buying one unrelated animal every 7
  years beat every in-zoo policy: the ceiling is gene flow, not maths.
- **The maximum, in order of value:**
  1. Multi-start the current search, and lift its round cap so it can use the time it is given.
  2. Add a MILP (or a Lagrangian bound) to prove or measure the gap.
  3. Use the MILP as the solver itself for up to about 70 breeders, if Gameface runs
     WebAssembly.
  4. Branch-and-price, the strongest exact method, only if proofs at 100+ breeders matter.
  5. Add a strand-diversity term to the objective once the game's inheritance is confirmed.

## 2. The problem as the programme states it today

Per species, choose a place `p(i)` for every breeder `i` (an allowed habitat, the trade centre, or
its home) to maximise

```
  Σ_habitats [ BestPairs(h)                      exact b-matching inside the habitat
             − 2 · relatedCompatiblePairs(h)      relatives living together
             − 1 · adultsOverRoom(h)
             − 1 · breedersOverMakeUp(h)          1:k → max(1, ⌈females/k⌉) males, game caps per sex
             + 0.01 · distinctFamilyLines(h) ]
  − Σ_moved (0.04 + 0.02 if joining an established group) − 0.15 · bondsBroken
```

with a pair worth `pv(m,f) = youngQuality × conceptionChance × longevityWeight` (0..1), and related
pairs never pairing. Partners per animal come from the make-up: 1:1 (monogamy), 1:k, 1:∗ (harem),
k:1, ∗:1, or mixed (each female her best male). See `kinprogramme.js` lines 1–57 and
`makeState()`.

What this is, mathematically:

- An **assignment problem with an inner matching**: a partition of the breeders into capacitated
  bins (habitats) whose value is a bipartite **b-matching** inside each bin.
- Harem, 1:k and mixed make-ups are a **capacitated facility location** problem: a breeding male
  is a "facility" opened in a habitat, females are "clients" served by the best open male in the
  same habitat; related pairs are **conflict edges** (they may not share a bin cheaply).
- 1:1 is a **global matching followed by bin packing with conflicts**: once the couples are chosen,
  they still have to fit into habitats without relatives of other couples beside them.
- All three are NP-hard in general (facility location and bin packing with conflicts are), but
  the instances are small and highly structured: one species, rarely more than ~100 breeders and
  ~12 places, and a pair value matrix that can be computed once.

**Search space.** `P^n` layouts (places per breeder to the power of breeders): 20 breeders in 5
places is 10^14, 40 in 6 is 10^31, 100 in 10 is 10^100. Brute force is not an option beyond about
a dozen breeders; the question is which method gets the true optimum, or a proof of how close we
are, in the time.

**Compute budget.** The programme runs in the game's Gameface JS on the UI thread, in 24 ms slices.
Today it scores about 0.5 M layout changes per second (3 M in the board's 6 s cap). Five minutes
is ~150 M evaluations, or 50× the board's budget. A mod can't ship an executable (ground rule 6), so
any solver has to be JavaScript, or WebAssembly if Gameface runs it (**not yet known**, needs a
probe: `typeof WebAssembly` on the HUD page).

## 3. The approaches, one by one

| Approach | Exact? | Fits this problem | Feasible in 5 min per species | Verdict |
|---|---|---|---|---|
| Brute force (every layout) | yes | trivially | only to ~12–15 breeders (`P^n ≤ ~10^9`) | already used below `exactLimit` |
| Branch and bound, own JS | yes | good: an easy upper bound exists (each female's best unrelated male, room ignored) | likely to ~30–50 breeders; worse with many equal pair values | possible, but a MILP solver does this better |
| Dynamic programming | yes | poor: the state is "which animals are used", 2^n | only for special cases (1:1 couples into habitats with no cross-couple penalties ≈ knapsack) | no |
| **Mixed-integer linear programming (MILP)** | **yes, with a proof** | **very good**: the objective linearises exactly (formulation in §4) | proven optimum to ~40–70 breeders; a bound (and often a better layout) to ~100; loses to the search at 150 | **the exact method of choice up to ~70 breeders, and the gap certificate above** |
| Constraint programming (CP-SAT) | yes | good (hard "no relatives", caps) | yes, but OR-Tools has no JS/WASM build | out: can't run in game |
| Column generation / branch-and-price | yes | the strongest exact method for "choose one group per habitat": tight LP bound, pricing = best group for one habitat | yes, but much more code | only if plain MILP struggles |
| **Lagrangian relaxation** (relax "one place per animal") | gives a **bound** | decomposes per habitat; each sub-problem is a small matching | yes, in pure JS, seconds | **good companion**: proves "within X % of the best possible" for any plan |
| Min-cost flow / Hungarian | yes for a sub-problem | exact when one sex's places are fixed and penalties are linear | instant | already used (`reassign`, `reassignScarce`) |
| Simulated annealing / ILS (today) | no | good | 0.7–1.7 % mean gap to the proven optimum, up to 3.7 % (§5); multi-start closes much of it | keep as the fast path and the large-zoo solver |
| Tabu search, LNS | no | good; LNS with **exact repair** (MILP or exhaustive on 2–3 habitats at a time) is a "matheuristic" and the best non-exact option | yes | the best upgrade if WASM is unavailable |
| Genetic algorithm | no | poor: crossover of two layouts breaks the groups; needs local search to work (memetic), then it is ILS with extra steps | yes | no, except NSGA-II for a moves-vs-genetics Pareto front |
| QUBO / quantum-style annealing | no | the penalties fit, the matching doesn't | n/a | no |

## 4. The exact formulation (MILP)

Built and validated in the experiment (`scratchpad\milp\milp.mjs`). Its score equals
`makeState().total` on 96 random fixed layouts, and its optimum equals the exhaustive optimum on 48
small zoos covering all four make-ups. Unisex species are not modelled yet.

Sets: B breeders, P places (habitats, homes, trade centre), G ⊆ P group places, T(i) the places
breeder i may go (`targetsOf`).

```
variables
  x[i,p] ∈ {0,1}        breeder i lives at p                    (p ∈ T(i))
  y[m,f,p] ∈ [0,1]      pair m–f breeds at p                     (pv(m,f) > 0, p ∈ G)
  z[m,f,p] ∈ [0,1]      related compatible pair lives together at p
  o[p] ≥ 0              adults over room
  eM[p], eF[p] ≥ 0      breeders over the make-up
  l[L,p] ∈ [0,1]        family line L present at p
  s[b,q], h[b] ∈ [0,1]  bond b's two together at q / both at home

maximise
  Σ pv·y − 2Σz − Σo − Σ(eM+eF) + 0.01Σl − Σ mc(i,p)·x[i,p] − 0.15·Σ_b (1 − Σ_q s[b,q] − h[b])

subject to
  Σ_{p∈T(i)} x[i,p] = 1                          one place each
  Σ_f y[m,f,p] ≤ bM·x[m,p],  Σ_m y[m,f,p] ≤ bF·x[f,p]   partners per animal (partnersPer);
                                                  plus y ≤ x where bM or bF > 1
  z ≥ x[m,p] + x[f,p] − 1                         related pairs
  o[p] ≥ Σ_i x[i,p] + fixed[p] − cap[p]           room (fixed > cap: the constant switched by u[p] ≥ x[i,p],
                                                  since an empty place scores 0)
  harem 1:k:  a[p] ∈ ℤ≥0, w[p] ∈ {0,1}, |F_p|·w ≥ n_f, k·a + w ≤ n_f, eM ≥ n_m − 1 − a
              (exactly max(1, ⌈n_f/k⌉) males allowed); 1:∗: eM ≥ n_m − 1; game caps: e ≥ n − cap;
              k:1 the same with the sexes swapped
  l[L,p] ≤ Σ_{i∈L} x[i,p]
  s[b,q] ≤ x[a,q], s[b,q] ≤ x[b,q];  h[b] ≤ x[a,home_a], h[b] ≤ x[b,home_b]
```

Given integral x, the pairs inside a habitat are a bipartite b-matching, whose constraint matrix
is totally unimodular, so **y can stay continuous** and only the ~n·|P| placements are binary. At
100 breeders and 14 places that is about 1.4 k binaries, 29 k pair variables and 6–35 k rows.

**Its weakness is the LP bound**: 2–22 % above the optimum, worst for monogamy (14 % at 20
breeders). With fractional x, `z ≥ x + x − 1` is 0, so the relaxation ignores who lives with whom.
Making "no relatives" a hard rule (`x + x ≤ 1`) helps only a little. The fix is the classic one for
this structure: **set partitioning over whole groups** (a column = a set of animals in one habitat,
with its exact value), solved by **column generation / branch-and-price**. Its pricing problem is
"the best group for one habitat given the duals", a small b-matching with node prizes. The LP
bound of that model is far tighter, which is what proves optima at 100+ breeders. It is much more
code.

## 5. Benchmark: the current search against the true optimum

Node, HiGHS 1.15.4 as WebAssembly (npm `highs`), 300 s limit per zoo. The zoos are random:

- 20, 40, 70 and 100 breeders, each with 1:1, 1:3, harem and mixed make-ups and 3 seeds;
- 150 breeders with 2 seeds;
- 3–12 habitats, shared parents, the trade centre and bonds.

"Board" is the Species board's setting: 3 M evaluations with a 6 s cap. Scripts are in
`scratchpad\milp\` (`bench.mjs`, `analyze.mjs`; raw data in `results.jsonl`).

| Breeders | MILP proved optimal | Board search optimal | Board gap to proven optimum (mean / max) | Median proof time | MILP's best beats the board |
|---|---|---|---|---|---|
| 20 | 12 / 12 | 6 | 0.70 % / 3.72 % | 1.1 s | 6 / 12 |
| 40 | 8 / 12 | 3 | 0.79 % / 1.86 % | 12.6 s | 9 / 12 |
| 70 | 8 / 12 | 0 | 1.74 % / 2.89 % | 61 s | 11 / 12 |
| 100 | 1 / 12 | 0 | 0.69 % (one zoo) | 162 s | 9 / 12 |
| 150 | 0 / 8 | – | – | – | 2 / 8 |

The board's gap to the best layout known (a lower bound on the true gap) by make-up:

| Breeders | 1:3 | Harem | Mixed | 1:1 |
|---|---|---|---|---|
| 70 | 2.35 % | 0.40 % | 1.22 % | 2.26 % |
| 100 | 2.08 % | 0.23 % | 1.86 % | 6.86 % (one zoo 13.7 %) |

What it shows:

- **Harem is nearly solved**: choosing the heads is the hard part, and `reassignScarce` does it
  well. **Pairs (1:1) and 1:3 are where the search loses**. There the partner limits make the
  layout a matching problem across habitats, and single moves and swaps get stuck.
- **More budget does not help as configured.** The annealing stops after `min(6000, 300 + 40n)`
  rounds, long before 3 M evaluations (at most 2.6 M were used), so the board's budget and the
  default often give the same plan.
- **Restarts do.** On one 40-breeder 1:1 zoo, the default seed stayed at 7.622 even with 100 000
  rounds (78 s). Seeds 1–3 each reached 7.763 (the MILP's best) in about 12 s. On a 40-breeder 1:3
  zoo, 100 000 rounds (90 s) found the proven optimum and 20 000 (15 s) did not. At 100 breeders,
  140 s of search came within 0.1 % of the MILP's 120 s layout.
- **Above ~100 breeders the MILP loses** (at 150: 3.7 against the search's 14.1 after 300 s; the
  LP alone took over 120 s). That is the weak bound, not the size of the model.
- **The WASM build is fragile**: `RuntimeError: Aborted()` after repeated long solves in one
  process. Each solve needed a fresh instance. It is single-threaded.

Caveats: synthetic zoos with many relatives at the start (start scores −9 to −47, so there is a
lot to fix); 12 solves ran at once, so the times are pessimistic; Gameface's JS may be slower than
Node's.

## 6. Beyond one season: the multi-generation problem

The objective above is **myopic**: the best pairs now. A breeding programme in the real sense is a
sequential decision over generations, and real zoos don't optimise it pair by pair: they use
**mean kinship** ranking and **optimal contribution selection** (Ballou & Lacy 1995; PMx, the
studbook software AZA and EAZA use; Meuwissen 1997 for the quadratic programme that maximises
merit under a kinship limit), with mate selection on top (Kinghorn's MateSel).

PZ2 differs from a real zoo in a way that makes far more possible:

- **Genotypes are fully known.** `GetGenes` gives every allele, so relatedness can be measured
  directly on the strands (identity by state), not estimated from a pedigree.
- **Inheritance is per whole strand** (per the game's own prediction: 4 equally likely
  combinations per trait, no recombination inside a strand). A population's genetic future is
  then fully described by its pool of strands per trait, and an offspring's distribution has at
  most 4^4 = 256 outcomes, so exact expectations are cheap.
- **The traits pull in two directions.** Fertility and immunity reward two *different* strands
  (heterozygosity at 6 loci), size and longevity reward two copies of the *best* strand. The ideal
  animal is F 6/6, I 6/6, S 12/12, L 12/12, and whether the population can reach it depends on
  which strands it still has, so losing a rare F/I strand is a permanent cost the one-shot score
  never sees.

**Simulation** (Node, `scratchpad\multigen\sim.mjs` and `paired.mjs`):

- **Setup.** A closed population of N adults. Genetics follow `predictOffspring`: whole strands, 4 traits picked independently, no mutation unless stated. Conception uses the fallback formula `(fM+fF)/12`. Animals are fertile from age 1 to 4 and die at 7, so year 50 is about generation 20.
- **Breeding.** Monogamous pairs only. No parent, sibling or half-sibling pairs under any policy.
- **Room.** When the population is over N, the policy's own keep rule decides who leaves.
- **Runs.** 40 seeds. The score is the mean of the F, I, S and L grades, and an extinct population counts as 0.

Policies compared:

- **Myopic:** today's pair value.
- **Mean kinship:** PMx-style.
- **OCS:** pair value minus a kinship term.
- **Haplotype:** a bonus for rare F/I strands, and a keep rule that protects them and the best S/L strand.
- **Lookahead:** adds the expected value of sampled young.
- **Buy one:** myopic plus one unrelated animal bought every 7 years.

| Mean grade at year 50 | N = 12 | N = 20 | N = 40 |
|---|---|---|---|
| Myopic (today) | 0.06 (34/40 extinct) | 0.41 | 0.67 |
| Mean kinship (PMx-style) | 0.02 | 0.17 | 0.55 |
| OCS (pair value − λ·kinship) | 0.04 | 0.37 | 0.65 |
| Haplotype (rare-strand bonus, keep rule) | 0.05 | 0.47 | 0.66 |
| Lookahead (value of sampled young) | 0.02 | 0.49 | 0.67 |
| Myopic + buy 1 unrelated per 7 years | **0.34** (16/40 extinct) | **0.57** | **0.70** |
| Best genotype the founders allow | 0.83 | 0.84 | 0.86 |

Paired against myopic on the same founders, the differences at year 50 (± standard error) were:

- Lookahead: +0.07 ± 0.04 at N = 20 and +0.00 ± 0.01 at N = 40.
- Haplotype: +0.06 ± 0.05 at N = 20.
- OCS: −0.04 ± 0.06 at N = 20.
- Buying one animal every 7 years: +0.16 ± 0.05 at N = 20 (32 of 40 runs better).

The most expensive policy took 0.1 s per decision at 40 animals.

What it says:

- **The objective matters less than expected.** No multi-generation policy beat the myopic one beyond the noise. Lookahead and the strand bonus help a little in mid-sized populations (N ≈ 20), which suggests an effect but does not establish one.
- **Pedigree mean kinship, the real-zoo method, is the worst here.** It keeps more strands (7.4 vs 4.3 F strands at N = 40) but ignores fertility, so conception falls and populations die out. That method is built for unknown genotypes. PZ2 shows the genotype, and the genotype-based policies beat the pedigree-based ones.
- **Gene flow dominates.** A closed population loses F/I strands whatever the policy (N = 40: about 24 founder strands down to about 4 by generation 20). One outside animal now and then beats every in-zoo strategy. That is the market's job, not the programme's, but it sets the ceiling on what the programme can do alone.
- **Small groups collapse through conception.** Losing F lowers conception, which shrinks the group, which speeds up the loss. How hard this bites in game depends on the real conception table.
- **Run time is not the limit.** Even a rollout policy needs well under a second per decision.

Caveats: the model has one pool, not habitats and make-ups, and its weights are untuned (each tried once). The conception table is the fallback formula. All of this depends on strand-level inheritance (§8).

Approaches for the sequential problem:

| Approach | What it optimises | In 5 min | Note |
|---|---|---|---|
| Myopic matching (today) | best young this season | trivially | blind to strand loss |
| Mean kinship / OCS (QP) | merit with a cap on kinship growth | yes (a small QP, n ≤ 150) | the zoo-world standard; pedigree or strand-based kinship |
| Strand-pool value + matching | today's young + a term for strands kept | yes | cheap to add to `pv` and the place score |
| Rollout / receding horizon (MPC) | 2–3 generations simulated, re-planned each season | yes (seconds per rollout set) | the practical "maximum" |
| Full MDP / stochastic DP | exact long-run optimum | no | state = the whole population's genotypes: astronomically large |
| MCTS over pairings | long-run, approximate | marginal | high variance; rollout/MPC is simpler for the same gain |

## 7. Recommendation

The most we could do in 5 minutes per species, cheapest and surest first:

1. **Make the current search use its time** (pure JS, low risk).
   - Let the annealing run until the budget ends, not until `min(6000, 300 + 40n)` rounds.
   - Run it as a **multi-start**: K seeds or K perturbed starts, keep the best.
   - Add **large-neighbourhood search with exact repair**: free 2–3 habitats and re-solve them
     exhaustively, or with the MILP (a "matheuristic").

   This targets exactly the 1:1 and 1:3 losses above.
2. **Prove how good the plan is.** Use an LP or Lagrangian bound in JS (relax "one place per
   animal" and the problem splits into one small matching per habitat), or the MILP's bound.
   The preview could then say "best possible" or "within 1 %". The bound is weak for pairs, so
   the certificate is honest but loose until step 4.
3. **Exact solving up to ~70 breeders** with HiGHS as WebAssembly, warm-started from the search's
   plan, only if Gameface runs WebAssembly (§8). Give each solve a fresh instance, and fall back
   to step 1 when it fails or the zoo is bigger.
4. **Exact solving at 100+ breeders** needs branch-and-price on the group model (§4). This is the
   real mathematical maximum for the one-season problem, and weeks of work for a ~2 % gain on big
   zoos.
5. **The objective, after the game's inheritance is checked.** Add a strand-diversity term
   (rare F/I strands, the best S/L strand) and optionally a 2-generation rollout for mid-sized
   groups (~20 animals). Expect a small gain. Don't use pedigree mean kinship: with the genotypes
   known it is worse.
6. **Moves against genetics as an exact trade-off.** The slider ("fewer moves" ↔ "best
   genetics") is a two-objective problem. The ε-constraint MILP gives its exact Pareto front:
   the best genetics for 0, 1, 2… moves. For small zoos it could replace the slider with "+0.4
   young quality for 3 more moves".

Not worth it: dynamic programming (exponential state), genetic algorithms (crossover breaks the
groups), CP-SAT (no build that runs in game), QUBO, and a full multi-generation MDP (state space
far too large, and the simulation shows little to gain).

## 8. What has to be checked in game first

- **WebAssembly in Gameface** (`typeof WebAssembly`, instantiate a tiny module on the HUD page).
  Decides between a WASM solver (HiGHS) and pure-JS methods.
- **Strand inheritance in the native breeding**: the UI's prediction is per whole strand; that the
  real births follow it is **inferred** (`animals-and-breeding.md`). Compare a few litters' genes
  with their parents'. Mutation (new letters appearing) would change §6.
- **Traits independent?** Whether F, I, S and L strands are picked independently per young.
- **The conception table** (`info.conception`, `CalculateProbabilityOfBreedingEvent`): the
  multi-generation value depends on how strongly fertility grades drive conception.
- **How long a 5-minute search may hold the UI**: slices of 24 ms keep the game smooth, but a
  long run competes with the board's 6 s rescans; it would need to run on demand, per species,
  with a cancel.
