/**
 * Custody Schedule Engine
 *
 * Pure TypeScript module — no external dependencies, no network calls.
 * Computes custody status, transitions, and holiday assignments based on
 * config/schedule.json and Utah Code § 81-9-302 even/odd year rotation.
 *
 * Run standalone for a quick status check: bun run src/schedule.ts
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// ============================================================
// TYPES
// ============================================================

interface ScheduleConfig {
  weekdayOvernight: {
    parent: "user" | "coparent";
    pickupDay: string;
    dropoffDay: string;
  };
  alternatingWeekends: {
    referenceDate: string; // ISO date of a known user weekend Friday
    pickupDay: string;
    pickupTime: string;
    dropoffDay: string;
    dropoffTime: string;
  };
  holidays: {
    evenYearUser: string[];
    oddYearUser: string[];
    alwaysUser: string[];
    alwaysCoparent: string[];
  };
}

export interface CustodyTransition {
  date: Date;
  description: string;
}

export interface HolidayAssignment {
  name: string;
  date: Date;
  parent: "user" | "coparent";
}

// School calendar types
interface SchoolCalendarConfig {
  school: {
    name: string;
    shortName: string;
    year: string;
    child: string;
  };
  schedule: {
    regularStart: string;
    regularEnd: string;
    earlyOutStart: string;
    earlyOutEnd: string;
    earlyOutDays: string[];
  };
  terms: { name: string; start: string; end: string }[];
  events: {
    date: string;
    endDate?: string;
    type: "no_school" | "early_release" | "milestone";
    name: string;
  }[];
}

export interface SchoolDayInfo {
  type: "regular" | "early_release" | "no_school" | "not_in_session";
  startTime?: string;
  endTime?: string;
  eventName?: string;
  term?: string;
  child?: string;
  schoolName?: string;
}

export interface SchoolEvent {
  name: string;
  date: Date;
  endDate?: Date;
  type: "no_school" | "early_release" | "milestone";
  daysUntil: number;
}

// ============================================================
// DAY HELPERS
// ============================================================

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function dayIndex(name: string): number {
  const idx = DAYS.indexOf(name.toLowerCase());
  if (idx === -1) throw new Error(`Invalid day name: ${name}`);
  return idx;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}

/** Parse "YYYY-MM-DD" as a local date (avoids UTC midnight shift). */
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function diffDays(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Convert "HH:MM" (24h) to "H:MM AM/PM" (12h). */
export function formatTime(time24: string): string {
  const [h, m] = time24.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

// ============================================================
// FLOATING HOLIDAY COMPUTATION (Utah)
// ============================================================

/** Get the Nth occurrence of a given weekday in a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  let dayOfWeek = first.getDay();
  let date = 1 + ((weekday - dayOfWeek + 7) % 7) + (n - 1) * 7;
  return new Date(year, month, date);
}

/** Last occurrence of a weekday in a month. */
function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(year, month + 1, 0); // last day of month
  const diff = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month, last.getDate() - diff);
}

export function getUtahHolidayDates(year: number): Record<string, Date> {
  return {
    "New Year's Day": new Date(year, 0, 1),
    "MLK Day": nthWeekday(year, 0, 1, 3), // 3rd Monday of January
    "Presidents Day": nthWeekday(year, 1, 1, 3), // 3rd Monday of February
    "Spring Break": (() => {
      // Approximate: typically the week containing the 3rd Monday of March
      // User should override in schedule.json if their district differs
      return nthWeekday(year, 2, 1, 3);
    })(),
    "Memorial Day": lastWeekday(year, 4, 1), // Last Monday of May
    "Father's Day": nthWeekday(year, 5, 0, 3), // 3rd Sunday of June
    "Mother's Day": nthWeekday(year, 4, 0, 2), // 2nd Sunday of May
    "July 4th": new Date(year, 6, 4),
    "Pioneer Day": new Date(year, 6, 24),
    "Labor Day": nthWeekday(year, 8, 1, 1), // 1st Monday of September
    "Fall Break": (() => {
      // Utah fall break is typically the 3rd week of October
      // Approximate: 3rd Thursday of October
      return nthWeekday(year, 9, 4, 3);
    })(),
    "Thanksgiving": nthWeekday(year, 10, 4, 4), // 4th Thursday of November
    "Christmas 1st half": new Date(year, 11, 24), // Dec 24
    "Christmas 2nd half": new Date(year, 11, 26), // Dec 26
  };
}

// ============================================================
// LOAD CONFIG
// ============================================================

let config: ScheduleConfig | null = null;

function loadConfig(): ScheduleConfig {
  if (config) return config;

  const configPath = join(PROJECT_ROOT, "config", "schedule.json");
  if (!existsSync(configPath)) {
    throw new Error(
      "config/schedule.json not found. Copy config/schedule.example.json and customize it."
    );
  }

  config = JSON.parse(readFileSync(configPath, "utf-8")) as ScheduleConfig;
  return config;
}

/** Reload config from disk (useful after edits). */
export function reloadConfig(): void {
  config = null;
  schoolCalConfig = null;
  loadConfig();
}

// ============================================================
// SCHOOL CALENDAR LOADER
// ============================================================

let schoolCalConfig: SchoolCalendarConfig | null | undefined = undefined; // undefined = not loaded, null = not found

function loadSchoolCalendar(): SchoolCalendarConfig | null {
  if (schoolCalConfig !== undefined) return schoolCalConfig;

  const calPath = join(PROJECT_ROOT, "config", "school-calendar.json");
  if (!existsSync(calPath)) {
    schoolCalConfig = null;
    return null;
  }

  schoolCalConfig = JSON.parse(readFileSync(calPath, "utf-8")) as SchoolCalendarConfig;
  return schoolCalConfig;
}

// ============================================================
// SCHOOL CALENDAR HELPERS
// ============================================================

function isWithinSchoolYear(date: Date, cal: SchoolCalendarConfig): boolean {
  const d = startOfDay(date);
  const firstTermStart = parseLocalDate(cal.terms[0].start);
  const lastTermEnd = parseLocalDate(cal.terms[cal.terms.length - 1].end);
  return d >= firstTermStart && d <= lastTermEnd;
}

function getCurrentTerm(date: Date, cal: SchoolCalendarConfig): string | undefined {
  const d = startOfDay(date);
  for (const term of cal.terms) {
    const start = parseLocalDate(term.start);
    const end = parseLocalDate(term.end);
    if (d >= start && d <= end) return term.name;
  }
  return undefined;
}

function getEventsForDate(
  date: Date,
  cal: SchoolCalendarConfig
): SchoolCalendarConfig["events"] {
  const d = startOfDay(date);
  return cal.events.filter((event) => {
    const eventStart = parseLocalDate(event.date);
    if (event.endDate) {
      const eventEnd = parseLocalDate(event.endDate);
      return d >= eventStart && d <= eventEnd;
    }
    return d.getTime() === eventStart.getTime();
  });
}

// ============================================================
// SCHOOL CALENDAR PUBLIC API
// ============================================================

/**
 * Get school schedule info for a given date.
 * Priority: outside school year → weekend → no_school event → early_release event → Friday early out → regular day
 */
export function getSchoolSchedule(date?: Date): SchoolDayInfo | null {
  const cal = loadSchoolCalendar();
  if (!cal) return null;

  const d = startOfDay(date || new Date());

  const base = { child: cal.school.child, schoolName: cal.school.shortName };

  // Outside school year
  if (!isWithinSchoolYear(d, cal)) {
    return { type: "not_in_session", ...base };
  }

  const term = getCurrentTerm(d, cal);

  // Weekend
  const dow = d.getDay();
  if (dow === 0 || dow === 6) {
    return { type: "not_in_session", term, ...base };
  }

  // Check events for this date
  const events = getEventsForDate(d, cal);
  const noSchool = events.find((e) => e.type === "no_school");
  if (noSchool) {
    return { type: "no_school", eventName: noSchool.name, term, ...base };
  }

  const earlyRelease = events.find((e) => e.type === "early_release");
  if (earlyRelease) {
    return {
      type: "early_release",
      startTime: cal.schedule.earlyOutStart,
      endTime: cal.schedule.earlyOutEnd,
      eventName: earlyRelease.name,
      term,
      ...base,
    };
  }

  // Friday early out (weekly)
  const dayName = DAYS[dow];
  if (cal.schedule.earlyOutDays.includes(dayName)) {
    return {
      type: "early_release",
      startTime: cal.schedule.earlyOutStart,
      endTime: cal.schedule.earlyOutEnd,
      eventName: "Weekly early release",
      term,
      ...base,
    };
  }

  // Regular school day
  return {
    type: "regular",
    startTime: cal.schedule.regularStart,
    endTime: cal.schedule.regularEnd,
    term,
    ...base,
  };
}

/**
 * Get upcoming school events within N days.
 */
export function getUpcomingSchoolEvents(date?: Date, daysAhead: number = 14): SchoolEvent[] {
  const cal = loadSchoolCalendar();
  if (!cal) return [];

  const d = startOfDay(date || new Date());
  const results: SchoolEvent[] = [];
  const seen = new Set<string>(); // dedupe by name+date

  for (const event of cal.events) {
    const eventDate = parseLocalDate(event.date);
    const eventEnd = event.endDate ? parseLocalDate(event.endDate) : undefined;

    // Use the start date for "days until" calculation
    const daysUntil = diffDays(eventDate, d);

    // Include events that start within the window, or are currently ongoing
    const startsInWindow = daysUntil >= 0 && daysUntil <= daysAhead;
    const isOngoing = eventEnd && diffDays(d, eventDate) >= 0 && diffDays(eventEnd, d) >= 0;

    if (!startsInWindow && !isOngoing) continue;

    const key = `${event.name}:${event.date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      name: event.name,
      date: eventDate,
      endDate: eventEnd,
      type: event.type,
      daysUntil: Math.max(0, daysUntil),
    });
  }

  results.sort((a, b) => a.date.getTime() - b.date.getTime());
  return results;
}

/**
 * Convenience: is the given date a school day?
 */
export function isSchoolDay(date?: Date): boolean {
  const info = getSchoolSchedule(date);
  if (!info) return false;
  return info.type === "regular" || info.type === "early_release";
}

/**
 * Build school context string for prompt injection.
 */
function getSchoolContext(date: Date): string {
  const info = getSchoolSchedule(date);
  if (!info) return "";

  const parts: string[] = [];
  const child = info.child || "Child";
  const school = info.schoolName || "school";

  switch (info.type) {
    case "regular":
      parts.push(`SCHOOL TODAY: ${child} has school at ${school} (${formatTime(info.startTime!)}\u2013${formatTime(info.endTime!)}).`);
      break;
    case "early_release":
      parts.push(
        `SCHOOL TODAY: ${child} has early release at ${school} (${formatTime(info.startTime!)}\u2013${formatTime(info.endTime!)})${info.eventName ? ` \u2014 ${info.eventName}` : ""}.`
      );
      break;
    case "no_school":
      parts.push(
        `SCHOOL TODAY: No school for ${child}${info.eventName ? ` \u2014 ${info.eventName}` : ""}.`
      );
      break;
    case "not_in_session":
      // Don't add noise if school isn't in session (summer, weekends)
      break;
  }

  const upcoming = getUpcomingSchoolEvents(date, 14);
  // Filter out milestones and events happening today (already covered above)
  const future = upcoming.filter((e) => e.daysUntil > 0 && e.type !== "milestone");
  if (future.length > 0) {
    const lines = future.map((e) => {
      const when = e.daysUntil === 1 ? "tomorrow" : `in ${e.daysUntil} days`;
      const dayLabel = formatDate(e.date);
      return `- ${e.name} ${when} (${dayLabel})`;
    });
    parts.push("UPCOMING SCHOOL EVENTS:\n" + lines.join("\n"));
  }

  return parts.join("\n");
}

// ============================================================
// CORE LOGIC
// ============================================================

/**
 * Is the given date on a "user weekend"?
 * Counts weeks from the referenceDate (which should be a Friday the user has the kids).
 */
export function isUserWeekend(date: Date): boolean {
  const cfg = loadConfig();
  const ref = startOfDay(new Date(cfg.alternatingWeekends.referenceDate));
  const target = startOfDay(date);

  const days = diffDays(target, ref);
  const weeks = Math.floor(days / 7);

  // Even week offset from reference = user weekend, odd = coparent weekend
  return weeks % 2 === 0;
}

/**
 * Who has the children on the given date?
 * Logic:
 * 1. Check if it's a holiday — holidays override regular schedule
 * 2. Check if it's a weekend day (Fri evening → Sun evening)
 * 3. Check if it's the weekday overnight (e.g., Wed night → Thu morning)
 * 4. Otherwise: coparent has them (default non-custodial time)
 */
export function getCustodyStatus(date: Date): "user" | "coparent" {
  const cfg = loadConfig();
  const d = startOfDay(date);

  // Check holidays first
  const holidays = getHolidayAssignmentsForDate(d);
  if (holidays.length > 0) {
    return holidays[0].parent;
  }

  const dow = d.getDay(); // 0=Sun, 6=Sat
  const pickupDow = dayIndex(cfg.alternatingWeekends.pickupDay);
  const dropoffDow = dayIndex(cfg.alternatingWeekends.dropoffDay);

  // Weekend check: pickup day through dropoff day (handles week wrapping, e.g. Fri→Mon)
  function isDayInRange(d: number, start: number, end: number): boolean {
    if (start <= end) return d >= start && d <= end;
    return d >= start || d <= end; // wraps around Saturday→Sunday
  }
  const isWeekendDay = isDayInRange(dow, pickupDow, dropoffDow);

  if (isWeekendDay) {
    return isUserWeekend(d) ? "user" : "coparent";
  }

  // Weekday overnight check
  const overnightPickup = dayIndex(cfg.weekdayOvernight.pickupDay);
  const overnightDropoff = dayIndex(cfg.weekdayOvernight.dropoffDay);

  if (dow === overnightPickup || dow === overnightDropoff) {
    // On pickup day: user has them from after school/pickup
    // On dropoff day: user has them until school/dropoff
    return cfg.weekdayOvernight.parent;
  }

  // Default: coparent has them
  return cfg.weekdayOvernight.parent === "user" ? "coparent" : "user";
}

/**
 * Get the next custody transition from the given date.
 */
export function getNextTransition(date: Date): CustodyTransition {
  const cfg = loadConfig();
  const current = getCustodyStatus(date);

  // Look ahead up to 14 days
  for (let i = 1; i <= 14; i++) {
    const next = addDays(date, i);
    const nextStatus = getCustodyStatus(next);

    if (nextStatus !== current) {
      const desc =
        nextStatus === "user"
          ? `Children come to you (${formatDate(next)})`
          : `Children go to ${process.env.COPARENT_NAME || "co-parent"} (${formatDate(next)})`;
      return { date: next, description: desc };
    }
  }

  // Fallback: next weekend transition
  const pickupDow = dayIndex(cfg.alternatingWeekends.pickupDay);
  const daysUntilFriday = ((pickupDow - date.getDay() + 7) % 7) || 7;
  const nextFriday = addDays(date, daysUntilFriday);

  return {
    date: nextFriday,
    description: `Next weekend: ${formatDate(nextFriday)}`,
  };
}

/**
 * Get holiday assignments for a specific date.
 */
function getHolidayAssignmentsForDate(date: Date): HolidayAssignment[] {
  const cfg = loadConfig();
  const year = date.getFullYear();
  const holidays = getUtahHolidayDates(year);
  const results: HolidayAssignment[] = [];

  for (const [name, holidayDate] of Object.entries(holidays)) {
    if (diffDays(date, holidayDate) !== 0) continue;

    let parent: "user" | "coparent";

    if (cfg.holidays.alwaysUser.includes(name)) {
      parent = "user";
    } else if (cfg.holidays.alwaysCoparent.includes(name)) {
      parent = "coparent";
    } else if (year % 2 === 0) {
      parent = cfg.holidays.evenYearUser.includes(name) ? "user" : "coparent";
    } else {
      parent = cfg.holidays.oddYearUser.includes(name) ? "user" : "coparent";
    }

    results.push({ name, date: holidayDate, parent });
  }

  return results;
}

/**
 * Get upcoming holidays within N days from the given date.
 */
export function getUpcomingHolidays(date: Date, daysAhead: number = 30): HolidayAssignment[] {
  const cfg = loadConfig();
  const d = startOfDay(date);
  const results: HolidayAssignment[] = [];

  // Check current year and next year (for year boundaries)
  for (const year of [date.getFullYear(), date.getFullYear() + 1]) {
    const holidays = getUtahHolidayDates(year);

    for (const [name, holidayDate] of Object.entries(holidays)) {
      const diff = diffDays(holidayDate, d);
      if (diff < 0 || diff > daysAhead) continue;

      let parent: "user" | "coparent";
      if (cfg.holidays.alwaysUser.includes(name)) {
        parent = "user";
      } else if (cfg.holidays.alwaysCoparent.includes(name)) {
        parent = "coparent";
      } else if (year % 2 === 0) {
        parent = cfg.holidays.evenYearUser.includes(name) ? "user" : "coparent";
      } else {
        parent = cfg.holidays.oddYearUser.includes(name) ? "user" : "coparent";
      }

      results.push({ name, date: holidayDate, parent });
    }
  }

  // Sort by date
  results.sort((a, b) => a.date.getTime() - b.date.getTime());
  return results;
}

/**
 * Get a week summary: who has the children each day.
 */
export function getWeekSummary(date: Date): string {
  const cfg = loadConfig();
  const userName = process.env.USER_NAME || "You";
  const coparentName = process.env.COPARENT_NAME || "Co-parent";
  const lines: string[] = [];

  for (let i = 0; i < 7; i++) {
    const d = addDays(date, i);
    const status = getCustodyStatus(d);
    const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
    const who = status === "user" ? userName : coparentName;

    // Detect transitions for pickup/drop-off annotations
    const prevStatus = getCustodyStatus(addDays(date, i - 1));
    const nextStatus = getCustodyStatus(addDays(date, i + 1));

    let note = "";
    if (status !== prevStatus) {
      note = " (pickup)";
    } else if (status !== nextStatus) {
      note = " (drop-off)";
    }

    lines.push(`${dayName}: ${who}${note}`);
  }

  return lines.join("\n");
}

/**
 * Build a context string for prompt injection.
 */
export function getScheduleContext(date?: Date): string {
  try {
    loadConfig();
  } catch {
    return ""; // No schedule configured
  }

  const now = date || new Date();
  const status = getCustodyStatus(now);
  const userName = process.env.USER_NAME || "you";
  const coparentName = process.env.COPARENT_NAME || "co-parent";
  const who = status === "user" ? userName : coparentName;
  const transition = getNextTransition(now);
  const holidays = getUpcomingHolidays(now, 30);

  const parts = [`CUSTODY STATUS: Children are with ${who}. Next transition: ${transition.description}.`];

  if (holidays.length > 0) {
    const holidayLines = holidays.map((h) => {
      const daysUntil = diffDays(h.date, startOfDay(now));
      const who = h.parent === "user" ? "your" : `${coparentName}'s`;
      return `- ${h.name} in ${daysUntil} days (${formatDate(h.date)}) — ${who} year`;
    });
    parts.push("UPCOMING HOLIDAYS:\n" + holidayLines.join("\n"));
  }

  // School calendar context (optional — only if school-calendar.json exists)
  const schoolCtx = getSchoolContext(now);
  if (schoolCtx) {
    parts.push(schoolCtx);
  }

  return parts.join("\n\n");
}

// ============================================================
// SELF-TEST (run directly: bun run src/schedule.ts)
// ============================================================

if (import.meta.main) {
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  console.log("");
  console.log(bold("  Custody Schedule Engine — Status Check"));
  console.log("");

  try {
    const now = new Date();
    const status = getCustodyStatus(now);
    const userName = process.env.USER_NAME || "You";
    const coparentName = process.env.COPARENT_NAME || "Co-parent";

    console.log(`  Today: ${formatDate(now)}`);
    console.log(
      `  Children are with: ${status === "user" ? green(userName) : yellow(coparentName)}`
    );

    const transition = getNextTransition(now);
    console.log(`  Next transition: ${transition.description}`);

    console.log(`\n${bold("  This week:")}`);
    console.log(
      getWeekSummary(now)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    );

    const holidays = getUpcomingHolidays(now, 60);
    if (holidays.length > 0) {
      console.log(`\n${bold("  Upcoming holidays (60 days):")}`);
      for (const h of holidays) {
        const daysUntil = diffDays(h.date, startOfDay(now));
        const who = h.parent === "user" ? green("yours") : yellow(`${coparentName}'s`);
        console.log(`  ${h.name}: ${formatDate(h.date)} (${daysUntil} days) — ${who}`);
      }
    }

    // School calendar info
    const schoolInfo = getSchoolSchedule(now);
    if (schoolInfo) {
      console.log(`\n${bold("  School (today):")}`);
      const child = schoolInfo.child || "Child";
      const school = schoolInfo.schoolName || "school";
      switch (schoolInfo.type) {
        case "regular":
          console.log(`  ${green(`${child} has school at ${school}`)} (${formatTime(schoolInfo.startTime!)}–${formatTime(schoolInfo.endTime!)})`);
          break;
        case "early_release":
          console.log(`  ${yellow(`${child} has early release at ${school}`)} (${formatTime(schoolInfo.startTime!)}–${formatTime(schoolInfo.endTime!)}) — ${schoolInfo.eventName}`);
          break;
        case "no_school":
          console.log(`  ${yellow(`No school for ${child}`)} — ${schoolInfo.eventName}`);
          break;
        case "not_in_session":
          console.log(`  ${dim("School not in session")}`);
          break;
      }
      if (schoolInfo.term) console.log(`  ${dim(schoolInfo.term)}`);

      const upcoming = getUpcomingSchoolEvents(now, 30);
      const future = upcoming.filter((e) => e.daysUntil > 0 && e.type !== "milestone");
      if (future.length > 0) {
        console.log(`\n${bold("  Upcoming school events (30 days):")}`);
        for (const e of future) {
          const when = e.daysUntil === 1 ? "tomorrow" : `in ${e.daysUntil} days`;
          const typeLabel = e.type === "no_school" ? yellow("no school") : yellow("early release");
          console.log(`  ${e.name}: ${formatDate(e.date)} (${when}) — ${typeLabel}`);
        }
      }
    }

    console.log("");
  } catch (e: any) {
    console.log(`  ${e.message}`);
    console.log(`  ${dim("Copy config/schedule.example.json → config/schedule.json and customize.")}`);
    console.log("");
    process.exit(1);
  }
}
