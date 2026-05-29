import fs from 'fs/promises'
import path from 'path'

export const CONFIG_DIR = path.join(process.cwd(), '.covoila')

export async function ensureDir(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
}

export async function readData<T>(name: string, fallback: T): Promise<T> {
  const file = path.join(CONFIG_DIR, `${name}.json`)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function writeData<T>(name: string, data: T): Promise<void> {
  const file = path.join(CONFIG_DIR, `${name}.json`)
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

export async function initData<T>(name: string, defaultData: T): Promise<void> {
  const file = path.join(CONFIG_DIR, `${name}.json`)
  try {
    await fs.access(file)
  } catch {
    await writeData(name, defaultData)
  }
}
