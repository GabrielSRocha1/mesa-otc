// GERADO de verum-wallet/src/services/verumProvider.ts — provider da Verum p/ dApp embutido.
// So ativa dentro de iframe (navegador dApp da Verum); no topo (desktop/extensao ou mobile fora) nao faz nada.
(function(){ try{ if (window.top === window.self) return; }catch(e){ return; }

(function () {
  if (window.__verumLoaded) return;
  window.__verumLoaded = true;

  var DEBUG   = false;
  var NETWORK = "solana";

  // ── Logger estruturado ─────────────────────────────────────────────────────
  function log(category, msg, data) {
    if (!DEBUG) return;
    var prefix = '[VERUM][' + category + ']';
    data !== undefined
      ? console.log(prefix, msg, data)
      : console.log(prefix, msg);
  }

  // ── Fila de callbacks pendentes (id → {resolve, reject, ts}) ─────────────
  var _cbs = {};
  var _seq = 0;
  var _pending = {}; // id por tipo de request (evita duplicatas excessivas)

  function nextId() { return 'vr' + (++_seq); }

  function enqueue(resolve, reject, type) {
    // Se já existe um connect pendente do mesmo tipo, não duplica o envio pesado
    if (type === 'connect' && _pending['connect']) {
      var existingId = _pending['connect'];
      if (_cbs[existingId]) {
        log('ROBUST', 'Reutilizando request de connect pendente', existingId);
        var oldResolve = _cbs[existingId].resolve;
        var oldReject = _cbs[existingId].reject;
        _cbs[existingId].resolve = function(res) { oldResolve(res); resolve(res); };
        _cbs[existingId].reject = function(err) { oldReject(err); reject(err); };
        return null; // Indica que não precisa enviar mensagem de novo
      }
    }

    var id = nextId();
    // (PF9) Guarda o handle do timeout para limpar no settle — antes ficavam
    // pendurados até 2min mesmo quando a request resolvia normalmente.
    var timeoutHandle = setTimeout(function() {
      if (_cbs[id]) {
        settle(id, null, 'TIMEOUT');
      }
    }, 120000);
    _cbs[id] = { resolve: resolve, reject: reject, ts: Date.now(), type: type, timeoutHandle: timeoutHandle };
    if (type) _pending[type] = id;

    return id;
  }

  function settle(id, result, error) {
    var cb = _cbs[id];
    if (!cb) return;

    // (PF9) Limpa o timeout pendente — sem isso, o timer continuava vivo até
    // 2min após resolução natural, mantendo o callback em memória.
    if (cb.timeoutHandle) {
      clearTimeout(cb.timeoutHandle);
    }

    if (cb.type && _pending[cb.type] === id) {
      delete _pending[cb.type];
    }

    delete _cbs[id];
    
    if (error) {
      log('REJECT', id, error);
      cb.reject(new WalletError(error));
    } else {
      log('RESOLVE', id);
      
      // Transformações de resultado baseadas no tipo de request
      var finalResult = result;
      
      // Se for assinatura de mensagem simples — retorna { signature, publicKey } (padrão Phantom).
      // A wallet pode mandar a assinatura como base64, bs58, array ou objeto-bytes (serialização
      // do postMessage): normaliza SEMPRE para Uint8Array(64) — o dApp não deve adivinhar.
      if (cb.type === 'signMsg' && result && result.signature !== undefined) {
        finalResult = {
          signature: normalizeSigBytes(result.signature),
          publicKey: result.publicKey || (window.verum.publicKey ? window.verum.publicKey.toString() : ''),
        };
      }
      
      // Se for assinatura de transação única (Uint8Array da tx completa)
      if (cb.type === 'sign' && typeof result === 'string') {
        finalResult = decodeBase64(result);
      }

      // Se for assinatura de múltiplas transações (Array de Uint8Array)
      if (cb.type === 'signAll' && Array.isArray(result)) {
        finalResult = result.map(function(s) { return typeof s === 'string' ? decodeBase64(s) : s; });
      }

      // Se for conexão (sucesso do handshake)
      if (cb.type === 'connect' && result && result.publicKey) {
        // result.publicKey pode chegar como string base58 (bridge web/flat) OU
        // como objeto já empacotado (no nativo, __cb chama __setConnected antes
        // de settle). Normalizamos SEMPRE para a string base58 e empacotamos uma
        // única vez. Sem isso, o objeto era re-empacotado (_s virava objeto),
        // corrompendo toBytes() e fazendo new PublicKey() falhar no adapter do
        // dApp — a wallet mostrava "CONECTADA" mas o site nunca avançava.
        var pkRaw = result.publicKey;
        var pkStr = typeof pkRaw === 'string'
          ? pkRaw
          : (pkRaw && typeof pkRaw.toBase58 === 'function'
              ? pkRaw.toBase58()
              : (pkRaw && typeof pkRaw.toString === 'function' ? pkRaw.toString() : String(pkRaw)));
        var pk = window.verum.__initPublicKey(pkStr);
        window.verum.connected   = true;
        window.verum.isConnected = true;
        window.verum.publicKey   = pk;
        result.publicKey         = pk;
        window.verum.emit('connect', pk);
        window.verum.emit('accountChanged', pk);
        log('CONNECTED', pk.toString());
      }

      cb.resolve(finalResult);
    }
  }

  /** Helper para converter Base64 em Uint8Array compatível com Solanachain standard */
  var B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58decode(s) {
    var n = 0n;
    for (var i = 0; i < s.length; i++) { var x = B58_ALPHA.indexOf(s[i]); if (x < 0) return null; n = n * 58n + BigInt(x); }
    var out = [];
    while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
    for (var j = 0; j < s.length && s[j] === '1'; j++) out.unshift(0);
    return new Uint8Array(out);
  }
  function sig64One(v) {
    if (v instanceof Uint8Array) return v.length === 64 ? v : null;
    if (Array.isArray(v) && v.every(function (x) { return typeof x === 'number'; })) { var a = new Uint8Array(v); return a.length === 64 ? a : null; }
    if (v && typeof v === 'object' && Array.isArray(v.data)) { var dd = new Uint8Array(v.data); return dd.length === 64 ? dd : null; }
    if (v && typeof v === 'object') { var ks = Object.keys(v).filter(function (k) { return /^\d+$/.test(k); }); if (ks.length > 8) { var arr = new Uint8Array(ks.sort(function (a, b) { return a - b; }).map(function (k) { return v[k]; })); return arr.length === 64 ? arr : null; } }
    if (typeof v === 'string') {
      var b64 = decodeBase64(v); if (b64 instanceof Uint8Array && b64.length === 64) return b64;
      var b58 = b58decode(v); if (b58 && b58.length === 64) return b58;
    }
    return null;
  }
  /** Assinatura ed25519 (64 bytes) vinda da wallet em QUALQUER forma/aninhamento → Uint8Array(64).
   *  Busca recursiva: bytes crus, objeto indexado, {data:[...]}, string base64/bs58, {signature:{...}}. */
  function normalizeSigBytes(v) {
    var seen = [];
    function walk(x, depth) {
      if (x == null || depth > 5) return null;
      var hit = sig64One(x); if (hit) return hit;
      if (typeof x === 'object' && seen.indexOf(x) < 0) {
        seen.push(x);
        var keys = ['signature', 'sig', 'data', 'bytes', 'value', 'result'].concat(Object.keys(x).filter(function (k) { return !/^\d+$/.test(k); }));
        for (var i = 0; i < keys.length; i++) { if (x[keys[i]] !== undefined) { var r = walk(x[keys[i]], depth + 1); if (r) return r; } }
      }
      return null;
    }
    return walk(v, 0) || v; // forma desconhecida: o dApp normaliza/erra com mensagem clara
  }
  function decodeBase64(str) {
    try {
      var bin = atob(str);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    } catch (e) {
      console.error('[VERUM][BRIDGE] Falha ao decodificar base64:', e);
      return str;
    }
  }

  // ── Erros padronizados ────────────────────────────────────────────────────
  function WalletError(code, message) {
    var msg = message || codeToMessage(code) || code;
    var err = new Error(msg);
    err.name  = 'WalletError';
    err.code  = code;
    return err;
  }

  function codeToMessage(code) {
    var map = {
      WALLET_NOT_FOUND:  'Verum Wallet não encontrada.',
      USER_REJECTED:     'Solicitação recusada pelo usuário.',
      INVALID_PAYLOAD:   'Payload de transação inválido.',
      NETWORK_MISMATCH:  'A rede da transação não corresponde à rede ativa.',
      NOT_CONNECTED:     'Carteira não conectada. Chame connect() primeiro.',
      TIMEOUT:           'A solicitação expirou.',
    };
    return map[code] || null;
  }

  // ── Detector de ambiente ──────────────────────────────────────────────────
  var _isWebView   = typeof window.ReactNativeWebView !== 'undefined';
  var _isIframe    = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
  // Extensão Chrome: o build (scripts/build-extension.mjs) prepende
  // "window.__verumExtension = true;" no injected-provider.js — sem handshake,
  // sem corrida com o content script.
  var _isExtension = window.__verumExtension === true;

  log('DETECTION', 'ambiente', { isWebView: _isWebView, isIframe: _isIframe, isExtension: _isExtension, network: NETWORK });

  // ── Envio de mensagem para o app ──────────────────────────────────────────
  function send(data) {
    var json = JSON.stringify(data);
    if (_isExtension) {
      // MAIN world → content script (ISOLATED) → chrome.runtime → service worker
      window.postMessage({ __verum_channel: 'page->cs', msg: data }, window.location.origin);
    } else if (_isWebView) {
      window.ReactNativeWebView.postMessage(json);
    } else if (_isIframe) {
      window.parent.postMessage(data, '*');
    }
    log('HANDSHAKE', 'send', data.type + ' id=' + (data.id || '-'));
  }

  // ── Recepção de resposta do app (via postMessage — web/iframe/extensão) ───
  if (_isExtension || (_isIframe && !_isWebView)) {
    window.addEventListener('message', function (e) {
      var d = e.data;
      // Modo extensão: respostas chegam do content script embrulhadas em
      // { __verum_channel:'cs->page', msg } e sempre de e.source === window.
      if (_isExtension) {
        if (e.source !== window || !d || d.__verum_channel !== 'cs->page') return;
        d = d.msg;
      }
      if (!d || typeof d !== 'object' || !d.type || !d.id) return;

      log('HANDSHAKE', 'recv', d.type);

      switch (d.type) {
        case 'VERUM_CONNECT_RESPONSE':
          // Caminho A: repassa o array plano de enderecos (ids do portal) que a
          // carteira embute no CONNECT_RESPONSE — o dApp ja recebe as redes ao
          // conectar, sem chamar getAddresses. Ausente = omitido (compat).
          var _connAddrs = Array.isArray(d.addresses) ? d.addresses : undefined;
          if (_isExtension) {
            // dApps esperam um objeto PublicKey-like (toBase58/toBytes/equals);
            // __setConnected monta o objeto e emite os eventos padrão.
            window.verum.__setConnected(d.publicKey);
            settle(d.id, { publicKey: window.verum.publicKey, addresses: _connAddrs }, null);
            break;
          }
          window.verum.isConnected = true;
          window.verum.publicKey   = d.publicKey;
          settle(d.id, { publicKey: d.publicKey, addresses: _connAddrs }, null);
          window.dispatchEvent(new CustomEvent('verum#connected', { detail: { publicKey: d.publicKey } }));
          break;
        case 'VERUM_CONNECT_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_SIGN_TX_RESPONSE':
          settle(d.id, d.signedTransaction, null);
          break;
        case 'VERUM_SIGN_TX_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_SIGN_AND_SEND_RESPONSE':
          // Assinou + transmitiu: resolve { signature } (base58, padrão Phantom).
          settle(d.id, { signature: d.signature }, null);
          break;
        case 'VERUM_SIGN_AND_SEND_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_SIGN_ALL_RESPONSE':
          settle(d.id, d.signedTransactions, null);
          break;
        case 'VERUM_SIGN_ALL_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_SIGN_MSG_RESPONSE':
          settle(d.id, { signature: d.signature, publicKey: d.publicKey }, null);
          break;
        case 'VERUM_SIGN_MSG_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_SIGN_PERSONAL_RESPONSE':
          // personal_sign multichain (EIP-191/TIP-191/BIP-137/SEP-53). SEM este
          // case, a resposta da carteira caía no vazio e o dApp ficava preso em
          // "Deslize para assinar…" para sempre (promise nunca liquidada).
          settle(d.id, { signature: d.signature, address: d.address, chainKey: d.chainKey }, null);
          break;
        case 'VERUM_SIGN_PERSONAL_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_TRANSFER_RESPONSE':
          // Resolve { txHash } — a assinatura já aceita pelo RPC (base58).
          settle(d.id, { txHash: d.txHash }, null);
          break;
        case 'VERUM_TRANSFER_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_MULTI_TRANSFER_RESPONSE':
          // Um único txHash comprova todas as pernas (atômico por construção).
          settle(d.id, { txHash: d.txHash }, null);
          break;
        case 'VERUM_MULTI_TRANSFER_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_PAYMENT_RESPONSE':
          // Pagamento declarativo: a carteira montou+assinou+transmitiu. Resolve
          // { txHash } (aceita tambem a grafia signature por tolerancia do protocolo).
          settle(d.id, { txHash: d.txHash != null ? d.txHash : d.signature }, null);
          break;
        case 'VERUM_PAYMENT_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_TRON_SIGN_TYPED_RESPONSE':
          // Typed data TIP-712 (perna Tron do escrow V2): { signature 0x…65B, address T… }.
          settle(d.id, { signature: d.signature, address: d.address }, null);
          break;
        case 'VERUM_TRON_SIGN_TYPED_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_TRON_CALL_RESPONSE':
          // Contract call Tron (approve/signV2): resolve { txHash } após o broadcast.
          settle(d.id, { txHash: d.txHash }, null);
          break;
        case 'VERUM_TRON_CALL_REJECTED':
          settle(d.id, null, d.reason || 'USER_REJECTED');
          break;
        case 'VERUM_ADDRESSES_RESPONSE':
          settle(d.id, { addresses: Array.isArray(d.addresses) ? d.addresses : [] }, null);
          break;
        case 'VERUM_BALANCE_RESPONSE':
          // A-01: resolve o objeto de saldo tipado ({ ok, amountAtomic, ... } ou
          // { ok:false, error }). O dApp inspeciona result.ok — nunca assume 0.
          settle(d.id, d.balance != null ? d.balance : d.result, null);
          break;
      }
    });
  }

  // ── Serialização de Transaction / VersionedTransaction ────────────────────
  function serializeTx(tx) {
    var bytes;
    // Wallet Standard (solana:signTransaction) entrega os bytes já serializados
    // como Uint8Array — não há objeto Transaction para .serialize(). Sem este
    // ramo, serializeTx lançava INVALID_PAYLOAD e a assinatura falhava só pela
    // lista de carteiras do dApp.
    if (tx instanceof Uint8Array) {
      bytes = tx;
    } else if (tx && tx.version !== undefined) {
      // VersionedTransaction (sem campo .signatures, usa .serialize() direto)
      bytes = tx.serialize();
    } else if (tx && typeof tx.serialize === 'function') {
      // Transaction legada
      bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    } else {
      throw new WalletError('INVALID_PAYLOAD');
    }
    // Evita stack overflow para arrays grandes (ex: transações complexas)
    var binary = '';
    var len = bytes.byteLength;
    for (var i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);

  }

  // ── window.verum ──────────────────────────────────────────────────────────
  window.verum = {
    isVerum:     true,
    isPhantom:   true,
    isSolflare:  true,
    connected:   false,
    isConnected: false,
    publicKey:   null,
    network:     NETWORK,

    // ── Internal event emitter ──────────────────────────────────────────────
    _events: {},
    on: function (event, cb) {
      if (!this._events[event]) this._events[event] = [];
      this._events[event].push(cb);
      return this;
    },
    off: function (event, cb) {
      if (!this._events[event]) return this;
      this._events[event] = this._events[event].filter(function (f) { return f !== cb; });
      return this;
    },
    emit: function (event, data) {
      if (!this._events[event]) return;
      this._events[event].forEach(function (cb) { try { cb(data); } catch (e) { console.error(e); } });
    },

    __initPublicKey: function (pubKeyStr) {
      if (!pubKeyStr) return null;
      return {
        _s: pubKeyStr,
        toString: function () { return this._s; },
        toBase58: function () { return this._s; },
        toJSON:   function () { return this._s; },
        equals:   function (other) { 
          return other && (other.toString() === this._s || other === this._s); 
        },
        toBytes:  function () { 
          return window.verum.__b58decode(this._s);
        }
      };
    },

    __b58decode: function (s) {
      var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      var lookup = {};
      for (var i = 0; i < ALPHABET.length; i++) lookup[ALPHABET[i]] = i;
      var bytes = [0];
      for (var i = 0; i < s.length; i++) {
        var c = lookup[s[i]];
        if (c === undefined) throw new Error('Invalid base58 character');
        for (var j = 0; j < bytes.length; j++) {
          c += bytes[j] * 58;
          bytes[j] = c & 0xff;
          c >>= 8;
        }
        while (c > 0) {
          bytes.push(c & 0xff);
          c >>= 8;
        }
      }
      for (var i = 0; s[i] === '1' && i < s.length - 1; i++) bytes.push(0);
      return new Uint8Array(bytes.reverse());
    },


    // ── connect ─────────────────────────────────────────────────────────────
    connect: function (options) {
      log('DETECTION', 'connect()', 'onlyIfTrusted=' + (options && options.onlyIfTrusted));
      
      // Se já estamos conectados com uma conta vinda do app nativo, resolvemos na hora
      if (window.verum.connected && window.verum.publicKey) {
        log('AUTO', 'Conexão automática via sessão ativa', window.verum.publicKey.toString());
        return Promise.resolve({ publicKey: window.verum.publicKey });
      }

      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'connect');
        if (id) {
          send({ type: 'VERUM_CONNECT_REQUEST', id: id, origin: window.location.origin });
        }
      });
    },

    // ── disconnect ──────────────────────────────────────────────────────────
    disconnect: function () {
      log('DETECTION', 'disconnect()', 'origin=' + window.location.origin);
      window.verum.connected = false;
      window.verum.publicKey = null;
      send({ type: 'VERUM_DISCONNECT', origin: window.location.origin });
      window.dispatchEvent(new Event('verum#disconnected'));
      window.verum.emit('disconnect');
      return Promise.resolve();
    },

    // ── signTransaction ─────────────────────────────────────────────────────
    signTransaction: function (transaction) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      log('SIGNATURE', 'signTransaction()', 'origin=' + window.location.origin);
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'sign');
        try {
          var serialized = serializeTx(transaction);
          send({ type: 'VERUM_SIGN_TX_REQUEST', id: id, transaction: serialized, origin: window.location.origin });
        } catch (e) {
          settle(id, null, 'INVALID_PAYLOAD');
        }
      });
    },

    // ── signAndSendTransaction ──────────────────────────────────────────────
    // A carteira ASSINA com a keypair embutida E TRANSMITE ela mesma, usando o
    // broadcaster resiliente (retry + fallback de RPC público + confirmação) e
    // blockhash fresco imediatamente antes de assinar. Resolve { signature }
    // (base58, padrão Phantom) SÓ após o broadcast confirmar. É este método que
    // torna "Pagar com a carteira" 100% automático — o dApp não transmite nada.
    signAndSendTransaction: function (transaction, options) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      log('SIGNATURE', 'signAndSendTransaction()', 'origin=' + window.location.origin);
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'signAndSend');
        try {
          var serialized = serializeTx(transaction);
          send({
            type: 'VERUM_SIGN_AND_SEND_REQUEST',
            id: id,
            transaction: serialized,
            options: options && typeof options === 'object' ? {
              skipPreflight: !!options.skipPreflight,
              maxRetries: typeof options.maxRetries === 'number' ? options.maxRetries : null,
            } : null,
            origin: window.location.origin,
          });
        } catch (e) {
          settle(id, null, 'INVALID_PAYLOAD');
        }
      });
    },

    // Alias p/ compat @solana/wallet-adapter (adapter.sendTransaction chama isto).
    sendTransaction: function (transaction, options) {
      return window.verum.signAndSendTransaction(transaction, options);
    },

    // ── signAllTransactions ─────────────────────────────────────────────────
    signAllTransactions: function (transactions) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      log('SIGNATURE', 'signAllTransactions()', 'count=' + transactions.length);
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'signAll');
        try {
          var serialized = transactions.map(serializeTx);
          send({ type: 'VERUM_SIGN_ALL_REQUEST', id: id, transactions: serialized, origin: window.location.origin });
        } catch (e) {
          settle(id, null, 'INVALID_PAYLOAD');
        }
      });
    },

    // ── signMessage ─────────────────────────────────────────────────────────
    signMessage: function (message) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      log('SIGNATURE', 'signMessage()', 'bytes=' + message.length);
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'signMsg');
        try {
          var binary = '';
          var bytes = new Uint8Array(message);
          for (var i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          var encoded = btoa(binary);

          send({ type: 'VERUM_SIGN_MSG_REQUEST', id: id, message: encoded, origin: window.location.origin });
        } catch (e) {
          settle(id, null, 'INVALID_PAYLOAD');
        }
      });
    },

    // ── signPersonalMessage (multichain: EVM/Tron/Bitcoin/Stellar) ──────────
    // Assina MENSAGEM no padrão da rede pedida (EIP-191, TIP-191, BIP-137,
    // SEP-53). message: string UTF-8, hex 0x (bytes) ou array de bytes.
    // Resolve { signature, address, chainKey }. A aprovação é do usuário.
    signPersonalMessage: function (chainKey, message, address) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      log('SIGNATURE', 'signPersonalMessage()', chainKey);
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'signPersonal:' + chainKey);
        try {
          var payload;
          if (typeof message === 'string') {
            payload = message;
          } else {
            // bytes → hex 0x… (o app decodifica de volta para bytes)
            var bytes = new Uint8Array(message);
            var hex = '0x';
            for (var i = 0; i < bytes.byteLength; i++) {
              hex += ('0' + bytes[i].toString(16)).slice(-2);
            }
            payload = hex;
          }
          if (!payload) { settle(id, null, 'INVALID_PAYLOAD'); return; }
          send({
            type: 'VERUM_SIGN_PERSONAL_REQUEST',
            id: id,
            chainKey: String(chainKey),
            message: payload,
            address: address ? String(address) : null,
            origin: window.location.origin,
          });
        } catch (e) {
          settle(id, null, 'INVALID_PAYLOAD');
        }
      });
    },

    // ── transfer (Protocolo de Transferência × Portal de Câmbio) ────────────
    // Recebe uma INTENÇÃO declarativa (asset/network/to/amount/memo/exactAmount)
    // e delega à carteira montar+assinar+transmitir. Resolve { txHash } SÓ após
    // o broadcast ser aceito. A capacidade, nesta superfície injetada, é a
    // própria presença deste método (typeof provider.transfer === 'function').
    transfer: function (intent) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      if (!intent || typeof intent !== 'object') {
        return Promise.reject(new WalletError('INVALID_PAYLOAD'));
      }
      log('SIGNATURE', 'transfer()', (intent.asset || '?') + ' ' + (intent.network || '?'));
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'transfer');
        send({
          type: 'VERUM_TRANSFER_REQUEST',
          id: id,
          intent: {
            asset:       intent.asset,
            network:     intent.network,
            to:          intent.to,
            amount:      intent.amount,
            memo:        intent.memo != null ? intent.memo : null,
            exactAmount: !!intent.exactAmount,
          },
          origin: window.location.origin,
        });
      }).catch(function (err) {
        // Recusa do usuário → padrão EIP-1193 (code 4001) que o portal detecta.
        // UNSUPPORTED/INSUFFICIENT_FUNDS/FAILED já viajam na .message (o portal
        // casa por substring), então só USER_REJECTED precisa desta normalização.
        if (err && err.code === 'USER_REJECTED') {
          var e = new Error('User rejected the transfer request.');
          e.name = 'WalletError';
          e.code = 4001;
          throw e;
        }
        throw err;
      });
    },

    // ── multiTransfer (comissão direta da Verum, spec v2 §8) ────────────────
    // Recebe UMA intenção com N saídas (depósito líquido + comissão) e delega à
    // carteira montar UMA transação atômica, exibir as saídas por extenso,
    // assinar UMA vez e transmitir. Resolve { txHash } — um único hash comprova
    // todas as pernas. A capacidade, nesta superfície, é a presença do método.
    multiTransfer: function (intent) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      if (!intent || typeof intent !== 'object' || !Array.isArray(intent.transfers)) {
        return Promise.reject(new WalletError('INVALID_PAYLOAD'));
      }
      log('SIGNATURE', 'multiTransfer()', (intent.asset || '?') + ' ' + (intent.network || '?') + ' x' + intent.transfers.length);
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'multiTransfer');
        send({
          type: 'VERUM_MULTI_TRANSFER_REQUEST',
          id: id,
          intent: {
            asset:     intent.asset,
            network:   intent.network,
            transfers: intent.transfers.map(function (leg) {
              return {
                to:     leg && leg.to,
                amount: leg && leg.amount,
                memo:   leg && leg.memo != null ? leg.memo : null,
              };
            }),
            exactAmount: !!intent.exactAmount,
            atomic:      true,
          },
          origin: window.location.origin,
        });
      }).catch(function (err) {
        // Recusa do usuário → padrão EIP-1193 (code 4001) que o portal detecta.
        if (err && err.code === 'USER_REJECTED') {
          var e = new Error('User rejected the transfer request.');
          e.name = 'WalletError';
          e.code = 4001;
          throw e;
        }
        throw err;
      });
    },

    // ── signAndSendPayment (pagamento declarativo, redes NÃO-Solana — v4 §5.1) ─
    // Recebe um DESCRITOR { network, outputs:[{address,amount,asset}], memo } e
    // delega à carteira MONTAR a transação da rede (ela tem UTXO/nonce/sequence),
    // assinar e transmitir. Resolve { txHash } SÓ após o broadcast ser aceito. A
    // capacidade, nesta superfície injetada, é a presença deste método; a lista
    // de redes com handler DE FATO viaja em paymentNetworks no handshake.
    signAndSendPayment: function (request) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      if (!request || typeof request !== 'object' || !Array.isArray(request.outputs)) {
        return Promise.reject(new WalletError('INVALID_PAYLOAD'));
      }
      log('SIGNATURE', 'signAndSendPayment()', String(request.network || '?'));
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'payment');
        send({
          type: 'VERUM_PAYMENT_REQUEST',
          id: id,
          network: request.network,
          payment: {
            outputs: request.outputs.map(function (o) {
              return {
                address: o && o.address,
                amount:  o && o.amount,
                asset:   o && o.asset,
              };
            }),
            memo: request.memo != null ? request.memo : null,
          },
          origin: window.location.origin,
        });
      }).catch(function (err) {
        // Recusa do usuário → padrão EIP-1193 (code 4001) que o portal detecta.
        // UNSUPPORTED/INSUFFICIENT_FUNDS/FAILED viajam na .message (casamento por
        // substring no portal), então só USER_REJECTED precisa desta normalização.
        if (err && err.code === 'USER_REJECTED') {
          var e = new Error('User rejected the payment request.');
          e.name = 'WalletError';
          e.code = 4001;
          throw e;
        }
        throw err;
      });
    },

    // ── Tron dApp (perna Tron do escrow Verum V2) ────────────────────────────
    // tronSignTypedData: assina TYPED DATA (TIP-712 — digest EIP-712 com a chave
    // Tron). Resolve { signature, address }. tronSendContractCall: contract call
    // genérico { contract, functionSelector, parameters:[{type,value}],
    // callValueSun?, feeLimitSun? } — a carteira codifica, verifica, assina e
    // transmite; resolve { txHash } só após o broadcast ser aceito.
    tronSignTypedData: function (typedData) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      if (!typedData || typeof typedData !== 'object' || !typedData.domain || !typedData.types || !typedData.message) {
        return Promise.reject(new WalletError('INVALID_PAYLOAD'));
      }
      log('SIGNATURE', 'tronSignTypedData()', String(typedData.primaryType || '?'));
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'tronSignTyped');
        send({
          type: 'VERUM_TRON_SIGN_TYPED_REQUEST',
          id: id,
          typedData: {
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
          },
          address: typeof typedData.address === 'string' ? typedData.address : null,
          origin: window.location.origin,
        });
      }).catch(function (err) {
        if (err && err.code === 'USER_REJECTED') {
          var e = new Error('User rejected the signature request.');
          e.name = 'WalletError';
          e.code = 4001;
          throw e;
        }
        throw err;
      });
    },
    tronSendContractCall: function (request) {
      if (!window.verum.connected) return Promise.reject(new WalletError('NOT_CONNECTED'));
      if (!request || typeof request !== 'object' || typeof request.contract !== 'string'
        || typeof request.functionSelector !== 'string' || !Array.isArray(request.parameters)) {
        return Promise.reject(new WalletError('INVALID_PAYLOAD'));
      }
      log('SIGNATURE', 'tronSendContractCall()', String(request.functionSelector));
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'tronCall');
        send({
          type: 'VERUM_TRON_CALL_REQUEST',
          id: id,
          call: {
            contract: request.contract,
            functionSelector: request.functionSelector,
            parameters: request.parameters.map(function (p) {
              return { type: p && p.type, value: p && String(p.value) };
            }),
            callValueSun: request.callValueSun != null ? String(request.callValueSun) : '0',
            feeLimitSun: request.feeLimitSun != null ? String(request.feeLimitSun) : null,
          },
          origin: window.location.origin,
        });
      }).catch(function (err) {
        if (err && err.code === 'USER_REJECTED') {
          var e = new Error('User rejected the transaction request.');
          e.name = 'WalletError';
          e.code = 4001;
          throw e;
        }
        throw err;
      });
    },

    // ── getAddresses (Protocolo de Endereços Multi-rede × Portal de Câmbio) ──
    // Pede à carteira a lista de endereços públicos do usuário por rede. Resolve
    // { addresses: [{ network, address }, ...] } — só as redes com endereço já
    // disponível (nunca inventa). É dado PÚBLICO; a prova de posse fica no
    // fluxo challenge/verify do backend. A capacidade, nesta superfície, é a
    // presença do método (typeof provider.getAddresses === 'function').
    getAddresses: function () {
      log('DETECTION', 'getAddresses()', 'origin=' + window.location.origin);
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'addresses');
        send({ type: 'VERUM_ADDRESSES_REQUEST', id: id, origin: window.location.origin });
      });
    },


    // ── getBalance (A-01: ponte multichain) ─────────────────────────────────
    // Lê o saldo de (chainKey, asset) na carteira. Resolve um objeto TIPADO:
    //   { ok:true, chainKey, asset, amountAtomic, decimals } ou
    //   { ok:false, chainKey, asset, error }  — o dApp DEVE checar result.ok e
    // nunca tratar erro como 0. Capacidade anunciada como 'multichainBridge'.
    getBalance: function (chainKey, asset) {
      log('DETECTION', 'getBalance()', chainKey + '/' + asset);
      return new Promise(function (resolve, reject) {
        var id = enqueue(resolve, reject, 'balance');
        send({ type: 'VERUM_BALANCE_REQUEST', id: id, chainKey: chainKey, asset: asset, origin: window.location.origin });
      });
    },


    // ── request (Compatibilidade Phantom/Wallet-Adapter standard) ───────────
    request: function (req) {
      log('ROBUST', 'request()', req.method);
      switch(req.method) {
        case 'connect': return window.verum.connect();
        case 'disconnect': return window.verum.disconnect();
        case 'signTransaction': return window.verum.signTransaction(req.params.transaction);
        case 'signAndSendTransaction': return window.verum.signAndSendTransaction(req.params.transaction, req.params.options);
        case 'signAllTransactions': return window.verum.signAllTransactions(req.params.transactions);
        case 'signMessage': return window.verum.signMessage(req.params.message);
        case 'signPersonalMessage': return window.verum.signPersonalMessage(req.params.chainKey, req.params.message, req.params.address);
        case 'transfer': return window.verum.transfer(req.params && req.params.intent ? req.params.intent : req.params);
        case 'multiTransfer': return window.verum.multiTransfer(req.params && req.params.intent ? req.params.intent : req.params);
        case 'signAndSendPayment': return window.verum.signAndSendPayment(req.params && req.params.request ? req.params.request : req.params);
        case 'tronSignTypedData': return window.verum.tronSignTypedData(req.params && req.params.typedData ? req.params.typedData : req.params);
        case 'tronSendContractCall': return window.verum.tronSendContractCall(req.params && req.params.request ? req.params.request : req.params);
        case 'getAddresses': return window.verum.getAddresses();
        case 'getBalance': return window.verum.getBalance(req.params && req.params.chainKey, req.params && req.params.asset);
        default: return Promise.reject(new WalletError('METHOD_NOT_SUPPORTED'));
      }
    },

    // ── Callback interno — chamado pelo app nativo via injectJavaScript ──────
    __cb: function (id, result, error) {
      if (result && result.publicKey && typeof result.publicKey === 'string') {
        window.verum.__setConnected(result.publicKey);
        result.publicKey = window.verum.publicKey; // Substitui pela versão objeto
      }
      settle(id, result, error);
    },

    // ── Atalho para conexão imediata (sem modal) quando já existe sessão ────
    __setConnected: function (pubKeyStr) {
      window.verum.connected   = true;
      window.verum.isConnected = true;
      window.verum.publicKey   = window.verum.__initPublicKey(pubKeyStr);
      log('DETECTION', '__setConnected', pubKeyStr);

      // Standard Events
      window.dispatchEvent(new CustomEvent('verum#connected', { detail: { publicKey: pubKeyStr } }));
      window.verum.emit('accountChanged', window.verum.publicKey);
      window.verum.emit('connect', window.verum.publicKey);

      // Compatibility with standard Wallet Adapters
      window.dispatchEvent(new CustomEvent('solana#connected', { detail: { publicKey: pubKeyStr } }));
    },
  };

// Inicializa publicKey se fornecido via opts
if (false) {
  window.verum.__setConnected(null);
}

// ── Alias window.solana (compatibilidade Phantom / Wallet Adapter) ─────────
if (!window.solana) {
  window.solana = window.verum;
  log('DETECTION', 'window.solana → alias de window.verum');
}

// ── Wallet Standard Registration (para dApps que usam @solana/wallet-adapter) ──
(function registerWalletStandard() {
  var walletObj = {
    version: '1.0.0',
    name: 'Verum Wallet',
    icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIHJ4PSIyNCIgZmlsbD0iIzBBMEEwQSIvPjx0ZXh0IHg9IjY0IiB5PSI4MCIgZm9udC1zaXplPSI2NCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI0M5QTg0QyI+VjwvdGV4dD48L3N2Zz4=',
    chains: ['solana:mainnet', 'solana:devnet'],
    accounts: [],
    _events: {},
    get features() {
      var self = this;
      return {
        'standard:connect': {
          version: '1.0.0',
          connect: function(input) {
            return window.verum.connect(input).then(function(res) {
              var pk = res && res.publicKey ? res.publicKey.toString() : '';
              if (pk) {
                self.accounts = [{ address: pk, publicKey: pk, chains: ['solana:mainnet'], features: ['standard:connect','standard:disconnect','solana:signTransaction','solana:signAndSendTransaction','solana:signMessage'] }];
                self._emitChange();
              }
              return { accounts: self.accounts };
            });
          }
        },
        'standard:disconnect': {
          version: '1.0.0',
          disconnect: function() {
            return window.verum.disconnect().then(function() {
              self.accounts = [];
              self._emitChange();
            });
          }
        },
        'standard:events': {
          version: '1.0.0',
          on: function(event, listener) {
            if (!self._events[event]) self._events[event] = [];
            self._events[event].push(listener);
            return function() {
              self._events[event] = (self._events[event] || []).filter(function(l) { return l !== listener; });
            };
          }
        },
        'solana:signTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          signTransaction: function() {
            var args = Array.prototype.slice.call(arguments);
            return Promise.all(args.map(function(input) {
              return window.verum.signTransaction(input.transaction).then(function(signed) {
                return { signedTransaction: signed };
              });
            }));
          }
        },
        'solana:signAndSendTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          signAndSendTransaction: function() {
            var args = Array.prototype.slice.call(arguments);
            return Promise.all(args.map(function(input) {
              return window.verum.signAndSendTransaction(input.transaction, input.options).then(function(res) {
                var sig = res && res.signature ? res.signature : res;
                // Wallet Standard exige a assinatura como bytes; a ponte devolve base58.
                var bytes = typeof sig === 'string' ? window.verum.__b58decode(sig) : sig;
                return { signature: bytes };
              });
            }));
          }
        },
        'solana:signMessage': {
          version: '1.0.0',
          signMessage: function() {
            var args = Array.prototype.slice.call(arguments);
            return Promise.all(args.map(function(input) {
              return window.verum.signMessage(input.message).then(function(sig) {
                return { signedMessage: input.message, signature: sig instanceof Uint8Array ? sig : sig.signature };
              });
            }));
          }
        }
      };
    },
    _emitChange: function() {
      var listeners = this._events['change'] || [];
      var accts = this.accounts;
      listeners.forEach(function(cb) { try { cb({ accounts: accts }); } catch(e) {} });
    }
  };

  // Registra via navigator.wallets.register() se disponível (API legada)
  if (navigator.wallets && typeof navigator.wallets.register === 'function') {
    navigator.wallets.register(walletObj);
    log('DETECTION', 'Wallet Standard registrado via navigator.wallets');
  }

  // Callback no formato exigido pelo Wallet Standard: o app entrega a API
  // { register } e a carteira chama register(walletObj). Antes o detail era
  // um objeto { register: fn }, então o app fazia detail({register}) num objeto
  // não-chamável → registro falhava silenciosamente e a Verum não aparecia na
  // lista de carteiras de dApps que usam @solana/wallet-adapter.
  function registerCallback(api) {
    if (api && typeof api.register === 'function') {
      try {
        api.register(walletObj);
        log('DETECTION', 'Wallet Standard registrado');
      } catch (e) {}
    }
  }

  // Anuncia para apps que já estão ouvindo. detail DEVE ser o próprio callback.
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', {
      detail: registerCallback,
    }));
  } catch (e) {}

  // Apps que inicializam depois disparam app-ready com detail = a API { register }.
  window.addEventListener('wallet-standard:app-ready', function(e) {
    registerCallback(e && e.detail);
  });
})();

log('DETECTION', 'Provider pronto', {
  network:    NETWORK,
  isWebView:  _isWebView,
  isIframe:   _isIframe,
  publicKey:  window.verum.publicKey,
  connected:  window.verum.connected
});

  // ── window.ethereum (EIP-1193) no IFRAME do dapp-browser WEB ──────────────
  // No app NATIVO a carteira injeta o provider EVM completo; no dapp-browser
  // WEB (verumcrypto.com com o OTC em iframe cross-origin) o pai NÃO consegue
  // injetar — e sem ele approve/signV2/createTradeV2 morriam com "Provider EVM
  // não injetado". O dispatcher da carteira JÁ trata as mensagens VERUM_ETH_*
  // vindas do iframe (accounts/personal_sign/typedData/sendTx/rpc) — esta
  // fachada fala exatamente esse protocolo. ADITIVO: só no iframe e só quando
  // nenhum provider Verum existe (nativo/extensão mantêm os caminhos atuais).
  (function () {
    if (!_isIframe || _isWebView || _isExtension) return;
    if (window.ethereum && window.ethereum.isVerum) return;
    var _ethCbs = {}; var _ethSeq = 0;
    var ethState = { accounts: [], chainId: null };
    function ethBridge(type, extra) {
      return new Promise(function (resolve, reject) {
        var id = 'eth_' + (++_ethSeq) + '_' + Date.now();
        var th = setTimeout(function () { if (_ethCbs[id]) { delete _ethCbs[id]; reject(rpcErr(-32603, 'Timeout aguardando a Verum Wallet (' + type + ')')); } }, 120000);
        _ethCbs[id] = { resolve: resolve, reject: reject, t: th };
        var msg = { type: type, id: id, origin: window.location.origin };
        for (var k in extra) msg[k] = extra[k];
        window.parent.postMessage(msg, '*');
        log('SIGNATURE', 'eth bridge → ' + type, id);
      });
    }
    function rpcErr(code, message) { var e = new Error(message); e.code = code; return e; }
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object' || !d.id) return;
      if (d.type === 'VERUM_ETH_RESPONSE') {
        var cb = _ethCbs[d.id]; if (!cb) return; delete _ethCbs[d.id]; clearTimeout(cb.t);
        if (d.error) cb.reject(rpcErr(d.error.code != null ? d.error.code : -32603, d.error.message || 'Erro na Verum Wallet'));
        else cb.resolve(d.result);
      } else if (d.type === 'VERUM_ETH_EVENT') {
        if (Array.isArray(d.accounts)) ethState.accounts = d.accounts;
        if (d.chainId) ethState.chainId = d.chainId;
      }
    });
    var isAddr = function (v) { return typeof v === 'string' && v.length === 42 && v.indexOf('0x') === 0; };
    var ethProvider = {
      isVerum: true,
      request: function (args) {
        var method = (args && args.method) || '';
        var params = (args && args.params) || [];
        switch (method) {
          case 'eth_requestAccounts':
            if (ethState.accounts.length) return Promise.resolve(ethState.accounts.slice());
            return ethBridge('VERUM_ETH_ACCOUNTS_REQUEST', {}).then(function (accts) {
              if (Array.isArray(accts) && accts.length) ethState.accounts = accts.slice();
              return Array.isArray(accts) ? accts.slice() : accts;
            });
          case 'eth_accounts': return Promise.resolve(ethState.accounts.slice());
          case 'eth_chainId': return ethState.chainId ? Promise.resolve(ethState.chainId) : ethBridge('VERUM_ETH_RPC_REQUEST', { method: 'eth_chainId', params: [] });
          case 'personal_sign': {
            var m0 = params[0], m1 = params[1];
            var msgData = isAddr(m0) ? m1 : m0; var addr = (msgData === m0) ? m1 : m0;
            if (!msgData) return Promise.reject(rpcErr(-32602, 'personal_sign: mensagem ausente'));
            return ethBridge('VERUM_ETH_PERSONAL_SIGN_REQUEST', { message: msgData, address: addr });
          }
          case 'eth_signTypedData_v3':
          case 'eth_signTypedData_v4': {
            var a0 = params[0], a1 = params[1];
            var addr712 = isAddr(a0) ? a0 : (isAddr(a1) ? a1 : a0);
            var typed = (addr712 === a0) ? a1 : a0;
            if (!typed) return Promise.reject(rpcErr(-32602, 'signTypedData: payload ausente'));
            return ethBridge('VERUM_ETH_SIGN_TYPED_DATA_REQUEST', { address: addr712, typedData: typeof typed === 'string' ? typed : JSON.stringify(typed) });
          }
          case 'eth_sendTransaction': {
            var tx = params[0];
            if (!tx || typeof tx !== 'object') return Promise.reject(rpcErr(-32602, 'transação ausente'));
            return ethBridge('VERUM_ETH_SEND_TX_REQUEST', { tx: tx });
          }
          case 'wallet_switchEthereumChain': {
            var target = params[0] && params[0].chainId;
            if (!target) return Promise.reject(rpcErr(-32602, 'chainId ausente'));
            return ethBridge('VERUM_ETH_SWITCH_CHAIN_REQUEST', { chainId: target });
          }
          case 'eth_sign': return Promise.reject(rpcErr(4200, 'eth_sign é inseguro — use personal_sign.'));
          default:
            // Leitura pura (receipt, estimate, call, blockNumber…) — relay RPC da carteira.
            return ethBridge('VERUM_ETH_RPC_REQUEST', { method: method, params: params });
        }
      },
      on: function () { return ethProvider; }, removeListener: function () { return ethProvider; },
    };
    window.ethereum = ethProvider;
    // EIP-6963 — o findVerumEthProvider do dashboard identifica por rdns/isVerum.
    var ethInfo = Object.freeze({ uuid: 'a8f2b7e4-verum-0000-0000-eip6963shim1', name: 'Verum Wallet', icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230A0A0A'/%3E%3Ctext x='16' y='23' font-family='serif' font-size='20' font-weight='bold' fill='%23C9A84C' text-anchor='middle'%3EV%3C/text%3E%3C/svg%3E", rdns: 'com.verumcrypto.wallet' });
    function ethAnnounce() { try { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: ethInfo, provider: ethProvider }) })); } catch (e2) {} }
    window.addEventListener('eip6963:requestProvider', ethAnnounce);
    ethAnnounce();
    log('DETECTION', 'window.ethereum (fachada iframe) injetado');
  })();

  window.dispatchEvent(new Event('verum#initialized'));
  document.dispatchEvent(new Event('verum#initialized'));
})();
true;

})();
