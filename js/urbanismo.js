// Clasificación urbanística orientativa (solo España).
//
// Fuente: Sistema de Información Urbana (SIU) del Ministerio de Vivienda y Agenda Urbana, que
// reúne en una capa común las clases de suelo del planeamiento que comunican los municipios
// (unos 5.900 municipios, con el 98,6 % de la población). Es una síntesis: no distingue las
// categorías del suelo no urbanizable ni recoge al día cada modificación del planeamiento.
// Servicio ArcGIS REST con respuesta en GeoJSON y cabeceras CORS (comprobado el 18-10-2026).

import { deGeoJSON } from "./geo.js";
import { pedir } from "./red.js";
import { pct, solapeM2 } from "./contexto.js";

const SIU = "https://mapas.fomento.gob.es/arcgis/rest/services/SIU/Servicios_OGC/MapServer/15/query";

/** Clases del SIU (campo ClaseSuelo) y la clave con que las nombra el informe. */
export const CLASES = {
  "SUELO URBANO": "urbano",
  "SUELO URBANO NO CONSOLIDADO": "urbano_nc",
  "SUELO URBANIZABLE DELIMITADO O SECTORIZADO": "urbanizable",
  "SUELO URBANIZABLE NO DELIMITADO O SECTORIZADO": "urbanizable_nd",
  "SUELO NO URBANIZABLE": "no_urbanizable",
  "SISTEMAS GENERALES Y OTROS": "sistemas",
};

function coleccion(datos) {
  if (!datos || datos.error || !Array.isArray(datos.features)) throw new Error("la respuesta no es una colección de entidades");
  return datos;
}

/** Suma por clase la superficie de la parcela que cae en cada una. */
export function resumirClases(ctx, entidades) {
  const porClase = new Map();
  for (const f of entidades) {
    const clase = CLASES[String((f.properties || {}).ClaseSuelo || "").trim().toUpperCase()];
    if (!clase) continue;
    const m2 = solapeM2(ctx, deGeoJSON(f.geometry));
    if (m2 > 0) porClase.set(clase, (porClase.get(clase) || 0) + m2);
  }
  return [...porClase].map(([clase, m2]) => ({ clase, m2, pct: pct(ctx, m2) })).sort((a, b) => b.m2 - a.m2);
}

/**
 * Devuelve {estado: "ok", clases: [{clase, m2, pct}], cubiertoPct}. Con `clases` vacía, el SIU no
 * tiene dato para la parcela (municipio sin información o hueco de la capa).
 */
export async function analizar(ctx, opciones = {}) {
  const [lon0, lat0, lon1, lat1] = ctx.medida.cajaLonLat;
  const caja = [lon0, lat0, lon1, lat1].map((v) => v.toFixed(6)).join(",");
  // Contornos simplificados a unos 2 m: bastan para medir y los del suelo no urbanizable,
  // que abarcan el término municipal entero, pesan mucho menos.
  const url = `${SIU}?where=1%3D1&geometry=${caja}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    "&outFields=ClaseSuelo&returnGeometry=true&outSR=4326&geometryPrecision=6&maxAllowableOffset=0.00002&f=geojson";
  const datos = await pedir(url, { como: "json", servicio: "SIU (Ministerio de Vivienda)", espera: 45000, leer: coleccion, ...opciones });
  const clases = resumirClases(ctx, datos.features);
  const cubierto = clases.reduce((s, c) => s + c.m2, 0);
  return { estado: "ok", clases, cubiertoPct: pct(ctx, Math.min(cubierto, ctx.medida.areaM2)) };
}
