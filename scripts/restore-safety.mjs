export function assertDistinctDatabaseIdentity(sourceIdentity, targetIdentity) {
  const sourceParts = sourceIdentity.split('\t')
  const targetParts = targetIdentity.split('\t')
  const samePostgresBackend =
    sourceParts.length === 3 &&
    targetParts.length === 3 &&
    sourceParts[1] === targetParts[1] &&
    sourceParts[2] === targetParts[2]

  if (sourceIdentity === targetIdentity || samePostgresBackend) {
    throw new Error(
      'Backup verification target must be isolated from the source database',
    )
  }
}

export function assertFreshRuntimeAuthority(
  sourceAuthority,
  restoredAuthority,
  requestedAuthority,
) {
  if (requestedAuthority === sourceAuthority) {
    throw new Error(
      'Restore verification requires a runtime authority different from the source',
    )
  }
  if (requestedAuthority === restoredAuthority) {
    throw new Error(
      'Restore verification requires a runtime authority different from the restored snapshot',
    )
  }
}
