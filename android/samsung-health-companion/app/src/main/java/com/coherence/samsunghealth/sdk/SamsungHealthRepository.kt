package com.coherence.samsunghealth.sdk

import com.coherence.samsunghealth.model.SamsungHealthPayload

interface SamsungHealthRepository {
  suspend fun collectDailyPayload(): SamsungHealthPayload
}
