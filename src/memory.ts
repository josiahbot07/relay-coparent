/**
 * Memory Module
 *
 * Persistent facts, goals, and preferences stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * The relay parses these tags, saves to Supabase, and strips them
 * from the response before sending to the user.
 *
 * Co-parenting addition:
 *   [AGREEMENT: description of what was agreed upon]
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    await supabase.from("memory").insert({
      type: "fact",
      content: match[1],
    });
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    await supabase.from("memory").insert({
      type: "goal",
      content: match[1],
      deadline: match[2] || null,
    });
    clean = clean.replace(match[0], "");
  }

  // [AGREEMENT: description of what was agreed upon]
  for (const match of response.matchAll(/\[AGREEMENT:\s*(.+?)\]/gi)) {
    await supabase.from("memory").insert({
      type: "agreement",
      content: match[1],
    });
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const { data } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "goal")
      .ilike("content", `%${match[1]}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("memory")
        .update({
          type: "completed_goal",
          completed_at: new Date().toISOString(),
        })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/**
 * Get all recorded co-parenting agreements.
 */
export async function getAgreements(
  supabase: SupabaseClient | null
): Promise<{ id: string; content: string; created_at: string }[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase.rpc("get_agreements");
    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

/**
 * Get all facts, active goals, and agreements for prompt context.
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null
): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult, agreements] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
      getAgreements(supabase),
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: any) => `- ${f.content}`).join("\n")
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
    }

    if (agreements.length) {
      parts.push(
        "CO-PARENTING AGREEMENTS:\n" +
          agreements
            .map((a) => `- ${a.content} (${new Date(a.created_at).toLocaleDateString()})`)
            .join("\n")
      );
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

/**
 * Semantic search for relevant past messages and memory entries via the
 * search Edge Function. Searches both tables in parallel.
 * The Edge Function handles embedding generation (OpenAI key stays in Supabase).
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string
): Promise<string> {
  if (!supabase) return "";

  try {
    const [msgResult, memResult, exchResult] = await Promise.all([
      supabase.functions.invoke("search", {
        body: { query, match_count: 5, table: "messages" },
      }),
      supabase.functions.invoke("search", {
        body: { query, match_count: 3, table: "memory" },
      }),
      supabase.functions.invoke("search", {
        body: { query, match_count: 3, table: "daily_transcripts" },
      }),
    ]);

    const parts: string[] = [];

    // Past messages — use sender if available, fall back to role
    if (!msgResult.error && msgResult.data?.length) {
      parts.push(
        "RELEVANT PAST MESSAGES:\n" +
          msgResult.data.map((m: any) => `[${m.sender || m.role}]: ${m.content}`).join("\n")
      );
    }

    // Daily transcript results (compacted iMessage exchanges)
    if (!exchResult.error && exchResult.data?.length) {
      parts.push(
        "RELEVANT PAST EXCHANGES (iMessage):\n" +
          exchResult.data.map((e: any) => `--- ${e.date} (${e.message_count} messages) ---\n${e.transcript}`).join("\n\n")
      );
    }

    // Memory entries — format by type
    if (!memResult.error && memResult.data?.length) {
      const decree = memResult.data.filter((m: any) => m.type === "decree");
      const legal = memResult.data.filter((m: any) => m.type === "legal");
      const reference = memResult.data.filter((m: any) => m.type === "reference");
      const other = memResult.data.filter(
        (m: any) => m.type !== "decree" && m.type !== "legal" && m.type !== "reference"
      );

      if (decree.length) {
        parts.push(
          "RELEVANT DECREE SECTIONS:\n" +
            decree.map((m: any) => m.content).join("\n---\n")
        );
      }

      if (legal.length) {
        parts.push(
          "RELEVANT UTAH LAW:\n" +
            legal.map((m: any) => m.content).join("\n---\n")
        );
      }

      if (reference.length) {
        parts.push(
          "RELEVANT REFERENCE MATERIAL:\n" +
            reference.map((m: any) => m.content).join("\n---\n")
        );
      }

      if (other.length) {
        parts.push(
          "RELEVANT MEMORY:\n" +
            other.map((m: any) => `[${m.type}]: ${m.content}`).join("\n")
        );
      }
    }

    return parts.join("\n\n");
  } catch {
    // Search not available yet (Edge Functions not deployed) — that's fine
    return "";
  }
}
