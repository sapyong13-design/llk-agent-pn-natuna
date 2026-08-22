# LLK Agent - Pengadilan Negeri Natuna

Aplikasi pendamping otomasi laporan lembar kerja dan verifikasi LLK Mahkamah Agung berbasis Node.js dan Playwright (Microsoft Edge).

## Prasyarat
- Node.js versi 20+
- Microsoft Edge
- Akun LLK Mahkamah Agung RI

## Cara Menjalankan
1. Pasang dependensi:
   ```bash
   cd llk-agent
   npm install
   ```
2. Jalankan aplikasi:
   - Di Windows: klik dua kali `LLK Agent.cmd`
   - Atau lewat terminal:
     ```bash
     npm start
     ```
3. Buka browser di `http://127.0.0.1:4545`.

## Fitur Utama
- **Otomasi Pengisian LLK**: Generator log kegiatan bulanan/mingguan sesuai bidang tugas pegawai.
- **Verifikasi LLK Anggota**: Pemindaian target halaman 1 dan verifikasi dengan catatan custom.
- **Isolasi Profil Pegawai**: Setiap pegawai memiliki profil browser terpisah; satuan kerja dibaca otomatis dari akun LLK.
