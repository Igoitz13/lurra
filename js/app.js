// Lurra: página principal. Une el formulario, el mapa, el motor y el informe.

import { cargarIdioma } from "./i18n.js";
import { ErrorLurra } from "./red.js";
import { deGeoJSON, deKml, medir, validarRecinto } from "./geo.js";
import * as catastro from "./catastro.js";
import * as sigpac from "./sigpac.js";
import { AREA_MAX_M2, generarInforme, historiaSatelite, megasSatelite } from "./motor.js";
import { h, pintarInforme, seccionSatelite } from "./informe.js";
import { buscarLugar, crearMapa } from "./mapa.js";

const cfg = window.LURRA || {};
// El idioma es el de la página (<html lang>): su diccionario se descarga antes de empezar.
const L = await cargarIdioma(document.documentElement.lang || "es");
const { t } = L;
const $ = (id) => document.getElementById(id);
const DESDE = "2017-01-01";

let mapa = null;
let candidata = null; // parcela elegida en el mapa o leída de un fichero, pendiente de confirmar
let control = null; // AbortController del informe en curso
let actual = null; // { res, parcela }
let turnoMapa = 0; // número de la última consulta lanzada desde el mapa
const TITULO_PAGINA = document.title;

// ------------------------------------------------------------------ utilidades
function mensajeError(e) {
  if (e instanceof ErrorLurra) {
    const datos = { ...e.datos };
    if (datos.areaM2 != null) datos.area = L.ha(datos.areaM2);
    if (datos.maxM2 != null) datos.max = L.ha(datos.maxM2);
    const clave = `error.${e.clave}`;
    const texto = t(clave, datos);
    if (texto !== clave) return texto;
  }
  return t("error.generico", { detalle: (e && e.message) || String(e) });
}
function avisar(id, texto) {
  const el = $(id);
  if (!el) return;
  el.textContent = texto || "";
  el.hidden = !texto;
}
function contar(evento) {
  try {
    if (window.lurraContar) window.lurraContar(evento);
  } catch { /* el recuento nunca debe romper la página */ }
}
function huella(geom) {
  let hsh = 2166136261;
  const texto = JSON.stringify(geom.map((p) => p.map((a) => a.map(([x, y]) => [Math.round(x * 1e6), Math.round(y * 1e6)]))));
  for (let i = 0; i < texto.length; i++) hsh = Math.imul(hsh ^ texto.charCodeAt(i), 16777619);
  return (hsh >>> 0).toString(36);
}
// Parcelas de ejemplo que ofrece la página (botones y enlaces con data-ejemplo).
const EJEMPLOS = new Set([...document.querySelectorAll("[data-ejemplo]")].map((el) => el.dataset.ejemplo));
const esEjemplo = (parcela) => Boolean(parcela && parcela.refcat && EJEMPLOS.has(parcela.refcat));
// Caché de la serie de satélite en el almacenamiento local del navegador (30 días).
const PREFIJO_CACHE = "lurra:sat:";
const VERSION_CACHE = "v3";
const CADUCIDAD_MS = 30 * 86400000;
const serieValida = (d) => d && d.estado === "ok" && Array.isArray(d.serie) && d.serie.length > 0 && d.analisis && Array.isArray(d.analisis.eventos)
  && d.serie.every((o) => o && typeof o.fecha === "string" && Number.isFinite(o.ndvi));
const cache = {
  clave: (geom) => `${PREFIJO_CACHE}${VERSION_CACHE}:${huella(geom)}:${DESDE}`,
  leer(clave) {
    try {
      const v = JSON.parse(localStorage.getItem(clave) || "null");
      return v && Date.now() - v.t < CADUCIDAD_MS && serieValida(v.d) ? v.d : null;
    } catch { return null; }
  },
  guardar(clave, d) {
    try { localStorage.setItem(clave, JSON.stringify({ t: Date.now(), d })); } catch { /* almacenamiento lleno o bloqueado */ }
  },
  /** Borra las series caducadas, las de versiones anteriores y las ilegibles. */
  limpiar() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(PREFIJO_CACHE)) continue;
        let vale = false;
        try {
          const v = JSON.parse(localStorage.getItem(k));
          vale = k.startsWith(`${PREFIJO_CACHE}${VERSION_CACHE}:`) && v && Date.now() - v.t < CADUCIDAD_MS;
        } catch { vale = false; }
        if (!vale) localStorage.removeItem(k);
      }
    } catch { /* almacenamiento bloqueado */ }
  },
};

// --------------------------------------------------------------------- pestañas
let pestanaPedida = null; // la última pestaña elegida: si el mapa aún se está cargando, manda esa
async function activarPestana(nombre) {
  pestanaPedida = nombre;
  document.querySelectorAll("[data-pestana]").forEach((b) => {
    const activa = b.dataset.pestana === nombre;
    b.setAttribute("aria-selected", activa ? "true" : "false");
    b.tabIndex = activa ? 0 : -1;
  });
  $("panel-ref").hidden = nombre !== "ref";
  $("panel-mapa").hidden = nombre === "ref";
  if (nombre !== "ref") $("panel-mapa").setAttribute("aria-labelledby", `pestana-${nombre}`);
  if (nombre !== "ref") { try { await iniciarMapa(); } catch { return; } }
  if (nombre !== "ref" && pestanaPedida === nombre) {
    mapa.modo(nombre === "dibujo" ? "dibujo" : "clic");
    // Para elegir una parcela con un clic hacen falta las líneas del Catastro (solo hay en España).
    if (nombre === "clic" && !$("capa-catastro").checked) { $("capa-catastro").checked = true; mapa.capa("catastro", true); }
    $("herramientas-dibujo").hidden = nombre !== "dibujo";
    avisar("mapa-ayuda", t(nombre === "dibujo" ? "app.mapa.dibujar" : "app.mapa.clic"));
    setTimeout(() => mapa.ajustar(), 50);
  }
}

function proponer(parcela, texto) {
  candidata = parcela;
  mapa.mostrar(parcela.geom);
  avisar("mapa-seleccion", texto);
  $("mapa-usar").hidden = false;
  $("mapa-usar").focus({ preventScroll: true });
}

// Leaflet (la librería del mapa) solo se descarga cuando hace falta el mapa: en las portadas
// que empiezan por la referencia catastral, no frena la carga de la página.
let cargaLeaflet = null;
function cargarLeaflet() {
  if (window.L) return Promise.resolve();
  cargaLeaflet ||= new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = new URL("../vendor/leaflet/leaflet.js", import.meta.url).href;
    s.onload = ok;
    s.onerror = () => { cargaLeaflet = null; mal(new ErrorLurra("servicio", { servicio: "Leaflet" })); };
    document.head.append(s);
  });
  return cargaLeaflet;
}

async function iniciarMapa() {
  if (mapa) return;
  try { await cargarLeaflet(); } catch (e) { avisar("mapa-error", mensajeError(e)); throw e; }
  if (mapa) return;
  const datos = $("herramienta").dataset;
  const vista = (datos.vista || "").split(",").map(Number);
  mapa = crearMapa($("mapa"), {
    L: window.L,
    vista: vista.length === 3 && vista.every(Number.isFinite) ? vista : null,
    fondo: datos.fondo || "orto",
    catastro: $("capa-catastro").checked,
    alClic: async (lon, lat, zoom) => {
      const turno = ++turnoMapa; // si llega otro clic o una búsqueda, esta respuesta ya no vale
      avisar("mapa-error", "");
      if (!candidata) avisar("mapa-seleccion", ""); // quita el «Buscando…» de una consulta anterior
      if (zoom < 14) return avisar("mapa-error", t("app.mapa.acercar"));
      avisar("mapa-seleccion", t("app.buscando_parcela"));
      $("mapa-usar").hidden = true;
      candidata = null;
      try {
        // Primero el Catastro; donde no llega (territorios forales) o no responde, SIGPAC.
        const rc = await catastro.refcatEnPunto(lon, lat);
        let parcela = null;
        if (rc) {
          try { parcela = await catastro.obtenerParcela(rc.refcat); } catch { parcela = null; }
        }
        if (!parcela) parcela = await sigpac.parcelaEnPunto(lon, lat);
        if (turno !== turnoMapa) return;
        proponer(parcela, t("app.mapa.seleccionada", { id: parcela.id, area: L.ha(medir(parcela.geom).areaM2) }));
      } catch (e) {
        if (turno !== turnoMapa) return;
        avisar("mapa-seleccion", "");
        avisar("mapa-error", mensajeError(e));
      }
    },
    alDibujar: (geom) => {
      turnoMapa++;
      const problema = validarRecinto(geom);
      if (problema) {
        candidata = null;
        $("mapa-usar").hidden = true;
        avisar("mapa-seleccion", "");
        return avisar("mapa-error", mensajeError(new ErrorLurra(problema)));
      }
      avisar("mapa-error", "");
      candidata = { id: t("inf.titulo.dibujo"), origen: "dibujo", geom };
      avisar("mapa-seleccion", t("app.mapa.dibujada", { area: L.ha(medir(geom).areaM2) }));
      $("mapa-usar").hidden = false;
    },
    alCambiar: (estado) => {
      $("dib-terminar").disabled = estado.cerrado || estado.vertices < 3;
      $("dib-deshacer").disabled = estado.vertices === 0;
    },
  });
}

// ---------------------------------------------------------------------- informe
const PASOS = ["parcela", "relieve", "inundacion", "proteccion", "sigpac", "urbanismo", "cobertura", "satelite"];
function pintarProgreso(estados) {
  const lista = $("progreso-pasos");
  lista.replaceChildren(...PASOS.filter((p) => estados[p]).map((p) =>
    h("li", { class: `paso paso--${estados[p]}` }, h("span", { class: "paso__punto", "aria-hidden": "true" }), t(`app.paso.${p}`), h("span", { class: "paso__estado" }, ` · ${t(`app.estado.${estados[p]}`)}`))));
}

function enlaceInforme(parcela) {
  const u = new URL(location.href);
  u.search = ""; u.hash = "";
  if (parcela.origen === "catastro") u.searchParams.set("ref", parcela.refcat);
  else if (parcela.origen === "sigpac") {
    const c = medir(parcela.geom).centroLonLat;
    u.searchParams.set("p", `${c[0].toFixed(6)},${c[1].toFixed(6)}`);
  } else return null;
  return u.toString();
}

function pintar(res) {
  const cont = $("informe");
  cont.replaceChildren(pintarInforme(res, L, { sitio: cfg.marca || "Lurra", correo: cfg.email || "" }));
}

/** Botón para leer (o terminar de leer) la historia por satélite cuando no se hace sola. */
function ofrecerSatelite(res, ctrl, clave, conAviso) {
  const zona = $("sat-control");
  zona.replaceChildren(h("div", { class: "sat-avance" },
    h("button", { type: "button", class: "boton boton--pequeno", onclick: () => lanzarSatelite(res, ctrl) }, t(clave)),
    conAviso ? h("span", { class: "tenue" }, t("app.sat.aviso_datos", megasSatelite(DESDE))) : null));
  zona.hidden = false;
}

/**
 * Lee la historia por satélite del informe `res`. `ctrl` es el control del informe al que
 * pertenece: si el usuario pide otro informe mientras tanto, la lectura se cancela y su
 * resultado no se pinta.
 */
async function lanzarSatelite(res, ctrl) {
  const vigente = () => control === ctrl && !ctrl.signal.aborted;
  if (!vigente()) return;
  const zona = $("sat-control");
  const clave = cache.clave(res.parcela.geom);
  const guardado = cache.leer(clave);
  if (guardado) {
    res.satelite = guardado;
    pintar(res);
    zona.hidden = true;
    return;
  }
  // Control propio de la lectura («Parar aquí»), encadenado al del informe.
  const lectura = new AbortController();
  ctrl.signal.addEventListener("abort", () => lectura.abort(), { once: true });
  const parar = h("button", { type: "button", class: "boton boton--secundario boton--pequeno", onclick: () => lectura.abort() }, t("app.sat.parar"));
  const texto = h("span", {}, t("app.sat.avance", { hechas: 0, total: "…" }));
  const barra = h("progress", { max: 1, value: 0 });
  zona.replaceChildren(h("div", { class: "sat-avance" }, texto, barra, parar), h("p", { class: "sat-espera tenue" }, t("app.sat.espera")));
  zona.hidden = false;
  // Al reanudar una lectura parada, el apartado deja de decir «se detuvo».
  if (res.satelite && res.satelite.parcial) {
    const viejo = document.querySelector("#informe #s6");
    if (viejo) viejo.replaceWith(seccionSatelite({ ...res, satelite: { ...res.satelite, leyendo: { hechas: 0, total: "…" } } }, L));
  }
  let ultimoPintado = 0;
  const sat = await historiaSatelite(res, {
    desde: DESDE,
    senal: lectura.signal,
    alAvance: ({ hechas, total, satelite }) => {
      if (!vigente()) return;
      texto.textContent = t("app.sat.avance", { hechas, total });
      barra.max = total; barra.value = hechas;
      if (Date.now() - ultimoPintado > 1500 && satelite.serie.length > 1) {
        ultimoPintado = Date.now();
        const viejo = document.querySelector("#informe #s6");
        if (viejo) viejo.replaceWith(seccionSatelite({ ...res, satelite }, L));
      }
    },
  });
  if (!vigente()) return;
  // Si se para antes de leer nada, se conserva lo que ya hubiera de una lectura anterior.
  if (!(sat.estado === "omitido" && res.satelite && res.satelite.serie && res.satelite.serie.length)) res.satelite = sat;
  const completa = sat.estado === "ok" && !sat.parcial;
  // Solo se guarda una serie completa y sin demasiadas imágenes fallidas.
  if (completa && !(sat.fallos >= 6)) cache.guardar(clave, sat);
  pintar(res);
  $("informe-listo").textContent = completa ? t("app.sat.lista") : "";
  if (completa || sat.estado === "pequena" || sat.estado === "vacia") zona.hidden = true;
  else ofrecerSatelite(res, ctrl, sat.estado === "error" || sat.estado === "omitido" ? "app.sat.iniciar" : "app.sat.continuar", false);
  if (completa && !esEjemplo(res.parcela)) contar("satelite");
}

async function hacerInforme(parcela) {
  if (control) control.abort();
  const ctrl = new AbortController();
  control = ctrl;
  const senal = ctrl.signal;
  actual = null;
  $("zona-informe").hidden = false;
  $("progreso").hidden = false;
  $("acciones").hidden = true;
  $("sat-control").hidden = true;
  $("informe").replaceChildren();
  avisar("informe-error", "");
  const estados = { parcela: "en_curso" };
  pintarProgreso(estados);
  $("zona-informe").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const res = await generarInforme(parcela, {
      senal,
      idioma: L.codigo,
      alAvance: ({ paso, estado }) => { if (control === ctrl) { estados[paso] = estado; pintarProgreso(estados); } },
    });
    if (senal.aborted || control !== ctrl) return;
    actual = { res, parcela };
    pintar(res);
    $("progreso").hidden = true;
    $("acciones").hidden = false;
    const enlace = enlaceInforme(parcela);
    $("acc-enlace").hidden = !enlace;
    // Un recinto dibujado o subido no tiene enlace: la dirección no debe apuntar a otro informe.
    history.replaceState(null, "", enlace || location.pathname);
    const tituloInforme = document.querySelector(".informe h1").textContent;
    document.title = `${tituloInforme} · ${cfg.marca || "Lurra"}`;
    $("informe-listo").textContent = t("app.informe_listo", { titulo: tituloInforme }); // aviso para lectores de pantalla
    // Los informes de las parcelas de ejemplo se cuentan aparte: no miden demanda real.
    contar(esEjemplo(parcela) ? "ejemplo" : "informe");
    if (res.satelite.estado === "pendiente") {
      const conexion = navigator.connection || {};
      const ahorro = conexion.saveData || /2g|3g/.test(conexion.effectiveType || "") || conexion.type === "cellular";
      // Con datos móviles se pregunta antes de descargar, salvo que la serie ya esté guardada.
      if (ahorro && !cache.leer(cache.clave(res.parcela.geom))) ofrecerSatelite(res, ctrl, "app.sat.iniciar", true);
      else await lanzarSatelite(res, ctrl);
    }
  } catch (e) {
    if (control !== ctrl || (e instanceof ErrorLurra && e.clave === "cancelado")) return;
    $("progreso").hidden = true;
    avisar("informe-error", mensajeError(e));
  }
}

// ----------------------------------------------------------------------- inicio
function iniciar() {
  document.querySelectorAll("[data-pestana]").forEach((b) => {
    b.addEventListener("click", () => activarPestana(b.dataset.pestana));
    b.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      const todas = [...document.querySelectorAll("[data-pestana]")];
      const sig = todas[(todas.indexOf(b) + (ev.key === "ArrowRight" ? 1 : todas.length - 1)) % todas.length];
      sig.focus(); sig.click();
    });
  });

  $("form-ref").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const campo = $("ref");
    avisar("ref-error", "");
    campo.removeAttribute("aria-invalid");
    const boton = $("ref-boton");
    try {
      const rc = catastro.normalizarRefcat(campo.value);
      boton.disabled = true;
      avisar("ref-estado", t("app.buscando_parcela"));
      const parcela = await catastro.obtenerParcela(rc);
      avisar("ref-estado", "");
      hacerInforme(parcela);
    } catch (e) {
      avisar("ref-estado", "");
      avisar("ref-error", mensajeError(e));
      campo.setAttribute("aria-invalid", "true");
      campo.focus();
    } finally {
      boton.disabled = false;
    }
  });

  // Ejemplos: rellenan la referencia y piden el informe, sin recargar la página.
  document.querySelectorAll("[data-ejemplo]").forEach((el) => el.addEventListener("click", (ev) => {
    ev.preventDefault();
    activarPestana("ref");
    $("ref").value = el.dataset.ejemplo;
    $("form-ref").requestSubmit();
  }));

  $("mapa-usar").addEventListener("click", () => candidata && hacerInforme(candidata));
  $("dib-terminar").addEventListener("click", () => { if (!mapa.terminar()) avisar("mapa-error", t("error.pocos_puntos")); });
  $("dib-deshacer").addEventListener("click", () => { mapa.deshacer(); $("mapa-usar").hidden = true; avisar("mapa-seleccion", ""); });
  $("dib-borrar").addEventListener("click", () => { mapa.borrar(); candidata = null; $("mapa-usar").hidden = true; avisar("mapa-seleccion", ""); avisar("mapa-error", ""); });
  document.querySelectorAll("[name=fondo]").forEach((r) => r.addEventListener("change", () => r.checked && mapa?.capa(r.value, true)));
  $("capa-catastro").addEventListener("change", (ev) => mapa?.capa("catastro", ev.target.checked));

  $("dib-fichero").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    avisar("mapa-error", "");
    try {
      const texto = await f.text();
      const geom = /^\s*</.test(texto) ? deKml(texto) : deGeoJSON(JSON.parse(texto));
      const problema = validarRecinto(geom);
      if (problema) throw new ErrorLurra(problema);
      turnoMapa++;
      await iniciarMapa();
      mapa.borrar();
      proponer({ id: f.name.replace(/\.[^.]+$/, ""), origen: "fichero", geom }, t("app.fichero.leido", { area: L.ha(medir(geom).areaM2) }));
    } catch (e) {
      // Un fichero rechazado no deja a medias la selección anterior.
      turnoMapa++;
      candidata = null;
      $("mapa-usar").hidden = true;
      avisar("mapa-seleccion", "");
      avisar("mapa-error", e instanceof ErrorLurra ? mensajeError(e) : t("error.sin_poligonos"));
    }
    ev.target.value = "";
  });

  $("form-lugar").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = $("lugar").value.trim();
    const lista = $("lugar-resultados");
    lista.replaceChildren();
    avisar("mapa-error", "");
    if (!q) return;
    const turno = ++turnoMapa;
    if (!candidata) avisar("mapa-seleccion", "");
    // Si lo escrito tiene forma de referencia catastral, se busca la parcela directamente
    // y, si falla, se explica por qué (no se busca como si fuera el nombre de un lugar).
    let rc = null;
    try { rc = catastro.normalizarRefcat(q); } catch { rc = null; }
    if (rc) {
      try {
        const parcela = await catastro.obtenerParcela(rc);
        if (turno !== turnoMapa) return;
        return proponer(parcela, t("app.mapa.seleccionada", { id: parcela.id, area: L.ha(medir(parcela.geom).areaM2) }));
      } catch (e) {
        if (turno !== turnoMapa) return;
        candidata = null;
        $("mapa-usar").hidden = true;
        avisar("mapa-seleccion", "");
        return avisar("mapa-error", mensajeError(e));
      }
    }
    try {
      await iniciarMapa();
      const res = await buscarLugar(q, L.codigo);
      if (turno !== turnoMapa) return;
      if (!res.length) return avisar("mapa-error", t("app.mapa.sin_resultados"));
      if (res.length === 1) return res[0].caja.length === 4 ? mapa.encuadrar(res[0].caja) : mapa.irA(res[0].lat, res[0].lon);
      lista.replaceChildren(...res.map((r) => h("li", {}, h("button", { type: "button", onclick: () => { r.caja.length === 4 ? mapa.encuadrar(r.caja) : mapa.irA(r.lat, r.lon); lista.replaceChildren(); } }, r.nombre))));
    } catch {
      if (turno === turnoMapa) avisar("mapa-error", t("error.servicio", { servicio: "Nominatim" }));
    }
  });

  $("acc-imprimir").addEventListener("click", () => window.print());
  $("acc-json").addEventListener("click", () => {
    if (!actual) return;
    const blob = new Blob([JSON.stringify(actual.res, null, 1)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `lurra-${(actual.res.parcela.refcat || "recinto").toLowerCase()}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  const textoEnlace = $("acc-enlace").textContent;
  let relojEnlace = null;
  $("acc-enlace").addEventListener("click", async () => {
    const b = $("acc-enlace");
    try {
      await navigator.clipboard.writeText(location.href);
      b.textContent = t("app.enlace_copiado");
    } catch {
      b.textContent = t("app.enlace_no_copiado"); // sin permiso de portapapeles
    }
    clearTimeout(relojEnlace);
    relojEnlace = setTimeout(() => (b.textContent = textoEnlace), 2500);
  });
  $("acc-otro").addEventListener("click", () => {
    if (control) control.abort();
    control = null;
    actual = null;
    $("zona-informe").hidden = true;
    $("sat-control").hidden = true;
    $("informe-listo").textContent = "";
    document.title = TITULO_PAGINA;
    history.replaceState(null, "", location.pathname);
    document.getElementById("herramienta").scrollIntoView({ behavior: "smooth" });
    ($("panel-ref").hidden ? $("lugar") : $("ref")).focus({ preventScroll: true });
  });

  // Informe directo desde el enlace: ?ref=REFERENCIA o ?p=lon,lat
  const q = new URLSearchParams(location.search);
  if (q.get("ref")) {
    activarPestana("ref");
    $("ref").value = q.get("ref");
    $("form-ref").requestSubmit();
  } else if (q.get("p")) {
    const partes = q.get("p").split(",");
    const [lon, lat] = partes.map(Number);
    $("zona-informe").hidden = false;
    if (partes.length === 2 && partes.every((x) => x.trim() !== "") && Math.abs(lon) <= 180 && Math.abs(lat) <= 85) {
      $("progreso").hidden = false;
      pintarProgreso({ parcela: "en_curso" });
      // Si mientras tanto el usuario pide otro informe, el del enlace ya no se pinta.
      const alEmpezar = control;
      sigpac.parcelaEnPunto(lon, lat)
        .then((parcela) => { if (control === alEmpezar) hacerInforme(parcela); })
        .catch((e) => { if (control !== alEmpezar) return; $("progreso").hidden = true; avisar("informe-error", mensajeError(e)); });
    } else {
      avisar("informe-error", t("error.punto_invalido"));
    }
  }

  // Las páginas que empiezan por el mapa (las de fuera de España) lo abren ya.
  const inicial = $("herramienta").dataset.inicio;
  if (inicial && inicial !== "ref" && !q.get("ref")) activarPestana(inicial);

  // El enlace a otro idioma conserva el informe que se está viendo.
  document.querySelectorAll(".idiomas a, .pie__idiomas a").forEach((a) => a.addEventListener("click", () => {
    const u = new URL(a.href);
    u.search = location.search;
    a.href = u.toString();
  }));
  cache.limpiar();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
else iniciar();

export { AREA_MAX_M2 };
