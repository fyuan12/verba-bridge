const FREE_KEY_SUFFIX = ':fx';
const FREE_API_HOST = 'https://api-free.deepl.com';
const PRO_API_HOST = 'https://api.deepl.com';

// DeepL's source codes don't carry a region (EN, ZH, ...), but several
// target codes require one (EN-US/EN-GB, PT-BR/PT-PT, ...). zh-CN maps to
// plain ZH, which DeepL returns as simplified Chinese by default.
const SOURCE_LANG_MAP = {
  en: 'EN',
  'zh-cn': 'ZH',
};

const TARGET_LANG_MAP = {
  en: 'EN-US',
  'zh-cn': 'ZH',
};

function mapLanguageCode(map, code, kind) {
  const normalized = (code || '').toLowerCase();
  const mapped = map[normalized];

  if (!mapped) {
    throw new Error(
      `Unsupported DeepL ${kind} language code "${code}". Add it to the mapping in deeplTranslator.js.`
    );
  }

  return mapped;
}

// Shared with scripts/sync-deepl-glossary.js so both the runtime translator
// and the glossary provisioning script route to the same API host for a
// given key.
function resolveApiHost(apiKey) {
  return apiKey.endsWith(FREE_KEY_SUFFIX) ? FREE_API_HOST : PRO_API_HOST;
}

function glossaryKey(sourceLanguageCode, targetLanguageCode) {
  return `${(sourceLanguageCode || '').toLowerCase()}>${(targetLanguageCode || '').toLowerCase()}`;
}

class DeepLTranslator {
  constructor({ apiKey, apiUrl, glossaryIds }) {
    if (!apiKey) {
      throw new Error('DEEPL_API_KEY is required when TRANSLATION_PROVIDER=deepl.');
    }

    this.apiKey = apiKey;
    this.apiUrl = apiUrl || `${resolveApiHost(apiKey)}/v2/translate`;
    // Keyed by "<sourceLanguageCode>>` + `<targetLanguageCode>` (both
    // lowercase, e.g. "en>zh-cn") because DeepL glossaries are
    // unidirectional: EN->ZH and ZH->EN need separate glossary resources.
    this.glossaryIds = glossaryIds || {};
  }

  async translate(text, { sourceLanguageCode, targetLanguageCode }) {
    if (!text || !text.trim()) {
      return {
        translatedText: '',
        usedGlossary: false,
      };
    }

    const sourceLang = mapLanguageCode(SOURCE_LANG_MAP, sourceLanguageCode, 'source');
    const targetLang = mapLanguageCode(TARGET_LANG_MAP, targetLanguageCode, 'target');
    const glossaryId = this.glossaryIds[glossaryKey(sourceLanguageCode, targetLanguageCode)];

    const body = new URLSearchParams();
    body.append('text', text);
    body.append('source_lang', sourceLang);
    body.append('target_lang', targetLang);

    if (glossaryId) {
      body.append('glossary_id', glossaryId);
    }

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${this.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `DeepL translation request failed (${response.status}): ${errorBody || response.statusText}`
      );
    }

    const data = await response.json();
    const translatedText = data.translations?.[0]?.text || '';

    return {
      translatedText,
      // DeepL doesn't report per-request glossary usage; if a glossary id
      // was attached and the request succeeded, assume it was applied.
      usedGlossary: Boolean(glossaryId),
    };
  }
}

module.exports = DeepLTranslator;
module.exports.resolveApiHost = resolveApiHost;
