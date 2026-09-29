# Task 0 spike: findings

Run on 2026-09-29, macOS, Node 24.11 locally (Render runs 22), against:
`@anthropic-ai/claude-agent-sdk` 0.3.284, `@modelcontextprotocol/server` 2.2.0,
`@modelcontextprotocol/node` 2.1.0, `@modelcontextprotocol/client` 2.2.0, `zod` 4.6.5.
Scripts: `scripts/spike/mcp-echo.ts`, `scripts/spike/agent-two-turns.ts`, `scripts/spike/vapi-log-server.ts`.

## MCP v2 (Q1, Q2)

**Q1. Import paths and names.**

| Need | Import |
|---|---|
| Server | `McpServer` from `@modelcontextprotocol/server` |
| Stateless HTTP | `createMcpHandler(factory)` from `@modelcontextprotocol/server`, returns a fetch-shaped handler; `toNodeHandler(handler)` from `@modelcontextprotocol/node` makes it a `node:http` handler |
| stdio | `serveStdio(factory)` and `StdioServerTransport` from `@modelcontextprotocol/server/stdio` |
| Client | `Client` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/client`; headers go in `{ requestInit: { headers } }` |

`createMcpHandler` calls the factory once per HTTP request and serves both protocol eras: 2026-07-28 ("modern") and 2025 ("legacy", stateless fallback, the default). No `sessionIdGenerator` wiring is needed.

**Q2. Can a tool handler read request headers?** Yes, two ways, both confirmed on the wire:

```
result: {"fromCtx":"spike-1","fromAls":"spike-1","ctxKeys":["sessionId","mcpReq","http"]}
```

`ctx.http.req` is the web `Request`, and `AsyncLocalStorage` set in the `node:http` wrapper survives into the handler. **Decision:** keep the plan's `AsyncLocalStorage` design (Task 6). It also carries the fault header and does not depend on an SDK context shape that is still moving.

## Agent SDK (Q3 to Q7)

Model `claude-haiku-4-5`, streaming input, `tools: []`, `settingSources: []`, `strictMcpConfig: true`, MCP over HTTP with an `x-conversation-id` header, `outputFormat: json_schema`.

**Q3. Does the SDK's MCP client talk to the v2 server?** Yes.

```
init mcp_servers: [{"name":"relaypay","status":"connected","source":"dynamic"}]
tools: [ 'mcp__relaypay__echo_header', 'mcp__relaypay__slow_lookup' ]
```

A `system/init` message is emitted again at the start of **every** turn, not only the first.

**Q4. One `result` per turn, with `structured_output`?** Yes. Each turn ended in its own `result` with `subtype: 'success'` and `structured_output` set.

**Structured output is a tool call.** The SDK delivers `outputFormat` through a built-in tool named `StructuredOutput`. It appears as a `tool_use` block in the assistant message, and **it reaches PreToolUse hooks**:

```
PreToolUse saw: mcp__relaypay__echo_header
PreToolUse saw: StructuredOutput
```

**Q5. Is `total_cost_usd` cumulative?** Yes: 0.00436, 0.00713, 0.01303, 0.01613, 0.01992 across five turns. Per-turn cost is the difference, as Task 12 assumes.

**Q6. Wall-clock times** (from pushing the user message to the `result`):

| Turn | Wall time |
|---|---|
| `startup({ options })` until ready | 723 to 754 ms |
| T1, first turn, no tool | 5,543 ms |
| T2, no tool | 3,921 ms |
| T3, one MCP tool | 5,104 ms (6,289 ms on a second run) |
| T5, no tool, after an interrupt | 2,686 ms |

The second no-tool turn is **over 3 s**, above the spec's 2.0 s p50 target. Part of it is the `StructuredOutput` round trip. This is the baseline Task 18's Sonnet comparison is read against, and the filler line matters more than the plan assumed.

**Q7. `interrupt()` during a tool call.** The `result` arrived **8 ms** after `interrupt()`, with `subtype: 'error_during_execution'` and no `structured_output`. The next turn on the same session succeeded normally.

**`canUseTool` is shadowed by `allowedTools`.** The SDK warns at start:

```
[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked for: mcp__relaypay__*.
Bare allowedTools entries auto-approve the whole tool before the callback is consulted.
To gate every tool call, use a PreToolUse hook.
```

**`startup()` is single-use and bound to its options.** `startup({ options })` returns a `WarmQuery` whose `.query(prompt)` may be called once. Options include the per-call `x-conversation-id` header, so a boot-time warm query cannot serve an arbitrary later call. `prewarm()` (a spare process claimed later) exists but is marked `@alpha`.

**`zod` 4's JSON Schema is refused by the CLI.** `z.toJSONSchema()` adds `"$schema": "https://json-schema.org/draft/2020-12/schema"`, and the CLI exits with `--json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. Dropping the `$schema` key fixes it.

## Vapi custom-llm (Q8 to Q11): open, needs the owner

These need the owner's Vapi dashboard and a public tunnel (`cloudflared` is not installed on this machine). `scripts/spike/vapi-log-server.ts` is ready: run it, run `cloudflared tunnel --url http://localhost:8789`, point a throwaway assistant's Custom LLM URL at the tunnel, press Talk, paste the log here, and delete the assistant.

- **Q8.** Request path: _open_
- **Q9.** Where the call id arrives: _open_
- **Q10.** Are both SSE chunks spoken: _open_
- **Q11.** The `messages` array on turn two: _open_

Until these are answered, the plan's fallbacks stand: `parseChatRequest` reads the call id from `body.call.id`, then `body.metadata.callId`, then the `callId` query parameter (Task 14), and `/vapi/chat/completions` is the route, with Task 15's `model.url` adjusted if Q8 says otherwise.

## Consequences for later tasks

| Finding | Task | Change |
|---|---|---|
| `StructuredOutput` is a tool_use block | 12 | `ClaudeSession.turn` yields `tool_start` only for `mcp__relaypay__*` tools, so the filler is not spoken on every turn |
| `StructuredOutput` reaches PreToolUse | 12 | `makePreToolUseHook` always allows `StructuredOutput` and does not count it toward the 4-per-turn cap. Otherwise a turn with four real tools would have its reply denied |
| `canUseTool` shadowed | 12 | Keep `canUseTool` as the deny for anything that is not a RelayPay tool (it still guards non-allowlisted names), but the per-turn cap, the post-escalation lookup ban and the budget ban live in the PreToolUse hook, as planned. The warning is expected |
| `$schema` refused | 11 | `REPLY_JSON_SCHEMA` is `z.toJSONSchema(ReplySchema)` with `$schema` removed, pinned by a unit test |
| `system/init` every turn | 12 | The session parser ignores `system` messages; nothing reads init after Task 0 |
| `startup()` single-use | 14 | Prewarm per call: on `status-update in-progress`, `sessions.getOrOpen` calls `startup({ options })` with that call's options, while Vapi speaks the first message. At boot, `agent/main.ts` runs one throwaway `startup()` and `close()`s it, only to fault in the native binary. No boot-time warm session is kept |
| Q6 over 3 s | 18 | Recorded as the baseline for the Haiku and Sonnet comparison |

## Supabase project

Not created yet (Task 2, Step 0). The project ref goes here when it is, never the password.
