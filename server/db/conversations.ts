import { nanoid } from "nanoid";
import {
  eq,
  and,
  desc,
  sql,
  getDb,
  withDbRetry,
  buildMessagePreview,
} from "./_core";
import { conversations, messages, InsertMessage } from "../../drizzle/schema";

export async function getConversations(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list conversations", async () =>
    db.select().from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
  );
}

export async function getConversationSummaries(userId: number, limit = 100) {
  const db = await getDb();
  if (!db) return [];

  const cappedLimit = Math.max(1, Math.min(limit, 300));
  const rows = await withDbRetry("list conversation summaries", async () =>
    db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
      .limit(cappedLimit)
  );

  const summaries = await Promise.all(
    rows.map(async (row) => {
      const latestMessage = await withDbRetry("load latest conversation message", async () =>
        db
          .select({
            content: messages.content,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.conversationId, row.id))
          .orderBy(desc(messages.createdAt))
          .limit(1)
      );

      const messageCountRows = await withDbRetry("count conversation messages", async () =>
        db
          .select({
            count: sql<number>`count(*)`,
          })
          .from(messages)
          .where(eq(messages.conversationId, row.id))
      );

      const latest = latestMessage[0];
      const messageCount = Number(messageCountRows[0]?.count ?? 0);

      return {
        ...row,
        lastMessagePreview: buildMessagePreview(latest?.content),
        lastMessageAt: latest?.createdAt ?? row.updatedAt ?? row.createdAt ?? null,
        messageCount,
      };
    })
  );

  return summaries.sort((a, b) => {
    const aMs = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bMs = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    if (aMs !== bMs) return bMs - aMs;
    return b.title.localeCompare(a.title);
  });
}

export async function createConversation(userId: number, title: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const id = nanoid();
  await withDbRetry("create conversation", async () => {
    await db.insert(conversations).values({
      id,
      userId,
      title,
    });
  });

  return id;
}

export async function getConversationMessages(conversationId: string) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list conversation messages", async () =>
    db.select().from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
  );
}

export async function addMessage(message: InsertMessage) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("insert message", async () => {
    await db.insert(messages).values(message);
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, message.conversationId));
  });
}

export async function deleteConversation(conversationId: string, userId: number) {
  const db = await getDb();
  if (!db) return;

  // Delete messages first
  await withDbRetry("delete conversation messages", async () => {
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
  });

  // Then delete conversation
  await withDbRetry("delete conversation", async () => {
    await db.delete(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  });
}
