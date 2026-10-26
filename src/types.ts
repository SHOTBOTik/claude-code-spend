/** Tokens of one call or of a group of calls, the cache write split the way it is priced. */
export interface Tokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/**
 * `message.usage` as the Messages API returns it, and as Claude Code and the Agent SDK pass it on. Only the fields
 * read here; anything else is ignored. `cache_creation` is the split of the cache write by lifetime, absent on
 * older logs.
 */
export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

/** One line of a Claude Code session log (`~/.claude/projects/<project>/<session>.jsonl`): the fields read here. */
export interface LogLine {
  type?: string;
  sessionId?: string;
  requestId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { id?: string; model?: string; usage?: Usage | null };
}

/**
 * The messages of the Claude Agent SDK this package reads, described by their own fields so that the SDK itself is
 * not a dependency. Any other message is passed by.
 */
export type SdkMessage =
  | {
      type: 'assistant';
      session_id?: string;
      /** `null` for the main thread, the id of the Task tool call for a sub-agent. */
      parent_tool_use_id?: string | null;
      message: { id?: string; model?: string; usage?: Usage | null };
    }
  | {
      /** Partial messages (`includePartialMessages`): `message_delta` carries the final output count of a call. */
      type: 'stream_event';
      /** The id of the API message the event belongs to, when the frame carries it. */
      api_message_id?: string;
      event?: { type?: string; usage?: { output_tokens?: number | null } | null };
    }
  | { type: string };

/** Where a cache write goes when `usage` has no `cache_creation` split. The API's default lifetime is 5 minutes. */
export type UnsplitWrite = '5m' | '1h';

/** One request to the model: every line or message of it merged into one. */
export interface Call {
  /** `message.id` and `requestId` (when known): the key the duplicates are merged by. */
  key: string;
  messageId: string;
  requestId?: string;
  model: string;
  /** The session the call was first seen in. */
  sessionId: string;
  /** When the call was first seen; a call without a time has no day. */
  at?: Date;
  /** A sub-agent's call (sidechain in a log, a parent tool call in the SDK). */
  sidechain: boolean;
  tokens: Tokens;
  /** Of `tokens.cacheWrite5m + tokens.cacheWrite1h`: how much had no split by lifetime and was put by the rule. */
  unsplitWrite: number;
  /** How many lines or messages were merged into this call. */
  seen: number;
}

export type GroupBy = 'model' | 'session' | 'day';
