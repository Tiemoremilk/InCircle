const JOIN_CODE_LENGTH = 8;
const JOIN_CODE_CHARACTER = /^[A-Za-z0-9@#￥%&]$/;
const JOIN_CODE_PATTERN = /^[A-Za-z0-9@#￥%&]{8}$/;
const INVITE_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const JOIN_CODE_HEX_PATTERN = /^(?:[a-f0-9]{4}){8}$/i;

function normalizeJoinCode(value) {
  return Array.from(String(value || "").trim())
    .filter((character) => JOIN_CODE_CHARACTER.test(character))
    .slice(0, JOIN_CODE_LENGTH)
    .join("");
}

function normalizeInviteToken(value) {
  return String(value || "").trim();
}

function encodeJoinCodeHex(value) {
  const joinCode = normalizeJoinCode(value);
  if (!JOIN_CODE_PATTERN.test(joinCode)) return "";
  return Array.from(joinCode)
    .map((character) => character.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
}

function decodeJoinCodeHex(value) {
  const encoded = String(value || "").trim();
  if (!JOIN_CODE_HEX_PATTERN.test(encoded)) return "";
  let joinCode = "";
  for (let offset = 0; offset < encoded.length; offset += 4) {
    joinCode += String.fromCharCode(parseInt(encoded.slice(offset, offset + 4), 16));
  }
  return JOIN_CODE_PATTERN.test(joinCode) ? joinCode : "";
}

function parseInviteOptions(options) {
  const source = options || {};
  const scene = normalizeInviteToken(source.scene);
  const explicitToken = normalizeInviteToken(source.token);
  const inviteToken = INVITE_TOKEN_PATTERN.test(explicitToken)
    ? explicitToken
    : INVITE_TOKEN_PATTERN.test(scene) ? scene : "";
  const encodedCode = decodeJoinCodeHex(source.codeHex);
  return {
    inviteToken,
    joinCode: encodedCode,
  };
}

function inviteQuery(joinCode, inviteToken) {
  const token = normalizeInviteToken(inviteToken);
  if (INVITE_TOKEN_PATTERN.test(token)) return `?token=${encodeURIComponent(token)}`;
  const codeHex = encodeJoinCodeHex(joinCode);
  return codeHex ? `?codeHex=${codeHex}` : "";
}

module.exports = {
  decodeJoinCodeHex,
  encodeJoinCodeHex,
  inviteQuery,
  normalizeInviteToken,
  normalizeJoinCode,
  parseInviteOptions,
};
