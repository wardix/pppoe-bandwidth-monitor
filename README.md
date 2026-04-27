# PPPoE Bandwidth Monitor (Prometheus Exporter)

Sebuah *web service* ringan yang dibangun menggunakan **Bun** dan **Hono**. Proyek ini berfungsi sebagai *Prometheus Exporter* untuk memantau dan membandingkan profil *bandwidth* pelanggan (PPPoE) secara *real-time* antara router MikroTik dan *database* Gateway terpusat.

Jika ada pelanggan yang mendapatkan limit internet di MikroTik yang tidak sesuai (misalnya bocor tanpa limit atau dilimit terlalu rendah) dibandingkan dengan paket berlangganannya di *database*, eksportir ini akan mengeluarkan indikator peringatan (*alert*) yang bisa ditangkap oleh Prometheus.

## Fitur Utama
- **Multi-Router Support:** Mampu menarik dan memeriksa data dari banyak router MikroTik sekaligus melalui *MikroTik REST API*.
- **Toleransi Dinamis:** Menghitung perbedaan kecepatan (dalam *bps*) antara router dan *database*, serta mengabaikan perbedaan minor (*default* selisih < 5%) yang biasa terjadi akibat perbedaan standar konversi (1000 bps vs 1024 bps). Toleransi ini dapat dikustomisasi.
- **Background Synchronization:** Melakukan proses pengecekan ke ribuan pelanggan secara berkala di latar belakang (setiap 5 menit), sehingga saat *endpoint* `/metrics` diakses, balasan diberikan secara instan tanpa risiko *timeout*.
- **Metrics Prometheus:** Format metrik disesuaikan agar bersih dan efisien, di mana hanya data pelanggan yang *mismatch* (tidak sesuai) yang di- *expose*.

## Persyaratan
- [Bun](https://bun.sh/) (versi terbaru)
- Akses ke Router MikroTik versi 7.1 atau lebih baru (karena menggunakan fitur *REST API*).

## Instalasi

1. Klon *repository* atau unduh berkas proyek ini.
2. Pasang dependensi menggunakan Bun:
   ```bash
   bun install
   ```
3. Siapkan file konfigurasi environment:
   ```bash
   cp .env.example .env
   ```
   Lalu ubah isi file `.env` sesuai dengan konfigurasi Anda (masukkan token Gateway API Anda).

4. Siapkan daftar router yang ingin dipantau:
   ```bash
   cp routers.example.json routers.json
   ```
   Lalu masukkan detail koneksi router MikroTik Anda ke dalam file `routers.json`.

## Konfigurasi

### Environment Variables (`.env`)
- `PORT`: Port di mana web service akan berjalan (Default: `3000`).
- `FETCH_INTERVAL_MINUTES`: Interval sinkronisasi data dari MikroTik ke Gateway dalam menit (Default: `5`).
- `TOLERANCE_PERCENTAGE`: Ambang batas perbedaan kecepatan yang dimaklumi sebelum dianggap *mismatch*. Format desimal (contoh: `0.05` untuk 5%, `0.1` untuk 10%). (Default: `0.05`).
- `DB_GATEWAY_API_URL`: URL Endpoint untuk API pengecekan bandwidth Gateway.
- `DB_GATEWAY_API_TOKEN`: Token otorisasi Bearer JWT.

### Daftar Router (`routers.json`)
Setiap objek JSON di dalam *array* merepresentasikan satu buah router MikroTik:
```json
{
  "id": "nama-unik-router",
  "apiUrlPpp": "https://<ip-atau-domain-mikrotik>/rest/ppp/active?service=pppoe&.proplist=name,address",
  "apiUrlQueue": "https://<ip-atau-domain-mikrotik>/rest/queue/simple?.proplist=target,max-limit",
  "username": "user_api",
  "password": "password_api"
}
```

## Menjalankan Aplikasi

Jalankan perintah berikut untuk mode produksi:
```bash
bun start
```

Atau untuk mode pengembangan (akan *auto-restart* jika ada perubahan *file*):
```bash
bun run dev
```

Aplikasi akan segera berjalan (misal pada `http://localhost:3000`). Anda bisa mengecek hasil komparasinya di:
`http://localhost:3000/metrics`

## Pengembangan (Development)
Proyek ini menggunakan **Biome** untuk memastikan format dan standar kode tetap konsisten. Proyek ini juga telah terintegrasi dengan **Husky** dan **lint-staged**, sehingga kode akan di-*format* secara otomatis setiap kali Anda melakukan `git commit`.

Jika Anda ingin merapikan format kode secara manual, jalankan:
```bash
bun run format
```

## Pengaturan Prometheus

Untuk membaca *metrics* dari layanan ini, tambahkan konfigurasi berikut ke dalam file `prometheus.yml` Anda:

```yaml
scrape_configs:
  - job_name: 'pppoe_bandwidth_monitor'
    scrape_interval: 1m
    static_configs:
      - targets: ['localhost:3000'] # Ganti dengan IP/Hostname jika berjalan di server terpisah
```

### Alerting Rule (Contoh)
Anda bisa membuat aturan *alert* di Prometheus/Grafana dengan logika sederhana:
```promql
# Akan terpicu jika ada ketidaksesuaian limit PPPoE
pppoe_bandwidth_mismatch > 0
```
Metrics ini akan langsung mencantumkan label seperti `router`, `ip`, `username`, `package` dan `mt_limit` sehingga memudahkan *troubleshooting*.
