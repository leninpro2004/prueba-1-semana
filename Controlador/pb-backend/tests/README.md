# Tests

Corren contra una base **separada** (`puertas_blindadas_test`), nunca contra la real.
Los helpers abortan si el nombre de la base no termina en `_test`.

## Preparar la base (una sola vez)

```bash
npm run test:preparar
```

Crea `puertas_blindadas_test` y le carga los 3 esquemas desde `ddl/`.
Hay que repetirlo solo si cambia el DDL.

## Correr

```bash
npm test               # todos
npm test -- tests/movimientos.test.js   # uno
TEST_VERBOSE=1 npm test                 # sin silenciar los console.error
```

## Cómo están armados

- `helpers/semilla.sql` — datos mínimos y explícitos. Cada test sabe qué existe.
- `helpers/db.js` — `resetear()` hace TRUNCATE + semilla antes de **cada** test,
  así que ningún test depende del anterior.
- `helpers/api.js` — levanta la app en un puerto libre y firma tokens reales,
  de modo que las peticiones pasan por el middleware de auth igual que en producción.

Se usa el runner de Node (`node:test`), sin dependencias nuevas.
