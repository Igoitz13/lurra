// Fuentes mundiales para los recintos de fuera de España.
//
// - Inundación fluvial: mapa mundial de peligrosidad para un periodo de retorno de 100 años,
//   de GloFAS (Servicio de Gestión de Emergencias de Copernicus y JRC de la Comisión Europea),
//   servido como imagen WMS. Sus celdas miden unos 150 m, solo considera los ríos grandes y no
//   tiene en cuenta las defensas: es una primera orientación, no cartografía oficial.
// - Nombre del lugar: geocodificación inversa de Nominatim (OpenStreetMap).

import { pedir } from "./red.js";
import { leerTesela } from "./teselas.js";
import { pct, porCelda } from "./contexto.js";

const GLOFAS = "https://ows.globalfloods.eu/glofas-ows/ows.py";
const CAPA = "FloodHazard100y";
export const CELDA_M = 150; // tamaño aproximado de la celda del modelo
const ENTORNO_M = 500;
const ALFA_MIN = 32;

/** URL de la imagen del modelo para una caja. `srs`: EPSG:4326 (lon/lat) o EPSG:3857. */
export function urlInundacion(caja, ancho, alto, srs = "EPSG:4326") {
  const cifras = srs === "EPSG:4326" ? 6 : 2;
  return `${GLOFAS}?service=WMS&version=1.1.1&request=GetMap&layers=${CAPA}&styles=&srs=${srs}&bbox=${caja.map((v) => v.toFixed(cifras)).join(",")}` +
    `&width=${ancho}&height=${alto}&format=image/png&transparent=true`;
}

/**
 * Cruza la parcela con el modelo mundial. Devuelve la misma forma que el análisis de España:
 * una lista de capas (aquí, una sola) con la superficie afectada. Si el servicio falla lanza
 * un error: nunca devuelve «no inundable» sin haber leído la imagen.
 */
export async function inundacion(ctx, opciones = {}) {
  const [lon0, lat0, lon1, lat1] = ctx.medida.cajaLonLat;
  const latMedia = (lat0 + lat1) / 2;
  const cosLat = Math.max(0.05, Math.cos((latMedia * Math.PI) / 180));
  const dLat = ENTORNO_M / 111320;
  const dLon = dLat / cosLat;
  const caja = [lon0 - dLon, lat0 - dLat, lon1 + dLon, lat1 + dLat];
  // Píxeles de unos 30 m: bastante más finos que las celdas del modelo.
  const lado = (metros) => Math.max(64, Math.min(1024, Math.ceil(metros / 30)));
  const ancho = lado((caja[2] - caja[0]) * 111320 * cosLat);
  const alto = lado((caja[3] - caja[1]) * 111320);
  const img = await leerTesela(urlInundacion(caja, ancho, alto), { servicio: "GloFAS (Copernicus)", estricto: true, espera: 30000, ...opciones });
  if (!img || !(img.w > 0) || !(img.h > 0)) throw new Error("imagen vacía");

  const pintado = (u, v) => img.datos[(v * img.w + u) * 4 + 3] > ALFA_MIN;
  let n = 0;
  porCelda(ctx, (i, j) => {
    const [lon, lat] = ctx.aLonLat(i, j);
    const u = Math.max(0, Math.min(img.w - 1, Math.floor(((lon - caja[0]) / (caja[2] - caja[0])) * img.w)));
    const v = Math.max(0, Math.min(img.h - 1, Math.floor(((caja[3] - lat) / (caja[3] - caja[1])) * img.h)));
    if (pintado(u, v)) n++;
  });
  let cerca = n > 0;
  for (let k = 3; !cerca && k < img.datos.length; k += 4) if (img.datos[k] > ALFA_MIN) cerca = true;
  const m2 = n * ctx.m2PorCelda;
  return {
    estado: "ok",
    modelo: "glofas",
    capas: [{ id: "fluvial_t100_mundo", grupo: "fluvial", periodo: 100, nivel: "ambar", estado: "ok", m2, pct: pct(ctx, m2), afecta: m2 > 0, enEntorno: cerca }],
    pixelM: CELDA_M,
    entornoM: ENTORNO_M,
  };
}

/**
 * Nombre del lugar donde cae el recinto: {texto, pais} o null si no se puede saber.
 * Se envía el centro redondeado a unos 100 m: basta para saber el municipio.
 */
export async function lugar([lon, lat], idioma = "es", opciones = {}) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&zoom=10&accept-language=${encodeURIComponent(idioma)}`;
  try {
    const d = await pedir(url, { como: "json", servicio: "Nominatim", espera: 12000, reintentos: 0, ...opciones });
    return leerLugar(d);
  } catch (e) {
    if (e.clave === "cancelado") throw e;
    return null; // el informe no depende de este dato
  }
}

/** Interpreta la respuesta de Nominatim: localidad, región y país, sin repetir. */
export function leerLugar(d) {
  const a = (d && d.address) || {};
  const local = a.village || a.town || a.city || a.municipality || a.county || (d && d.name) || null;
  const region = a.state || a.region || a.province || a.state_district || a.county || null;
  const partes = [...new Set([local, region, a.country].filter(Boolean))];
  if (!partes.length) return null;
  return { texto: partes.join(", "), pais: a.country_code ? String(a.country_code).toUpperCase() : null };
}
