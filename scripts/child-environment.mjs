const inheritedEnvironmentNames = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'CI',
  'COREPACK_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'npm_config_user_agent',
  'npm_config_registry',
  'npm_config_cache',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'COMPOSE_FILE',
  'COMPOSE_PROFILES',
  'COMPOSE_PROJECT_NAME',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSYSCONFDIR',
  'PGPASSFILE',
  'PGSSLROOTCERT',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGSSLMODE',
  'PGAPPNAME',
]

export function buildChildProcessEnvironment(overrides = {}, source = process.env) {
  const environment = {}
  for (const name of inheritedEnvironmentNames) {
    if (source[name] !== undefined) environment[name] = source[name]
  }
  return { ...environment, ...overrides }
}
