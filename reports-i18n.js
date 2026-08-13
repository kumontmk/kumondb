import { bootI18n } from './i18n-core.js';
import en from './locales/en/reports.js';
import zhTW from './locales/zh-TW/reports.js';

bootI18n({ en, "zh-TW": zhTW });
export { i18nReady, t, currentLanguage, applyI18n } from './i18n-core.js';