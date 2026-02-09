import { SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "./types.js";
import { type OpenClawConfig } from "../../config/types.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import {
  resolveSessionAgentId,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
} from "../agent-scope.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileGood,
  markAuthProfileUsed,
} from "../auth-profiles.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  ensureAuthProfileStore,
  getApiKeyForModel,
  resolveAuthProfileOrder,
  type ResolvedProviderAuth,
} from "../model-auth.js";
import { normalizeProviderId } from "../model-selection.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import {
  classifyFailoverReason,
  formatAssistantErrorText,
  isCompactionFailureError,
  isContextOverflowError,
  isTimeoutErrorMessage,
  parseImageSizeError,
  pickFallbackThinkingLevel,
  type FailoverReason,
} from "../pi-embedded-helpers.js";
import { normalizeUsage, type UsageLike } from "../usage.js";
import {
  loadWorkspaceBootstrapFiles,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
} from "../workspace.js";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { limitHistoryTurns, getDmHistoryLimitFromSessionKey } from "./history.js";
import { log } from "./logger.js";
import { resolveModel } from "./model.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import { describeUnknownError } from "./utils.js";

type ApiKeyInfo = ResolvedProviderAuth;

// Avoid Anthropic's refusal test token poisoning session transcripts.

export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
  const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.config,
  });
  const resolvedWorkspace = params.workspaceDir
    ? resolveUserPath(params.workspaceDir)
    : resolveAgentWorkspaceDir(params.config ?? {}, agentId);
  const fallbackConfigured = (params.config?.agents?.defaults?.model?.fallbacks?.length ?? 0) > 0;
  await ensureOpenClawModelsJson(params.config, agentDir);

  const { model, error, authStorage, modelRegistry } = resolveModel(
    provider,
    modelId,
    agentDir,
    params.config,
  );
  if (!model) {
    return {
      meta: {
        durationMs: 0,
        error: {
          kind: "unknown",
          message: error ?? `Unknown model: ${provider}/${modelId}`,
        } as any,
      },
    };
  }

  const ctxInfo = resolveContextWindowInfo({
    cfg: params.config as OpenClawConfig,
    provider,
    modelId,
    modelContextWindow: model.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  const ctxGuard = evaluateContextWindowGuard({
    info: ctxInfo,
    warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
    hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
  });
  if (ctxGuard.shouldWarn) {
    log.warn(
      `low context window: ${provider}/${modelId} ctx=${ctxGuard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
    );
  }
  if (ctxGuard.shouldBlock) {
    log.error(
      `blocked model (context window too small): ${provider}/${modelId} ctx=${ctxGuard.tokens} (min=${CONTEXT_WINDOW_HARD_MIN_TOKENS}) source=${ctxGuard.source}`,
    );
    throw new FailoverError(
      `Model context window too small (${ctxGuard.tokens} tokens). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
      { reason: "unknown", provider, model: modelId },
    );
  }

  const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const preferredProfileId = params.authProfileId?.trim();
  let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;
  if (lockedProfileId) {
    const lockedProfile = authStore.profiles[lockedProfileId];
    if (
      !lockedProfile ||
      normalizeProviderId(lockedProfile.provider) !== normalizeProviderId(provider)
    ) {
      lockedProfileId = undefined;
    }
  }
  const profileOrder = resolveAuthProfileOrder({
    cfg: params.config as OpenClawConfig,
    store: authStore,
    provider,
    preferredProfile: preferredProfileId,
  });
  if (lockedProfileId && !profileOrder.includes(lockedProfileId)) {
    throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
  }
  const profileCandidates = lockedProfileId
    ? [lockedProfileId]
    : profileOrder.length > 0
      ? profileOrder
      : [undefined];
  let profileIndex = 0;

  const initialThinkLevel = params.thinkLevel ?? "off";
  let thinkLevel = initialThinkLevel;
  const attemptedThinking = new Set<ThinkLevel>();
  let apiKeyInfo: ApiKeyInfo | null = null;
  let lastProfileId: string | undefined;

  const resolveAuthProfileFailoverReason = (params: {
    allInCooldown: boolean;
    message: string;
  }): FailoverReason => {
    if (params.allInCooldown) {
      return "rate_limit";
    }
    const classified = classifyFailoverReason(params.message);
    return classified ?? "auth";
  };

  const throwAuthProfileFailover = (params: {
    allInCooldown: boolean;
    message?: string;
    error?: unknown;
  }): never => {
    const fallbackMessage = `No available auth profile for ${provider} (all in cooldown or unavailable).`;
    const message =
      params.message?.trim() ||
      (params.error ? describeUnknownError(params.error).trim() : "") ||
      fallbackMessage;
    const reason = resolveAuthProfileFailoverReason({
      allInCooldown: params.allInCooldown,
      message,
    });
    if (fallbackConfigured) {
      throw new FailoverError(message, {
        reason,
        provider,
        model: modelId,
        status: resolveFailoverStatus(reason),
        cause: params.error,
      });
    }
    if (params.error instanceof Error) {
      throw params.error;
    }
    throw new Error(message);
  };

  const resolveApiKeyForCandidate = async (candidate?: string) => {
    return getApiKeyForModel({
      model,
      cfg: params.config as OpenClawConfig,
      profileId: candidate,
      agentDir,
    });
  };

  const applyApiKeyInfo = async (candidate?: string) => {
    lastProfileId = candidate;
    apiKeyInfo = await resolveApiKeyForCandidate(candidate);
    if (!apiKeyInfo.apiKey && apiKeyInfo.mode !== "aws-sdk") {
      throw new Error(
        `No API key resolved for provider "${model.provider}" (auth mode: ${apiKeyInfo.mode}).`,
      );
    }

    let runtimeApiKey = apiKeyInfo.apiKey;
    if (model.provider === "github-copilot" && apiKeyInfo.apiKey) {
      const { resolveCopilotApiToken } = await import("../../providers/github-copilot-token.js");
      const copilotToken = await resolveCopilotApiToken({
        githubToken: apiKeyInfo.apiKey,
      });
      runtimeApiKey = copilotToken.token;
      authStorage.setRuntimeApiKey(model.provider, runtimeApiKey);
    } else if (apiKeyInfo.apiKey) {
      authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
    }
    return runtimeApiKey;
  };

  const advanceAuthProfile = async (): Promise<boolean> => {
    if (lockedProfileId) {
      return false;
    }
    let nextIndex = profileIndex + 1;
    while (nextIndex < profileCandidates.length) {
      const candidate = profileCandidates[nextIndex];
      if (candidate && isProfileInCooldown(authStore, candidate)) {
        nextIndex += 1;
        continue;
      }
      try {
        await applyApiKeyInfo(candidate);
        profileIndex = nextIndex;
        thinkLevel = initialThinkLevel;
        attemptedThinking.clear();
        return true;
      } catch (err) {
        if (candidate && candidate === lockedProfileId) {
          throw err;
        }
        nextIndex += 1;
      }
    }
    return false;
  };

  try {
    await applyApiKeyInfo(profileCandidates[profileIndex]);
    if (profileIndex >= profileCandidates.length) {
      throwAuthProfileFailover({ allInCooldown: true });
    }
  } catch (err) {
    if (err instanceof FailoverError) {
      throw err;
    }
    if (profileCandidates[profileIndex] === lockedProfileId) {
      throwAuthProfileFailover({ allInCooldown: false, error: err });
    }
    const advanced = await advanceAuthProfile();
    if (!advanced) {
      throwAuthProfileFailover({ allInCooldown: false, error: err });
    }
  }

  const mindConfig = params.config?.plugins?.entries?.["mind-memory"] as any;
  const debug = !!mindConfig?.config?.debug;

  // Create a lightweight LLM client for the subconscious (reusable for consolidation)
  const { createSubconsciousAgent } = await import("./subconscious-agent.js");
  const subconsciousAgent = createSubconsciousAgent({
    model,
    authStorage,
    modelRegistry,
    debug,
    autoBootstrapHistory: mindConfig?.config?.narrative?.autoBootstrapHistory ?? false,
  });

  const agentConfig = resolveAgentConfig(params.config ?? {}, agentId);

  // Resolve identity context for narrative updates
  let identityContext = "";
  try {
    const bootstrapFiles = await loadWorkspaceBootstrapFiles(resolvedWorkspace);
    const identityFile = bootstrapFiles.find((f) => f.name === DEFAULT_IDENTITY_FILENAME);
    const soulFile = bootstrapFiles.find((f) => f.name === DEFAULT_SOUL_FILENAME);

    const identityParts: string[] = [];
    if (identityFile && !identityFile.missing && identityFile.content) {
      identityParts.push(`IDENTITY:\n${identityFile.content}`);
    }
    if (soulFile && !soulFile.missing && soulFile.content) {
      identityParts.push(`SOUL:\n${soulFile.content}`);
    }
    if (agentConfig?.identity) {
      identityParts.push(`CONFIG IDENTITY: ${JSON.stringify(agentConfig.identity)}`);
    }

    identityContext = identityParts.join("\n\n").trim();
  } catch (e: any) {
    if (debug) {
      process.stderr.write(`  ⚠️ [DEBUG] Failed to load identity context: ${e.message}\n`);
    }
  }

  let finalExtraSystemPrompt = params.extraSystemPrompt ?? "";
  let narrativeStory: { content: string; updatedAt: Date } | null = null;
  const storyPath = path.join(resolvedWorkspace, "STORY.md");
  const isMindEnabled = mindConfig?.enabled && (mindConfig?.config?.narrative?.enabled ?? true);
  const safeTokenLimit = Math.floor((ctxInfo.tokens || 50000) * 0.5);

  // HEARTBEAT DETECTION (Incoming)
  const isHeartbeatPrompt =
    params.prompt.includes("Read HEARTBEAT.md") && params.prompt.includes("reply HEARTBEAT_OK");

  try {
    if (isMindEnabled) {
      // [MIND] Disable Mind for sub-agents (no observer, no storage)
      if (isSubagentSessionKey(params.sessionKey)) {
        if (debug) {
          process.stderr.write(`🧠 [MIND] Sub-agent detected - skipping Mind pipeline.\n`);
        }
      } else {
        if (debug) {
          process.stderr.write(
            `🧠 [MIND] Starting modular subconscious pipeline (Model: ${modelId})...\n`,
          );
        }

        const { GraphService } = await import("../../services/memory/GraphService.js");
        const { SubconsciousService } =
          await import("../../services/memory/SubconsciousService.js");
        const { ConsolidationService } =
          await import("../../services/memory/ConsolidationService.js");

        const gUrl = mindConfig?.config?.graphiti?.baseUrl || "http://localhost:8001";
        const gs = new GraphService(gUrl, debug);
        const sub = new SubconsciousService(gs, debug);
        const cons = new ConsolidationService(gs, debug);
        const globalSessionId = "global-user-memory";

        if (!isHeartbeatPrompt) {
          // 1. Storage & Consolidation (Only for real messages)
          const memoryDir = path.join(path.dirname(storyPath), "memory");
          const sessionMgr = SessionManager.open(params.sessionFile);
          const sessionMessages = sessionMgr.buildSessionContext().messages || [];

          // Bootstrap historical episodes
          await cons.bootstrapHistoricalEpisodes(params.sessionId, memoryDir, sessionMessages);

          // FETCH NARRATIVE STORY EARLY (before sync, for immediate LLM context)
          try {
            const earlyStory = await fs.readFile(storyPath, "utf-8").catch(() => null);
            if (earlyStory) {
              narrativeStory = { content: earlyStory, updatedAt: new Date() };
              if (debug) {
                process.stderr.write(
                  `📖 [MIND] Pre-sync Story retrieved (${earlyStory.length} chars)\n`,
                );
              }
            }
          } catch {}

          // GLOBAL NARRATIVE SYNC — only narrates old sessions outside current context
          {
            const { resolveSessionTranscriptsDir } = await import("../../config/sessions/paths.js");
            const sessionsDir = resolveSessionTranscriptsDir();
            await cons.syncGlobalNarrative(
              sessionsDir,
              storyPath,
              subconsciousAgent,
              identityContext,
              safeTokenLimit,
              params.sessionFile, // exclude current session (already in LLM context)
            );
          }

          // Persist User Message to Graphiti (Semantic Search)
          if (debug) {
            process.stderr.write(
              `Tape [GRAPH] Storing episode for Global ID: ${globalSessionId} (Trace: ${params.sessionId})\n`,
            );
          }
          await gs.addEpisode(globalSessionId, `human: ${params.prompt}`);

          // NOTE: We no longer track pending episodes per turn or consolidate constantly.
          // Narrative updates now happen via Global Sync (startup) or Compaction Sync.
        } else {
          if (debug) {
            process.stderr.write(
              `💓 [MIND] Heartbeat detected - skipping memory storage & consolidation.\n`,
            );
          }
        }

        // 2. Fetch Narrative Story (reload after sync in case it was updated, or use pre-sync version)
        try {
          const storyContent = await fs.readFile(storyPath, "utf-8").catch(() => null);
          if (storyContent) {
            narrativeStory = { content: storyContent, updatedAt: new Date() };
            if (debug) {
              process.stderr.write(
                `📖 [MIND] Local Story retrieved (${storyContent.length} chars)\n`,
              );
            }
          }
        } catch (e: any) {
          if (debug) {
            process.stderr.write(`⚠️ [MIND] Failed to read local story: ${e.message}\n`);
          }
        }

        // 3. Get Flashbacks (Only for real messages, skip if MIND_SKIP_RESONANCE is set)
        const skipResonance = process.env.MIND_SKIP_RESONANCE === "1";
        if (!isHeartbeatPrompt && !skipResonance) {
          let oldestContextTimestamp: Date | undefined;
          let rawHistory: any[] = [];
          try {
            const tempSessionManager = SessionManager.open(params.sessionFile);
            const branch = tempSessionManager.getBranch();

            rawHistory = branch
              .filter((e) => e.type === "message")
              .filter((e) => (e.message as any)?.role !== "system") // [MIND] Exclude system messages (compaction/summaries)
              .map((e: any) => ({
                role: e.message?.role,
                text: e.message?.text || e.message?.content,
                timestamp: e.timestamp,
              }));

            const contextMessages = tempSessionManager.buildSessionContext().messages || [];
            if (contextMessages.length > 0) {
              const limit = getDmHistoryLimitFromSessionKey(
                params.sessionKey,
                params.config as OpenClawConfig,
              );
              const limited = limitHistoryTurns(contextMessages, limit);
              if (limited.length > 0 && (limited[0] as any).timestamp) {
                oldestContextTimestamp = new Date((limited[0] as any).timestamp);
              }
            }
          } catch {}

          const flashbacks = await sub.getFlashback(
            globalSessionId, // STRICTLY use global-user-memory
            params.prompt,
            subconsciousAgent,
            oldestContextTimestamp,
            rawHistory,
          );

          if (flashbacks) {
            if (debug) {
              process.stderr.write("✨ [MIND] Memories injected into system prompt.\n");
            }
            finalExtraSystemPrompt += flashbacks;
          }
        } else {
          if (debug) {
            const reason = skipResonance
              ? "MIND_SKIP_RESONANCE=1 (voice mode)"
              : "Heartbeat detected";
            process.stderr.write(`⏭️ [MIND] ${reason} - skipping resonance retrieval.\n`);
          }
        }
      }
    }
  } catch (e: any) {
    process.stderr.write(`❌ [MIND] Subconscious error: ${e.message}\n`);
  }

  // Wrap onAgentEvent to hook into auto-compaction for STORY.md sync.
  // After compaction, messages that were removed from context (summarized away)
  // need to be narrated to STORY.md before they're lost. Messages still in
  // context are NOT narrated (they're already available to the LLM).
  const wrappedOnAgentEvent =
    isMindEnabled && !isSubagentSessionKey(params.sessionKey) && !isHeartbeatPrompt
      ? (evt: { stream: string; data: Record<string, unknown> }) => {
          if (
            evt.stream === "compaction" &&
            (evt.data as any)?.phase === "end" &&
            !(evt.data as any)?.willRetry
          ) {
            // Fire-and-forget: narrate compacted-away messages to STORY.md
            void (async () => {
              try {
                const sm = SessionManager.open(params.sessionFile);

                // Full history from the .jsonl (all entries, including compacted ones)
                const allMessages = sm
                  .getBranch()
                  .filter((e) => e.type === "message")
                  .filter((e) => (e.message as any)?.role !== "system")
                  .map((e: any) => ({
                    role: e.message?.role,
                    text: e.message?.text || e.message?.content,
                    timestamp: e.timestamp,
                  }));

                // Messages currently in LLM context (post-compaction)
                const contextMessages = sm.buildSessionContext().messages || [];
                const contextTimestamps = new Set(contextMessages.map((m: any) => m.timestamp));

                // Messages that got compacted away = in full history but NOT in current context
                const compactedMessages = allMessages.filter(
                  (m) => m.timestamp && !contextTimestamps.has(m.timestamp),
                );

                if (compactedMessages.length === 0) {
                  if (debug) {
                    process.stderr.write(
                      `🧠 [MIND] Auto-compaction detected — no new compacted messages to narrate.\n`,
                    );
                  }
                  return;
                }

                if (debug) {
                  process.stderr.write(
                    `🧠 [MIND] Auto-compaction detected — narrating ${compactedMessages.length} compacted messages to STORY.md...\n`,
                  );
                }

                const { ConsolidationService } =
                  await import("../../services/memory/ConsolidationService.js");
                const { GraphService } = await import("../../services/memory/GraphService.js");
                const gUrl = mindConfig?.config?.graphiti?.baseUrl || "http://localhost:8001";
                const gs = new GraphService(gUrl, debug);
                const cons = new ConsolidationService(gs, debug);

                await cons.syncStoryWithSession(
                  compactedMessages,
                  storyPath,
                  subconsciousAgent,
                  identityContext,
                  safeTokenLimit,
                );

                if (debug) {
                  process.stderr.write(`✅ [MIND] Post-compaction STORY.md sync complete.\n`);
                }
              } catch (e: any) {
                process.stderr.write(`❌ [MIND] Post-compaction story sync failed: ${e.message}\n`);
              }
            })();
          }
          // Always forward the event to the original handler
          params.onAgentEvent?.(evt);
        }
      : params.onAgentEvent;

  const started = Date.now();
  let aborted = false;
  let timedOut = false;
  let didCompactOnOverflow = false;

  while (!aborted && !timedOut) {
    process.stderr.write("🤖 [MIND] Calling LLM...\n");
    const attempt = await runEmbeddedAttempt({
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider,
      modelId,
      model,
      authStorage,
      modelRegistry,
      sessionFile: params.sessionFile,
      workspaceDir: resolvedWorkspace,
      agentDir,
      config: params.config as OpenClawConfig,
      prompt: params.prompt,
      images: params.images,
      extraSystemPrompt: finalExtraSystemPrompt,
      narrativeStory: narrativeStory?.content || "",
      thinkLevel,
      verboseLevel: params.verboseLevel,
      reasoningLevel: params.reasoningLevel,
      toolResultFormat: resolvedToolResultFormat,
      timeoutMs: params.timeoutMs,
      abortSignal: params.abortSignal,
      onPartialReply: (payload) => {
        if (payload.text) {
          process.stderr.write("✍️");
        }
        void params.onPartialReply?.(payload);
      },
      onAssistantMessageStart: params.onAssistantMessageStart,
      onBlockReply: params.onBlockReply,
      onBlockReplyFlush: params.onBlockReplyFlush,
      blockReplyBreak: params.blockReplyBreak,
      blockReplyChunking: params.blockReplyChunking,
      onReasoningStream: params.onReasoningStream,
      onToolResult: params.onToolResult,
      onAgentEvent: wrappedOnAgentEvent,
      streamParams: params.streamParams,
      ownerNumbers: params.ownerNumbers,
      enforceFinalTag: params.enforceFinalTag,
    }).catch((err) => {
      if (err.name === "AbortError") {
        aborted = true;
      } else if (err.name === "TimeoutError" || isTimeoutErrorMessage(err.message)) {
        timedOut = true;
      } else {
        throw err;
      }
      return undefined;
    });

    if (aborted || timedOut || !attempt) {
      break;
    }

    // Handle promptError (overflow/compaction failure caught before session starts)
    if (attempt.promptError) {
      const promptErrMsg =
        attempt.promptError instanceof Error
          ? attempt.promptError.message
          : JSON.stringify(attempt.promptError);

      if (isCompactionFailureError(promptErrMsg)) {
        log.error(`compaction failure in prompt: ${promptErrMsg}`);
        return {
          payloads: [{ text: `Session compaction failed: ${promptErrMsg}`, isError: true }],
          meta: {
            durationMs: Date.now() - started,
            agentMeta: { sessionId: params.sessionId, provider, model: model.id },
            error: { kind: "compaction_failure", message: promptErrMsg },
          },
        } as any;
      }

      if (isContextOverflowError(promptErrMsg)) {
        if (didCompactOnOverflow) {
          log.warn("context overflow persists after compaction; giving up");
          return {
            payloads: [
              {
                text: "Session context is too large even after compaction. Please start a new session with /new.",
                isError: true,
              },
            ],
            meta: {
              durationMs: Date.now() - started,
              agentMeta: { sessionId: params.sessionId, provider, model: model.id },
              error: { kind: "context_overflow", message: promptErrMsg },
            },
          } as any;
        }

        log.warn("context overflow detected; attempting auto-compaction...");
        const compactResult = await compactEmbeddedPiSessionDirect({
          sessionFile: params.sessionFile,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          config: params.config as OpenClawConfig,
          agentDir,
          authProfileId:
            (apiKeyInfo as ApiKeyInfo | null)?.profileId ?? lastProfileId ?? params.authProfileId,
          model: modelId,
          provider,
          workspaceDir: resolvedWorkspace,
        });
        didCompactOnOverflow = true;

        if (!compactResult?.ok || !compactResult?.compacted) {
          log.warn(`auto-compaction failed: ${(compactResult as any)?.reason ?? "unknown reason"}`);
          return {
            payloads: [
              {
                text: "Session context is too large and compaction failed. Please start a new session with /new.",
                isError: true,
              },
            ],
            meta: {
              durationMs: Date.now() - started,
              agentMeta: { sessionId: params.sessionId, provider, model: model.id },
              error: { kind: "context_overflow", message: promptErrMsg },
            },
          } as any;
        }

        log.info(
          `auto-compaction succeeded (tokens before: ${(compactResult as any)?.result?.tokensBefore ?? "?"})`,
        );
        continue;
      }
    }

    const lastAssistant = attempt.lastAssistant as any;
    const errorText = lastAssistant?.errorMessage || "";

    if (lastAssistant?.isError) {
      log.warn(`attempt error: ${errorText}`);

      if (isCompactionFailureError(errorText)) {
        log.error(`compaction failed in attempt: ${errorText}`);
        throw new Error(`Session compaction failed: ${errorText}`);
      }

      if (isContextOverflowError(errorText)) {
        log.warn("context overflow detected; triggering compaction...");
        await compactEmbeddedPiSessionDirect({
          sessionFile: params.sessionFile,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          config: params.config as OpenClawConfig,
          agentDir,
          authProfileId: params.authProfileId,
          model: modelId,
          provider,
          workspaceDir: resolvedWorkspace,
        });
        continue;
      }

      // Handle role ordering errors with a user-friendly message
      if (/incorrect role information|roles must alternate/i.test(errorText)) {
        return {
          payloads: [
            {
              text:
                "Message ordering conflict - please try again. " +
                "If this persists, use /new to start a fresh session.",
              isError: true,
            },
          ],
          meta: {
            durationMs: Date.now() - started,
            agentMeta: {
              sessionId: params.sessionId,
              provider,
              model: model.id,
            },
            systemPromptReport: attempt.systemPromptReport,
            error: { kind: "role_ordering", message: errorText },
          },
        };
      }

      // Handle image size errors
      const imageSizeError = parseImageSizeError(errorText);
      if (imageSizeError) {
        const maxMb = imageSizeError.maxMb;
        const maxMbLabel = typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
        const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
        return {
          payloads: [
            {
              text:
                `Image too large for the model${maxBytesHint}. ` +
                "Please compress or resize the image and try again.",
              isError: true,
            },
          ],
          meta: {
            durationMs: Date.now() - started,
            agentMeta: {
              sessionId: params.sessionId,
              provider,
              model: model.id,
            },
            systemPromptReport: attempt.systemPromptReport,
            error: { kind: "image_size", message: errorText },
          },
        };
      }

      const fallbackThinking = pickFallbackThinkingLevel({
        message: lastAssistant?.errorMessage,
        attempted: attemptedThinking,
      });
      if (fallbackThinking && !aborted) {
        log.warn(
          `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
        );
        thinkLevel = fallbackThinking;
        continue;
      }

      const assistantFailoverReason = classifyFailoverReason(errorText);
      const shouldRotate = assistantFailoverReason && assistantFailoverReason !== "timeout";

      if (shouldRotate && lastProfileId) {
        await markAuthProfileFailure({
          store: authStore,
          profileId: lastProfileId,
          reason: assistantFailoverReason,
          cfg: params.config as OpenClawConfig,
          agentDir,
        });
        const rotated = await advanceAuthProfile();
        if (rotated) {
          continue;
        }
      }

      if (fallbackConfigured) {
        const message =
          formatAssistantErrorText(lastAssistant, {
            cfg: params.config as OpenClawConfig,
            sessionKey: params.sessionKey ?? params.sessionId,
          }) || errorText;
        const status = resolveFailoverStatus(assistantFailoverReason ?? "unknown");
        throw new FailoverError(message, {
          reason: assistantFailoverReason ?? "unknown",
          provider,
          model: modelId,
          profileId: lastProfileId,
          status,
        });
      }
    }

    process.stderr.write("\n✅ [MIND] Response finished.\n");

    // MIND INTEGRATION v1.0: Persist Assistant Message & Consolidate
    try {
      if (isMindEnabled && !isSubagentSessionKey(params.sessionKey)) {
        const assistantText = attempt.assistantTexts.join("\n").trim();
        const isHeartbeatResponse = assistantText === "HEARTBEAT_OK";

        if (!isHeartbeatPrompt && !isHeartbeatResponse) {
          if (assistantText) {
            const { GraphService } = await import("../../services/memory/GraphService.js");

            const gUrl = mindConfig?.config?.graphiti?.baseUrl || "http://localhost:8001";
            const gs = new GraphService(gUrl, debug);
            await gs.addEpisode("global-user-memory", `assistant: ${assistantText}`);
            // await cons.trackPendingEpisode(...) -> Disabled in favor of Compaction Sync
          }
        } else if (isHeartbeatResponse) {
          if (debug) {
            process.stderr.write(
              `💓 [MIND] Heartbeat response detected - skipping memory storage.\n`,
            );
          }
        }
      }
    } catch (e: any) {
      process.stderr.write(`❌ [MIND] Consolidation / Persistence error: ${e.message}\n`);
    }

    const usage = normalizeUsage(lastAssistant?.usage as UsageLike);
    const agentMeta: EmbeddedPiAgentMeta = {
      sessionId: params.sessionId,
      provider: lastAssistant?.provider ?? provider,
      model: lastAssistant?.model ?? model.id,
      usage,
    };

    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: attempt.assistantTexts,
      toolMetas: attempt.toolMetas,
      lastAssistant: attempt.lastAssistant,
      lastToolError: attempt.lastToolError,
      config: params.config as OpenClawConfig,
      sessionKey: params.sessionKey ?? params.sessionId,
      verboseLevel: params.verboseLevel,
      reasoningLevel: params.reasoningLevel,
      toolResultFormat: resolvedToolResultFormat,
      inlineToolResultsAllowed: false,
    });

    if (lastProfileId) {
      await markAuthProfileGood({
        store: authStore,
        provider,
        profileId: lastProfileId,
        agentDir,
      });
      await markAuthProfileUsed({
        store: authStore,
        profileId: lastProfileId,
        agentDir,
      });
    }

    return {
      payloads: payloads.length ? payloads : undefined,
      meta: {
        durationMs: Date.now() - started,
        agentMeta,
        aborted,
        systemPromptReport: attempt.systemPromptReport,
        stopReason: attempt.clientToolCall ? "tool_calls" : undefined,
        pendingToolCalls: attempt.clientToolCall
          ? [
              {
                id: `call_${Date.now()}`,
                name: attempt.clientToolCall.name,
                arguments: JSON.stringify(attempt.clientToolCall.params),
              },
            ]
          : undefined,
      },
      didSendViaMessagingTool: attempt.didSendViaMessagingTool,
      messagingToolSentTexts: attempt.messagingToolSentTexts,
      messagingToolSentTargets: attempt.messagingToolSentTargets,
    };
  }

  return {
    meta: {
      durationMs: Date.now() - started,
      agentMeta: {
        sessionId: params.sessionId,
        provider,
        model: modelId,
      },
      error: {
        kind: timedOut ? "timeout" : "unknown",
        message: timedOut ? "LLM request timed out." : "LLM request aborted.",
      },
    },
  } as any;
}
