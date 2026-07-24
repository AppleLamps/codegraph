#!/usr/bin/env node
// Extract one eval run's metrics from its Claude stream-json transcript + the
// offload usage sidecar log, emit ONE merged JSON line.
//
// Usage: extract-metrics.mjs --run <run.jsonl> --usage <usage.jsonl|-> \
//          --arm <a> --rep <n> --repo <r> --tier <t> --q <question>
import { readFileSync, existsSync } from 'fs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const runFile = args.run;
const lines = existsSync(runFile) ? readFileSync(runFile, 'utf8').split('\n').filter(Boolean) : [];

const toolCounts = {};
let result = null;
const tok = { gen: 0, fresh: 0, cached: 0 };
const offloadAnswers = [];
let exploreResults = 0; // tool_results from explore (offload or raw)
let lastAssistantText = '';
const exploreToolUseIds = new Set();
let completedExploreSeen = false;
const followUpReadFiles = [];
const evidenceHeaders = [];
const completedExplores = [];
let activeCompletedExplore = null;

const EXPLORE_TOOL_NAMES = new Set([
  'codegraph_explore',
  'mcp__codegraph__codegraph_explore',
  'mcp__codegraph.codegraph_explore',
]);
const isExploreToolName = (name) => EXPLORE_TOOL_NAMES.has(name);

const toolResultText = (content) => Array.isArray(content)
  ? content.map(c => (typeof c === 'string' ? c : c.text || '')).join('')
  : (typeof content === 'string' ? content : '');

const integerField = (section, pattern) => {
  const m = section.match(pattern);
  if (!m || /^(?:unknown|n\/a|—)$/i.test(m[1].trim())) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
};

// Evidence Header v1 is deliberately parsed from its labelled fields rather
// than line positions so additions to the header do not silently shift data.
// Missing/unknown fields stay null: absence of evidence is not a zero.
const parseEvidenceHeader = (text) => {
  const start = text.search(/^#{1,6}\s+Evidence Header v1\s*$/im);
  if (start < 0) return null;
  const rest = text.slice(start);
  const nextHeading = rest.slice(rest.indexOf('\n') + 1).search(/^#{1,6}\s+/m);
  const section = nextHeading < 0
    ? rest
    : rest.slice(0, rest.indexOf('\n') + 1 + nextHeading);
  const line = (label) => section.match(new RegExp(`^\\s*(?:[-*]\\s*)?${label}:\\s*(.+?)\\s*$`, 'im'))?.[1]?.trim() ?? null;
  const relationships = section.match(/^\s*(?:[-*]\s*)?Relationships:\s*exact=(\d+),\s*heuristic=(\d+),\s*ambiguous=(\d+),\s*unresolved=(\d+)\s*$/im);
  const files = section.match(/^\s*(?:[-*]\s*)?Candidate files:\s*rendered=(\d+),\s*omitted=(\d+)\s*$/im);
  const coverageLine = line('Coverage');
  const coverage = coverageLine?.match(/^(focused|qualified|partial)\b/i)?.[1]?.toLowerCase() ?? null;
  const pendingFilesDetail = line('Pending files');
  return {
    indexFreshness: line('Index freshness'),
    pendingFiles: integerField(section, /^\s*(?:[-*]\s*)?Pending files:\s*(\d+|unknown|n\/a|—)(?:\s+.*)?$/im),
    pendingFilesDetail,
    deferredSynthesis: line('Deferred synthesis'),
    exactEdges: relationships ? Number(relationships[1]) : null,
    heuristicEdges: relationships ? Number(relationships[2]) : null,
    ambiguousRelationships: relationships ? Number(relationships[3]) : null,
    unresolvedRelationships: relationships ? Number(relationships[4]) : null,
    renderedFiles: files ? Number(files[1]) : null,
    omittedFiles: files ? Number(files[2]) : null,
    coverage,
    coverageDetail: coverageLine,
  };
};

for (const line of lines) {
  let ev; try { ev = JSON.parse(line); } catch { continue; }

  // per-turn token usage (authoritative token measure; result.usage is last-turn only)
  const u = ev.message?.usage;
  if (u) {
    tok.gen += u.output_tokens || 0;
    tok.fresh += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    tok.cached += u.cache_read_input_tokens || 0;
  }

  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'tool_use') {
        toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
        if (isExploreToolName(b.name) && b.id) exploreToolUseIds.add(b.id);
        if (b.name === 'Read' && completedExploreSeen) {
          const path = b.input?.file_path ?? b.input?.path;
          const normalizedPath = typeof path === 'string' ? path : null;
          followUpReadFiles.push(normalizedPath);
          activeCompletedExplore?.readFiles.push(normalizedPath);
        }
      }
      if (b.type === 'text' && b.text?.trim()) lastAssistantText = b.text.trim();
    }
  }
  // tool_results arrive in user messages
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type !== 'tool_result') continue;
      const text = toolResultText(b.content);
      const matchedExploreCall = !!b.tool_use_id && exploreToolUseIds.has(b.tool_use_id);
      const looksLikeExploreResult = /Synthesized by CodeGraph|### Referenced source — verbatim|Found \d+ symbols? across|\*\*Exploration:|^#{1,6}\s+Evidence Header v1\s*$/im.test(text);
      // An offload answer is either the 'plain'/'report' synthesis (carries the
      // "Synthesized by CodeGraph" footer) or a 'refs' answer (carries the re-expanded
      // "### Referenced source — verbatim" appendix). A refs call that cited nothing
      // valid falls back to RAW source, which is correctly counted as a raw explore below.
      if (/Synthesized by CodeGraph|### Referenced source — verbatim/.test(text)) offloadAnswers.push(text);
      if (matchedExploreCall || looksLikeExploreResult) {
        exploreResults++;
      }
      // Follow-up and confidence metrics require deterministic tool_use_id
      // association. Content recognition above remains only for the legacy
      // exploreResults counter; it must not establish provenance or truth.
      if (matchedExploreCall) {
        completedExploreSeen = true;
        const header = parseEvidenceHeader(text);
        if (header) evidenceHeaders.push(header);
        activeCompletedExplore = {
          toolUseId: matchedExploreCall ? b.tool_use_id : null,
          evidenceHeader: header,
          answer: text.slice(0, 6000),
          readFiles: [],
        };
        completedExplores.push(activeCompletedExplore);
      }
    }
  }
  if (ev.type === 'result') result = ev;
}

// offload usage sidecar (CodeGraph AI tokens + cost) — one JSON line per offload call
const ai = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, credits: 0, costUsd: 0, ms: 0 };
if (args.usage && args.usage !== '-' && existsSync(args.usage)) {
  for (const line of readFileSync(args.usage, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    ai.calls++;
    ai.promptTokens += e.promptTokens || 0;
    ai.completionTokens += e.completionTokens || 0;
    ai.totalTokens += e.totalTokens || 0;
    ai.credits += e.creditsCharged || 0;
    ai.costUsd += e.costUsd || 0;
    ai.ms += e.ms || 0;
  }
}

// front-load hook fired iff its injected header appears in the transcript
const frontload = lines.some(l => l.includes('auto-retrieved for this question'));
const get = (n) => toolCounts[n] || 0;
const read = get('Read');
const grep = get('Grep') + get('Bash') + get('Glob');
const explore = Object.entries(toolCounts)
  .filter(([name]) => isExploreToolName(name))
  .reduce((sum, [, count]) => sum + count, 0);
const cgAny = Object.keys(toolCounts).filter(k => /codegraph/.test(k)).reduce((s, k) => s + toolCounts[k], 0);
const hasCompletedExplore = completedExplores.length > 0;
const lastEvidenceHeader = evidenceHeaders.at(-1) ?? null;
const followUpReadsByExplore = completedExplores.map(({ toolUseId, evidenceHeader, readFiles }) => ({
  toolUseId,
  count: readFiles.length,
  files: [...new Set(readFiles.filter(Boolean))],
  evidenceHeader,
  confidenceClaim: evidenceHeader?.coverage ?? null,
  confidenceCorrect: null,
}));
const evidenceAnswers = completedExplores
  .filter(({ evidenceHeader }) => evidenceHeader !== null)
  .map(({ toolUseId, evidenceHeader, answer }) => ({
    toolUseId,
    confidenceClaim: evidenceHeader.coverage,
    answer,
  }));

const out = {
  repo: args.repo, tier: args.tier, arm: args.arm, rep: Number(args.rep), question: args.q,
  ok: result?.subtype === 'success',
  durationSec: result ? +(result.duration_ms / 1000).toFixed(1) : null,
  numTurns: result?.num_turns ?? null,
  costUsdMain: result ? +(result.total_cost_usd || 0).toFixed(4) : null,
  tokGen: tok.gen, tokFresh: tok.fresh, tokCached: tok.cached, tokBillable: tok.gen + tok.fresh,
  read, grep, explore, cgAny, frontload,
  offloadFired: offloadAnswers.length,
  // Count only Reads issued after a completed explore result, never a parallel
  // Read launched in the same assistant turn as the explore request.
  followUpReads: hasCompletedExplore ? followUpReadFiles.length : null,
  followUpReadFiles: hasCompletedExplore ? [...new Set(followUpReadFiles.filter(Boolean))] : null,
  followUpReadsByExplore: hasCompletedExplore ? followUpReadsByExplore : null,
  // The extractor records CodeGraph's confidence claim and its observable
  // evidence, but cannot decide semantic correctness without ground truth.
  // A later judge may replace null; keeping unknown explicit avoids treating
  // an absent header or an unjudged claim as correct.
  confidenceClaim: lastEvidenceHeader?.coverage ?? null,
  confidenceCorrect: null,
  evidenceHeader: lastEvidenceHeader,
  evidenceHeaderCount: evidenceHeaders.length,
  // Retained for the ground-truth judge. The metrics extractor itself cannot
  // decide whether a coverage claim was semantically calibrated.
  evidenceAnswers,
  ai,
  // text payloads for the accuracy judge (kept separate; large)
  finalAnswer: (result?.result || lastAssistantText || '').slice(0, 8000),
  offloadAnswers: offloadAnswers.map(a => a.slice(0, 6000)),
};
process.stdout.write(JSON.stringify(out) + '\n');
