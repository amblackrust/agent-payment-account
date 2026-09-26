import { describe, expect, it } from 'vitest'

import {
  assertDistinctDatabaseIdentity,
  assertFreshRuntimeAuthority,
} from '../scripts/restore-safety.mjs'

describe('backup restore safety fences', () => {
  it('rejects source and target connections to the same backend', () => {
    expect(() =>
      assertDistinctDatabaseIdentity('db\t127.0.0.1\t5432', 'db\t127.0.0.1\t5432'),
    ).toThrow('isolated from the source database')

    expect(() =>
      assertDistinctDatabaseIdentity('db\t127.0.0.1\t5432', 'restore\t127.0.0.1\t5432'),
    ).toThrow('isolated from the source database')

    expect(() =>
      assertDistinctDatabaseIdentity('db\t127.0.0.1\t5432', 'restore\t127.0.0.2\t5432'),
    ).not.toThrow()
  })

  it('requires a new authority for the restored runtime', () => {
    expect(() =>
      assertFreshRuntimeAuthority('runtime-source', 'runtime-source', 'runtime-source'),
    ).toThrow('different from the source')
    expect(() =>
      assertFreshRuntimeAuthority(
        'runtime-source',
        'runtime-source',
        'runtime-restore',
      ),
    ).not.toThrow()
    expect(() =>
      assertFreshRuntimeAuthority('runtime-source', 'runtime-target', 'runtime-target'),
    ).toThrow('different from the restored snapshot')
  })
})
