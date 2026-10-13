/**
 * Guardas de regressão do FRONTEND (lê os HTML servidos). Travam correções já feitas para
 * que não voltem silenciosamente num refactor. São asserts de presença/padrão — baratos e
 * estáveis, sem navegador. Se algum quebrar, um fix de robustez foi removido sem querer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL('../web/' + f, import.meta.url), 'utf8');
const PAGES = ['verum-dashboard.html', 'verum-saas.html', 'verum-convite.html', 'verum-operacao.html'];

describe('Guarda frontend · rede de segurança para rejeições de promessa', () => {
  for (const p of PAGES) {
    it(`${p} registra listener de unhandledrejection`, () => {
      const html = read(p);
      expect(html).toContain('unhandledrejection');
      expect(html).toContain('preventDefault');
    });
  }
});

describe('Guarda frontend · cópia resiliente (clipboard com fallback)', () => {
  const html = read('verum-dashboard.html');
  it('clip() tem fallback execCommand(\'copy\') (funciona em iframe/sem permissão)', () => {
    expect(html).toContain("execCommand('copy')");
    expect(html).toContain('function legacyCopy');
  });
  it('clip() trata a rejeição da Clipboard API (.catch), nunca deixa escapar', () => {
    // dentro de clip(): writeText(...).then(...).catch(...)
    expect(html).toMatch(/writeText\([^)]*\)\.then\([^)]*\)\.catch\(/);
  });
  it('convite: "Copiar erro" não deixa a promessa de writeText escapar', () => {
    const conv = read('verum-convite.html');
    // há um .catch associado ao writeText do botão copiar
    expect(conv).toMatch(/writeText\([\s\S]{0,120}?catch/);
  });
});

describe('Guarda frontend · responsividade mobile (sem overflow)', () => {
  it('/ver: media queries de .op-parts/.op-steps usam !important (vencem o grid inline)', () => {
    const op = read('verum-operacao.html');
    // o grid inline (repeat(N,1fr)) só é vencido no mobile com !important
    expect(op).toMatch(/op-parts\{grid-template-columns:1fr!important\}/);
    expect(op).toMatch(/op-steps\{grid-template-columns:1fr!important\}/);
  });
  it('painel: lista "Minhas mesas" usa .m3-row (empilha no mobile) e não layout inline frágil', () => {
    const dash = read('verum-dashboard.html');
    expect(dash).toContain('class="m3-row"');
    expect(dash).toContain('.m3-row{');
    // a linha deve empilhar no mobile
    expect(dash).toMatch(/\.m3-row\{flex-direction:column/);
  });
  it('painel: linhas de cadeira do wizard empilham no mobile', () => {
    const dash = read('verum-dashboard.html');
    expect(dash).toMatch(/\[data-m3-chair\]\{flex-direction:column/);
  });
});

describe('Guarda frontend · Verum-only (sem fallback para outras carteiras)', () => {
  it('convite não tem FALLBACK para outras carteiras (|| window.ethereum, unisat, tronLink)', () => {
    const conv = read('verum-convite.html');
    // O fallback removido era "|| window.ethereum" — referenciar window.ethereum é OK desde que
    // só aceite isVerum (seleção do provider EVM da Verum via EIP-6963), nunca como fallback.
    expect(conv).not.toMatch(/\|\|\s*window\.ethereum/);
    expect(conv).not.toContain('window.unisat');
    expect(conv).not.toContain('window.tronLink');
    expect(conv).not.toContain('window.tronWeb');
    // Toda referência a window.ethereum deve estar na mesma região de um teste isVerum.
    for (const m of conv.matchAll(/window\.ethereum/g)) {
      const around = conv.slice(Math.max(0, m.index! - 200), m.index! + 200);
      expect(around, 'window.ethereum sem gate isVerum por perto').toContain('isVerum');
    }
  });
});
