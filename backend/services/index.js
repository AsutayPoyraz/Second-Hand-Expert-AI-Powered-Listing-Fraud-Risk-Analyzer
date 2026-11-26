'use strict';

/**
 * Servis katmanı için tek giriş noktası (test ve dış kullanım kolaylığı).
 */

const {
  GEMINI_RESPONSE_SCHEMA,
  FOLLOWUP_RESPONSE_SCHEMA,
  validateReport,
  DECISION_OPTIONS
} = require('../utils/reportSchema');
const { buildSystemInstruction, buildFollowupInstruction, buildFollowupQuestion, buildUserParts } = require('./promptBuilder');
const {
  runAnalysis,
  runFollowup,
  listAvailableModels,
  GeminiApiError,
  isUserAbort,
  sanitizeUpstreamMessage
} = require('./geminiService');

module.exports = {
  GEMINI_RESPONSE_SCHEMA,
  FOLLOWUP_RESPONSE_SCHEMA,
  validateReport,
  DECISION_OPTIONS,
  buildSystemInstruction,
  buildFollowupInstruction,
  buildFollowupQuestion,
  buildUserParts,
  runAnalysis,
  runFollowup,
  listAvailableModels,
  GeminiApiError,
  isUserAbort,
  sanitizeUpstreamMessage
};
