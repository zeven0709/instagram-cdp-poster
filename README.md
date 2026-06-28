# Instagram CDP Poster

> Auto-poster komentar Instagram menggunakan **Node.js + Chrome DevTools Protocol (CDP)** — tanpa Selenium, tanpa undetected-chromedriver, tanpa cookie injection.

## Cara Kerja

```
┌──────────────┐     CDP (Port 9222)     ┌────────────────┐
│  Chrome.exe  │◄────────────────────────►│  cdp_poster.js │
│  (Windows)   │                          │  (Node.js)     │
│  real profile│◄── Runtime.evaluate ────│                │
│  persistent  │                          └───────┬────────┘
│  login       │                                   │
└──────────────┘        1. Buka IG (auto-logged in)
                         2. Navigasi ke post
                         3. Cek duplikat (scoped ke komen)
                         4. Inject komentar via JS
                         5. Reload & verify
```

Kunci utamanya: Chrome pakai **persistent profile** (`--user-data-dir`) — login Instagram **sekali manual**, session tersimpan selamanya.

## Prasyarat

### 1. Chrome dengan Remote Debugging

Jalankan Chrome dengan flags berikut (tutup semua Chrome dulu):

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\temp\chrome-debug"
```

Verifikasi:
```bash
curl http://localhost:9222/json/version
```

### 2. Login Instagram Manual

Buka `instagram.com` di Chrome tersebut, login sekali. Session akan persist di `--user-data-dir`.

### 3. Node.js

Node.js v18+ (tested on v24).

## Instalasi

```bash
git clone https://github.com/zeven0709/instagram-cdp-poster
cd instagram-cdp-poster
npm install
```

## Cara Pakai

### Post komentar dari CLI

```bash
node cdp_poster.js https://www.instagram.com/akun/pot/CxVaB/ --comment "Aku bisa bantu joki tugas kak, DM ya!"
```

### Default post (fallback)

```bash
node cdp_poster.js
```

Akan pakai post default dan fallback comment.

## Fitur

- ✅ **Real Chrome profile** — tidak perlu login ulang
- ✅ **No bot detection** — CDP langsung, bukan WebDriver
- ✅ **Duplicate detection** — auto-skip kalau sudah komen
- ✅ **No cookie injection** — sesi real dari persistent profile
- ✅ **React-safe** — proper value setter untuk input React
- ✅ **Popup dismiss** — auto-close Not Now / login popup
- ✅ **Kompatibel dengan Hermes Agent** — bisa dipanggil dari skill

## Struktur File

```
instagram-cdp-poster/
├── cdp_poster.js          # Script utama (Node.js + CDP)
├── package.json           # Dependencies
├── README.md              # Dokumentasi ini
└── SKILL.md               # Hermes Agent skill (opsional)
```

## Konfigurasi

### Environment Variable (recommended)

| Variable | Default | Fungsi |
|----------|---------|--------|
| `IG_USERNAME` | `your_ig_username` | Username IG untuk deteksi duplikat |
| `IG_DEFAULT_POST` | `https://www.instagram.com/example/p/xxx/` | Post default (fallback) |

Atau via CLI args:

```bash
node cdp_poster.js <post_url> --comment "teks" --username "ig_user"
```


## Tips

- **Path dengan backtick** — path project mengandung karakter backtick (\`). Gunakan single quotes di bash.
- **Chrome harus jalan** — script akan error dengan instruksi clear jika Chrome di port 9222 tidak terdeteksi.
- **Ganti `USERNAME`** — sesuaikan dengan username IG kamu agar duplicate detection bekerja.

## License

ISC
