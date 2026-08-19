import AiConversation from '../models/AiConversation.js';
import { runAiCourseChat } from './aiChatRunner.js';

const activeJobs = new Map();

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
        signal: controller.signal,
      });
      await AiConversation.findOneAndUpdate(filter, {
        $push: { messages: { role: 'assistant', content } },
        $set: { pending: false, pendingMessageId: '', pendingError: '', updatedAt: new Date() },
      });
    } catch (error) {
      await AiConversation.findOneAndUpdate(filter, {
        $set: { pending: false, pendingMessageId: '', pendingError: abortMessage(error), updatedAt: new Date() },
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
