/**
 * Compact Exchanges → Daily Transcripts
 *
 * Groups individual iMessage exchanges into 1 row per day.
 * Handles both backfill (first run) and nightly compaction.
 *
 * - Skips today (keep raw exchanges for real-time context)
 * - UPSERTs into daily_transcripts (safe to re-run)
 * - Deletes compacted rows from exchanges
 *
 * Usage: bun run compact
 */

import { createClient } from "@supabase/supabase-js";
import { dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const USER_NAME = process.env.USER_NAME || "user";
const COPARENT_NAME = process.env.COPARENT_NAME || "Co-parent";
const USER_TIMEZONE = process.env.USER_TIMEZONE || "America/Denver";

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: USER_TIMEZONE,
  });
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error(`\n  ${red("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env")}\n`);
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  console.log("");
  console.log(bold("  Exchange Compaction → Daily Transcripts"));
  console.log("");

  // Get today's date in user's timezone to skip it
  const today = new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE }); // YYYY-MM-DD

  // Fetch all exchanges except today's, ordered chronologically
  const { data: exchanges, error } = await supabase
    .from("exchanges")
    .select("id, sender, content, original_timestamp, created_at")
    .lt("original_timestamp", `${today}T00:00:00`)
    .order("original_timestamp", { ascending: true, nullsFirst: false });

  if (error) {
    console.error(`  ${red("Error fetching exchanges:")} ${error.message}`);
    process.exit(1);
  }

  if (!exchanges || exchanges.length === 0) {
    console.log(`  ${dim("No exchanges to compact (only today's remain).")}`);
    console.log("");
    return;
  }

  console.log(`  Found ${exchanges.length} exchanges to compact (excluding today: ${today})`);

  // Group by date
  const byDate = new Map<string, typeof exchanges>();

  for (const ex of exchanges) {
    const ts = ex.original_timestamp || ex.created_at;
    const date = new Date(ts).toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });

    if (date === today) continue; // safety check

    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(ex);
  }

  console.log(`  Grouped into ${byDate.size} days`);
  console.log("");

  let totalCompacted = 0;
  let daysCreated = 0;

  for (const [date, dayExchanges] of byDate) {
    // Format as timestamped transcript
    const lines = dayExchanges.map((ex) => {
      const ts = ex.original_timestamp || ex.created_at;
      const time = formatTime(new Date(ts));
      return `[${time}] ${ex.sender}: ${ex.content}`;
    });

    const transcript = lines.join("\n");

    // UPSERT into daily_transcripts
    const { error: upsertError } = await supabase
      .from("daily_transcripts")
      .upsert(
        {
          date,
          transcript,
          message_count: dayExchanges.length,
          metadata: {
            participants: [USER_NAME, COPARENT_NAME],
            compacted_at: new Date().toISOString(),
          },
        },
        { onConflict: "date" }
      );

    if (upsertError) {
      console.error(`  ${red("✗")} ${date}: upsert failed — ${upsertError.message}`);
      continue;
    }

    // Delete compacted exchanges
    const ids = dayExchanges.map((ex) => ex.id);
    const { error: deleteError } = await supabase
      .from("exchanges")
      .delete()
      .in("id", ids);

    if (deleteError) {
      console.error(`  ${red("✗")} ${date}: delete failed — ${deleteError.message}`);
      continue;
    }

    console.log(`  ${green("✓")} ${date}: ${dayExchanges.length} messages → 1 transcript`);
    totalCompacted += dayExchanges.length;
    daysCreated++;
  }

  console.log("");
  console.log(`  ${green("Done!")} ${totalCompacted} exchanges → ${daysCreated} daily transcripts`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
