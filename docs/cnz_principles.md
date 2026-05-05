# CNZ v1.1 — Project Principles
*Read before writing any code. Applies to every session.*

---

## The Core Philosophy

CNZ does one thing: keep the AI's working memory minimal without losing narrative fidelity. Every architectural decision serves that goal. Complexity that doesn't serve it doesn't belong here.

The system is designed to be **super fixable, not unbreakable.** We do not try to prevent bad states. We make bad states easy to detect and trivial to recover from. If the chat is intact, everything is recoverable.

---

## The Three Kinds of Code

This is the most important principle in the codebase. Every function belongs to exactly one category. Mixing categories is the primary source of bugs.

### Pure Functions
Takes inputs, returns outputs. No side effects. No module state reads. No module state writes. No DOM. No network. Given the same inputs, always returns the same output.

When you find yourself reaching for a module variable inside a pure function, stop. Pass it as a parameter instead.

### Stateful Owners
A small, explicitly identified set of functions that are allowed to read and write module state. These are the session managers. Everything else is not allowed to touch module state directly. If a function needs state, it receives it as a parameter from a stateful owner.

### IO Executors
Execute what they are told. Write what they receive. Fire when called. They contain no business logic. If an IO function contains an if-statement that isn't error handling, something is wrong.

---

## The Data Model

**The chat JSONL is the database.** There is no external state store. All CNZ state lives in `message.extra.cnz` on specific messages. If you have the chat, you have everything.

**The Anchor is the world snapshot.** Every sync cycle commits exactly one Anchor to the chat. It contains the complete world state at that moment: hooks text, full lorebook snapshot, RAG segment reference, RAG headers. It is written once. The most recent Anchor is the Last Known Good state. On every chat load, CNZ reads it and restores from it.

**The Link is a bookmark.** Lightweight back-pointers on non-Anchor pairs in a sync block. No state data. Navigation only.

**The Prose Pair is the atomic unit.** CNZ does not count individual messages or tokens. It counts Prose Pairs. All window sizing, chunking, and boundary calculations operate in pairs.

---

## Recipes and Contracts

---

**A Recipe is static data.** Defined once at module load time, never modified at runtime. It declares everything needed to execute one AI call: what inputs it needs, how to build the prompt, which LLM profile to use, what it produces, and its staleness key. Recipes are not functions. They are declarations.

**A Trigger is also static data.** Defined once, never modified at runtime. It declares everything needed to make one scheduling decision: which event to watch, what condition must be true, and what bus event to emit when the condition is met. Triggers are not functions. They are declarations. A Trigger is to the scheduler what a Recipe is to the executor.

**Both live in `recipes.js`.** Same file, same philosophy. The only functions permitted inside either are pure — no module state reads, no side effects. All values they need are passed in as parameters.

**A Contract is a stamped Recipe.** A Recipe plus a job ID, a cycle ID, and resolved input values. Created at dispatch time. Immutable in flight.

**Dependency resolution is mechanical.** When a job completes and writes a value to the store, the resolver checks every recipe whose inputs include that output key. If all inputs are satisfied and the recipe is not already running or complete, it dispatches a new contract automatically. No special cases. Pure graph resolution.

**Fan-out is mechanical.** A recipe that declares `fanOut` produces N contracts from a single dispatch — one per element returned by the fan-out function. Each contract is a first-class job with its own `jobId`. Concurrency gating via `maxConcurrent` is enforced by `cycleStore` the same way staleness is: one counter, one comparison, no per-component logic.

---

## Triggers and the Scheduler

---

**The scheduler is dumb.** It reads Triggers, watches events, evaluates conditions, and emits decisions. It contains no narrative logic and no knowledge of what a sync does. It only decides whether and when to fire.

**Trigger conditions are pure functions.** A condition receives two parameters: a `state` snapshot assembled by the scheduler (`nonSystemCount`, `gap`, `syncInProgress`, `snoozeUntilCount`) and the active `settings` object. It returns a payload object if the condition is met, or `null` to no-op. It reads nothing from module state directly.

**`index.js` executes, the scheduler decides.** Subscribers in `index.js` receive scheduling events from the bus and call the appropriate functions. They contain no condition logic — that belongs in the Trigger declaration. If a subscriber contains an if-statement that is not error handling, something is wrong.

**The wand button is the one exception.** Manual user intent with interactive resolution (the gap choice popup) cannot be expressed as a trigger condition. The wand button computes its own gap and emits `SYNC_TRIGGERED` directly. This is intentional and not a violation — it is an entry point, not a scheduler bypass.

---

## The Message Bus

---

**The bus is dumb.** It has no knowledge of CNZ concepts. It does not inspect payloads. It does not make routing decisions. It emits and it subscribes. That is all.

**Everything is observable.** Every event that passes through the bus is loggable in one line. In development mode, a single console.log listener on the bus shows the entire life of the application — AI job lifecycle and scheduling decisions alike. This is not a nice-to-have. It is a requirement.

**The bus carries two categories of event.** AI job events (`CONTRACT_DISPATCHED`, `JOB_COMPLETED`, `JOB_FAILED`, `CYCLE_STORE_UPDATED`) are owned by `cycleStore` and `executor`. Scheduling events (`SYNC_TRIGGERED`, `MASK_ADVANCE_TRIGGERED`, `GAP_DETECTED`) are owned by `scheduler`. Both categories are first-class. Both are fully observable. Neither category knows about the other.

**Staleness is one counter and one lookup.** One global monotonic job counter. One active job number per staleness key. When a result arrives, one comparison decides whether to keep or drop it. No genId arrays scattered through the codebase. No per-component staleness flags.

---

## State Ownership

---

**Every piece of mutable state has exactly one owner.** No function outside the owner writes to that state directly. If you are writing to a state variable from a function that is not its declared owner, stop and reconsider.

**State that moves together resets together.** There are exactly three reset functions: one for session state (clears on character switch), one for modal state (clears on modal close), and one for scheduler state (clears on character switch, called by session reset). Every state variable belongs to one of them. When a new state variable is added, the first decision is which reset function it belongs to — this determines what kind of state it is.

**Stateful owners are declared, not inferred.** Each stateful owner explicitly lists the state fields it owns in its `@contract` header (`state_ownership`). If a state field has no declared owner, it has no owner — that is a bug, not an omission to be fixed later.

---

## Error Handling

Errors are reported, not swallowed. Every catch block does exactly one of:
- **Re-throws** — if the caller needs to know
- **Emits `JOB_FAILED` onto the bus** — if the pipeline needs to know
- **Toastr warning** — if the user needs to know

A catch block that does nothing is a bug.

The bus is the spine of the application. Errors that affect the pipeline belong on it. A single `JOB_FAILED` subscriber can handle logging, user notification, and retry logic in one place rather than scattered across every call site.

Sync steps are independent — a lorebook failure does not abort hooks, a RAG failure does not abort the ledger commit. Each step emits its own outcome onto the bus. The sync reporter subscribes to all outcomes and composes the final user-facing toast from what actually succeeded.

---
