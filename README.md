# llm-gateway

**Per-model, cache-aware LLM cost attribution with an append-only usage ledger.**

[![CI](https://github.com/builtbyai/llm-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/builtbyai/llm-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Most token trackers add up `input + output` tokens, multiply by a flat rate, and
call it a day. That answer is wrong the moment prompt caching is involved —
often by **5–10×** on a cache-heavy workload — because it conflates two prices
that are nowhere near each other:

- **Cache _creation_** (writing a block into the cache) bills at **1.25×** the
  base input rate for a 5-minute TTL, or **2×** for a 1-hour TTL.
- **Cache _read_** (reusing a cached block) bills at **0.1×** the base input rate.

That's a **12.5×** spread between writing and reading the *same tokens* at the
5-minute tier. Collapse those into one number and a workload that looks
expensive (lots of cache writes) or nearly free (lots of cache reads) gets
mispriced in whichever direction hurts most. `llm-gateway` keeps
`cacheCreationInputTokens` and `cacheReadInputTokens` as **distinct fields with
distinct multipliers**, all the way from the per-call cost function through the
per-model / per-provider rollups.

---

## Install

```bash
npm install llm-gateway
```

Node 18+ (uses the built-in global `fetch`). Zero runtime dependencies.

---

## The cost model

### Per-call cost

`computeCost(usage, model)` prices a single response. `model` accepts a
canonical id (`'claude-opus-4-7'`) or a tier alias (`'advanced'`, `'sonnet'`,
`'fast'`, …). `usage` is the token block you get back from the Anthropic API.

```ts
import { computeCost } from 'llm-gateway';

// A cache-hit call: 1M tokens served from cache, 100 tokens generated.
const cost = computeCost(
  { inputTokens: 0, outputTokens: 100, cacheReadInputTokens: 1_000_000 },
  'claude-opus-4-7'
);
// => 0.5025  (1M x $5/MTok x 0.1 read-mult  +  100 x $25/MTok)

// The SAME 1M tokens, but as a cache write instead of a read:
const writeCost = computeCost(
  { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
  'claude-opus-4-7'
);
// => 6.25   (1M x $5/MTok x 1.25 write-mult)  --  12.5x the read cost
```

Under the hood the money is split four ways and summed:

```
baseInput   = inputTokens              / 1e6 * inputCostPerMTok
cacheWrite  = cacheCreationInputTokens / 1e6 * inputCostPerMTok * writeMultiplier
cacheRead   = cacheReadInputTokens     / 1e6 * inputCostPerMTok * readMultiplier
output      = outputTokens             / 1e6 * outputCostPerMTok
```

`writeMultiplier` is `1.25` for a 5-minute TTL and `2` for 1-hour; `readMultiplier`
is `0.1`. Pass the TTL as the third argument to `computeCost(usage, model, '1h')`.

### Pricing registry

Prices are pinned per model in `PROVIDERS` / `ANTHROPIC_MODELS` (USD per million
tokens), so a rate change is a one-line edit, not a hunt through the codebase.

```ts
import { ANTHROPIC_MODELS, getModelDescriptor } from 'llm-gateway';

ANTHROPIC_MODELS['claude-opus-4-7'];
// {
//   id: 'claude-opus-4-7',
//   contextWindow: 1_000_000,
//   inputCostPerMTok: 5,
//   outputCostPerMTok: 25,
//   cacheWriteMultiplier5min: 1.25,
//   cacheWriteMultiplier1h: 2,
//   cacheReadMultiplier: 0.1,
//   supportsCaching: true,
//   supportsVision: true,
// }

getModelDescriptor('anthropic', 'advanced')?.id; // 'claude-opus-4-7'
```

Three providers ship out of the box — `anthropic` (priced), `openai`, and
`ollama` (local, $0) — each with `fast` / `standard` / `advanced` tier aliases.

---

## The usage ledger

Every priced call is one line of JSON, appended to a log you never rewrite. This
is the schema of a `UsageRecord`:

```ts
interface UsageRecord {
  timestamp: string;                    // ISO-8601
  provider: string;                     // 'anthropic' | 'openai' | 'ollama' | ...
  model: string;                        // canonical model id
  inputTokens: number;                  // fresh (uncached) input
  outputTokens: number;
  cacheReadInputTokens?: number;        // billed at 0.1x  -- kept separate
  cacheCreationInputTokens?: number;    // billed at 1.25x/2x -- kept separate
  costUsd: number;                      // from computeCost()
  source?: string;                      // optional call-site tag
  durationMs?: number;                  // optional latency
}
```

```ts
import { UsageLedger, computeCost } from 'llm-gateway';

const ledger = new UsageLedger(); // defaults to ~/.structure/usage.log

await ledger.append({
  timestamp: new Date().toISOString(),
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  inputTokens: 1_000,
  outputTokens: 500,
  cacheReadInputTokens: 90_000,
  cacheCreationInputTokens: 2_000,
  costUsd: computeCost(
    {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadInputTokens: 90_000,
      cacheCreationInputTokens: 2_000,
    },
    'claude-opus-4-7'
  ),
  durationMs: 1_800,
});
```

Append-only means it is crash-safe, trivially `tail -f`-able, and mergeable
across machines — no schema migrations, no lock contention.

### Aggregation rollups

`summarize()` (or `ledger.summarize()`) folds the ledger into totals plus
`byModel` and `byProvider` buckets. Crucially, each bucket carries its **cache
read and cache write token totals separately**, so you can see *why* a model is
cheap or expensive, not just that it is.

```ts
const sum = await ledger.summarize();

sum.totalCostUsd;      // grand total USD
sum.cacheHitRate;      // cacheReads / (input + reads + writes), in [0,1]
sum.byModel['claude-opus-4-7'];
// {
//   calls, costUsd,
//   inputTokens, outputTokens,
//   cacheReads,   // <- distinct
//   cacheWrites,  // <- distinct
// }
```

---

## CLI

A tiny, dependency-free entry point over the same library:

```bash
llm-gateway usage                 # human-readable rollup
llm-gateway usage --json          # machine-readable summary
llm-gateway usage --last 200      # only the most recent 200 calls
llm-gateway usage --records       # raw per-call lines
```

```
Usage summary  (ledger: ~/.structure/usage.log)

  Calls            : 2
  Total cost       : $0.0610
  Cache reads      : 90,000
  Cache writes     : 2,000
  Cache hit rate   : 96.3%

  By model:
    claude-opus-4-7    1 calls   $0.0610   cache_read=90,000
    qwen2.5-coder:7b   1 calls   $0.0000   cache_read=0
```

---

## Numbers

Real fleet numbers are not committed — they live on the owner's machines. The
table below is a placeholder; **populate it from your own `~/.structure/usage.log`
via `llm-gateway usage`** (or `--json` piped into your own reducer).

| workload            | calls | median ms | p99 ms | cache-read % | $/1k calls |
| ------------------- | ----: | --------: | -----: | -----------: | ---------: |
| _code-review_       |     — |         — |      — |            — |          — |
| _doc-summarize_     |     — |         — |      — |            — |          — |
| _agent-loop_        |     — |         — |      — |            — |          — |
| _embedding (local)_ |     — |         — |      — |            — |          — |

> Real numbers live on the owner's fleet, not in this repo.

---

## Fleet routing (optional)

`OllamaFleet` routes inference across a set of local Ollama nodes by task type
(reasoning / coding / vision / embedding / fast / general), model availability,
and per-node GPU/RAM capability, with a 30-second health cache. The default node
list is a **demo topology** (`node-a` / `node-b` / `node-c` on `localhost` and
`*.local`) — swap in your own `FleetNode[]` via the constructor.

```ts
import { OllamaFleet } from 'llm-gateway';

const fleet = new OllamaFleet(); // or new OllamaFleet(myNodes)
const route = await fleet.route('reasoning');
// { node, model, reason: 'gpu-node (GPU) -> qwq:32b for reasoning' }

console.log(await fleet.status()); // live health + routing table
```

---

## API

```ts
import {
  computeCost,        // (usage, model, ttl?) -> USD
  estimateCost,       // (descriptor, usage, ttl?) -> USD (lower-level)
  cacheHitRate,       // (usage) -> [0,1]
  buildCachedSystem,  // marks stable system/skill blocks as ephemeral

  PROVIDERS,          // provider registry (anthropic/openai/ollama)
  ANTHROPIC_MODELS,   // pinned per-model pricing
  getModelDescriptor, // (provider, idOrTier) -> ModelDescriptor
  resolveModel,       // tier alias -> model id

  UsageLedger,        // append-only ledger class
  appendUsage,        // functional append (default ledger path)
  readUsage,          // functional read
  summarize,          // records -> UsageSummary (byModel/byProvider + cache totals)
  ledgerPath,         // default ledger location

  OllamaFleet,        // multi-node router (optional)
} from 'llm-gateway';
```

---

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # jest
npm run build       # emit dist/
```

## License

MIT — see [LICENSE](./LICENSE).
