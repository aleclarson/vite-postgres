import getPort from 'get-port'
import { ChildProcess, execSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net, { Server as NetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { BackendError } from 'pg-gateway'
import type { PostgresConnection, PostgresConnectionOptions } from 'pg-gateway'
import { fromNodeSocket } from 'pg-gateway/node'
import { Plugin } from 'vite'

type PGliteLike = {
  waitReady: Promise<void>
  execProtocol(data: Uint8Array): Promise<Array<[unknown, Uint8Array]>>
  close?: () => void | Promise<void>
}

type PGliteModule = {
  PGlite: new (dataDir?: string) => PGliteLike
}

export interface VitePostgresOptions {
  /**
   * The path to the database.
   *
   * - When using system Postgres, this is the data directory passed to `initdb`.
   * - When using PGlite, this is the db file path passed to `new PGlite(path)`.
   */
  dbPath?: string
  /**
   * The name of the database.
   *
   * Defaults to the root directory name.
   */
  dbName?: string
  /**
   * A module to seed the database with.
   */
  seedModule?: string
}

export default function vitePostgres(
  options: VitePostgresOptions = {}
): Plugin {
  let port: number
  let dbPath: string
  let dbName: string
  let root: string
  let pgProcess: ChildProcess | null = null
  let pgliteModule: PGliteModule | null = null
  let pgliteDb: PGliteLike | null = null
  let gatewayServer: NetServer | null = null
  let mode: 'postgres' | 'pglite' = 'postgres'

  const pgliteModuleId = '@electric-sql' + '/pglite'
  const loadPGlite = async () => {
    if (pgliteModule) return pgliteModule
    try {
      const mod = (await import(pgliteModuleId)) as unknown as PGliteModule
      if (!mod?.PGlite) return null
      pgliteModule = mod
      return pgliteModule
    } catch {
      return null
    }
  }

  return {
    name: 'vite-plugin-local-postgres',
    apply: 'serve',

    async config(config, { command }) {
      if (command !== 'serve') return

      root = config.root || process.cwd()
      const rootBasename = path.basename(root)
      const rootHash = crypto
        .createHash('sha256')
        .update(root)
        .digest('hex')
        .substring(0, 7)

      const detectedPGliteModule = await loadPGlite()
      mode = detectedPGliteModule ? 'pglite' : 'postgres'
      dbName = options.dbName || rootBasename

      if (mode === 'pglite') {
        const defaultDbFile = path.join(
          os.tmpdir(),
          'vite-postgres',
          `${rootBasename}-${rootHash}.db`
        )
        const configuredPath = options.dbPath || defaultDbFile
        const treatAsDirectory =
          configuredPath.endsWith('/') || configuredPath.endsWith(path.sep)
        dbPath = treatAsDirectory
          ? path.join(configuredPath, `${dbName}.db`)
          : configuredPath
      } else {
        dbPath =
          options.dbPath ||
          path.join(os.tmpdir(), 'vite-postgres', `${rootBasename}-${rootHash}`)
      }

      // Resolve port here so we can inject it
      port = await getPort()

      // Inject Environment Variables for the app to use
      process.env.PGPORT = port.toString()
      process.env.PGDATABASE = dbName
      process.env.PGHOST = '127.0.0.1'
      process.env.PGDATA = dbPath

      if (mode === 'pglite') {
        process.env.PGUSER ||= 'postgres'
        process.env.PGPASSWORD ||= 'postgres'
      }

      this.info(
        `[postgres] Configured env: PGPORT=${port}, PGDATABASE=${dbName} (${mode})`
      )
    },

    async configureServer(server) {
      if (mode === 'pglite') {
        const module = await loadPGlite()
        if (!module) {
          this.error(
            `[postgres] PGlite was detected earlier but failed to load at runtime.`
          )
        }

        if (fs.existsSync(dbPath) && fs.statSync(dbPath).isDirectory()) {
          dbPath = path.join(dbPath, `${dbName}.db`)
          process.env.PGDATA = dbPath
        }

        fs.mkdirSync(path.dirname(dbPath), { recursive: true })

        pgliteDb = new module.PGlite(dbPath)

        this.info(`[postgres] Starting pg-gateway (PGlite) on port ${port}...`)

        gatewayServer = net.createServer(socket => {
          void (async () => {
            let connection: PostgresConnection | undefined

            const connectionOptions: PostgresConnectionOptions = {
              serverVersion: '16.3 (PGlite)',
              auth: { method: 'trust' },

              async onStartup() {
                await pgliteDb?.waitReady
              },

              async onMessage(data, state) {
                if (!state.isAuthenticated) return
                try {
                  const responses = await pgliteDb!.execProtocol(data)
                  return responses.map(([, responseData]) => responseData)
                } catch (err) {
                  const message =
                    err instanceof Error ? err.message : String(err)
                  const errorResponse = BackendError.create({
                    severity: 'ERROR',
                    code: 'XX000',
                    message,
                  }).flush()
                  return connection
                    ? [errorResponse, connection.createReadyForQuery('error')]
                    : [errorResponse]
                }
              },
            }

            connection = await fromNodeSocket(socket, connectionOptions)
            await connection.processData(connection.duplex)
          })().catch(() => {
            socket.destroy()
          })
        })

        await new Promise<void>((resolve, reject) => {
          if (!gatewayServer) return reject(new Error('Missing gateway server'))
          const onError = (err: Error) => {
            gatewayServer?.off('listening', onListening)
            reject(err)
          }
          const onListening = () => {
            gatewayServer?.off('error', onError)
            resolve()
          }

          gatewayServer.once('error', onError)
          gatewayServer.once('listening', onListening)
          gatewayServer.listen(port, '127.0.0.1')
        })

        await pgliteDb.waitReady
        this.info(`[postgres] Database "${dbName}" ready (PGlite).`)
      } else {
        // 1. Ensure Data Directory Exists
        if (!fs.existsSync(dbPath)) {
          fs.mkdirSync(dbPath, { recursive: true })
        }

        // 2. Initialize Database Cluster (if needed)
        if (!fs.existsSync(path.join(dbPath, 'PG_VERSION'))) {
          try {
            this.info('[postgres] Initializing database cluster...')
            // --auth=trust allows passwordless local connections
            // --no-locale speeds up init and reduces issues
            execSync(`initdb -D "${dbPath}" --auth=trust --no-locale -E UTF8`, {
              stdio: 'ignore',
            })
          } catch (e) {
            this.error(
              '[postgres] Failed to initialize DB. Ensure "initdb" is in your PATH.'
            )
          }
        }

        // 3. Spawn PostgreSQL in Foreground
        // We use 'postgres' directly instead of 'pg_ctl' to keep it attached to
        // this process
        this.info(`[postgres] Starting server on port ${port}...`)

        const logStream = fs.openSync(path.join(dbPath, 'postgres.log'), 'a')

        pgProcess = spawn('postgres', ['-D', dbPath, '-p', port.toString()], {
          // Redirect stdout/err to log file to keep Vite console clean
          stdio: ['ignore', logStream, logStream],
        })

        pgProcess.on('error', err => {
          this.error(
            `[postgres] Failed to start postgres process: ${err.message}`
          )
        })

        pgProcess.on('exit', code => {
          if (code !== 0 && code !== null) {
            this.error(
              `[postgres] Process exited unexpectedly with code ${code}`
            )
          }
        })

        // 4. Wait for Readiness
        // Even though spawned, it takes a moment to bind the port
        const waitForReady = async () => {
          const retries = 30
          for (let i = 0; i < retries; i++) {
            try {
              execSync(`pg_isready -h 127.0.0.1 -p ${port}`, {
                stdio: 'ignore',
              })
              return true
            } catch {
              await new Promise(r => setTimeout(r, 100))
            }
          }
          return false
        }

        if (!(await waitForReady())) {
          pgProcess.kill()
          this.error('[postgres] Timed out waiting for database to be ready.')
        }

        // 5. Create Database (if needed)
        try {
          execSync(`createdb -h 127.0.0.1 -p ${port} "${dbName}"`, {
            stdio: 'ignore',
          })
          this.info(`[postgres] Database "${dbName}" ready.`)
        } catch (e) {
          // Ignored: Database likely already exists
        }
      }

      // 6. Seed Module
      if (options.seedModule) {
        try {
          this.info(`[postgres] Seeding from ${options.seedModule}...`)
          await server.ssrLoadModule(path.resolve(root, options.seedModule))
          this.info('[postgres] Seeding complete.')
        } catch (e) {
          this.error(`[postgres] Seeding failed: ${e}`)
        }
      }

      // 7. Cleanup Logic
      // Ensure we kill the child process when Vite exits
      const cleanExit = () => {
        if (gatewayServer) {
          gatewayServer.close()
          gatewayServer = null
        }
        if (pgliteDb) {
          void pgliteDb.close?.()
          pgliteDb = null
        }
        if (pgProcess) {
          // SIGTERM is the "Smart Shutdown" signal for Postgres (finishes
          // active transactions then closes)
          // SIGINT is "Fast Shutdown" (rollback active transactions and close)
          // - often better for dev
          pgProcess.kill('SIGINT')
          pgProcess = null
        }
      }

      server.httpServer?.on('close', cleanExit)
      process.once('exit', cleanExit)
      process.once('SIGINT', () => {
        cleanExit()
        process.exit()
      })
      process.once('SIGTERM', () => {
        cleanExit()
        process.exit()
      })
    },
  }
}
