// Serve dist/ locally with the same headers Cloudflare Pages will send (_headers).
import { startStaticServer } from '../tests/support/static-server.mjs'
const port = Number(process.argv[2] || 4174)
const srv = await startStaticServer('dist', { port })
console.log(`Serving dist/ with production headers at ${srv.url}`)
