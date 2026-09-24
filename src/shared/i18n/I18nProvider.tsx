import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";

import { i18n } from "./i18n";
import {
  getStoredLocalePreference,
  detectSystemLocale,
  setDocumentLocale,
  normalizeLocale,
  getInitialLocale,
} from "./locale";
import { DEFAULT_LOCALE } from "./constants";

export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const syncDocumentLanguage = (language: string) => {
      setDocumentLocale(normalizeLocale(language) ?? DEFAULT_LOCALE);
    };

    syncDocumentLanguage(i18n.resolvedLanguage ?? DEFAULT_LOCALE);
    const syncStoredLanguage = () => {
      void i18n.changeLanguage(getInitialLocale());
    };
    syncStoredLanguage();

    const handleLanguageChanged = (language: string) => {
      syncDocumentLanguage(language);
    };

    const handleSystemLanguageChanged = () => {
      if (getStoredLocalePreference()) return;
      void i18n.changeLanguage(detectSystemLocale());
    };

    i18n.on("languageChanged", handleLanguageChanged);
    window.addEventListener("languagechange", handleSystemLanguageChanged);
    window.addEventListener("storage", syncStoredLanguage);

    return () => {
      i18n.off("languageChanged", handleLanguageChanged);
      window.removeEventListener("languagechange", handleSystemLanguageChanged);
      window.removeEventListener("storage", syncStoredLanguage);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
