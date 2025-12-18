# vite-postgres

Vite dev-only plugin that bootstraps and runs a local PostgreSQL server for your app.

- Runs on `vite dev` only (`apply: 'serve'`)
- Uses your system Postgres binaries (`initdb`, `postgres`, `createdb`, `pg_isready`)
- Picks a free port automatically and injects Postgres env vars for your app

## Install

```sh
pnpm add -D vite-postgres
```

## Usage

`vite.config.ts`

```ts
import { defineConfig } from 'vite'
import postgres from 'vite-postgres'

export default defineConfig({
  plugins: [
    postgres({
      // dbPath: '.postgres',      // persist in-repo (optional)
      // dbName: 'myapp',          // defaults to Vite root folder name
      // seedModule: 'src/seed.ts' // optional, runs after DB is ready
    }),
  ],
})
```

Then start Vite. Your app can connect using the injected env:

- `PGHOST=127.0.0.1`
- `PGPORT=<free port>`
- `PGDATABASE=<db name>`
- `PGDATA=<data directory>`

Example connection strings:

```sh
psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE"
# or (common default)
psql "postgresql://127.0.0.1:$PGPORT/$PGDATABASE"
```

## Options

```ts
export interface VitePostgresOptions {
  dbPath?: string
  dbName?: string
  seedModule?: string
}
```

- `dbPath`: Postgres data directory. Default: `${os.tmpdir()}/vite-postgres/<root>-<hash>`
- `dbName`: Database name. Default: Vite root folder name
- `seedModule`: Module path (relative to Vite root) to execute after the DB is ready

## Seeding

If `seedModule` is set, it’s loaded via `server.ssrLoadModule(...)` after:

1. `initdb` (only if `PG_VERSION` missing)
2. `postgres` started
3. `pg_isready` succeeds
4. `createdb` attempted (ignored if it already exists)

The module can be TS/ESM and can run whatever you want (migrations, seed data, etc).

## Notes / behavior

- Auth is initialized with `--auth=trust` (no password). This is for local dev.
- Logs go to `${PGDATA}/postgres.log` to keep Vite output clean.
- The Postgres process is terminated when Vite exits (SIGINT for fast shutdown).

## Requirements

- PostgreSQL installed and on your `PATH` (`initdb`, `postgres`, `createdb`, `pg_isready`)
- Node compatible with Vite 7+

## Troubleshooting

- `Failed to initialize DB. Ensure "initdb" is in your PATH.`: install Postgres (or add its `bin/` directory to `PATH`).
- Port conflicts: the plugin chooses a free port each run; read `process.env.PGPORT` from your app instead of hard-coding `5432`.
