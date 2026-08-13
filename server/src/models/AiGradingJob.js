import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiGradingJobSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateMeteorId() },
  courseId: { type: String, required: true },
  sessionId: { type: String, required: true },
  ownerId: { type: String, required: true },
  questionIds: { type: [String], default: [] },
  regrade: { type: Boolean, default: false },
  instructions: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued' },
  completed: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  report: { type: mongoose.Schema.Types.Mixed, default: {} },
  log: { type: [mongoose.Schema.Types.Mixed], default: [] },
  error: { type: String, default: '' },
}, { collection: 'aiGradingJobs', timestamps: true });

AiGradingJobSchema.index({ courseId: 1, sessionId: 1, createdAt: -1 });
export default mongoose.model('AiGradingJob', AiGradingJobSchema);
