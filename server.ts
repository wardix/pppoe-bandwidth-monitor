import { Hono } from 'hono'
import { file } from 'bun'

// Konfigurasi dari Environment Variables (.env)
const DB_GATEWAY_API_URL = process.env.DB_GATEWAY_API_URL || ''
const DB_GATEWAY_API_TOKEN = process.env.DB_GATEWAY_API_TOKEN || ''
const TOLERANCE_PERCENTAGE = process.env.TOLERANCE_PERCENTAGE
  ? parseFloat(process.env.TOLERANCE_PERCENTAGE)
  : 0.05
const FETCH_INTERVAL_MINUTES = process.env.FETCH_INTERVAL_MINUTES
  ? parseInt(process.env.FETCH_INTERVAL_MINUTES, 10)
  : 5

let cachedMetrics = ''
let isFetching = false

// Fungsi untuk mengambil dan membandingkan data, lalu membangun metrics
async function updateMetrics() {
  if (isFetching) return
  isFetching = true

  console.log(`\n[${new Date().toISOString()}] Memulai sinkronisasi data...`)

  try {
    // Membaca daftar router dari file routers.json
    const routersData = await file('routers.json').text()
    const routers = JSON.parse(routersData)

    let allMismatches: any[] = []

    for (const router of routers) {
      console.log(
        `\n[${new Date().toISOString()}] Memproses router: ${router.id}`,
      )

      const authHeader = `Basic ${btoa(`${router.username}:${router.password}`)}`
      const headers = {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      }

      try {
        // 1. Ambil data dari MikroTik
        const [pppoeRes, queueRes] = await Promise.all([
          fetch(router.apiUrlPpp, { headers }),
          fetch(router.apiUrlQueue, { headers }),
        ])

        if (!pppoeRes.ok)
          throw new Error(`Gagal mengambil PPPoE dari ${router.id}`)
        if (!queueRes.ok)
          throw new Error(`Gagal mengambil Queue dari ${router.id}`)

        const activePPPoE = await pppoeRes.json()
        const simpleQueues = await queueRes.json()

        // 2. Petakan Queue ke Username
        const limitMap = new Map<string, string>()
        for (const queue of simpleQueues) {
          let target = queue.target
          const match = target.match(/<pppoe-(.*)>/)
          if (match) target = match[1]
          limitMap.set(target, queue['max-limit'])
        }

        // 3. Gabungkan data MikroTik (IP -> Username -> Limit)
        const mikrotikMap = new Map()
        for (const session of activePPPoE) {
          if (session.address) {
            mikrotikMap.set(session.address, {
              ip_address: session.address,
              username: session.name,
              max_limit: limitMap.get(session.name) || 'Tidak ada limit',
            })
          }
        }

        // 4. Batch request ke DB Gateway
        const ipBatches: string[][] = []
        const BATCH_SIZE = 128
        const allIps = Array.from(mikrotikMap.keys())

        for (let i = 0; i < allIps.length; i += BATCH_SIZE) {
          ipBatches.push(allIps.slice(i, i + BATCH_SIZE))
        }

        // 5. Bandingkan dengan API Gateway
        for (const batch of ipBatches) {
          try {
            const response = await fetch(DB_GATEWAY_API_URL, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${DB_GATEWAY_API_TOKEN}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ ips: batch }),
            })

            if (!response.ok) continue
            const apiData = await response.json()

            for (const apiUser of apiData) {
              const mtUser = mikrotikMap.get(apiUser.ip)
              if (!mtUser) continue

              let mtUpload = 0
              let mtDownload = 0

              if (mtUser.max_limit && mtUser.max_limit.includes('/')) {
                const parts = mtUser.max_limit.split('/')
                mtUpload = parseInt(parts[0], 10)
                mtDownload = parseInt(parts[1], 10)
              }

              const uploadDiff = Math.abs(mtUpload - apiUser.upload_rate)
              const downloadDiff = Math.abs(mtDownload - apiUser.download_rate)

              let uploadTolerance =
                apiUser.upload_rate > 0
                  ? uploadDiff / apiUser.upload_rate
                  : mtUpload > 0
                    ? 1
                    : 0
              let downloadTolerance =
                apiUser.download_rate > 0
                  ? downloadDiff / apiUser.download_rate
                  : mtDownload > 0
                    ? 1
                    : 0

              const isMatch =
                uploadTolerance < TOLERANCE_PERCENTAGE &&
                downloadTolerance < TOLERANCE_PERCENTAGE

              if (!isMatch) {
                allMismatches.push({
                  router_id: router.id,
                  ip_address: apiUser.ip,
                  username: mtUser.username,
                  mt_max_limit: mtUser.max_limit,
                  db_package: apiUser.subscription_package,
                })
              }
            }
          } catch (err) {
            console.error(`Gagal memproses batch untuk ${router.id}:`, err)
          }
        }
        console.log(`✅ Router ${router.id} selesai diproses.`)
      } catch (err) {
        console.error(`❌ Error memproses router ${router.id}:`, err)
      }
    }

    // 6. Format ke Prometheus Metrics
    let newMetrics = ''
    if (allMismatches.length > 0) {
      newMetrics +=
        '# HELP pppoe_bandwidth_mismatch Indikasi adanya ketidaksesuaian bandwidth pelanggan (Selalu 1 jika muncul)\n'
      newMetrics += '# TYPE pppoe_bandwidth_mismatch gauge\n'

      for (const res of allMismatches) {
        const ip = res.ip_address || 'unknown'
        const username = (res.username || 'unknown').replace(/\"/g, '\\"')
        const pkg = (res.db_package || 'unknown').replace(/\"/g, '\\"')

        let formattedMtLimit = 'unknown'
        if (res.mt_max_limit && res.mt_max_limit.includes('/')) {
          const [upload, download] = res.mt_max_limit.split('/')
          formattedMtLimit = `${formatBandwidth(
            parseInt(upload, 10),
          )}/${formatBandwidth(parseInt(download, 10))}`
        } else {
          formattedMtLimit = res.mt_max_limit || 'unknown'
        }
        const mtLimit = formattedMtLimit.replace(/\"/g, '\\"')

        const routerId = (res.router_id || 'unknown').replace(/\"/g, '\\"')

        newMetrics += `pppoe_bandwidth_mismatch{router="${routerId}",ip="${ip}",username="${username}",package="${pkg}",mt_limit="${mtLimit}"} 1\n`
      }
    }

    // Update global variable cache
    cachedMetrics = newMetrics
    console.log(
      `\n[${new Date().toISOString()}] Sinkronisasi selesai. Ditemukan total ${allMismatches.length} pelanggan tidak sesuai di semua router.`,
    )
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Terjadi kesalahan utama saat update metrics:`,
      error,
    )
  } finally {
    isFetching = false
  }
}

const app = new Hono()

// Endpoint utama untuk di-scrape oleh Prometheus
app.get('/metrics', (c) => {
  return c.text(cachedMetrics)
})

app.get('/', (c) =>
  c.text('PPPoE Bandwidth Prometheus Exporter is running. Visit /metrics.'),
)

// Endpoint untuk memicu sinkronisasi manual (misalnya via webhook atau curl)
app.post('/refresh', async (c) => {
  if (isFetching) {
    return c.json(
      { success: false, message: 'Sinkronisasi sedang berjalan.' },
      409,
    )
  }

  // Memicu update di background, tidak ditunggu (non-blocking) agar request bisa langsung selesai
  updateMetrics()

  return c.json({
    success: true,
    message:
      'Sinkronisasi manual telah dipicu. Silakan cek /metrics beberapa saat lagi.',
  })
})

// Inisialisasi
updateMetrics()
setInterval(updateMetrics, FETCH_INTERVAL_MINUTES * 60 * 1000)

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000

Bun.serve({
  port: PORT,
  fetch: app.fetch,
})
