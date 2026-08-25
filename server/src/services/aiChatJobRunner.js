import AiConversation from '../models/AiConversation.js';
import { MAX_AI_CONVERSATION_MESSAGES, MAX_AI_MESSAGE_CHARS } from '../models/AiConversation.js';
import { runAiCourseChat } from './aiChatRunner.js';

const activeJobs = new Map();

export function isAiCourseChatActive(conversationId) {
  return activeJobs.has(String(conversationId));
}

function abortMessage(error) {
  return error?.name === 'AbortError' ? 'AI response stopped' : error?.message || 'AI backend request failed';
}

export function queueAiCourseChat({
  conversationId,
  pendingMessageId,
  backend,
  modelId,
  course,
  user,
  onCourseChatUpdated,
}) {
  const controller = new AbortController();
  activeJobs.set(String(conversationId), controller);

  setImmediate(async () => {
    const jobKey = String(conversationId);
    const filter = { _id: jobKey, pending: true, pendingMessageId: String(pendingMessageId) };
    try {
      const conversation = await AiConversation.findOne(filter).lean();
      if (!conversation) return;

      const content = await runAiCourseChat({
        backend,
        modelId,
        course,
        user,
        messages: conversation.messages,
        conversationId: jobKey,
        currentUserMessageId: String(pendingMessageId),
        onCourseChatUpdated,
        onProgress: () => AiConversation.updateOne(filter, { $set: { updatedAt: new Date() } }),
        signal: controller.signal,
      });
      await AiConversation.findOneAndUpdate(filter, {
        $push: { messages: { $each: [{ role: 'assistant', content: String(content).slice(0, MAX_AI_MESSAGE_CHARS) }], $slice: -MAX_AI_CONVERSATION_MESSAGES } },
        $set: { pending: false, pendingMessageId: '', pendingError: '', updatedAt: new Date() },
      });
    } catch (error) {
      const detail = abortMessage(error);
      await AiConversation.findOneAndUpdate(filter, {
        // Keep a visible assistant turn when a provider fails. Otherwise the
        // user only sees a banner and the conversation appears to have ignored
        // their message.
        $push: { messages: { $each: [{ role: 'assistant', content: `AI backend ran into an error: ${detail}`, isError: true }], $slice: -MAX_AI_CONVERSATION_MESSAGES } },
        $set: { pending: false, pendingMessageId: '', pendingError: detail, updatedAt: new Date() },
      });
    } finally {
      if (activeJobs.get(jobKey) === controller) activeJobs.delete(jobKey);
    }
  });
}

export function stopAiCourseChat(conversationId) {
  const controller = activeJobs.get(String(conversationId));
  if (controller) controller.abort();
}
