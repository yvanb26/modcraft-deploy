// Applique le theme enregistre (clair/sombre) des le chargement de la page,
// avant le premier rendu : charge en <head>, sans defer, pour eviter un
// flash de la mauvaise couleur. Sombre par defaut.
(function () {
  var mode = 'dark';
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') mode = saved;
  } catch (e) { /* stockage indisponible : theme par defaut */ }
  document.documentElement.dataset.theme = mode;
})();
