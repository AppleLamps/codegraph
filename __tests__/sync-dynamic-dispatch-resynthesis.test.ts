/**
 * Dynamic-dispatch edge re-synthesis on the incremental sync path.
 *
 * Synthesis (callback/observer, closure-collection, EventEmitter, react-render,
 * JSX-child, …) used to run ONLY at the end of `resolveAndPersistBatched` — a
 * full index. Incremental sync never re-ran it, and that is not merely a
 * staleness problem: re-indexing a file deletes its nodes (`deleteFile` →
 * `DELETE FROM nodes WHERE file_path = ?`) and every edge touching them
 * FK-cascades away (`ON DELETE CASCADE`, schema.sql). Node ids are
 * `sha256(filePath:kind:name:line)`, so even an edit that only SHIFTS lines
 * re-ids every symbol below it and takes their edges with them.
 *
 * Which synthesized edges actually die is asymmetric, and these tests pin the
 * side that does:
 *
 *  - target in the edited file, source elsewhere → SURVIVES. The #899 snapshot
 *    (extraction/index.ts) re-points cross-file INCOMING edges to the
 *    re-indexed target's new id by matching (filePath, kind, name).
 *  - source in the edited file → DESTROYED. That snapshot doesn't cover it, and
 *    the comment's reassurance that such edges "are re-emitted by the extractor
 *    below" holds only for STATIC edges — a synthesized edge has no extractor
 *    to re-emit it, so nothing recreated it until the next full re-index.
 *
 * So dynamic-dispatch coverage decayed monotonically across an editing session,
 * exactly when an agent leans on it hardest. Fixtures below therefore edit the
 * DISPATCHER file (the edge source), which is the case that regresses.
 *
 * Shape is the closure-collection (Alamofire) one, which synthesizes
 * deterministically: a base class iterates-and-invokes a closure collection, a
 * subclass in another file appends to it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph, resolveSynthDebounceMs } from '../src/index';

/** Dispatcher side — owns the edge SOURCE (`didCompleteTask`, `runHandlers`). */
const REQUEST_SWIFT = `class Request {
    var validators: [() -> Void] = []
    var handlers: [() -> Void] = []

    func didCompleteTask() {
        let validators = validators
        validators.forEach { $0() }
    }

    func runHandlers() {
        handlers.forEach { $0() }
    }
}
`;

/** Registrar side — owns the edge TARGET (`validate`, `onEvent`). */
const DATA_REQUEST_SWIFT = `class DataRequest: Request {
    func validate(_ validation: @escaping () -> Void) -> Self {
        let validator: () -> Void = { validation() }
        validators.write { $0.append(validator) }
        return self
    }

    func onEvent(_ handler: @escaping () -> Void) {
        handlers.append(handler)
    }
}
`;

interface SynthEdge {
  source_name: string;
  target_name: string;
  field: string;
  line: number;
  registeredAt: string;
}

/** Every synthesized closure-collection edge, joined back to its endpoints. */
function synthEdges(cg: CodeGraph): SynthEdge[] {
  const db = (cg as any).db.db;
  return db
    .prepare(
      `SELECT s.name source_name, t.name target_name, e.line line,
              json_extract(e.metadata,'$.field') field,
              json_extract(e.metadata,'$.registeredAt') registeredAt
       FROM edges e
       JOIN nodes s ON s.id = e.source
       JOIN nodes t ON t.id = e.target
       WHERE json_extract(e.metadata,'$.synthesizedBy') = 'closure-collection'`
    )
    .all();
}

const validators = (rows: SynthEdge[]) =>
  rows.find((r) => r.field === 'validators' && r.target_name === 'validate');

// Kept under vitest's 5s default so a regression fails on the assertion (with a
// readable diff) rather than as an opaque test timeout.
async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('dynamic-dispatch re-synthesis on sync', () => {
  let dir: string;
  let cg: CodeGraph | null;
  const priorDebounce = process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-resynth-'));
    fs.writeFileSync(path.join(dir, 'Request.swift'), REQUEST_SWIFT);
    fs.writeFileSync(path.join(dir, 'DataRequest.swift'), DATA_REQUEST_SWIFT);
    cg = null;
  });

  afterEach(async () => {
    if (priorDebounce === undefined) delete process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS;
    else process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = priorDebounce;
    try { await cg?.closeAsync(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Prepend `n` comment lines to the dispatcher file — cheapest edit that re-ids it. */
  function touchDispatcher(n = 1): void {
    fs.writeFileSync(path.join(dir, 'Request.swift'), `${'// touched\n'.repeat(n)}${REQUEST_SWIFT}`);
  }

  function touchRegistrar(n = 1): void {
    fs.writeFileSync(path.join(dir, 'DataRequest.swift'), `${'// touched\n'.repeat(n)}${DATA_REQUEST_SWIFT}`);
  }

  it('rebuilds a synthesized edge whose source file was re-indexed', async () => {
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '100';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const before = validators(synthEdges(cg));
    expect(before).toBeTruthy();
    expect(before!.source_name).toBe('didCompleteTask');
    // `validators.forEach { $0() }` sits on line 7 of the pristine file.
    expect(before!.line).toBe(7);

    touchDispatcher();
    await cg.sync();

    expect(await waitFor(() => validators(synthEdges(cg!)) !== undefined)).toBe(true);
    const after = validators(synthEdges(cg));
    expect(after).toBeTruthy();
    expect(after!.source_name).toBe('didCompleteTask');
    // Recomputed against the shifted dispatcher — proves the edge was genuinely
    // re-synthesized against the new node ids rather than surviving the cascade.
    expect(after!.line).toBe(8);
    // The registrar file was untouched, so its wiring site is unchanged.
    expect(after!.registeredAt).toBe('DataRequest.swift:4');

    // The second channel round-trips identically.
    expect(synthEdges(cg).some((r) => r.field === 'handlers' && r.target_name === 'onEvent')).toBe(true);
  });

  it('does not duplicate edges when synthesized identities are upserted', async () => {
    cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const baseline = synthEdges(cg).length;
    expect(baseline).toBeGreaterThan(0);

    // Re-running whole-graph synthesis is the recovery mechanism, so it has to
    // be idempotent — the unique idx_edges_identity + synthesized-edge UPSERT
    // makes a delete-before-insert step unnecessary.
    const resolver = (cg as any).resolver;
    await resolver.synthesizeDynamicDispatchEdges();
    await resolver.synthesizeDynamicDispatchEdges();

    expect(synthEdges(cg).length).toBe(baseline);
  });

  it('holds coverage flat across repeated edits instead of decaying', async () => {
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '25';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const baseline = synthEdges(cg).length;
    expect(baseline).toBeGreaterThan(0);

    for (let i = 1; i <= 3; i++) {
      touchDispatcher(i);
      await cg.sync();
      expect(await waitFor(() => validators(synthEdges(cg!)) !== undefined)).toBe(true);
      const rows = synthEdges(cg);
      expect(rows.length).toBe(baseline);
      // …and still anchored to the dispatcher's current line, i lines lower.
      expect(validators(rows)!.line).toBe(7 + i);
    }
  });

  it('never runs repository-wide synthesis inline for a manual sync', async () => {
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '600000';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const internals = cg as any;
    let synthesisCalls = 0;
    const originalSynthesize = internals.resolver.synthesizeDynamicDispatchEdges.bind(internals.resolver);
    internals.resolver.synthesizeDynamicDispatchEdges = async (...args: unknown[]) => {
      synthesisCalls++;
      return originalSynthesize(...args);
    };

    touchDispatcher();
    await cg.sync();

    expect(synthesisCalls).toBe(0);
    expect(validators(synthEdges(cg))).toBeUndefined();
    expect(internals.synthesisTimer).not.toBeNull();
    expect(internals.queries.getMetadata('dynamic_dispatch_dirty')).toBe('1');
    internals.resolver.synthesizeDynamicDispatchEdges = originalSynthesize;
  });

  it('defers instead of running inline while a watcher is driving syncs', async () => {
    // Long debounce: the deferred pass must not have fired by the time sync
    // returns, which is what proves the work was handed off rather than paid
    // inline on every save.
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '600000';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    expect(validators(synthEdges(cg))).toBeTruthy();

    // Watcher debounce is set absurdly high so the watcher never fires a sync of
    // its own — this isolates the isWatching() branch, not the watcher itself.
    expect(cg.watch({ debounceMs: 3_600_000 })).toBe(true);

    touchDispatcher();
    await cg.sync();

    // The cascade took the edge and the deferred pass has not run yet.
    expect(validators(synthEdges(cg))).toBeUndefined();
    expect((cg as any).synthesisTimer).not.toBeNull();
    expect((cg as any).synthesisDirty).toBe(true);
  });

  it('the deferred pass restores the edges once the tree settles', async () => {
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '100';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    expect(cg.watch({ debounceMs: 3_600_000 })).toBe(true);

    touchDispatcher();
    await cg.sync();

    expect(await waitFor(() => validators(synthEdges(cg!)) !== undefined)).toBe(true);
    // Restored with the same recomputed geometry the inline path produces.
    expect(validators(synthEdges(cg))!.line).toBe(8);
  });

  it('coalesces a burst of syncs into a single pending pass', async () => {
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '600000';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    expect(cg.watch({ debounceMs: 3_600_000 })).toBe(true);

    // Three edits in a row must leave ONE armed timer, not three passes queued.
    const timers: unknown[] = [];
    for (let i = 1; i <= 3; i++) {
      touchDispatcher(i);
      await cg.sync();
      timers.push((cg as any).synthesisTimer);
    }
    expect(timers.every((t) => t !== null)).toBe(true);
    // Each sync re-armed the same slot — the previous timer was cleared, so the
    // deadline slid forward rather than stacking.
    expect(new Set(timers).size).toBe(timers.length);
    expect((cg as any).synthesisRunning).toBe(false);
  });

  it('a later watcher resumes a durable refresh left by a short-lived sync', async () => {
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '600000';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    touchDispatcher();
    await cg.sync();
    expect((cg as any).queries.getMetadata('dynamic_dispatch_dirty')).toBe('1');
    await cg.closeAsync();

    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '25';
    cg = await CodeGraph.open(dir);
    expect(cg.watch({ debounceMs: 3_600_000 })).toBe(true);

    expect(await waitFor(() => validators(synthEdges(cg!)) !== undefined)).toBe(true);
    expect((cg as any).queries.getMetadata('dynamic_dispatch_dirty')).toBe('0');
  });

  it('refreshes registeredAt when a surviving synthesized edge is rediscovered', async () => {
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '25';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    expect(validators(synthEdges(cg))!.registeredAt).toBe('DataRequest.swift:4');

    // Target-side reindexing preserves and repoints the incoming synthesized
    // edge. Its identity survives, but the registrar line moves.
    touchRegistrar();
    await cg.sync();
    expect(await waitFor(
      () => validators(synthEdges(cg!))?.registeredAt === 'DataRequest.swift:5'
    )).toBe(true);
    expect(validators(synthEdges(cg))!.registeredAt).toBe('DataRequest.swift:5');
  });

  it('retries instead of writing when another process owns the project lock', async () => {
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '600000';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    expect(cg.watch({ debounceMs: 3_600_000 })).toBe(true);

    touchDispatcher();
    await cg.sync();
    expect(validators(synthEdges(cg))).toBeUndefined();

    const internals = cg as any;
    clearTimeout(internals.synthesisTimer);
    internals.synthesisTimer = null;

    const originalAcquire = internals.fileLock.acquire.bind(internals.fileLock);
    let synthesisCalls = 0;
    const originalSynthesize = internals.resolver.synthesizeDynamicDispatchEdges.bind(internals.resolver);
    internals.fileLock.acquire = () => {
      throw new Error('held by another process');
    };
    internals.resolver.synthesizeDynamicDispatchEdges = async (...args: unknown[]) => {
      synthesisCalls++;
      return originalSynthesize(...args);
    };

    await internals.runDeferredSynthesis();

    expect(synthesisCalls).toBe(0);
    expect(internals.synthesisDirty).toBe(true);
    expect(internals.synthesisTimer).not.toBeNull();
    expect(validators(synthEdges(cg))).toBeUndefined();

    internals.fileLock.acquire = originalAcquire;
    internals.resolver.synthesizeDynamicDispatchEdges = originalSynthesize;
  });

  it('closeAsync() disarms a pending deferred pass', async () => {
    process.env.CODEGRAPH_SYNTH_DEBOUNCE_MS = '600000';
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    expect(cg.watch({ debounceMs: 3_600_000 })).toBe(true);

    touchDispatcher();
    await cg.sync();
    expect((cg as any).synthesisTimer).not.toBeNull();

    await cg.closeAsync();
    // A timer left armed here would fire against a closed database from a bare
    // setTimeout callback, with no caller to catch the throw.
    expect((cg as any).synthesisTimer).toBeNull();
    expect((cg as any).synthesisClosed).toBe(true);
    cg = null;
  });
});

describe('resolveSynthDebounceMs', () => {
  it('takes a numeric override and falls back on anything else', () => {
    expect(resolveSynthDebounceMs('0')).toBe(0);
    expect(resolveSynthDebounceMs('250')).toBe(250);
    expect(resolveSynthDebounceMs(undefined)).toBe(6000);
    expect(resolveSynthDebounceMs('')).toBe(6000);
    expect(resolveSynthDebounceMs('   ')).toBe(6000);
    expect(resolveSynthDebounceMs('nope')).toBe(6000);
    expect(resolveSynthDebounceMs('-5')).toBe(6000);
  });
});
