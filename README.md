# Xbox Deals

Comparador de precios de juegos Xbox por region. Un robot recorre **todo** el
catalogo de Xbox una vez al dia, saca precios y descuentos de cada region, les
pega la nota (IGDB) y guarda los datos como JSON. La pagina solo lee esos JSON:
rapida, sin servidor, sin limites.

## Estructura del repo

```
robot.mjs                          # el robot (genera los datos)
.github/workflows/update-data.yml  # lo corre solo, cada dia
public/index.html                  # la pagina
public/data/                       # datos generados por el robot (games.json, meta.json)
```

## Puesta en marcha (una sola vez)

1. **Sube estos archivos** al repo respetando las carpetas de arriba.

2. **Secretos de GitHub** (para las notas de IGDB). En el repo:
   Settings -> Secrets and variables -> Actions -> New repository secret.
   Crea dos:
   - `TWITCH_CLIENT_ID`  = el Client ID de tu app de Twitch
   - `TWITCH_CLIENT_SECRET` = el Client Secret (en dev.twitch.tv, en tu app,
     boton "Nuevo secreto" para generarlo)
   (Sin estos, el sitio igual funciona; solo quedan sin nota.)

3. **Primera corrida a mano**: pestana Actions -> "Actualizar precios Xbox"
   -> Run workflow. Tarda un rato (recorre ~17.500 juegos x 12 regiones).
   Al terminar, aparecen `public/data/games.json` y `meta.json` commiteados.

4. **Sitio**: se publica solo en GitHub Pages (repo publico `pepsend/xbox-deals-web`).
   URL: https://pepsend.github.io/xbox-deals-web/
   Cada corrida del robot hace un commit y Pages redespliega solo.

## Ajustes rapidos

- Regiones: edita el arreglo `REGIONS` arriba de `robot.mjs`.
- Hora de actualizacion: el `cron` en el workflow (esta en UTC).
- Prueba rapida sin recorrer todo: corre con `MAX_PAGES=2` en las env del step.

## Notas

- Los precios de Argentina/Turquia/etc. salen baratos, pero comprar ahi suele
  pedir gift card de ese pais o cambiar la region de la cuenta Xbox. La pagina
  lo avisa y tiene un filtro para dejar solo las regiones con gift card facil.
- Las notas vienen de IGDB (via tu app de Twitch). Cobertura parcial: los
  juegos conocidos traen nota, los muy oscuros pueden quedar en N/A.
