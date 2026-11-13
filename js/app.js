(function(){
  "use strict";
  var CHUNK=64*1024, HIGH=4*1024*1024, STREAM_THRESHOLD=150*1024*1024;
  var ENDPOINT = window.BEAM_RELAY_ENDPOINT || "/api/turn";
  var ACCESS_TOKEN = window.BEAM_ACCESS_TOKEN || "";

  // ---- relay credentials (fetched from the serverless function) ----
  var RELAY=[], relayExpiry=0, relayState="loading", relayErr="";
  function haveRelay(){ return RELAY.some(function(s){return /^turns?:/.test(String(s.urls));}); }
  function fetchRelay(){
    var opts={cache:"no-store"};
    if(ACCESS_TOKEN) opts.headers={"X-Beam-Token":ACCESS_TOKEN};
    return fetch(ENDPOINT,opts).then(function(r){
      if(!r.ok) throw new Error("HTTP "+r.status);
      return r.json();
    }).then(function(data){
      RELAY = Array.isArray(data) ? data : ((data&&data.iceServers)||[]);
      var ttl = (data&&data.ttl)||3600;
      relayExpiry = Date.now() + ttl*1000;
      relayState = haveRelay() ? "ok" : "empty";
      paintNet();
    }).catch(function(e){
      RELAY=[]; relayState="error"; relayErr=e.message; paintNet();
    });
  }
  function ensureFreshRelay(){ return (Date.now() > relayExpiry-60000) ? fetchRelay() : Promise.resolve(); }

  function baseStun(){ return [{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun.cloudflare.com:3478"}]; }
  function allServers(){ return baseStun().concat(RELAY); }

  // ---- routing mode ----
  function getMode(){ try{var m=localStorage.getItem("beam.mode");if(m)return m;}catch(e){} return "auto"; }
  function setMode(m){ try{localStorage.setItem("beam.mode",m);}catch(e){} }
  var detected="unknown"; // open | restricted | unknown
  function effectivePolicyRelay(){
    var m=getMode();
    if(m==="relay") return true;
    if(m==="direct") return false;
    return (detected==="restricted" && haveRelay());
  }
  function pcConfig(){
    var m=getMode();
    var servers = (m==="direct") ? baseStun() : allServers();
    var cfg={iceServers:servers};
    if(effectivePolicyRelay()) cfg.iceTransportPolicy="relay";
    return cfg;
  }

  var $=function(id){return document.getElementById(id);};
  var stage=$("stage"),statusEl=$("status");
  var netbadge=$("netbadge"),netbadgetxt=$("netbadgetxt"),netTag=$("netTag"),netSummary=$("netSummary");
  var myCodeEl=$("myCode"),qrEl=$("qr"),peerInput=$("peerInput"),connectBtn=$("connectBtn");
  var nodePeer=$("nodePeer"),peerRole=$("peerRole"),selfRole=$("selfRole"),pairing=$("pairing");
  var transfer=$("transfer"),drop=$("drop"),filein=$("filein"),xfers=$("xfers");
  var promptEl=$("prompt"),promptText=$("promptText"),acceptBtn=$("accept"),declineBtn=$("decline");
  var modeSeg=$("modeSeg");
  var shareBtn=$("shareBtn"),mazeStatus=$("mazeStatus");
  var opticalBeacon=$("opticalBeacon"),obCanvas=$("obCanvas"),obName=$("obName"),obCount=$("obCount"),obFallback=$("obFallback");
  var opticalScan=$("opticalScan"),osVideo=$("osVideo"),osCanvas=$("osCanvas"),osStatus=$("osStatus"),osName=$("osName"),osBar=$("osBar"),osFallback=$("osFallback");
  var modeStatus=$("modeStatus"),modeStatusWord=$("modeStatusWord"),modeSwitchBtn=$("modeSwitchBtn");

  var peer=null,conn=null,myId=null,pendingConn=null,sendQueue=[],sending=false,currentRecv=null,connectTimeoutId=null;
  var activeSends={}, activeRecvs={};
  var peerIsMobile=false; // learned from the peer right after linking — drives the QR-optical add-on below
  var transferMode=null; // null (undecided) | "optical" | "web" — the user's explicit pick for sending to this phone
  var activeOpticalSends={}, activeOpticalRecvs={}, opticalFallbackRows={};
  function shuffledIndices(n){
    var a=[];for(var i=0;i<n;i++)a.push(i);
    for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}
    return a;
  }
  function genCode(){ return shuffledIndices(MAZE_N).map(function(i){return String(i+1);}).join(""); }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g,function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];
    });
  }

  // ---- CRC32 (built-in only, no dependency) — integrity check across the transfer ----
  var CRC_TABLE=(function(){
    var t=new Uint32Array(256);
    for(var n=0;n<256;n++){
      var c=n;
      for(var k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);
      t[n]=c;
    }
    return t;
  })();
  function crc32Update(state,buf){
    var view=new Uint8Array(buf);
    for(var i=0;i<view.length;i++) state=CRC_TABLE[(state^view[i])&0xFF]^(state>>>8);
    return state;
  }
  function crc32Whole(bytes){ return (crc32Update(0xFFFFFFFF,bytes)^0xFFFFFFFF)>>>0; }

  function xferKey(file){ return file.name+"|"+file.size; }

  // ---- Optical transfer: LT fountain codec + self-describing QR frame format ----
  // (PC/notebook -> phone add-on. Ported inline from the reference implementation
  // in New function/ — see New function/README.md for the design rationale.)
  function opMakeRng(seed){
    var a=seed>>>0;
    return function(){
      a=(a+0x6d2b79f5)>>>0; var t=a;
      t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61);
      return ((t^(t>>>14))>>>0)/4294967296;
    };
  }
  function opBuildCdf(K){
    var rho=new Float64Array(K+1); rho[1]=1/K;
    for(var d=2;d<=K;d++) rho[d]=1/(d*(d-1));
    var tau=new Float64Array(K+1);
    var S=Math.max(2,Math.round(Math.sqrt(K))), d0=Math.max(1,Math.floor(K/S));
    if(d0>=1&&d0<=K) tau[d0]=0.10;
    var sum=0, mu=new Float64Array(K+1);
    for(d=1;d<=K;d++){ mu[d]=rho[d]+tau[d]; sum+=mu[d]; }
    var cdf=new Float64Array(K+1), acc=0;
    for(d=1;d<=K;d++){ acc+=mu[d]/sum; cdf[d]=acc; }
    cdf[K]=1;
    return cdf;
  }
  function opDegree(cdf,u,K){ for(var d=1;d<=K;d++) if(u<=cdf[d]) return d; return K; }
  function opBlocksForSeq(seq,K,cdf){
    var rng=opMakeRng((seq*2654435761)>>>0);
    var d=opDegree(cdf,rng(),K);
    var picked=new Set(), guard=0;
    while(picked.size<d && guard<d*8){ picked.add(Math.floor(rng()*K)%K); guard++; }
    var i=0;
    while(picked.size<d){ picked.add(i%K); i++; }
    return Array.from(picked).sort(function(a,b){return a-b;});
  }
  function OpticalLTEncoder(data,blockSize){
    this.blockSize=blockSize;
    this.K=Math.max(1,Math.ceil(data.length/blockSize));
    this.blocks=new Array(this.K);
    for(var i=0;i<this.K;i++){
      var b=new Uint8Array(blockSize);
      b.set(data.subarray(i*blockSize,Math.min((i+1)*blockSize,data.length)));
      this.blocks[i]=b;
    }
    this.cdf=opBuildCdf(this.K);
  }
  OpticalLTEncoder.prototype.symbol=function(seq){
    var idx=opBlocksForSeq(seq,this.K,this.cdf);
    var out=new Uint8Array(this.blockSize);
    for(var j=0;j<idx.length;j++){
      var b=this.blocks[idx[j]];
      for(var k=0;k<this.blockSize;k++) out[k]^=b[k];
    }
    return out;
  };
  function OpticalLTDecoder(K,blockSize,fileLength){
    this.K=K; this.blockSize=blockSize; this.fileLength=fileLength;
    this.cdf=opBuildCdf(K);
    this.solved=new Array(K).fill(null);
    this.solvedCount=0; this.symbols=[]; this.seen=new Set();
  }
  Object.defineProperty(OpticalLTDecoder.prototype,"done",{get:function(){return this.solvedCount===this.K;}});
  Object.defineProperty(OpticalLTDecoder.prototype,"progress",{get:function(){return this.solvedCount/this.K;}});
  OpticalLTDecoder.prototype.addSymbol=function(seq,payload){
    if(this.seen.has(seq)||this.done) return this.done;
    this.seen.add(seq);
    var idx=opBlocksForSeq(seq,this.K,this.cdf);
    var data=payload.slice(0,this.blockSize);
    var rem=new Set();
    for(var j=0;j<idx.length;j++){
      var i=idx[j];
      if(this.solved[i]){ var s=this.solved[i]; for(var k=0;k<this.blockSize;k++) data[k]^=s[k]; }
      else rem.add(i);
    }
    this._process({rem:rem,data:data});
    return this.done;
  };
  OpticalLTDecoder.prototype._process=function(sym){
    var q=[sym];
    while(q.length){
      var s=q.pop();
      if(s.rem.size===0) continue;
      if(s.rem.size>1){ this.symbols.push(s); continue; }
      var i=s.rem.values().next().value;
      if(this.solved[i]) continue;
      this.solved[i]=s.data; this.solvedCount++;
      var still=[];
      for(var ti=0;ti<this.symbols.length;ti++){
        var t=this.symbols[ti];
        if(t.rem.has(i)){
          for(var k=0;k<this.blockSize;k++) t.data[k]^=s.data[k];
          t.rem.delete(i);
          if(t.rem.size===1) q.push(t); else if(t.rem.size>1) still.push(t);
        } else still.push(t);
      }
      this.symbols=still;
    }
  };
  OpticalLTDecoder.prototype.assemble=function(){
    var out=new Uint8Array(this.K*this.blockSize);
    for(var i=0;i<this.K;i++) out.set(this.solved[i],i*this.blockSize);
    return out.subarray(0,this.fileLength);
  };

  // Self-describing per-frame wire format (little-endian):
  //   'B','M', version, flags(0), sessionId(4), seq(4), K(4), blockSize(2),
  //   fileLength(4), crc32(4), nameLen(1), name, payload
  var opTE=new TextEncoder(), opTD=new TextDecoder();
  function packOpticalFrame(meta,seq,payload){
    var name=opTE.encode(meta.name||"");
    var buf=new Uint8Array(27+name.length+payload.length);
    var dv=new DataView(buf.buffer);
    buf[0]=0x42; buf[1]=0x4D; buf[2]=1; buf[3]=0;
    dv.setUint32(4,meta.sessionId>>>0,true);
    dv.setUint32(8,seq>>>0,true);
    dv.setUint32(12,meta.K>>>0,true);
    dv.setUint16(16,meta.blockSize,true);
    dv.setUint32(18,meta.fileLength>>>0,true);
    dv.setUint32(22,meta.crc>>>0,true);
    buf[26]=name.length;
    buf.set(name,27);
    buf.set(payload,27+name.length);
    return buf;
  }
  function parseOpticalFrame(buf){
    if(!buf||buf.length<27||buf[0]!==0x42||buf[1]!==0x4D||buf[2]!==1) return null;
    var dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
    var nameLen=buf[26];
    if(buf.length<27+nameLen) return null;
    var name=opTD.decode(buf.subarray(27,27+nameLen));
    var blockSize=dv.getUint16(16,true);
    var payload=buf.subarray(27+nameLen);
    if(payload.length<blockSize) return null;
    return {
      meta:{sessionId:dv.getUint32(4,true),K:dv.getUint32(12,true),blockSize:blockSize,
             fileLength:dv.getUint32(18,true),crc:dv.getUint32(22,true),name:name},
      seq:dv.getUint32(8,true),
      payload:payload.subarray(0,blockSize)
    };
  }
  var opRandU32=function(){ return (Math.floor(Math.random()*0xFFFFFFFF))>>>0; };
  var zxingReadBarcodesPromise=null;
  function getReadBarcodes(){
    if(!zxingReadBarcodesPromise){
      // Self-hosted zxing-wasm 3.1.2 (vendor/zxing-wasm): same-origin, so CSP needs no CDN for it,
      // the service worker can keep it for offline use, and nothing is fetched from a third party at runtime.
      zxingReadBarcodesPromise=import("/vendor/zxing-wasm/es/reader/index.js")
        .then(function(m){
          m.setZXingModuleOverrides({
            locateFile:function(path,prefix){ return path.slice(-5)===".wasm"?"/vendor/zxing-wasm/reader/zxing_reader.wasm":prefix+path; }
          });
          return m.readBarcodes;
        });
    }
    return zxingReadBarcodesPromise;
  }

  function markXferState(el,text){
    if(!el) return;
    el.classList.add("paused");
    var p=el.querySelector(".pct"); if(p) p.textContent=text;
  }
  function clearXferState(el){ if(el) el.classList.remove("paused"); }

  // Event-driven backpressure with a safety-timeout fallback in case bufferedamountlow
  // doesn't fire in some environment.
  function waitForDrain(dch,cb){
    var fired=false;
    function onLow(){ if(fired)return; fired=true; try{dch.removeEventListener("bufferedamountlow",onLow);}catch(e){} cb(); }
    try{ dch.addEventListener("bufferedamountlow",onLow); }catch(e){}
    setTimeout(onLow,1000);
  }

  function clearConnectTimeout(){ if(connectTimeoutId){clearTimeout(connectTimeoutId);connectTimeoutId=null;} }
  function armConnectTimeout(ms,msg){
    clearConnectTimeout();
    connectTimeoutId=setTimeout(function(){
      setStatus(msg||"Couldn't establish a connection — check the code and your network, then try again.");
      pairing.classList.remove("hidden");
      mazeReportFailure("Still not connecting — check the order and try again.");
    },ms||20000);
  }

  function relayStateText(){
    if(relayState==="loading") return "loading…";
    if(relayState==="ok") return "active (auto-renewing, short-lived)";
    if(relayState==="empty") return "<b style='color:var(--warn)'>endpoint returned no relay</b> — check function env vars";
    return "<b style='color:var(--danger)'>endpoint error</b> ("+relayErr+") — check the /api/turn function";
  }
  function paintNet(){
    var m=getMode();
    netbadge.className="badge "+(detected==="restricted"?"restricted":detected==="open"?"open":"checking");
    netbadgetxt.textContent = detected==="restricted" ? "corporate — via relay"
      : detected==="open" ? "open — direct" : "checking network…";
    netTag.textContent = detected==="restricted"?"restricted":detected==="open"?"open":"checking…";
    netTag.className="tag "+(detected==="restricted"?"restricted":detected==="open"?"open":"");
    var route = m==="relay"?"always via relay":m==="direct"?"direct only (relay off)":
      (effectivePolicyRelay()?"auto → using relay":"auto → direct, relay on standby");
    netSummary.innerHTML =
      "<span class='k'>Network:</span> "+(detected==="unknown"?"detecting…":detected)+
      "<br><span class='k'>Relay:</span> "+relayStateText()+
      "<br><span class='k'>Routing:</span> "+route;
    Array.prototype.forEach.call(modeSeg.children,function(b){b.classList.toggle("on",b.getAttribute("data-mode")===m);});
  }

  // Codes on screen, typed, or in ?j= links are bare; only the PeerJS server
  // sees them with the deployment namespace prefix.
  var PEER_NS=(window.BEAM_PEER_NAMESPACE||"beam")+"-";
  function peerIdFor(code){ return PEER_NS+code; }
  function codeOf(peerId){ peerId=String(peerId||""); return peerId.indexOf(PEER_NS)===0?peerId.slice(PEER_NS.length):peerId; }
  // What to call a peer on screen: short codes as-is, long private codes abbreviated.
  function labelOf(peerId){ var c=codeOf(peerId); return c.length>6?c.slice(0,4)+"…":c; }
  var MAX_ID_TRIES=12,shortTries=0;

  // Two identities per device:
  //  - myLongId: 16 random chars (80 bits), only ever shown inside the QR code / private link. Anyone
  //    who dials it must have seen this screen, so those links are accepted without a prompt.
  //  - myId: the 4-block short code (only 24 exist, so guessable). Registered on demand, on a separate
  //    Peer, only while "Can't scan?" is open — and links through it still need Accept.
  var LONG_ALPHA="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O/1/I
  function genLongCode(){
    var b=new Uint8Array(16),s=""; crypto.getRandomValues(b);
    for(var i=0;i<b.length;i++) s+=LONG_ALPHA[b[i]&31];
    return s;
  }
  var myLongId=null,shortPeer=null,joinPending=false;

  function handleIncoming(c,trusted){
    if(c.peer.indexOf(PEER_NS)!==0){try{c.close();}catch(e){}return;} // not from this deployment
    if(conn&&conn.open){c.on("open",function(){c.send({__ctrl:true,t:"busy"});setTimeout(function(){c.close();},300);});return;}
    if(trusted){ armConnectTimeout(); ensureFreshRelay().then(function(){ applyPolicy(); wireConn(c); }); return; }
    pendingConn=c;promptText.textContent="Device “"+labelOf(c.peer)+"” wants to connect.";promptEl.classList.add("show");
  }

  function ensureShortPeer(){
    if(shortPeer) return;
    myId=genCode();
    myCodeEl.textContent=myId; renderMazeShow(myId);
    var p=shortPeer=new Peer(peerIdFor(myId),{debug:1, config:pcConfig()});
    p.on("open",function(){shortTries=0;});
    p.on("connection",function(c){ handleIncoming(c,false); });
    p.on("error",function(err){
      if(!(err&&err.type==="unavailable-id")) return;
      // Code taken (only 24 exist): pick another, backing off instead of spinning forever.
      p.destroy(); if(shortPeer===p) shortPeer=null;
      if(++shortTries>=MAX_ID_TRIES){
        shortTries=0; myCodeEl.textContent="busy";
        setTimeout(ensureShortPeer,5000);
      } else setTimeout(ensureShortPeer,Math.min(150*shortTries,1000));
    });
    p.on("disconnected",function(){try{p.reconnect();}catch(e){}});
  }
  $("shortFallback").addEventListener("toggle",function(){ if(this.open) ensureShortPeer(); });

  function init(){
    myLongId=genLongCode();
    renderQR(myLongId); // optimistic: show the QR before the server round-trip
    peer = new Peer(peerIdFor(myLongId),{debug:1, config:pcConfig()});
    peer.on("open",function(){
      if(conn||joinPending) return; // a link is already under way: keep its status
      setStatus(mazeRoleMobile ? "Ready. Tap Scan QR code and point at the computer's screen." : "Ready. Scan this code with your phone to link.");
    });
    peer.on("connection",function(c){ handleIncoming(c,true); });
    peer.on("error",function(err){
      if(err&&err.type==="unavailable-id"){ peer.destroy(); setTimeout(init,300); return; } // 80-bit collision: practically never
      if(err&&err.type==="peer-unavailable"){
        setStatus("No device found with that code. Check it and try again.");
        mazeReportFailure("Not quite — watch the other screen and try again.");
        return;
      }
      setStatus("Connection issue: "+(err&&err.type?err.type:"unknown")+". You can retry.");
      mazeReportFailure("Connection issue — try again.");
    });
    peer.on("disconnected",function(){try{peer.reconnect();}catch(e){}});
  }
  function applyPolicy(){ if(peer) peer.options.config = pcConfig(); if(shortPeer) shortPeer.options.config = pcConfig(); paintNet(); }

  function renderQR(id){
    qrEl.innerHTML="";
    try{ var url=location.origin+location.pathname+"?j="+id;
      new QRCode(qrEl,{text:url,width:208,height:208,colorDark:"#000000",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.M});
    }catch(e){qrEl.style.display="none";}
  }

  connectBtn.addEventListener("click",function(){
    var code=(peerInput.value||"").trim().toUpperCase();
    if(code.length<4){peerInput.focus();return;}
    if(code===myId||code===myLongId){setStatus("That's your own code — use the other device's code.");return;}
    setStatus("Linking to "+escapeHtml(code.length>6?code.slice(0,4)+"…":code)+"…");
    armConnectTimeout();
    ensureFreshRelay().then(function(){ applyPolicy(); wireConn(peer.connect(peerIdFor(code),{reliable:true}),true); });
  });
  peerInput.addEventListener("keydown",function(e){if(e.key==="Enter")connectBtn.click();});
  acceptBtn.addEventListener("click",function(){promptEl.classList.remove("show");if(pendingConn){var c=pendingConn;pendingConn=null;armConnectTimeout();ensureFreshRelay().then(function(){applyPolicy();wireConn(c);});}});
  declineBtn.addEventListener("click",function(){promptEl.classList.remove("show");if(pendingConn){try{pendingConn.close();}catch(e){}pendingConn=null;}});

  // PeerJS answers an incoming offer by itself, so the dialing side's channel opens
  // before the other person has tapped Accept. Until the acceptor speaks (its
  // onConnected sends role + roleRequest), anything we send lands on a connection
  // nobody listens to — so an outgoing link only counts as linked on its first message.
  function wireConn(c,outgoing){
    conn=c;
    c.__awaitAccept=!!outgoing;
    c.on("open",function(){
      attachIceMonitor(c);
      if(!c.__awaitAccept){ onConnected(); return; }
      // Long (QR) codes are accepted automatically on the other side; short codes need a tap.
      setStatus(codeOf(c.peer).length>6 ? "Connecting securely…" : "Waiting for <b>"+escapeHtml(labelOf(c.peer))+"</b> to tap Accept…");
      armConnectTimeout(60000,"No answer — the other device didn't accept. Try again.");
    });
    c.on("data",onData);
    c.on("close",onClosed);
    c.on("error",function(){setStatus("The link dropped. Re-enter the code to reconnect.");});
    if(c.open){ onConnected(); attachIceMonitor(c); }
  }
  // Best-effort ICE restart on a transient network blip, so a brief NAT rebind or
  // wifi hiccup doesn't require the user to manually re-enter the code. Uses
  // addEventListener (not the on-property) so PeerJS's own internal ICE handler,
  // which it needs to detect real disconnects/closes, isn't clobbered.
  function attachIceMonitor(c){
    var pc=c.peerConnection||c._pc;
    if(!pc||pc.__beamMonitored) return;
    pc.__beamMonitored=true;
    var restarting=false;
    function tryRestart(){
      if(restarting) return; restarting=true;
      try{ pc.restartIce(); }catch(e){}
      setTimeout(function(){restarting=false;},8000);
    }
    pc.addEventListener("iceconnectionstatechange",function(){
      var st=pc.iceConnectionState;
      if(st==="disconnected") setTimeout(function(){ if(pc.iceConnectionState==="disconnected") tryRestart(); },2000);
      else if(st==="failed") tryRestart();
    });
  }
  // Short code derived from both ends' DTLS certificate fingerprints. Both devices compute it
  // from the same pair, so the screens match; anyone relaying the link through themselves
  // (e.g. a hostile signaling server, or a hijacked code) ends up with different fingerprints
  // on each side, and the codes differ.
  var verifyEl=null;
  function hideVerifyCode(){ if(verifyEl) verifyEl.classList.add("hidden"); }
  function showVerifyCode(c){
    var pc=c.peerConnection||c._pc;
    if(!pc||!pc.localDescription||!pc.remoteDescription||!(window.crypto&&crypto.subtle)) return;
    function fp(sdp){ var m=/a=fingerprint:\S+ ([0-9A-Fa-f:]+)/.exec(sdp||""); return m?m[1].toUpperCase():""; }
    var a=fp(pc.localDescription.sdp),b=fp(pc.remoteDescription.sdp);
    if(!a||!b) return;
    var pair=[a,b].sort().join("|");
    crypto.subtle.digest("SHA-256",new TextEncoder().encode("beam-verify|"+pair)).then(function(h){
      if(conn!==c) return;
      var v=new DataView(h).getUint32(0)%1000000,s=String(v);
      while(s.length<6) s="0"+s;
      if(!verifyEl){
        verifyEl=document.createElement("div");
        verifyEl.id="verifyCode";
        verifyEl.className="verify";
        statusEl.parentNode.insertBefore(verifyEl,statusEl.nextSibling);
      }
      verifyEl.innerHTML='<span>Both screens should show</span><b></b>';
      verifyEl.querySelector("b").textContent=s.slice(0,3)+" "+s.slice(3);
      verifyEl.classList.remove("hidden");
    });
  }
  function onConnected(){
    clearConnectTimeout();
    stopPairScan();
    showVerifyCode(conn);
    mazePending=false;
    stage.classList.add("connected");nodePeer.classList.add("live");
    peerRole.textContent="“"+labelOf(conn.peer)+"”";selfRole.textContent="you";
    setStatus("Linked to <b>"+escapeHtml(labelOf(conn.peer))+"</b> — send files freely.");
    pairing.classList.add("hidden");transfer.classList.remove("hidden");drop.classList.remove("disabled");
    transferMode=null;
    applyRole();
    maybeShowModePrompt();
    // Announce our own role, AND ask the peer for theirs. The ask matters because
    // the accepting side only attaches its message listener once the human
    // notices and taps Accept — which can take several seconds. By then the
    // *other* side's connection may already be open and have fired its one-shot
    // role announcement into a connection nobody was listening on yet, losing it
    // for good. A blind delayed resend can't fix that (any fixed delay can lose
    // the race to a slower human); asking works regardless of timing, because
    // by the time we send the request our OWN listener is definitely already
    // attached (that's what just triggered this very function), so the peer's
    // reply — sent the moment its listener sees the request — is guaranteed to
    // land on an already-listening connection.
    try{ conn.send({__ctrl:true,t:"role",mobile:mazeRoleMobile}); }catch(e){}
    try{ conn.send({__ctrl:true,t:"roleRequest"}); }catch(e){}
    Object.keys(activeSends).forEach(function(xferId){
      var entry=activeSends[xferId];
      if(entry) conn.send({__ctrl:true,t:"meta",xferId:xferId,name:entry.file.name,size:entry.file.size,mime:entry.file.type||"application/octet-stream",resume:true});
    });
  }
  function onClosed(){
    if(conn&&conn.__awaitAccept){ // closed before it was ever accepted: declined (or busy)
      clearConnectTimeout(); conn=null; pairing.classList.remove("hidden");
      if(!/already linked/.test(statusEl.textContent)) setStatus("The other device declined the link.");
      mazeReportFailure("The other device declined — try again.");
      return;
    }
    hideVerifyCode();
    stage.classList.remove("connected");nodePeer.classList.remove("live");
    peerRole.textContent="disconnected";selfRole.textContent="";
    var hasPending = Object.keys(activeSends).length>0 || Object.keys(activeRecvs).length>0;
    Object.keys(activeSends).forEach(function(id){ markXferState(activeSends[id].el,"connection lost - will resume"); });
    Object.keys(activeRecvs).forEach(function(id){ markXferState(activeRecvs[id].el,"connection lost - will resume"); });
    currentRecv=null;
    Object.keys(activeOpticalSends).forEach(function(id){ stopOpticalSend(activeOpticalSends[id]); markXferState(activeOpticalSends[id].el,"connection lost"); delete activeOpticalSends[id]; });
    Object.keys(activeOpticalRecvs).forEach(function(id){ stopOpticalReceive(activeOpticalRecvs[id]); markXferState(activeOpticalRecvs[id].el,"connection lost"); delete activeOpticalRecvs[id]; });
    opticalBeacon.classList.add("hidden"); opticalScan.classList.add("hidden");
    peerIsMobile=false;
    transferMode=null;
    maybeShowModePrompt();
    setStatus(hasPending ? "Link closed. Re-enter the code to resume your transfer." : "Link closed. Enter a code to connect again.");
    pairing.classList.remove("hidden");drop.classList.add("disabled");conn=null;
    applyRole();
  }
  function setStatus(html){statusEl.innerHTML=html;}

  // ---- transfer mode choice: only relevant when this device is the (auto- or
  // manually-)declared non-mobile side and the linked peer is a phone. Shown once
  // per connection; the "switch" link lets the user change their mind any time. ----
  function modeRelevant(){ return !mazeRoleMobile && peerIsMobile; }
  // No upfront question: files to a phone go over the connection by default, and QR broadcast
  // (screen → camera, works with no network at all) is one tap away while a PC is linked to a phone.
  function maybeShowModePrompt(){
    if(modeRelevant() && !transferMode) transferMode="web";
    updateModeStatus();
  }
  function updateModeStatus(){
    if(modeRelevant() && transferMode){
      modeStatus.style.display="";
      modeStatusWord.textContent = transferMode==="optical" ? "QR broadcast (no network needed)" : "the connection";
      modeSwitchBtn.textContent = transferMode==="optical" ? "Use the connection" : "Send by QR broadcast instead";
    } else {
      modeStatus.style.display="none";
    }
  }
  modeSwitchBtn.addEventListener("click",function(){ transferMode = transferMode==="optical" ? "web" : "optical"; updateModeStatus(); });

  function dc(){return conn&&(conn.dataChannel||conn._dc)||null;}

  function queueFiles(list){
    if(!conn||!conn.open){ setStatus("Not linked yet - connect to a device first."); return; }
    for(var i=0;i<list.length;i++) sendQueue.push(list[i]);
    pump();
  }
  function pump(){
    if(sending) return;
    var f=sendQueue.shift();
    if(!f) return;
    sending=true;
    var task=(transferMode==="optical" && window.BeamByteQR) ? sendFileOptical(f) : sendFile(f);
    task.then(function(){ sending=false; stage.classList.remove("busy"); pump(); });
  }
  function sendFile(file,reuseEl){
    return new Promise(function(resolve){
      var xferId=xferKey(file);
      var el=reuseEl||makeXfer(xferId,file.name,file.size,"sending");
      var entry={xferId:xferId,file:file,offset:0,crc:0xFFFFFFFF,el:el,resolve:resolve,
                 t0:performance.now(),retries:0,started:false};
      activeSends[xferId]=entry;
      conn.send({__ctrl:true,t:"meta",xferId:xferId,name:file.name,size:file.size,
                 mime:file.type||"application/octet-stream",resume:false});
    });
  }

  // ---- Optical (QR) send: PC/notebook -> phone add-on. Broadcasts fountain-coded
  // frames on a canvas; the receiving phone's camera decodes them. The already-open
  // WebRTC link is only used to say "here comes a file" and "got it" / "give up" —
  // the bytes themselves never touch the data channel. ----
  function sendFileOptical(file){
    return new Promise(function(resolve){
      var xferId=xferKey(file);
      var el=makeXfer(xferId,file.name,file.size,"sending");
      var entry={xferId:xferId,file:file,el:el,resolve:resolve,raf:null,running:true};
      activeOpticalSends[xferId]=entry;
      file.arrayBuffer().then(function(buf){
        if(!activeOpticalSends[xferId]){ return; } // fell back / cancelled while reading
        var bytes=new Uint8Array(buf);
        var payloadSize=800,fps=12,scale=8;
        var enc=new OpticalLTEncoder(bytes,payloadSize);
        var meta={sessionId:opRandU32(),K:enc.K,blockSize:payloadSize,fileLength:bytes.length,crc:crc32Whole(bytes),name:file.name};
        entry.meta=meta;
        try{ conn.send({__ctrl:true,t:"opticalMeta",xferId:xferId,name:file.name,size:file.size}); }
        catch(e){ fallbackSend(entry); return; }
        obName.textContent=file.name; obCount.textContent="frame 0"; obCanvas.width=obCanvas.height=0;
        opticalBeacon.classList.remove("hidden");
        stage.classList.add("busy");
        var interval=1000/fps,last=0,seq=0,busy=false;
        function tick(t){
          if(!entry.running) return;
          if(t-last>=interval && !busy){
            last=t; busy=true;
            var frame=packOpticalFrame(meta,seq,enc.symbol(seq)); seq++;
            window.BeamByteQR.toCanvas(obCanvas,[{data:frame,mode:"byte"}],
              {errorCorrectionLevel:"L",margin:2,scale:scale,color:{dark:"#000000ff",light:"#ffffffff"}},
              function(){ busy=false; }
            );
            obCount.textContent="frame "+seq;
          }
          entry.raf=requestAnimationFrame(tick);
        }
        entry.raf=requestAnimationFrame(tick);
      }).catch(function(){ fallbackSend(entry); });
    });
  }
  function stopOpticalSend(entry){
    entry.running=false;
    if(entry.raf) cancelAnimationFrame(entry.raf);
    entry.raf=null;
    if(opticalBeacon.classList.contains("hidden")===false && activeOpticalSends[entry.xferId]===entry) opticalBeacon.classList.add("hidden");
  }
  function fallbackSend(entry){
    stopOpticalSend(entry);
    delete activeOpticalSends[entry.xferId];
    markXferState(entry.el,"switching to Wi-Fi…");
    sendFile(entry.file,entry.el).then(entry.resolve);
  }
  obFallback.addEventListener("click",function(){
    var ids=Object.keys(activeOpticalSends);
    if(!ids.length) return;
    try{ conn.send({__ctrl:true,t:"opticalCancelled",xferId:ids[0]}); }catch(e){}
    fallbackSend(activeOpticalSends[ids[0]]);
  });
  function beginSend(entry){
    if(entry.started) return;
    entry.started=true;
    clearXferState(entry.el);
    stage.classList.add("busy");
    var dch0=dc();
    if(dch0) dch0.bufferedAmountLowThreshold=HIGH;
    function next(){
      var file=entry.file;
      if(entry.offset>=file.size){ completeSend(entry); return; }
      if(!conn||!conn.open){ pauseSend(entry); return; }
      var d=dc();
      if(d&&d.bufferedAmount>HIGH){ waitForDrain(d,next); return; }
      file.slice(entry.offset,entry.offset+CHUNK).arrayBuffer().then(function(buf){
        if(!conn||!conn.open){ pauseSend(entry); return; }
        try{ conn.send(buf); }
        catch(e){
          entry.retries=(entry.retries||0)+1;
          if(entry.retries>20){ failSend(entry,"send failed repeatedly"); return; }
          setTimeout(next,60);
          return;
        }
        entry.retries=0;
        entry.crc=crc32Update(entry.crc,buf);
        entry.offset+=buf.byteLength;
        updateXfer(entry.el,entry.offset,file.size,entry.t0);
        if(entry.offset%(CHUNK*8)===0) setTimeout(next,0); else next();
      });
    }
    next();
  }
  function completeSend(entry){
    if(!conn||!conn.open){ pauseSend(entry); return; }
    var crcFinal=(entry.crc^0xFFFFFFFF)>>>0;
    try{ conn.send({__ctrl:true,t:"end",xferId:entry.xferId,crc32:crcFinal}); }
    catch(e){ pauseSend(entry); return; }
    finishXfer(entry.el,null,entry.file.name,"sent");
    delete activeSends[entry.xferId];
    entry.resolve();
  }
  function pauseSend(entry){
    entry.started=false;
    entry.retries=0;
    markXferState(entry.el,"connection lost - will resume");
  }
  function failSend(entry,msg){
    markXferState(entry.el,msg||"failed");
    delete activeSends[entry.xferId];
    entry.resolve();
  }
  function recomputeCrcThenBegin(entry,targetOffset){
    var file=entry.file,crc=0xFFFFFFFF,pos=0;
    function step(){
      if(pos>=targetOffset){ entry.crc=crc; entry.offset=targetOffset; beginSend(entry); return; }
      file.slice(pos,Math.min(pos+CHUNK,targetOffset)).arrayBuffer().then(function(buf){
        crc=crc32Update(crc,buf); pos+=buf.byteLength; step();
      });
    }
    step();
  }
  function handleStart(data){
    var entry=activeSends[data.xferId];
    if(!entry) return;
    if(entry.offset===data.offset) beginSend(entry);
    else recomputeCrcThenBegin(entry,data.offset);
  }

  function handleMeta(data){
    if(typeof data.size!=="number"||!isFinite(data.size)||data.size<0) return;
    if(opticalFallbackRows[data.xferId]){ opticalFallbackRows[data.xferId].remove(); delete opticalFallbackRows[data.xferId]; }
    var entry=activeRecvs[data.xferId];
    var offset;
    if(entry && data.resume){
      offset=entry.received||0;
      clearXferState(entry.el);
    } else {
      entry={xferId:data.xferId,meta:data,received:0,parts:[],crc:0xFFFFFFFF,
             t0:performance.now(),el:makeXfer(data.xferId,data.name,data.size,"receiving"),
             streaming:false,writable:null,writeQueue:null,streamDeclined:false};
      activeRecvs[data.xferId]=entry;
      offset=0;
    }
    currentRecv=entry;
    stage.classList.add("busy");
    decideOffer(entry,offset);
  }
  function decideOffer(entry,offset){
    var size=entry.meta.size;
    var canStream=typeof window.showSaveFilePicker==="function";
    if(canStream && size>=STREAM_THRESHOLD && !entry.streamDeclined && !entry.streaming){
      showSavePrompt(entry,offset);
      return;
    }
    if(!canStream && size>=STREAM_THRESHOLD){
      markXferState(entry.el,"large file - may fail to save on this browser");
    }
    ackStart(entry,offset);
  }
  function showSavePrompt(entry,offset){
    var btn=document.createElement("button");
    btn.className="btn-ghost";
    btn.style.marginTop="10px";
    btn.style.display="block";
    btn.textContent="Choose where to save ("+fmtBytes(entry.meta.size)+")";
    btn.addEventListener("click",function(){
      btn.disabled=true;
      window.showSaveFilePicker({suggestedName:entry.meta.name}).then(function(handle){
        return handle.createWritable();
      }).then(function(writable){
        entry.streaming=true;
        entry.writable=writable;
        btn.remove();
        ackStart(entry,offset);
      }).catch(function(){
        entry.streamDeclined=true;
        btn.remove();
        decideOffer(entry,offset);
      });
    });
    entry.el.appendChild(btn);
  }
  function ackStart(entry,offset){
    entry.received=offset;
    conn.send({__ctrl:true,t:"start",xferId:entry.xferId,offset:offset});
  }
  // The peer announces size and type; never trust either beyond what we asked for.
  function safeMime(m){
    m=String(m||"").toLowerCase();
    // blob: URLs share our origin, so an html/svg/xml blob opened in a tab could run script as Beam.
    return /^(image\/(png|jpeg|gif|webp|heic|heif|avif|bmp)|(video|audio)\/[a-z0-9.+-]+|application\/pdf|text\/plain)$/.test(m)?m:"application/octet-stream";
  }
  function rejectRecv(entry,msg){
    entry.parts=[];
    if(entry.writable){ try{ entry.writable.abort(); }catch(e){} }
    delete activeRecvs[entry.xferId];
    if(currentRecv===entry) currentRecv=null;
    markXferState(entry.el,msg);
  }
  function handleChunk(buf){
    var entry=currentRecv;
    if(!entry) return;
    if(entry.received+buf.byteLength>entry.meta.size){ rejectRecv(entry,"rejected - more data than announced"); return; }
    entry.crc=crc32Update(entry.crc,buf);
    entry.received+=buf.byteLength;
    updateXfer(entry.el,entry.received,entry.meta.size,entry.t0);
    if(entry.streaming){
      entry.writeQueue=(entry.writeQueue||Promise.resolve()).then(function(){return entry.writable.write(buf);});
    } else {
      entry.parts.push(buf);
    }
  }
  function handleEnd(data){
    var entry=activeRecvs[data.xferId];
    if(!entry) return;
    function finalize(){
      var ok=((entry.crc^0xFFFFFFFF)>>>0)===data.crc32;
      if(entry.streaming){
        entry.writable.close().then(function(){
          finishXfer(entry.el,null,entry.meta.name,ok?"received":"corrupted - retry");
        });
      } else {
        var blob=ok?new Blob(entry.parts,{type:safeMime(entry.meta.mime)}):null;
        finishXfer(entry.el,blob,entry.meta.name,ok?"received":"corrupted - retry");
      }
      delete activeRecvs[data.xferId];
      if(currentRecv===entry) currentRecv=null;
      stage.classList.remove("busy");
    }
    if(entry.writeQueue){ entry.writeQueue.then(finalize); } else { finalize(); }
  }

  function onData(data){
    if(conn&&conn.__awaitAccept&&data&&data.__ctrl&&data.t!=="busy"){ conn.__awaitAccept=false; onConnected(); }
    if(data&&data.__ctrl){
      if(data.t==="meta") return handleMeta(data);
      if(data.t==="start") return handleStart(data);
      if(data.t==="end") return handleEnd(data);
      if(data.t==="role"){
        peerIsMobile=!!data.mobile;
        peerRole.textContent="“"+labelOf(conn.peer)+"” ("+(peerIsMobile?"phone":"desktop")+")";
        maybeShowModePrompt();
        return;
      }
      if(data.t==="roleRequest"){
        try{ conn.send({__ctrl:true,t:"role",mobile:mazeRoleMobile}); }catch(e){}
        return;
      }
      if(data.t==="opticalMeta") return handleOpticalMeta(data);
      if(data.t==="opticalDone") return handleOpticalDone(data);
      if(data.t==="opticalFallback") return handleOpticalSenderFallback(data);
      if(data.t==="opticalCancelled") return handleOpticalCancelled(data);
      if(data.t==="busy"){ setStatus("That device is already linked to someone else."); }
      return;
    }
    var buf=data;
    if(buf&&buf.buffer&&ArrayBuffer.isView(buf)) buf=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
    if(buf instanceof ArrayBuffer) handleChunk(buf);
  }

  // ---- sender side: the receiving phone told us it's done, gave up on the camera,
  // or the user on our own side cancelled — all three stop the broadcast loop. ----
  function handleOpticalDone(data){
    var entry=activeOpticalSends[data.xferId];
    if(!entry) return;
    stopOpticalSend(entry);
    delete activeOpticalSends[data.xferId];
    finishXfer(entry.el,null,entry.file.name,data.ok?"sent":"receiver reported a checksum mismatch");
    entry.resolve();
  }
  function handleOpticalSenderFallback(data){
    var entry=activeOpticalSends[data.xferId];
    if(!entry) return;
    // The phone couldn't start its camera: say so instead of silently switching, and stay on the
    // connection for the next files until the user picks QR broadcast again.
    transferMode="web"; updateModeStatus();
    var el=entry.el,done=entry.resolve;
    entry.resolve=function(){
      var pct=el.querySelector(".pct"); if(pct) pct.textContent="sent over the connection — the phone's camera wasn't available";
      done();
    };
    fallbackSend(entry);
  }
  function handleOpticalCancelled(data){
    var entry=activeOpticalRecvs[data.xferId];
    if(!entry) return;
    stopOpticalReceive(entry);
    delete activeOpticalRecvs[data.xferId];
    markXferState(entry.el,"sender switched to Wi-Fi — waiting…");
  }

  // ---- receiver side (phone): a PC/notebook is about to broadcast a file as QR
  // frames. Open the camera and start decoding; if the camera can't be used, tell
  // the sender to fall back to the normal Wi-Fi/WebRTC transfer instead. ----
  function handleOpticalMeta(data){
    var entry={xferId:data.xferId,name:data.name,size:data.size,
               el:makeXfer(data.xferId,data.name,data.size,"receiving"),
               decoder:null,session:null,meta:null,stream:null,gen:0,stopped:false};
    activeOpticalRecvs[data.xferId]=entry;
    stage.classList.add("busy");
    osName.textContent=data.name; osStatus.textContent="Starting camera…"; osBar.style.width="0%";
    opticalScan.classList.remove("hidden");
    startOpticalReceive(entry);
  }
  function startOpticalReceive(entry){
    var gen=++entry.gen;
    var ctx=osCanvas.getContext("2d",{willReadFrequently:true});
    Promise.all([
      navigator.mediaDevices.getUserMedia({video:{facingMode:"environment",width:{ideal:1280},frameRate:{exact:30}}})
        .catch(function(){ return navigator.mediaDevices.getUserMedia({video:{facingMode:"environment",width:{ideal:1280}}}); }),
      getReadBarcodes()
    ]).then(function(res){
      if(gen!==entry.gen||entry.stopped) { res[0].getTracks().forEach(function(t){t.stop();}); return; }
      var stream=res[0],readBarcodes=res[1];
      entry.stream=stream;
      osVideo.srcObject=stream;
      return osVideo.play().then(function(){
        var useRVFC="requestVideoFrameCallback" in HTMLVideoElement.prototype;
        var busy=false;
        osStatus.textContent="Looking for a stream…";
        function grab(){
          if(gen!==entry.gen||entry.stopped) return;
          var w=osVideo.videoWidth,h=osVideo.videoHeight;
          if(w&&h&&!busy){
            busy=true;
            osCanvas.width=w; osCanvas.height=h;
            ctx.drawImage(osVideo,0,0,w,h);
            var img=ctx.getImageData(0,0,w,h);
            readBarcodes(img,{formats:["QRCode"],maxNumberOfSymbols:1}).then(function(results){
              for(var i=0;i<results.length;i++){
                var r=results[i];
                var bytes=r.bytes instanceof Uint8Array ? r.bytes : (r.bytes?Uint8Array.from(r.bytes):null);
                if(bytes) ingestOpticalFrame(entry,bytes);
              }
            }).catch(function(){}).then(function(){ busy=false; });
          }
          if(gen!==entry.gen||entry.stopped) return;
          if(useRVFC) osVideo.requestVideoFrameCallback(grab); else setTimeout(grab,33);
        }
        if(useRVFC) osVideo.requestVideoFrameCallback(grab); else setTimeout(grab,33);
      });
    }).catch(function(){
      // No camera, permission denied, or zxing failed to load — fall back gracefully.
      stopOpticalReceive(entry);
      delete activeOpticalRecvs[entry.xferId];
      opticalScan.classList.add("hidden");
      markXferState(entry.el,"camera unavailable - receiving over the connection");
      opticalFallbackRows[entry.xferId]=entry.el; // replaced by the real row when the file arrives (handleMeta)
      try{ conn.send({__ctrl:true,t:"opticalFallback",xferId:entry.xferId}); }catch(e){}
    });
  }
  function ingestOpticalFrame(entry,frameBytes){
    var f=parseOpticalFrame(frameBytes);
    if(!f) return;
    // Only accept the stream announced over the link: a stray or crafted QR could otherwise
    // make the decoder allocate K slots straight from its header (K is a uint32).
    if(f.meta.fileLength!==entry.size||!f.meta.blockSize||
       f.meta.K!==Math.max(1,Math.ceil(f.meta.fileLength/f.meta.blockSize))) return;
    if(!entry.decoder||entry.session!==f.meta.sessionId){
      entry.session=f.meta.sessionId; entry.meta=f.meta;
      entry.decoder=new OpticalLTDecoder(f.meta.K,f.meta.blockSize,f.meta.fileLength);
      osStatus.textContent="Receiving";
    }
    var done=entry.decoder.addSymbol(f.seq,f.payload);
    osBar.style.width=Math.round(entry.decoder.progress*100)+"%";
    updateXfer(entry.el,Math.round(entry.decoder.progress*entry.meta.fileLength),entry.meta.fileLength,entry.t0||(entry.t0=performance.now()));
    if(done) finishOpticalReceive(entry);
  }
  function finishOpticalReceive(entry){
    var bytes=entry.decoder.assemble();
    var ok=crc32Whole(bytes)===entry.meta.crc;
    stopOpticalReceive(entry);
    delete activeOpticalRecvs[entry.xferId];
    opticalScan.classList.add("hidden");
    var blob=ok?new Blob([bytes]):null;
    finishXfer(entry.el,blob,entry.meta.name,ok?"received":"corrupted - retry");
    stage.classList.remove("busy");
    try{ conn.send({__ctrl:true,t:"opticalDone",xferId:entry.xferId,ok:ok}); }catch(e){}
  }
  function stopOpticalReceive(entry){
    entry.stopped=true; entry.gen++;
    if(entry.stream){ entry.stream.getTracks().forEach(function(t){t.stop();}); entry.stream=null; }
  }
  osFallback.addEventListener("click",function(){
    var ids=Object.keys(activeOpticalRecvs);
    if(!ids.length) return;
    var entry=activeOpticalRecvs[ids[0]];
    stopOpticalReceive(entry);
    delete activeOpticalRecvs[ids[0]];
    opticalScan.classList.add("hidden");
    markXferState(entry.el,"switching to Wi-Fi…");
    try{ conn.send({__ctrl:true,t:"opticalFallback",xferId:ids[0]}); }catch(e){}
  });
  function fmtBytes(n){if(n<1024)return n+" B";if(n<1048576)return(n/1024).toFixed(1)+" KB";if(n<1073741824)return(n/1048576).toFixed(1)+" MB";return(n/1073741824).toFixed(2)+" GB";}
  function makeXfer(id,name,size,dirWord){
    var row=document.createElement("div");row.className="xfer";
    row.innerHTML='<div class="r1"><span class="nm"></span><span class="dir">'+dirWord+'</span></div><div class="bar"><i></i></div><div style="display:flex;justify-content:space-between;margin-top:7px"><span class="meta pct">0%</span><span class="meta sz">'+fmtBytes(size)+'</span></div>';
    row.querySelector(".nm").textContent=name;xfers.insertBefore(row,xfers.firstChild);return row;
  }
  function updateXfer(el,done,total,t0){var pct=total?Math.min(100,Math.round(done/total*100)):0;el.querySelector(".bar > i").style.width=pct+"%";var sec=(performance.now()-t0)/1000,rate=sec>0?done/sec:0;el.querySelector(".pct").textContent=pct+"%  ·  "+fmtBytes(rate)+"/s";}
  function finishXfer(el,blob,name,label){
    el.classList.remove("paused");
    el.classList.add("done");
    el.querySelector(".bar > i").style.width="100%";
    el.querySelector(".pct").textContent=label||(blob?"received":"sent");
    if(blob){
      var url=URL.createObjectURL(blob),a=document.createElement("a");
      a.className="save";a.href=url;a.download=name;a.target="_blank";a.rel="noopener";a.textContent="Save / open ↓";
      el.appendChild(a);
    }
  }

  drop.addEventListener("click",function(){if(!drop.classList.contains("disabled"))filein.click();});
  filein.addEventListener("change",function(){if(filein.files.length)queueFiles(filein.files);filein.value="";});
  ["dragenter","dragover"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();if(!drop.classList.contains("disabled"))drop.classList.add("hot");});});
  ["dragleave","drop"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove("hot");});});
  drop.addEventListener("drop",function(e){if(e.dataTransfer&&e.dataTransfer.files.length)queueFiles(e.dataTransfer.files);});

  Array.prototype.forEach.call(modeSeg.children,function(b){
    b.addEventListener("click",function(){ setMode(b.getAttribute("data-mode")); applyPolicy(); });
  });

  // ---- ICE probe ----
  function probe(timeout){
    var onCand=null;
    var pr = new Promise(function(res){
      var counts={host:0,srflx:0,relay:0,other:0},relayProtos={},pc,done=false;
      try{ pc=new RTCPeerConnection({iceServers:allServers()}); }
      catch(e){ res({counts:counts,relayProtos:relayProtos,error:e.message}); return; }
      try{ pc.createDataChannel("p"); }catch(e){}
      function typeOf(c){ if(c.type) return c.type; var m=/ typ (\w+)/.exec(c.candidate||""); return m?m[1]:"other"; }
      function fin(){ if(done)return; done=true; try{pc.close();}catch(e){} res({counts:counts,relayProtos:relayProtos}); }
      pc.onicecandidate=function(e){
        if(!e.candidate){fin();return;}
        var t=typeOf(e.candidate); if(counts[t]!==undefined)counts[t]++; else counts.other++;
        if(t==="relay") relayProtos[(e.candidate.protocol||"udp").toUpperCase()]=1;
        if(onCand) onCand(counts,relayProtos);
      };
      pc.createOffer().then(function(o){return pc.setLocalDescription(o);}).catch(function(){});
      setTimeout(fin,timeout||3000);
    });
    pr.setOnCand=function(fn){onCand=fn;};
    return pr;
  }

  function autoDetect(){
    paintNet();
    probe(3000).then(function(r){
      detected = (r.counts.srflx===0) ? "restricted" : "open";
      applyPolicy();
    });
  }

  $("testNet").addEventListener("click",function(){
    var diag=$("diag"),cands=$("cands"),verdict=$("verdict");
    diag.classList.remove("hidden");cands.innerHTML="";verdict.className="verdict";verdict.textContent="Gathering candidates…";
    function render(counts,relayProtos){
      cands.innerHTML="";
      [["srflx","Public via STUN"],["relay","Relay via TURN"]].forEach(function(p){
        var s=document.createElement("span");s.className="cand "+p[0];s.textContent=p[1]+": "+(counts[p[0]]||0);cands.appendChild(s);
      });
      var pr=Object.keys(relayProtos||{});
      if(pr.length){var s=document.createElement("span");s.className="cand relay";s.textContent="relay over "+pr.join(", ");cands.appendChild(s);}
    }
    ensureFreshRelay().then(function(){
      var p=probe(9000);
      p.setOnCand(render);
      p.then(function(r){
        render(r.counts,r.relayProtos);
        if(r.error){verdict.className="verdict bad";verdict.textContent="Couldn't run test: "+r.error;return;}
        var c=r.counts;
        if(c.relay>0){verdict.className="verdict ok";verdict.innerHTML="✓ Relay reachable. Links will succeed on this network"+(c.srflx>0?", and direct paths are available too.":".");}
        else if(!haveRelay()){verdict.className="verdict warn";verdict.textContent="No relay credentials loaded — the /api/turn function isn't returning any. Check its environment variables.";}
        else if(c.srflx>0){verdict.className="verdict warn";verdict.textContent="STUN works but the relay didn't answer. Check the TURN host/secret and that it listens on TLS 443.";}
        else{verdict.className="verdict bad";verdict.textContent="Neither STUN nor relay reachable from here — the relay must listen on 443 with valid credentials.";}
      });
    });
  });

  function joinByCode(code){
    code=(code||"").trim().toUpperCase();
    if(!code) return;
    peerInput.value=code;
    // Dial only once our own peer is registered with the signaling server: an offer sent
    // before that (e.g. straight from a scanned ?j= link on page load) is silently lost.
    if(peer&&peer.open){ connectBtn.click(); return; }
    joinPending=true;
    setStatus("Linking…");
    var tries=0,iv=setInterval(function(){
      tries++;
      if(peer&&peer.open){ clearInterval(iv); joinPending=false; connectBtn.click(); }
      else if(tries>100){ clearInterval(iv); joinPending=false; setStatus("Couldn't reach the connection service — check your internet and try again."); }
    },150);
  }
  function autoJoin(){
    var m=location.search.match(/[?&]j=([A-Za-z0-9]+)/);
    if(!m) return;
    // Opened from a scanned QR / private link: don't leave the code in the address bar or redial on reload.
    try{ history.replaceState(null,"",location.pathname); }catch(e){}
    joinByCode(m[1]);
  }

  // ---- in-app QR scan (phone side): camera → vendored zxing → this site's ?j= link → dial ----
  // For when Beam is open already (e.g. installed as an app), where the phone's own camera app
  // would open a separate browser tab instead.
  var scanStream=null,scanTimer=null;
  function codeFromScan(text){
    try{
      var u=new URL(text);
      if(u.host!==location.host) return null; // only links to this same Beam deployment
      var j=u.searchParams.get("j");
      return j&&/^[A-Za-z0-9]{4,32}$/.test(j)?j:null;
    }catch(e){ return null; }
  }
  function stopPairScan(){
    if(scanTimer){ clearInterval(scanTimer); scanTimer=null; }
    if(scanStream){ scanStream.getTracks().forEach(function(t){t.stop();}); scanStream=null; }
    $("pairVideo").srcObject=null;
    $("scanBox").classList.add("hidden"); $("scanCancel").classList.add("hidden"); $("scanBtn").classList.remove("hidden");
  }
  function startPairScan(){
    var hint=$("scanHint"),video=$("pairVideo");
    if(!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)){ hint.textContent="This browser can't use the camera here. Use your phone's camera app, or blocks or a short code below."; return; }
    $("scanBtn").classList.add("hidden"); $("scanBox").classList.remove("hidden"); $("scanCancel").classList.remove("hidden");
    hint.textContent="Starting camera…";
    Promise.all([
      getReadBarcodes(),
      navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false})
    ]).then(function(r){
      var read=r[0]; scanStream=r[1];
      video.srcObject=scanStream; video.play().catch(function(){});
      hint.textContent="Point the camera at the QR code on the other screen.";
      var cv=document.createElement("canvas"),ctx=cv.getContext("2d",{willReadFrequently:true}),busy=false;
      scanTimer=setInterval(function(){
        if(busy||!video.videoWidth) return;
        busy=true;
        var w=Math.min(960,video.videoWidth),h=Math.round(video.videoHeight*w/video.videoWidth);
        cv.width=w; cv.height=h; ctx.drawImage(video,0,0,w,h);
        read(ctx.getImageData(0,0,w,h),{formats:["QRCode"],maxNumberOfSymbols:1}).then(function(res){
          busy=false;
          for(var i=0;i<res.length;i++){
            var code=codeFromScan(res[i].text);
            if(code){ stopPairScan(); hint.textContent="Code found — connecting…"; if(navigator.vibrate) navigator.vibrate(30); joinByCode(code); return; }
          }
        },function(){ busy=false; });
      },200);
    }).catch(function(e){
      stopPairScan();
      hint.textContent=(e&&e.name==="NotAllowedError")
        ? "Camera access was blocked. Allow it in your browser settings, or use blocks or a short code below."
        : "Couldn't start the camera. Use your phone's camera app, or blocks or a short code below.";
    });
  }
  $("scanBtn").addEventListener("click",startPairScan);
  $("scanCancel").addEventListener("click",function(){ stopPairScan(); $("scanHint").textContent="Point the camera at the QR code on the other screen."; });

  // ---- share link (sender side) ----
  function shareLink(){
    var url=location.origin+location.pathname+"?j="+myLongId; // the private (QR) code, never the short one
    if(navigator.share){ navigator.share({title:"Beam",url:url}).catch(function(){}); return; }
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(function(){
        var old=shareBtn.textContent; shareBtn.textContent="Copied!";
        setTimeout(function(){shareBtn.textContent=old;},1500);
      }).catch(function(){});
    }
  }
  shareBtn.addEventListener("click",shareLink);

  // ---- pairing maze: the block order IS the room code (see genCode above) ----
  // Four fixed block identities (index 0..3), reusing the existing brand palette.
  // Kept at 4 (not 5) so the row never wraps to a second line on narrow phones.
  var MAZE_N=4;
  var MAZE_DOTS=[
    {glyph:"●",color:"var(--blk-circle)"},
    {glyph:"▲",color:"var(--blk-triangle)"},
    {glyph:"■",color:"var(--blk-square)"},
    {glyph:"★",color:"var(--blk-star)"}
  ];
  function codeToSeq(code){ return code.split("").map(function(c){return parseInt(c,10)-1;}); }
  function setCubeVisual(el,identity){
    var d=MAZE_DOTS[identity];
    el.style.background=d.color;
    el.textContent=d.glyph;
  }
  function cubeEl(identity){
    var el=document.createElement("div");
    el.className="cube";
    setCubeVisual(el,identity);
    return el;
  }

  // ---- shower side: this device's own code, in order, left to right ----
  function renderMazeShow(code){
    var seq=codeToSeq(code);
    var box=$("mazeShow");
    box.innerHTML="";
    seq.forEach(function(identity){ box.appendChild(cubeEl(identity)); });
  }

  // ---- joiner side: same blocks shuffled - swipe a block past its neighbor
  // (like sliding a 2048 tile) until the row matches the other device ----
  var mazeOrder=[],mazePending=false;
  function renderMazeTrace(){
    mazeOrder=shuffledIndices(MAZE_N);
    mazePending=false;
    drawMazeTrace();
    mazeStatus.textContent="Watch the other device, then swipe blocks left/right into the same order.";
  }
  function drawMazeTrace(){
    var box=$("mazeTrace");
    box.innerHTML="";
    mazeOrder.forEach(function(identity,i){
      var el=cubeEl(identity);
      wireCubeDrag(el,i);
      box.appendChild(el);
    });
  }
  // One finger/mouse drag = one slide: past a threshold, the dragged block
  // swaps with whichever neighbor is in the drag direction. Pointermove only
  // records the latest X; the actual style write happens once per animation
  // frame via requestAnimationFrame, so fast phones/high pointer-report-rate
  // devices don't thrash layout with redundant writes (this, plus never
  // rebuilding the DOM on a swap - see below - was the main source of the
  // laggy/robotic feel). On commit, the two elements involved just swap
  // which identity they display and animate back to rest from wherever the
  // drag left them - the CSS transition on transform does the "slide into
  // the new spot" animation for free, since these are the same DOM nodes
  // the whole time, never destroyed and recreated.
  function wireCubeDrag(el,i){
    var startX=0,lastX=0,dragging=false,neighborIdx=-1,neighborEl=null,pitch=56,rafId=null;
    function applyMove(){
      rafId=null;
      var dx=lastX-startX;
      if(!dragging){
        if(Math.abs(dx)<6) return; // dead zone so a tap isn't read as a drag
        var ni=i+(dx<0?-1:1);
        if(ni<0||ni>=mazeOrder.length) return; // no neighbor that way (edge block)
        dragging=true;
        neighborIdx=ni;
        neighborEl=$("mazeTrace").children[ni];
        var r1=el.getBoundingClientRect(),r2=neighborEl.getBoundingClientRect();
        pitch=Math.abs(r2.left-r1.left)||56;
        el.classList.add("dragging"); neighborEl.classList.add("dragging");
      }
      var clamped=Math.max(-pitch,Math.min(pitch,dx));
      el.style.transform="translateX("+clamped+"px) scale(1.06)";
      neighborEl.style.transform="translateX("+(-clamped)+"px)";
    }
    el.addEventListener("pointerdown",function(e){
      startX=e.clientX; lastX=e.clientX; dragging=false; neighborIdx=-1; neighborEl=null;
      try{ el.setPointerCapture(e.pointerId); }catch(err){}
    });
    el.addEventListener("pointermove",function(e){
      lastX=e.clientX;
      if(rafId===null) rafId=requestAnimationFrame(applyMove);
    });
    function endDrag(e){
      if(rafId!==null){ cancelAnimationFrame(rafId); rafId=null; }
      if(!dragging) return;
      var dx=(e&&e.clientX!==undefined?e.clientX:lastX)-startX;
      dragging=false;
      el.classList.remove("dragging");
      if(neighborEl) neighborEl.classList.remove("dragging");
      if(neighborEl && Math.abs(dx)>pitch*0.4){
        var tmp=mazeOrder[i]; mazeOrder[i]=mazeOrder[neighborIdx]; mazeOrder[neighborIdx]=tmp;
        if(navigator.vibrate) navigator.vibrate(10);
        setCubeVisual(el,mazeOrder[i]);
        setCubeVisual(neighborEl,mazeOrder[neighborIdx]);
      }
      el.style.transform=""; // eases back/settles via the CSS transition either way
      if(neighborEl) neighborEl.style.transform="";
    }
    el.addEventListener("pointerup",endDrag);
    el.addEventListener("pointercancel",endDrag);
  }
  $("mazeConnectBtn").addEventListener("click",function(){
    mazePending=true;
    mazeStatus.textContent="Connecting…";
    joinByCode(mazeOrder.map(function(i){return String(i+1);}).join(""));
  });
  // Failure paths (wrong order, or a connect attempt that times out) are
  // reported back into the maze's own caption from peer.on("error") and
  // armConnectTimeout below - otherwise this caption is left stuck reading
  // "Connecting..." forever even after the real status line has already
  // moved on to "No device found with that code."
  function mazeReportFailure(msg){
    if(!mazePending) return;
    mazePending=false;
    mazeStatus.textContent=msg;
  }

  // ---- role: show only the relevant card by default (coarse/touch pointer
  // = phone = receiver; fine pointer = PC = sender), with a manual override
  // since detection can guess wrong (touchscreen laptops, tablets, etc). ----
  var mazeRoleMobile=false;
  try{
    var _coarse = matchMedia("(pointer: coarse)").matches;
    var _fine = matchMedia("(pointer: fine)").matches;
    var _touch = ("ontouchstart" in window) || navigator.maxTouchPoints>0;
    // Older Safari doesn't support the pointer media feature (silently reads as
    // not-coarse), which would otherwise misdetect an iPhone as a desktop and
    // leave the peer never knowing to expect optical/QR transfers. Touch
    // capability without a fine pointer is treated as mobile too.
    mazeRoleMobile = _coarse || (_touch && !_fine);
  }catch(e){}
  function applyRole(){
    document.body.classList.toggle("role-mobile",mazeRoleMobile);
    // Once linked, the pairing cards are moot — switch the button's wording to
    // a plain device-type declaration instead, since that's the only thing it
    // still does at that point (manual override for detection getting it wrong,
    // e.g. older Safari not supporting the pointer media feature).
    $("roleSwitchBtn").textContent = (conn&&conn.open)
      ? (mazeRoleMobile ? "This device: phone — tap to switch to PC" : "This device: PC — tap to switch to phone")
      : (mazeRoleMobile ? "Sending instead? Show my code" : "Receiving instead? Connect to a device");
  }
  $("roleSwitchBtn").addEventListener("click",function(){
    mazeRoleMobile=!mazeRoleMobile;
    applyRole();
    if(!modeRelevant()) transferMode=null;
    maybeShowModePrompt();
    // Already linked? Re-announce immediately so the peer's optical routing
    // (and its displayed "(phone)"/"(desktop)" label) updates without a reconnect.
    if(conn&&conn.open){ try{ conn.send({__ctrl:true,t:"role",mobile:mazeRoleMobile}); }catch(e){} }
  });
  applyRole();

  // ---- boot ----
  paintNet();
  renderMazeTrace();
  if(typeof Peer==="undefined"){setStatus("Couldn't load the connection library. Check your internet connection and reload.");netbadgetxt.textContent="offline";}
  else{
    init();
    fetchRelay().then(function(){ applyPolicy(); autoDetect(); });
    autoJoin();
    setInterval(function(){ fetchRelay().then(applyPolicy); }, 45*60*1000); // keep creds fresh
    setInterval(autoDetect, 10*60*1000); // re-classify the network periodically
    window.addEventListener("online", autoDetect); // and right after coming back online
  }

  if("serviceWorker" in navigator){
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("/sw.js").catch(function(){ /* installability is best-effort */ });
    });
  }
})();
