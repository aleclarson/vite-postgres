import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Logger } from 'vite'

export async function managePostgresProcess({
  dataDir,
  port,
  dbName,
  logger,
  verbose,
  logFilePath,
}: {
  dataDir: string
  port: number
  dbName: string
  logger: Logger
  verbose?: boolean
  logFilePath?: string
}): Promise<{ stop(): void }> {
  let stopped = false

  const self = {
    stop: () => {},
  }

  // 1. Ensure Data Directory Exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  // 2. Initialize Database Cluster (if needed)
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    try {
      logger.info('[postgres] Initializing database cluster...')
      // --auth=trust allows passwordless local connections
      // --no-locale speeds up init and reduces issues
      execSync(`initdb -D "${dataDir}" --auth=trust --no-locale -E UTF8`, {
        stdio: 'ignore',
      })
    } catch {
      logger.error(
        '[postgres] Failed to initialize DB. Ensure "initdb" is in your PATH.'
      )
      return self
    }
  }

  // 3. Spawn PostgreSQL in Foreground
  // We use 'postgres' directly instead of 'pg_ctl' to keep it attached to
  // this process.
  logger.info(`[postgres] Starting server on port ${port}...`)

  let inheritLogs = !!verbose

  // Redirect stdout/err to log file to keep Vite console clean
  let logFd: number | null = null
  if (!inheritLogs && logFilePath) {
    try {
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
      // Truncate on each Vite start to avoid unbounded log growth.
      logFd = fs.openSync(logFilePath, 'w')
    } catch (e) {
      inheritLogs = true
      logger.warn(
        `[postgres] Failed to open log file at "${logFilePath}". Falling back to inherited logs.`
      )
    }
  }

  const closeLogFd = () => {
    if (logFd === null) return
    try {
      fs.closeSync(logFd)
    } finally {
      logFd = null
    }
  }

  const proc = spawn('postgres', ['-D', dataDir, '-p', port.toString()], {
    stdio:
      logFd !== null
        ? ['ignore', logFd, logFd]
        : inheritLogs
          ? ['ignore', 'inherit', 'inherit']
          : ['ignore', 'ignore', 'ignore'],
  })

  proc.once('exit', () => {
    closeLogFd()
  })

  proc.on('error', err => {
    logger.error(`[postgres] Failed to start postgres process: ${err.message}`)
  })

  proc.on('exit', code => {
    if (stopped) return
    if (code !== 0 && code !== null) {
      logger.error(`[postgres] Process exited unexpectedly with code ${code}`)
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

  self.stop = () => {
    if (stopped) return
    stopped = true
    proc.kill('SIGINT')
  }

  const ready = await waitForReady()
  if (!ready) {
    self.stop()
    logger.error('[postgres] Timed out waiting for database to be ready.')
    return self
  }

  // 5. Create Database (if needed)
  try {
    execSync(`createdb -h 127.0.0.1 -p ${port} "${dbName}"`, {
      stdio: 'ignore',
    })
    logger.info(`[postgres] Database "${dbName}" ready.`)
  } catch {
    // Ignored: Database likely already exists
  }

  return self
}
