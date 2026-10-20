/**
 * Validação do nó LND real — rode no instante em que o nó estiver de pé e as envs LND_* setadas.
 * Confirma conectividade/escopo do macaroon/TLS SEM nunca imprimir segredos.
 *
 *   npx tsx --env-file=.env scripts/lnd-check.mts                 # getinfo + saldo de canais
 *   npx tsx --env-file=.env scripts/lnd-check.mts <bolt11>        # + decodifica um invoice de teste
 *
 * Saída: rede do nó, pubkey, liquidez OUTBOUND (o BTC que a mesa consegue entregar) e INBOUND.
 * Códigos de saída: 0 ok · 1 simulador (envs ausentes/LND_SIMULATE=1) · 2 falha de conexão.
 */
import { loadConfig, lndConfig } from '../src/config.js';
import { createLightningService } from '../src/adapters/lightning/index.js';

const fmtSat = (s: bigint) => `${s.toLocaleString('pt-BR')} sat (${(Number(s) / 1e8).toFixed(8)} BTC)`;

async function main() {
  const config = loadConfig();
  const cfg = lndConfig(config);
  const { service, real } = createLightningService(config);

  if (!real || !cfg) {
    console.error('✗ SIMULADOR ativo — o grupo LND_* não está completo ou LND_SIMULATE=1.');
    console.error('  Para ligar o nó real: LND_SIMULATE=0 + LND_REST_URL + LND_MACAROON (hex) + LND_TLS_CERT.');
    process.exit(1);
  }

  // Confirma QUE a URL é a esperada sem vazar macaroon/cert.
  console.log(`▸ endpoint: ${cfg.restUrl}  (macaroon ${cfg.macaroonHex.length / 2} bytes · cert ${/BEGIN CERT/.test(cfg.tlsCert) ? 'PEM' : 'base64'})`);

  try {
    const info = await service.getNodeInfo();
    const bal = await service.getBalance();
    console.log(`✓ getinfo  pubkey=${info.pubkey.slice(0, 12)}… alias="${info.alias}" chains=[${info.chains.join(', ')}]`);
    console.log(`✓ canais   OUTBOUND=${fmtSat(bal.outboundSat)}   INBOUND=${fmtSat(bal.inboundSat)}`);

    // Avisos de sanidade para o estado atual (perna USDT na Sepolia testnet).
    const net = info.chains.join(',').toLowerCase();
    const looksMainnet = net.includes('mainnet') || (net.includes('bitcoin') && !net.includes('test') && !net.includes('signet') && !net.includes('regtest'));
    if (looksMainnet) console.warn('⚠ ATENÇÃO: o nó parece MAINNET (BTC real). A perna USDT hoje é Sepolia (testnet) — não aprove swaps reais nesse par.');
    if (bal.outboundSat === 0n) console.warn('⚠ Liquidez OUTBOUND zero: o precheck da aprovação vai barrar todo swap. Abra um canal com saldo local.');

    const bolt11 = process.argv[2];
    if (bolt11) {
      const inv = await service.decodeInvoice(bolt11);
      console.log(`✓ decode   payment_hash=${inv.paymentHash.slice(0, 16)}… valor=${fmtSat(inv.amountSat)} expira=${new Date(inv.expiresAt).toISOString()}`);
    }
    console.log('\n✅ Nó LND acessível. Para produção: LND_SIMULATE=0 no deploy e liquidez OUTBOUND ≥ maior swap esperado.');
  } catch (e) {
    console.error(`✗ falha ao falar com o nó: ${(e as Error).message}`);
    console.error('  Verifique: REST acessível pela internet (Vercel chama de fora), macaroon com escopo info:read+offchain:read, cert correto.');
    process.exit(2);
  }
}

void main();
