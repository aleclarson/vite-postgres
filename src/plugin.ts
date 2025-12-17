import getPort from 'get-port'
import { ChildProcess, execSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Plugin } from 'vite'

interface PostgresPluginOptions {
  dbPath?: string
  dbName?: string
  seedModule?: string
}

export default function vitePostgres(
  options: PostgresPluginOptions = {}
): Plugin {
  let port: number
  let dataDir: string
  let dbName: string
  let root: string
  let pgProcess: ChildProcess | null = null

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

      dataDir =
        options.dbPath ||
        path.join(os.tmpdir(), 'vite-postgres', `${rootBasename}-${rootHash}`)
      dbName = options.dbName || rootBasename

      // Resolve port here so we can inject it
      port = await getPort()

      // Inject Environment Variables for the app to use
      process.env.PGPORT = port.toString()
      process.env.PGDATABASE = dbName
      process.env.PGHOST = '127.0.0.1'
      process.env.PGDATA = dataDir

      this.info(
        `[postgres] Configured env: PGPORT=${port}, PGDATABASE=${dbName}`
      )
    },

    async configureServer(server) {
      // 1. Ensure Data Directory Exists
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
      }

      // 2. Initialize Database Cluster (if needed)
      if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
        try {
          this.info('[postgres] Initializing database cluster...')
          // --auth=trust allows passwordless local connections
          // --no-locale speeds up init and reduces issues
          execSync(`initdb -D "${dataDir}" --auth=trust --no-locale -E UTF8`, {
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

      const logStream = fs.openSync(path.join(dataDir, 'postgres.log'), 'a')

      pgProcess = spawn('postgres', ['-D', dataDir, '-p', port.toString()], {
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
          this.error(`[postgres] Process exited unexpectedly with code ${code}`)
        }
      })

      // 4. Wait for Readiness
      // Even though spawned, it takes a moment to bind the port
      const waitForReady = async () => {
        const retries = 30
        for (let i = 0; i < retries; i++) {
          try {
            execSync(`pg_isready -h 127.0.0.1 -p ${port}`, { stdio: 'ignore' })
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
