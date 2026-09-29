export function resolveContextIdentity(context) {
  const chatSessionId = firstText(
    safeCall(() => context?.getCurrentChatId?.()),
    context?.chatId,
    context?.chatFileName,
    context?.chatMetadata?.chat_id,
    context?.chat_metadata?.chat_id,
  );
  if (!chatSessionId) return null;

  let characterWorldId;
  if (context?.groupId !== null && context?.groupId !== undefined && String(context.groupId).length > 0) {
    characterWorldId = 'group:' + String(context.groupId);
  } else {
    const character = context?.characters?.[Number(context?.characterId)];
    const stableCharacterId = firstText(character?.avatar, character?.id);
    if (!stableCharacterId) return null;
    characterWorldId = 'character:' + stableCharacterId;
  }

  const metadata = context?.chatMetadata ?? context?.chat_metadata ?? {};
  const branchSource = firstText(metadata.branch_id, metadata.branchId, metadata.main_chat, metadata.mainChat);
  const branchId = branchSource ? 'branch:' + branchSource : 'chat:' + chatSessionId;
  return { characterWorldId, chatSessionId: String(chatSessionId), branchId };
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

