/**
 * Morning Briefing — Production Version
 *
 * Sends a daily co-parenting briefing via Telegram at 9am with real data:
 * 1. Custody today — who has the children
 * 2. This week — day-by-day schedule
 * 3. Upcoming holidays — with parent assignments
 * 4. Recent agreements — from Supabase memory
 * 5. Active goals — from Supabase get_active_goals()
 * 6. Weekend ideas — Thu/Fri before user weekends (via Claude CLI)
 *
 * Schedule: bun run setup:launchd -- --service briefing
 * Manual:   bun run briefing
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { spawn } from "bun";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  getCustodyStatus,
  getWeekSummary,
  getUpcomingHolidays,
  isUserWeekend,
  getNextTransition,
  getSchoolSchedule,
  getUpcomingSchoolEvents,
  formatTime,
} from "./schedule.ts";

const PROJECT_ROOT = dirname(import.meta.dir);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const USER_NAME = process.env.USER_NAME || "You";
const COPARENT_NAME = process.env.COPARENT_NAME || "Co-parent";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );
    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// DATA FETCHERS
// ============================================================

async function getRecentAgreements(supabase: SupabaseClient | null): Promise<string> {
  if (!supabase) return "";

  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data, error } = await supabase
      .from("memory")
      .select("content, created_at")
      .eq("type", "agreement")
      .gte("created_at", sevenDaysAgo.toISOString())
      .order("created_at", { ascending: false })
      .limit(5);

    if (error || !data?.length) return "";

    return data
      .map((a) => {
        const date = new Date(a.created_at).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
        return `- ${a.content} _(${date})_`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

async function getActiveGoals(supabase: SupabaseClient | null): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase.rpc("get_active_goals");
    if (error || !data?.length) return "";

    return data
      .map((g: any) => {
        const deadline = g.deadline
          ? ` _(by ${new Date(g.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric" })})_`
          : "";
        return `- ${g.content}${deadline}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

async function getWeekendIdeas(supabase: SupabaseClient | null): Promise<string> {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun ... 6=Sat

  // Only generate on Thursday (4) and Friday (5), before user weekends
  if (dow !== 4 && dow !== 5) return "";

  // Check if the upcoming weekend is the user's
  const friday = new Date(now);
  friday.setDate(friday.getDate() + (5 - dow));
  if (!isUserWeekend(friday)) return "";

  // Load profile for age-appropriate suggestions
  let profileContext = "";
  try {
    profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
  } catch {
    // No profile
  }

  try {
    const claudePath = process.env.CLAUDE_PATH || "claude";
    const prompt = `You are a co-parenting assistant. Suggest 3 brief weekend activity ideas for a parent spending the weekend with their children. Keep suggestions short (one line each), age-appropriate, and seasonal for ${now.toLocaleDateString("en-US", { month: "long" })}.${profileContext ? `\n\nContext:\n${profileContext}` : ""}\n\nRespond with just the 3 ideas as bullet points, nothing else.`;

    const proc = spawn([claudePath, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode === 0 && output.trim()) {
      return output.trim();
    }
  } catch {
    // Claude CLI not available
  }

  return "";
}

// ============================================================
// BUILD BRIEFING
// ============================================================

async function buildBriefing(supabase: SupabaseClient | null): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sections: string[] = [];

  // Header
  sections.push(`*Good Morning, ${USER_NAME}!*\n${dateStr}\n`);

  // Custody today
  try {
    const status = getCustodyStatus(now);
    const who = status === "user" ? USER_NAME : COPARENT_NAME;
    const transition = getNextTransition(now);
    sections.push(`*Today:* Children are with ${who}\n${transition.description}\n`);
  } catch {
    // No schedule configured
  }

  // School today
  try {
    const schoolInfo = getSchoolSchedule(now);
    if (schoolInfo && schoolInfo.type !== "not_in_session") {
      const child = schoolInfo.child || "Child";
      switch (schoolInfo.type) {
        case "regular":
          sections.push(`*School:* ${child} — regular day (${formatTime(schoolInfo.startTime!)}\u2013${formatTime(schoolInfo.endTime!)})\n`);
          break;
        case "early_release":
          sections.push(`*School:* ${child} — early release (${formatTime(schoolInfo.startTime!)}\u2013${formatTime(schoolInfo.endTime!)})${schoolInfo.eventName ? ` \u2014 ${schoolInfo.eventName}` : ""}\n`);
          break;
        case "no_school":
          sections.push(`*School:* No school for ${child}${schoolInfo.eventName ? ` \u2014 ${schoolInfo.eventName}` : ""}\n`);
          break;
      }

      const upcoming = getUpcomingSchoolEvents(now, 7);
      const future = upcoming.filter((e) => e.daysUntil > 0 && e.type !== "milestone");
      if (future.length > 0) {
        const lines = future.map((e) => {
          const when = e.daysUntil === 1 ? "tomorrow" : `in ${e.daysUntil} days`;
          return `- ${e.name} ${when}`;
        });
        sections.push(`*School This Week:*\n${lines.join("\n")}\n`);
      }
    }
  } catch {
    // No school calendar configured
  }

  // This week
  try {
    const weekSummary = getWeekSummary(now);
    sections.push(`*This Week:*\n${weekSummary}\n`);
  } catch {
    // No schedule configured
  }

  // Upcoming holidays
  try {
    const holidays = getUpcomingHolidays(now, 30);
    if (holidays.length > 0) {
      const lines = holidays.map((h) => {
        const daysUntil = Math.round(
          (h.date.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000
        );
        const whose = h.parent === "user" ? "your" : `${COPARENT_NAME}'s`;
        return `- ${h.name} in ${daysUntil} days — ${whose} year`;
      });
      sections.push(`*Upcoming Holidays:*\n${lines.join("\n")}\n`);
    }
  } catch {
    // No schedule configured
  }

  // Recent agreements
  const agreements = await getRecentAgreements(supabase);
  if (agreements) {
    sections.push(`*Recent Agreements (7 days):*\n${agreements}\n`);
  }

  // Active goals
  const goals = await getActiveGoals(supabase);
  if (goals) {
    sections.push(`*Active Goals:*\n${goals}\n`);
  }

  // Weekend ideas (Thu/Fri only, before user weekends)
  const ideas = await getWeekendIdeas(supabase);
  if (ideas) {
    sections.push(`*Weekend Ideas:*\n${ideas}\n`);
  }

  return sections.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building morning briefing...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const supabase =
    process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
      : null;

  const briefing = await buildBriefing(supabase);

  console.log("Sending briefing...");
  const success = await sendTelegram(briefing);

  if (success) {
    console.log("Briefing sent!");
  } else {
    console.error("Failed to send briefing");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Briefing error:", err.message);
  process.exit(1);
});
