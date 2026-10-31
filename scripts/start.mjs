import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

let electronPath
try {
  const electron = await import('electron')
  electronPath = electron.default
} catch (error) {
  console.error('Electron 未安装或不完整。请先在项目目录运行 npm install。')
  console.error(error.message)
  process.exit(1)
}

if (typeof electronPath !== 'string' || !electronPath) {
  console.error('无法定位 Electron 可执行文件，请重新运行 npm install。')
  process.exit(1)
}

const env = { ...process.env }
// Some IDE/agent environments set this globally. With it set, electron.exe behaves like Node
// and exits instead of opening the launcher window.
delete env.ELECTRON_RUN_AS_NODE

const userArgs = process.argv.slice(2)
const appArgs = ['.', ...userArgs]
const fallbackUserData = path.join(projectRoot, '.launcher-user-data')
const compatibilityArgs = [
  '--no-sandbox',
  '--disable-gpu',
  `--user-data-dir=${fallbackUserData}`,
  ...appArgs
]

function run(args) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(electronPath, args, {
      cwd: projectRoot,
      env,
      stdio: 'inherit'
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      resolve({ code, signal, elapsed: Date.now() - startedAt })
    })

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        if (!child.killed) child.kill(signal)
      })
    }
  })
}

function finish(result) {
  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exit(result.code ?? 0)
}

console.log('Starting Voxel Launcher...')

try {
  const first = await run(appArgs)

  // Some Windows security software / restricted sessions make Chromium's sandbox hang or exit
  // immediately. Retry once in compatibility mode when Electron vanishes before it can show a
  // window. Normal launches are never started with --no-sandbox.
  if (
    !first.signal &&
    first.elapsed < 3000 &&
    !userArgs.some((arg) => arg === '--no-sandbox')
  ) {
    console.log('')
    console.log(
      `Electron 启动后立即退出（code ${first.code ?? 'unknown'}），正在尝试兼容模式（NoSandbox + 本地配置目录）...`
    )
    console.log('')
    const second = await run(compatibilityArgs)
    finish(second)
  } else {
    finish(first)
  }
} catch (error) {
  console.error('无法启动 Electron：', error.message)
  process.exit(1)
}
