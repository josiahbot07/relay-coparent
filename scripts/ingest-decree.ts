/**
 * Ingest Divorce Decree
 *
 * One-time script: extracts text from a decree PDF, chunks it for
 * semantic search, stores in Supabase, and generates a structured
 * summary via Claude CLI.
 *
 * Usage: bun run ingest:decree config/documents/decree.pdf
 */

import { existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { join, basename, dirname } from "path";
import { spawn } from "bun";
import { createClient } from "@supabase/supabase-js";
import { extractPdfText, ingestDocument } from "../src/documents.ts";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

async function main() {
  const pdfPath = process.argv[2];

  if (!pdfPath) {
    console.error(`\n  ${red("Usage:")} bun run ingest:decree <path-to-decree.pdf>`);
    console.error(`  ${dim("Example: bun run ingest:decree config/documents/decree.pdf")}\n`);
    process.exit(1);
  }

  if (!existsSync(pdfPath)) {
    console.error(`\n  ${red("File not found:")} ${pdfPath}\n`);
    process.exit(1);
  }

  // Check Supabase config
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error(`\n  ${red("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env")}\n`);
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  console.log("");
  console.log(bold("  Divorce Decree Ingestion"));
  console.log("");

  // Step 1: Extract text
  console.log(`  Extracting text from ${basename(pdfPath)}...`);
  const text = await extractPdfText(pdfPath);
  console.log(`  ${green("✓")} Extracted ${text.length} characters`);

  // Step 2: Chunk and store in Supabase
  console.log("  Chunking and storing in Supabase...");
  const source = basename(pdfPath);
  const chunkCount = await ingestDocument(supabase, text, "decree", source);
  console.log(`  ${green("✓")} Stored ${chunkCount} chunks in memory table`);

  // Step 3: Generate structured summary via Claude CLI
  console.log("  Generating decree summary via Claude...");
  const summaryPrompt = `You are a legal document analyst. Read the following divorce decree text and extract a structured summary. Focus on:

1. **Custody arrangement** — physical and legal custody type (joint/sole)
2. **Parent-time schedule** — regular weekday and weekend schedule
3. **Holiday schedule** — which holidays each parent gets, rotation rules
4. **Decision-making** — who decides on education, healthcare, religion, extracurriculars
5. **Relocation** — any restrictions on moving
6. **Right of first refusal** — threshold (e.g., 4+ hours) and rules
7. **Communication** — required methods, response times
8. **Child support** — general terms (no dollar amounts needed)
9. **Other notable provisions** — anything unusual or important

Format the output as a clean markdown document. Use headers and bullet points.
Be concise but complete — this summary will be loaded into every AI prompt.

DECREE TEXT:
${text.substring(0, 30000)}`;

  try {
    const claudePath = process.env.CLAUDE_PATH || "claude";
    const proc = spawn([claudePath, "-p", summaryPrompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
    });

    const summary = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode === 0 && summary.trim()) {
      const summaryPath = join(PROJECT_ROOT, "config", "decree-summary.md");
      await writeFile(summaryPath, summary.trim());
      console.log(`  ${green("✓")} Summary written to config/decree-summary.md`);
    } else {
      console.log(`  ${red("!")} Claude summary generation failed — you can write config/decree-summary.md manually`);
    }
  } catch {
    console.log(`  ${red("!")} Claude CLI not available — write config/decree-summary.md manually`);
  }

  // Step 4: Ensure documents directory exists
  const docsDir = join(PROJECT_ROOT, "config", "documents");
  await mkdir(docsDir, { recursive: true });

  console.log("");
  console.log(`  ${green("Done!")} Ingested ${chunkCount} chunks from ${basename(pdfPath)}`);
  console.log(`  ${dim("Embeddings will be generated automatically by the database webhook.")}`);
  console.log(`  ${dim("Summary loaded at startup via config/decree-summary.md")}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}\n`);
  process.exit(1);
});
