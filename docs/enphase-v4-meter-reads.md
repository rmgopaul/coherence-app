# Enphase v4 Meter Reads Setup

This guide is for the page at `/enphase-v4-meter-reads` in this app.

## What this page does

It lets you:

1. Connect to Enphase v4 using OAuth (`api key`, `client id`, `client secret`, `authorization code`).
2. Load your systems from Enphase.
3. Pull meter-related endpoints:
   - `summary`
   - `energy_lifetime`
   - `rgm_stats`
   - `telemetry/production_meter`

## 1) Prepare your Enphase app credentials

From your Enphase developer app page, collect:

1. API Key
2. Client ID
3. Client Secret

Base URL for this page is set to:

`https://api.enphaseenergy.com/api/v4`

Default redirect URI is:

`https://api.enphaseenergy.com/oauth/redirect_uri`

## 2) Get an authorization code

1. In the Enphase page, enter `client id` and `redirect URI`.
2. Open the generated **Auth URL** link.
3. Sign in and authorize.
4. Copy the `code` query parameter from the redirected URL.
5. Paste that code into the app and click **Exchange Code + Connect**.

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
2. Click **Enphase v4**.
3. Enter:
   - API Key
   - Client ID
   - Client Secret
   - Authorization Code
4. Click **Exchange Code + Connect**.
5. Select a system.
6. Set Start Date and End Date.
7. Click one of the fetch buttons to view JSON response data.

## Notes

- `energy_lifetime` uses `start_date` and `end_date`.
- `rgm_stats` and `telemetry/production_meter` are sent with epoch timestamps based on your selected date range.
- If Enphase returns an API error, the page will show it as a toast message.
- If no systems appear, check the red error panel shown in the Enphase page for the exact API response.
