/**
 * iMessage Reader
 *
 * Reads ~/Library/Messages/chat.db (macOS only) to track
 * co-parent communication via iMessage. Polls for new messages,
 * saves them to Supabase, and notifies via Telegram.
 *
 * Requires Full Disk Access for the terminal running the bot.
 */

import { Database } from "bun:sqlite";
import { readFile, writeFile, mkdir } from "fs/promises";
import { watch } from "fs";
import { join, dirname } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";

const CHAT_DB_PATH = join(
  process.env.HOME || "~",
  "Library/Messages/chat.db"
);
const RELAY_DIR =
  process.env.RELAY_DIR ||
  join(process.env.HOME || "~", ".coparent-relay");
const CURSOR_FILE = join(RELAY_DIR, "imessage-cursor.json");

const FALLBACK_POLL_MS = 60_000; // 60s fallback if file watching fails
const DEBOUNCE_MS = 500; // debounce rapid file change events

const COPARENT_HANDLE = process.env.COPARENT_HANDLE || "";
const COPARENT_NAME = process.env.COPARENT_NAME || "Co-parent";
const USER_NAME = process.env.USER_NAME || "user";

// Apple's epoch starts 2001-01-01 — offset from Unix epoch
const APPLE_EPOCH_OFFSET = 978307200;

// Module-level database handle with lazy initialization
let moduleDb: Database | null = null;
let dbInitAttempted = false;

function getDb(): Database | null {
  if (moduleDb) return moduleDb;
  if (dbInitAttempted) return null;
  dbInitAttempted = true;
  try {
    moduleDb = new Database(CHAT_DB_PATH, { readonly: true });
    console.log("chat.db opened for context queries");
    return moduleDb;
  } catch (error) {
    console.warn(
      "Could not open chat.db for context queries. " +
        "Falling back to in-memory buffer. " +
        "Ensure Full Disk Access is granted.",
      error
    );
    return null;
  }
}

// In-memory ring buffer for recent iMessage exchanges (fallback when chat.db can't be opened)
const MAX_BUFFER_SIZE = 20;
interface BufferedMessage {
  content: string;
  direction: "incoming" | "outgoing";
  timestamp: string;
}
const recentMessageBuffer: BufferedMessage[] = [];

interface CursorState {
  lastRowId: number;
}

// In-memory cursor — loaded once from file at startup, then kept in sync
let cachedCursor: CursorState | null = null;

// Polling lock — prevents concurrent poll() executions
let isPolling = false;

async function loadCursor(): Promise<CursorState> {
  if (cachedCursor) return cachedCursor;
  try {
    const content = await readFile(CURSOR_FILE, "utf-8");
    cachedCursor = JSON.parse(content);
    return cachedCursor!;
  } catch {
    cachedCursor = { lastRowId: 0 };
    return cachedCursor;
  }
}

async function saveCursor(state: CursorState): Promise<void> {
  cachedCursor = state;
  await mkdir(RELAY_DIR, { recursive: true });
  await writeFile(CURSOR_FILE, JSON.stringify(state, null, 2));
}

function appleTimestampToUnix(appleNs: number): number {
  return appleNs / 1_000_000_000 + APPLE_EPOCH_OFFSET;
}

interface IMessageRow {
  ROWID: number;
  text: string | null;
  is_from_me: number;
  date: number;
  handle_id: string;
}

/**
 * Start the iMessage polling loop.
 * Reads new messages from chat.db and syncs to Supabase + Telegram.
 */
export function startIMessageSync(
  supabase: SupabaseClient | null,
  sendTelegram: (text: string) => Promise<void>
): void {
  if (!COPARENT_HANDLE) {
    console.log(
      "iMessage sync disabled — COPARENT_HANDLE not set in .env"
    );
    return;
  }

  const db = getDb();
  if (!db) {
    console.error(
      "Could not open iMessage database. Make sure Full Disk Access is granted."
    );
    return;
  }

  console.log(`iMessage sync started — watching for ${COPARENT_NAME} (${COPARENT_HANDLE})`);

  const query = db.query<IMessageRow, [string, number]>(`
    SELECT
      m.ROWID,
      m.text,
      m.is_from_me,
      m.date,
      h.id AS handle_id
    FROM message m
    JOIN handle h ON m.handle_id = h.ROWID
    WHERE h.id = ?1
      AND m.ROWID > ?2
    ORDER BY m.ROWID ASC
  `);

  async function poll(): Promise<void> {
    if (isPolling) return;
    isPolling = true;
    try {
      const cursor = await loadCursor();
      const rows = query.all(COPARENT_HANDLE, cursor.lastRowId);

      if (rows.length === 0) return;

      let newLastRowId = cursor.lastRowId;

      for (const row of rows) {
        if (!row.text) continue; // skip non-text messages (tapbacks, etc.)

        const unixTimestamp = appleTimestampToUnix(row.date);
        const timestamp = new Date(unixTimestamp * 1000).toISOString();
        const direction = row.is_from_me ? "outgoing" : "incoming";

        // Save to exchanges table (iMessage thread, separate from bot chat)
        if (supabase) {
          const { error } = await supabase.from("exchanges").insert({
            sender: row.is_from_me ? USER_NAME : COPARENT_NAME,
            content: row.text,
            original_timestamp: timestamp,
            metadata: {
              source: "imessage",
              direction,
              coparent_handle: COPARENT_HANDLE,
            },
          });
          if (error) console.error("Exchange save error:", error.message, error.details);
        }

        // Always push to in-memory buffer (works even without Supabase)
        recentMessageBuffer.push({
          content: row.text,
          direction,
          timestamp,
        });
        if (recentMessageBuffer.length > MAX_BUFFER_SIZE) {
          recentMessageBuffer.shift();
        }

        // Notify on Telegram for incoming messages only
        if (!row.is_from_me) {
          await sendTelegram(
            `${COPARENT_NAME}: ${row.text}`
          );
        }

        newLastRowId = Math.max(newLastRowId, row.ROWID);
      }

      if (newLastRowId > cursor.lastRowId) {
        await saveCursor({ lastRowId: newLastRowId });
      }
    } catch (error) {
      console.error("iMessage poll error:", error);
    } finally {
      isPolling = false;
    }
  }

  // Initial poll — complete and save cursor before starting watchers
  poll().then(() => {
    // Watch chat.db for changes (FSEvents on macOS) — near-instant notifications
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const watcher = watch(CHAT_DB_PATH, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(poll, DEBOUNCE_MS);
      });
      watcher.on("error", (err) => {
        console.error("File watcher error, falling back to polling:", err);
        setInterval(poll, FALLBACK_POLL_MS);
      });
      console.log("iMessage watching via FSEvents (near-instant)");
    } catch (err) {
      console.error("Could not watch chat.db, falling back to polling:", err);
      setInterval(poll, FALLBACK_POLL_MS);
    }

    // Safety-net poll in case file events are missed
    setInterval(poll, FALLBACK_POLL_MS);
  });
}

/**
 * Get recent iMessage exchanges with the co-parent for prompt context.
 * Primary: reads chat.db directly (source of truth, survives restarts).
 * Fallback: in-memory ring buffer (when chat.db can't be opened).
 */
export async function getRecentExchanges(
  supabase: SupabaseClient | null,
  count: number = 10
): Promise<string> {
  if (!COPARENT_HANDLE) return "";

  // Primary: query chat.db directly
  const db = getDb();
  if (db) {
    try {
      const rows = db
        .query<
          { text: string; is_from_me: number; date: number },
          [string, number]
        >(
          `SELECT m.text, m.is_from_me, m.date
           FROM message m
           JOIN handle h ON m.handle_id = h.ROWID
           WHERE h.id = ?1
             AND m.text IS NOT NULL
           ORDER BY m.date DESC
           LIMIT ?2`
        )
        .all(COPARENT_HANDLE, count);

      if (rows.length > 0) {
        const exchanges = rows
          .reverse() // chronological order
          .map((row) => {
            const who = row.is_from_me ? USER_NAME : COPARENT_NAME;
            return `${who}: ${row.text}`;
          })
          .join("\n");

        console.log(
          `getRecentExchanges: ${rows.length} messages from chat.db`
        );
        return `RECENT iMESSAGE EXCHANGES WITH ${COPARENT_NAME.toUpperCase()}:\n${exchanges}`;
      }

      console.log("getRecentExchanges: 0 messages found in chat.db");
      return "";
    } catch (error) {
      console.warn("getRecentExchanges: chat.db query failed, trying Supabase fallback", error);
    }
  } else {
    console.log("getRecentExchanges: chat.db unavailable, trying Supabase fallback");
  }

  // Second fallback: query exchanges table in Supabase (recent/uncompacted)
  if (supabase) {
    try {
      const { data } = await supabase.rpc("get_recent_exchanges", { limit_count: count });
      if (data?.length) {
        const exchanges = data.reverse().map((row: any) => `${row.sender}: ${row.content}`).join("\n");
        console.log(`getRecentExchanges: ${data.length} messages from Supabase exchanges`);
        return `RECENT iMESSAGE EXCHANGES WITH ${COPARENT_NAME.toUpperCase()}:\n${exchanges}`;
      }
    } catch (error) {
      console.warn("getRecentExchanges: Supabase exchanges fallback failed", error);
    }
  }

  // Third fallback: daily_transcripts (for when exchanges have been compacted)
  if (supabase) {
    try {
      const { data } = await supabase
        .from("daily_transcripts")
        .select("date, transcript, message_count")
        .order("date", { ascending: false })
        .limit(2);
      if (data?.length) {
        const transcripts = data.reverse().map((row: any) =>
          `--- ${row.date} (${row.message_count} messages) ---\n${row.transcript}`
        ).join("\n\n");
        console.log(`getRecentExchanges: ${data.length} days from daily_transcripts`);
        return `RECENT iMESSAGE EXCHANGES WITH ${COPARENT_NAME.toUpperCase()}:\n${transcripts}`;
      }
    } catch (error) {
      console.warn("getRecentExchanges: daily_transcripts fallback failed", error);
    }
  }

  // Last fallback: use in-memory buffer
  if (recentMessageBuffer.length === 0) return "";

  const exchanges = recentMessageBuffer
    .slice(-count)
    .map((m) => {
      const who = m.direction === "outgoing" ? USER_NAME : COPARENT_NAME;
      return `${who}: ${m.content}`;
    })
    .join("\n");

  console.log(
    `getRecentExchanges: ${Math.min(count, recentMessageBuffer.length)} messages from buffer`
  );
  return `RECENT iMESSAGE EXCHANGES WITH ${COPARENT_NAME.toUpperCase()}:\n${exchanges}`;
}
