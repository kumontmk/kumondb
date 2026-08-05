import { bootI18n } from './i18n-core.js';
import en from './locales/en/student-form.js';
import zhTW from './locales/zh-TW/student-form.js';

bootI18n({ en, "zh-TW": zhTW });
export { i18nReady, t, currentLanguage, applyI18n } from './i18n-core.js';