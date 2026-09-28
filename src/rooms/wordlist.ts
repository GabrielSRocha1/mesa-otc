/**
 * Impressão digital da operação (§5.3): 6 palavras em português derivadas do termsHash,
 * exibidas a todos os participantes (e na carteira) para conferência verbal. Qualquer
 * mudança nos termos muda a sequência. Lista fixa de 64 palavras (6 bits/palavra).
 */
export const FINGERPRINT_WORDS: readonly string[] = [
  'agua', 'areia', 'arvore', 'barco', 'brisa', 'cacto', 'campo', 'canoa',
  'ceu', 'chuva', 'colina', 'coral', 'dado', 'dente', 'estrela', 'faca',
  'farol', 'ferro', 'flor', 'folha', 'fogo', 'fonte', 'fruta', 'gaivota',
  'gelo', 'grao', 'ilha', 'jardim', 'lago', 'leao', 'lenho', 'lua',
  'mapa', 'mar', 'mel', 'monte', 'nuvem', 'onda', 'ouro', 'palha',
  'pedra', 'peixe', 'pilar', 'ponte', 'porto', 'prata', 'raiz', 'rede',
  'rio', 'rocha', 'rosa', 'sino', 'sol', 'sombra', 'trigo', 'trilho',
  'vale', 'vela', 'vento', 'vidro', 'vinho', 'voz', 'zebra', 'zinco',
];

/** Deriva 6 palavras determinísticas de um termsHash (hex de 64 chars). */
export function fingerprintWords(termsHashHex: string): string[] {
  const hex = (termsHashHex || '').replace(/[^0-9a-f]/gi, '');
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2) || '0', 16);
    out.push(FINGERPRINT_WORDS[byte & 63]!);
  }
  return out;
}
