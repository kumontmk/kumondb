// ashr-i18n.js
import { bootI18n } from './i18n-core.js';
import * as core from './i18n-core.js';
import en from './locales/en/ashr.js';
import zhTW from './locales/zh-TW/ashr.js';

bootI18n({ en, "zh-TW": zhTW });

// Keep the same exports your pages already use
export const i18nReady = core.i18nReady;
export const t = core.t;
export const currentLanguage = core.currentLanguage;
export const applyI18n = core.applyI18n;

// ✅ Language helpers that stay in sync with i18n-core no matter
//    which localStorage key the core uses internally.
export function getLang() {
  if (core.getLang) return core.getLang();
  const cl = typeof core.currentLanguage === 'function' ? core.currentLanguage() : core.currentLanguage;
  if (cl === 'zh-TW' || cl === 'en') return cl;
  return localStorage.getItem('lang') || 'en';
}
export function setLang(lang) {
  if (core.setLang) { core.setLang(lang); return; }
  // Fallback: update every localStorage entry that currently holds a language
  // code, so i18n-core picks the change up on next page boot.
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k);
    if (v === 'en' || v === 'zh-TW' || v === 'zh' || v === 'zh-CN') localStorage.setItem(k, lang);
  }
  localStorage.setItem('lang', lang);
}