# Productivity Hub - Complete Project Export

## Project Overview
A full-stack productivity dashboard integrating Google Calendar, Gmail, Google Drive, Google Sheets, Todoist, and ChatGPT APIs. Built with React 19, TypeScript, tRPC, Express, and MySQL/TiDB.

## Tech Stack
- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Wouter (routing), shadcn/ui components
- **Backend**: Express 4, tRPC 11, Node.js 22
- **Database**: MySQL/TiDB with Drizzle ORM
- **Authentication**: Manus OAuth + custom OAuth for Google/Microsoft/Todoist
- **Storage**: S3-compatible storage

## Features Implemented

### 1. Dashboard
- Four-column layout showing Today's Events, Today's Tasks, Recent Emails, Drive Files
- Real-time data fetching from all integrated services
- Refresh buttons for each widget
- Responsive design

### 2. Universal Drop Dock
- Drag & drop or paste links from Calendar, Gmail, Sheets, Todoist
- 250px canvas with free positioning
- Fetches real titles from APIs (email subjects, task names, event titles, sheet names)
- App-specific color schemes and icons
- Persists to localStorage
- Prevents auto-launch when repositioning items

### 3. Todoist Integration
- Project/filter selector dropdown (Today, Inbox, Upcoming, My Projects)
- Dynamic card title based on selected filter
- Task completion toggle
- Email-to-Todoist: hover button on emails to create tasks in Inbox project

### 4. Google Calendar Integration
- Displays upcoming events grouped by date
- Color-coded event cards
- Clickable links to calendar events

### 5. Gmail Integration
- Filters for "Important and Unread" emails only
- Email preview with sender, subject, snippet
- Hover button to add email to Todoist

### 6. Google Drive Integration
- Lists recent files with icons
- Search functionality
- Create new spreadsheets directly from dashboard

### 7. ChatGPT Integration
- Conversation management
- Context-aware responses with access to productivity data
- Message history

### 8. Settings Page
- OAuth credential management (Google, Microsoft, Todoist, OpenAI)
- Credentials persist in database
- Auto-loads saved credentials

## Environment Variables Required

### System-provided (auto-injected):
- DATABASE_URL
- JWT_SECRET
- VITE_APP_ID
- OAUTH_SERVER_URL
- VITE_OAUTH_PORTAL_URL
- OWNER_OPEN_ID
- OWNER_NAME
- VITE_APP_TITLE
- VITE_APP_LOGO
- BUILT_IN_FORGE_API_URL
- BUILT_IN_FORGE_API_KEY
- VITE_ANALYTICS_ENDPOINT
- VITE_ANALYTICS_WEBSITE_ID

### User-provided (via Settings UI):
- Google OAuth Client ID & Secret
- Microsoft OAuth Client ID & Secret
- Todoist API Token
- OpenAI API Key

## Database Schema

### users
- id (int, primary key)
- openId (varchar, unique)
- name, email, loginMethod
- role (enum: 'user', 'admin')
- createdAt, updatedAt, lastSignedIn

### integrations
- id (int, primary key)
- userId (int, foreign key)
- provider (enum: 'google', 'whoop', 'todoist', 'samsung-health', 'openai')
- accessToken, refreshToken, expiresAt
- metadata (json)
- createdAt, updatedAt

### oauthCredentials
- id (int, primary key)
- userId (int)
- provider (varchar)
- clientId, clientSecret
- createdAt, updatedAt
- Unique index on (userId, provider)

### conversations
- id (int, primary key)
- userId (int, foreign key)
- title (text)
- createdAt, updatedAt

### messages
- id (int, primary key)
- conversationId (int, foreign key)
- role (enum: 'user', 'assistant', 'system')
- content (text)
- createdAt

## API Routes

### tRPC Routers

#### auth
- `me`: Get current user
- `logout`: Clear session

#### integrations
- `list`: Get all user integrations
- `connect`: Connect new integration
- `disconnect`: Remove integration

#### google
- `getCalendarEvents`: Fetch calendar events
- `getGmailMessages`: Fetch important unread emails
- `getDriveFiles`: List recent Drive files
- `searchDrive`: Search Drive by query
- `createSpreadsheet`: Create new Google Sheet

#### todoist
- `getTasks`: Get tasks by filter (today, inbox, project, etc.)
- `getProjects`: List all projects
- `createTask`: Create new task
- `updateTask`: Update task (complete/uncomplete)
- `createTaskFromEmail`: Create task from email with link

#### chatgpt
- `getConversations`: List conversations
- `createConversation`: Start new conversation
- `getMessages`: Get conversation messages
- `sendMessage`: Send message and get AI response
- `deleteConversation`: Delete conversation

#### dock
- `getItemDetails`: Fetch real title for dropped URL (email subject, task name, etc.)

#### oauthCredentials
- `save`: Save OAuth credentials
- `get`: Get saved credentials by provider

### Express Routes

#### OAuth Callbacks
- `/api/oauth/callback`: Manus OAuth callback
- `/api/oauth/google`: Google OAuth initiation
- `/api/oauth/google/callback`: Google OAuth callback
- `/api/oauth/todoist`: Todoist OAuth initiation
- `/api/oauth/todoist/callback`: Todoist OAuth callback

## Key Files Structure

```
productivity-hub/
├── client/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx          # Main dashboard
│   │   │   ├── Settings.tsx           # OAuth settings
│   │   │   ├── Home.tsx               # Landing page
│   │   │   ├── TodoistWidget.tsx      # Todoist detail view
│   │   │   ├── GoogleCalendarWidget.tsx
│   │   │   ├── GmailWidget.tsx
│   │   │   └── ChatGPTWidget.tsx
│   │   ├── components/
│   │   │   ├── UniversalDropDock.tsx  # Drop dock component
│   │   │   └── ui/                    # shadcn components
│   │   ├── lib/
│   │   │   └── trpc.ts                # tRPC client
│   │   ├── App.tsx                    # Routes
│   │   └── main.tsx                   # Entry point
│   └── index.html
├── server/
│   ├── _core/                         # Framework code (don't modify)
│   │   ├── index.ts                   # Express server
│   │   ├── trpc.ts                    # tRPC setup
│   │   ├── context.ts                 # Request context
│   │   ├── oauth.ts                   # Manus OAuth
│   │   └── env.ts                     # Environment config
│   ├── routers.ts                     # tRPC procedures
│   ├── db.ts                          # Database helpers
│   ├── oauth-routes.ts                # Custom OAuth routes
│   ├── services/
│   │   ├── google.ts                  # Google API calls
│   │   └── todoist.ts                 # Todoist API calls
│   └── helpers/
│       └── tokenRefresh.ts            # Token refresh logic
├── drizzle/
│   └── schema.ts                      # Database schema
└── package.json

```

## Setup Instructions for New Environment

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Set up database:**
   - Create MySQL/TiDB database
   - Set DATABASE_URL environment variable
   - Run: `pnpm db:push`

3. **Configure OAuth apps:**
   - Google Cloud Console: Create OAuth 2.0 credentials
   - Todoist: Get API token from Settings > Integrations
   - OpenAI: Get API key from platform.openai.com

4. **Set environment variables:**
   - Copy all system variables from Manus environment
   - Or set up your own JWT_SECRET, OAuth configs, etc.

5. **Run development server:**
   ```bash
   pnpm dev
   ```

6. **Build for production:**
   ```bash
   pnpm build
   pnpm start
   ```

## Known Issues & Fixes

### Issue 1: OAuth Redirect URI Mismatch
**Problem:** Google OAuth fails with "invalid redirect_uri"
**Fix:** Add your domain to Google Cloud Console:
- Authorized JavaScript origins: `http://your-domain.com`
- Authorized redirect URIs: `http://your-domain.com/api/oauth/google/callback`

### Issue 2: Todoist Project Filter Not Working
**Problem:** Project filter shows wrong tasks
**Fix:** Ensure `getTodoistFilterString()` properly formats project IDs as `#projectId`

### Issue 3: Drop Dock Auto-launches on Drag
**Problem:** Links open when repositioning bookmarks
**Fix:** Track `isDragging` state and prevent click event when dragging

### Issue 4: OAuth Credentials Not Persisting
**Problem:** Credentials reset on page refresh
**Fix:** Add unique index on `(userId, provider)` in oauthCredentials table

## API Integration Details

### Google APIs
- **Scopes needed:**
  - `https://www.googleapis.com/auth/calendar.readonly`
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/drive.readonly`
  - `https://www.googleapis.com/auth/spreadsheets`

### Todoist API
- **Base URL:** `https://api.todoist.com/rest/v2`
- **Authentication:** Bearer token
- **Key endpoints:**
  - GET `/tasks?filter={filter}` - Get tasks by filter
  - GET `/projects` - List projects
  - POST `/tasks` - Create task
  - POST `/tasks/{id}/close` - Complete task

### OpenAI API
- **Model:** Uses default from built-in LLM helper
- **Context:** Can access user's productivity data via function calling

## Deployment Notes

- Use Node.js 22+
- Ensure DATABASE_URL points to production database
- Set all environment variables
- Configure OAuth redirect URIs for production domain
- Use HTTPS in production
- Set secure cookie options for production

## Future Enhancements

1. Add Microsoft OneNote integration
2. Implement task scheduling/reminders
3. Add data visualization/analytics
4. Export data to CSV/PDF
5. Mobile app version
6. Offline support with service workers
7. Real-time sync with WebSockets
8. Advanced search across all services
9. Custom dashboard layouts
10. Team collaboration features
