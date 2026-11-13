'use strict'
const $ = (id) => document.getElementById(id)
const code = (new URLSearchParams(location.search).get('j') || '').toLowerCase().replace(/[^a-z2-7]/g, '')
const CHUNK = 64 * 1024, HIGH = 1024 * 1024
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crcUpdate = (crc, buf) => { const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) crc = CRC[(crc ^ b[i]) & 0xff] ^ (crc >>> 8); return crc >>> 0 }
const size = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'

let conn = null, hello = null, waiter = null, busy = false, queue = []
function setState(kind, text, msg) { $('dot').className = 'dot ' + kind; $('state').textContent = text; $('msg').textContent = msg || '' }
function fail(text, msg) { setState('bad', text, msg); $('pick').classList.add('off') }

async function start() {
  if (code.length !== 10) return fail('No room code', 'Scan the QR code shown on the board or the touch panel in the training room.')
  let ice
  try {
    const r = await fetch('/api/turn-drop?c=' + code, { cache: 'no-store' })
    if (r.status === 401) return fail('This code has expired', 'The code changes every day. Scan the QR code in the room again.')
    ice = await r.json()
    if (!r.ok) throw new Error(ice.error || r.status)
  } catch (e) { return fail('Can’t connect', 'Check this phone’s internet connection and try again.') }
  const peer = new Peer({ debug: 1, config: { iceServers: ice.iceServers || [] } })
  const giveUp = setTimeout(() => { if (!hello) fail('The room PC doesn’t answer', 'It may be switched off. Try again in a minute, or ask someone in the room.') }, 25000)
  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') fail('The room PC is offline', 'It may be switched off, or this code is old: scan the QR code in the room again.')
    else if (!hello) fail('Can’t connect', 'Check this phone’s internet connection and try again.')
  })
  peer.on('open', () => {
    conn = peer.connect('oatr-' + code, { reliable: true })
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object') return
      if (d.t === 'hello') { hello = d; clearTimeout(giveUp); setState('ok', 'Connected to the ' + (d.room || 'room'), 'Up to ' + d.maxMB + ' MB per file.'); $('pick').classList.remove('off'); $('file').accept = d.exts.map((x) => '.' + x).join(','); return }
      if (waiter) { const w = waiter; waiter = null; w(d) }
    })
    conn.on('close', () => { if (hello) fail('Disconnected', 'Reload this page to connect again.') })
  })
}
const next = () => new Promise((res) => { waiter = res })
const drained = () => new Promise((res) => {
  const dc = conn.dataChannel
  const full = () => conn.open && ((dc && dc.bufferedAmount >= HIGH) || conn.bufferSize > 8) // the channel and PeerJS's own queue
  if (!full()) return res()
  const t = setInterval(() => { if (!full()) { clearInterval(t); res() } }, 30)
})

async function send(file, li) {
  const note = (cls, text) => { li.className = cls; li.querySelector('small').textContent = text }
  const bar = li.querySelector('progress')
  conn.send({ t: 'meta', name: file.name, size: file.size })
  const r = await next()
  if (r.t !== 'ready') { bar.remove(); return note('err', r.msg || 'Refused') }
  let crc = 0xffffffff
  for (let off = 0; off < file.size; off += CHUNK) {
    if (!conn.open) { bar.remove(); return note('err', 'Connection lost') }
    const buf = await file.slice(off, off + CHUNK).arrayBuffer()
    crc = crcUpdate(crc, buf); conn.send(buf); bar.value = Math.min(100, (off + buf.byteLength) / file.size * 100)
    await drained()
  }
  note('', 'Saving…')
  conn.send({ t: 'end', crc: (crc ^ 0xffffffff) >>> 0 })
  const done = await next()
  bar.remove()
  done.t === 'saved' ? note('done', '✓ On the board: open Files on the touch panel') : note('err', done.msg || 'Not saved')
}
async function pump() {
  if (busy) return; busy = true
  while (queue.length) { const [f, li] = queue.shift(); try { await send(f, li) } catch (e) { li.className = 'err'; li.querySelector('small').textContent = 'Failed' } }
  busy = false
}
$('file').onchange = () => {
  for (const f of $('file').files) {
    const li = document.createElement('li'); li.innerHTML = '<b></b><small></small><progress max="100" value="0"></progress>'
    li.querySelector('b').textContent = f.name; li.querySelector('small').textContent = size(f.size)
    $('files').prepend(li); queue.push([f, li])
  }
  $('file').value = ''; pump()
}
start()
