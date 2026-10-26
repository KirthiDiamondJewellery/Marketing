import {
  ProviderError,
  type AttentionOSConfig,
  type InboundMessage,
  type Logger,
  type Notifier,
  type OutboundMessage,
  type ProviderHealth,
} from "@attentionos/core";
import { DiscordClient, type FetchLike } from "./client.ts";
import { decodeCursor, encodeCursor, isFromOwner, messagesToInbound, parseInteraction, reactionCandidates, type ParsedInteraction } from "./inbound.ts";
import { planSend, type ActionMode } from "./payload.ts";

export { escapeDiscord, toDiscordMarkdown } from "./markdown.ts";
export { actionMapFooter, buildButtons, emojiFor, parseActionMap, planSend, type ActionMode, type PlannedMessage } from "./payload.ts";
export {
  decodeCursor,
  encodeCursor,
  interactionResponse,
  messagesToInbound,
  parseInteraction,
  reactionCandidates,
  verifyInteraction,
  type ParsedInteraction,
} from "./inbound.ts";
export { extractRef, normalizeRef, refFooter } from "./refs.ts";

export type CreateOptions = {
  secret(name: string): string | undefined;
  config: AttentionOSConfig;
  log: Logger;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Override the action mode. Default: "buttons" when DISCORD_PUBLIC_KEY is set, otherwise "reactions". */
  actionMode?: ActionMode;
};

export interface DiscordNotifier extends Notifier {
  readonly id: "discord";
  readonly actionMode: ActionMode;
  /** For the Autopilot worker's interactions endpoint (buttons mode). Verify the signature first. */
  handleInteraction(body: unknown): ParsedInteraction;
}

const SETUP_FIX =
  "Create a bot in the Discord developer portal, turn on the Message Content intent, invite it to your server, then set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID in your workspace .env.";

/** Discord notifier (alternative to Telegram). */
export function create(opts: CreateOptions): DiscordNotifier {
  const token = opts.secret("DISCORD_BOT_TOKEN")?.trim();
  const channelId = opts.secret("DISCORD_CHANNEL_ID")?.trim();
  const ownerId = opts.secret("DISCORD_OWNER_ID")?.trim() || undefined;
  const publicKey = opts.secret("DISCORD_PUBLIC_KEY")?.trim();
  const actionMode: ActionMode = opts.actionMode ?? (publicKey ? "buttons" : "reactions");
  const log = opts.log.child({ provider: "discord" });
  const client = token
    ? new DiscordClient({ token, log, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}) })
    : undefined;
  let botUserId: string | undefined;

  const ready = (): { c: DiscordClient; channel: string } => {
    if (!client) throw new ProviderError("discord", "auth", `DISCORD_BOT_TOKEN is not set. ${SETUP_FIX}`);
    if (!channelId) throw new ProviderError("discord", "invalid_request", `DISCORD_CHANNEL_ID is not set. ${SETUP_FIX}`);
    return { c: client, channel: channelId };
  };
  const me = async (c: DiscordClient) => {
    botUserId ??= (await c.get<{ id: string }>("/users/@me")).id;
    return botUserId;
  };

  return {
    id: "discord",
    actionMode,

    async health(): Promise<ProviderHealth> {
      if (!client) return { ok: false, detail: "Discord bot token is missing", fix: SETUP_FIX };
      try {
        const user = await client.get<{ username?: string; id: string }>("/users/@me");
        botUserId = user.id;
        if (!channelId) return { ok: false, detail: `Connected as ${user.username ?? "your bot"}, but no channel is set`, fix: SETUP_FIX };
        await client.get(`/channels/${channelId}`);
        const how = actionMode === "buttons" ? "buttons" : "reactions";
        return { ok: true, detail: `Connected as ${user.username ?? "your bot"}; approvals use ${how}` };
      } catch (e) {
        const code = e instanceof ProviderError ? e.code : undefined;
        if (code === "auth") return { ok: false, detail: "Discord rejected the bot token or the bot can't see the channel", fix: "Reset the token in the developer portal, and check the bot was invited with View Channel, Send Messages, Add Reactions and Read Message History." };
        if (code === "not_found") return { ok: false, detail: "The channel wasn't found", fix: "Turn on Developer Mode in Discord, right-click the channel, Copy Channel ID, and paste it into DISCORD_CHANNEL_ID." };
        return { ok: false, detail: "Discord didn't respond", fix: "Check your internet connection and try again." };
      }
    },

    async send(msg: OutboundMessage): Promise<{ messageId: string }> {
      const { c, channel } = ready();
      const planned = planSend(msg, actionMode);
      let firstId: string | undefined;
      for (const p of planned) {
        const sent = await c.postMessage(channel, p);
        firstId ??= sent.id;
        for (const emoji of p.reactions) {
          await c.put(`/channels/${channel}/messages/${sent.id}/reactions/${encodeURIComponent(emoji)}/@me`).catch((e) => {
            log.warn("could not add reaction", { error: e instanceof Error ? e.message : String(e) });
          });
        }
      }
      return { messageId: firstId ?? "" };
    },

    async receive(cursor?: string): Promise<{ messages: InboundMessage[]; cursor: string }> {
      const { c, channel } = ready();
      const state = decodeCursor(cursor);
      const bot = await me(c);
      const filter = { botUserId: bot, ...(ownerId ? { ownerId } : {}) };

      // First run: start from the newest message so old history isn't replayed as instructions.
      const raw = await c.get<unknown[]>(state.after ? `/channels/${channel}/messages?after=${state.after}&limit=100` : `/channels/${channel}/messages?limit=1`);
      const fresh = messagesToInbound(raw, state.after, filter);
      const messages = state.after ? fresh.messages : [];
      const next = { after: fresh.newestId ?? state.after, done: [...state.done] };

      // Reactions on our recent messages (reactions mode).
      if (actionMode === "reactions") {
        const recent = await c.get<unknown[]>(`/channels/${channel}/messages?limit=50`);
        for (const cand of reactionCandidates(recent, next.done)) {
          const users = await c.get<{ id: string; bot?: boolean }[]>(
            `/channels/${channel}/messages/${cand.messageId}/reactions/${encodeURIComponent(cand.emoji)}?limit=25`,
          );
          const who = users.find((u) => isFromOwner({ author: u }, filter));
          if (!who) continue;
          next.done.push(cand.messageId);
          messages.push({
            channel: "discord",
            messageId: `rx:${cand.messageId}`,
            text: "",
            from: who.id,
            at: new Date().toISOString(),
            actionId: cand.actionId,
            ...(cand.ref ? { replyToRef: cand.ref } : {}),
          });
        }
      }
      return { messages, cursor: encodeCursor(next) };
    },

    handleInteraction(body: unknown): ParsedInteraction {
      return parseInteraction(body, { ...(ownerId ? { ownerId } : {}), ...(botUserId ? { botUserId } : {}), ...(channelId ? { channelId } : {}) });
    },
  };
}

export default create;
