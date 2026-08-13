import { bootI18n } from './i18n-core.js';
import en from './locales/en/new-student-list.js';
import zhTW from './locales/zh-TW/new-student-list.js';

bootI18n({ en, "zh-TW": zhTW });
export { i18nReady, t, currentLanguage, applyI18n } from './i18n-core.js';