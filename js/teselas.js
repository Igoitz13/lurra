// Teselas de mapa (rejilla estándar «GoogleMapsCompatible») y lectura de sus píxeles.

import { aMercator, MEDIO_MUNDO, resolucionMercator } from "./geo.js";
import { ErrorLurra } from "./red.js";

const entorno = {
  fetch: (...a) => globalThis.fetch(...a),
  // Decodifica un PNG/JPEG a RGBA. En el navegador usa un lienzo; en las pruebas se sustituye.
  decodificar: async (buffer) => {
    const blob = new Blob([buffer]);
    let mapa;
    try {
      mapa = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    } catch {
      mapa = await createImageBitmap(blob);
    }
    const lienzo = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(mapa.width, mapa.height)
      : Object.assign(document.createElement("canvas"), { width: mapa.width, height: mapa.height });
    const g = lienzo.getContext("2d", { willReadFrequently: true });
    g.drawImage(mapa, 0, 0);
    const datos = g.getImageData(0, 0, mapa.width, mapa.height).data;
    if (mapa.close) mapa.close();
    return { w: lienzo.width, h: lienzo.height, datos };
  },
};
export function configurarTeselas(opciones) {
  Object.assign(entorno, opciones);
}

/** Índices de tesela que cubren una caja en lon/lat en el nivel z. */
export function teselasDeCaja([lon0, lat0, lon1, lat1], z) {
  const res = resolucionMercator(z) * 256;
  const [mx0, my0] = aMercator(lon0, lat0);
  const [mx1, my1] = aMercator(lon1, lat1);
  const n = 2 ** z;
  const lim = (v) => Math.max(0, Math.min(n - 1, v));
  return {
    z,
    x0: lim(Math.floor((mx0 + MEDIO_MUNDO) / res)),
    x1: lim(Math.floor((mx1 + MEDIO_MUNDO) / res)),
    y0: lim(Math.floor((MEDIO_MUNDO - my1) / res)),
    y1: lim(Math.floor((MEDIO_MUNDO - my0) / res)),
  };
}
export function numTeselas(t) {
  return (t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1);
}
/**
 * Mayor nivel de zoom (hasta zMax) con el que la caja cabe en `maxTeselas` teselas.
 * Si ni en el nivel mínimo cabe (recinto con partes muy separadas), lanza un error claro
 * en lugar de pedir cientos de teselas.
 */
export function elegirZoom(cajaLonLat, zMax, maxTeselas, zMin = 8) {
  for (let z = zMax; z > zMin; z--) if (numTeselas(teselasDeCaja(cajaLonLat, z)) <= maxTeselas) return z;
  if (numTeselas(teselasDeCaja(cajaLonLat, zMin)) > maxTeselas * 4) throw new ErrorLurra("muy_disperso");
  return zMin;
}

/**
 * Descarga y decodifica una tesela. Devuelve null si el servicio dice que no hay tesela
 * (fuera de cobertura) y lanza ErrorLurra si el servicio falla. Con `estricto`, «no hay
 * tesela» también es un fallo: sirve para los servicios que contestan siempre con una imagen
 * (transparente donde no hay nada), en los que un 404 o una página de error no significan
 * «aquí no hay nada». Hace un reintento.
 */
export async function leerTesela(url, opciones = {}) {
  try {
    return await leerTeselaUnaVez(url, opciones);
  } catch (e) {
    if (e.clave === "cancelado") throw e;
    await new Promise((ok) => setTimeout(ok, 500));
    return leerTeselaUnaVez(url, opciones);
  }
}

async function leerTeselaUnaVez(url, { servicio = "", senal = null, espera = 25000, estricto = false } = {}) {
  if (senal && senal.aborted) throw new ErrorLurra("cancelado");
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), espera);
  const alCancelar = () => control.abort();
  if (senal) senal.addEventListener("abort", alCancelar, { once: true });
  try {
    const r = await entorno.fetch(url, { signal: control.signal });
    const vacia = (motivo) => {
      if (estricto) throw new Error(motivo);
      return null;
    };
    if ([204, 400, 404].includes(r.status)) return vacia(`HTTP ${r.status}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const tipo = (r.headers && r.headers.get && r.headers.get("content-type")) || "";
    if (tipo && !/image/i.test(tipo)) return vacia(`respuesta de tipo ${tipo}`);
    const buffer = await r.arrayBuffer();
    if (!buffer.byteLength) return vacia("respuesta vacía");
    return await entorno.decodificar(buffer);
  } catch (e) {
    if (senal && senal.aborted) throw new ErrorLurra("cancelado");
    throw new ErrorLurra("servicio", { servicio }, e);
  } finally {
    clearTimeout(reloj);
    if (senal) senal.removeEventListener("abort", alCancelar);
  }
}

/** Plantillas de URL de las capas de teselas que usa la web (para leer y para dibujar). */
export const CAPAS_TESELA = {
  pnoa: (z, x, y) => `https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`,
  ignBase: (z, x, y) => `https://www.ign.es/wmts/ign-base?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=IGNBaseTodo&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`,
  osm: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  s2: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`,
  terrarium: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  snczi: (capa) => (z, x, y) => `https://wmts-snczi.idee.es/wmts/riesgos-naturales/inundaciones?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${capa}&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/png`,
};
