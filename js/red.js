// Peticiones a los servicios públicos, con tiempo de espera, reintento y caché en memoria.

/** Error que se puede enseñar al usuario: `clave` es la entrada de textos de i18n. */
export class ErrorLurra extends Error {
  constructor(clave, datos = {}, causa = null) {
    super(clave + (causa ? `: ${causa.message || causa}` : ""));
    this.name = "ErrorLurra";
    this.clave = clave;
    this.datos = datos;
    this.causa = causa;
  }
}

const entorno = { fetch: (...a) => globalThis.fetch(...a) };
const cache = new Map();
const TOPE_CACHE = 400;

/** Solo para pruebas: sustituye `fetch`. */
export function configurarRed(opciones) {
  Object.assign(entorno, opciones);
  cache.clear();
}

/**
 * Pide una URL. `como`: "texto", "json", "binario" (ArrayBuffer) o "respuesta".
 * `leer(dato)` interpreta la respuesta: si lanza un error (el servicio ha devuelto una página
 * de error con HTTP 200, por ejemplo) la petición cuenta como fallida, se reintenta y no se
 * guarda en la caché. Lo que devuelve `leer` es lo que devuelve `pedir`.
 * Lanza ErrorLurra("servicio", {servicio}) si el servicio no responde bien.
 */
export async function pedir(url, { como = "texto", servicio = "", metodo = "GET", cuerpo = null, cabeceras = null, espera = 30000, reintentos = 1, guardar = true, senal = null, leer = null } = {}) {
  const clave = guardar && metodo === "GET" ? `${como}|${url}` : null;
  if (clave && cache.has(clave)) return cache.get(clave);
  let ultimo = null;
  for (let intento = 0; intento <= reintentos; intento++) {
    if (senal && senal.aborted) throw new ErrorLurra("cancelado");
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), espera);
    const alCancelar = () => control.abort();
    if (senal) senal.addEventListener("abort", alCancelar, { once: true });
    try {
      const opciones = { method: metodo, signal: control.signal };
      if (cabeceras) opciones.headers = cabeceras;
      if (cuerpo != null) opciones.body = cuerpo;
      const r = await entorno.fetch(url, opciones);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let dato;
      if (como === "json") dato = await r.json();
      else if (como === "binario") dato = await r.arrayBuffer();
      else if (como === "respuesta") dato = r;
      else dato = await r.text();
      if (leer) dato = leer(dato);
      if (clave) {
        if (cache.size >= TOPE_CACHE) cache.delete(cache.keys().next().value);
        cache.set(clave, dato);
      }
      return dato;
    } catch (e) {
      ultimo = e;
      if (senal && senal.aborted) throw new ErrorLurra("cancelado");
      // Un error propio con su clave (parcela inexistente, etc.) no se arregla reintentando.
      if (e instanceof ErrorLurra && e.clave !== "servicio") throw e;
      if (intento < reintentos) await new Promise((ok) => setTimeout(ok, 600 * (intento + 1)));
    } finally {
      clearTimeout(reloj);
      if (senal) senal.removeEventListener("abort", alCancelar);
    }
  }
  throw new ErrorLurra("servicio", { servicio }, ultimo);
}

/** Ejecuta tareas asíncronas con un máximo de `n` a la vez. Devuelve los resultados en orden. */
export async function enParalelo(elementos, n, tarea) {
  const salida = new Array(elementos.length);
  let siguiente = 0;
  async function obrero() {
    while (siguiente < elementos.length) {
      const i = siguiente++;
      salida[i] = await tarea(elementos[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, elementos.length) }, obrero));
  return salida;
}
