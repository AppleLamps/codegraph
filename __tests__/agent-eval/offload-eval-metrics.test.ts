import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tempRoot = mkdtempSync(resolve(tmpdir(), 'codegraph-agent-eval-'));
const script = resolve('scripts/agent-eval/offload-eval-metrics.mjs');

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function extract(events: unknown[]) {
  const run = resolve(tempRoot, `run-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(run, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const stdout = execFileSync(process.execPath, [
    script,
    '--run', run,
    '--usage', '-',
    '--arm', 'raw',
    '--rep', '1',
    '--repo', 'fixture',
    '--tier', 'small',
    '--q', 'trace the flow',
  ], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

describe('offload-eval-metrics Evidence Header v1 metrics', () => {
  it('counts only Reads after a completed explore and extracts labelled evidence', () => {
    const out = extract([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'explore-1', name: 'mcp__codegraph__codegraph_explore', input: { query: 'flow' } },
            { type: 'tool_use', id: 'parallel-read', name: 'Read', input: { file_path: '/repo/parallel.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'explore-1',
            content: `### Evidence Header v1
- Index freshness: current
- Pending files: 0 (watcher current)
- Deferred synthesis: dirty
- Relationships: exact=7, heuristic=2, ambiguous=1, unresolved=3
- Candidate files: rendered=3, omitted=4
- Coverage: partial — one ambiguous boundary

## Exploration: flow
Found 10 symbols across 7 files.`,
          }],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: 'read-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: 'read-3', name: 'Read', input: { file_path: '/repo/b.ts' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', duration_ms: 100, num_turns: 2, result: 'done' },
    ]);

    expect(out.read).toBe(4);
    expect(out.followUpReads).toBe(3);
    expect(out.followUpReadFiles).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(out.followUpReadsByExplore).toEqual([{
      toolUseId: 'explore-1',
      count: 3,
      files: ['/repo/a.ts', '/repo/b.ts'],
      evidenceHeader: {
        indexFreshness: 'current',
        pendingFiles: 0,
        pendingFilesDetail: '0 (watcher current)',
        deferredSynthesis: 'dirty',
        exactEdges: 7,
        heuristicEdges: 2,
        ambiguousRelationships: 1,
        unresolvedRelationships: 3,
        renderedFiles: 3,
        omittedFiles: 4,
        coverage: 'partial',
        coverageDetail: 'partial — one ambiguous boundary',
      },
      confidenceClaim: 'partial',
      confidenceCorrect: null,
    }]);
    expect(out.confidenceClaim).toBe('partial');
    expect(out.confidenceCorrect).toBeNull();
    expect(out.evidenceHeaderCount).toBe(1);
    expect(out.evidenceAnswers).toHaveLength(1);
    expect(out.evidenceAnswers[0]).toMatchObject({
      toolUseId: 'explore-1',
      confidenceClaim: 'partial',
    });
    expect(out.evidenceAnswers[0].answer).toContain('## Exploration: flow');
    expect(out.evidenceHeader).toEqual({
      indexFreshness: 'current',
      pendingFiles: 0,
      pendingFilesDetail: '0 (watcher current)',
      deferredSynthesis: 'dirty',
      exactEdges: 7,
      heuristicEdges: 2,
      ambiguousRelationships: 1,
      unresolvedRelationships: 3,
      renderedFiles: 3,
      omittedFiles: 4,
      coverage: 'partial',
      coverageDetail: 'partial — one ambiguous boundary',
    });
  });

  it('reports unknown rather than zero when no explore result was completed', () => {
    const out = extract([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/repo/a.ts' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', duration_ms: 20, num_turns: 1, result: 'done' },
    ]);

    expect(out.followUpReads).toBeNull();
    expect(out.followUpReadFiles).toBeNull();
    expect(out.confidenceClaim).toBeNull();
    expect(out.confidenceCorrect).toBeNull();
    expect(out.evidenceHeader).toBeNull();
    expect(out.evidenceHeaderCount).toBe(0);
    expect(out.evidenceAnswers).toEqual([]);
  });

  it('attributes follow-up Reads to the most recently completed explore', () => {
    const header = (coverage: string) => `## Evidence Header v1
- Index freshness: current
- Pending files: 0
- Deferred synthesis: fresh
- Relationships: exact=2, heuristic=0, ambiguous=0, unresolved=0
- Candidate files: rendered=1, omitted=0
- Coverage: ${coverage}`;
    const out = extract([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'explore-1', name: 'mcp__codegraph__codegraph_explore', input: { query: 'one' } }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'explore-1', content: header('focused') }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/repo/one.ts' } }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'explore-2', name: 'mcp__codegraph__codegraph_explore', input: { query: 'two' } }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'explore-2', content: header('qualified — ranked retrieval is not whole-repo proof') }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'read-2', name: 'Read', input: { file_path: '/repo/two.ts' } }] },
      },
      { type: 'result', subtype: 'success', duration_ms: 20, num_turns: 3, result: 'done' },
    ]);

    expect(out.followUpReads).toBe(2);
    expect(out.followUpReadsByExplore).toEqual([
      {
        toolUseId: 'explore-1',
        count: 1,
        files: ['/repo/one.ts'],
        evidenceHeader: {
          indexFreshness: 'current',
          pendingFiles: 0,
          pendingFilesDetail: '0',
          deferredSynthesis: 'fresh',
          exactEdges: 2,
          heuristicEdges: 0,
          ambiguousRelationships: 0,
          unresolvedRelationships: 0,
          renderedFiles: 1,
          omittedFiles: 0,
          coverage: 'focused',
          coverageDetail: 'focused',
        },
        confidenceClaim: 'focused',
        confidenceCorrect: null,
      },
      {
        toolUseId: 'explore-2',
        count: 1,
        files: ['/repo/two.ts'],
        evidenceHeader: {
          indexFreshness: 'current',
          pendingFiles: 0,
          pendingFilesDetail: '0',
          deferredSynthesis: 'fresh',
          exactEdges: 2,
          heuristicEdges: 0,
          ambiguousRelationships: 0,
          unresolvedRelationships: 0,
          renderedFiles: 1,
          omittedFiles: 0,
          coverage: 'qualified',
          coverageDetail: 'qualified — ranked retrieval is not whole-repo proof',
        },
        confidenceClaim: 'qualified',
        confidenceCorrect: null,
      },
    ]);
  });

  it('preserves unknown header fields as null', () => {
    const out = extract([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'explore-1', name: 'codegraph_explore', input: { query: 'flow' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'explore-1',
            content: `## Evidence Header v1
- Index freshness: unknown
- Pending files: unknown
- Deferred synthesis: unknown
- Coverage: partial — evidence fields unavailable`,
          }],
        },
      },
      { type: 'result', subtype: 'success', duration_ms: 20, num_turns: 1, result: 'done' },
    ]);

    expect(out.followUpReads).toBe(0);
    expect(out.explore).toBe(1);
    expect(out.confidenceClaim).toBe('partial');
    expect(out.confidenceCorrect).toBeNull();
    expect(out.evidenceHeader.pendingFiles).toBeNull();
    expect(out.evidenceHeader.exactEdges).toBeNull();
    expect(out.evidenceHeader.ambiguousRelationships).toBeNull();
    expect(out.evidenceHeader.unresolvedRelationships).toBeNull();
  });
});
