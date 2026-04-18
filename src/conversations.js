'use strict';

/**
 * Simple in-memory conversation history per WhatsApp number.
 *
 * LIMITATION: History is lost on server restart. For production with multiple
 * Node processes or persistent memory across restarts, replace with Redis
 * or a Supabase table.
 */

const conversations = new Map();
const MAX_MESSAGES = 20; // Keep last 20 messages to limit token cost
const TTL_MS = 60 * 60 * 1000; // 1 hour — conversations expire if idle

function _cleanup() {
  const now = Date.now();
  for (const [key, value] of conversations.entries()) {
    if (now - value.updatedAt > TTL_MS) conversations.delete(key);
  }
}

function getHistory(whatsappNumber) {
  _cleanup();
  const entry = conversations.get(whatsappNumber);
  return entry ? entry.messages : [];
}

function addMessage(whatsappNumber, message) {
  const entry = conversations.get(whatsappNumber) || {
    messages: [],
    updatedAt: Date.now(),
  };
  entry.messages.push(message);
  if (entry.messages.length > MAX_MESSAGES) {
    entry.messages.splice(0, entry.messages.length - MAX_MESSAGES);
  }
  entry.updatedAt = Date.now();
  conversations.set(whatsappNumber, entry);
}

function clearHistory(whatsappNumber) {
  conversations.delete(whatsappNumber);
}

module.exports = { getHistory, addMessage, clearHistory };