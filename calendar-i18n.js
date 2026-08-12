import { bootI18n } from './i18n-core.js';
import en from './locales/en/calendar.js';
import zhTW from './locales/zh-TW/calendar.js';

bootI18n({ en, "zh-TW": zhTW });
export { i18nReady, t, currentLanguage, applyI18n } from './i18n-core.js';