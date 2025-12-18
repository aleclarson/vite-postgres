import exitHook from 'exit-hook'
import getPort from 'get-port'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { Plugin } from 'vite'
import { managePostgresProcess } from './postgres'

export interface VitePostgresOptions {
  /**
   * The path to the database.
   *
   * Defaults to a temporary directory in the system's temp directory.
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
  let dataDir: string
  let dbName: string
  let root: string

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
      // 1. Start the Postgres process
      const { stop } = await managePostgresProcess({
        dataDir,
        port,
        dbName,
        logger: server.config.logger,
      })

      // 2. Seed Module
      if (options.seedModule) {
        try {
          this.info(`[postgres] Seeding from ${options.seedModule}...`)
          await server.ssrLoadModule(path.resolve(root, options.seedModule))
          this.info('[postgres] Seeding complete.')
        } catch (e) {
          this.error(`[postgres] Seeding failed: ${e}`)
        }
      }

      // 3. Cleanup Logic
      // Ensure we kill the child process when Vite exits
      server.httpServer?.on('close', stop)
      exitHook(stop)
    },
  }
}
