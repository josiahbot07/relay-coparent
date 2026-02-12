/**
 * Utah Code Fetcher
 *
 * Fetches Utah family law statutes (Title 81, Chapter 9) from le.utah.gov,
 * caches them locally, and stores chunks in Supabase for semantic search.
 *
 * Target statutes:
 * - § 81-9-302: Minimum parent-time schedule (5-18) + holidays
 * - § 81-9-303: Advisory guidelines
 * - § 81-9-304: Parent-time under 5
 * - § 81-9-305: Equal parent-time
 *
 * Usage: bun run fetch:legal
 */

import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ingestDocument } from "./documents.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const LEGAL_DIR = join(PROJECT_ROOT, "config", "legal");

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// Target statutes
const STATUTES = [
  { section: "302", topic: "Minimum parent-time schedule (5-18) and holidays" },
  { section: "303", topic: "Advisory guidelines" },
  { section: "304", topic: "Parent-time for children under 5" },
  { section: "305", topic: "Equal parent-time" },
];

/**
 * Fetch a statute from le.utah.gov and extract the text content.
 */
async function fetchStatute(section: string): Promise<string> {
  const url = `https://le.utah.gov/xcode/Title81/Chapter9/81-9-S${section}.html`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching § 81-9-${section}`);
  }

  const html = await response.text();

  // Extract statute text — strip HTML tags, nav, and chrome
  let text = html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Remove nav/header/footer if present
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // Try to extract just the main content area
  const mainMatch = text.match(/<div[^>]*class="[^"]*statute[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
    text.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  if (mainMatch) {
    text = mainMatch[1];
  }

  // Convert HTML to readable text
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "") // Strip remaining tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n") // Collapse excessive newlines
    .trim();

  return text;
}

/**
 * Fetch all target statutes, cache locally, and store in Supabase.
 */
async function fetchAllStatutes(supabase: SupabaseClient | null): Promise<void> {
  await mkdir(LEGAL_DIR, { recursive: true });

  let totalChunks = 0;

  for (const statute of STATUTES) {
    const source = `utah-81-9-${statute.section}`;
    const cachePath = join(LEGAL_DIR, `${source}.md`);

    console.log(`  Fetching § 81-9-${statute.section}: ${statute.topic}...`);

    try {
      const text = await fetchStatute(statute.section);

      if (!text || text.length < 100) {
        console.log(`  ${red("!")} § 81-9-${statute.section}: insufficient content extracted`);
        continue;
      }

      // Add header and cache locally
      const content = `# Utah Code § 81-9-${statute.section}\n## ${statute.topic}\n\n${text}`;
      await writeFile(cachePath, content);
      console.log(`  ${green("✓")} Cached: ${cachePath}`);

      // Store in Supabase if available
      if (supabase) {
        const chunkCount = await ingestDocument(supabase, content, "legal", source);
        totalChunks += chunkCount;
        console.log(`  ${green("✓")} Stored ${chunkCount} chunks in Supabase`);
      }
    } catch (error: any) {
      console.log(`  ${red("✗")} § 81-9-${statute.section}: ${error.message}`);
    }
  }

  if (supabase && totalChunks > 0) {
    console.log(`\n  ${green("Total:")} ${totalChunks} chunks stored in Supabase`);
  }
}

// ============================================================
// MAIN
// ============================================================

if (import.meta.main) {
  console.log("");
  console.log(bold("  Utah Family Law Code Fetcher"));
  console.log("");

  const supabase =
    process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
      : null;

  if (!supabase) {
    console.log(`  ${dim("No Supabase configured — caching locally only")}`);
  }

  await fetchAllStatutes(supabase);

  console.log("");
  console.log(`  ${green("Done!")} Statutes cached in config/legal/`);
  if (supabase) {
    console.log(`  ${dim("Embeddings will be generated automatically by the database webhook.")}`);
  }
  console.log("");
}

export { fetchAllStatutes, fetchStatute, STATUTES };
