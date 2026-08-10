# ADR-0032: Segment Stable System Prompts for Explicit Caching

## Status

Accepted

## Context

ADR-0031 routes matching request shapes with a project-scoped key. Its live proof used byte-identical prompts and showed a 5,120-token cache-read increase on the configured third-party GPT-5.6 endpoint. That proof does not establish reuse when the user or dynamic system suffix changes.

GPT-5.6 places its implicit cache breakpoint at the latest user or tool message. A stable key improves routing but cannot declare that an earlier prefix should be written and read. Pi also permits `before_agent_start` extensions to append dynamic task and memory state to the system prompt, while the current explicit implementation places its breakpoint at the end of the complete system string.

## Decision

Pi will retain the exact prompt text and classify the base system prompt as a stable prefix only when it is an exact prefix of the effective per-turn system prompt.

For OpenAI Responses requests:

1. derive routing from the exact stable base, tools, model, project scope, and output shape;
2. exclude the dynamic system suffix and conversation tail;
3. when model compatibility enables both explicit cache mode and content breakpoints, split the existing provider content block at the stable boundary and attach the breakpoint there;
4. otherwise preserve implicit caching;
5. collect privacy-safe routing diagnostics and hot-key evidence without mutating tool order or prompt text.

Official OpenAI GPT-5.6 generated metadata enables both capabilities. Third-party models require explicit compatibility configuration. The known `rayin-gpt/gpt-5.6-terra` endpoint remains implicit because its previous breakpoint probe returned 502.

## Consequences

### Positive

- Task-ledger and memory suffix changes no longer rotate the stable route fingerprint.
- Verified providers can reuse the base prompt when the user suffix changes.
- Replacing/prepending extensions fail safely to implicit behavior.
- Diagnostics identify prompt, tool, output-shape, model, and traffic causes without exposing their contents.

### Negative

- Enabling explicit support starts a new provider cache population and writes can cost more than uncached input.
- One stable project key can become hot under high concurrency.
- Provider compatibility metadata must remain accurate.

### Neutral

- Provider-visible prompt text, instruction order, tools, tool order, history, and model settings are unchanged.
- Hot-key sharding is deferred until request-rate evidence exceeds the provider threshold.
- Third-party gateways that lack explicit breakpoints still benefit only from stable routing.

## Alternatives

### Insert a marker into the system prompt

Rejected because the marker changes model-visible input and can affect output.

### Move dynamic extension state into user messages

Rejected because it changes instruction priority and behavior.

### Sort tools before sending

Rejected because order is observable to the model. Pi records order drift instead.

### Enable explicit fields for every GPT-5.6-compatible gateway

Rejected because the configured gateway has already rejected this syntax. Capabilities are provider/model-specific.

### Automatically shard every routing key

Rejected until measured traffic exceeds the hot-key threshold; fixed sharding duplicates cache warm-up work at ordinary request rates.

## References

- [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [ADR-0031: Route Prompt Caches by Stable Project Prefix](0031-shared-prefix-prompt-cache-routing.md)
- [Prompt cache architecture](../prompt-cache-architecture.md)
