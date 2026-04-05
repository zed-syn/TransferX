# TransferX — Publish Checklist

# Versions: core/adapters 1.1.1 | downloader 1.3.1 | sdk 1.3.2

# ── Step 1: Login ─────────────────────────────────────────────────────────────

npm login

# ── Step 2: Build all (theo đúng thứ tự dependency) ──────────────────────────

$tsc = "C:\Users\PC\Documents\Tool-Script\UploadX\node_modules\typescript\bin\tsc"
cd packages/core ; node $tsc -p tsconfig.json
cd ../adapters/b2 ; node $tsc -p tsconfig.json
cd ../adapters/s3 ; node $tsc -p tsconfig.json
cd ../adapters/http ; node $tsc -p tsconfig.json
cd ../../downloader ; node $tsc -p tsconfig.json
cd ../sdk ; node $tsc -p tsconfig.json

# ── Step 3: Publish (thay XXXXXX bằng OTP từ authenticator app) ──────────────

# 1. core

cd C:\Users\PC\Documents\Tool-Script\UploadX\packages\core
npm publish --access public --otp=XXXXXX

# 2. adapter-b2

cd C:\Users\PC\Documents\Tool-Script\UploadX\packages\adapters\b2
npm publish --access public --otp=XXXXXX

# 3. adapter-s3

cd C:\Users\PC\Documents\Tool-Script\UploadX\packages\adapters\s3
npm publish --access public --otp=XXXXXX

# 4. adapter-http

cd C:\Users\PC\Documents\Tool-Script\UploadX\packages\adapters\http
npm publish --access public --otp=XXXXXX

# 5. downloader (không đổi version, chỉ publish nếu có thay đổi)

# cd C:\Users\PC\Documents\Tool-Script\UploadX\packages\downloader

# npm publish --access public --otp=XXXXXX

# 6. sdk (cuối cùng — phụ thuộc tất cả packages trên)

cd C:\Users\PC\Documents\Tool-Script\UploadX\packages\sdk
npm publish --access public --otp=XXXXXX

# ── Step 4: Verify ────────────────────────────────────────────────────────────

# https://www.npmjs.com/package/@transferx/core

# https://www.npmjs.com/package/@transferx/adapter-b2

# https://www.npmjs.com/package/@transferx/adapter-s3

# https://www.npmjs.com/package/@transferx/adapter-http

# https://www.npmjs.com/package/@transferx/downloader

# https://www.npmjs.com/package/@transferx/sdk
