export function formatBytes (n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Number(n)
  let i = 0
  while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export const formatRate = n => `${formatBytes(n || 0)}/s`

export function formatEta (seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '∞'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m ${s % 60}s`
}

export const formatDate = t => (t ? new Date(t).toLocaleString() : '–')
