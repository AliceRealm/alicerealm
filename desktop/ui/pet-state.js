export const PET_INTERACTIONS = Object.freeze({
  wave: { duration: 1700, status: '有好友向你挥手', symbol: '👋' },
  high_five: { duration: 1500, status: '好友邀请你击掌', symbol: '✋' },
  visit_request: { duration: 2100, status: '好友想来串门', symbol: '🚪' },
  visit_accept: { duration: 2100, status: '串门邀请已接受', symbol: '✨' },
  visit_decline: { duration: 1800, status: '这次先休息一下', symbol: '🌙' },
  gift: { duration: 2100, status: '收到一份好友礼物', symbol: '🎁' },
  emote: { duration: 1800, status: '好友分享了一个心情', symbol: '💚' },
});

const ID_PATTERN = /^\d+$/;

function requireDecimalString(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a decimal string`);
  }
  return value;
}

export function normalizeInteraction(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('interaction data must be an object');
  }

  const eventType = data.event_type;
  const presentation = PET_INTERACTIONS[eventType];
  if (!presentation) throw new TypeError('unsupported pet interaction');

  const payload = data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload)
    ? data.payload
    : {};
  const message = typeof payload.message === 'string' ? payload.message.trim().slice(0, 80) : '';

  return Object.freeze({
    interactionId: requireDecimalString(data.interaction_id, 'interaction_id'),
    senderAgentId: requireDecimalString(data.sender_agent_id, 'sender_agent_id'),
    receiverAgentId: requireDecimalString(data.receiver_agent_id, 'receiver_agent_id'),
    eventType,
    message,
    ...presentation,
  });
}

export function parsePetEnvelope(input) {
  const envelope = typeof input === 'string' ? JSON.parse(input) : input;
  if (!envelope || envelope.type !== 'pet.interaction') {
    throw new TypeError('unsupported pet event envelope');
  }
  return normalizeInteraction(envelope.data);
}

export class PetStateMachine {
  constructor(render, options = {}) {
    if (typeof render !== 'function') throw new TypeError('render must be a function');
    this.render = render;
    this.schedule = options.schedule ?? setTimeout;
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout;
    this.onComplete = options.onComplete ?? (() => {});
    this.queue = [];
    this.seen = new Set();
    this.seenOrder = [];
    this.timer = null;
    this.current = null;
    this.connected = false;
    this.renderIdle();
  }

  setConnected(connected) {
    this.connected = Boolean(connected);
    if (!this.current) this.renderIdle();
  }

  enqueue(rawInteraction) {
    const interaction = rawInteraction.eventType ? rawInteraction : normalizeInteraction(rawInteraction);
    if (this.seen.has(interaction.interactionId)) return false;

    this.seen.add(interaction.interactionId);
    this.seenOrder.push(interaction.interactionId);
    if (this.seenOrder.length > 128) this.seen.delete(this.seenOrder.shift());
    this.queue.push(interaction);
    this.pump();
    return true;
  }

  react(eventType, message = '') {
    const presentation = PET_INTERACTIONS[eventType];
    if (!presentation) throw new TypeError('unsupported pet interaction');
    this.queue.push({
      interactionId: `local-${Date.now()}-${this.queue.length}`,
      senderAgentId: '0',
      receiverAgentId: '0',
      eventType,
      message: String(message).trim().slice(0, 80),
      ...presentation,
    });
    this.pump();
  }

  pump() {
    if (this.current || this.queue.length === 0) return;
    this.current = this.queue.shift();
    this.render({
      state: this.current.eventType,
      status: this.current.message || this.current.status,
      symbol: this.current.symbol,
      interaction: this.current,
    });
    this.timer = this.schedule(() => this.completeCurrent(), this.current.duration);
  }

  completeCurrent() {
    const completed = this.current;
    this.timer = null;
    this.current = null;
    this.renderIdle();
    if (completed) this.onComplete(completed);
    this.pump();
  }

  renderIdle() {
    this.render({
      state: this.connected ? 'idle' : 'offline',
      status: this.connected ? 'AliceRealm 已连接' : 'AliceRealm 桌宠待连接',
      symbol: '',
      interaction: null,
    });
  }

  dispose() {
    if (this.timer !== null) this.cancelSchedule(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.current = null;
  }
}
