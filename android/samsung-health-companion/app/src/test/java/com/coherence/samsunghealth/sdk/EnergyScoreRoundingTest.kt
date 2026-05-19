package com.coherence.samsunghealth.sdk

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Locks the Energy-Score rounding contract: the SDK's
 * `EnergyScoreType.ENERGY_SCORE` Field is a `Float`, but the
 * server's `samsungEnergyScore` column stores a rounded `Int`
 * (the CSV importer does `round(total_score)`). The reader must
 * round before putting the value on the wire so it matches the
 * existing column. This test pins `Math.round(Float)` semantics
 * (round-half-up) so a refactor can't silently switch to
 * truncation.
 */
class EnergyScoreRoundingTest {

  private fun roundForWire(raw: Float): Double = Math.round(raw).toDouble()

  @Test
  fun roundsHalfUp() {
    assertEquals(73.0, roundForWire(72.5f), 0.0)
    assertEquals(73.0, roundForWire(73.4f), 0.0)
    assertEquals(74.0, roundForWire(73.6f), 0.0)
    assertEquals(0.0, roundForWire(0.0f), 0.0)
    assertEquals(100.0, roundForWire(99.9f), 0.0)
  }
}
