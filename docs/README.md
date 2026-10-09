# NewsTrader documentation index

**What this project is:** a personal, single-developer research system that ingests financial news,
has an LLM convert each novel story into a structured signal, and lets deterministic code decide and
paper-trade on it — in order to **measure whether news interpretation has a tradeable edge**. Profit
is the hypothesis, not the assumption. There is no real-money code path.

---

## Reading order

**If you are an agent or engineer about to change code, read in this order.** Steps 1–3 are the
minimum to avoid doing damage; 4–5 are needed before touching money-path or analytics code.

| #   | Read                                                       | Why                                                                                   |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | [`../CLAUDE.md`](../CLAUDE.md)                             | The invariants you must not break, and the conventions the code already follows       |
| 2   | [`codebase-guide.md`](codebase-guide.md)                   | Repo map, every module's job, how data flows, where to make which kind of change      |
| 3   | [`roadmap.md`](roadmap.md)                                 | What is built, what is not, and what is deliberately deferred — check before planning |
| 4   | [`business-logic.md`](business-logic.md)                   | Every rule, threshold, and invariant **with the reason it exists**                    |
| 5   | [`newstrader-architecture.md`](newstrader-architecture.md) | The approved design + all verified vendor/cost/regulatory research                    |

**If you are operating the system rather than changing it,** go straight to
[`../README.md`](../README.md) — quickstart, the full CLI reference, and the deploy runbook.

---

## The documents

| Document                                                                     | Purpose                                                                                                                                                       | Status                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`codebase-guide.md`](codebase-guide.md)                                     | Structural reference: packages, modules, data flow, conventions, testing, gotchas. Answers "where does X live / how do I change Y."                           | Current                                                                      |
| [`business-logic.md`](business-logic.md)                                     | The rules and their motivation: pipeline-stage semantics, every tunable parameter and why it has that value, the invariants and what breaks without them.     | Current                                                                      |
| [`milestones.md`](milestones.md)                                             | What each built milestone (M0, M1, M3, M4, M5) added and why — the narrative formerly in the top-level README.                                                | Current                                                                      |
| [`roadmap.md`](roadmap.md)                                                   | Remaining work (M2 LLM stage, M5 evaluation), safety gaps, measured debt, deferred ideas with revival triggers, idea parking lot.                             | Current                                                                      |
| [`newstrader-architecture.md`](newstrader-architecture.md)                   | The original approved architecture, and the durable record of verified vendor facts (costs, rate limits, ToS, broker/venue analysis for a Canadian resident). | **Keep — has a drift section at the top.** Its §10 build order is historical |
| [`newstrader-implementation-prompt.md`](newstrader-implementation-prompt.md) | The build spec that produced the code.                                                                                                                        | **Historical.** Still the most specific spec for unbuilt parts               |
| [`../README.md`](../README.md)                                               | Operator runbook: quickstart, CLI table, deploy prerequisites, kill-switch operation.                                                                         | Current                                                                      |

---

## Which doc do I update when?

Keeping these honest is cheap if done at the time and expensive later.

- **Changed a threshold, gate, or confidence value?** → `business-logic.md` (its parameter registry
  is meant to be exhaustive) and the `rules_versions` label if it is engine config.
- **Added a module, table, or pipeline stage?** → `codebase-guide.md`, and `../README.md` if it adds
  a CLI command or a deploy step.
- **Finished a milestone?** → `milestones.md` (what it added and why) and the status table in
  `roadmap.md`.
- **Finished, dropped, or discovered work?** → `roadmap.md`. Deleting a roadmap item is a decision;
  say why in the commit.
- **Learned a vendor/cost/regulatory fact** (a price changed, an entitlement resolved, a ToS
  shifted)? → `newstrader-architecture.md`, since that is the research record, and resolve the
  matching `[re-check at build]` flag.
- **Made a design decision that contradicts the architecture doc?** → add a row to its drift table
  at the top _and_ a work item in `roadmap.md`. Never silently diverge; the next agent will assume
  the doc is true.

## Notes on provenance

- An earlier planning document exists outside the repo at
  `~/.claude/plans/lets-work-on-architecture-linked-wand.md`. It is **superseded** by
  `newstrader-architecture.md`, which contains everything in it plus the detail. Do not treat it as
  current.
- The architecture and vendor research were produced by parallel research agents with live source
  verification, then hardened by two adversarial critique passes; the M1/M3/M4 implementations each
  went through two adversarial reviews (correctness + data-integrity or money-path safety) whose
  findings were fixed before commit. That is why several comments in the code read like warnings —
  they are recording a bug that was actually caught, not a hypothetical.
