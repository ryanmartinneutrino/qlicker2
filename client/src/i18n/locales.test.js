import { describe, expect, it } from 'vitest';
import deLocale from './locales/de.json';
import enLocale from './locales/en.json';
import esLocale from './locales/es.json';
import frLocale from './locales/fr.json';
import itLocale from './locales/it.json';
import pirLocale from './locales/pir.json';
import ruLocale from './locales/ru.json';
import zhLocale from './locales/zh.json';

const LOCALES = {
  de: deLocale,
  en: enLocale,
  es: esLocale,
  fr: frLocale,
  it: itLocale,
  pir: pirLocale,
  ru: ruLocale,
  zh: zhLocale,
};

function getNestedValue(obj, path) {
  return path.split('.').reduce((value, segment) => value?.[segment], obj);
}

function flattenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value).flatMap(([key, nested]) => (
    flattenKeys(nested, prefix ? `${prefix}.${key}` : key)
  ));
}

describe('locale files', () => {
  it('keeps translation structures aligned across all supported locales', () => {
    const sections = [
      'questionLibrary',
      'questions.types',
    ];

    sections.forEach((section) => {
      expect(getNestedValue(enLocale, section)).toBeTruthy();

      Object.entries(LOCALES).forEach(([localeCode, localeMessages]) => {
        expect(getNestedValue(localeMessages, section), `Missing ${section} in ${localeCode}`).toBeTruthy();
        expect(flattenKeys(getNestedValue(localeMessages, section))).toEqual(flattenKeys(getNestedValue(enLocale, section)));
      });
    });

    expect(getNestedValue(enLocale, 'questionLibrary.filters.sessionsButton')).toBe('Sessions');
    expect(getNestedValue(enLocale, 'questionLibrary.filters.sessionsDialogTitle')).toBe('Filter by sessions');
  });

  it('has full key parity with English across every locale', () => {
    const englishKeys = flattenKeys(enLocale).sort();

    Object.entries(LOCALES).forEach(([localeCode, localeMessages]) => {
      if (localeCode === 'en') {
        return;
      }
      const localeKeys = flattenKeys(localeMessages).sort();
      const missing = englishKeys.filter((key) => !localeKeys.includes(key));
      const extra = localeKeys.filter((key) => !englishKeys.includes(key));
      expect(missing, `Keys missing from ${localeCode}: ${missing.join(', ')}`).toEqual([]);
      expect(extra, `Unexpected keys in ${localeCode}: ${extra.join(', ')}`).toEqual([]);
    });
  });
});
