// Moteur de traduction minimaliste : `t(key, ...args)` retourne la chaine
// traduite dans la langue courante (branding.language, "fr" par defaut),
// avec repli sur le francais puis sur la cle elle-meme si introuvable.
let currentLang = 'fr';

function setLanguage(lang) {
  currentLang = window.LOCALES[lang] ? lang : 'fr';
}

function t(key, ...args) {
  const dict = window.LOCALES[currentLang] || window.LOCALES.fr;
  const entry = dict[key] ?? window.LOCALES.fr[key];
  if (entry === undefined) return key;
  return typeof entry === 'function' ? entry(...args) : entry;
}

// Applique les traductions statiques du DOM : `data-i18n` (textContent),
// `data-i18n-placeholder` (attribut placeholder). A rappeler apres tout
// changement de langue.
function applyStaticTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}
