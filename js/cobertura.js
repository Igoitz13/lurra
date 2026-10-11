// Cobertura del suelo fuera de España: mapa mundial de 10 m «Sentinel-2 Land Use/Land Cover»
// (Impact Observatory, Microsoft y Esri; CC BY 4.0). El servicio devuelve el recuento de
// píxeles de cada clase dentro del polígono.

import { pedir } from "./red.js";

const URL = "https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/computeHistograms";
export const CLASES = { 1: "agua", 2: "arbolado", 4: "vegetacion_inundada", 5: "cultivos", 7: "construido", 8: "suelo_desnudo", 9: "nieve", 10: "nubes", 11: "pastizal_matorral" };

/** Convierte la respuesta del servicio en porcentajes por clase. */
export function leerHistograma(datos) {
  const h = datos && datos.histograms && datos.histograms[0];
  if (!h || !h.counts) return [];
  const paso = (h.max - h.min) / h.size;
  const total = h.counts.reduce((a, b) => a + b, 0);
  if (!total) return [];
  return h.counts
    .map((n, i) => ({ clase: CLASES[Math.round(h.min + paso * (i + 0.5))] || null, pct: (100 * n) / total }))
    .filter((c) => c.clase && c.pct >= 0.5)
    .sort((a, b) => b.pct - a.pct);
}

export async function analizar(ctx, opciones = {}) {
  const geometria = { rings: ctx.parcela.geom.flat(), spatialReference: { wkid: 4326 } };
  const cuerpo = new URLSearchParams({
    f: "json",
    geometryType: "esriGeometryPolygon",
    geometry: JSON.stringify(geometria),
    pixelSize: JSON.stringify({ x: 10, y: 10, spatialReference: { wkid: 3857 } }),
  });
  const leer = (datos) => {
    if (!datos || datos.error) throw new Error("el servicio ha devuelto un error");
    const clases = leerHistograma(datos);
    if (!clases.length) throw new Error("sin datos de cobertura");
    return clases;
  };
  const clases = await pedir(URL, { como: "json", servicio: "Esri Land Cover", metodo: "POST", cuerpo, guardar: false, leer, ...opciones });
  return { estado: "ok", clases };
}
