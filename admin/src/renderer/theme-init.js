// Applique le theme enregistre (clair/sombre) et la couleur choisie par l'utilisateur des le chargement de la page,
// avant le premier rendu : charge en <head>, sans defer, pour eviter un flash de la mauvaise couleur. Clair et couleur
// d'origine (rouge) par defaut.
(function () {
  var mode = 'light';
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') mode = saved;
  } catch (e) { /* stockage indisponible : theme par defaut */ }
  document.documentElement.dataset.theme = mode;

  // --- Couleur de l'outil (menu Apparence) ------------------------------------------------------------------------
  // Seules --accent, --accent-2 (couleur secondaire du degrade) et --on-accent (texte des boutons) sont remplacees :
  // fonds, bordures, textes et ombres en sont deduits dans styles.css et suivent donc tout seuls.
  var HEX = /^#[0-9a-f]{6}$/i;
  var KEY = 'adminAccent';

  function toRgb(hex) {
    return [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); });
  }
  function toHex(rgb) {
    return '#' + rgb.map(function (v) { return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'); }).join('');
  }
  function darken(hex, ratio) {
    return toHex(toRgb(hex).map(function (v) { return v * (1 - ratio); }));
  }
  function luminance(hex) {
    var c = toRgb(hex).map(function (v) {
      var x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function apply(hex) {
    var root = document.documentElement.style;
    if (hex && HEX.test(hex)) {
      // Couleur claire (jaune...) : degrade peu marque et texte sombre ; couleur foncee : degrade plus profond, texte blanc.
      var second = darken(hex, luminance(hex) > 0.45 ? 0.12 : 0.38);
      root.setProperty('--accent', hex);
      root.setProperty('--accent-2', second);
      root.setProperty('--on-accent', (luminance(hex) + luminance(second)) / 2 > 0.4 ? '#111114' : '#ffffff');
    } else {
      root.removeProperty('--accent');
      root.removeProperty('--accent-2');
      root.removeProperty('--on-accent');
    }
  }

  function current() {
    try {
      var value = localStorage.getItem(KEY);
      return HEX.test(value) ? value.toLowerCase() : null;
    } catch (e) { return null; }
  }

  window.adminAccent = {
    HEX: HEX,
    current: current,
    // hex = "#rrggbb" pour choisir, null pour revenir a la couleur d'origine
    set: function (hex) {
      var value = hex && HEX.test(hex) ? hex.toLowerCase() : null;
      apply(value);
      try {
        if (value) localStorage.setItem(KEY, value); else localStorage.removeItem(KEY);
      } catch (e) { /* stockage indisponible : le choix n'est simplement pas memorise */ }
      return value;
    }
  };

  apply(current());
})();
