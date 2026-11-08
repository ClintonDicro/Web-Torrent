// Local WebTorrent tracker for tests: bittorrent-tracker over WSS (self-signed TLS)
// on 127.0.0.1. Using wss:// lets tests run under the production CSP, which only
// allows secure WebSocket trackers. Test-only: never part of the deployed site.
import https from 'node:https'
import { Server } from 'bittorrent-tracker'
import selfsigned from 'selfsigned'

export async function startTracker (port = 0) {
  const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    days: 2,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] }]
  })
  const tracker = new Server({ http: false, udp: false, ws: { noServer: true }, stats: false })
  const stats = { connections: 0, announces: 0 }
  tracker.on('start', () => { stats.announces++ })
  tracker.on('update', () => { stats.announces++ })
  tracker.on('warning', () => {})
  tracker.on('error', () => {})

  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    tracker.ws.handleUpgrade(req, socket, head, ws => {
      stats.connections++
      tracker.ws.emit('connection', ws, req)
    })
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const actual = server.address().port
  return {
    url: `wss://127.0.0.1:${actual}`,
    port: actual,
    stats,
    async close () {
      await new Promise(resolve => tracker.close(resolve))
      await new Promise(resolve => server.close(() => resolve()))
    }
  }
}
