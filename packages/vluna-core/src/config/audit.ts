export function isAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = String(env.VLUNA_AUDIT_ENABLED || '').trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}
