import { bootI18n } from './i18n-core.js';
import en from './locales/en/leave.js';
import zhTW from './locales/zh-TW/leave.js';

bootI18n({ en, "zh-TW": zhTW });
export { i18nReady, t, currentLanguage, applyI18n } from './i18n-core.js';