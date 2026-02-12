/**
 * Ingest the Children's Guidebook PDF into Supabase memory.
 *
 * Usage: bun run scripts/ingest-guidebook.ts
 *
 * Extracts text, chunks it, and stores with type: "reference".
 * Supabase webhook generates embeddings automatically.
 */

import { createClient } from "@supabase/supabase-js";
import { extractPdfText, ingestDocument } from "../src/documents.ts";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const PDF_PATH = join(PROJECT_ROOT, "config", "documents", "childrens-guidebook.pdf");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log("Extracting text from Children's Guidebook PDF...");
const text = await extractPdfText(PDF_PATH);
console.log(`Extracted ${text.length} characters`);

// Preview first 200 chars
console.log(`Preview: ${text.substring(0, 200)}...`);

console.log("\nIngesting into Supabase memory table (type: reference)...");
const chunkCount = await ingestDocument(supabase, text, "reference", "childrens-guidebook.pdf");

console.log(`\nDone! Stored ${chunkCount} chunks.`);
console.log("Supabase webhook will generate embeddings automatically.");
