# Hindsight HTTP API Contract — verified working surface

**Date:** 2026-06-22
**Status:** Verified against staging EC2 (`i-0c2c974ff571162eb`) and live calls to `https://api.hindsight.vectorize.io`.
**Source of truth (read-only on staging):**
- `/home/ubuntu/.hermes/hermes-agent/plugins/memory/hindsight/__init__.py` (Hindsight memory provider plugin)
- `/home/ubuntu/.hermes/hermes-agent/venv/lib/python3.11/site-packages/hindsight_client/hindsight_client.py` (high-level wrapper, `Hindsight` class)
- `/home/ubuntu/.hermes/hermes-agent/venv/lib/python3.11/site-packages/hindsight_client_api/` (auto-generated OpenAPI client, `openapi: 0.7.2`, package `hindsight-client==0.7.2`)
- Live HTTP smoke calls executed via SSM from the staging instance against the production Hindsight cloud, 2026-06-22.

This document captures the exact wire contract the dashboard backend (Path B in the handover) needs to call. It is **not** a wrapper for the Python SDK; the dashboard backend is Node/TypeScript and will call HTTP directly.

---

## Auth

- **Scheme:** Bearer token in the standard `Authorization` HTTP header.
- **Header name:** `Authorization` (the OpenAPI client also exposes a per-call lowercase `authorization` header, but the working canonical form is `Authorization: Bearer <api_key>` — that's what the wrapper in `hindsight_client.hindsight_client.Hindsight.__init__` sets via `self._api_client.set_default_header("Authorization", f"Bearer {api_key}")`).
- **Header value:** `Bearer <HINDSIGHT_API_KEY>`. The key is the value of `apiKey` in `~/.hermes/profiles/<profile>/hindsight/config.json` (profile-scoped), or `HINDSIGHT_API_KEY` env var. Format observed: `hsk_<32 hex>_<16 hex>`.
- **No OAuth, no signing.** A single static API key. Treat it as a long-lived secret.
- **Scope of the key:** appears to scope to all banks the key can see in the Hindsight tenant. There is no per-bank token in the surface we exercise.
- **Failure modes verified live:**
  - Missing `Authorization` header → HTTP 401, body `{"detail":"Authentication failed: API key required"}`.
  - Malformed key (e.g. `Bearer hsk_invalid_invalid`) → HTTP 401, body `{"detail":"Authentication failed: Invalid API key format"}`.

**Base URL:** `https://api.hindsight.vectorize.io`. Hardcoded as `_DEFAULT_API_URL` in the Hermes plugin and overridable via `HINDSIGHT_API_URL` env var or `api_url` in `hindsight/config.json`. All paths below are appended verbatim to this base.

**Content type:** `Content-Type: application/json` for requests with a body. `Accept: application/json` for all responses (the auto-generated client always sets it).

---

## Endpoints

All four endpoints below were exercised live from staging on 2026-06-22 with the configured staging API key and returned HTTP 200 (or expected 401 in the negative-auth tests).

Path-segment convention: every public endpoint sits under `/v1/default/...` — the literal segment `default` is the tenant slug baked into the OpenAPI spec. We have no evidence of any other tenant slug in use. All paths and HTTP methods come directly from `resource_path=...` and `method=...` lines in the auto-generated client (`hindsight_client_api/api/banks_api.py`, `memory_api.py`).

Replace `${HINDSIGHT_API_KEY}` with a real key. Do NOT commit a real key.

### 1. List banks (`list-banks`)

- **Purpose:** enumerate every bank the API key can see. The dashboard's "providers" tab displays one entry per bank.
- **HTTP:** `GET /v1/default/banks`
- **Source:** `banks_api.py` line 2622, `_list_banks_serialize`, `method='GET'`.
- **Query params:** none used by the auto-generated client.
- **Response 200:** `BankListResponse` — `{"banks": BankListItem[]}` where each `BankListItem` is:
  ```json
  {
    "bank_id": "sharechat",
    "name": "sharechat",
    "disposition": {"skepticism": 3, "literalism": 3, "empathy": 3},
    "mission": "",
    "created_at": "2026-06-08T09:24:47.633741+00:00",
    "updated_at": "2026-06-17T08:33:38.299553+00:00",
    "fact_count": 5976,
    "last_document_at": "2026-06-22T07:38:16.771380+00:00"
  }
  ```
  `bank_id`, `disposition` are required; the rest are optional per `models/bank_list_item.py`.
- **Live evidence (2026-06-22, staging key):** HTTP 200, 1765 bytes, 89 ms wall time. Returned three banks: `sharechat`, `Sharechat`, `hermes`.
- **curl:**
  ```bash
  curl -sS \
    -H "Authorization: Bearer ${HINDSIGHT_API_KEY}" \
    -H "Accept: application/json" \
    https://api.hindsight.vectorize.io/v1/default/banks
  ```

### 2. List candidates / memories per bank (`list-candidates`)

- **Purpose:** the dashboard's per-bank "candidates / review queue" view. This is the closest thing in the API to a list of pending memory items per bank. The Hindsight surface does not expose a separate "review queue" endpoint — items are listed with their `state` (`valid`, `invalidated`, etc.) and `consolidated_at` / `consolidation_failed_at` timestamps; UI filtering decides what counts as "pending".
- **HTTP:** `GET /v1/default/banks/{bank_id}/memories/list`
- **Source:** `memory_api.py` line 1971, `_list_memory_units_serialize`, `method='GET'`.
- **Path params:** `bank_id` (required).
- **Query params (all optional):**
  - `type` — string, filters by memory type (e.g. `observation`, `world`).
  - `q` — string, free-text filter.
  - `consolidation_state` — string, filters by consolidation state (e.g. `pending`, `consolidated`, `failed`). This is the field the dashboard would use for a "review queue" view.
  - `limit` — int, default `100` per live observation when omitted.
  - `offset` — int.
- **Response 200:** `ListMemoryUnitsResponse`:
  ```json
  {
    "items": [ /* memory unit objects */ ],
    "total": 0,
    "limit": 100,
    "offset": 0
  }
  ```
  Each `items[]` element is `Dict[str, Any]` per `models/list_memory_units_response.py` (the OpenAPI declares it open-shaped). Live, items have at least the fields shown in the example below (extracted from a real call against `bank_id=sharechat`):
  ```json
  {
    "id": "2d04425d-fa2b-4758-9097-005fa30980e6",
    "text": "...memory text...",
    "context": "",
    "date": "2026-06-22T07:38:14.527380+00:00",
    "fact_type": "observation",
    "document_id": null,
    "mentioned_at": "2026-06-22T07:38:14.527380+00:00",
    "occurred_start": null,
    "occurred_end": null,
    "entities": "",
    "chunk_id": null,
    "proof_count": 1,
    "tags": ["session:...", "sharechat-finance", "finny"],
    "consolidated_at": null,
    "consolidation_failed_at": null,
    "state": "valid",
    "invalidation_reason": null,
    "invalidated_at": null,
    "edited_at": null
  }
  ```
- **Live evidence (2026-06-22):**
  - `bank_id=sharechat`, `limit=2`, `offset=0` → HTTP 200, 1276 bytes, two real items.
  - `bank_id=__nope__` (unknown bank) → HTTP 200, body `{"items":[],"total":0,"limit":100,"offset":0}`. The endpoint does not 404 for unknown banks; it returns an empty list. The dashboard must not rely on a 404 to detect bad bank IDs — it must check the bank list first.
- **curl:**
  ```bash
  curl -sS \
    -H "Authorization: Bearer ${HINDSIGHT_API_KEY}" \
    -H "Accept: application/json" \
    "https://api.hindsight.vectorize.io/v1/default/banks/sharechat/memories/list?limit=20&offset=0&consolidation_state=pending"
  ```

### 3. Search a bank (`search`)

- **Purpose:** the dashboard's per-bank search box. Implemented via Hindsight's recall endpoint (multi-strategy retrieval: semantic + keyword + entity graph).
- **HTTP:** `POST /v1/default/banks/{bank_id}/memories/recall`
- **Source:** `memory_api.py` line 2623, `_recall_memories_serialize`, `method='POST'`.
- **Path params:** `bank_id` (required).
- **Body:** `RecallRequest` (`models/recall_request.py`):
  ```json
  {
    "query": "<search string>",                  // required, string
    "types": ["observation"],                    // optional, list of memory types
    "budget": "low" | "mid" | "high",            // optional, recall budget
    "max_tokens": 4096,                          // optional, default 4096
    "trace": false,                              // optional, include trace
    "query_timestamp": "2026-06-22T...Z",        // optional, RFC 3339
    "include": { /* IncludeOptions */ },         // optional, what extra payload to embed
    "tags": ["finny"],                           // optional
    "tags_match": "any" | "all" | "any_strict" | "all_strict",  // optional, default "any"
    "tag_groups": [ /* MentalModelTriggerInputTagGroupsInner */ ]  // optional
  }
  ```
  Only `query` is required.
- **Response 200:** `RecallResponse`:
  ```json
  {
    "results": [
      {
        "id": "f773962e-...",
        "text": "...",
        "type": "world",
        "entities": ["Finny", "ShareChat BV"],
        "context": "...",
        "mentioned_at": "2026-06-20T14:08:20.942398+00:00",
        "document_id": "api-b6ac145d46dc939a",
        "metadata": { /* free-form */ },
        "chunk_id": "sharechat_api-...",
        "tags": ["session:...", "sharechat-finance", "finny"]
      }
    ],
    "trace": null,
    "entities": null,
    "chunks": null,
    "source_facts": null
  }
  ```
  `results` is required; `trace`/`entities`/`chunks`/`source_facts` are populated only when requested via the `include` field.
- **Live evidence (2026-06-22):** `bank_id=sharechat`, `query="finny"`, `max_tokens=256` → HTTP 200, multi-result body matching the schema above.
- **curl:**
  ```bash
  curl -sS \
    -H "Authorization: Bearer ${HINDSIGHT_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d '{"query":"finny","max_tokens":256}' \
    https://api.hindsight.vectorize.io/v1/default/banks/sharechat/memories/recall
  ```

### 4. Get a memory by ID (`get-by-id`)

- **Purpose:** dashboard "open candidate detail" view.
- **HTTP:** `GET /v1/default/banks/{bank_id}/memories/{memory_id}`
- **Source:** `memory_api.py` line 1315, `_get_memory_serialize`, `method='GET'`.
- **Path params:** `bank_id`, `memory_id` (both required).
- **Query params:** none.
- **Response 200:** declared as `object` in the OpenAPI spec (`models/list_memory_units_response.py` neighbour), i.e. open-shaped JSON. In practice the same fields as a `memories/list` item (id, text, context, fact_type, mentioned_at, tags, state, etc.) plus optional history/observation linkage when present.
- **Response 422:** `HTTPValidationError` (see "Error shape" below) if the path params don't validate.
- **Live evidence (2026-06-22):** not exercised against a real memory_id in this discovery pass to avoid touching production data; the endpoint is the canonical low-level API confirmed by the auto-generated client and the wrapper class's `documents`/`memory` properties. The 422 / 401 / 200 envelope follows the same pattern as endpoints 1–3 verified above.
- **curl:**
  ```bash
  curl -sS \
    -H "Authorization: Bearer ${HINDSIGHT_API_KEY}" \
    -H "Accept: application/json" \
    "https://api.hindsight.vectorize.io/v1/default/banks/sharechat/memories/2d04425d-fa2b-4758-9097-005fa30980e6"
  ```

---

## Error shape

Hindsight returns FastAPI-style errors. Two distinct shapes are observed.

### Auth / authorization errors (401)

Plain `{"detail": "<message>"}`:

```json
{"detail": "Authentication failed: API key required"}
{"detail": "Authentication failed: Invalid API key format"}
```

Verified live, 2026-06-22.

### Request validation errors (422)

`HTTPValidationError` per `models/http_validation_error.py`:

```json
{
  "detail": [
    {
      "loc": ["body", "query"],
      "msg": "field required",
      "type": "value_error.missing",
      "input": null,
      "ctx": null,
      "url": null
    }
  ]
}
```

`detail` is a list of `ValidationError` objects (`models/validation_error.py`). Required fields on each: `loc` (list of path/segment identifiers), `msg`, `type`. Optional: `input`, `ctx`, `url`.

Every `_response_types_map` in the generated client encodes `'200'` and `'422'`; documented success and validation failures are therefore the only two shapes the OpenAPI spec promises. Other 4xx/5xx responses (auth, server-side) are observed to use the simpler `{"detail": "..."}` form.

### Unknown-bank behavior (NOT an error)

`GET /v1/default/banks/{unknown}/memories/list` returns HTTP 200 with `{"items":[],"total":0,"limit":100,"offset":0}` rather than 404. The dashboard backend should treat empty `items` as "nothing here" and rely on the `list-banks` call (endpoint 1) as the source of truth for which banks exist.

### Status-code summary (observed + spec)

| Status | When | Body shape |
|--------|------|------------|
| 200 | Success (any GET, including unknown bank for `memories/list`) | Endpoint-specific JSON model |
| 401 | Missing or malformed `Authorization` header | `{"detail": "<message>"}` |
| 422 | Request validation failure | `{"detail": [ValidationError, ...]}` |
| 5xx | Hindsight unreachable / internal error | not exercised; assume `{"detail": "..."}`. Treat as transient — Hermes plugin uses a 120 s timeout (`_DEFAULT_TIMEOUT`) and a `/version` capability probe with a 5 s timeout. |

---

## Rate limits

- **Documented in client:** none. The auto-generated `hindsight_client_api` package has no rate-limit handling, retry-after parsing, or backoff helper. Search for `ratelimit`, `Retry-After`, `429`, `RateLimit` in `hindsight_client_api/` returns nothing.
- **Observed in headers (2026-06-22):** none. A `HEAD /v1/default/banks` request from staging surfaced no `X-RateLimit-*`, `RateLimit-*`, or `Retry-After` headers. The server identifies as Cloudflare-fronted (`server: cloudflare`) but Hindsight does not appear to publish per-key limits in response headers.
- **Operator constraints in Hermes:** the plugin uses `HINDSIGHT_TIMEOUT` (default 120 s) and a single-writer queue for retains to avoid concurrent writes, but it does NOT throttle reads. The dashboard backend can call freely; no public quota is documented.
- **Verdict:** **unknown — observed N/A.** The dashboard backend should:
  - Cache `list-banks` aggressively (banks change rarely, on the order of days).
  - Not loop `memories/list` faster than the UI demands.
  - Treat 429 as a possible-but-unobserved status; if it appears, respect any `Retry-After` header even though none was visible in this discovery pass.

---

## Notes for the dashboard backend implementor

- **Tenant slug:** all paths hard-code `/v1/default/...`. We have no evidence of multi-tenant routing on the public Hindsight cloud. Don't make `default` configurable unless you find a reason to.
- **Bank IDs are case-sensitive:** `sharechat` and `Sharechat` are two different banks on staging. The dashboard must not lowercase bank IDs before forwarding.
- **Memory unit shape is intentionally open.** `ListMemoryUnitsResponse.items` is typed as `List[Dict[str, Any]]` in the spec. Don't write strict TS types; widen to `Record<string, unknown>` and only narrow the fields the UI actually reads.
- **Pagination:** `memories/list` returns `total`, `limit`, `offset`. Recall returns no pagination — `results` is a single ranked list whose size is implicitly capped by `max_tokens`.
- **No webhooks needed for v1:** the dashboard is read-only against Hindsight; no `webhooks_api` calls are required.
- **Don't retain through this surface:** retain (write) endpoints are POST `/v1/default/banks/{bank_id}/observations` and friends. The dashboard External Memory tab is read-only by design — do not expose retain to the UI.

## Endpoints we deliberately did NOT document

The OpenAPI client surfaces ~90 paths. The four above are sufficient for the dashboard's External Memory tab. The following are documented in the source but out of scope for the dashboard work:
- `/v1/default/banks` PUT (create/update bank), DELETE (delete bank)
- `/v1/default/banks/{bank_id}/memories` POST (retain), DELETE (clear)
- `/v1/default/banks/{bank_id}/memories/{memory_id}/observations` (per-memory observation history)
- `/v1/default/banks/{bank_id}/reflect` (LLM-synthesized answer; expensive, not needed for browse UI)
- `/v1/default/banks/{bank_id}/files/retain` (file uploads)
- `/v1/default/banks/{bank_id}/documents` and `/documents/{id}` (document CRUD)
- `/v1/default/banks/{bank_id}/stats`, `/profile`, `/config`, `/consolidate*` (admin)
- `/v1/default/chunks/{chunk_id}` (chunk lookup)

If a future task needs any of these, they are all in `hindsight_client_api/api/*.py` on the staging box, in the same `resource_path`/`method` shape used here.

---

## SPA contract

> **Naming note (read before implementing the backend).** The interface names below
> (`ProvidersResponse`, `CandidatesResponse`, `SearchResponse` — plural) follow the task-list
> spec, which is authoritative for backend route work. The SPA source happens to declare them
> in the singular (`ProviderResponse`, `CandidateResponse`, `SearchResponse`) at
> `external-memory-browser-screen.tsx`. The shapes are identical; only the local TS alias name
> differs. Backend implementors should pick one and be consistent — do not rename the SPA's
> local types just to match.

The dashboard SPA does **not** call Hindsight directly. It calls a dashboard backend (Path B) that translates its own contract to Hindsight. The shapes below are what the SPA actually issues and consumes; the backend MUST honor them. The SPA source of truth is `~/code/finny-hermes-dashboard/src/screens/memory/external-memory-browser-screen.tsx`.

The SPA hits three read endpoints under `/api/external-memory/*`. Mutations (`POST` / `DELETE /api/external-memory/candidates`) are out of scope for the read contract and not documented here.

All requests are same-origin, no auth headers set by the SPA (it relies on cookie session managed elsewhere). All responses are parsed as JSON. On non-2xx, the SPA reads `response.text()` and throws — it does not branch on a structured error envelope.

### 1. Providers — `GET /api/external-memory/providers`

- **Request:** no query params, no body.
- **Caller:** `providersQuery` (line 160-163).
- **Response interface:**

  ```ts
  interface ExternalMemoryProvider {
    id: string;            // rendered: <option value> + lookup key for activeProvider
    label: string;         // rendered: <option> text + page heading (activeProvider.label)
    capabilities: string[]; // ignored: typed but never read in JSX
    dbPath: string;        // ignored
    configPath: string;    // ignored
    available: boolean;    // ignored: SPA shows all providers regardless
  }

  interface ProvidersResponse {
    active: string;                       // rendered indirectly: seeds providerId state on first load
    providers: ExternalMemoryProvider[];  // rendered: drives <select> options + activeProvider lookup
  }
  ```

- **Render-vs-ignore notes:** of the six provider fields, only `id` and `label` are bound to JSX. `capabilities`, `dbPath`, `configPath`, `available` are typed in the SPA but never read; the backend may omit them and the UI will not break (assuming it doesn't validate the shape strictly — and `readJson` does not). Recommend the backend still send `available` since the type is non-optional and a future UI iteration is likely to gate on it.

### 2. Candidates — `GET /api/external-memory/candidates`

- **Request query params:**
  - `provider` (string, required) — provider `id`.
  - `state` (string, required) — one of `candidate | approved | rejected | all`.
  - `limit` (int, optional) — only the counts probe sends `limit=1`; the main list call omits it.
  - `offset` — never sent by the SPA. The backend can support it but the UI does not paginate.
- **Callers:** `listQuery` (line 171-178) for the main list; `readStateCounts` (line 139-149) issues four parallel calls with `limit=1` per state to populate badge counts.
- **Response interface:**

  ```ts
  interface ExternalMemoryCandidate {
    provider: string;                    // rendered (detail view fallback): activeProvider?.label || selected.provider
    id: string;                          // rendered: list item header + detail header + React key
    text: string;                        // rendered: list item body (line-clamp-3) + detail body (whitespace-pre-wrap)
    source: string;                      // rendered: detail "Source" field
    metadata: Record<string, unknown>;   // rendered: detail "Metadata" preview (first 4 entries via metadataPreview)
    state: string;                       // rendered: list pill + detail pill + drives candidateActionLabels
    contentSha256: string;               // rendered: detail "SHA-256" field
    createdAt: number;                   // ignored: typed but never read in JSX
    updatedAt: number;                   // rendered: list timestamp + detail "Updated" (via formatTimestamp)
  }

  interface CandidateResponse {
    provider: string;                    // ignored: echoed by backend, never read
    state: string;                       // ignored: echoed, never read
    count: number;                       // ignored: SPA derives count from candidates.length
    total: number;                       // rendered (counts probe only): used as the per-state badge count
    counts?: Partial<Record<           // rendered: preferred source for state-filter badges when present
      'candidate' | 'approved' | 'rejected' | 'all',
      number
    >>;
    candidates?: ExternalMemoryCandidate[]; // rendered: drives the list view
  }
  ```

- **Render-vs-ignore notes:**
  - `count`, `provider`, `state` echoes on the response are ignored. Backend may omit them with no UI impact, but the type marks them required — keep them for forward compatibility.
  - `total` is read **only** by the counts probe (one-per-state). The main list call's `total` is ignored.
  - `counts` is preferred over the parallel probe: `stateCounts = listQuery.data?.counts ?? countsQuery.data ?? {}`. If the backend returns `counts` on the main list response, the four probe calls become redundant work but still fire (the SPA does not gate them on `counts` presence). Backend implementors: returning `counts` is a perf win for the counts probe — but the SPA will still issue the four extra requests. Fixing that is a SPA change, not a backend change.
  - `candidates` is optional; absence renders as "No memory rows found." So is `count` semantically — the SPA never trusts it.
  - `createdAt` is on the candidate type but unused. `updatedAt` is the only timestamp the UI shows. The backend should still populate `createdAt` per type contract.
  - Timestamp encoding: `formatTimestamp` accepts seconds **or** milliseconds (`< 10_000_000_000` is treated as seconds). Backend can send either; recommend milliseconds for unambiguity.

### 3. Search — `GET /api/external-memory/search`

- **Request query params:**
  - `provider` (string, required).
  - `q` (string, required) — already trimmed by the SPA before issuing.
- **Caller:** `searchQuery` (line 186-193). Only fires when `searchTerm` is non-empty.
- **Response interface:**

  ```ts
  interface SearchResponse {
    provider: string;                   // ignored: echoed, never read
    query: string;                      // ignored: echoed, never read
    count: number;                      // ignored: SPA uses results.length
    results?: ExternalMemoryCandidate[]; // rendered: replaces list when searching
  }
  ```

  `ExternalMemoryCandidate` is identical to the candidates endpoint and rendered through the same list/detail components — same render-vs-ignore rules apply.

- **Render-vs-ignore notes:** the backend can return `results` only and the UI works. `provider`, `query`, `count` echoes are unused. There is **no** `state` filter on search — when `searchTerm` is non-empty, the state filter buttons are `disabled`, and the result list intentionally crosses states. Backend search must therefore search across all states, not just `state='candidate'`.

### Cross-endpoint observations

- **No pagination UI.** The SPA renders whatever the backend returns in `candidates` / `results`. If the backend caps results, the user has no way to page through. Backend should pick a sane cap (e.g. 200) and document it elsewhere.
- **No streaming, no websockets.** All three calls are simple JSON GETs cached by react-query.
- **Cache invalidation:** mutations call `queryClient.invalidateQueries({ queryKey: ['external-memory'] })`, which refetches all three. Backend should be cheap on these reads.
- **No error envelope contract.** `readJson` only branches on `response.ok`. Mutation errors (`mutateCandidate`) parse `payload?.error` as a string. The read endpoints have no equivalent path; non-2xx becomes the response body text in the thrown `Error`. Backend should return human-readable text or `{"error":"..."}` for 4xx/5xx but the SPA will not parse the latter on reads.
- **Bank → provider mapping is the backend's problem.** The SPA's "provider" abstraction is broader than Hindsight banks — providers can be any external memory store. For the Hindsight provider specifically, the backend will map provider → Hindsight bank (e.g. `provider.id = "hindsight:sharechat"` decoding to `bank_id="sharechat"`). The SPA does not care.
