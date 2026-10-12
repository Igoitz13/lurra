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
  // Las visitas y los informes de las páginas que no están en castellano llevan además el
  // código de idioma de la página («inicio-de», «informe-fr»…), para saber cuáles se usan.
  var AVISOS = { inicio: 1, informe: 1, ejemplo: 1, satelite: 1 };
  var IDIOMA = (document.documentElement.lang || "es").toLowerCase();
  window.lurraContar = function (aviso) {
    if (!c.contador || !/^[a-z0-9-]+$/i.test(c.contador) || !AVISOS[aviso]) return;
    if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname) || location.protocol === "file:") return;
    var nombre = aviso + ((aviso === "inicio" || aviso === "informe") && IDIOMA !== "es" && /^[a-z0-9-]{2,10}$/.test(IDIOMA) ? "-" + IDIOMA : "");
    var p = "p=" + nombre + (aviso === "inicio" ? "" : "&e=true");
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

  // Menú de idiomas: se cierra al pulsar fuera o con Escape.
  var menu = document.querySelector("details.idiomas");
  if (menu) {
    document.addEventListener("click", function (ev) { if (menu.open && !menu.contains(ev.target)) menu.open = false; });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && menu.open) { menu.open = false; menu.querySelector("summary").focus(); }
    });
  }

  // Si la página existe en el idioma del navegador y no es esta, se ofrece con un enlace
  // (nunca se redirige sola). La lista de idiomas la deja idiomas.js en LURRA_IDIOMAS.
  var lista = window.LURRA_IDIOMAS;
  var cima = document.querySelector(".cima");
  if (lista && cima && !cima.classList.contains("cima--texto")) {
    var codigos = {};
    Object.keys(lista).forEach(function (k) { codigos[k.toLowerCase()] = k; });
    var mejor = function (pedido) {
      var x = String(pedido || "").toLowerCase();
      var base = x.split("-")[0];
      if (codigos[x]) return codigos[x];
      if (base === "zh") return codigos[/hant|-tw|-hk|-mo/.test(x) ? "zh-hant" : "zh-hans"];
      if (base === "es") return codigos[x === "es" || x === "es-es" ? "es" : "es-419"] || codigos.es;
      if (base === "no" || base === "nn") return codigos.nb;
      if (base === "tl") return codigos.fil;
      if (base === "iw") return codigos.he;
      if (base === "in") return codigos.id;
      return codigos[base];
    };
    var preferidos = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    var elegido = null;
    for (var i = 0; i < preferidos.length && !elegido; i++) elegido = mejor(preferidos[i]) || null;
    if (elegido && elegido.toLowerCase() !== IDIOMA) {
      var raiz = document.currentScript ? document.currentScript.src.replace(/web\.js(\?.*)?$/, "") : "";
      var aviso = document.createElement("p");
      aviso.className = "aviso-idioma";
      aviso.lang = elegido;
      var enlace = document.createElement("a");
      enlace.href = raiz + lista[elegido][2] + location.search;
      enlace.hreflang = elegido;
      enlace.textContent = lista[elegido][1];
      var cerrar = document.createElement("button");
      cerrar.type = "button";
      cerrar.setAttribute("aria-label", "×");
      cerrar.textContent = "×";
      cerrar.addEventListener("click", function () { aviso.remove(); });
      aviso.appendChild(enlace);
      aviso.appendChild(cerrar);
      cima.insertBefore(aviso, cima.firstChild);
    }
  }
})();
