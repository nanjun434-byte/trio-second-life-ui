export const TRIO_CARD_WORLD_ID = 'sos_trio_second_life_zh';
export const TRIO_CARD_GAME_ID = 'story_of_seasons_trio_of_towns';

export function getTrioCardMetadata(context) {
  if (context?.groupId !== null && context?.groupId !== undefined && String(context.groupId).length > 0) return null;
  const character = context?.characters?.[Number(context?.characterId)];
  const metadata = character?.data?.extensions?.trio_second_life
    ?? character?.extensions?.trio_second_life;
  if (!metadata || metadata.schema_version !== 2
    || metadata.world_id !== TRIO_CARD_WORLD_ID
    || metadata.game_id !== TRIO_CARD_GAME_ID
    || metadata.card_role !== 'world_ensemble'
    || metadata.runtime_contract_version !== 2) return null;
  return metadata;
}

export function ensureContextBinding(context, createId = createOperationId) {
  const card = getTrioCardMetadata(context);
  if (!card) return null;
  const chatSessionId = firstText(
    safeCall(() => context?.getCurrentChatId?.()),
    context?.chatId,
    context?.chatFileName,
    context?.chatMetadata?.chat_id,
    context?.chat_metadata?.chat_id,
  );
  if (!chatSessionId) return null;
  const chatMetadata = context?.chatMetadata ?? context?.chat_metadata;
  if (!chatMetadata || typeof chatMetadata !== 'object') return null;

  const existing = chatMetadata.trio_second_life;
  const sameChat = existing?.schema_version === 2
    && existing.world_id === card.world_id
    && existing.origin_chat_id === String(chatSessionId)
    && typeof existing.chat_instance_id === 'string'
    && existing.chat_instance_id.length > 0;
  const binding = sameChat ? existing : {
    schema_version: 2,
    world_id: card.world_id,
    chat_instance_id: createId(),
    save_id: null,
    origin_chat_id: String(chatSessionId),
    last_server_revision: null,
    canonical_data_version: card.canonical_profile ?? 'unknown',
  };
  chatMetadata.trio_second_life = binding;
  return {
    identity: {
      characterWorldId: card.world_id,
      chatSessionId: String(chatSessionId),
      branchId: 'instance:' + binding.chat_instance_id,
    },
    binding,
    changed: !sameChat,
  };
}

export function identityKey(identity) {
  return identity ? [identity.characterWorldId, identity.chatSessionId, identity.branchId].join('|') : '';
}

export class ContextGuard {
  #epoch = 0;
  #controller = new AbortController();

  capture(key) {
    return { epoch: this.#epoch, key, signal: this.#controller.signal };
  }

  invalidate() {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#epoch += 1;
  }

  assertCurrent(token, key) {
    if (token.signal.aborted || token.epoch !== this.#epoch || token.key !== key) throw new StaleContextError();
  }

  get signal() { return this.#controller.signal; }
}

export class StaleContextError extends Error {
  constructor() { super('STALE_CHAT_CONTEXT'); this.name = 'StaleContextError'; }
}

export function createOperationId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes].map((byte, index) => {
      const hex = byte.toString(16).padStart(2, '0');
      return [4, 6, 8, 10].includes(index) ? '-' + hex : hex;
    }).join('');
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const random = Math.random() * 16 | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function firstText(...values) {
  const value = values.find(item => (typeof item === 'string' || typeof item === 'number') && String(item).trim().length > 0);
  return value === undefined ? null : String(value);
}

function safeCall(fn) {
  if (typeof fn !== 'function') return null;
  try { return fn(); } catch { return null; }
}

