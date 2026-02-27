# Samsung Health Data SDK - Step 1 Deliverable

This project now contains a companion Android scaffold at:

`/Users/rhettgopaul/Documents/New project/productivity-hub/android/samsung-health-companion`

## Maximum datapoint scope currently modeled

### Activity and energy

- Steps
- Distance (m)
- Floors climbed
- Active, sedentary, and exercise minutes
- Active calories, basal calories, total calories
- Walking/running/cycling/swimming duration
- Exercise session count

### Sleep

- Total sleep, in-bed, awake, light, deep, REM minutes
- Sleep latency
- Wake after sleep onset
- Sleep efficiency, consistency, score
- Bedtime and wake time
- Sleep sessions and sleep stage timeline samples

### Cardio and recovery

- Resting, average, min, max heart rate
- HRV (RMSSD, SDNN)
- Respiratory rate
- VO2 max
- Stress score and stress minutes
- Heart-rate sample timeline

### Oxygen and temperature

- SpO2 average and min
- Skin temperature
- Body temperature
- SpO2 sample timeline

### Blood pressure

- Systolic
- Diastolic
- Pulse
- Blood-pressure sample timeline

### Body composition

- Weight
- BMI
- Body fat %
- Skeletal muscle mass
- Body water %
- Basal metabolic rate

### Nutrition and hydration

- Calories intake
- Protein, carbs, fat, saturated fat
- Sugar, fiber
- Sodium, cholesterol
- Caffeine
- Water intake

### Glucose

- Fasting glucose
- Average glucose
- Max glucose
- Glucose sample timeline

### Mindfulness and reproductive health

- Mindful minutes
- Meditation minutes
- Menstruation start/end
- Ovulation timestamp

## What is implemented in Step 1

- Android project skeleton and sync worker
- Canonical payload model with all fields above
- Webhook uploader (`POST`, `application/json`, `x-sync-key`)
- Placeholder repository returning schema-stable payloads

## What still needs implementation (Step 2)

- Add Samsung Health Data SDK dependency once access is available
- Request runtime permissions for each record type
- Query real records and map them into the payload
- Handle partial permission grants and per-record fallback
- Add local caching/retry policy for offline sync
