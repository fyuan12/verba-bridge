const FREE_KEY_SUFFIX = ':fx';
const FREE_API_URL = 'https://api-free.deepl.com/v2/translate';
const PRO_API_URL = 'https://api.deepl.com/v2/translate';

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

function resolveApiUrl(apiKey, explicitUrl) {
  if (explicitUrl) {
    return explicitUrl;
  }

  return apiKey.endsWith(FREE_KEY_SUFFIX) ? FREE_API_URL : PRO_API_URL;
}

class DeepLTranslator {
  constructor({ apiKey, apiUrl, glossaryId }) {
    if (!apiKey) {
      throw new Error('DEEPL_API_KEY is required when TRANSLATION_PROVIDER=deepl.');
    }

    this.apiKey = apiKey;
    this.apiUrl = resolveApiUrl(apiKey, apiUrl);
    this.glossaryId = glossaryId || '';
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

    const body = new URLSearchParams();
    body.append('text', text);
    body.append('source_lang', sourceLang);
    body.append('target_lang', targetLang);

    if (this.glossaryId) {
      body.append('glossary_id', this.glossaryId);
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
      usedGlossary: Boolean(this.glossaryId),
    };
  }
}

module.exports = DeepLTranslator;
