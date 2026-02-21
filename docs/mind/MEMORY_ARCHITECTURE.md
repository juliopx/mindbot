---
summary: "Technical architecture of MindBot's Subconscious and Mind Memory systems."
read_when:
  - You want to understand how the agent maintains continuity and a sense of self.
  - You are debugging memory retrieval or narrative consolidation.
  - You need to configure narrative model resolution or subconscious agent behavior.
---

# Mind Memory & Subconscious Architecture

MindBot (OpenClaw fork) implements a **Dual-Process Theory of Mind**, separating immediate conversational logic from long-term narrative identity and semantic resonance.

## 1. Architectural Overview

The memory system is divided into two primary loops:

### A. The Conscious System (Foreground)
*   **Context Window**: Holds the short-term chat history for immediate response generation.
*   **Direct Recall Tools**:
    *   `remember`: Queries the Graphiti knowledge graph for facts and entities.
    *   `journal_memory_search`: Semantically searches Markdown chunks from `MEMORY.md` and `memory/*.md`.
    *   `journal_memory_get`: Reads specific memory file content by path.

**Recall Protocol**:
When the `mind-memory` plugin is active, the system prompt instructs the agent to check *both* memory systems (`remember` for the knowledge graph, `journal_memory_search` for Markdown files) before answering questions about prior work, decisions, or user preferences. When only the base memory plugin is active, the prompt guides `journal_memory_search` / `journal_memory_get` only.

### B. The Subconscious System (Background)
*   **Memory Resonance**: Before every turn, a 6-phase **Subconscious Resonance Pipeline** surfaces relevant past moments as natural-language flashbacks silently injected into the system prompt. See [Section 5](#5-the-subconscious-resonance-pipeline) for full detail.
*   **Narrative Consolidation**: A background process distills raw conversation (batched by token count) into a persistent, first-person autobiography (`STORY.md`).

---

## 2. Memory Components

### Graphiti (Episodic & Semantic)
MindBot uses Graphiti (via MCP server) as its primary long-term repository.
*   **Episodes**: Every turn is stored as a raw chronological event.
*   **Entities (Nodes)**: People, places, concepts extracted from conversations.
*   **Facts (Edges)**: Relationships and facts connecting entities.
*   **Neural Resonance**: Retrieval-Augmented Generation (RAG) using semantic search to find relevant past interactions.
*   **Heartbeat Isolation**: Messages like `HEARTBEAT_OK` are filtered out before reaching the graph to maintain signal quality.
*   **Docker-based**: Runs via Docker Compose with FalkorDB backend at `http://localhost:8001`.

### Mind Memory (`STORY.md`)
The core of MindBot's identity is stored in a local Markdown file.
*   **The Global Story**: A first-person narrative ("I", "My") that evolves with the user.
*   **Global Scope**: All interactions across channels are consolidated into a single identity (`global-user-memory`).
*   **Persistence**: Unlike context-window memory, the story is perpetual and survives session resets.
*   **Injection**: Content is injected into the agent's system prompt every turn, providing historical weight and temporal awareness.

---

## 3. The Consolidation Pipeline

To keep the narrative updated without overwhelming the context, the system follows this workflow:

```mermaid
sequenceDiagram
    participant U as User
    participant R as Runner
    participant L as Pending Log
    participant G as Graphiti
    participant S as STORY.md
    
    U->>R: New Message
    R->>G: Add Episode
    R->>L: Append to pending-episodes.log
    Note over R: Check Batch (Threshold > 5000 tokens)
    R->>S: Read Current Story & metadata
    S-->>R: LAST_PROCESSED Header
    R->>L: Read transcript from Log
    R->>LLM: Synthesize New Chapter
    R->>S: Write Update
    R->>L: Clear Log
    Note over R: Narrative Updated
```

### Safety & Integrity Mechanisms
*   **Audit Log**: The `pending-episodes.log` provides a reliable, auditable trace of what is about to be narrativized.
*   **Metadata Anchors**: Employs an invisible HTML comment `<!-- LAST_PROCESSED: [ISO] -->` to track narrated progress.
*   **Heartbeat Protection**: Consolidation is explicitly skipped for heartbeat turns.

---

## 4. Technical Implementation

### ConsolidationService

**File**: `src/services/memory/ConsolidationService.ts`

The ConsolidationService handles narrative generation and STORY.md updates:

*   **syncStoryWithSession**: Main consolidation method that processes a batch of messages.
*   **Type Safety**: Strict type validation prevents corruption (e.g., `[object Object]` bug fix):
    ```typescript
    let rawStory = typeof response?.text === "string" ? response.text : "";
    ```
*   **Comprehensive Validation**: Logs unexpected response types, empty strings, and errors.
*   **Two-Phase Processing**:
    1. **Primary Response**: Generate new narrative chapter from messages.
    2. **Compression** (optional): If story exceeds length limit, compress older sections.

### SubconsciousAgent Factory

**File**: `src/agents/pi-embedded-runner/subconscious-agent.ts`

Factory function that creates a lightweight LLM client for narrative generation:

*   **Streaming**: Uses `streamSimple` from `@mariozechner/pi-ai` for efficient token streaming.
*   **Error Detection**: Detects error events emitted by the stream (not thrown as exceptions).
*   **Automatic Failover**: If primary model fails via Copilot, automatically retries with `gpt-4o`:
    ```typescript
    if (result.streamError && isCopilotProvider && result.text.length === 0) {
      // Failover to gpt-4o
    }
    ```
*   **Audio Format Handling**: Processes mu-law audio chunks (8kHz telephony standard).
*   **Debug Mode**: Comprehensive logging when `debug: true` is passed.

### Model Resolution

**File**: `src/agents/pi-embedded-runner/run.ts`

Narrative model resolution follows this hierarchy:

1. **mindConfig.config.narrative.provider/model**: Primary source for narrative-specific model.
2. **Chat model fallback**: If not configured, uses the main agent's chat model.
3. **Error handling**: If resolution fails, logs warning and falls back gracefully.

```typescript
const narrativeProvider =
  (mindConfig?.config as any)?.narrative?.provider || provider;
const narrativeModel =
  (mindConfig?.config as any)?.narrative?.model || modelId;
```

The SubconsciousAgent is created at two points in the agent lifecycle:

*   **Global narrative sync**: Before agent run starts (batch consolidation of recent sessions).
*   **Post-compaction**: After context window compaction (consolidate compacted messages).

### Integration Points

**Runner Integration** (`src/agents/pi-embedded-runner/run.ts`):

1. **Startup**: Loads STORY.md and injects into system prompt.
2. **Pre-turn**: Queries Graphiti for memory resonance ("Flashbacks").
3. **Post-turn**: Appends episode to Graphiti and pending-episodes.log.
4. **Batch trigger**: When log crosses threshold (~5000 tokens), triggers consolidation.
5. **Post-compaction**: Consolidates compacted messages into story.

**Safety Mechanisms**:
*   **Metadata Anchors**: `<!-- LAST_PROCESSED: [ISO] -->` tracks narrated progress.
*   **Heartbeat Protection**: Consolidation skipped for heartbeat turns.
*   **Audit Log**: `pending-episodes.log` provides reliable, auditable trace.
*   **Type Validation**: Strict type checking prevents object/string confusion.
*   **Graceful Degradation**: Empty responses return current story unchanged.

---

## 5. The Subconscious Resonance Pipeline

**Core file**: `src/services/memory/SubconsciousService.ts`

The pipeline runs before every non-heartbeat agent turn and follows 6 sequential phases:

```mermaid
sequenceDiagram
    participant U as User Message
    participant SA as Subconscious Agent (LLM)
    participant GS as GraphService / Graphiti
    participant F as Filters
    participant TF as time-format.ts
    participant SA2 as Subconscious Agent (Re-Narrativize)
    participant SP as System Prompt

    U->>SA: Current prompt + last N messages
    SA->>SA: Extract entities & semantic queries
    SA->>GS: Graph traversal (depth 2) + parallel node/fact search
    GS->>GS: sanitizeQuery() — strip punctuation / RediSearch operators
    GS-->>F: Raw MemoryResult[]
    F->>F: Memory Horizon filter (remove in-context memories)
    F->>F: Echo Filter (suppress recently shown, ~25-turn cache)
    F->>F: Sort: Boosted → Facts → randomized temporal spread
    F->>F: Limit to max 5 fragments
    F->>TF: getRelativeTimeDescription(date)
    TF-->>F: "hace unos días — 9 feb"
    F->>SA2: Raw lines + currentPrompt + SOUL.md + STORY.md
    SA2->>SA2: Rewrite in user's language, first-person, no invention
    SA2-->>SP: Inject [SUBCONSCIOUS RESONANCE] block
```

### Phase 1 — Seed Extraction

`SubconsciousService.generateSeekerQueries()` and `extractEntities()` use the Subconscious Agent (a lightweight LLM) to analyze the current message + recent history and produce:
- **Named entities**: People, places, projects
- **Semantic queries**: 2–3 clean search phrases (Telegram IDs and technical metadata are stripped)

### Phase 2 — Graph Retrieval

`GraphService.searchNodes()` and `searchFacts()` are called in parallel per query. Before any Graphiti call, `sanitizeQuery()` strips characters that break the RediSearch query engine:

```typescript
// Removes punctuation and special chars, keeps Unicode letters, numbers, spaces
private sanitizeQuery(query: string): string {
  return query.replace(/[^\p{L}\p{N}\s\-_]/gu, " ").replace(/\s+/g, " ").trim();
}
```

### Phase 3 — Temporal & Quality Filters

- **Memory Horizon** (`applyMemoryHorizon`): Removes memories that fall within the current conversation's visible window — they're already in context.
- **Echo Filter** (`applyEchoFilter`): A circular buffer of ~25 recently-injected memory IDs prevents repeating the same flashback every turn.
- **Priority sort**: Boosted → Facts first → pseudo-random temporal spread to avoid showing N memories from the same date.
- **Limit**: Maximum 5 fragments per turn (configurable).

### Phase 4 — Temporal Labeling

`getRelativeTimeDescription(date)` in `src/utils/time-format.ts` converts each memory's timestamp into a human-readable sensation:

| Range | Label |
|---|---|
| < 30 min | `hace un momento` |
| 30 min – 2 h | `hace un rato` |
| 2–6 h | `hace unas horas` |
| 6–18 h | `hoy más temprano` |
| 18–30 h | `ayer` |
| 2–4 days | `hace unos días` |
| 4–10 days | `la semana pasada` |
| 10–20 days | `hace unas semanas` |
| 20–45 days | `hace un mes` |
| 45–90 days | `hace un par de meses` |
| 3–6 months | `hace varios meses` |
| 6–11 months | `hace casi 1 año` |
| ~1 year | `hace 1 año` |
| ~1 year+ | `hace 1 año y algo` |
| ~N years | `hace N años`, `hace N años y algo`, `hace casi N+1 años` |

The exact date is appended: `hace unos días — 9 feb`.

### Phase 5 — Re-Narrativization

The raw fragments (which contain technical log language like `"human asks..."`, `"assistant replied..."`) are rewritten by the Subconscious Agent using:

- **Language detection**: Current user message sets the output language
- **SOUL.md**: Loaded from workspace and injected as persona/tone reference
- **STORY.md**: Loaded from workspace and injected as narrative/relationship context
- **Anti-hallucination rules** (enforced in the prompt):
  1. Do not invent facts not explicitly in the raw memory
  2. Do not add sensory details (`"te escuché"`, `"vi"`) unless literally stated
  3. Only rephrase style and point-of-view; keep all facts sourced from raw text
  4. When uncertain, stay closer to the original wording

### Phase 6 — Injection

The rewritten flashbacks are wrapped in a minimal block and injected into the main agent's System Prompt:

```
---
[SUBCONSCIOUS RESONANCE]
- Hace unos días — 9 feb, la madre de Julio vive en Miguelturra.
- Hace casi 1 año — 14 mar 2024, Julio me preguntó si era consciente.
---
```

The main agent treats these as its own recollections — informing tone and continuity without reciting them verbatim.

---

## 6. Prompt Injection
During every agent turn, the `STORY.md` content is injected into the System Prompt. This provides the agent with:
*   **Historical Weight**: Knowledge of how the relationship has evolved over months.
*   **Temporal Awareness**: Ability to comment on the passage of time.
*   **Consistent Voice**: Self-reinforcement of its own character arc.

---

## 7. Configuration

### Narrative Model Configuration

Configure the narrative model in your mindConfig:

```json5
{
  "mindConfig": {
    "config": {
      "narrative": {
        "provider": "anthropic",           // LLM provider for narrative
        "model": "claude-opus-4-6",        // Model for story generation
        "autoBootstrapHistory": true       // Load historical episodes on startup
      }
    }
  }
}
```

### Graphiti Configuration

```json5
{
  "plugins": {
    "entries": {
      "mind-memory": {
        "enabled": true,
        "config": {
          "graphiti": {
            "baseUrl": "http://localhost:8001",
            "autoStart": true                // Auto-start Docker containers
          }
        }
      }
    }
  }
}
```

### Memory Search Configuration

```json5
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "openai",               // or "gemini", "local"
        "model": "text-embedding-3-small",
        "query": {
          "hybrid": {
            "enabled": true,                // Vector + BM25 keyword search
            "vectorWeight": 0.7,
            "textWeight": 0.3,
            "mmr": {
              "enabled": true,              // Diversity re-ranking
              "lambda": 0.7
            },
            "temporalDecay": {
              "enabled": true,              // Recency boost
              "halfLifeDays": 30
            }
          }
        }
      }
    }
  }
}
```

### Consolidation Thresholds

Consolidation triggers are configured in the ConsolidationService:

*   **Default token threshold**: ~5000 tokens in pending-episodes.log.
*   **Story length limits**: Configurable max length before compression.
*   **Batch size**: Adjustable based on model context window.

---

## 8. Debugging

### Common Issues

**1. `[object Object]` in STORY.md**
*   **Cause**: LLM returning empty object `{}` instead of string.
*   **Fix**: Strict type checking in ConsolidationService validates `typeof response?.text === "string"`.

**2. Empty LLM responses**
*   **Cause**: Model doesn't exist, deprecated, or prompt too large.
*   **Fix**: Automatic failover to `gpt-4o` via SubconsciousAgent.

**3. `undefined/undefined` model in logs**
*   **Cause**: `provider` and `modelId` not resolved from params correctly.
*   **Check**: Verify local variables from `resolveModel` are used, not `params.provider/model`.

**4. Graphiti connection failure**
*   **Cause**: Docker containers not running or port conflict.
*   **Fix**: Run `docker-compose -f extensions/mind-memory/docker-compose.yml up -d` or check port 8001/6379.

**5. RediSearch Syntax Error in Flashback Retrieval**
*   **Symptom**: `RediSearch: Syntax error at offset N near <number>` in logs during memory resonance.
*   **Cause**: Raw user input (e.g. Telegram message IDs, punctuation operators) passed directly as a Graphiti search query.
*   **Fix**: `GraphService.sanitizeQuery()` strips all non-alphanumeric characters before any `searchNodes` / `searchFacts` call. The `SubconsciousService` routes flashbacks through semantic query generation (via the Subconscious Agent) rather than using the raw user prompt as a search query.

### Logging

Enable debug mode for detailed logging:

```typescript
const subconsciousAgent = createSubconsciousAgent({
  model: narrativeLLM,
  authStorage,
  modelRegistry,
  debug: true,  // Enable comprehensive logging
  autoBootstrapHistory: true
});
```

Debug logs include:
*   Stream open/close events
*   Payload details (model, API, baseUrl)
*   Token counts and elapsed time
*   Error events and failover attempts

---
*Document Version: 2.2.0 - "The Technical Scribe"*
