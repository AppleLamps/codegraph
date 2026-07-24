import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { __emitWatchEventForTests, __setFsWatchForTests } from '../src/sync/watcher';

function evidenceLine(text: string, label: string): string | null {
  const match = text.match(new RegExp(`^- ${label}: (.+)$`, 'm'));
  return match?.[1] ?? null;
}

describe('codegraph_explore Evidence Header v1', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-evidence-header-'));
    fs.writeFileSync(
      path.join(testDir, 'entry.ts'),
      [
        `import { helperFlow } from './helper';`,
        `export function startFlow() { return helperFlow(); }`,
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(testDir, 'helper.ts'),
      `export function helperFlow() { return 'ok'; }\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'stable.ts'),
      [
        `export function stableStart() { return stableEnd(); }`,
        `export function stableEnd() { return 1; }`,
        '',
      ].join('\n'),
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(async () => {
    __setFsWatchForTests(null);
    await cg?.closeAsync();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reports snapshot freshness and never claims whole-repository completeness', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'stableStart stableEnd',
    });
    const text = result.content[0].text;

    expect(text).toContain('## Evidence Header v1');
    expect(evidenceLine(text, 'Index freshness')).toBe('snapshot');
    expect(evidenceLine(text, 'Pending files')).toBe('unknown (live watcher unavailable)');
    expect(evidenceLine(text, 'Deferred synthesis')).toBe('fresh');
    expect(evidenceLine(text, 'Relationships')).toMatch(
      /^exact=\d+, heuristic=\d+, ambiguous=0, unresolved=0$/,
    );
    expect(evidenceLine(text, 'Candidate files')).toMatch(/^rendered=\d+, omitted=\d+$/);
    expect(evidenceLine(text, 'Coverage')).toMatch(
      /^qualified — .*ranked retrieval is not proof of whole-repository completeness$/,
    );
    expect(result).not.toHaveProperty('_exploreEvidence');
  });

  it('counts ambiguous and unresolved query-local relationship gaps', async () => {
    const start = cg.getNodesByName('startFlow')[0]!;
    const queries = (cg as unknown as {
      queries: {
        insertUnresolvedRef(ref: {
          fromNodeId: string;
          referenceName: string;
          referenceKind: 'calls';
          line: number;
          column: number;
          filePath: string;
          language: 'typescript';
          candidates?: string[];
        }): void;
      };
    }).queries;
    queries.insertUnresolvedRef({
      fromNodeId: start.id,
      referenceName: 'ambiguousTarget',
      referenceKind: 'calls',
      line: 2,
      column: 37,
      filePath: 'entry.ts',
      language: 'typescript',
      candidates: ['pkgA::ambiguousTarget', 'pkgB::ambiguousTarget'],
    });
    queries.insertUnresolvedRef({
      fromNodeId: start.id,
      referenceName: 'missingTarget',
      referenceKind: 'calls',
      line: 2,
      column: 37,
      filePath: 'entry.ts',
      language: 'typescript',
    });

    const result = await handler.execute('codegraph_explore', {
      query: 'startFlow helperFlow ambiguousTarget missingTarget',
      maxFiles: 1,
    });
    const text = result.content[0].text;

    expect(evidenceLine(text, 'Relationships')).toMatch(
      /^exact=\d+, heuristic=\d+, ambiguous=1, unresolved=1$/,
    );
    expect(evidenceLine(text, 'Candidate files')).toBe('rendered=1, omitted=1');
    expect(evidenceLine(text, 'Coverage')).toMatch(
      /^partial — .*1 ambiguous relationship.*1 unresolved relationship.*1 ranked candidate file was not rendered/,
    );
  });

  it('reports live pending files and lowers coverage when a ranked file is stale', async () => {
    cg.watch({ debounceMs: 4000, inertForTests: true });
    await cg.waitUntilWatcherReady();
    fs.writeFileSync(
      path.join(testDir, 'stable.ts'),
      [
        `export function stableStart() { return stableEnd(); }`,
        `export function stableEnd() { return 2; }`,
        '',
      ].join('\n'),
    );
    __emitWatchEventForTests(testDir, 'stable.ts');

    const result = await handler.execute('codegraph_explore', {
      query: 'stableStart stableEnd',
    });
    const text = result.content[0].text;

    expect(evidenceLine(text, 'Index freshness')).toBe('pending');
    expect(evidenceLine(text, 'Pending files')).toMatch(/^1 \(0 indexing; stable\.ts\)$/);
    expect(evidenceLine(text, 'Coverage')).toMatch(
      /^partial — 1 ranked candidate file is pending sync/,
    );
  });

  it('surfaces persisted deferred-synthesis dirtiness', async () => {
    const queries = (cg as unknown as {
      queries: { setMetadata(key: string, value: string): void };
    }).queries;
    queries.setMetadata('dynamic_dispatch_dirty', '1');

    const result = await handler.execute('codegraph_explore', {
      query: 'stableStart stableEnd',
    });
    const text = result.content[0].text;

    expect(evidenceLine(text, 'Deferred synthesis')).toBe('dirty');
    expect(evidenceLine(text, 'Coverage')).toMatch(
      /^partial — deferred synthesis is dirty/,
    );
  });
});
