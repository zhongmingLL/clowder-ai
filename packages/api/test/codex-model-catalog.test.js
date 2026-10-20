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
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const { CodexAgentService: ProductionCodexAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/CodexAgentService.js'
);
const { CODEX_CUSTOM_MODEL_CATALOG_ENTRIES, buildCodexModelCatalogArgs, buildCodexModelCatalogFileContent } =
  await import('../dist/domains/cats/services/agents/providers/codex-model-catalog.js');

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
      'context_window',
      'max_context_window',
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

  // Codex pins both windows to 272_000 for models missing from its own catalog
  // and then applies `min(--config model_context_window, max_context_window)`,
  // so a configured 1M window was silently clamped to 272_000 (258_400 usable).
  // The entry must therefore declare the native window, and it must reach the
  // serialized file — a value readable only from the typed constant would not
  // change what the CLI sees.
  // Regression for a P1 caught in review: the line array was joined with
  // "'\n'" (quote + newline + quote) instead of "\n", so every one of the 274
  // line boundaries carried a stray pair of quotes into the system prompt that
  // is sent on every deepseek-flash invocation. The catalog file is what the
  // CLI actually reads, so assert on the serialized artifact rather than the
  // typed constant.
  test('fallback instructions template survives serialization byte-identically', () => {
    const parsed = JSON.parse(buildCodexModelCatalogFileContent());
    for (const item of parsed.models) {
      const template = item.model_messages.instructions_template;
      assert.equal(typeof template, 'string', `entry ${item.slug} must carry a template`);
      assert.ok(!template.includes("'\n'"), 'template must not contain a quote-wrapped join separator');
      assert.ok(!/(?:^|\n)'|'(?:\n|$)/.test(template), 'no line may start or end with a stray quote');
      // Byte-identical to the fallback template extracted from codex-cli
      // 0.163.0. A different join separator changes this length silently.
      assert.equal(template.length, 20_750, 'template must stay byte-identical to the CLI fallback text');
    }
  });

  // The snapshot is a pinned upstream asset, not a hand-maintained paraphrase:
  // openai/codex rust-v0.163.0 codex-rs/models-manager/prompt.md with its single
  // trailing LF removed. If this hash changes, update the source pin and the
  // sync script output together.
  test('fallback instructions snapshot matches the pinned upstream source hash', () => {
    const parsed = JSON.parse(buildCodexModelCatalogFileContent());
    const template = parsed.models[0].model_messages.instructions_template;
    assert.equal(
      createHash('sha256').update(template, 'utf8').digest('hex'),
      'ebfcbdce4a6c353e85d6cde37e508b89c77a902bd27771c91caba5fd494bdb83',
      'fallback instructions must stay byte-identical to the pinned upstream prompt.md',
    );
  });

  test('does not inject the catalog on the app_server carrier', () => {
    assert.deepEqual(
      buildCodexModelCatalogArgs('deepseek-flash', 'app_server'),
      [],
      'app_server does not receive the per-invocation window override, so it must not get the catalog',
    );
    assert.ok(
      buildCodexModelCatalogArgs('deepseek-flash', 'exec_json').length > 0,
      'exec_json must still receive the catalog',
    );
  });

  test('custom entries declare the native window that the CLI actually clamps against', () => {
    const parsed = JSON.parse(buildCodexModelCatalogFileContent());
    for (const item of parsed.models) {
      assert.equal(item.context_window, 1_000_000, `entry ${item.slug} must advertise the native 1M window`);
      assert.equal(
        item.max_context_window,
        1_000_000,
        `entry ${item.slug} must not lower the configurable ceiling (Codex clamps with min())`,
      );
      assert.equal(
        item.context_window,
        item.max_context_window,
        `entry ${item.slug} default window must equal its ceiling`,
      );
    }
  });
});
