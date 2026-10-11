#!/usr/bin/env node
//
// sync-deepl-glossary.js
//
// Provisions or refreshes the DeepL glossaries used by verba-bridge.
// Idempotent: every run converges to the state described by .env +
// config/glossary.csv.
//
// DeepL glossaries are unidirectional (one source_lang/target_lang pair
// per glossary), unlike Google's. This script creates (or refreshes) one
// glossary per configured direction (EN_TO_ZH, ZH_TO_EN):
//
//   1. Validate DEEPL_API_KEY is set
//   2. Load config/glossary.csv
//   3. For each direction: build TSV entries, delete any existing
//      glossary with the same name, create a fresh one, poll until ready,
//      and verify entry count
//   4. Print the resulting glossary ids and the .env lines to set
//
// Usage:
//   node scripts/sync-deepl-glossary.js
//
// Required env vars (read from .env):
//   DEEPL_API_KEY   your DeepL API key (":fx" suffix = free plan)
//
// Optional env vars:
//   GLOSSARY_PATH       source CSV path (default: config/glossary.csv)
//   DEEPL_API_URL       override the full /v2/translate URL (unused here,
//                       present only for parity with config.js; the host
//                       portion is re-derived from the key below)
//   POLL_TIMEOUT_SEC    max seconds to wait for a glossary to become ready
//                       (default: 60)
//   POLL_INTERVAL_SEC   poll interval in seconds (default: 2)
//
// NOTE ON LANGUAGE VARIANTS: DeepL's /translate endpoint requires regional
// target codes for some languages (e.g. target_lang=EN-US rather than
// plain EN — see src/translation/deeplTranslator.js). Glossaries, however,
// are created against the plain, non-regional codes (EN, ZH, ...). DeepL's
// documented behavior is that a glossary created for EN<->ZH applies to
// any EN-US/EN-GB variant request — but if a live translation call reports
// the glossary wasn't applied, double-check this by running a sample
// request through DeepL's API directly before assuming the glossary is
// broken.

require('dotenv').config();

const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const { loadGlossaryFromCsv } = require('../src/glossary/glossaryLoader');
const { DIRECTIONS, DIRECTION_CONFIG } = require('../src/constants');
const { resolveApiHost } = require('../src/translation/deeplTranslator');

const FREE_KEY_SUFFIX = ':fx';
const POLL_TIMEOUT_SEC = Number(process.env.POLL_TIMEOUT_SEC || 60);
const POLL_INTERVAL_SEC = Number(process.env.POLL_INTERVAL_SEC || 2);

function resolveProjectPath(input, fallbackRelativePath) {
  const value = input || fallbackRelativePath;
  return path.isAbsolute(value) ? value : path.join(ROOT_DIR, value);
}

function toBaseLanguageCode(languageCode) {
  // "en" -> "EN", "zh-CN" -> "ZH" (DeepL glossaries use plain, non-regional
  // codes even for languages whose /translate target requires a region).
  return languageCode.split('-')[0].toUpperCase();
}

function glossaryName(direction) {
  return `verba-bridge-${direction.toLowerCase()}`;
}

// DeepL glossaries require a unique source term per entry. Our glossary CSV
// is a flat 2-column list, so a word that's legitimately ambiguous (e.g.
// "Jacob" the person vs. "Jacob" the Book of Mormon book; "High Council"
// said two different ways) can appear twice with different translations
// for the same direction. Rather than fail the whole sync, keep the first
// occurrence and skip (with a warning) any later entry whose source term
// repeats with a different target.
function buildTsvEntries(entries, direction) {
  const isEnToZh = direction === DIRECTIONS.EN_TO_ZH;
  const seen = new Map();
  const skipped = [];
  const lines = [];

  entries.forEach((entry) => {
    const source = isEnToZh ? entry.english : entry.chinese;
    const target = isEnToZh ? entry.chinese : entry.english;

    if (/[\t\n\r]/.test(source) || /[\t\n\r]/.test(target)) {
      throw new Error(
        `Glossary term contains a tab or newline, which breaks DeepL's TSV format: "${source}" -> "${target}"`
      );
    }

    const key = source.toLowerCase();
    const existingTarget = seen.get(key);

    if (existingTarget === undefined) {
      seen.set(key, target);
      lines.push(`${source}\t${target}`);
    } else if (existingTarget !== target) {
      skipped.push({ source, keptTarget: existingTarget, skippedTarget: target });
    }
    // else: exact duplicate pair, silently ignored.
  });

  return { tsv: lines.join('\n'), entryCount: lines.length, skipped };
}

async function deeplRequest(apiHost, apiKey, method, urlPath, body) {
  const response = await fetch(`${apiHost}${urlPath}`, {
    method,
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  const data = rawText ? JSON.parse(rawText) : {};

  if (!response.ok) {
    const message = data.message || response.statusText;
    throw new Error(`DeepL API ${method} ${urlPath} failed (${response.status}): ${message}`);
  }

  return data;
}

async function deleteExistingGlossary(apiHost, apiKey, name) {
  const { glossaries } = await deeplRequest(apiHost, apiKey, 'GET', '/v2/glossaries');
  const existing = (glossaries || []).filter((glossary) => glossary.name === name);

  for (const glossary of existing) {
    await deeplRequest(apiHost, apiKey, 'DELETE', `/v2/glossaries/${glossary.glossary_id}`);
    console.log(`  Deleted existing glossary ${glossary.glossary_id} ("${name}")`);
  }
}

async function waitUntilReady(apiHost, apiKey, glossaryId) {
  const deadline = Date.now() + POLL_TIMEOUT_SEC * 1000;

  while (Date.now() < deadline) {
    const glossary = await deeplRequest(apiHost, apiKey, 'GET', `/v2/glossaries/${glossaryId}`);

    if (glossary.ready) {
      return glossary;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_SEC * 1000));
  }

  throw new Error(
    `Glossary ${glossaryId} did not become ready within ${POLL_TIMEOUT_SEC}s.`
  );
}

async function syncDirection(apiHost, apiKey, direction, entries) {
  const directionConfig = DIRECTION_CONFIG[direction];
  const name = glossaryName(direction);
  const sourceLang = toBaseLanguageCode(directionConfig.sourceLanguageCode);
  const targetLang = toBaseLanguageCode(directionConfig.targetLanguageCode);
  const { tsv, entryCount, skipped } = buildTsvEntries(entries, direction);

  console.log(`\n${direction}: ${sourceLang} -> ${targetLang} (${entries.length} terms, ${entryCount} unique sources)`);

  if (skipped.length > 0) {
    console.log(`  Skipping ${skipped.length} ambiguous term(s) (same source, conflicting translations):`);
    skipped.forEach(({ source, keptTarget, skippedTarget }) => {
      console.log(`    "${source}": kept "${keptTarget}", skipped "${skippedTarget}"`);
    });
  }

  await deleteExistingGlossary(apiHost, apiKey, name);

  const created = await deeplRequest(apiHost, apiKey, 'POST', '/v2/glossaries', {
    name,
    source_lang: sourceLang,
    target_lang: targetLang,
    entries: tsv,
    entries_format: 'tsv',
  });

  console.log(`  Created glossary ${created.glossary_id}`);

  const ready = await waitUntilReady(apiHost, apiKey, created.glossary_id);

  if (ready.entry_count !== entryCount) {
    throw new Error(
      `Entry count mismatch for ${direction}: DeepL reports ${ready.entry_count}, expected ${entryCount} unique entries.`
    );
  }

  console.log(`  Ready. entry_count=${ready.entry_count}`);

  return {
    direction,
    envVar: `DEEPL_GLOSSARY_ID_${direction}`,
    glossaryId: created.glossary_id,
  };
}

async function main() {
  const apiKey = process.env.DEEPL_API_KEY;

  if (!apiKey) {
    throw new Error('DEEPL_API_KEY is required (set it in .env).');
  }

  const apiHost = resolveApiHost(apiKey);
  const isFree = apiKey.endsWith(FREE_KEY_SUFFIX);
  console.log(`Using DeepL ${isFree ? 'Free' : 'Pro'} API at ${apiHost}`);

  const glossaryPath = resolveProjectPath(process.env.GLOSSARY_PATH, 'config/glossary.csv');
  const entries = loadGlossaryFromCsv(glossaryPath);

  if (entries.length === 0) {
    throw new Error(`No glossary entries found in ${glossaryPath}.`);
  }

  console.log(`Loaded ${entries.length} terms from ${glossaryPath}`);

  const results = [];
  for (const direction of Object.keys(DIRECTION_CONFIG)) {
    results.push(await syncDirection(apiHost, apiKey, direction, entries));
  }

  console.log('\nDone. Set these in .env:\n');
  results.forEach(({ envVar, glossaryId }) => {
    console.log(`${envVar}=${glossaryId}`);
  });
}

main().catch((error) => {
  console.error(`\nsync-deepl-glossary failed: ${error.message}`);
  process.exitCode = 1;
});
