const A='bc1qcsqm5832s7jcxezsvha8aeav2ut0suv8y6kqruc6zu0w52wswrxs9t32mc';
const TXID='d6fb58d05946e39617c7c87cca0ab95d41875355cf22a397c0eee8a28397ddb6';
const need=3; const maxIters=18; // ~18 x 4min = ~72 min
for(let i=0;i<maxIters;i++){
  try{
    const tip=Number(await (await fetch('https://blockstream.info/api/blocks/tip/height')).text());
    const utxos=await (await fetch(`https://blockstream.info/api/address/${A}/utxo`)).json();
    const u=utxos.find(x=>x.txid===TXID)||utxos[0];
    const confs=(u&&u.status&&u.status.confirmed&&u.status.block_height)?(tip-u.status.block_height+1):0;
    const sum=utxos.reduce((s,x)=>s+(x.value||0),0);
    console.log(new Date().toISOString()+` · saldo ${sum} sats · ${confs} conf(s) · tip ${tip}`);
    if(confs>=need){ console.log(`\n✅ COFRE CONFIRMADO: ${confs} confirmações (≥${need}) · saldo ${sum} sats. O cron pode abrir a operação agora.`); process.exit(0); }
  }catch(e){ console.log('poll erro: '+((e&&e.message)||e)); }
  await new Promise(r=>setTimeout(r,240000));
}
console.log('\n⏳ monitor encerrou (timeout ~72min) sem atingir 3 confs — rode de novo se precisar.');
