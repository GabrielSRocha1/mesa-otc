// Compila contracts/*.sol com solc-js (0.8.x), resolvendo imports de node_modules. Falha em erro; lista warnings.
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)); const dir = join(root, 'contracts'); const out = join(dir, 'out'); mkdirSync(out, { recursive: true });
const list = [...readdirSync(dir).filter(f => f.endsWith('.sol')), ...readdirSync(join(dir, 'mocks')).filter(f => f.endsWith('.sol')).map(f => 'mocks/' + f)];
const sources = Object.fromEntries(list.map(f => [f, { content: readFileSync(join(dir, f), 'utf8') }]));
const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
const findImports = p => { try { return { contents: readFileSync(join(root, 'node_modules', p), 'utf8') }; } catch { return { error: 'não encontrado: ' + p }; } };
const res = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (res.errors ?? []).filter(e => e.severity === 'error'); const warns = (res.errors ?? []).filter(e => e.severity !== 'error');
warns.forEach(w => console.warn('warning:', w.formattedMessage.split('\n')[0]));
if (errors.length) { errors.forEach(e => console.error(e.formattedMessage)); process.exit(1); }
for (const [file, contracts] of Object.entries(res.contracts)) for (const [name, c] of Object.entries(contracts)) { if (!c.evm.bytecode.object || !sources[file]) continue; writeFileSync(join(out, `${name}.json`), JSON.stringify({ contractName: name, sourceName: file, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object, compiler: solc.version(), evmVersion: input.settings.evmVersion }, null, 2)); console.log(`✓ ${name} (${c.evm.deployedBytecode.object.length / 2} bytes, ${c.abi.length} entradas de ABI)`); }
