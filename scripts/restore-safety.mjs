export function assertDistinctDatabaseIdentity(sourceIdentity, targetIdentity) {
  if (sourceIdentity === targetIdentity) {
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
