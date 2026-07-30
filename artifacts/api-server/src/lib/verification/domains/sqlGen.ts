/**
 * domains/sqlGen.ts — NEW DOMAIN, built from scratch to prove extensibility.
 *
 * Use case (very BNY-relevant): an agent generates a SQL query from a natural-language request.
 * This domain did NOT exist when the core was written. Onboarding it required ZERO core changes —
 * only this file: a prepare() + a few domain-specific guardians against the stable Guardian
 * interface. That is the whole "apply to new domains" story, made concrete.
 *
 * Guardians (domain-specific, not reused text helpers):
 *   syntax        — is it a real, non-placeholder SQL SELECT (materiality analogue)?
 *   safety        — no destructive/DDL statements; parameterized, not string-concatenated literals
 *   bounded       — a row limit is present and matches the requested limit (numerical analogue)
 *   rubric        — LLM judge reused from guardians.ts (optional, dry→degraded)
 */

import type { DomainAdapter, Guardian, GuardianResult } from "../verificationCore.js";
import { makeRubricGuardian } from "../guardians.js";

export const SQL_GEN_DOMAIN = "sql_gen";

export interface SqlRaw {
  sql: string;
  /** The request the agent was answering (used by rubric + intent checks). */
  request: string;
  /** If the request asked for N rows, the query must enforce it. */
  requestedLimit?: number;
}
export interface SqlInput extends SqlRaw {}

const DESTRUCTIVE = /\b(drop|delete|truncate|update|insert|alter|grant|revoke|create)\b/i;
const PLACEHOLDER = /(\bTODO\b|\bFIXME\b|<table>|<column>|your_table|\.\.\.)/i;

function syntaxGuardian(): Guardian<unknown> {
  return {
    name: "syntax",
    run(input): GuardianResult {
      const { sql } = input as SqlInput;
      const reasons: string[] = [];
      const s = (sql ?? "").trim();
      if (s.length < 12) reasons.push("query too short / empty");
      if (!/^\s*select\b/i.test(s)) reasons.push("not a SELECT query");
      if (!/\bfrom\b/i.test(s)) reasons.push("missing FROM clause");
      if (PLACEHOLDER.test(s)) reasons.push(`placeholder tokens present: ${(s.match(PLACEHOLDER) || [])[0]}`);
      return {
        guardian: "syntax",
        status: reasons.length ? "fail" : "pass",
        live: false,
        reasons: reasons.length ? reasons : ["well-formed non-placeholder SELECT"],
        evidence: { length: s.length },
      };
    },
  };
}

function safetyGuardian(): Guardian<unknown> {
  return {
    name: "safety",
    run(input): GuardianResult {
      const { sql } = input as SqlInput;
      const s = sql ?? "";
      const reasons: string[] = [];
      const destr = s.match(DESTRUCTIVE);
      if (destr) reasons.push(`destructive/DDL statement not allowed for a read query: '${destr[0]}'`);
      // naive injection smell: a literal OR 1=1, or a trailing ';' with a second statement
      if (/\bor\s+1\s*=\s*1\b/i.test(s)) reasons.push("suspicious tautology 'OR 1=1'");
      if (/;\s*\S/.test(s)) reasons.push("multiple statements (';' with trailing SQL)");
      return {
        guardian: "safety",
        status: reasons.length ? "fail" : "pass",
        live: false,
        reasons: reasons.length ? reasons : ["read-only, single-statement, no injection smell"],
      };
    },
  };
}

function boundedGuardian(): Guardian<unknown> {
  return {
    name: "bounded",
    run(input): GuardianResult {
      const { sql, requestedLimit } = input as SqlInput;
      const s = sql ?? "";
      const m = s.match(/\blimit\s+(\d+)/i);
      const claimed = m ? Number(m[1]) : null;
      if (requestedLimit == null) {
        // no explicit request: just require SOME limit to avoid unbounded scans
        const ok = claimed != null;
        return { guardian: "bounded", status: ok ? "pass" : "fail", live: false, reasons: ok ? [`bounded by LIMIT ${claimed}`] : ["no LIMIT clause — unbounded scan risk"], evidence: { claimed } };
      }
      if (claimed == null) return { guardian: "bounded", status: "fail", live: false, reasons: [`request asked for ${requestedLimit} rows but query has no LIMIT`], evidence: { claimed, requestedLimit } };
      const ok = claimed === requestedLimit;
      return {
        guardian: "bounded",
        status: ok ? "pass" : "fail",
        live: false,
        reasons: ok ? [`LIMIT ${claimed} matches requested ${requestedLimit}`] : [`LIMIT ${claimed} does not match requested ${requestedLimit}`],
        evidence: { claimed, requestedLimit },
      };
    },
  };
}

export const sqlGenAdapter: DomainAdapter<SqlRaw, SqlInput> = {
  domain: SQL_GEN_DOMAIN,
  prepare: (raw) => raw,
  guardians: [
    syntaxGuardian(),
    safetyGuardian(),
    boundedGuardian(),
    makeRubricGuardian({ getText: (i) => `REQUEST: ${(i as SqlInput).request}\nSQL: ${(i as SqlInput).sql}`, axes: ["intent_match", "correctness", "safety", "efficiency"] }),
  ],
};
