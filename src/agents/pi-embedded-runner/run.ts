import { streamSimple } from "@mariozechner/pi-ai";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "./types.js";
import { type OpenClawConfig } from "../../config/types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentId, resolveAgentConfig } from "../agent-scope.js";
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
  isAuthAssistantError,
  isCompactionFailureError,
  isContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  parseImageSizeError,
  parseImageDimensionError,
  isRateLimitAssistantError,
  isTimeoutErrorMessage,
  pickFallbackThinkingLevel,
  type FailoverReason,
} from "../pi-embedded-helpers.js";
import { resolveCompactionReserveTokensFloor } from "../pi-settings.js";
import { normalizeUsage, type UsageLike } from "../usage.js";
import {
  loadWorkspaceBootstrapFiles,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
} from "../workspace.js";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { limitHistoryTurns, getDmHistoryLimitFromSessionKey } from "./history.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { resolveModel } from "./model.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import { describeUnknownError } from "./utils.js";

type ApiKeyInfo = ResolvedProviderAuth;

// Avoid Anthropic's refusal test token poisoning session transcripts.
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  return enqueueSession(() =>
    enqueueGlobal(async () => {
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
      const fallbackConfigured =
        (params.config?.agents?.defaults?.model?.fallbacks?.length ?? 0) > 0;
      await ensureOpenClawModelsJson(params.config as OpenClawConfig, agentDir);

      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
        params.config as OpenClawConfig,
      );
      if (!model) {
        return {
          ok: false,
          error: error ?? `Unknown model: ${provider}/${modelId}`,
          meta: {} as any,
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
          const { resolveCopilotApiToken } =
            await import("../../providers/github-copilot-token.js");
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
      const subconsciousAgent: {
        complete: (prompt: string) => Promise<{ text: string | null }>;
        autoBootstrapHistory?: boolean;
      } = {
        complete: async (prompt: string) => {
          let fullText = "";
          try {
            const key = ((authStorage as any).getRuntimeApiKey?.(model.provider) ||
              apiKeyInfo?.apiKey) as string;
            if (!key) return { text: "" };
            const stream = streamSimple(
              model,
              {
                messages: [{ role: "user", content: prompt, timestamp: Date.now() } as any],
                temperature: 0, // Force deterministic output to avoid loops
              } as any,
              {
                apiKey: key,
              },
            );
            if (debug)
              process.stderr.write(`  🧩 [DEBUG] Subconscious stream open (${modelId})... `);
            for await (const chunk of stream) {
              const ch = chunk as any;
              let text = "";

              if (ch.content) {
                fullText = ch.content;
              } else if (ch.text) {
                fullText = ch.text;
              } else if (ch.delta?.text) {
                text = ch.delta.text;
              } else if (typeof ch.delta === "string") {
                text = ch.delta;
              } else if (ch.delta?.content?.[0]?.text) {
                text = ch.delta.content[0].text;
              } else if (ch.partial?.content?.[0]?.text) {
                text = ch.partial.content[0].text;
              }

              if (text) {
                fullText += text;
              }
            }
            if (debug && fullText.length > 0) process.stderr.write("\n");
          } catch (e: any) {
            if (debug) process.stderr.write(`  ❌ [DEBUG] Subconscious LLM error: ${e.message}\n`);
          }
          return { text: fullText };
        },
        autoBootstrapHistory: mindConfig?.config?.narrative?.autoBootstrapHistory ?? false,
      };

      const agentId = resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: params.config as OpenClawConfig,
      });
      const agentConfig = resolveAgentConfig((params.config as OpenClawConfig) ?? {}, agentId);

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
          identityParts.push(`CONFIG IDENTITY: ${agentConfig.identity}`);
        }

        identityContext = identityParts.join("\n\n").trim();
      } catch (e: any) {
        if (debug)
          process.stderr.write(`  ⚠️ [DEBUG] Failed to load identity context: ${e.message}\n`);
      }

      let finalExtraSystemPrompt = params.extraSystemPrompt ?? "";
      let narrativeStory: { content: string; updatedAt: Date } | null = null;
      const storyPath = path.join(resolvedWorkspace, "STORY.md");
      const isMindEnabled = mindConfig?.enabled && (mindConfig?.config?.narrative?.enabled ?? true);
      const tokenThreshold = mindConfig?.config?.narrative?.tokenThreshold ?? 5000;

      // HEARTBEAT DETECTION (Incoming)
      const isHeartbeatPrompt =
        params.prompt.includes("Read HEARTBEAT.md") && params.prompt.includes("reply HEARTBEAT_OK");

      try {
        if (isMindEnabled) {
          // [MIND] Disable Mind for sub-agents (no observer, no storage)
          if (isSubagentSessionKey(params.sessionKey)) {
            if (debug)
              process.stderr.write(`🧠 [MIND] Sub-agent detected - skipping Mind pipeline.\n`);
          } else {
            if (debug)
              process.stderr.write(
                `🧠 [MIND] Starting modular subconscious pipeline (Model: ${modelId})...\n`,
              );

            const { GraphService } = await import("../../services/memory/GraphService.js");
            const { SubconsciousService } =
              await import("../../services/memory/SubconsciousService.js");
            const { ConsolidationService } =
              await import("../../services/memory/ConsolidationService.js");

            const gUrl = (mindConfig?.config as any)?.graphiti?.baseUrl || "http://localhost:8001";
            const gs = new GraphService(gUrl, debug);
            const sub = new SubconsciousService(gs, debug);
            const cons = new ConsolidationService(gs, debug);
            const globalSessionId = "global-user-memory";

            if (!isHeartbeatPrompt) {
              // 1. Storage & Consolidation (Only for real messages)
              const memoryDir = path.join(path.dirname(storyPath), "memory");
              const sessionMgr = SessionManager.open(params.sessionFile);
              const sessionMessages = sessionMgr.buildSessionContext().messages || [];

              const safeTokenLimit = Math.floor((ctxInfo.tokens || 50000) * 0.5);

              // Bootstrap historical episodes
              await cons.bootstrapHistoricalEpisodes(params.sessionId, memoryDir, sessionMessages);

              // GLOBAL NARRATIVE SYNC (Startup)
              // Recover any un-narrated messages from previous sessions
              const { resolveSessionTranscriptsDir } =
                await import("../../config/sessions/paths.js");
              const sessionsDir = resolveSessionTranscriptsDir();
              await cons.syncGlobalNarrative(
                sessionsDir,
                storyPath,
                subconsciousAgent,
                identityContext,
                safeTokenLimit,
              );

              // Persist User Message to Graphiti (Semantic Search)
              if (debug)
                process.stderr.write(
                  `Tape [GRAPH] Storing episode for Global ID: ${globalSessionId} (Trace: ${params.sessionId})\n`,
                );
              await gs.addEpisode(globalSessionId, `human: ${params.prompt}`);

              // NOTE: We no longer track pending episodes per turn or consolidate constantly.
              // Narrative updates now happen via Global Sync (startup) or Compaction Sync.
            } else {
              if (debug)
                process.stderr.write(
                  `💓 [MIND] Heartbeat detected - skipping memory storage & consolidation.\n`,
                );
            }

            // 2. Fetch Narrative Story (ALWAYS, even for heartbeats)
            try {
              const storyContent = await fs.readFile(storyPath, "utf-8").catch(() => null);
              if (storyContent) {
                narrativeStory = { content: storyContent, updatedAt: new Date() };
                if (debug)
                  process.stderr.write(
                    `📖 [MIND] Local Story retrieved (${storyContent.length} chars)\n`,
                  );
              }
            } catch (e: any) {
              if (debug)
                process.stderr.write(`⚠️ [MIND] Failed to read local story: ${e.message}\n`);
            }

            // 3. Get Flashbacks (Only for real messages)
            if (!isHeartbeatPrompt) {
              let oldestContextTimestamp: Date | undefined;
              let rawHistory: any[] = [];
              try {
                const tempSessionManager = SessionManager.open(params.sessionFile);
                const branch = tempSessionManager.getBranch();

                rawHistory = branch
                  .filter((e) => e.type === "message")
                  .filter((e) => (e.message as any)?.role !== "system") // [MIND] Exclude system messages (compaction/summaries)
                  .map((e: any) => ({
                    role: (e.message as any)?.role,
                    text: (e.message as any)?.text || (e.message as any)?.content,
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
              } catch (e) {}

              const flashbacks = await sub.getFlashback(
                globalSessionId, // STRICTLY use global-user-memory
                params.prompt,
                subconsciousAgent,
                oldestContextTimestamp,
                rawHistory,
              );

              if (flashbacks) {
                if (debug)
                  process.stderr.write("✨ [MIND] Memories injected into system prompt.\n");
                finalExtraSystemPrompt += flashbacks;
              }
            } else {
              if (debug)
                process.stderr.write(
                  `💓 [MIND] Heartbeat detected - skipping resonance retrieval.\n`,
                );
            }
          }
        }
      } catch (e: any) {
        process.stderr.write(`❌ [MIND] Subconscious error: ${e.message}\n`);
      }

      const started = Date.now();
      let aborted = false;
      let timedOut = false;

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
            if (payload.text) process.stderr.write("✍️");
            params.onPartialReply?.(payload);
          },
          onAssistantMessageStart: params.onAssistantMessageStart,
          onBlockReply: params.onBlockReply,
          onBlockReplyFlush: params.onBlockReplyFlush,
          blockReplyBreak: params.blockReplyBreak,
          blockReplyChunking: params.blockReplyChunking,
          onReasoningStream: params.onReasoningStream,
          onToolResult: params.onToolResult,
          onAgentEvent: params.onAgentEvent,
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
            const maxMbLabel =
              typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
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
                const { ConsolidationService } =
                  await import("../../services/memory/ConsolidationService.js");

                const gUrl =
                  (mindConfig?.config as any)?.graphiti?.baseUrl || "http://localhost:8001";
                const gs = new GraphService(gUrl, debug);
                const cons = new ConsolidationService(gs, debug);

                await gs.addEpisode("global-user-memory", `assistant: ${assistantText}`);
                // await cons.trackPendingEpisode(...) -> Disabled in favor of Compaction Sync
              }
            } else if (isHeartbeatResponse) {
              if (debug)
                process.stderr.write(
                  `💓 [MIND] Heartbeat response detected - skipping memory storage.\n`,
                );
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
    }),
  );
}
