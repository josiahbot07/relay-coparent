/**
 * Fetch Utah Code — Wrapper Script
 *
 * Fetches Utah family law statutes, caches locally, stores in Supabase.
 * This is a thin wrapper that imports and runs the legal fetcher.
 *
 * Usage: bun run fetch:legal
 * Schedule: monthly via launchd (com.claude.coparent-legal-refresh)
 */

import "../src/legal-fetcher.ts";
