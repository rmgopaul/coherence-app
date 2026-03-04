# Enphase v2 Meter Reads Setup

This guide is for the new page at `/enphase-v2-meter-reads` in this app.

## What this page does

It lets you:

1. Save your Enphase v2 credentials (`api key` + `user id`).
2. Load your systems from Enphase.
3. Pull meter-related endpoints:
   - `summary`
   - `energy_lifetime`
   - `rgm_stats`
   - `production_meter_readings`

## 1) Get your Enphase user ID

1. Open [https://enlighten.enphaseenergy.com/support](https://enlighten.enphaseenergy.com/support).
2. Sign in with your Enphase/Enlighten account.
3. Look for your **User ID** on that page.

## 2) Get your Enphase v2 API key

Use the same key you already use for v2 requests.

Base URL for this page is set to:

`https://api.enphaseenergy.com/api/v2`

## 3) Run the app locally

From the `productivity-hub` folder:

```bash
# option A
pnpm install
pnpm dev

# option B (if pnpm is not installed)
npm install
npm run dev
```

Then open the app URL shown in your terminal (usually `http://localhost:3000`).

## 4) Use the Enphase page

1. Go to **Dashboard**.
2. Click **Enphase v2**.
3. Enter:
   - API Key
   - User ID
4. Click **Save Credentials**.
5. Select a system.
6. Set Start Date and End Date.
7. Click one of the fetch buttons to view JSON response data.

## Notes

- `energy_lifetime` uses `start_date` and `end_date`.
- `rgm_stats` and `production_meter_readings` are sent with epoch timestamps under the hood, based on your selected date range.
- If Enphase returns an API error, the page will show it as a toast message.
