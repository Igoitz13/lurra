// Protección ambiental: espacios de la Red Natura 2000 y espacios naturales protegidos.
//
// España: servicios WFS del Inventario Español del Patrimonio Natural y de la Biodiversidad
// (MITECO, geoserver.iepnb.es), que devuelven los polígonos oficiales en GeoJSON.
// Resto de la UE: servicio de la Agencia Europea de Medio Ambiente (Red Natura 2000).

import { deGeoJSON, simplificar } from "./geo.js";
import { pedir } from "./red.js";
import { pct, solapeM2, solapeUnionM2 } from "./contexto.js";

const IEPNB = "https://geoserver.iepnb.es/geoserver";
const EEA = "https://bio.discomap.eea.europa.eu/arcgis/rest/services/ProtectedSites/Natura2000Sites/MapServer/2/query";

export const CAPAS_ES = [
  {
    id: "rn2000", nivel: "ambar",
    url: `${IEPNB}/RN2000/rn2000/wfs`, tipo: "RN2000:rn2000",
    campos: ["id_ref", "nombre", "desc_figura"],
    leer: (p) => ({ codigo: p.id_ref, nombre: p.nombre, figura: p.desc_figura }),
  },
  {
    id: "enp", nivel: "ambar",
    url: `${IEPNB}/ENP/enp/wfs`, tipo: "ENP:enp",
    campos: ["id_ref_es", "nombre", "designacion", "figura"],
    leer: (p) => ({ codigo: p.id_ref_es, nombre: p.nombre, figura: p.designacion || p.figura }),
    // La capa de ENP repite los espacios Natura 2000, que ya salen en su propia capa.
    descartar: (p) => /natura\s*2000/i.test(`${p.figura || ""} ${p.designacion || ""}`),
  },
];

function cajaAmpliada(ctx, metros = 5) {
  const [lon0, lat0, lon1, lat1] = ctx.medida.cajaLonLat;
  const dLat = metros / 111320;
  const dLon = dLat / Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  return [lon0 - dLon, lat0 - dLat, lon1 + dLon, lat1 + dLat];
}

/** Convierte las entidades devueltas en la lista de espacios que tocan la parcela. */
export function cruzar(ctx, entidades, leer, descartar = null) {
  const elementos = [];
  for (const f of entidades) {
    const p = f.properties || f.attributes || {};
    if (descartar && descartar(p)) continue;
    const geom = deGeoJSON(f.geometry);
    if (!geom.length) continue;
    const m2 = solapeM2(ctx, geom);
    // Los que no tocan la parcela (pero sí su entorno) se guardan aparte, solo para el mapa.
    elementos.push({ ...leer(p), m2, pct: pct(ctx, m2), geom });
  }
  elementos.sort((a, b) => b.m2 - a.m2);
  return elementos;
}

/** Contornos simplificados para dibujarlos en el mapa del informe (un píxel de tolerancia). */
function paraDibujar(ctx, geometrias) {
  const [lon0, lat0, lon1, lat1] = ctx.medida.cajaLonLat;
  let tol = Math.max(lon1 - lon0, lat1 - lat0, 1e-5) / 100;
  let salida = geometrias.map((g) => simplificar(g, tol));
  const vertices = (lista) => lista.reduce((n, g) => n + g.reduce((m, pol) => m + pol.reduce((k, an) => k + an.length, 0), 0), 0);
  for (let i = 0; i < 6 && vertices(salida) > 6000; i++) {
    tol *= 2;
    salida = geometrias.map((g) => simplificar(g, tol));
  }
  const red = (v) => Math.round(v * 1e6) / 1e6;
  return salida.map((g) => g.map((pol) => pol.map((an) => an.map(([x, y]) => [red(x), red(y)]))));
}

function resumen(ctx, id, nivel, todos, { dibujar = false } = {}) {
  const elementos = todos.filter((e) => e.m2 > 0);
  // Varios espacios pueden solaparse: la superficie afectada es la de su unión.
  const total = elementos.length > 1 ? solapeUnionM2(ctx, elementos.map((e) => e.geom)) : (elementos[0] ? elementos[0].m2 : 0);
  const dibujo = dibujar && todos.length ? paraDibujar(ctx, todos.map((e) => e.geom)) : undefined;
  elementos.forEach((e) => delete e.geom); // los polígonos completos pesan mucho y ya no hacen falta
  return { id, nivel, estado: "ok", afecta: elementos.length > 0, m2: total, pct: pct(ctx, total), elementos, ...(dibujo ? { dibujo } : {}) };
}

/** Comprueba que la respuesta es una colección de entidades y no un error servido con HTTP 200. */
function coleccion(datos) {
  if (!datos || datos.error || !Array.isArray(datos.features)) throw new Error("la respuesta no es una colección de entidades");
  return datos;
}

async function capaEs(ctx, capa, opciones) {
  const caja = cajaAmpliada(ctx).map((v) => v.toFixed(6)).join(",");
  const url = `${capa.url}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${capa.tipo}&outputFormat=application/json&srsName=EPSG:4326` +
    `&propertyName=${[...capa.campos, "geom"].join(",")}&cql_filter=${encodeURIComponent(`BBOX(geom,${caja},'EPSG:4326')`)}`;
  const datos = await pedir(url, { como: "json", servicio: "IEPNB (MITECO)", espera: 45000, leer: coleccion, ...opciones });
  return resumen(ctx, capa.id, capa.nivel, cruzar(ctx, datos.features, capa.leer, capa.descartar));
}

async function natura2000Ue(ctx, opciones) {
  // Se pide algo más que la parcela para poder dibujar en el mapa los espacios cercanos.
  const [lon0, lat0, lon1, lat1] = ctx.medida.cajaLonLat;
  const entornoM = Math.min(1500, Math.max(150, 111320 * Math.max(lat1 - lat0, (lon1 - lon0) * Math.cos((lat0 * Math.PI) / 180))));
  const caja = cajaAmpliada(ctx, entornoM).map((v) => v.toFixed(6)).join(",");
  const url = `${EEA}?where=1%3D1&geometry=${caja}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&outFields=SITECODE,SITENAME,SITETYPE&returnGeometry=true&outSR=4326&geometryPrecision=6&f=geojson`;
  const datos = await pedir(url, { como: "json", servicio: "EEA Natura 2000", espera: 45000, leer: coleccion, ...opciones });
  // Tipos de espacio de la red: A = aves (ZEPA, en inglés SPA); B = hábitats (LIC/ZEC, SCI/SAC).
  const figura = { A: "ZEPA (SPA)", B: "LIC/ZEC (SCI/SAC)", C: "ZEPA + LIC/ZEC (SPA + SCI/SAC)" };
  const leer = (p) => ({ codigo: p.SITECODE, nombre: p.SITENAME, figura: figura[p.SITETYPE] || p.SITETYPE });
  return resumen(ctx, "rn2000", "ambar", cruzar(ctx, datos.features, leer), { dibujar: true });
}

/** Devuelve una entrada por capa: {id, estado, afecta, m2, pct, elementos}. */
export async function analizar(ctx, ambito, opciones = {}) {
  const tareas = ambito === "es"
    ? CAPAS_ES.map((c) => ({ id: c.id, nivel: c.nivel, fn: () => capaEs(ctx, c, opciones) }))
    : ambito === "ue" ? [{ id: "rn2000", nivel: "ambar", fn: () => natura2000Ue(ctx, opciones) }] : [];
  return Promise.all(tareas.map(async (t) => {
    try {
      return await t.fn();
    } catch (e) {
      if (e.clave === "cancelado") throw e;
      return { id: t.id, nivel: t.nivel, estado: "error", afecta: false, m2: 0, pct: 0, elementos: [], error: String(e.message || e) };
    }
  }));
}
