// Pinta el informe en la página a partir del resultado del motor. Todo el texto que viene
// de los servicios se inserta como texto, nunca como HTML.

import { aMercator, MEDIO_MUNDO, resolucionMercator } from "./geo.js";
import { evaluar } from "./semaforo.js";
import { CAPAS_TESELA } from "./teselas.js";
import { urlInundacion } from "./mundo.js";

const SVG = "http://www.w3.org/2000/svg";
let contador = 0;

/** Crea un elemento. `hijos` admite nodos, textos, null y listas. */
export function h(etiqueta, atributos = {}, ...hijos) {
  const el = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(atributos || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  const anadir = (x) => {
    if (x === null || x === undefined || x === false) return;
    if (Array.isArray(x)) x.forEach(anadir);
    else el.appendChild(x instanceof Node ? x : document.createTextNode(String(x)));
  };
  hijos.forEach(anadir);
  return el;
}
function s(etiqueta, atributos = {}, ...hijos) {
  const el = document.createElementNS(SVG, etiqueta);
  for (const [k, v] of Object.entries(atributos)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  hijos.flat().forEach((x) => x != null && el.appendChild(x instanceof Node ? x : document.createTextNode(String(x))));
  return el;
}

function tabla(cabeceras, filas, { clase = "", numericas = [] } = {}) {
  return h("div", { class: "tabla-marco" },
    h("table", { class: `tabla ${clase}` },
      cabeceras ? h("thead", {}, h("tr", {}, cabeceras.map((c, i) => h("th", { scope: "col", class: numericas.includes(i) ? "num" : null }, c)))) : null,
      h("tbody", {}, filas.map((f) => h("tr", { class: f.clase || null }, (f.celdas || f).map((c, i) => h(i === 0 && !cabeceras ? "th" : "td", { scope: i === 0 && !cabeceras ? "row" : null, class: numericas.includes(i) ? "num" : null }, c)))))));
}

// --------------------------------------------------------------------- mapas
const IEPNB = "https://geoserver.iepnb.es/geoserver";
const TINTES = {
  t500: "0 0 0 0 0.61  0 0 0 0 0.76  0 0 0 0 0.94  0 0 0 0.85 0",
  t100: "0 0 0 0 0.25  0 0 0 0 0.53  0 0 0 0 0.85  0 0 0 0.85 0",
  t10: "0 0 0 0 0.09  0 0 0 0 0.31  0 0 0 0 0.58  0 0 0 0.9 0",
  verde: "0 0 0 0 0.12  0 0 0 0 0.54  0 0 0 0 0.38  0 0 0 0.55 0",
};

/**
 * Mapa estático en SVG: teselas de fondo, capas superpuestas y el contorno de la parcela.
 * `encuadre` es la fracción del marco que ocupa la parcela (menor = más contexto).
 */
export function figuraMapa(res, { fondo, zMaxFondo, encuadre = 0.6, inundacion = false, protegidos = null, ancho = 720, alto = 470, etiqueta = "" }) {
  const id = `m${++contador}`;
  const [lon0, lat0, lon1, lat1] = res.parcela.caja;
  const [mx0, my0] = aMercator(lon0, lat0);
  const [mx1, my1] = aMercator(lon1, lat1);
  const necesario = Math.max((mx1 - mx0) / (ancho * encuadre), (my1 - my0) / (alto * encuadre), 1e-9);
  const z = Math.max(3, Math.min(20, Math.floor(Math.log2((2 * MEDIO_MUNDO) / 256 / necesario))));
  const r = resolucionMercator(z);
  const px0 = ((mx0 + mx1) / 2 + MEDIO_MUNDO) / r - ancho / 2;
  const py0 = (MEDIO_MUNDO - (my0 + my1) / 2) / r - alto / 2;
  const svg = s("svg", { viewBox: `0 0 ${ancho} ${alto}`, role: "img", "aria-label": etiqueta, class: "mapa" });
  const defs = s("defs", {}, s("clipPath", { id: `${id}c` }, s("rect", { width: ancho, height: alto })));
  for (const [nombre, valores] of Object.entries(TINTES))
    defs.appendChild(s("filter", { id: `${id}${nombre}`, "color-interpolation-filters": "sRGB" }, s("feColorMatrix", { type: "matrix", values: valores })));
  // Los espacios protegidos se dibujan con un rayado, encima de las zonas inundables, para
  // que se distingan aunque coincidan (y aunque el informe se imprima sin color).
  defs.appendChild(s("pattern", { id: `${id}raya`, width: 9, height: 9, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
    s("rect", { width: 9, height: 9, fill: "#1f8a61", "fill-opacity": 0.22 }),
    s("rect", { width: 3, height: 9, fill: "#14694a", "fill-opacity": 0.8 })));
  defs.appendChild(s("filter", { id: `${id}blanco`, "color-interpolation-filters": "sRGB" }, s("feColorMatrix", { type: "matrix", values: "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 4 0" })));
  svg.appendChild(defs);
  svg.appendChild(s("rect", { width: ancho, height: alto, fill: "#e9ece8" }));
  const marco = s("g", { "clip-path": `url(#${id}c)` });
  svg.appendChild(marco);

  const teselas = (plantilla, zMax, atributos = {}) => {
    const zl = Math.min(z, zMax);
    const f = 2 ** (z - zl);
    const lado = 256 * f;
    const g = s("g", atributos);
    const n = 2 ** zl;
    for (let ty = Math.floor(py0 / lado); ty <= Math.floor((py0 + alto) / lado); ty++)
      for (let tx = Math.floor(px0 / lado); tx <= Math.floor((px0 + ancho) / lado); tx++) {
        if (ty < 0 || ty >= n) continue;
        const x = ((tx % n) + n) % n;
        g.appendChild(s("image", { href: plantilla(zl, x, ty), x: (tx * lado - px0).toFixed(2), y: (ty * lado - py0).toFixed(2), width: lado + 0.6, height: lado + 0.6, preserveAspectRatio: "none" }));
      }
    return g;
  };
  marco.appendChild(teselas(fondo, zMaxFondo));

  if (inundacion === "mundo") {
    // Imagen del modelo mundial (GloFAS) para todo el marco, teñida de un solo azul.
    const caja = [px0 * r - MEDIO_MUNDO, MEDIO_MUNDO - (py0 + alto) * r, (px0 + ancho) * r - MEDIO_MUNDO, MEDIO_MUNDO - py0 * r];
    marco.appendChild(s("image", { href: urlInundacion(caja, ancho, alto, "EPSG:3857"), x: 0, y: 0, width: ancho, height: alto, filter: `url(#${id}t100)`, preserveAspectRatio: "none" }));
  } else if (inundacion) {
    for (const [capa, tinte] of [["NZ.Flood.FluvialT500", "t500"], ["NZ.Flood.MarinaT500", "t500"], ["NZ.Flood.FluvialT100", "t100"], ["NZ.Flood.MarinaT100", "t100"], ["NZ.Flood.FluvialT10", "t10"]])
      marco.appendChild(teselas(CAPAS_TESELA.snczi(capa), 18, { filter: `url(#${id}${tinte})` }));
  }
  const trazado = (geom) => geom.map((pol) => pol.map((an) => "M" + an.map(([lon, lat]) => {
    const [mx, my] = aMercator(lon, lat);
    return `${((mx + MEDIO_MUNDO) / r - px0).toFixed(1)} ${((MEDIO_MUNDO - my) / r - py0).toFixed(1)}`;
  }).join("L") + "Z").join("")).join("");
  if (protegidos === "es") {
    // Imagen oficial (WMS del IEPNB) usada como máscara del rayado.
    const caja = [px0 * r - MEDIO_MUNDO, MEDIO_MUNDO - (py0 + alto) * r, (px0 + ancho) * r - MEDIO_MUNDO, MEDIO_MUNDO - py0 * r].map((v) => v.toFixed(2)).join(",");
    const mascara = s("mask", { id: `${id}prot`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: ancho, height: alto, style: "mask-type: alpha" });
    for (const [ruta, capa] of [["RN2000/rn2000", "rn2000"], ["ENP/enp", "enp"]])
      mascara.appendChild(s("image", { href: `${IEPNB}/${ruta}/wms?service=WMS&version=1.1.1&request=GetMap&layers=${capa}&styles=&srs=EPSG:3857&bbox=${caja}&width=${ancho}&height=${alto}&format=image/png&transparent=true`, x: 0, y: 0, width: ancho, height: alto, filter: `url(#${id}blanco)`, preserveAspectRatio: "none" }));
    defs.appendChild(mascara);
    marco.appendChild(s("rect", { width: ancho, height: alto, fill: `url(#${id}raya)`, mask: `url(#${id}prot)` }));
  } else if (Array.isArray(protegidos)) {
    // Contornos ya descargados por el motor (fuera de España). El rayado se pinta una sola
    // vez, con todos los espacios como máscara: si varios se solapan, no se oscurece.
    if (protegidos.length) {
      const mascara = s("mask", { id: `${id}prot`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: ancho, height: alto });
      const trazos = s("g", { fill: "none", stroke: "#14694a", "stroke-width": 1.2, "stroke-linejoin": "round" });
      for (const geom of protegidos) {
        const camino = trazado(geom);
        mascara.appendChild(s("path", { d: camino, fill: "#fff", "fill-rule": "evenodd" }));
        trazos.appendChild(s("path", { d: camino }));
      }
      defs.appendChild(mascara);
      marco.appendChild(s("rect", { width: ancho, height: alto, fill: `url(#${id}raya)`, mask: `url(#${id}prot)` }));
      marco.appendChild(trazos);
    }
  }

  const d = trazado(res.parcela.geom);
  marco.appendChild(s("path", { d, fill: "none", stroke: "#fff", "stroke-width": 5.5, "stroke-linejoin": "round", "fill-rule": "evenodd", opacity: 0.9 }));
  marco.appendChild(s("path", { d, fill: "#fff", "fill-opacity": 0.08, stroke: "#14201b", "stroke-width": 2.6, "stroke-linejoin": "round", "fill-rule": "evenodd" }));

  // Escala gráfica
  const mPorPx = r * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  const objetivo = mPorPx * ancho * 0.22;
  const pot = 10 ** Math.floor(Math.log10(objetivo));
  const largo = [5, 2, 1].map((k) => k * pot).find((v) => v <= objetivo) || pot;
  const lpx = largo / mPorPx;
  const eg = s("g", { transform: `translate(14 ${alto - 16})` });
  const cuerpo = Math.round(ancho / (estrecha() ? 30 : 48)); // en pantallas estrechas el mapa se encoge
  eg.appendChild(s("rect", { x: -6, y: -(cuerpo + 10), width: Math.max(lpx, cuerpo * 3.2) + 12, height: cuerpo + 20, fill: "#fff", opacity: 0.88, rx: 2 }));
  eg.appendChild(s("path", { d: `M0 -4V2H${lpx.toFixed(1)}V-4`, fill: "none", stroke: "#14201b", "stroke-width": 1.6 }));
  eg.appendChild(s("text", { x: Math.max(lpx, cuerpo * 3.2) / 2, y: -7, "text-anchor": "middle", "font-size": cuerpo, fill: "#14201b" }, largo >= 1000 ? `${largo / 1000} km` : `${largo} m`));
  svg.appendChild(eg);
  // Norte
  const norte = s("g", { transform: `translate(${ancho - 26} 30)` });
  norte.appendChild(s("circle", { r: 15, fill: "#fff", opacity: 0.88 }));
  norte.appendChild(s("path", { d: "M0 -11L5 6L0 2.5L-5 6Z", fill: "#14201b" }));
  norte.appendChild(s("text", { y: 12.5, "text-anchor": "middle", "font-size": 8, "font-weight": 700, fill: "#14201b" }, "N"));
  svg.appendChild(norte);
  return svg;
}

/** ¿Pantalla estrecha (móvil)? Los gráficos se dibujan entonces más compactos y con letra mayor. */
function estrecha() {
  return typeof window !== "undefined" && window.innerWidth > 0 && window.innerWidth < 600;
}

function leyenda(elementos) {
  return h("ul", { class: "leyenda" }, elementos.map(([clase, texto]) => h("li", {}, h("span", { class: `muestra ${clase}`, "aria-hidden": "true" }), texto)));
}

// --------------------------------------------------------------- gráfico NDVI
/** Serie de NDVI: una sola línea, bandas en las caídas, cursor con el valor y tabla de datos. */
export function graficoNdvi(sat, L) {
  const { t, num } = L;
  const serie = sat.serie || [];
  const compacto = estrecha();
  const W = compacto ? 400 : 720, H = compacto ? 240 : 256, mi = 40, md = compacto ? 38 : 46, ms = 26, mb = 30;
  const aDia = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
  const anoIni = Number((sat.desde || serie[0].fecha).slice(0, 4));
  const anoFin = Math.max(new Date().getUTCFullYear(), Number(serie[serie.length - 1].fecha.slice(0, 4)));
  const d0 = aDia(`${anoIni}-01-01`), d1 = aDia(`${anoFin + 1}-01-01`);
  const x = (iso) => mi + ((aDia(iso) - d0) / (d1 - d0)) * (W - mi - md);
  const y = (v) => ms + (1 - Math.max(0, Math.min(1, v))) * (H - ms - mb);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "grafico", role: "img", "aria-label": t("inf.s6") });
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    svg.appendChild(s("line", { x1: mi, x2: W - md, y1: y(v), y2: y(v), class: v === 0 ? "eje" : "rejilla" }));
    svg.appendChild(s("text", { x: mi - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" }, num(v, 2)));
  }
  svg.appendChild(s("text", { x: 2, y: 11, class: "tick titulo-eje" }, t("inf.v.eje")));
  const cadaCuantos = Math.ceil((anoFin - anoIni + 1) / (compacto ? 5 : 12));
  for (let a = anoIni; a <= anoFin + 1; a++) {
    const xa = x(`${a}-01-01`);
    svg.appendChild(s("line", { x1: xa, x2: xa, y1: H - mb, y2: H - mb + 5, class: "eje" }));
    if (a <= anoFin && (a - anoIni) % cadaCuantos === 0) svg.appendChild(s("text", { x: (xa + x(`${a + 1}-01-01`)) / 2, y: H - mb + 18, "text-anchor": "middle", class: "tick" }, a));
  }
  for (const e of (sat.analisis && sat.analisis.eventos) || []) {
    // Una caída no recuperada sigue abierta: la banda llega hasta la última observación.
    const xa = x(e.inicio) - 4, xb = x(e.recuperado ? e.fin : serie[serie.length - 1].fecha) + 4;
    svg.appendChild(s("rect", { x: xa, y: ms, width: Math.max(8, xb - xa), height: H - ms - mb, class: "caida" }));
    svg.appendChild(s("text", { x: Math.max(mi + 18, Math.min(W - md - 18, (xa + xb) / 2)), y: ms + 12, "text-anchor": "middle", class: "tick caida-texto" }, t("inf.v.caida")));
  }
  if (serie.length) {
    svg.appendChild(s("path", { d: "M" + serie.map((o) => `${x(o.fecha).toFixed(1)} ${y(o.ndvi).toFixed(1)}`).join("L"), class: "linea" }));
    if (serie.length <= 40) for (const o of serie) svg.appendChild(s("circle", { cx: x(o.fecha), cy: y(o.ndvi), r: 2.6, class: "punto-menor" }));
    const fin = serie[serie.length - 1];
    svg.appendChild(s("circle", { cx: x(fin.fecha), cy: y(fin.ndvi), r: 5, class: "punto" }));
    svg.appendChild(s("text", { x: x(fin.fecha) + 9, y: y(fin.ndvi) + 4, class: "tick valor" }, num(fin.ndvi, 2)));
  }
  // Cursor: sigue al puntero y se queda en la observación más cercana.
  const cursor = s("g", { class: "cursor", visibility: "hidden" }, s("line", { y1: ms, y2: H - mb, class: "cursor-linea" }), s("circle", { r: 5, class: "punto" }));
  svg.appendChild(cursor);
  const zona = s("rect", { x: mi, y: ms, width: W - mi - md, height: H - ms - mb, fill: "transparent", tabindex: 0, "aria-label": t("inf.s6") });
  svg.appendChild(zona);
  const globo = h("div", { class: "globo", hidden: true });
  const marco = h("div", { class: "grafico-marco" }, svg, globo);
  let actual = -1;
  const mostrar = (i) => {
    if (i < 0 || i >= serie.length) return;
    actual = i;
    const o = serie[i];
    cursor.setAttribute("visibility", "visible");
    cursor.firstChild.setAttribute("x1", x(o.fecha));
    cursor.firstChild.setAttribute("x2", x(o.fecha));
    cursor.lastChild.setAttribute("cx", x(o.fecha));
    cursor.lastChild.setAttribute("cy", y(o.ndvi));
    globo.replaceChildren(h("strong", {}, num(o.ndvi, 2)), h("span", {}, ` NDVI · ${L.dia(o.fecha)}`));
    globo.hidden = false;
    const fx = x(o.fecha) / W;
    globo.style.left = `${fx * 100}%`;
    globo.style.transform = `translate(${fx > 0.7 ? "-105%" : "8px"}, 0)`;
    globo.style.top = `${(y(o.ndvi) / H) * 100}%`;
  };
  const ocultar = () => { cursor.setAttribute("visibility", "hidden"); globo.hidden = true; actual = -1; };
  zona.addEventListener("pointermove", (ev) => {
    const caja = svg.getBoundingClientRect();
    const xp = ((ev.clientX - caja.left) / caja.width) * W;
    let mejor = 0, dist = Infinity;
    serie.forEach((o, i) => { const dd = Math.abs(x(o.fecha) - xp); if (dd < dist) { dist = dd; mejor = i; } });
    mostrar(mejor);
  });
  zona.addEventListener("pointerleave", ocultar);
  zona.addEventListener("blur", ocultar);
  zona.addEventListener("focus", () => mostrar(serie.length - 1));
  zona.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft") { mostrar(Math.max(0, actual - 1)); ev.preventDefault(); }
    if (ev.key === "ArrowRight") { mostrar(Math.min(serie.length - 1, actual + 1)); ev.preventDefault(); }
  });
  return marco;
}

// -------------------------------------------------------------------- informe
function titulo(res, L) {
  const p = res.parcela, d = p.datos || {};
  if (p.origen === "catastro") {
    if (d.poligono && d.parcela) return L.t("inf.titulo.poligono_parcela", { poligono: d.poligono, parcela: d.parcela });
    return L.t("inf.titulo.urbana", { refcat: p.refcat });
  }
  if (p.origen === "sigpac" && d.poligono && d.parcela) return L.t("inf.titulo.poligono_parcela", { poligono: d.poligono, parcela: d.parcela });
  if (p.origen === "sigpac") return L.t("inf.titulo.sigpac", { id: p.id.replace(/^SIGPAC\s*/, "") });
  return L.t(p.origen === "fichero" ? "inf.titulo.fichero" : "inf.titulo.dibujo");
}

function usoTexto(codigo, L) {
  const clave = `uso.${codigo}`;
  const texto = L.t(clave);
  return texto === clave ? codigo || "–" : texto;
}

function seccion(n, texto, ...hijos) {
  return h("section", { class: "apartado", id: `s${n}` }, h("h2", {}, h("span", { class: "num-apartado" }, `${n}.`), " ", texto), hijos);
}
const nota = (texto) => h("p", { class: "nota" }, texto);
const aviso = (texto) => h("p", { class: "nota nota--aviso" }, texto);

function resultadoCapa(c, L, entornoM) {
  if (c.estado !== "ok") return L.t("inf.a.error");
  if (c.afecta) return L.t("inf.a.si");
  if (c.enEntorno) return L.t("inf.a.no_cerca", { m: entornoM });
  return L.t("inf.a.no");
}

/** Devuelve el elemento con el informe completo. `sitio` es el nombre que firma el pie. */
export function pintarInforme(res, L, { sitio = "Lurra" } = {}) {
  const { t, num, m2, area } = L;
  const p = res.parcela, d = p.datos || {};
  const es = res.ambito === "es";
  const sem = evaluar(res, L);
  const g = new Date(res.generado); // la fecha del informe es la del lugar donde se genera
  const fecha = L.dia(`${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, "0")}-${String(g.getDate()).padStart(2, "0")}`);
  const doc = h("article", { class: "informe", lang: L.codigo });

  // ---- cabecera
  doc.appendChild(h("header", { class: "informe__cabecera" },
    h("p", { class: "informe__sello" }, h("span", { class: "marca" }, sitio), " · ", t("inf.titulo_documento")),
    h("h1", {}, titulo(res, L)),
    d.localizacion || d.municipio ? h("p", { class: "informe__lugar" }, d.paraje ? `${d.paraje}, ` : "", d.municipio || "", d.provincia ? ` (${d.provincia})` : "") : null,
    p.lugar ? h("p", { class: "informe__lugar" }, p.lugar.texto) : null,
    p.origen === "sigpac" ? h("p", { class: "informe__lugar" }, [d.provincia, p.id].filter(Boolean).join(" · ")) : null,
    h("p", { class: "informe__ref" }, p.refcat ? t("inf.refcat", { refcat: p.refcat }) : t("inf.centro", { lat: num(p.centro[1], 5), lon: num(p.centro[0], 5) }))));

  doc.appendChild(h("div", { class: `semaforo semaforo--${sem.nivel}` },
    h("span", { class: "semaforo__icono", "aria-hidden": "true" }, sem.nivel === "verde" ? "✓" : sem.nivel === "incompleto" ? "?" : "!"),
    h("div", {}, h("p", { class: "semaforo__titulo" }, `${sem.color}: ${sem.etiqueta.toLowerCase()}`), h("p", {}, sem.resumen))));
  if (res.ambitoDudoso) doc.appendChild(aviso(t("inf.ambito_dudoso")));

  // ---- resumen con mapa
  const rel = res.relieve || {};
  const usos = es && res.sigpac && res.sigpac.estado === "ok" ? [...new Set(res.sigpac.recintos.slice(0, 3).map((r) => usoTexto(r.uso, L)))].join(", ") : null;
  const cultivos = (d.subparcelas || []).slice(0, 3).map((x) => x.cultivo).filter(Boolean);
  const cob = !es && res.cobertura && res.cobertura.estado === "ok" ? res.cobertura.clases.slice(0, 2).map((c) => t(`cob.${c.clase}`)).join(", ") : null;
  const filasResumen = [
    [t("inf.dato.superficie"), area(p.areaM2)],
    cultivos.length ? [t("inf.dato.cultivo"), [...new Set(cultivos)].join(", ")] : null,
    usos ? [t("inf.dato.uso_sigpac"), usos] : null,
    cob ? [t("inf.dato.cobertura"), cob] : null,
    rel.estado === "ok" ? [t("inf.dato.altitud"), `${num(rel.altitudMin)}–${num(rel.altitudMax)} m`] : null,
    rel.estado === "ok" ? [t("inf.dato.pendiente"), `${num(rel.pendienteMedia)} %`] : null,
    rel.estado === "ok" ? [t("inf.dato.orientacion"), rel.orientacion ? t(`orient.${rel.orientacion}`) : t("inf.r.llano")] : null,
  ].filter(Boolean);
  const fondoOrto = es ? { fondo: CAPAS_TESELA.pnoa, zMaxFondo: 19 } : { fondo: CAPAS_TESELA.s2, zMaxFondo: 14 };
  doc.appendChild(h("div", { class: "resumen" },
    tabla(null, filasResumen, { clase: "tabla--ficha" }),
    h("figure", { class: "figura" }, figuraMapa(res, { ...fondoOrto, encuadre: 0.62, etiqueta: t(es ? "inf.mapa.pie" : "inf.mapa.pie_mundo") }), h("figcaption", {}, t(es ? "inf.mapa.pie" : "inf.mapa.pie_mundo")))));

  // ---- 1. ficha
  const filasFicha = [];
  if (p.refcat) filasFicha.push([t("inf.f.refcat"), p.refcat]);
  if (d.localizacion) filasFicha.push([t("inf.f.localizacion"), d.localizacion]);
  else if (p.lugar) filasFicha.push([t("inf.f.localizacion"), p.lugar.texto]);
  if (d.clase) filasFicha.push([t("inf.f.clase"), [t(`inf.f.clase.${d.clase}`), d.uso].filter(Boolean).join(" · ")]);
  filasFicha.push([t("inf.f.origen"), t(`inf.f.origen.${p.origen}`)]);
  if (p.areaCatastroM2) {
    filasFicha.push([t("inf.f.sup_catastral"), m2(p.areaCatastroM2)]);
    const dif = (100 * (p.areaM2 - p.areaCatastroM2)) / p.areaCatastroM2;
    filasFicha.push([t("inf.f.sup_medida"), Math.abs(dif) < 0.05 ? t("inf.f.sup_medida_igual", { area: m2(p.areaM2) }) : t("inf.f.sup_medida_dif", { area: m2(p.areaM2), dif: `${dif >= 0 ? "+" : "−"}${num(Math.abs(dif), 1)} %` })]);
  } else {
    filasFicha.push([t("inf.f.sup_medida"), area(p.areaM2)]);
  }
  filasFicha.push([t("inf.f.perimetro"), `${num(p.perimetroM)} m`]);
  if (p.fechaAlta) filasFicha.push([t("inf.f.alta"), L.dia(p.fechaAlta)]);
  const s1 = seccion(1, t(p.origen === "catastro" ? "inf.s1" : "inf.s1.recinto"), tabla(null, filasFicha, { clase: "tabla--ficha" }));
  if ((d.subparcelas || []).length) {
    s1.appendChild(h("h3", {}, t("inf.f.sub.titulo")));
    s1.appendChild(tabla([t("inf.f.sub.subparcela"), t("inf.f.sub.cultivo"), t("inf.f.sub.intensidad"), t("inf.f.sub.superficie")],
      d.subparcelas.map((x) => [x.subparcela ?? "–", x.cultivo ? `${x.cultivo}${x.codigo ? ` (${x.codigo})` : ""}` : "–", x.intensidad ?? "–", x.superficieM2 != null ? m2(x.superficieM2) : "–"]), { numericas: [3] }));
  }
  if (p.origen === "dibujo" || p.origen === "fichero") s1.appendChild(nota(t("inf.f.nota_dibujo")));
  if (p.origen === "sigpac") s1.appendChild(nota(t("inf.f.nota_sigpac")));
  if (p.origen === "catastro" && p.rustica === false) s1.appendChild(aviso(t("inf.f.nota_urbana")));
  doc.appendChild(s1);

  // ---- 2. relieve
  if (rel.estado === "ok") {
    const s2 = seccion(2, t("inf.s2"), tabla(null, [
      [t("inf.r.altitud"), t("inf.r.altitud_v", { min: num(rel.altitudMin), media: num(rel.altitudMedia), max: num(rel.altitudMax) })],
      [t("inf.r.pendiente"), t("inf.r.pendiente_v", { media: num(rel.pendienteMedia), max: num(rel.pendienteMax) })],
      [t("inf.r.mas20"), `${num(rel.pctMas20)} %`],
      [t("inf.r.orientacion"), rel.orientacion ? t(`orient.${rel.orientacion}`) : t("inf.r.llano")],
      [t("inf.r.modelo"), t(`inf.r.fuente.${rel.fuente}`)],
    ], { clase: "tabla--ficha" }));
    if (rel.aproximado) s2.appendChild(nota(t("inf.r.aproximado")));
    if (es && rel.fuente === "terrarium") s2.appendChild(nota(t("inf.r.reserva")));
    doc.appendChild(s2);
  } else {
    doc.appendChild(seccion(2, t("inf.s2"), aviso(t("inf.r.error"))));
  }

  // ---- 3. agua
  const inu = res.inundacion;
  if (inu && !Array.isArray(inu.capas)) {
    doc.appendChild(seccion(3, t("inf.s3"), aviso(t("inf.a.error_total"))));
  } else if (inu) {
    const s3 = seccion(3, t("inf.s3"), tabla([t("inf.a.capa"), t("inf.a.resultado"), t("inf.a.superficie"), t("inf.a.pct")],
      (inu.capas || []).map((c) => ({ clase: c.afecta ? "fila-afecta" : c.estado !== "ok" ? "fila-error" : null, celdas: [t(`capa.${c.id}`), resultadoCapa(c, L, inu.entornoM), c.estado === "ok" ? m2(c.m2) : "–", c.estado === "ok" ? `${num(c.pct)} %` : "–"] })), { numericas: [2, 3] }));
    if (inu.capas.some((c) => c.estado === "ok" && c.incompleta)) s3.appendChild(aviso(t("inf.a.entorno_incompleto")));
    s3.appendChild(nota(es ? t("inf.a.nota", { pixel: num(inu.pixelM || 1, 1) }) : t("inf.a.nota_mundo", { pixel: num(inu.pixelM) })));
    doc.appendChild(s3);
  } else {
    doc.appendChild(seccion(3, t("inf.s3"), aviso(t(res.ambitoDudoso ? "inf.ambito_dudoso" : "inf.a.error_total"))));
  }

  // ---- 4. protección
  const hayModelo = !es && inu && Array.isArray(inu.capas) && inu.capas.some((c) => c.estado === "ok");
  if (res.proteccion) {
    const filas = res.proteccion.map((c) => {
      const texto = c.estado !== "ok" ? t("inf.p.error") : c.elementos.length
        ? h("ul", { class: "lista-simple" }, c.elementos.map((e) => h("li", {}, [e.codigo, e.nombre].filter(Boolean).join(" "), e.figura ? h("span", { class: "tenue" }, ` · ${e.figura}`) : null)))
        : t("inf.p.ninguno");
      return { clase: c.afecta ? "fila-afecta" : c.estado !== "ok" ? "fila-error" : null, celdas: [t(`capa.${c.id}`), texto, c.estado === "ok" ? m2(c.m2) : "–", c.estado === "ok" ? `${num(c.pct)} %` : "–"] };
    });
    const s4 = seccion(4, t("inf.s4"), tabla([t("inf.p.capa"), t("inf.p.resultado"), t("inf.a.superficie"), t("inf.a.pct")], filas, { numericas: [2, 3] }));
    s4.appendChild(h("figure", { class: "figura figura--ancha" },
      figuraMapa(res, { fondo: es ? CAPAS_TESELA.ignBase : CAPAS_TESELA.osm, zMaxFondo: es ? 18 : 19, encuadre: 0.2, inundacion: es ? true : hayModelo ? "mundo" : false, protegidos: es ? "es" : res.proteccion.flatMap((c) => c.dibujo || []), alto: 380, etiqueta: t(es ? "inf.mapa2.pie" : "inf.mapa2.pie_mundo") }),
      h("figcaption", {}, t(es ? "inf.mapa2.pie" : "inf.mapa2.pie_mundo")),
      leyenda([["muestra--parcela", t("inf.leyenda.parcela")], ...(es ? [["muestra--t10", t("inf.leyenda.t10")], ["muestra--t100", t("inf.leyenda.t100")], ["muestra--t500", t("inf.leyenda.t500")]] : hayModelo ? [["muestra--t100", t("inf.leyenda.t100")]] : []), ["muestra--verde", t("inf.leyenda.protegido")]])));
    if (es) s4.appendChild(nota(t("inf.p.nota")));
    else {
      if (res.ambito === "ue") s4.appendChild(nota(t("inf.p.nota_ue")));
      s4.appendChild(nota(t("inf.p.nota_wdpa")));
    }
    doc.appendChild(s4);
  } else {
    doc.appendChild(seccion(4, t("inf.s4"), aviso(t("inf.p.error"))));
  }

  // ---- 5. uso / cobertura
  if (es) {
    const sg = res.sigpac || {};
    const s5 = seccion(5, t("inf.s5"));
    if (sg.estado !== "ok") s5.appendChild(aviso(t("inf.u.error")));
    else if (!sg.recintos.length) s5.appendChild(nota(t("inf.u.sin_recintos")));
    else {
      s5.appendChild(tabla([t("inf.u.recinto"), t("inf.u.uso"), t("inf.u.dentro"), t("inf.u.pct"), t("inf.u.pendiente"), t("inf.u.regadio")],
        sg.recintos.map((r) => [r.recinto, `${usoTexto(r.uso, L)} (${r.uso})`, m2(r.comunM2), `${num(r.pct, 1)} %`, r.pendientePct != null ? `${num(r.pendientePct, 1)} %` : "–", r.coefRegadio != null ? num(r.coefRegadio) : "–"]), { numericas: [2, 3, 4, 5] }));
      if (sg.cubiertoPct != null && sg.cubiertoPct < 97) s5.appendChild(aviso(t("inf.u.cobertura", { pct: num(sg.cubiertoPct) })));
      s5.appendChild(nota(t("inf.u.nota")));
    }
    doc.appendChild(s5);
  } else {
    const c = res.cobertura || {};
    const s5 = seccion(5, t("inf.s5_mundo"));
    if (c.estado !== "ok") s5.appendChild(aviso(t("inf.c.error")));
    else {
      s5.appendChild(tabla([t("inf.c.clase"), t("inf.c.pct")], c.clases.map((x) => [t(`cob.${x.clase}`), `${num(x.pct)} %`]), { numericas: [1] }));
      s5.appendChild(nota(t("inf.c.nota")));
    }
    doc.appendChild(s5);
  }

  // ---- 6. satélite
  doc.appendChild(seccionSatelite(res, L));

  // ---- 7. resumen
  const s7 = seccion(7, t("inf.s7"));
  if (sem.hallazgos.length) {
    s7.appendChild(h("ul", { class: "hallazgos" }, sem.hallazgos.map((x) => h("li", { class: `hallazgo hallazgo--${x.nivel}` },
      h("span", { class: "hallazgo__icono", "aria-hidden": "true" }, x.nivel === "info" ? "i" : "!"),
      h("div", {}, h("p", { class: "hallazgo__titulo" }, x.titulo), h("p", {}, x.detalle))))));
  }
  s7.appendChild(tabla([t("sem.q.quien"), t("sem.q.que")], sem.preguntas));
  doc.appendChild(s7);

  // ---- fuentes
  const anos = res.satelite && res.satelite.serie && res.satelite.serie.length ? `${res.satelite.serie[0].fecha.slice(0, 4)}-${res.satelite.serie[res.satelite.serie.length - 1].fecha.slice(0, 4)}` : null;
  const fuentes = [
    p.origen === "catastro" ? t("inf.fu.catastro", { fecha }) : null,
    es ? t("inf.fu.sigpac", { fecha }) : null,
    es ? t("inf.fu.snczi") : null,
    es ? t("inf.fu.iepnb") : res.ambito === "ue" ? t("inf.fu.eea") : null,
    hayModelo ? t("inf.fu.glofas") : null,
    !es && res.proteccion ? t("inf.fu.wdpa", { fecha: L.mesAno(res.generado.slice(0, 10)) }) : null,
    es ? t("inf.fu.ign") : null,
    rel.fuente === "terrarium" ? t("inf.fu.terrarium") : null,
    anos ? t("inf.fu.sentinel", { anos }) : null,
    !es ? t("inf.fu.eox") : null,
    !es && res.cobertura && res.cobertura.estado === "ok" ? t("inf.fu.esri") : null,
    !es ? t("inf.fu.osm") : null,
  ].filter(Boolean);
  doc.appendChild(h("section", { class: "apartado fuentes" }, h("h2", {}, t("inf.fuentes")), h("ul", {}, fuentes.map((f) => h("li", {}, f))), h("p", {}, t("inf.limites"))));
  if (L.traducido) doc.appendChild(h("p", { class: "informe__traduccion" }, t("inf.traduccion")));
  doc.appendChild(h("footer", { class: "informe__pie" }, h("span", {}, t("inf.generado", { fecha })), h("span", {}, t("inf.pagina_gratis", { sitio }))));
  return doc;
}

/** Apartado 6 por separado, para poder repintarlo mientras se leen las imágenes. */
export function seccionSatelite(res, L) {
  const { t, num } = L;
  const sat = res.satelite || { estado: "omitido" };
  const s6 = seccion(6, t("inf.s6"));
  if (sat.estado === "pequena") return s6.appendChild(nota(t("inf.v.pequena", { min: L.m2(sat.minimoM2 || 2000) }))), s6;
  if (sat.estado === "error") return s6.appendChild(aviso(t("inf.v.error"))), s6;
  if (sat.estado === "vacia") return s6.appendChild(nota(t("inf.v.vacia"))), s6;
  if (sat.estado !== "ok" || !sat.serie || !sat.serie.length) {
    s6.appendChild(h("p", { class: "nota", "data-hueco": "satelite" }, t("inf.v.omitido")));
    return s6;
  }
  const a = sat.analisis || {};
  const serie = sat.serie;
  s6.appendChild(h("p", {}, t("inf.v.intro", { desde: L.mesAno(serie[0].fecha), hasta: L.mesAno(serie[serie.length - 1].fecha), n: serie.length })));
  s6.appendChild(graficoNdvi(sat, L));
  if (sat.leyendo) s6.appendChild(nota(t("inf.v.leyendo", sat.leyendo)));
  else if (sat.parcial && sat.parcial.hechas < sat.parcial.total) s6.appendChild(aviso(t("inf.v.parcial", sat.parcial)));
  if (!sat.leyendo && sat.fallos >= 6) s6.appendChild(aviso(t("inf.v.fallos", { n: sat.fallos })));
  if (!a.suficiente) {
    s6.appendChild(nota(t("inf.v.pocos", { n: serie.length })));
  } else {
    const tend = a.tendenciaDecada;
    const frases = [t("inf.v.media", { media: num(a.media, 2) })];
    if (tend != null) frases.push(Math.abs(tend) < 0.05 ? t("inf.v.tendencia.estable") : t(tend > 0 ? "inf.v.tendencia.sube" : "inf.v.tendencia.baja", { valor: `${tend > 0 ? "+" : "−"}${num(Math.abs(tend), 2)}` }));
    frases.push(a.eventos.length ? t("inf.v.caidas.n", { n: a.eventos.length }) : t("inf.v.caidas.ninguna"));
    s6.appendChild(h("p", {}, frases.join(" ")));
    if (a.eventos.length) {
      s6.appendChild(tabla([t("inf.v.e.inicio"), t("inf.v.e.fin"), t("inf.v.e.desviacion"), t("inf.v.e.recuperacion")],
        a.eventos.map((e) => [L.mesAno(e.inicio), L.mesAno(e.fin), `−${num(Math.abs(e.minimo), 2)}`, e.recuperado ? L.mesAno(e.recuperado) : t("inf.v.e.no")]), { numericas: [2] }));
    }
  }
  s6.appendChild(nota(t("inf.v.nota", { res: sat.resolucion || 20 })));
  s6.appendChild(h("details", { class: "datos-tabla" }, h("summary", {}, t("inf.v.tabla")),
    tabla([t("inf.v.fecha"), "NDVI"], serie.map((o) => [L.dia(o.fecha), num(o.ndvi, 2)]), { numericas: [1] })));
  return s6;
}
