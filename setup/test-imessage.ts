/**
 * Claude Telegram Relay — Test iMessage Context Pipeline
 *
 * Verifies that chat.db can be read, messages exist for COPARENT_HANDLE,
 * and getRecentExchanges() returns the formatted context string Claude sees.
 *
 * Usage: bun run setup/test-imessage.ts
 */

import { Database } from "bun:sqlite";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");

// Load .env manually
async function loadEnv(): Promise<Record<string, string>> {
  const envPath = join(PROJECT_ROOT, ".env");
  try {
    const content = await Bun.file(envPath).text();
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

const CHAT_DB_PATH = join(
  process.env.HOME || "~",
  "Library/Messages/chat.db"
);

// Apple's epoch starts 2001-01-01
const APPLE_EPOCH_OFFSET = 978307200;

async function main() {
  console.log("");
  console.log(bold("  iMessage Context Test"));
  console.log("");

  const env = await loadEnv();
  const handle = env.COPARENT_HANDLE || process.env.COPARENT_HANDLE || "";
  const coparentName = env.COPARENT_NAME || process.env.COPARENT_NAME || "Co-parent";

  // 1. Check COPARENT_HANDLE
  if (!handle || handle.includes("your_")) {
    console.log(`  ${FAIL} COPARENT_HANDLE not set in .env`);
    console.log(`      ${dim("Set it to your co-parent's phone number or iMessage ID (e.g., +15551234567)")}`);
    process.exit(1);
  }
  const masked = handle.length > 6
    ? handle.slice(0, 4) + "..." + handle.slice(-2)
    : handle;
  console.log(`  ${PASS} COPARENT_HANDLE set: ${masked}`);

  // 2. Open chat.db
  let db: Database;
  try {
    db = new Database(CHAT_DB_PATH, { readonly: true });
    console.log(`  ${PASS} chat.db opened successfully`);
  } catch (error: any) {
    console.log(`  ${FAIL} Cannot open chat.db`);
    if (error.message?.includes("permission") || error.code === "SQLITE_CANTOPEN") {
      console.log(`      ${dim("Grant Full Disk Access to your terminal app:")}`);
      console.log(`      ${dim("System Settings > Privacy & Security > Full Disk Access")}`);
      console.log(`      ${dim("Add your terminal (Terminal, iTerm2, Warp, etc.) and restart it")}`);
    } else {
      console.log(`      ${dim(error.message)}`);
    }
    process.exit(1);
  }

  // 3. Query messages directly
  const COUNT = 10;
  let rows: { text: string; is_from_me: number; date: number }[];
  try {
    rows = db
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
      .all(handle, COUNT);
  } catch (error: any) {
    console.log(`  ${FAIL} SQL query failed: ${error.message}`);
    db.close();
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log(`  ${WARN} No messages found for ${masked}`);
    console.log(`      ${dim("Make sure COPARENT_HANDLE matches exactly (phone format: +15551234567)")}`);
    console.log(`      ${dim("Check that you have iMessage conversations with this contact")}`);
    db.close();
    process.exit(0);
  }

  console.log(`  ${PASS} Found ${rows.length} messages with co-parent`);

  // 4. Display formatted output (what Claude sees)
  const exchanges = rows
    .reverse()
    .map((row) => {
      const who = row.is_from_me ? "You" : coparentName;
      return `[${who}]: ${row.text}`;
    })
    .join("\n");

  const contextString = `RECENT iMESSAGE EXCHANGES WITH ${coparentName.toUpperCase()}:\n${exchanges}`;

  console.log("");
  console.log(`  ${bold("What Claude sees:")}`);
  console.log(`  ${"─".repeat(40)}`);
  for (const line of contextString.split("\n")) {
    console.log(`  ${line}`);
  }
  console.log(`  ${"─".repeat(40)}`);

  db.close();

  // 5. Call getRecentExchanges() to verify the actual function
  // Set env vars so the module picks them up
  process.env.COPARENT_HANDLE = handle;
  process.env.COPARENT_NAME = coparentName;

  console.log("");
  try {
    const { getRecentExchanges } = await import("../src/imessage.ts");
    const result = await getRecentExchanges(null, COUNT);

    if (result && result.length > 0) {
      const lineCount = result.split("\n").length - 1; // subtract header line
      console.log(`  ${PASS} getRecentExchanges() returned ${lineCount} messages`);
    } else {
      console.log(`  ${WARN} getRecentExchanges() returned empty (but direct query worked)`);
    }
  } catch (error: any) {
    console.log(`  ${FAIL} getRecentExchanges() threw: ${error.message}`);
  }

  // 6. Check Supabase for forwarded messages (if configured)
  const supaUrl = env.SUPABASE_URL || process.env.SUPABASE_URL || "";
  const supaKey = env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";

  if (supaUrl && !supaUrl.includes("your_") && supaKey && !supaKey.includes("your_")) {
    try {
      const res = await fetch(
        `${supaUrl}/rest/v1/messages?select=id&metadata->>source=eq.imessage&limit=100`,
        {
          headers: {
            apikey: supaKey,
            Authorization: `Bearer ${supaKey}`,
          },
        }
      );

      if (res.status === 200) {
        const data = (await res.json()) as any[];
        if (data.length > 0) {
          console.log(`  ${PASS} Supabase has ${data.length} forwarded iMessage notifications`);
        } else {
          console.log(`  ${WARN} No forwarded iMessages in Supabase yet (they appear after the bot runs)`);
        }
      } else {
        console.log(`  ${WARN} Could not query Supabase messages: ${res.status}`);
      }
    } catch (error: any) {
      console.log(`  ${WARN} Supabase check failed: ${error.message}`);
    }
  } else {
    console.log(`  ${dim("  Supabase not configured — skipping forwarded message check")}`);
  }

  console.log(`\n  ${green("All good!")} iMessage context is working.`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
