Text file: schema.ts
Latest content with line numbers:
1	import { mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
2	
3	/**
4	 * Core user table backing auth flow.
5	 * Extend this file with additional tables as your product grows.
6	 * Columns use camelCase to match both database fields and generated types.
7	 */
8	export const users = mysqlTable("users", {
9	  id: varchar("id", { length: 64 }).primaryKey(),
10	  name: text("name"),
11	  email: varchar("email", { length: 320 }),
12	  loginMethod: varchar("loginMethod", { length: 64 }),
13	  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
14	  createdAt: timestamp("createdAt").defaultNow(),
15	  lastSignedIn: timestamp("lastSignedIn").defaultNow(),
16	});
17	
18	export type User = typeof users.$inferSelect;
19	export type InsertUser = typeof users.$inferInsert;
20	
21	// Integration connections table to store OAuth tokens
22	export const integrations = mysqlTable("integrations", {
23	  id: varchar("id", { length: 64 }).primaryKey(),
24	  userId: varchar("userId", { length: 64 }).notNull(),
25	  provider: varchar("provider", { length: 64 }).notNull(), // todoist, google, whoop, samsung-health, openai
26	  accessToken: text("accessToken"),
27	  refreshToken: text("refreshToken"),
28	  expiresAt: timestamp("expiresAt"),
29	  scope: text("scope"),
30	  metadata: text("metadata"), // JSON string for provider-specific data
31	  createdAt: timestamp("createdAt").defaultNow(),
32	  updatedAt: timestamp("updatedAt").defaultNow(),
33	});
34	
35	export type Integration = typeof integrations.$inferSelect;
36	export type InsertIntegration = typeof integrations.$inferInsert;
37	
38	// User preferences for dashboard layout
39	export const userPreferences = mysqlTable("userPreferences", {
40	  id: varchar("id", { length: 64 }).primaryKey(),
41	  userId: varchar("userId", { length: 64 }).notNull().unique(),
42	  enabledWidgets: text("enabledWidgets"), // JSON array of enabled widget IDs
43	  widgetLayout: text("widgetLayout"), // JSON object for widget positions
44	  theme: varchar("theme", { length: 32 }).default("light"),
45	  createdAt: timestamp("createdAt").defaultNow(),
46	  updatedAt: timestamp("updatedAt").defaultNow(),
47	});
48	
49	export type UserPreference = typeof userPreferences.$inferSelect;
50	export type InsertUserPreference = typeof userPreferences.$inferInsert;
51	
52	// OAuth credentials table for storing client IDs and secrets
53	export const oauthCredentials = mysqlTable("oauthCredentials", {
54	  id: varchar("id", { length: 64 }).primaryKey(),
55	  userId: varchar("userId", { length: 64 }).notNull(),
56	  provider: varchar("provider", { length: 64 }).notNull(), // google, whoop
57	  clientId: text("clientId"),
58	  clientSecret: text("clientSecret"),
59	  createdAt: timestamp("createdAt").defaultNow(),
60	  updatedAt: timestamp("updatedAt").defaultNow(),
61	});
62	
63	export type OAuthCredential = typeof oauthCredentials.$inferSelect;
64	export type InsertOAuthCredential = typeof oauthCredentials.$inferInsert;
65	
66	// Conversations table for ChatGPT chat history
67	export const conversations = mysqlTable("conversations", {
68	  id: varchar("id", { length: 64 }).primaryKey(),
69	  userId: varchar("userId", { length: 64 }).notNull(),
70	  title: text("title").notNull(),
71	  createdAt: timestamp("createdAt").defaultNow(),
72	  updatedAt: timestamp("updatedAt").defaultNow(),
73	});
74	
75	export type Conversation = typeof conversations.$inferSelect;
76	export type InsertConversation = typeof conversations.$inferInsert;
77	
78	// Messages table for individual chat messages
79	export const messages = mysqlTable("messages", {
80	  id: varchar("id", { length: 64 }).primaryKey(),
81	  conversationId: varchar("conversationId", { length: 64 }).notNull(),
82	  role: mysqlEnum("role", ["user", "assistant"]).notNull(),
83	  content: text("content").notNull(),
84	  createdAt: timestamp("createdAt").defaultNow(),
85	});
86	
87	export type Message = typeof messages.$inferSelect;
88	export type InsertMessage = typeof messages.$inferInsert;
89	