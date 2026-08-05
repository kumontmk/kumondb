// centers-i18n.js
import { bootI18n } from './i18n-core.js';
import en from './locales/en/centers.js';
import zhTW from './locales/zh-TW/centers.js';

bootI18n({ en, "zh-TW": zhTW });

// Keep the same exports your centers.js already uses
export { i18nReady, t, currentLanguage, applyI18n } from './i18n-core.js';