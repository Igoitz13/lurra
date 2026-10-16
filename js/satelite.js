// Historia por satélite: serie de NDVI de Sentinel-2 y caídas bruscas de vegetación.
//
// Fuente: catálogo STAC Earth Search (Element 84) y los COG de Sentinel-2 L2A alojados en
// AWS, de acceso libre y sin cuenta. El navegador lee solo el trozo de cada imagen que cubre
// la parcela. Se toma una escena por mes (la menos nubosa), se descartan nubes y sombras con
// la capa SCL y se promedia el NDVI de los píxeles de la parcela.

import { caja, contar, proyeccionEpsg, rasterizar, transformar } from "./geo.js";
import { enParalelo, ErrorLurra, pedir } from "./red.js";

const URL_STAC = "https://earth-search.aws.element84.com/v1/search";
const COLECCION = "sentinel-2-l2a";
const SCL_VALIDO = new Set([4, 5, 6, 7]); // vegetación, suelo desnudo, agua, sin clasificar
const MIN_VALIDO = 0.7; // fracción mínima de píxeles limpios en la parcela
const CONTEXTO_M = 100; // margen alrededor de la parcela; sirve para estimar el desplazamiento de +1000 si falta la marca
export const UMBRAL_CAIDA = -0.2;
export const UMBRAL_RECUPERA = -0.1;

const entorno = { GeoTIFF: null };
export function configurarSatelite(opciones) {
  Object.assign(entorno, opciones);
}
// La librería GeoTIFF (unos 100 kB) solo hace falta para la historia por satélite: en el
// navegador se descarga la primera vez que se pide, para no frenar la carga de la página.
let cargaGeoTIFF = null;
function cargarScriptGeoTIFF() {
  if (typeof document === "undefined") return Promise.resolve(null);
  cargaGeoTIFF ||= new Promise((ok) => {
    const s = document.createElement("script");
    s.src = new URL("../vendor/geotiff/geotiff.js", import.meta.url).href;
    s.onload = () => ok(globalThis.GeoTIFF || null);
    s.onerror = () => { cargaGeoTIFF = null; ok(null); };
    document.head.append(s);
  });
  return cargaGeoTIFF;
}
async function geotiff() {
  const g = entorno.GeoTIFF || globalThis.GeoTIFF || (await cargarScriptGeoTIFF());
  if (!g) throw new ErrorLurra("servicio", { servicio: "GeoTIFF" });
  return g;
}

// ------------------------------------------------------------------ búsqueda
// Cada escena del catálogo pesa de 20 a 35 kB, casi todo en recursos que aquí no se usan, y
// el servicio no puede devolver más de 6 MB por respuesta (con 200 escenas antiguas por
// página falla; comprobado el 12-10-2026). Por eso se piden solo los campos necesarios y se
// excluyen los demás recursos: unos 2 kB por escena.
const RECURSOS_SOBRANTES = [
  "aot", "blue", "coastal", "granule_metadata", "green", "nir08", "nir09", "rededge1", "rededge2", "rededge3", "swir16", "swir22",
  "thumbnail", "tileinfo_metadata", "visual", "wvp", "cloud", "snow", "product_metadata", "preview",
  ...["aot", "blue", "coastal", "green", "nir", "nir08", "nir09", "red", "rededge1", "rededge2", "rededge3", "scl", "swir16", "swir22", "visual", "wvp"].map((n) => `${n}-jp2`),
];
const CAMPOS = {
  include: ["id", "properties.datetime", "properties.eo:cloud_cover", "properties.s2:sequence", "properties.s2:processing_baseline",
    "properties.earthsearch:boa_offset_applied", "properties.proj:epsg", "properties.proj:code", "assets.red.href", "assets.nir.href", "assets.scl.href"],
  exclude: ["geometry", "bbox", "links", "stac_extensions", "collection", "stac_version", ...RECURSOS_SOBRANTES.map((n) => `assets.${n}`)],
};

async function buscarPaginas(cuerpoInicial, senal) {
  let cuerpo = cuerpoInicial;
  const escenas = [];
  let url = URL_STAC;
  for (let pagina = 0; pagina < 40; pagina++) {
    const datos = await pedir(url, {
      como: "json", servicio: "Earth Search (Sentinel-2)", metodo: "POST", guardar: false, espera: 60000, senal,
      cabeceras: { "Content-Type": "application/json" }, cuerpo: JSON.stringify(cuerpo),
      leer: (d) => { if (!d || !Array.isArray(d.features)) throw new Error("respuesta sin escenas"); return d; },
    });
    escenas.push(...datos.features);
    const sig = (datos.links || []).find((e) => e.rel === "next");
    // El catálogo ofrece «next» aunque ya no queden más: una página incompleta es la última.
    if (!sig || datos.features.length < cuerpo.limit) break;
    url = sig.href || URL_STAC;
    const nuevo = sig.body || null;
    if (!nuevo) break;
    cuerpo = sig.merge ? { ...cuerpo, ...nuevo } : nuevo;
    if (!cuerpo.limit) cuerpo.limit = cuerpoInicial.limit;
  }
  return escenas;
}

export async function buscarEscenas(lon, lat, desde, hasta, { nubesMax = 60, senal = null } = {}) {
  const base = {
    collections: [COLECCION],
    intersects: { type: "Point", coordinates: [lon, lat] },
    datetime: `${desde}T00:00:00Z/${hasta}T23:59:59Z`,
    query: { "eo:cloud_cover": { lt: nubesMax } },
  };
  let escenas;
  try {
    escenas = await buscarPaginas({ ...base, limit: 400, fields: CAMPOS }, senal);
  } catch (e) {
    if (e.clave === "cancelado") throw e;
    // Si el servicio no admitiera la selección de campos, se pide todo en páginas pequeñas.
    escenas = await buscarPaginas({ ...base, limit: 100 }, senal);
  }
  // Solo sirven las escenas que traen las tres capas que se leen.
  return escenas.filter((e) => e && e.properties && e.properties.datetime && e.assets && e.assets.red && e.assets.nir && e.assets.scl);
}

/** Una escena por fecha: el catálogo repite adquisiciones reprocesadas (_0_, _1_…). */
export function sinDuplicados(escenas) {
  const mejor = new Map();
  const orden = (e) => Number(e.properties["s2:sequence"] || 0) || 0;
  for (const e of escenas) {
    const dia = e.properties.datetime.slice(0, 10);
    if (!mejor.has(dia) || orden(e) > orden(mejor.get(dia))) mejor.set(dia, e);
  }
  return [...mejor.keys()].sort().map((d) => mejor.get(d));
}

/** Agrupa por mes natural, con las candidatas de cada mes ordenadas de menos a más nubes. */
export function candidatasPorMes(escenas, porMes = 2) {
  const grupos = new Map();
  for (const e of escenas) {
    const mes = e.properties.datetime.slice(0, 7);
    if (!grupos.has(mes)) grupos.set(mes, []);
    grupos.get(mes).push(e);
  }
  return [...grupos.keys()].sort().map((mes) => ({
    mes,
    escenas: grupos.get(mes).sort((a, b) => (a.properties["eo:cloud_cover"] ?? 100) - (b.properties["eo:cloud_cover"] ?? 100)).slice(0, porMes),
  }));
}

// ------------------------------------------------------------------- lectura
function epsgEscena(item) {
  const p = item.properties;
  if (p["proj:epsg"]) return Number(p["proj:epsg"]);
  const codigo = String(p["proj:code"] || "");
  if (/^EPSG:/i.test(codigo)) return Number(codigo.split(":")[1]);
  throw new Error(`La escena ${item.id} no declara proyección`);
}

function percentil(valores, q) {
  if (!valores.length) return null;
  const v = Float64Array.from(valores).sort();
  return v[Math.min(v.length - 1, Math.max(0, Math.floor((q / 100) * (v.length - 1))))];
}

/**
 * Desplazamiento que hay que restar a los valores digitales (0 o 1000).
 * Desde la línea de proceso 04.00 (25-1-2022) ESA suma 1000 a los valores. Earth Search marca
 * cada escena con `earthsearch:boa_offset_applied` (verdadero si el COG ya lo trae restado),
 * pero en escenas de 2022 la marca dice «falso» y los datos ya vienen sin el desplazamiento
 * (comprobado con datos reales el 11-10-2026). Por eso la marca «falso» se contrasta con los
 * datos: con el desplazamiento puesto, el rojo de los píxeles limpios no baja de 1000.
 */
export function desplazamientoDn(propiedades, rojoLimpio) {
  const base = Number(propiedades["s2:processing_baseline"]);
  if (!Number.isFinite(base) || base < 4.0) return 0;
  const marca = propiedades["earthsearch:boa_offset_applied"];
  if (marca === true) return 0;
  const validos = Array.from(rojoLimpio).filter((v) => v > 0);
  const p5 = validos.length >= 30 ? percentil(validos, 5) : null;
  if (marca === false) return p5 === null || p5 >= 1000 ? 1000 : 0;
  return p5 !== null && p5 >= 1000 ? 1000 : 0;
}

/** NDVI medio a partir de las ventanas ya leídas. Función pura, para poder probarla. */
export function ndviDeVentanas({ rojo, nir, scl, mascara, propiedades }) {
  const dentro = contar(mascara);
  if (!dentro) return null;
  const limpios = [];
  for (let k = 0; k < rojo.length; k++) if (SCL_VALIDO.has(scl[k])) limpios.push(rojo[k]);
  const resta = desplazamientoDn(propiedades, limpios);
  let util = 0, suma = 0, n = 0;
  for (let k = 0; k < mascara.length; k++) {
    if (!mascara[k]) continue;
    if (!SCL_VALIDO.has(scl[k]) || !(rojo[k] > 0) || !(nir[k] > 0)) continue;
    util++;
    const r = rojo[k] - resta, i = nir[k] - resta;
    if (r + i <= 0) continue;
    suma += Math.max(-1, Math.min(1, (i - r) / (i + r)));
    n++;
  }
  const fraccion = util / dentro;
  if (fraccion < MIN_VALIDO || !n) return null;
  return { ndvi: suma / n, validos: Math.round(fraccion * 100) / 100, pixeles: dentro, restaDn: resta };
}

async function abrir(href, nivel) {
  // Bloques de 16 kB: la cabecera de cada imagen cabe en uno y no se descarga de más.
  const tiff = await (await geotiff()).fromUrl(href.includes("://") ? href : `https://${href}`, { cacheSize: 60, blockSize: 16384 });
  const base = await tiff.getImage(0);
  const img = nivel ? await tiff.getImage(nivel) : base;
  const [ox, oy] = base.getOrigin();
  const res = Math.abs(base.getResolution()[0]) * (base.getWidth() / img.getWidth());
  return { img, ox, oy, res, w: img.getWidth(), h: img.getHeight() };
}

/** Fracción de la parcela con píxeles limpios según la capa SCL. */
export function fraccionLimpia(scl, mascara) {
  let dentro = 0, limpio = 0;
  for (let k = 0; k < mascara.length; k++) if (mascara[k]) { dentro++; if (SCL_VALIDO.has(scl[k])) limpio++; }
  return dentro ? limpio / dentro : 0;
}

/** NDVI medio de la parcela en una escena, o null si no es utilizable (nubes, fuera de imagen). */
export async function ndviEscena(item, geomLonLat, { resolucion = 20, senal = null } = {}) {
  const proy = proyeccionEpsg(epsgEscena(item));
  const geom = transformar(geomLonLat, proy.directa);
  const [x0, y0, x1, y1] = caja(geom);
  const leer = async (r, v) => (await r.img.readRasters({ window: v, signal: senal || undefined }))[0];
  const mascaraEn = (rej) => {
    const m = rasterizar(geom, rej);
    return contar(m) < 4 ? rasterizar(geom, rej, { todoTocado: true }) : m;
  };

  // 1. Capa de clasificación (20 m, pocos kB): si la parcela está nublada no se lee nada más.
  const cl = await abrir(item.assets.scl.href, 0);
  const { ox, oy } = cl;
  const c0 = Math.max(0, Math.floor((x0 - CONTEXTO_M - ox) / cl.res)), f0 = Math.max(0, Math.floor((oy - (y1 + CONTEXTO_M)) / cl.res));
  const c1 = Math.min(cl.w, Math.ceil((x1 + CONTEXTO_M - ox) / cl.res)), f1 = Math.min(cl.h, Math.ceil((oy - (y0 - CONTEXTO_M)) / cl.res));
  if (c1 <= c0 || f1 <= f0) return null;
  const w20 = c1 - c0, h20 = f1 - f0;
  const scl20 = await leer(cl, [c0, f0, c1, f1]);
  if (fraccionLimpia(scl20, mascaraEn({ x0: ox + c0 * cl.res, y1: oy - f0 * cl.res, res: cl.res, w: w20, h: h20 })) < MIN_VALIDO) return null;

  // 2. Rojo e infrarrojo, a 20 m (vista reducida) o a 10 m.
  const nivel = resolucion >= 20 ? 1 : 0;
  const [rojo, nir] = await Promise.all([abrir(item.assets.red.href, nivel), abrir(item.assets.nir.href, nivel)]);
  const f = Math.max(1, Math.round(cl.res / rojo.res)); // 1 a 20 m; 2 a 10 m
  const ventana = [c0 * f, f0 * f, Math.min(rojo.w, c1 * f), Math.min(rojo.h, f1 * f)];
  const w = ventana[2] - ventana[0], h = ventana[3] - ventana[1];
  const [bRojo, bNir] = await Promise.all([leer(rojo, ventana), leer(nir, ventana)]);
  let scl = scl20;
  if (f > 1) {
    scl = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) scl[j * w + i] = scl20[Math.min(h20 - 1, Math.floor(j / f)) * w20 + Math.min(w20 - 1, Math.floor(i / f))];
  }
  const mascara = mascaraEn({ x0: ox + ventana[0] * rojo.res, y1: oy - ventana[1] * rojo.res, res: rojo.res, w, h });
  const r = ndviDeVentanas({ rojo: bRojo, nir: bNir, scl, mascara, propiedades: item.properties });
  if (!r) return null;
  return { fecha: item.properties.datetime.slice(0, 10), ...r, escena: item.id, resolucion: rojo.res };
}

/**
 * Serie mensual de NDVI. Llama a `alAvance({hechas, total, serie})` según va leyendo.
 * Devuelve {serie, escenas, fallos, resolucion}.
 */
export async function serieNdvi(geomLonLat, centroLonLat, { desde = "2017-01-01", hasta = null, resolucion = 20, hilos = 4, alAvance = null, senal = null } = {}) {
  hasta = hasta || new Date().toISOString().slice(0, 10);
  const [lon, lat] = centroLonLat.map((v) => Number(v.toFixed(6)));
  const meses = candidatasPorMes(sinDuplicados(await buscarEscenas(lon, lat, desde, hasta, { senal })));
  const serie = [];
  let hechas = 0, fallos = 0, leidas = 0;
  // Se lee de lo más reciente a lo más antiguo: si el usuario para la lectura a medias, se
  // queda con los últimos años, que son los que más interesan.
  await enParalelo([...meses].reverse(), hilos, async (m) => {
    for (const item of m.escenas) {
      if (senal && senal.aborted) throw new ErrorLurra("cancelado");
      try {
        leidas++;
        const r = await ndviEscena(item, geomLonLat, { resolucion, senal });
        if (r) { serie.push(r); break; }
      } catch (e) {
        if (senal && senal.aborted) throw new ErrorLurra("cancelado");
        fallos++;
      }
    }
    hechas++;
    if (alAvance) alAvance({ hechas, total: meses.length, serie: [...serie].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)) });
  });
  if (meses.length && fallos >= leidas) throw new ErrorLurra("servicio", { servicio: "Sentinel-2 (AWS)" });
  serie.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  return { serie, meses: meses.length, fallos, resolucion };
}

// ------------------------------------------------------------------ análisis
const mediana = (v) => {
  const o = [...v].sort((a, b) => a - b);
  return o.length % 2 ? o[(o.length - 1) / 2] : (o[o.length / 2 - 1] + o[o.length / 2]) / 2;
};
const media = (v) => v.reduce((a, b) => a + b, 0) / v.length;

const mesDe = (o) => Number(o.fecha.slice(5, 7));
const dias = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
const MARGEN_VUELTA = 0.2; // para dar una caída por recuperada, lo habitual debe distinguirse así del mínimo de la caída
const DIAS_CAIDA_CORTA = 550; // una caída más corta (un barbecho, una sequía) pasa a formar parte de lo habitual

/**
 * NDVI habitual para un mes según las observaciones de referencia (las anteriores).
 * Con tres o más años de ese mismo mes es su valor más bajo (el segundo más bajo si hay
 * ocho o más): lo que la finca ya ha mostrado otros años en ese mes no es una anomalía, y
 * así un barbecho que se repite no cuenta como caída cada vez. Con menos historia se usa la
 * mediana de ese mes y los dos vecinos (al menos dos observaciones).
 */
function habitualDe(referencias, mes) {
  const exactas = [], vecinas = [];
  for (const r of referencias) {
    const d = Math.min((r.mes - mes + 12) % 12, (mes - r.mes + 12) % 12);
    if (d === 0) exactas.push(r.ndvi);
    if (d <= 1) vecinas.push(r.ndvi);
  }
  if (exactas.length >= 3) {
    exactas.sort((a, b) => a - b);
    return exactas[exactas.length >= 8 ? 1 : 0];
  }
  return vecinas.length >= 2 ? mediana(vecinas) : null;
}

/**
 * Resumen de la serie: valores anuales, tendencia y caídas bruscas.
 *
 * Cada observación se compara con lo habitual en ese mes del año según las observaciones
 * ANTERIORES (no con toda la serie: así un cambio permanente, como una tala, no acaba
 * formando parte de «lo habitual»). Una caída empieza con dos observaciones seguidas con el
 * NDVI 0,20 o más por debajo de lo habitual. Mientras dura, la referencia queda congelada en
 * los valores de antes de la caída. Termina cuando una observación vuelve a quedar a menos
 * de 0,10 de aquella referencia en un mes en que eso significa algo (en pleno verano un
 * cereal y un suelo desnudo dan casi lo mismo, y eso no es recuperarse); si no ocurre, la
 * caída queda como no recuperada.
 */
export function analizar(serie) {
  if (serie.length < 12) return { suficiente: false, n: serie.length, anual: [], eventos: [], anomalias: [] };
  const referencias = []; // observaciones «normales» anteriores: {mes, ndvi}
  const anomalias = [];
  const eventos = [];
  let pendientes = []; // observaciones bajas que aún no forman una caída
  let evento = null; // caída abierta
  let enCurso = null; // sus observaciones y su NDVI mínimo
  for (const o of serie) {
    const mes = mesDe(o);
    const base = habitualDe(referencias, mes);
    if (base === null) { referencias.push({ mes, ndvi: o.ndvi }); continue; }
    const anomalia = o.ndvi - base;
    anomalias.push({ fecha: o.fecha, anomalia });
    if (evento) {
      const distinguible = base >= enCurso.minimoNdvi + MARGEN_VUELTA;
      if (anomalia > UMBRAL_RECUPERA && distinguible) {
        evento.recuperado = o.fecha;
        // Una caída corta ya recuperada (barbecho, sequía, siega tardía) es parte de lo que
        // la finca hace: sus valores pasan a la referencia. Una larga no, para que una
        // segunda tala o un segundo incendio se vuelvan a señalar.
        if (dias(evento.inicio, o.fecha) < DIAS_CAIDA_CORTA) referencias.push(...enCurso.observaciones);
        evento = null; enCurso = null;
        referencias.push({ mes, ndvi: o.ndvi });
        continue;
      }
      enCurso.observaciones.push({ mes, ndvi: o.ndvi });
      enCurso.minimoNdvi = Math.min(enCurso.minimoNdvi, o.ndvi);
      if (anomalia <= UMBRAL_CAIDA) {
        evento.fin = o.fecha;
        evento.observaciones++;
        evento.minimo = Math.min(evento.minimo, anomalia);
      }
      continue;
    }
    if (anomalia <= UMBRAL_CAIDA) {
      pendientes.push({ fecha: o.fecha, anomalia, mes, ndvi: o.ndvi });
      if (pendientes.length >= 2) {
        evento = { inicio: pendientes[0].fecha, fin: o.fecha, minimo: Math.min(...pendientes.map((x) => x.anomalia)), observaciones: pendientes.length, recuperado: null };
        enCurso = { observaciones: pendientes.map((x) => ({ mes: x.mes, ndvi: x.ndvi })), minimoNdvi: Math.min(...pendientes.map((x) => x.ndvi)) };
        eventos.push(evento);
        pendientes = [];
      }
      continue;
    }
    // Una sola observación baja y aislada (sombra, nieve, siega) no cuenta ni sirve de referencia.
    pendientes = [];
    referencias.push({ mes, ndvi: o.ndvi });
  }

  // Valor de cada año sin el efecto de los meses que falten: media de las diferencias de cada
  // observación con lo habitual en su mes (aquí sí con toda la serie), más la media general.
  const porMes = new Map();
  for (const o of serie) {
    if (!porMes.has(mesDe(o))) porMes.set(mesDe(o), []);
    porMes.get(mesDe(o)).push(o.ndvi);
  }
  const clima = new Map([...porMes].map(([m, v]) => [m, mediana(v)]));
  const nivel = media([...clima.values()]);
  const porAno = new Map();
  for (const o of serie) {
    const a = Number(o.fecha.slice(0, 4));
    if (!porAno.has(a)) porAno.set(a, []);
    porAno.get(a).push(o.ndvi - clima.get(mesDe(o)));
  }
  const anual = [...porAno].filter(([, v]) => v.length >= 4).sort((a, b) => a[0] - b[0]).map(([ano, v]) => ({ ano, ndvi: nivel + media(v), n: v.length }));
  let tendenciaDecada = null;
  if (anual.length >= 5) {
    const mx = media(anual.map((a) => a.ano)), my = media(anual.map((a) => a.ndvi));
    const num = anual.reduce((s, a) => s + (a.ano - mx) * (a.ndvi - my), 0);
    const den = anual.reduce((s, a) => s + (a.ano - mx) ** 2, 0);
    tendenciaDecada = den ? (num / den) * 10 : null;
  }
  return {
    suficiente: true,
    n: serie.length,
    desde: serie[0].fecha,
    hasta: serie[serie.length - 1].fecha,
    media: media(serie.map((o) => o.ndvi)),
    anual,
    tendenciaDecada,
    eventos,
    anomalias,
  };
}
