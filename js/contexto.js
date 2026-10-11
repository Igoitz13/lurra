// Contexto de cálculo de una parcela: su proyección local en metros y una rejilla fina
// con la máscara de la parcela. Todos los cruces de superficie se miden contando celdas
// de esa rejilla, así no hace falta una biblioteca de recorte de polígonos.

import { contar, crearRejilla, mapeoRejilla, medir, rasterizar, transformar } from "./geo.js";

export function crearContexto(parcela, { maxCeldas = 1000000 } = {}) {
  const medida = medir(parcela.geom);
  const provisional = crearRejilla(medida.cajaXY, { maxCeldas });
  const rejilla = crearRejilla(medida.cajaXY, { res: provisional.res, margen: provisional.res * 2 });
  let mascara = rasterizar(medida.xy, rejilla);
  let celdas = contar(mascara);
  if (celdas === 0) {
    mascara = rasterizar(medida.xy, rejilla, { todoTocado: true });
    celdas = contar(mascara);
  }
  return {
    parcela,
    medida,
    rejilla,
    mascara,
    celdas,
    // Cada celda representa esta superficie: se ajusta para que la suma coincida con la medida exacta.
    m2PorCelda: celdas ? medida.areaM2 / celdas : rejilla.res ** 2,
    aLonLat: mapeoRejilla(rejilla, (x, y) => medida.local.inversa(x, y)),
  };
}

/** Máscara (sobre la rejilla del contexto) de las celdas de la parcela que cubre una geometría. */
export function mascaraSolape(ctx, geomLonLat) {
  const otra = rasterizar(transformar(geomLonLat, ctx.medida.local.directa), ctx.rejilla);
  for (let i = 0; i < otra.length; i++) otra[i] &= ctx.mascara[i];
  return otra;
}

/** Superficie (m²) de la parte de la parcela cubierta por una geometría en lon/lat. */
export function solapeM2(ctx, geomLonLat) {
  if (!geomLonLat || !geomLonLat.length) return 0;
  return contar(mascaraSolape(ctx, geomLonLat)) * ctx.m2PorCelda;
}

/**
 * Superficie (m²) de la parte de la parcela cubierta por al menos una de las geometrías.
 * Cada una se rasteriza por separado y se acumula: así los solapes entre ellas no se anulan.
 */
export function solapeUnionM2(ctx, geometrias) {
  let union = null;
  for (const g of geometrias) {
    if (!g || !g.length) continue;
    const m = mascaraSolape(ctx, g);
    if (!union) union = m;
    else for (let i = 0; i < m.length; i++) union[i] |= m[i];
  }
  return union ? contar(union) * ctx.m2PorCelda : 0;
}

/** Recorre las celdas de la parcela: llama a fn(i, j, indice) solo en las que están dentro. */
export function porCelda(ctx, fn) {
  const { w, h } = ctx.rejilla;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    if (ctx.mascara[k]) fn(i, j, k);
  }
}

export function pct(ctx, m2) {
  return ctx.medida.areaM2 > 0 ? Math.min(100, (100 * m2) / ctx.medida.areaM2) : 0;
}
