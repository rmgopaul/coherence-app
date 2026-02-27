import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  createConversation,
  getConversations,
  getConversationMessages,
  deleteConversation,
} from "../db";

export const conversationsRouter = router({
  // List all conversations for the current user
  list: protectedProcedure.query(async ({ ctx }) => {
    return await getConversations(ctx.user.id);
  }),

  // Get messages for a specific conversation
  getMessages: protectedProcedure
    .input(z.object({ conversationId: z.string() }))
    .query(async ({ input }) => {
      return await getConversationMessages(input.conversationId);
    }),

  // Create a new conversation
  create: protectedProcedure
    .input(z.object({ title: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const conversationId = await createConversation(ctx.user.id, input.title);
      return { conversationId };
    }),

  // Delete a conversation
  delete: protectedProcedure
    .input(z.object({ conversationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await deleteConversation(input.conversationId, ctx.user.id);
      return { success: true };
    }),
});

