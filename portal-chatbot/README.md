# portal-chatbot

A Portal chat persona backed by an OpenAI-compatible model endpoint. @-mention
it (or reply to it) and it answers with the channel's recent history as
context. It holds no Discord bot token and uses no integration slot: it
self-enrolls a persona from a Portal invite and talks only to the relay.

One process is one persona. It talks either to a **route** from the route
table (Surplus Intelligence models, metered and capped) or, with no route set,
to OpenRouter as it always has (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`,
`OPENROUTER_PROVIDER`; unmetered, uncapped).

The full environment list is the header comment of `src/index.mjs`.

```bash
npm test     # node --test, no network
```

## Routes

The route table is one JSON file, read once at start:
`CHATBOT_ROUTES` (default `~/Projects/portal-runtime/routes.json`). The
process picks its row by `CHATBOT_ROUTE` (e.g. `argon`). Changing a row and
restarting that persona switches its model, endpoint or limits; nothing else
repeats those settings. `routes.example.json` in this package is the
committed starting table (Gemini 4 Argon, Muse Wonder, MiMo V2.6 Pro, Gemini
3.8 Flash, prices from the Surplus catalogue of 2026-10-18).

```json
{
  "defaults": { "base_url": "https://api.surplusintelligence.ai/v1",
                "key_env": "SURPLUS_DISCORD_API_KEY",
                "key_file": "~/Projects/shimmer-discord/.env.surplus-discord",
                "max_tokens": 2048, "context_chars": 75000 },
  "routes": {
    "argon": { "model": "gemini-4-argon",
               "base_url": "https://api.surplusintelligence.ai/min70/v1",
               "daily_usd": 0.30,
               "usd_per_mtok": { "prompt": 2.0, "completion": 10.0,
                                 "cache_read": 0.1, "cache_write": 0.1875 },
               "allowed_params": ["max_tokens", "reasoning", "reasoning_effort",
                                  "seed", "stop", "temperature", "top_p"] }
  }
}
```

| Field | Meaning |
|---|---|
| `model` | Model id at the endpoint. Required. |
| `base_url` | OpenAI-compatible base; `/chat/completions` is appended. Surplus: `…/v1`, or `…/min70/v1` for the discount floor. |
| `key_env` | Name of the variable holding the API key. Required. |
| `key_file` | Optional dotenv file read for `key_env` when the variable is not in the environment — keeps the key out of the plist. |
| `extra` | Top-level body fields copied verbatim: only `provider`, `providers_blocked`, `provider_order`, `si_route`. |
| `max_tokens` | Reply budget (default 2048). |
| `context_chars` | History window in characters (default 75000). |
| `daily_usd` | Daily cap in catalogue dollars, UTC day. Omit for no cap. Needs `usd_per_mtok`. |
| `usd_per_mtok` | USD per million tokens: `prompt`, `completion` (required), `cache_read`, `cache_write` (each falls back to `prompt`). A route with prices is metered. |
| `allowed_params` | Generation parameters the model accepts (from the catalogue's `supported_parameters`). Only these are ever sent. `tools`, `tool_choice`, `audio`, `modalities` and `include_reasoning` are refused: the persona is text only. |
| `params` | Values for allowlisted parameters (e.g. `{"temperature": 0.8}`); a name outside `allowed_params` fails the load. |

`defaults` fills any field a route leaves out; `extra` and `params` merge one
level deep. Keys starting with `_` are comments. An unknown field, an
`extra` key outside the four, or a parameter outside the allowlist stops the
persona at start with a message naming the route and field.

## Context

The history sent is the newest whole messages whose rendered transcript fits
`context_chars`, plus the system prompt and the one-line address. Split-send
parts are folded back into their message; a part whose first part is older
than the fetched history is dropped rather than sent as a fragment. History
is paged back 100 messages at a time until the window can be filled, at most
`CHATBOT_HISTORY` messages (default 500).

## Spend and the cap

Every call on a metered route appends one JSON line to
`CHATBOT_SPEND_DIR/<route>.jsonl` (default `~/Projects/portal-runtime/spend/`):
`ts` (UTC), `route`, `model`, `status`, `request_id`, `response_id`, `usage`
as reported, `usage_reported`, `tokens` (the disjoint counts priced),
`estimated`, `dollars`, `prompt_chars`, and `error` when there is one.

- **Dollars** are catalogue figures: fresh input × prompt + cache reads ×
  read + cache writes × write + output × completion. On the OpenAI shape
  `prompt_tokens_details.cached_tokens` (and `cache_write_tokens`) are inside
  `prompt_tokens` and subtracted from it; Anthropic-style top-level
  `cache_read_input_tokens` / `cache_creation_input_tokens` are taken as
  separate. Reasoning tokens are inside completion and not added again. A
  `/min70` call is counted at full catalogue price — this is not what Surplus
  billed.
- **No usage** (a 200 without `usage`, or a request that got no response) is
  recorded with `usage_reported: false` and charged `max_tokens` × completion
  + sent prompt characters / 3 × prompt. An HTTP error the marketplace
  answered (402, 5xx) is recorded at 0.
- **The cap**: before answering, today's (UTC) dollars for the route are
  summed from its file. At or over `daily_usd`, or after a 402 from the
  endpoint today, the persona posts *"Daily model budget reached; back at
  00:00 UTC."* once per channel (a thread counts as its own channel) and is
  silent there until the reset. No retry on 402, no fallback endpoint. The
  hold and the noticed channels are kept in
  `CHATBOT_SPEND_DIR/<route>.state.json`, so a restart does not repeat
  either.
- A capped route answers one trigger at a time, so the cap is overshot by at
  most one reply. That holds for **one process per route**; two processes on
  the same route would each overshoot. The hard stop is the key's own daily
  limit at Surplus, which arrives as the 402.

## Adding a persona

1. Add or pick a route in `~/Projects/portal-runtime/routes.json` (start
   from `routes.example.json`).
2. Mint an invite for it — in portal-admin (*Invites → new*), or
   `node portal-relay/scripts/mint-invite.mjs --file ~/Projects/portal-runtime/invites.json --roles <role> --label <name> --max-uses 1`.
3. Write a launchd plist like `com.portal.deepseek.plist`, with this
   environment (no key in it; the route's `key_file` supplies it):

   ```
   CHATBOT_ROUTE        argon
   PORTAL_PERSONA_NAME  Argon
   PORTAL_CREDENTIALS   /Users/wolfram/Projects/portal-runtime/argon.creds.json
   PORTAL_INVITE        <code from step 2; only read on the first run>
   PORTAL_URL           ws://127.0.0.1:8790
   PATH                 /opt/homebrew/bin:/usr/bin:/bin
   ```

   `ProgramArguments` is `node …/portal-chatbot/src/index.mjs`, as for
   DeepSeek. Each persona needs its own `PORTAL_CREDENTIALS` file.
4. Load it; the first run enrolls the persona and writes the creds file, and
   the log's first line names the route, endpoint, window and cap.
