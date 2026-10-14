/**
 * Codex custom-model catalog injection.
 *
 * The Codex CLI resolves per-model metadata (context window, capabilities,
 * instructions template) from a built-in catalog keyed by model slug. Models
 * routed through Clowder AI that have no built-in entry (e.g. `deepseek-flash`)
 * silently fall back to generic metadata and log a startup warning
 * ("Model metadata for <slug> not found. Defaulting to fallback metadata").
 *
 * `--config model_catalog_json=<path>` points the CLI at a catalog file, but it
 * REPLACES the built-in catalog wholesale (verified against codex-cli 0.147.0:
 * with a 1-entry file, `codex debug models` lists only that model). The flag is
 * therefore injected per-model: only invocations whose effective model is a
 * custom entry get it; builtin models must never receive it.
 *
 * The catalog's `instructions_template` is the CLI's own captured fallback text
 * (see ./codex-model-catalog-instructions.ts) so the model receives exactly the
 * same instructions it got under fallback metadata.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeModelSlug } from '@cat-cafe/shared';
import { CODEX_FALLBACK_MODEL_INSTRUCTIONS } from './codex-model-catalog-instructions.js';

export interface CodexModelCatalogEntry {
  slug: string;
  display_name: string;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  support_verbosity: boolean;
  truncation_policy: { mode: string; limit: number };
  supports_parallel_tool_calls: boolean;
  experimental_supported_tools: string[];
  model_messages: { instructions_template: string };
}

/**
 * `max` is listed because Clowder AI cats may run this model at `max` effort
 * (`CLI_EFFORT_VALUES`); the entry must not contradict the requested effort.
 */
const DEEPSEEK_FLASH_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
  { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
];

export const CODEX_CUSTOM_MODEL_CATALOG_ENTRIES: Readonly<Record<string, CodexModelCatalogEntry>> = {
  'deepseek-flash': {
    slug: 'deepseek-flash',
    display_name: 'DeepSeek Flash',
    supported_reasoning_levels: DEEPSEEK_FLASH_REASONING_LEVELS,
    shell_type: 'shell_command',
    visibility: 'hide',
    supported_in_api: true,
    priority: 23,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    // Parity with the fallback metadata Codex used before this entry existed
    // (captured request body: parallel_tool_calls=false).
    supports_parallel_tool_calls: false,
    experimental_supported_tools: [],
    model_messages: { instructions_template: CODEX_FALLBACK_MODEL_INSTRUCTIONS },
  },
};

/** Serialized catalog file content (stable: entries are module constants). */
export function buildCodexModelCatalogFileContent(): string {
  return `${JSON.stringify({ models: Object.values(CODEX_CUSTOM_MODEL_CATALOG_ENTRIES) }, null, 2)}\n`;
}

/** Content-addressed path: identical content reuses one file; new content never mutates it. */
export function resolveCodexModelCatalogPath(content: string): string {
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return join(tmpdir(), 'cat-cafe-codex-model-catalog', `${digest}.json`);
}

/**
 * Server-owned argv pair for custom models, or `[]` for everything else.
 * Materialization failures degrade to `[]` (the CLI then uses fallback
 * metadata again — a warning, not an outage), never to a failed launch.
 */
export function buildCodexModelCatalogArgs(model: string | null | undefined): string[] {
  const slug = normalizeModelSlug(model);
  if (!slug || !(slug in CODEX_CUSTOM_MODEL_CATALOG_ENTRIES)) return [];
  try {
    const content = buildCodexModelCatalogFileContent();
    const path = resolveCodexModelCatalogPath(content);
    materializeCodexModelCatalog(content, path);
    return ['--config', `model_catalog_json=${path}`];
  } catch {
    return [];
  }
}

function materializeCodexModelCatalog(content: string, path: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, path);
}
