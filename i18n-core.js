// i18n-core.js
import i18next from "https://cdn.jsdelivr.net/npm/i18next@23.11.5/+esm";
import LanguageDetector from "https://cdn.jsdelivr.net/npm/i18next-browser-languagedetector@7.2.1/+esm";

const LANGUAGE_STORAGE_KEY = "kumonLanguage";

// ============================================
// COMMON KEYS (shared by ALL pages)
// ============================================
const common = {
  en: {
    language: "Language",
    logout: "Logout",
    loggingOut: "Logging out...",
    loading: "Loading...",
    unknown: "Unknown",
    saving: "Saving...",
    saved: "✅ Saved!",
    saveNote: "💾 Save Note",
    saveChanges: "💾 Save Changes",
    cancel: "Cancel",
    close: "Close"
  },
  "zh-TW": {
    language: "語言",
    logout: "登出",
    loggingOut: "登出中...",
    loading: "載入中...",
    unknown: "未知",
    saving: "儲存中...",
    saved: "✅ 已儲存！",
    saveNote: "💾 儲存備註",
    saveChanges: "💾 儲存變更",
    cancel: "取消",
    close: "關閉"
  }
};

// ============================================
// CORE API
// ============================================
export let i18nReady = Promise.resolve();

export function bootI18n(pageResources = {}) {
  const resources = {};

  for (const lng of ["en", "zh-TW"]) {
    resources[lng] = {
      translation: {
        // Nest common keys under "common" so t('common.loading') works
        common: common[lng],
        // Spread page-specific keys at the top level (e.g., t('dashboard.title'))
        ...(pageResources[lng] || {})
      }
    };
  }

  i18nReady = i18next
    .use(LanguageDetector)
    .init({
      resources,
      fallbackLng: "en",
      supportedLngs: ["en", "zh-TW"],
      load: "currentOnly",
      interpolation: { escapeValue: false },
      detection: {
        order: ["localStorage", "navigator"],
        caches: ["localStorage"],
        lookupLocalStorage: LANGUAGE_STORAGE_KEY,
        convertDetectedLanguage: (lng) =>
          String(lng || "").toLowerCase().startsWith("zh") ? "zh-TW" : "en"
      }
    })
    .catch((err) => console.error("i18n init failed:", err));

  bootDom();
  return i18nReady;
}

export const t = (key, options) => i18next.t(key, options);
export const currentLanguage = () => i18next.language || "en";

export function applyI18n(root = document) {
  if (!root) return;

  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });

  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.placeholder = t(key);
  });

  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.title = t(key);
  });

  root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria-label");
    if (key) el.setAttribute("aria-label", t(key));
  });
}

// ============================================
// DOM BOOT (static text + language switch)
// ============================================
function bootDom() {
  i18next.on("languageChanged", (lng) => {
    document.documentElement.lang = lng;
    applyI18n();
  });

  const start = () => {
    i18nReady.then(() => {
      document.documentElement.lang = currentLanguage();
      applyI18n();

      const switcher = document.getElementById("languageSwitch");
      if (switcher) {
        switcher.value = currentLanguage();
        switcher.addEventListener("change", async (e) => {
          const lng = e.target.value;
          if (lng === currentLanguage()) return;
          localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
          await i18next.changeLanguage(lng);
          window.location.reload();
        });
      }
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}