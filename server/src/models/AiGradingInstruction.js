import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiGradingInstructionSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateMeteorId() },
  courseId: { type: String, required: true },
  kind: { type: String, enum: ['grading', 'feedback'], required: true },
  name: { type: String, required: true },
  content: { type: String, required: true },
}, { collection: 'aiGradingInstructions', timestamps: true });

AiGradingInstructionSchema.index({ courseId: 1, kind: 1, name: 1 }, { unique: true });

export default mongoose.model('AiGradingInstruction', AiGradingInstructionSchema);
