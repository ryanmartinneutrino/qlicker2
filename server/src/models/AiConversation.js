import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiMessageSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    contentWysiwyg: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AiConversationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    courseId: { type: String, required: true, index: true },
    ownerId: { type: String, required: true, index: true },
    title: { type: String, default: '' },
    backendId: { type: String, default: '' },
    modelId: { type: String, default: '' },
    messages: { type: [AiMessageSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'aiConversations', timestamps: false }
);

AiConversationSchema.index({ courseId: 1, ownerId: 1, updatedAt: -1 });

export default mongoose.model('AiConversation', AiConversationSchema);
