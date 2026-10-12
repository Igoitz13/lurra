// Textos y formatos del informe y de la página, en cualquiera de los idiomas de la web.
//
// Los diccionarios están en js/idiomas/<código>.js y los genera tools/paginas.py a partir de
// tools/textos/<código>.json: no se editan a mano. El castellano y el inglés van siempre
// cargados (son el respaldo de los demás); el resto se descarga solo cuando hace falta.

import ES from "./idiomas/es.js";
import EN from "./idiomas/en.js";

const CARGADOS = { es: ES, en: EN };
// Idiomas que, si les falta un texto, lo toman del castellano; los demás, del inglés.
const CON_RESPALDO_ES = new Set(["es", "es-419", "ca", "eu", "gl"]);
// Región con la que se escriben los números y las fechas cuando el código no la lleva.
const REGION = { es: "es-ES", en: "en-GB", pt: "pt-PT" };
const RTL = new Set(["ar", "he", "fa", "ur"]);

const normalizar = (codigo) => {
  const [base, ...resto] = String(codigo || "es").trim().split(/[-_]/);
  // «pt-br» → «pt-BR», «zh-hans» → «zh-Hans», «es-419» igual
  return [base.toLowerCase(), ...resto.map((p) => (p.length === 4 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toUpperCase()))].join("-");
};

function intl(Clase, region, opciones) {
  // Cifras latinas y calendario gregoriano en todos los idiomas: las mismas que en las tablas.
  for (const r of [`${region}-u-ca-gregory-nu-latn`, "en-GB"]) {
    try { return new Clase(r, opciones); } catch { /* idioma que este navegador no conoce */ }
  }
  return null;
}

/** Funciones de texto y formato a partir de un diccionario ya cargado. */
function crear(lang, dic) {
  const respaldo = CON_RESPALDO_ES.has(lang) ? [ES] : [EN, ES];
  const region = REGION[lang] || lang;
  const plural = intl(Intl.PluralRules, region);
  const buscar = (clave) => {
    if (dic[clave] !== undefined) return dic[clave];
    for (const d of respaldo) if (d[clave] !== undefined) return d[clave];
    return clave;
  };
  const t = (clave, datos = {}) => {
    let base = buscar(clave);
    // Texto con formas de plural ({one, few, many, other…}): se elige según datos.n
    if (base && typeof base === "object") {
      const forma = datos.n !== undefined && plural ? plural.select(Number(datos.n)) : "other";
      base = base[forma] ?? base.other ?? Object.values(base)[0] ?? clave;
    }
    return String(base).replace(/\{(\w+)\}/g, (m, k) => (datos[k] !== undefined && datos[k] !== null ? String(datos[k]) : m));
  };
  const formatos = new Map();
  const num = (v, decimales = 0) => {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "–";
    if (!formatos.has(decimales)) formatos.set(decimales, intl(Intl.NumberFormat, region, { minimumFractionDigits: decimales, maximumFractionDigits: decimales, useGrouping: "always" }));
    const texto = formatos.get(decimales).format(Number(v));
    return /^-0([.,٫]0+)?$/.test(texto) ? texto.slice(1) : texto; // nunca «-0»
  };
  // En los idiomas que se escriben de derecha a izquierda, la cifra y su unidad se aíslan para
  // que se lean en su orden («80,200 m²» y no «m² 80,200»).
  const aislar = RTL.has(lang.split("-")[0]) ? (x) => `\u2066${x}\u2069` : (x) => x;
  const m2Bruto = (v) => `${num(v)} m²`;
  const haBruto = (v) => `${num(v / 10000, v < 100000 ? 2 : 1)} ha`;
  const m2 = (v) => aislar(m2Bruto(v));
  const ha = (v) => aislar(haBruto(v));
  const area = (v) => (v == null ? "–" : aislar(`${m2Bruto(v)} (${haBruto(v)})`));
  const fMes = intl(Intl.DateTimeFormat, region, { month: "long", year: "numeric", timeZone: "UTC" });
  const fDia = intl(Intl.DateTimeFormat, region, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const fecha = (iso) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) || 1));
  const mesAno = (iso) => fMes.format(fecha(iso));
  const dia = (iso) => fDia.format(fecha(iso));
  // `traducido`: los textos son una traducción automática (todo salvo castellano e inglés).
  return { codigo: lang, traducido: !CON_RESPALDO_ES.has(lang) && lang !== "en" || ["ca", "eu", "gl"].includes(lang), t, num, m2, ha, area, mesAno, dia };
}

/** Funciones de un idioma ya cargado (el castellano y el inglés lo están siempre). */
export function idioma(codigo = "es") {
  const lang = normalizar(codigo);
  return CARGADOS[lang] ? crear(lang, CARGADOS[lang]) : crear("es", ES);
}

/** Descarga el diccionario de un idioma, si hace falta, y devuelve sus funciones. */
export async function cargarIdioma(codigo = "es") {
  const lang = normalizar(codigo);
  if (!CARGADOS[lang]) {
    try {
      CARGADOS[lang] = (await import(`./idiomas/${lang.toLowerCase()}.js`)).default;
    } catch {
      // Sin diccionario (idioma desconocido o descarga fallida): textos de respaldo.
      return crear(lang, {});
    }
  }
  return crear(lang, CARGADOS[lang]);
}
