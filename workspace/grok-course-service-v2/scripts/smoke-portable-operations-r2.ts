import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SOURCE_ROOT, commandEnv, freePort, runCommand } from './smoke-portable-course-service';
import { startManagedService, stopManagedService, inspectManagedService, watchdogManagedService } from './course-service-manage';
import { exportPrivateState, importPrivateState } from './course-service-state';
import { PortableCourseClient } from '../lib/workbench/portable-course-client';

async function main() {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'cmooc-ops-r2-'));
  const dataDir = path.join(scratch, 'source'); const target = path.join(scratch, 'target');
  const port = await freePort(); const secondPort = await freePort();
  const options = { dataDir, packageRoot: SOURCE_ROOT, port, startupTimeoutMs: 60000, stopTimeoutMs: 20000 };
  const importedOptions = { ...options, dataDir: target, port: secondPort };
  try {
    await runCommand(['setup'], commandEnv(dataDir, port));
    const first = await startManagedService(options);
    const client = new PortableCourseClient({ dataDir, serviceOrigin: `http://127.0.0.1:${port}`, requireProtocolIdentity: true });
    const course = await client.registerCourse({ title: 'Synthetic migration', entryUrl: 'https://example.invalid/ops', budget: 1 });
    const run = await client.createCourseRun({ courseId: course.id, requestId: randomUUID(), mode: 'observe' });
    await client.claimCourseRun(run.id);
    await client.readCourseGuidance(run.id);
    const at = new Date(Date.now() - 1000).toISOString();
    await client.recordCourseObservation({ courseUrl: course.entryUrl, observedAt: at, scope: 'selected_discussions', complete: false,
      expectedDiscussions: null, coverageNote: 'Synthetic migration evidence',
      pages: [{ url: course.entryUrl, itemCount: 1, terminal: false }],
      discussions: [{ ref: 'D1', stableKey: 'migration-D1', url: course.entryUrl, title: 'Synthetic', summary: 'Synthetic only', complete: true }],
      posts: [{ ref: 'P1', discussionRef: 'D1', parentRef: null, actorAlias: 'A', role: 'learner', createdAt: at, url: course.entryUrl },
        { ref: 'P2', discussionRef: 'D1', parentRef: 'P1', actorAlias: 'B', role: 'learner', createdAt: at, url: course.entryUrl }]
    }, run.id, 'migration-observe');
    const saved = await client.saveCourseProposals([{ discussionRef: 'D1', decision: 'YIELD', reason: 'Synthetic human response', draft: '' }], run.id, 'migration-proposals');
    const originalProjection = JSON.stringify({ ...(saved.middleLayer as Record<string, unknown>), replayed: true });

    await assert.rejects(exportPrivateState({ dataDir, packageRoot: SOURCE_ROOT, file: path.join(scratch, 'active.json') }));
    process.kill(first.state.pid, 'SIGKILL');
    for (let i = 0; i < 100; i++) {
      if ((await inspectManagedService(options)).status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const recovered = await watchdogManagedService({ ...options, once: true, maxRestarts: 2, backoffMs: 100 });
    assert.equal(recovered.status, 'running');
    const current = await inspectManagedService(options);
    assert.notEqual(current.state?.instanceId, first.state.instanceId);
    assert.equal(current.state?.namespaceId, first.state.namespaceId);
    await client.readCourseGuidance(run.id);
    await stopManagedService(options);
    assert.equal((await watchdogManagedService({ ...options, once: true })).status, 'stopped');
    const file = path.join(scratch, 'private-migration.json');
    await exportPrivateState({ dataDir, packageRoot: SOURCE_ROOT, file });
    await importPrivateState({ dataDir: target, packageRoot: SOURCE_ROOT, file });
    await assert.rejects(importPrivateState({ dataDir: target, packageRoot: SOURCE_ROOT, file }));
    assert.equal((await readFile(path.join(target, 'namespace-id'), 'utf8')).trim(), (await readFile(path.join(dataDir, 'namespace-id'), 'utf8')).trim());
    await runCommand(['setup'], commandEnv(target, secondPort));
    await startManagedService(importedOptions);
    const imported = new PortableCourseClient({ dataDir: target, serviceOrigin: `http://127.0.0.1:${secondPort}`, requireProtocolIdentity: true });
    assert.equal((await imported.workspace()).courses.some(item => item.id === course.id), true);
    const restored = await imported.getCourseRun(run.id);
    assert.equal(restored.id, run.id);
    assert.notEqual(restored.status, 'running');
    await imported.claimCourseRun(run.id);
    await imported.readCourseGuidance(run.id);
    const readback = await imported.saveCourseProposals([{ discussionRef: 'D1', decision: 'YIELD', reason: 'Synthetic human response', draft: '' }], run.id, 'migration-proposals');
    assert.equal(JSON.stringify(readback.middleLayer), originalProjection);
    assert.equal((await readFile(path.join(target, 'private/cmooc-research/runtime/evidence-hmac-v1.key'), 'utf8')).trim(), (await readFile(path.join(dataDir, 'private/cmooc-research/runtime/evidence-hmac-v1.key'), 'utf8')).trim());
    process.stdout.write(JSON.stringify({ ok: true, checks: ['managed background startup', 'watchdog crash restart preserving namespace and lease', 'intentional stop suppresses restart', 'active export refused', 'private migration preserves course and run', 'nonempty import refused', 'new host reclaim after migration'] }) + '\n');
  } finally {
    await stopManagedService(options).catch(() => undefined);
    await stopManagedService(importedOptions).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
