/**
 * Codex custom-model catalog injection (`--config model_catalog_json=...`).
 *
 * The CLI logs "Model metadata for deepseek-flash not found. Defaulting to
 * fallback metadata" for routed custom models with no built-in catalog entry.
 * The injected catalog removes that fallback path. Because the flag REPLACES
 * the built-in catalog wholesale, it must stay gated per-model and reserved
 * against free-form cliConfigArgs.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const { CodexAgentService: ProductionCodexAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/CodexAgentService.js'
);
const { CODEX_CUSTOM_MODEL_CATALOG_ENTRIES, buildCodexModelCatalogFileContent } = await import(
  '../dist/domains/cats/services/agents/providers/codex-model-catalog.js'
);

class CodexAgentService extends ProductionCodexAgentService {
  constructor(options = {}) {
    super({ ...options, cliCommand: process.execPath });
  }
}

function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') {
      process.nextTick(() => originalEmit('close', ...args));
    }
    return emitted;
  };
  const proc = {
    stdout,
    stderr,
    stdin: { write: () => true, end: () => {}, on: () => proc.stdin },
    pid: 12345,
    exitCode: null,
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
  };
  proc.kill = mock.fn(() => true);
  return proc;
}

/**
 * Defer the scripted events until spawn has attached its listeners; emitting
 * before the spawn call races the generator's pre-spawn awaits (first config
 * load can outlive a bare setImmediate).
 */
function createDeferredSpawnFn(proc, threadId) {
  return mock.fn(() => {
    setImmediate(() => emitCodexEvents(proc, [{ type: 'thread.started', thread_id: threadId }]));
    return proc;
  });
}

function emitCodexEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  setImmediate(() => {
    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);
  });
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function findCatalogPath(args) {
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === '--config' && typeof args[i + 1] === 'string' && args[i + 1].startsWith('model_catalog_json=')) {
      return args[i + 1].slice('model_catalog_json='.length);
    }
  }
  return null;
}

describe('codex custom-model catalog injection', () => {
  test('injects the catalog for a custom model and materializes valid JSON', async () => {
    const proc = createMockProcess();
    const spawnFn = createDeferredSpawnFn(proc, 't-catalog-custom');
    const service = new CodexAgentService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn,
      catId: 'runtime-sol',
      model: 'deepseek-flash',
    });

    const promise = collect(service.invoke('hello', {}));
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const path = findCatalogPath(args);
    assert.ok(path, `catalog flag missing from argv: ${JSON.stringify(args)}`);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const entry = parsed.models.find((item) => item.slug === 'deepseek-flash');
    assert.ok(entry, 'catalog must contain the deepseek-flash entry');
    assert.equal(
      entry.model_messages.instructions_template.includes('{{'),
      false,
      'instructions template must be pre-rendered fallback text',
    );
    assert.ok(entry.model_messages.instructions_template.includes('Codex CLI'));
    assert.ok(entry.supported_reasoning_levels.some((level) => level.effort === 'max'));
  });

  test('does not inject the catalog for builtin models', async () => {
    const proc = createMockProcess();
    const spawnFn = createDeferredSpawnFn(proc, 't-catalog-builtin');
    const service = new CodexAgentService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn,
      catId: 'runtime-sol',
      model: 'gpt-5.6-sol',
    });

    const promise = collect(service.invoke('hello', {}));
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(findCatalogPath(args), null, `builtin model must not get a catalog: ${JSON.stringify(args)}`);
  });

  test('reserved: free-form cliConfigArgs cannot override model_catalog_json', async () => {
    const proc = createMockProcess();
    const spawnFn = createDeferredSpawnFn(proc, 't-catalog-reserved');
    const service = new CodexAgentService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn,
      catId: 'runtime-sol',
      model: 'deepseek-flash',
    });

    const promise = collect(
      service.invoke('hello', {
        cliConfigArgs: [
          '--config model_catalog_json=/tmp/evil.json',
          '-c=model_catalog_json=/tmp/evil2.json',
          '--config=model_catalog_json=/tmp/evil3.json',
        ],
      }),
    );
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const catalogArgs = args.filter((arg) => typeof arg === 'string' && arg.startsWith('model_catalog_json='));
    assert.equal(catalogArgs.length, 1, `exactly the system catalog pair must survive: ${JSON.stringify(args)}`);
    assert.ok(!catalogArgs[0].includes('evil'), 'user-supplied catalog path must not survive');
  });

  test('module catalog entries carry the CLI-required schema fields', () => {
    const requiredFields = [
      'slug',
      'display_name',
      'supported_reasoning_levels',
      'shell_type',
      'visibility',
      'supported_in_api',
      'priority',
      'support_verbosity',
      'truncation_policy',
      'supports_parallel_tool_calls',
      'experimental_supported_tools',
      'model_messages',
    ];
    for (const [slug, entry] of Object.entries(CODEX_CUSTOM_MODEL_CATALOG_ENTRIES)) {
      assert.equal(entry.slug, slug, 'entry slug must match its map key');
      for (const field of requiredFields) {
        assert.ok(field in entry, `entry ${slug} is missing ${field}`);
      }
    }
    const parsed = JSON.parse(buildCodexModelCatalogFileContent());
    assert.deepEqual(
      parsed.models.map((item) => item.slug).sort(),
      Object.keys(CODEX_CUSTOM_MODEL_CATALOG_ENTRIES).sort(),
    );
  });
});
