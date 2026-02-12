/**
 * Document Ingestion System
 *
 * Extracts text from PDFs, chunks it for semantic search, and stores
 * chunks in the Supabase memory table. Used for divorce decrees and
 * other legal documents.
 *
 * Requires: poppler (brew install poppler) for pdftotext
 */

import { spawn } from "bun";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Extract text from a PDF using pdftotext (poppler).
 * Falls back to a helpful error message if poppler isn't installed.
 */
export async function extractPdfText(pdfPath: string): Promise<string> {
  const proc = spawn(["pdftotext", "-nodiag", pdfPath, "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const text = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    if (stderr.includes("not found") || exitCode === 127) {
      throw new Error(
        "pdftotext not found. Install poppler:\n  macOS: brew install poppler\n  Linux: apt install poppler-utils"
      );
    }
    throw new Error(`pdftotext failed: ${stderr}`);
  }

  return cleanExtractedText(text.trim());
}

/**
 * Remove noise from PDF extraction: standalone page numbers,
 * stray 1-2 character fragments, and excessive blank lines.
 */
export function cleanExtractedText(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (/^\d{1,3}$/.test(trimmed)) return false;
      if (trimmed.length > 0 && trimmed.length <= 2 && !/\d/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

/**
 * Split text into overlapping chunks on paragraph boundaries.
 * Targets ~3000 characters per chunk with ~750 character overlap.
 */
export function chunkText(
  text: string,
  maxChars: number = 3000,
  overlap: number = 750
): string[] {
  // Split on double-newlines (paragraph boundaries)
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();

    if (current.length + trimmed.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());

      // Start next chunk with overlap from end of current chunk
      if (overlap > 0) {
        const overlapStart = Math.max(0, current.length - overlap);
        current = current.slice(overlapStart).trim() + "\n\n" + trimmed;
      } else {
        current = trimmed;
      }
    } else {
      current = current ? current + "\n\n" + trimmed : trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Ingest a document into Supabase memory table.
 * Clears old chunks for this source before inserting new ones.
 */
export async function ingestDocument(
  supabase: SupabaseClient,
  text: string,
  type: "decree" | "legal" | "reference",
  source: string
): Promise<number> {
  // Delete existing chunks for this source
  await supabase.from("memory").delete().eq("type", type).eq("source", source);

  // Chunk and insert
  const chunks = chunkText(text);

  for (let i = 0; i < chunks.length; i++) {
    const { error } = await supabase.from("memory").insert({
      type,
      content: chunks[i],
      source,
      metadata: { chunk: i + 1, total: chunks.length },
    });

    if (error) {
      console.error(`Error inserting chunk ${i + 1}:`, error.message);
    }
  }

  return chunks.length;
}
