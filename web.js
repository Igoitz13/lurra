// Lurra: rellena la página con config.js y, si está configurado, cuenta las visitas.
(function () {
  "use strict";
  var c = window.LURRA || {};
  document.querySelectorAll("[data-dato]").forEach(function (el) {
    var v = c[el.getAttribute("data-dato")];
    if (v !== undefined && v !== "") {
      el.textContent = v;
      el.classList.remove("pendiente");
    }
  });
  document.querySelectorAll("[data-si]").forEach(function (el) {
    el.hidden = !c[el.getAttribute("data-si")];
  });

  // Recuento de visitas opcional con GoatCounter (sin cookies).
  // No se carga ningún programa de terceros: se pide una imagen de un píxel con un nombre de
  // aviso fijo. No se envían la dirección de la página, sus parámetros ni la referencia o
  // las coordenadas de la finca; de la página de procedencia solo va el nombre del sitio,
  // y solo si es otra web.
  var AVISOS = { inicio: 1, informe: 1, satelite: 1 };
  window.lurraContar = function (aviso) {
    if (!c.contador || !/^[a-z0-9-]+$/i.test(c.contador) || !AVISOS[aviso]) return;
    if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname) || location.protocol === "file:") return;
    var p = "p=" + aviso + (aviso === "inicio" ? "" : "&e=true");
    if (aviso === "inicio") {
      try {
        var origen = document.referrer ? new URL(document.referrer).hostname : "";
        if (origen && origen !== location.hostname) p += "&r=" + encodeURIComponent(origen);
      } catch (e) { /* procedencia ilegible: no se envía */ }
    }
    var img = new Image();
    img.referrerPolicy = "no-referrer";
    img.src = "https://" + c.contador + ".goatcounter.com/count?" + p + "&rnd=" + Math.random().toString(36).slice(2, 8);
  };
  window.lurraContar("inicio");
})();
