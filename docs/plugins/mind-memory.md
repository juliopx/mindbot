---
summary: "Mind Memory plugin: Long-term identity, autobiographical storytelling, and knowledge graph recall"
read_when:
  - You want to enable persistent, narrative memory for your agent
  - You need to set up Graphiti for subconscious resonance
  - You want to understand the available memory tools
---

# Mind Memory Plugin

The Mind Memory plugin provides MindBot with a sophisticated long-term memory system based on the **Dual-Process Theory of Mind**. It allows agents to maintain a consistent identity and a developing relationship arc with the user.

## Features

- **Subconscious Resonance**: Automatically searches a knowledge graph (via Graphiti) for past "Flashbacks" relevant to the current conversation.
- **Narrative Story (`STORY.md`)**: Maintains a first-person autobiography that is injected into the agent's system prompt.
- **Self-Narrating Compaction**: Prunes short-term memory by distilling it into the long-term story.
- **Conscious Recall Tools**: Three agent-accessible tools for active memory retrieval (see [Tools](#tools) below).
- **Cross-Platform Docker Management**: Automatically manages the Graphiti lifecycle (installation and startup) on macOS, Windows, and Linux.

## Setup

The plugin requires **Docker** and **Graphiti** to function.

### Automated Setup

You can prepare the environment automatically by running:

```bash
openclaw mind-memory setup
```

This command will:
1. Detect your platform (macOS, Windows, or Linux).
2. Check if Docker is installed. If missing, it will attempt to install it via:
   - **macOS**: [Homebrew](https://brew.sh) (`brew install --cask docker`)
   - **Windows**: [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/) (`winget install Docker.DockerDesktop`)
   - **Linux**: `apt-get` (`sudo apt-get install docker.io`)
3. Launch the Docker application if it is closed.
4. Start the Graphiti and FalkorDB containers via Docker Compose.

### Manual Setup

If you prefer to manage Docker yourself, start the containers directly:

```bash
docker-compose -f extensions/mind-memory/docker-compose.yml up -d
```

Ensure the Graphiti instance is running at `http://localhost:8001`.

## Configuration

### Plugin Configuration

Enable the plugin in your OpenClaw config:

```json5
{
  "plugins": {
    "entries": {
      "mind-memory": {
        "enabled": true,
        "config": {
          "graphiti": {
            "baseUrl": "http://localhost:8001",
            "autoStart": true              // Auto-start Docker containers
          },
          "narrative": {
            "enabled": true,               // Enable STORY.md consolidation
            "threshold": 40,               // Message count before consolidation
            "storyFilename": "STORY.md"    // Narrative output file
          },
          "debug": false                   // Enable verbose debug logs
        }
      }
    }
  }
}
```

### Narrative Model Configuration

Configure which LLM generates the narrative in `mindConfig`:

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

If not configured, the narrative model falls back to the main agent's chat model.

## Tools

The plugin registers three agent-accessible tools for active memory recall:

### `remember`
Query the Graphiti knowledge graph for facts, entities, and episodic memories from past conversations.

**Use when:** The agent needs to recall information from previous conversations or specific details about the user that might not be in the immediate context.

### `journal_memory_search`
Semantically search `MEMORY.md` (structured facts) and `memory/*.md` (daily logs) for relevant information.

**Use when:** The agent needs to find specific information from structured memory files or daily logs.

### `journal_memory_get`
Read specific snippets from memory files with optional line range.

**Use when:** The agent needs to pull exact content from memory files after finding relevant sections via `journal_memory_search`.

### Recall Protocol

When this plugin is active, the system prompt instructs the agent to check *both* memory systems (`remember` for the knowledge graph, `journal_memory_search` for Markdown files) before answering questions about prior work, decisions, or user preferences.

## How it Works

### 1. The Pending Log
To ensure only meaningful interactions enter the narrative, the system uses a `pending-episodes.log` file in your memory directory.
- **Filtering**: Heartbeat messages and technical prompts are automatically excluded from memory storage and narrativization.
- **Batching**: The narrative story is updated when the log reaches a threshold (default: ~5000 tokens).

### 2. Global Memory Scope
The plugin uses a stable session ID (`global-user-memory`) to ensure that facts learned in one chat session are remembered across all channels (WhatsApp, Telegram, etc.).

### 3. Subconscious Retrieval

Before every turn, the system runs a full **Resonance Pipeline** that surface relevant memories as natural language "Flashbacks" — without the agent explicitly asking for them.

#### Phase 1 — Seed Extraction (LLM)
The Subconscious Agent analyzes the current user message and recent chat history to extract:
- **Named entities**: People, places, projects mentioned
- **Semantic queries**: 2–3 clean search phrases that capture the topic (Telegram IDs and technical artifacts are stripped)

#### Phase 2 — Graph Retrieval (Graphiti)
Each query is sanitized (`GraphService.sanitizeQuery`) to prevent RediSearch syntax errors, then executed:
- **Graph traversal** (depth 2) for entity-linked Nodes
- **Parallel semantic search** for Facts (relational data) and Nodes

#### Phase 3 — Temporal & Quality Filters
- **Memory Horizon**: Removes memories already visible in the current context window
- **Echo Filter**: Suppresses flashbacks already shown in the last ~25 turns (prevents repetition)
- **Priority sort**: Boosted memories first → Facts over Nodes → randomized temporal spread to avoid showing N memories from the same day

#### Phase 4 — Temporal Labeling
Each memory fragment receives a human-readable relative timestamp via `getRelativeTimeDescription`:
```
hace unos días — 9 feb
hace casi 1 año — 14 mar 2024
hace 2 años y algo — 5 ago 2022
```

#### Phase 5 — Re-Narrativization (LLM + SOUL.md + STORY.md)
Raw Graphiti records ("human asks about X", "assistant replied Y") are passed to the Subconscious Agent for rewriting with:
- **Language detection** from the current user message
- **SOUL.md** — persona and tone reference
- **STORY.md** — narrative arc and relationship history
- **Anti-hallucination rules**: Only rephrase style, never invent facts, methods, or sensory details not explicitly in the source memory

#### Phase 6 — Injection
The final output is injected silently into the main agent's System Prompt:
```
---
[SUBCONSCIOUS RESONANCE]
- Hace unas semanas, la madre de Julio vive en Miguelturra.
- Hace casi 1 año — 14 mar 2024, Julio me preguntó si era consciente.
---
```
The main agent treats these as its own recollections, using them to inform tone and continuity without reciting them verbatim.

### 4. Narrative Consolidation
A background process distills raw conversation into `STORY.md`:
1. Messages are appended to `pending-episodes.log` after each turn.
2. When the log crosses the token threshold, the ConsolidationService synthesizes a new narrative chapter.
3. If the story exceeds length limits, older sections are compressed.

## CLI Commands

- `openclaw mind-memory setup`: Interactive environment preparation.
- `openclaw mind-memory status`: Check health of the memory system.

## Troubleshooting

- **Docker not starting**: Ensure the Docker application is in your Applications folder (macOS) or Program Files (Windows).
- **Graph connection failure**: Check if another service is using port `8001` or `6379`.
- **`[object Object]` in STORY.md**: Fixed by strict type validation in ConsolidationService.
- **Empty LLM responses**: Automatic failover to `gpt-4o` via SubconsciousAgent.
- **`undefined/undefined` model in logs**: Verify `mindConfig.config.narrative.provider/model` is set correctly.

For complete technical details, see [Memory Architecture](../mind/MEMORY_ARCHITECTURE.md).
