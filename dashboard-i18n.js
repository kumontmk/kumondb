// dashboard-i18n.js
import { bootI18n } from './i18n-core.js';
import en from './locales/en/dashboard.js';
import zhTW from './locales/zh-TW/dashboard.js';

bootI18n({ en, "zh-TW": zhTW });

export { i18nReady, t, currentLanguage, applyI18n } from './i18n-core.js';