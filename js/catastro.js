// Catastro: de la referencia catastral (o de un punto) a la geometría y los datos de la parcela.
//
// Servicios (comprobados desde el navegador el 11-10-2026, todos con CORS):
//   - WFS INSPIRE de parcelas, consulta almacenada GetParcel.
//   - Consulta_DNPRC (datos no protegidos) y Consulta_RCCOOR (referencia de un punto), en JSON.
// Álava, Bizkaia, Gipuzkoa y Navarra tienen catastro foral y no están aquí: para esas
// parcelas se usa el recinto de SIGPAC (clic en el mapa) o un recinto dibujado.

import { ErrorLurra, pedir } from "./red.js";
import { proyeccionEpsg } from "./geo.js";

const URL_WFS = "https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx";
const URL_SVC = "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero";
export const FORALES = { "01": "Álava", "20": "Gipuzkoa", "48": "Bizkaia", "31": "Navarra" };
const CANARIAS = new Set(["35", "38"]);

/** Devuelve los 14 caracteres de parcela de una referencia de 14 o 20. */
export function normalizarRefcat(texto) {
  const rc = String(texto || "").replace(/[\s.\-]/g, "").toUpperCase();
  if (!/^[0-9A-Z]{14}([0-9A-Z]{6})?$/.test(rc)) throw new ErrorLurra("refcat_invalida", { texto });
  return rc.slice(0, 14);
}

/** Las rústicas son provincia(2) + municipio(3) + sector(letra) + polígono(3) + parcela(5). */
export function esRustica(rc14) {
  return /^\d{5}[A-Z]\d{8}$/.test(rc14);
}

export function partesRustica(rc14) {
  if (!esRustica(rc14)) return null;
  return {
    provincia: Number(rc14.slice(0, 2)),
    municipio: Number(rc14.slice(2, 5)),
    sector: rc14[5],
    poligono: Number(rc14.slice(6, 9)),
    parcela: Number(rc14.slice(9, 14)),
  };
}

function numeros(texto) {
  return texto.trim().split(/\s+/).map(Number);
}

/** Convierte una lista plana de coordenadas en un anillo [lon, lat]. */
function anillo(valores, dimension, epsg) {
  const pares = [];
  for (let i = 0; i + dimension - 1 < valores.length; i += dimension) pares.push([valores[i], valores[i + 1]]);
  if (epsg === 4326 || epsg === 4258) {
    // El Catastro sirve las geográficas como «latitud longitud». Se comprueba por si cambia.
    // En España las longitudes (−19 a 5) y las latitudes (27 a 44) no se solapan.
    const lonPrimero = pares.every(([a, b]) => a >= -19.5 && a <= 5.5 && b >= 26.5 && b <= 44.5);
    return pares.map(([a, b]) => (lonPrimero ? [a, b] : [b, a]));
  }
  const p = proyeccionEpsg(epsg);
  return pares.map(([x, y]) => p.inversa(x, y));
}

/** Convierte la respuesta GML de GetParcel en una parcela con geometría en lon/lat. */
export function leerGmlParcela(xml) {
  const texto = String(xml || "");
  // Una página HTML (mantenimiento, error del servidor) o una respuesta vacía no es «parcela
  // inexistente»: es un fallo del servicio, que se reintenta y no se guarda.
  if (!texto.trim() || /<html[\s>]|<!doctype html/i.test(texto)) throw new Error("el Catastro no ha devuelto XML");
  if (!/CadastralParcel/.test(texto)) throw new ErrorLurra("catastro_sin_parcela", { respuesta: texto.replace(/\s+/g, " ").slice(0, 160) });
  const srs = texto.match(/srsName="[^"]*?(\d{4,5})"/);
  const epsg = srs ? Number(srs[1]) : null;
  if (!epsg) throw new ErrorLurra("catastro_sin_geometria");
  const geom = [];
  for (const parche of texto.match(/<gml:PolygonPatch>[\s\S]*?<\/gml:PolygonPatch>/g) || []) {
    const leer = (bloque) => {
      const m = bloque.match(/<gml:posList([^>]*)>([^<]+)<\/gml:posList>/);
      if (!m) return null;
      const dim = Number((m[1].match(/srsDimension="(\d)"/) || [0, 2])[1]);
      return anillo(numeros(m[2]), dim, epsg);
    };
    const ext = parche.match(/<gml:exterior>[\s\S]*?<\/gml:exterior>/);
    const exterior = ext && leer(ext[0]);
    if (!exterior || exterior.length < 4) continue;
    const pol = [exterior];
    for (const h of parche.match(/<gml:interior>[\s\S]*?<\/gml:interior>/g) || []) {
      const hueco = leer(h);
      if (hueco && hueco.length >= 4) pol.push(hueco);
    }
    geom.push(pol);
  }
  if (!geom.length) throw new ErrorLurra("catastro_sin_geometria");
  const etiqueta = (n) => {
    const m = texto.match(new RegExp(`<cp:${n}[^>]*>([^<]*)</cp:${n}>`));
    return m && m[1].trim() ? m[1].trim() : null;
  };
  const area = etiqueta("areaValue");
  const alta = etiqueta("beginLifespanVersion");
  return {
    refcat: etiqueta("nationalCadastralReference") || "",
    geom,
    epsgOrigen: epsg,
    areaCatastroM2: area ? Number(area) : null,
    fechaAlta: alta ? alta.slice(0, 10) : null,
  };
}

function lista(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}
function titulo(s) {
  return String(s || "").toLowerCase().replace(/(^|[\s\-(/])([a-záéíóúüñ])/g, (m, a, b) => a + b.toUpperCase());
}

/** Extrae lo útil de Consulta_DNPRC: localización, uso y subparcelas. */
export function leerDnprc(datos) {
  const d = typeof datos === "string" ? JSON.parse(datos) : datos;
  const res = d.consulta_dnprcResult || d;
  const errores = res.lerr;
  if (errores) {
    const err = lista(errores.err || errores);
    throw new ErrorLurra("catastro_error", { detalle: (err[0] && err[0].des) || "" });
  }
  const bico = res.bico || {};
  let bi = bico.bi || {};
  const varios = lista(res.lrcdnp && (res.lrcdnp.rcdnp || res.lrcdnp));
  if (!Object.keys(bi).length && varios.length) bi = { dt: varios[0].dt || {}, idbi: { cn: "RU" }, ldt: "", debi: {} };
  const dt = bi.dt || {};
  const rus = (((dt.locs || {}).lors || {}).lorus) || {};
  const cpp = rus.cpp || {};
  const subparcelas = lista(bico.lspr).map((s) => {
    const x = s.dspr || {};
    const cultivo = String(x.dcc || "").trim().toLowerCase();
    return {
      subparcela: s.cspr,
      codigo: x.ccc,
      cultivo: cultivo ? cultivo[0].toUpperCase() + cultivo.slice(1) : "",
      intensidad: x.ip,
      superficieM2: x.ssp ? Number(x.ssp) : null,
    };
  });
  const sup = ((bico.finca || {}).dff || {}).ss;
  return {
    clase: { RU: "rustica", UR: "urbana" }[(bi.idbi || {}).cn] || "",
    provincia: titulo(dt.np),
    municipio: titulo(dt.nm),
    poligono: cpp.cpo || null,
    parcela: cpp.cpa || null,
    paraje: titulo(rus.npa),
    localizacion: String(bi.ldt || "").replace(/\s+/g, " ").trim(),
    uso: (bi.debi || {}).luso || null,
    superficieM2: sup ? Number(sup) : null,
    subparcelas,
  };
}

/** Lee Consulta_RCCOOR y devuelve la referencia de 14 caracteres del punto, o null. */
export function leerRccoor(datos) {
  const d = typeof datos === "string" ? JSON.parse(datos) : datos;
  const res = d.Consulta_RCCOORResult || d;
  const coord = lista(res.coordenadas && res.coordenadas.coord)[0];
  if (!coord || !coord.pc) return null;
  const rc = `${coord.pc.pc1 || ""}${coord.pc.pc2 || ""}`;
  return rc.length === 14 ? { refcat: rc, localizacion: String(coord.ldt || "").trim() } : null;
}

export async function refcatEnPunto(lon, lat, opciones = {}) {
  const url = `${URL_SVC}/COVCCoordenadas.svc/json/Consulta_RCCOOR?CoorX=${lon.toFixed(7)}&CoorY=${lat.toFixed(7)}&SRS=EPSG:4326`;
  try {
    return leerRccoor(await pedir(url, { como: "json", servicio: "Catastro", ...opciones }));
  } catch (e) {
    if (e.clave === "cancelado") throw e;
    return null;
  }
}

/** Descarga geometría y datos no protegidos de una parcela del Catastro estatal. */
export async function obtenerParcela(refcat, opciones = {}) {
  const rc = normalizarRefcat(refcat);
  if (FORALES[rc.slice(0, 2)] && esRustica(rc)) throw new ErrorLurra("catastro_foral", { territorio: FORALES[rc.slice(0, 2)] });
  const srs = CANARIAS.has(rc.slice(0, 2)) ? "EPSG::32628" : "EPSG::25830";
  const url = (s) => `${URL_WFS}?service=wfs&version=2&request=getfeature&STOREDQUERIE_ID=GetParcel&refcat=${rc}&srsname=${s}`;
  let parcela;
  try {
    parcela = await pedir(url(srs), { servicio: "Catastro", leer: leerGmlParcela, ...opciones });
  } catch (e) {
    if (e.clave !== "catastro_sin_geometria") throw e;
    parcela = await pedir(url("EPSG::4326"), { servicio: "Catastro", leer: leerGmlParcela, ...opciones });
  }
  let datos = null;
  try {
    datos = leerDnprc(await pedir(`${URL_SVC}/COVCCallejero.svc/json/Consulta_DNPRC?RefCat=${rc}`, { como: "json", servicio: "Catastro", ...opciones }));
  } catch (e) {
    if (e.clave === "cancelado") throw e;
  }
  return {
    id: parcela.refcat || rc,
    refcat: parcela.refcat || rc,
    origen: "catastro",
    geom: parcela.geom,
    areaCatastroM2: parcela.areaCatastroM2,
    fechaAlta: parcela.fechaAlta,
    datos,
    rustica: esRustica(rc),
  };
}
